"""Regression tests for the per-call search_kb memoization (Issue 2: duplicate
search_kb when an interrupted first response re-fires the same tool).

Without the memo, MoloAgent.search_kb queried Gemini on every call, so an
interrupted-then-retried turn paid for two identical KB lookups.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import kb_search  # noqa: E402
import agent as agent_mod  # noqa: E402


def _make_agent(kb="The carpets are orange and fluffy."):
    return agent_mod.MoloAgent(instructions="x", default_kb_content=kb)


@pytest.mark.asyncio
async def test_identical_question_is_memoized_within_a_call(monkeypatch):
    calls = []

    async def fake_answer(question, kb_content):
        calls.append(question)
        return "The carpets are orange and fluffy."

    monkeypatch.setattr(kb_search, "answer_from_kb", fake_answer)

    a = _make_agent()
    r1 = await a._answer_kb("What is the carpet color?")
    r2 = await a._answer_kb("  what is THE carpet color?  ")  # same Q, diff case/space

    assert r1 == r2 == "The carpets are orange and fluffy."
    assert len(calls) == 1, "duplicate search_kb should reuse the memo, not re-query Gemini"


@pytest.mark.asyncio
async def test_cache_busts_when_kb_swaps(monkeypatch):
    kbs_seen = []

    async def fake_answer(question, kb_content):
        kbs_seen.append(kb_content)
        return f"answer-from::{kb_content[:12]}"

    monkeypatch.setattr(kb_search, "answer_from_kb", fake_answer)

    a = _make_agent(kb="GENERAL: wifi is molo-guest / pass1234")
    first = await a._answer_kb("wifi password?")
    assert len(kbs_seen) == 1

    # Simulate identify_guest swapping in a room-specific KB.
    a.kb_content = "ROOM-SPECIFIC INFO: wifi is room101 / pass9999"
    a._kb_answer_cache.clear()

    second = await a._answer_kb("wifi password?")
    assert len(kbs_seen) == 2, "after a KB swap the same question must be re-answered"
    assert first != second


@pytest.mark.asyncio
async def test_miss_while_unidentified_nudges_identify(monkeypatch):
    async def miss(question, kb_content):
        return "NO_KB_MATCH: nothing in the loaded knowledge base covers this question."

    monkeypatch.setattr(kb_search, "answer_from_kb", miss)

    a = _make_agent(kb="general info, no wifi")
    a.property_id = None  # guest not identified yet
    result = await a.search_kb(None, question="how do I connect to the wifi?")
    assert "identify_guest" in result, "an unidentified miss should nudge toward identify_guest"


@pytest.mark.asyncio
async def test_miss_while_identified_does_not_nudge(monkeypatch):
    async def miss(question, kb_content):
        return "NO_KB_MATCH: nothing in the loaded knowledge base covers this question."

    monkeypatch.setattr(kb_search, "answer_from_kb", miss)

    a = _make_agent(kb="room info loaded")
    a.property_id = "prop-1"  # already identified — re-identifying would be wrong
    result = await a.search_kb(None, question="how do I connect to the wifi?")
    assert "identify_guest" not in result, "an identified miss must not loop back to identify_guest"
