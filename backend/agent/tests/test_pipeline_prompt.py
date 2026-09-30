# tests/test_pipeline_prompt.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pipeline_prompt              # noqa: E402


def test_s2s_filler_guidance_is_gone():
    # The pipeline speaks a fixed non-interruptible filler automatically, so the
    # prompt must NOT carry any of the s2s "say/don't-say a filler before the tool"
    # guidance the client removed.
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert "# Calling Tools" not in p
    assert "soft thinking sound" not in p
    assert "cuts you off" not in p
    assert "cuts your speech off mid-word" not in p
    assert "I'm currently pulling up your reservation" not in p
    # personality block was retitled/trimmed, not left as "# Emotional Direction"
    assert "# Emotional Direction" not in p


def test_client_structure_present():
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert "# Tone & Style" in p
    assert "## Existing Guest" in p
    assert "## Booking (Prospective Guest)" in p
    # tools are called directly, then the result is presented (no self-filler)
    assert "call `search_kb`, then answer from what it returns" in p
    assert "call `suggest_available_rooms`, then present what it returns" in p
    # new booking constraint the client added
    assert "This link can only get sent to the current caller's number" in p


def test_all_tools_referenced():
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    for tool in ("search_kb", "suggest_available_rooms", "send_booking_link",
                 "identify_guest", "raise_maintenance_ticket"):
        assert tool in p


def test_typos_fixed_and_maintenance_renumbered():
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert "an current guest" not in p and "a current guest" in p
    assert "inormation" not in p
    # maintenance list runs 1-4 with no gap (client's cleanup left 1,2,3,5)
    assert "4. In case of emergency" in p


def test_current_time_sentinel_present_in_constant():
    # The constant keeps the sentinel; the live time is substituted per call.
    assert pipeline_prompt.CURRENT_TIME_TOKEN in pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert pipeline_prompt.CURRENT_TIME_TOKEN == "%%CURRENT_TIME%%"


def test_render_instructions_substitutes_time_and_removes_sentinel():
    stamp = "Tuesday, 12 August 2026, 18:14 local time (today's date is 2026-08-12)."
    rendered = pipeline_prompt.render_instructions(stamp)
    assert stamp in rendered
    assert pipeline_prompt.CURRENT_TIME_TOKEN not in rendered   # no un-substituted sentinel leaks


def test_pipeline_addendum_present_and_appended():
    # The Gemma no-spoken-reasoning guardrail is appended AFTER the client body.
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert "# On the phone" in p
    assert "Say ONLY the words to speak" in p           # no spoken reasoning
    assert "in parentheses" in p                         # blocks "(I'll wait…)" leak
    assert p.endswith(pipeline_prompt._PIPELINE_ADDENDUM)  # appended, not spliced
