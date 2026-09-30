"""What happened on a call — as a LIST, because a call is rarely one thing.

Replaces a single `outcome` that was wrong most of the time. The old rule was:

    if a tool set a hint:            use that hint
    elif no tool ran and they hung up: "abandoned"
    else:                            "other"

Both fallbacks misfire. The model answers most guest questions straight from the
loaded knowledge base without calling `search_kb` at all, so "no tool ran" is
routine on a perfectly good call — which is why calls where a guest asked two
questions and rang off were logged as ABANDONED. And "other" swallowed
everything else: 133 of 232 calls.

The replacement has two halves, deliberately kept apart:

  * `from_tool_calls` — hard evidence. A ticket exists or it doesn't; an SMS
    went out or it didn't. Never guessed, never model-derived.
  * `classify_transcript` — one cheap Gemini pass over the finished transcript
    for the things only the conversation shows: was the question answered, was
    it a complaint, was it spam. Same shape as gdpr_check.py — post-call,
    guarded, and returning nothing at all on any failure.

`merge` puts the two together under one rule worth stating plainly: **abandoned
means the caller hung up without a real exchange.** It cannot coexist with any
other outcome, and it is never inferred from an absence of tool calls.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Iterable, Sequence

logger = logging.getLogger("molo-agent.outcomes")

_MODEL = os.getenv("OUTCOME_CLASSIFY_MODEL", "gemini-2.5-flash")
_TIMEOUT_S = float(os.getenv("OUTCOME_CLASSIFY_TIMEOUT_S", "20"))

# The vocabulary, in RANK ORDER: most specific first. Two things read this
# order — the singular `call_logs.outcome` column takes the highest-ranked
# entry, and the dashboard lists badges in this order so the eye lands on what
# the call achieved before what it was about.
#
# Keep in sync with the CHECK constraint in
# backend/supabase/migrations/20260816010000_call_outcomes_and_cost.sql and with
# OUTCOME_OPTIONS in frontend/src/app/(dashboard)/calls/calls-client.tsx.
OUTCOMES: tuple[str, ...] = (
    "maintenance_ticket_raised",
    "booking_link_sent",
    "transferred_to_human",
    "reservation_looked_up",
    "availability_checked",
    "transfer_unavailable",
    "question_answered",
    "unresolved",
    "complaint",
    "spam",
    "wrong_number",
    "abandoned",
    "other",
)

_RANK = {name: i for i, name in enumerate(OUTCOMES)}

# What the transcript pass is allowed to return. The tool-derived outcomes are
# NOT in here on purpose: the model must never be able to claim a ticket was
# filed or a link was sent — that is the tool trace's job, and only its job.
CLASSIFIABLE: tuple[str, ...] = (
    "question_answered",
    "unresolved",
    "complaint",
    "spam",
    "wrong_number",
    "abandoned",
    "other",
)

SYSTEM_PROMPT = """You read a phone call transcript between a hotel's AI agent \
(Molo Residence in Sopot, Poland) and a caller, and label what happened.

Reply with a comma-separated list of labels from this list, and NOTHING else:

question_answered — the caller asked something and the agent gave them a real answer.
unresolved — the caller asked something the agent could not answer, or could not help with.
complaint — the caller complained about the stay, the property, the service or the agent.
spam — not a genuine caller: a robocall, a sales call, or a test.
wrong_number — the caller wanted someone or something else entirely.
abandoned — the caller hung up without a real exchange: silence, or a word or two, nothing asked and nothing answered.
other — a real conversation, but none of the above fit.

