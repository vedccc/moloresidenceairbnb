"""Semantic knowledge-base answering with Gemini 2.5 Flash (Vertex AI).

The live conversation runs on the Gemini Live *audio* model; this module is a
separate, lightweight *text* call used by the `search_kb` tool to answer a guest
question grounded ONLY in the loaded knowledge-base text.

Why a second model call instead of keyword matching: the KB is free text and
guests paraphrase ("can I bring my dog?" vs a "Pets" paragraph). Gemini 2.5
Flash understands the question semantically and returns a concise, spoken-ready
answer — or a sentinel when the KB genuinely doesn't cover it.

Reliability: this is on the live-call hot path, so every failure path returns
None and the caller (agent.py) falls back to the naive keyword search. A Gemini
hiccup, timeout, or region issue must never strand the caller.

Reuses the same Vertex creds as the Live model (GOOGLE_APPLICATION_CREDENTIALS
is already set from GOOGLE_CREDENTIALS_B64 in agent.py before this is imported).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger("molo-agent.kb_search")

# No caching: every question is answered fresh against the current KB, so
# dashboard KB edits take effect immediately.

# Sentinel the model is told to emit when the KB doesn't contain the answer.
_NOT_FOUND = "NOT_FOUND"

# Neutral "no KB answer" signal. It deliberately does NOT prescribe a next step
# (e.g. "connect you with a team member") — that wording used to hijack the
# maintenance flow, making the agent offer a transfer instead of raising a ticket.
# The system prompt now decides the next step (raise a ticket for a maintenance
# issue; offer team follow-up for a general question).
_MISS_REPLY = "NO_KB_MATCH: nothing in the loaded knowledge base covers this question."

_MODEL = os.getenv("KB_SEARCH_MODEL", "gemini-2.5-flash")
# Hard cap so a slow text call can't stall the live conversation; on timeout we
# fall back to keyword search.
_TIMEOUT_S = float(os.getenv("KB_SEARCH_TIMEOUT_S", "10"))

_SYSTEM = """You answer a hotel guest's spoken question using ONLY the knowledge base below.

Rules:
- Use ONLY information found in the knowledge base. Never invent or guess values you cannot see — prices, times, codes, Wi-Fi names/passwords, policies — and quote those values EXACTLY as written (don't change, round, or reformat them).
- If the knowledge base contains the relevant information, ANSWER the question with it (for example, a Wi-Fi question is answered with the network name and password). Only if the knowledge base clearly does not cover the question, reply with EXACTLY this token and nothing else: {nf}
- The knowledge base may have a "ROOM-SPECIFIC INFO" section and a "GENERAL PROPERTY INFO" section (separated by "---"). The ROOM-SPECIFIC section describes THIS guest's exact room and its values REPLACE the general ones. Whenever the room-specific section gives a value (Wi-Fi network/password, codes, policies, etc.), you MUST use that value and IGNORE any different value in the general/building section for the same thing. Use the general section only for things the room-specific section does not mention. Never mention that there were multiple sections.
- The question may name the guest's specific room or address (e.g. "the carpets in room 105 at Pułaskiego 10b"). Treat that ONLY as context about who is asking — it does NOT mean the answer must be tagged to that exact room. If the knowledge base answers the question anywhere, INCLUDING generally, use that answer. Do NOT reply {nf} merely because the matching fact isn't labelled with the specific room the question named.
- Answer in 1-3 short sentences, conversational and natural to read aloud (no markdown, no lists, no headings).
- Reply in the same language the guest used.""".format(nf=_NOT_FOUND)

_client = None  # cached google.genai Client


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


async def answer_from_kb(question: str, kb_content: str) -> Optional[str]:
    """Return a grounded, spoken-ready answer to `question` from `kb_content`.

    Returns:
      - a short answer string grounded in the KB, OR
      - a graceful "not in the KB" reply when the model returns the not-found
        sentinel, OR
      - None on empty KB / error / timeout, so the caller can fall back to the
        naive keyword search. Never raises.
    """
    if not question or not kb_content or not kb_content.strip():
        return None

    try:
        from google.genai import types

        client = _get_client()
        contents = (
            f"KNOWLEDGE BASE:\n{kb_content}\n\n"
            f"GUEST QUESTION: {question.strip()}"
        )
        cfg = types.GenerateContentConfig(
            system_instruction=_SYSTEM,
            temperature=0.0,  # deterministic, extractive — maximize faithfulness to the KB
            max_output_tokens=300,
        )
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL, contents=contents, config=cfg
            ),
            timeout=_TIMEOUT_S,
        )
        text = (getattr(resp, "text", None) or "").strip()
        if not text:
            return None
        answer = _MISS_REPLY if text.upper().startswith(_NOT_FOUND) else text
        return answer
    except asyncio.TimeoutError:
        logger.warning("kb_search: Gemini answer timed out after %ss", _TIMEOUT_S)
        return None
    except Exception as exc:  # noqa: BLE001 — never crash a live call
        logger.warning("kb_search: Gemini answer failed: %s", exc)
        return None
