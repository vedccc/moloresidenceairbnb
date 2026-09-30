# tests/test_kb_search_room_context.py
# Regression guard for the "over-qualified query" bug: the agent appended the
# room number + address to the search text ("carpets in room 105 at Pułaskiego
# 10b"), and the Gemini matcher then returned NO_KB_MATCH for a fact that lives
# in the GENERAL KB with no room tag ("the carpets are orange and fluffy").
# The live fix was verified against real Gemini; this offline test just pins the
# system-prompt rule so the guardrail can't silently disappear.
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import kb_search  # noqa: E402


def test_matcher_prompt_tolerates_room_qualified_questions():
    s = kb_search._SYSTEM.lower()
    # It must tell the model a named room is only context, and not to reply the
    # not-found sentinel just because the fact isn't tagged to that exact room.
    assert "context" in s
    assert kb_search._NOT_FOUND.lower() in s          # the sentinel is referenced in the rule
    assert "generally" in s or "general" in s
    # The specific failure mode is called out by example.
    assert "room" in s and ("tagged" in s or "labelled" in s or "labeled" in s)