Rules:
- Several labels can apply. Use as many as genuinely fit, most important first.
- Use question_answered AND unresolved together when some questions were answered and others were not.
- NEVER use abandoned together with another label. A caller who asked anything at all did not abandon the call.
- The agent's opening line is scripted and is spoken before the caller says anything. Ignore it when judging whether there was an exchange.
- The transcript may be in Polish, English, or both. Judge the content, not the language.
- If nothing fits, reply: other"""

_client = None


def _get_client():
    """Lazily build a cached Vertex AI genai client (creds already in env)."""
    global _client
    if _client is None:
        from google import genai

        _client = genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
        )
    return _client


def _sorted_unique(values: Iterable[str]) -> list[str]:
    """Dedupe and put in rank order; anything unrecognized is dropped."""
    seen = {v for v in values if v in _RANK}
    return sorted(seen, key=lambda v: _RANK[v])


def count_caller_turns(transcript_lines: Sequence[str]) -> int:
    """How many times the CALLER spoke.

    The transcript is the agent's own log: one "role: text" line per turn, where
    role is the LiveKit chat role ("user" for the caller, "assistant" for the
    agent). Anything else — a line with no role prefix, a system note — is not a
    caller turn.
    """
    n = 0
    for line in transcript_lines or ():
        role = str(line).split(":", 1)[0].strip().lower()
        if role in ("user", "caller"):
            n += 1
    return n


def from_tool_calls(tool_calls: Sequence[dict[str, Any]] | None) -> list[str]:
    """Outcomes that the tool trace PROVES, in rank order.

    Matches on the exact result strings the tools in agent.py record. Those
    strings are the contract; if one is reworded there, the corresponding test
    in tests/test_call_outcomes.py fails, which is the intended alarm.
    """
    found: set[str] = set()
    kb_hits = 0
    kb_misses = 0

    for call in tool_calls or ():
        name = str((call or {}).get("name") or "")
        result = str((call or {}).get("result") or "")

        if name == "identify_guest":
            # Only a single, unambiguous property match means we actually told
            # the guest something about their reservation. "ambiguous: " and
            # "no match: " are prefixed by the tool itself.
            if result.startswith("MATCHED (one place)"):
                found.add("reservation_looked_up")

        elif name == "search_kb":
            # A miss is recorded with the NO_KB_MATCH sentinel in the result —
            # including the longer "ask for their room number" variant, which
            # still carries it.
            if "NO_KB_MATCH" in result:
                kb_misses += 1
            else:
                kb_hits += 1

        elif name == "raise_maintenance_ticket":
            if result.startswith("Maintenance ticket created"):
                found.add("maintenance_ticket_raised")
            else:
                found.add("unresolved")  # they reported a fault and we didn't file it

        elif name == "suggest_available_rooms":
            # Anything that isn't an outright error means we quoted the caller
            # something — available, partial, or fully booked.
            if not result.startswith("error:"):
                found.add("availability_checked")

        elif name == "send_booking_link":
            # 'sent' is the SMS actually going out. A link that was built but
            # never delivered is not a link the caller got.
            if "'sms_sent': True" in result:
                found.add("booking_link_sent")
            else:
                found.add("unresolved")

        elif name == "transfer_call":
            if result.startswith("dialing front desk"):
                found.add("transferred_to_human")
            else:
                # Refused (front desk closed), not provisioned, dialling the
                # caller's own number, or a SIP error: the caller asked for a
                # human and did not get one.
                found.add("transfer_unavailable")

    if kb_hits:
        found.add("question_answered")
    if kb_misses:
        found.add("unresolved")

    return _sorted_unique(found)


def parse_labels(reply: str | None) -> list[str]:
    """Pull known labels out of a model reply, ignoring everything else.

    Deliberately lenient about FORMAT and strict about VOCABULARY: the model
    wrapping its answer in a sentence must not lose the labels, but a label it
    invented must never reach the database (the column has a CHECK constraint,
    and a rejected write would lose the whole row's update).
    """
    if not reply:
        return []
    tokens = re.split(r"[^a-z_]+", reply.strip().lower())
    ordered = [t for t in tokens if t in CLASSIFIABLE]
    # Keep the model's own ordering for equal ranks by deduping in place first.
    seen: list[str] = []
    for t in ordered:
        if t not in seen:
            seen.append(t)
    return seen


def classify_config(types):
    """The Gemini request config. Split out so the token budget is testable.

    ⚠️ `thinking_budget=0` is load-bearing. Gemini 2.5 Flash thinks by default,
    and thinking tokens come out of `max_output_tokens` — so a tight budget is
    spent reasoning and the visible answer is truncated or empty. The first live
    call after this shipped logged

        outcome classify: 'question' -> []

    "question" being all that was left of "question_answered" once thinking had
    taken the rest of a 40-token budget. Every label was dropped and the
    classifier contributed nothing (the tool-derived outcomes carried the call).
    Thinking is off AND the budget is comfortable — either alone would do, but
    this is a post-call job nobody is waiting on, so it takes both.
    """
    return types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.0,
        max_output_tokens=200,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )


async def classify_transcript(transcript: str | None) -> list[str]:
    """Label a finished transcript. Never raises; returns [] if it can't.

    An empty list is a real answer here — it means "the model told us nothing",
    and `merge` falls back to what the tool trace and the call shape show. That
    is strictly better than a guess: the tool-derived half is unaffected.
    """
    if not transcript or not transcript.strip():
        return []

    try:
        from google.genai import types

        client = _get_client()
        cfg = classify_config(types)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=f"TRANSCRIPT:\n{transcript.strip()}",
                config=cfg,
            ),
            timeout=_TIMEOUT_S,
        )
        reply = getattr(resp, "text", None)
        labels = parse_labels(reply)
        if reply and not labels:
            # The model said something and none of it was a label we know. That
            # is how the truncation bug above showed up, so it warns rather than
            # disappearing into an INFO line.
            logger.warning("outcome classify: no known labels in %r", reply[:80])
        else:
            logger.info("outcome classify: %r -> %s", (reply or "")[:60], labels)
        return labels
    except asyncio.TimeoutError:
        logger.warning("outcome classify timed out after %ss", _TIMEOUT_S)
        return []
    except Exception as exc:  # noqa: BLE001 — must never break call teardown
        logger.warning("outcome classify failed: %s", exc)
        return []


def merge(tool_outcomes: Sequence[str], llm_outcomes: Sequence[str], *,
          caller_turns: int) -> list[str]:
    """Combine both halves into the final list. Always returns at least one.

    The rules, in order:

    1. The caller never spoke and no tool ran -> ["abandoned"], full stop. This
       is the ONLY way a call gets that label, and it is the definition the
       client asked for: hung up without a real exchange.
    2. Otherwise `abandoned` is stripped, wherever it came from. A caller who
       said something did not abandon the call, whatever the model thinks.
    3. `other` is a fallback, not a fact: it survives only when nothing else did.
    """
    tools = _sorted_unique(tool_outcomes)
    llm = [o for o in llm_outcomes if o in _RANK]

    if not tools and caller_turns == 0:
        return ["abandoned"]

    merged = _sorted_unique([*tools, *(o for o in llm if o != "abandoned")])

    if len(merged) > 1:
        merged = [o for o in merged if o != "other"]
    return merged or ["other"]


def primary(outcomes: Sequence[str]) -> str | None:
    """The single highest-ranked outcome — what `call_logs.outcome` holds.

    That column is still what the home dashboard's category chart groups by, so
    it keeps meaning "the most significant thing this call did".
    """
    ranked = _sorted_unique(outcomes)
    return ranked[0] if ranked else None


async def for_call(*, tool_calls: Sequence[dict[str, Any]] | None,
                   transcript: str | None,
                   transcript_lines: Sequence[str] | None = None) -> list[str]:
    """The whole pipeline for one finished call. Never raises.

    `transcript_lines` is the agent's raw "role: text" list; `transcript` is the
    same thing joined, as stored. Both are accepted because the caller-turn
    count needs the lines and the model needs the text.
    """
    tools = from_tool_calls(tool_calls)
    if transcript_lines is None:
        transcript_lines = (transcript or "").split("\n")
    try:
        llm = await classify_transcript(transcript)
    except Exception as exc:  # noqa: BLE001 — belt and braces; classify already guards
        logger.warning("outcome classification blew up: %s", exc)
        llm = []
    return merge(tools, llm, caller_turns=count_caller_turns(transcript_lines))
