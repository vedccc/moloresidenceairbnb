"""What a call cost us, in USD, from what the call actually used.

Not a per-minute guess. Three of the five components are billed on measured
usage — LLM tokens, TTS characters, STT audio seconds — and LiveKit's SDK
reports all three per session (`UsageCollector`). Those go in as measured. Only
the flat per-minute lines (agent session, SIP, Telnyx) are multiplied out from
the call duration, which is exactly how they are billed anyway.

The one genuinely estimated component is the KB search: it runs on Vertex AI
directly, outside LiveKit's metrics, so its tokens are approximated from the
character counts of the prompt and answer at 4 chars/token. It is a small share
of the total (the KB text is a few thousand tokens per search on Flash pricing).

Rates are LiveKit's published Build/Ship-tier prices as of 2026-08-16, for the
exact model triple this agent runs (see agent_pipeline: Gemma 4 31B, Deepgram
Nova-3 multilingual, Cartesia Sonic 3.5). Every one is env-tunable, because
prices move and a rate change must never need a rebuild:

    lk agent update-secrets --project molo-residence --id CA_9DeKbNqCaYHQ \\
      --secrets RATE_TELEPHONY_PER_MIN=0.0092

The result is stored in `call_logs.cost_usd`, with the full split, the usage it
came from and the rates applied in `call_logs.cost_breakdown` — so a number on
the dashboard can always be taken apart and checked against an invoice.

USD is what LiveKit and Telnyx bill in, so USD is what is stored. The dashboard
converts to EUR for display (frontend/src/lib/money.ts holds that one rate).
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from typing import Any

# Cost model version, recorded in every breakdown. Bump it when the SHAPE of
# the calculation changes (not when a rate changes — rates are recorded inline),
# so a mixed table can still be read years later.
COST_MODEL_VERSION = 1

# Rough tokens-per-character for the Vertex AI KB search. 4 is the usual English
# figure; Polish runs a little denser, which biases this slightly low.
_CHARS_PER_TOKEN = 4.0


def _rate(name: str, default: float) -> float:
    """A rate from the environment, falling back to the published default."""
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Rates:
    """Every price the agent is billed at, in USD.

    Defaults are LiveKit's published Build/Ship rates on 2026-08-16 plus the
    Telnyx per-minute already recorded in `agent_settings.cost_per_min_usd`.
    """

    # LLM — Gemma 4 31B through LiveKit Inference, per 1M tokens.
    llm_input_per_1m: float = field(default_factory=lambda: _rate("RATE_LLM_INPUT_PER_1M", 0.40))
    llm_cached_input_per_1m: float = field(
        default_factory=lambda: _rate("RATE_LLM_CACHED_INPUT_PER_1M", 0.20)
    )
    llm_output_per_1m: float = field(default_factory=lambda: _rate("RATE_LLM_OUTPUT_PER_1M", 1.20))

    # STT — Deepgram Nova-3 MULTILINGUAL, per minute of audio. Multilingual is a
    # different (higher) rate to monolingual: 0.0058 vs 0.0048. The agent runs
    # language="multi", so multilingual is the correct one.
    stt_per_min: float = field(default_factory=lambda: _rate("RATE_STT_PER_MIN", 0.0058))

    # TTS — Cartesia Sonic 3.5, per 1M characters synthesized. This is normally
    # the single biggest line on a call; roughly half the total.
    tts_per_1m_chars: float = field(default_factory=lambda: _rate("RATE_TTS_PER_1M_CHARS", 50.0))

    # LiveKit Cloud agent session, per minute of session time.
    session_per_min: float = field(default_factory=lambda: _rate("RATE_SESSION_PER_MIN", 0.01))

    # LiveKit's connection fee for bringing your own SIP provider, per minute.
    sip_per_min: float = field(default_factory=lambda: _rate("RATE_SIP_PER_MIN", 0.004))

    # Telnyx's own inbound per-minute — billed by Telnyx, not LiveKit. This is
    # the figure already stored in agent_settings.cost_per_min_usd->>'telnyx'.
    telephony_per_min: float = field(
        default_factory=lambda: _rate("RATE_TELEPHONY_PER_MIN", 0.0085)
    )

    # KB search — Gemini 2.5 Flash on Vertex AI, per 1M tokens.
    kb_input_per_1m: float = field(default_factory=lambda: _rate("RATE_KB_INPUT_PER_1M", 0.30))
    kb_output_per_1m: float = field(default_factory=lambda: _rate("RATE_KB_OUTPUT_PER_1M", 2.50))


RATES = Rates()


@dataclass
class CallUsage:
    """Everything a call consumed. Zero-filled so a partial call still prices."""

    duration_s: float = 0.0
    llm_input_tokens: int = 0
    llm_cached_input_tokens: int = 0
    llm_output_tokens: int = 0
    stt_audio_s: float = 0.0
    tts_characters: int = 0
    kb_input_chars: int = 0
    kb_output_chars: int = 0


def usage_from_summary(summary: Any, duration_s: float,
                       kb_input_chars: int = 0, kb_output_chars: int = 0) -> CallUsage:
    """Build a CallUsage from LiveKit's UsageSummary.

    Read with getattr defaults rather than field access: this is the one place
    that touches the SDK's shape, and a renamed field there must cost us an
    understated line on a dashboard, never a crash during call teardown.

    NOTE `llm_prompt_tokens` from LiveKit is the TOTAL input including cached
    ones, so the cached count is subtracted out before pricing (they bill at
    half). Treating them as two separate buckets would double-count.
    """
    prompt = int(getattr(summary, "llm_prompt_tokens", 0) or 0)
    cached = int(getattr(summary, "llm_prompt_cached_tokens", 0) or 0)
    cached = max(0, min(cached, prompt))
    return CallUsage(
        duration_s=max(0.0, float(duration_s or 0.0)),
        llm_input_tokens=prompt - cached,
        llm_cached_input_tokens=cached,
        llm_output_tokens=int(getattr(summary, "llm_completion_tokens", 0) or 0),
        stt_audio_s=float(getattr(summary, "stt_audio_duration", 0.0) or 0.0),
        tts_characters=int(getattr(summary, "tts_characters_count", 0) or 0),
        kb_input_chars=max(0, int(kb_input_chars or 0)),
        kb_output_chars=max(0, int(kb_output_chars or 0)),
    )


def blended_per_minute_usd(rates: Rates = RATES) -> float:
    """The all-in cost of one minute on LiveKit's own calculator assumptions.

    Used for two things and nothing else: pricing a call whose usage metrics
    never arrived (the session died early), and backfilling calls that predate
    this module. Both are marked `measured: false` in the breakdown.

    LiveKit's stated per-minute assumptions for a voice agent: 3,000 input and
    175 output LLM tokens, 600 TTS characters, one minute of STT audio.
    """
    return round(
        (3000 * rates.llm_input_per_1m + 175 * rates.llm_output_per_1m) / 1_000_000
        + rates.stt_per_min
        + 600 * rates.tts_per_1m_chars / 1_000_000
        + rates.session_per_min
        + rates.sip_per_min
        + rates.telephony_per_min,
        6,
    )


def estimate_cost(usage: CallUsage, rates: Rates = RATES, *, measured: bool = True) -> dict:
    """Price a call. Returns the breakdown dict stored in `cost_breakdown`.

    `total_usd` is rounded to 4dp to match the numeric(8,4) column; the
    components keep 6dp, because a 40-second call's LLM line is genuinely
    smaller than a hundredth of a cent and rounding each one to 4dp would zero
    them out and stop the parts adding up to the whole.
    """
    minutes = usage.duration_s / 60.0

    llm = (
        usage.llm_input_tokens * rates.llm_input_per_1m
        + usage.llm_cached_input_tokens * rates.llm_cached_input_per_1m
        + usage.llm_output_tokens * rates.llm_output_per_1m
    ) / 1_000_000
    stt = usage.stt_audio_s / 60.0 * rates.stt_per_min
    tts = usage.tts_characters * rates.tts_per_1m_chars / 1_000_000
    session = minutes * rates.session_per_min
    telephony = minutes * (rates.sip_per_min + rates.telephony_per_min)
    kb = (
        usage.kb_input_chars / _CHARS_PER_TOKEN * rates.kb_input_per_1m
        + usage.kb_output_chars / _CHARS_PER_TOKEN * rates.kb_output_per_1m
    ) / 1_000_000

    components = {
        "llm": round(llm, 6),
        "stt": round(stt, 6),
        "tts": round(tts, 6),
        "session": round(session, 6),
        "telephony": round(telephony, 6),
        "kb_search": round(kb, 6),
    }
    total = round(llm + stt + tts + session + telephony + kb, 4)

    return {
        "version": COST_MODEL_VERSION,
        "measured": measured,
        "total_usd": total,
        "components_usd": components,
        "usage": asdict(usage),
        "rates_usd": asdict(rates),
    }


def estimate_from_duration(duration_s: float, rates: Rates = RATES) -> dict:
    """Price a call from its duration alone, when no usage was captured.

    Deliberately routed through `estimate_cost` with a synthetic usage built
    from LiveKit's per-minute assumptions, so the breakdown has the same shape
    and the same component lines as a measured one — just flagged
    `measured: false`. A consumer never has to special-case it.
    """
    minutes = max(0.0, float(duration_s or 0.0)) / 60.0
    usage = CallUsage(
        duration_s=max(0.0, float(duration_s or 0.0)),
        llm_input_tokens=int(round(3000 * minutes)),
        llm_output_tokens=int(round(175 * minutes)),
        stt_audio_s=max(0.0, float(duration_s or 0.0)),
        tts_characters=int(round(600 * minutes)),
    )
    return estimate_cost(usage, rates, measured=False)
