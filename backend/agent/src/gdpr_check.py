"""End-of-call check: did the caller ask for their data to be deleted?

Runs once, after the call has ended, over the finished transcript. Deliberately
a separate cheap text call rather than something the live agent decides, so a
model mid-conversation can never trigger an erasure by mistake — and so a
failure here can never affect a call that is still in progress.

The model is asked for one word. Anything that is not an unambiguous YES is
treated as NO: a false negative leaves data in place until the 14-day retention
sweep takes it, while a false positive destroys a guest's transcript
irreversibly. Those are not equally bad, so the bias is deliberate.
"""

from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("molo-agent.gdpr")

_MODEL = os.getenv("GDPR_CHECK_MODEL", "gemini-2.5-flash")
_TIMEOUT_S = float(os.getenv("GDPR_CHECK_TIMEOUT_S", "15"))

# Kept deliberately narrow. It must not fire on a caller who merely mentions
# privacy, asks what data is held, or is told about deletion by the agent —
# only on an actual request from the caller to erase their data.
SYSTEM_PROMPT = """You read a phone call transcript between a hotel AI agent and a caller.

Answer exactly one question: did the CALLER ask for their personal data to be deleted?

Say YES only if the caller actually requested deletion or erasure of their data \
(for example "delete my data", "remove my number", "I want my information erased", \
"proszę usunąć moje dane"). A request counts even if the agent then asked them to \
confirm it.

Say NO for everything else, including:
- the AGENT mentioning data deletion, or offering it, without the caller asking
- the caller asking what data you hold, or how it is used, without asking to delete it
- the caller talking about deleting or cancelling anything else (a booking, a message, an order)
- the caller declining or taking back a deletion request

If you are unsure, say NO.

Reply with exactly one word: YES or NO."""

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


async def caller_requested_deletion(transcript: str) -> bool:
    """True only when the transcript clearly shows the caller asking for erasure.

    Never raises. Any error, timeout, empty transcript or ambiguous answer
    returns False — see the module docstring for why the bias runs that way.
    """
    if not transcript or not transcript.strip():
        return False

    try:
        from google.genai import types

        client = _get_client()
        cfg = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0.0,
            # thinking_budget=0 is the fix for a real failure: gemini-2.5-flash is
            # a THINKING model, and its reasoning tokens are drawn from
            # max_output_tokens. This ran with max_output_tokens=5, the model
            # spent the whole budget thinking, and `resp.text` came back EMPTY on
            # every call — logged as "model said '' -> False". The bias-to-NO rule
            # then read that as "no request", so a caller who genuinely asked for
            # erasure was silently ignored (observed live 2026-08-16).
            #
            # This is a yes/no classification; it needs no reasoning budget at
            # all. The larger token cap is belt-and-braces so a model that ignores
            # the budget still has room to answer.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            max_output_tokens=16,
        )
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=f"TRANSCRIPT:\n{transcript.strip()}",
                config=cfg,
            ),
            timeout=_TIMEOUT_S,
        )
        answer = (getattr(resp, "text", None) or "").strip().upper()
        if not answer:
            # An empty answer is a MALFUNCTION, not a "no" — log loudly with the
            # finish reason so it is diagnosable. This exact case silently
            # swallowed real erasure requests before thinking_budget was pinned
            # to 0; it must never look like a routine negative again.
            reason = None
            try:
                reason = str(resp.candidates[0].finish_reason)
            except Exception:  # noqa: BLE001
                pass
            logger.error(
                "GDPR check returned NO TEXT (finish_reason=%s, usage=%s) — "
                "treating as NO, but this is a fault, not a decision",
                reason, getattr(resp, "usage_metadata", None),
            )
            return False

        # Exact match, not "startswith" — "NO" would otherwise be missed and
        # "NOT A DELETION REQUEST" would read as NO by accident rather than by
        # rule. Anything unexpected falls through to False.
        decided = answer.rstrip(".!") == "YES"
        logger.info("GDPR check: model said %r -> %s", answer[:20], decided)
        return decided
    except asyncio.TimeoutError:
        logger.warning("GDPR check timed out after %ss — treating as NO", _TIMEOUT_S)
        return False
    except Exception as exc:  # noqa: BLE001 — must never break call teardown
        logger.warning("GDPR check failed (%s) — treating as NO", exc)
        return False
