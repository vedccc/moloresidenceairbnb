# tests/test_gdpr_check.py
import asyncio
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def _answer(monkeypatch, text):
    """Stub the Gemini call so we test OUR decision logic, not the model's."""
    import gdpr_check

    class R:  # minimal response shape
        pass

    async def fake(**kw):
        r = R(); r.text = text; return r

    class FakeModels:
        generate_content = staticmethod(fake)

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(gdpr_check, "_get_client", lambda: FakeClient())
    return gdpr_check


def test_yes_is_honoured(monkeypatch):
    g = _answer(monkeypatch, "YES")
    assert asyncio.run(g.caller_requested_deletion("user: delete my data")) is True


def test_no_is_honoured(monkeypatch):
    g = _answer(monkeypatch, "NO")
    assert asyncio.run(g.caller_requested_deletion("user: what's the wifi?")) is False


def test_anything_ambiguous_is_treated_as_no(monkeypatch):
    # Erasure is irreversible; a false positive destroys a guest's transcript,
    # while a false negative just leaves it for the 14-day sweep. Those are not
    # equally bad, so only an unambiguous YES may pass.
    for reply in ["MAYBE", "YES, but only if...", "I think so", "",
                  "NOT A DELETION REQUEST", "TAK", "1", "true"]:
        g = _answer(monkeypatch, reply)
        got = asyncio.run(g.caller_requested_deletion("user: hmm"))
        assert got is False, f"{reply!r} must not trigger an erasure"


def test_trailing_punctuation_still_counts(monkeypatch):
    for reply in ["YES.", "yes", " YES ", "Yes!"]:
        g = _answer(monkeypatch, reply)
        assert asyncio.run(g.caller_requested_deletion("user: erase me")) is True, reply


def test_empty_transcript_never_calls_the_model(monkeypatch):
    import gdpr_check
    def boom():
        raise AssertionError("must not build a client for an empty transcript")
    monkeypatch.setattr(gdpr_check, "_get_client", boom)
    assert asyncio.run(gdpr_check.caller_requested_deletion("")) is False
    assert asyncio.run(gdpr_check.caller_requested_deletion("   ")) is False


def test_model_failure_is_treated_as_no(monkeypatch):
    import gdpr_check
    def boom():
        raise RuntimeError("vertex is down")
    monkeypatch.setattr(gdpr_check, "_get_client", boom)
    # Must not raise — this runs during call teardown.
    assert asyncio.run(gdpr_check.caller_requested_deletion("user: delete my data")) is False


def test_timeout_is_treated_as_no(monkeypatch):
    import gdpr_check

    async def hang(**kw):
        await asyncio.sleep(10)

    class FakeModels:
        generate_content = staticmethod(hang)
    class FakeAio:
        models = FakeModels()
    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(gdpr_check, "_get_client", lambda: FakeClient())
    monkeypatch.setattr(gdpr_check, "_TIMEOUT_S", 0.05)
    assert asyncio.run(gdpr_check.caller_requested_deletion("user: delete my data")) is False


def test_prompt_excludes_the_agent_offering_deletion():
    # The agent's own prompt tells it to discuss deletion when asked, and the
    # greeting used to mention it. The classifier must key off the CALLER only,
    # or ordinary calls would erase themselves.
    import gdpr_check
    p = gdpr_check.SYSTEM_PROMPT
    assert "CALLER" in p
    assert "AGENT mentioning data deletion" in p
    assert "unsure, say NO" in p


def test_alert_number_configured():
    import agent_pipeline as ap
    assert ap.GDPR_ALERT_PHONE == "+48608466046"


def test_alert_is_sent_after_erasure_with_the_count(monkeypatch):
    import agent_pipeline as ap
    sent = {}
    monkeypatch.setattr(ap.sms, "send_sms", lambda to, msg: sent.update(to=to, msg=msg) or True)
    ap._notify_gdpr_erasure("+48123456789", 3)
    assert sent["to"] == "+48608466046"
    assert "+48123456789" in sent["msg"]
    assert "3 calls" in sent["msg"]


def test_alert_failure_does_not_raise(monkeypatch):
    # The erasure has already happened by this point; a failed SMS must not
    # bubble up and make it look like the deletion failed.
    import agent_pipeline as ap
    def boom(to, msg):
        raise RuntimeError("telnyx down")
    monkeypatch.setattr(ap.sms, "send_sms", boom)
    ap._notify_gdpr_erasure("+48123456789", 1)   # must not raise


def test_alert_can_be_turned_off(monkeypatch):
    import agent_pipeline as ap
    called = []
    monkeypatch.setattr(ap, "GDPR_ALERT_PHONE", "")
    monkeypatch.setattr(ap.sms, "send_sms", lambda to, msg: called.append(to))
    ap._notify_gdpr_erasure("+48123456789", 1)
    assert called == []


def test_thinking_is_disabled_and_the_budget_is_not_starved(monkeypatch):
    # THE REGRESSION (live 2026-08-16): gemini-2.5-flash is a thinking model and
    # its reasoning tokens come out of max_output_tokens. With max_output_tokens=5
    # it spent the whole budget thinking and returned EMPTY text on every call,
    # which the bias-to-NO rule read as "no deletion requested". Real requests
    # were silently dropped.
    import gdpr_check
    from google.genai import types

    seen = {}

    class R:
        text = "NO"

    async def fake(**kw):
        seen["cfg"] = kw.get("config")
        return R()

    class FakeModels:
        generate_content = staticmethod(fake)
    class FakeAio:
        models = FakeModels()
    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(gdpr_check, "_get_client", lambda: FakeClient())
    asyncio.run(gdpr_check.caller_requested_deletion("user: hello"))

    cfg = seen["cfg"]
    assert cfg.thinking_config is not None, "thinking must be explicitly disabled"
    assert cfg.thinking_config.thinking_budget == 0
    # Enough room to say YES or NO even if a model ignores the thinking budget.
    assert cfg.max_output_tokens >= 16


def test_empty_answer_is_logged_as_a_fault_not_a_decision(monkeypatch, caplog):
    # An empty response must be distinguishable in the logs from a genuine "NO",
    # or the next silent failure looks identical to normal operation.
    import logging
    import gdpr_check

    class R:
        text = ""
        candidates = []

    async def fake(**kw):
        return R()

    class FakeModels:
        generate_content = staticmethod(fake)
    class FakeAio:
        models = FakeModels()
    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(gdpr_check, "_get_client", lambda: FakeClient())
    with caplog.at_level(logging.ERROR, logger="molo-agent.gdpr"):
        assert asyncio.run(gdpr_check.caller_requested_deletion("user: delete my data")) is False
    assert any("NO TEXT" in r.message for r in caplog.records), \
        "an empty answer must be logged at ERROR, not pass as a routine no"
