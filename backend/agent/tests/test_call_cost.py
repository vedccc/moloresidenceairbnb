# tests/test_call_cost.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import call_cost


class FakeSummary:
    """Stands in for livekit.agents.metrics.UsageSummary."""

    def __init__(self, **kw):
        self.llm_prompt_tokens = kw.get("llm_prompt_tokens", 0)
        self.llm_prompt_cached_tokens = kw.get("llm_prompt_cached_tokens", 0)
        self.llm_completion_tokens = kw.get("llm_completion_tokens", 0)
        self.tts_characters_count = kw.get("tts_characters_count", 0)
        self.stt_audio_duration = kw.get("stt_audio_duration", 0.0)


def test_blended_minute_lands_where_the_client_expects():
    # The client's own estimate for this stack was 5-8 US cents a minute. If a
    # rate edit ever drops the figure outside that, it is far likelier to be a
    # typo (a missing zero, per-1M confused with per-1K) than a real price move.
    assert 0.05 <= call_cost.blended_per_minute_usd() <= 0.08


def test_tts_is_the_biggest_single_line_on_a_normal_call():
    # Worth pinning: it is counter-intuitive (people assume the LLM dominates)
    # and it is the reason cost tracks how much the agent TALKS, not how long
    # the caller stays on the line.
    b = call_cost.estimate_from_duration(120)
    parts = b["components_usd"]
    assert parts["tts"] == max(parts.values())


def test_components_add_up_to_the_total():
    usage = call_cost.CallUsage(
        duration_s=95, llm_input_tokens=4200, llm_cached_input_tokens=800,
        llm_output_tokens=310, stt_audio_s=61.5, tts_characters=940,
        kb_input_chars=12000, kb_output_chars=400,
    )
    b = call_cost.estimate_cost(usage)
    assert round(sum(b["components_usd"].values()), 4) == b["total_usd"]


def test_a_real_call_costs_cents_not_dollars():
    # ~90 seconds of ordinary conversation. Guards against a units slip that
    # would silently inflate every figure on the dashboard by 1000x.
    usage = call_cost.CallUsage(
        duration_s=90, llm_input_tokens=5000, llm_output_tokens=300,
        stt_audio_s=55, tts_characters=900, kb_input_chars=9000,
        kb_output_chars=350,
    )
    assert 0.02 < call_cost.estimate_cost(usage)["total_usd"] < 0.30


def test_cached_input_tokens_are_not_double_counted():
    # LiveKit reports prompt_tokens as the TOTAL, cached included. Pricing both
    # buckets off the raw numbers would bill the cached ones one and a half
    # times over.
    usage = call_cost.usage_from_summary(
        FakeSummary(llm_prompt_tokens=1000, llm_prompt_cached_tokens=400), duration_s=60
    )
    assert usage.llm_input_tokens == 600
    assert usage.llm_cached_input_tokens == 400


def test_cached_tokens_are_clamped_to_the_prompt():
    usage = call_cost.usage_from_summary(
        FakeSummary(llm_prompt_tokens=100, llm_prompt_cached_tokens=999), duration_s=10
    )
    assert usage.llm_input_tokens == 0
    assert usage.llm_cached_input_tokens == 100


def test_a_summary_missing_fields_prices_as_zero_rather_than_raising():
    # This runs during call teardown, after the caller has hung up. A renamed
    # field in a future SDK must understate a line, never lose the whole row.
    class Empty:
        pass

    usage = call_cost.usage_from_summary(Empty(), duration_s=30)
    b = call_cost.estimate_cost(usage)
    assert b["components_usd"]["llm"] == 0
    assert b["components_usd"]["telephony"] > 0  # per-minute lines still apply


def test_measured_and_estimated_breakdowns_have_the_same_shape():
    measured = call_cost.estimate_cost(call_cost.CallUsage(duration_s=60))
    estimated = call_cost.estimate_from_duration(60)
    assert measured.keys() == estimated.keys()
    assert measured["components_usd"].keys() == estimated["components_usd"].keys()
    assert measured["measured"] is True
    assert estimated["measured"] is False


def test_the_duration_fallback_matches_the_blended_rate():
    # estimate_from_duration exists so a metrics-less call is still priced the
    # same way the backfill prices history. The two must not drift apart.
    one_minute = call_cost.estimate_from_duration(60)["total_usd"]
    assert abs(one_minute - call_cost.blended_per_minute_usd()) < 0.001


def test_a_zero_length_call_costs_nothing():
    assert call_cost.estimate_from_duration(0)["total_usd"] == 0
    assert call_cost.estimate_cost(call_cost.CallUsage())["total_usd"] == 0


def test_the_breakdown_records_what_it_was_computed_from():
    # cost_breakdown has to be auditable against an invoice months later, which
    # means carrying the usage AND the rates, not just the answer.
    b = call_cost.estimate_cost(call_cost.CallUsage(duration_s=60, tts_characters=600))
    assert b["usage"]["tts_characters"] == 600
    assert b["rates_usd"]["tts_per_1m_chars"] == 50.0
    assert b["version"] == call_cost.COST_MODEL_VERSION


def test_rates_come_from_the_environment_when_set(monkeypatch):
    # Every rate is env-tunable so a price change is a secrets update, not a
    # rebuild-and-redeploy of the agent.
    monkeypatch.setenv("RATE_TELEPHONY_PER_MIN", "0.02")
    rates = call_cost.Rates()
    assert rates.telephony_per_min == 0.02
    dearer = call_cost.estimate_cost(call_cost.CallUsage(duration_s=60), rates)
    assert dearer["components_usd"]["telephony"] > 0.02


def test_a_nonsense_rate_env_falls_back_to_the_published_default(monkeypatch):
    monkeypatch.setenv("RATE_STT_PER_MIN", "not-a-number")
    assert call_cost.Rates().stt_per_min == 0.0058
