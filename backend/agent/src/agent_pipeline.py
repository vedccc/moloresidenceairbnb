"""Pipeline (STT->LLM->TTS) variant of the Molo voice agent.

Separate worker from agent.py (which is imported, never edited). Fixes the
speech-to-speech silence-during-tool-calls issue by letting LiveKit's framework
govern turn-taking. All three model legs run through LiveKit Inference (one
LiveKit API key, no extra provider accounts/plugins).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from livekit import agents, rtc
from livekit.agents import (AgentServer, AgentSession, room_io, inference, tts as tts_api,
                            BackgroundAudioPlayer, BuiltinAudioClip, AudioConfig,
                            function_tool, metrics as lk_metrics, RunContext)
from livekit.api import LiveKitAPI
from livekit.plugins import noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

# Import from the live agent — NEVER edit agent.py.
# NOTE: agent.py's GREETING is deliberately NOT imported any more. It is an
# *instruction* the model improvises a greeting from, so the caller heard slightly
# different wording every call. The client requires a fixed, verbatim opening that
# includes an AI disclosure and a transcription/data notice, so the pipeline now
# speaks WELCOME_MESSAGE below instead. agent.py itself is untouched.
from agent import MoloAgent, _now_warsaw, _now_iso  # noqa
import call_cost
import call_outcomes
import gdpr_check
import kb_search
import molo_supabase as db
import sms
from pipeline_prompt import PIPELINE_INSTRUCTIONS, render_instructions
from thinking_filter import strip_thinking_tokens

logger = logging.getLogger("molo-agent-pipeline")

PIPELINE_AGENT_NAME = "molo-gemma"
PIPELINE_INSTRUCTIONS_TEXT = PIPELINE_INSTRUCTIONS

# Fixed opening line, spoken VERBATIM at the start of every call (client-specified
# 2026-08-15). This is deliberately not model-generated: it carries an AI
# disclosure and a transcription / data-deletion notice, so the wording must be
# identical on every call and cannot be left to the model to paraphrase.
#
# Always English. The agent speaks first, before the caller has said anything, so
# there is no language signal to adapt to yet; the model still switches to Polish
# for the rest of the call once it hears the caller (see the Tone & Style section
# of the prompt).
WELCOME_MESSAGE = (
    "Hi, welcome to Molo Residence. My name is Tomasz, I'm an AI. This call is "
    "being transcribed for quality purposes. Are you an existing guest, or are "
    "you looking to book a stay?"
)

# Language the FILLER WORDING defaults to before the caller has said anything.
# This is about which words are spoken, NOT the accent — the accent is TTS_LANGUAGE
# and is held fixed (see TTS_FOLLOW_CALLER_LANGUAGE).
DEFAULT_FILLER_LANGUAGE = "en"

# Model config — all env-tunable so they can be changed without a rebuild.
# STT: Deepgram Nova-3 in MULTILINGUAL mode (client requirement 2026-08-15).
# language="multi" makes Nova-3 detect the language per speech segment, so a
# caller switching EN<->PL mid-call is transcribed correctly in one stream.
# Multilingual is billed at a different rate to monolingual — see LiveKit's
# inference pricing. To A/B back to Whisper: STT_MODEL=cartesia/ink-whisper
# STT_LANGUAGE= (empty; Whisper auto-detects and rejects a language hint).
STT_MODEL = os.getenv("STT_MODEL", "deepgram/nova-3")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "multi")

# Keyterm prompting — biases Deepgram toward the proper nouns this hotel actually
# uses. Every one of these is a word an English-speaking caller says badly and
# Deepgram then mangles; on a real call (2026-08-16) "Pułaskiego 6a" came back as
# "Policy AOS CXR", then "Go six eight", then "Google six a", and "Sopot" simply
# vanished from the transcript twice ("what is known for"). Both cost the caller
# three attempts each.
#
# Deliberately NOT the whole knowledge base. Keyterms work by biasing the decoder,
# so a long list of ordinary words dilutes the boost and can pull normal speech
# toward them. Only distinctive names go in: places, streets, brands and the Wi-Fi
# SSIDs a guest might read back.
#
# Diacritics are included as written (Pułaskiego) alongside a plain-ASCII variant,
# since callers pronounce it as spelled and Deepgram may emit either form.
STT_KEYTERMS = [
    # City and streets — the addresses identify_guest has to disambiguate
    "Sopot",
    "Pułaskiego", "Pulaskiego",
    "Chmielewskiego",
    "Chopina",
    "Sobieskiego",
    "Bohaterów Monte Cassino",
    # Property and brand names
    "Molo Residence",
    "Hotel Molo Residence",
    "Molo Residence Apartments",
    "Apartament Molo",
    "Apartament Molo Superior",
    "Riviera Residence Apartments",
    "Riviera Rooms",
    "Boho Rooms",
    "Boho Apartment",
    "Boho Apartament",
    # Wi-Fi network names, which guests read back over the phone
    "MoloResidence",
    "MoloResidence Apartments",
    # Things guests ask about by name
    "Forest Opera",
    "SmartHotel",
    "Profitroom",
    "Booking.com",
]
LLM_MODEL = os.getenv("LLM_MODEL", "google/gemma-4-31b-it")

# TTS: Cartesia Sonic-3.5 on the client's chosen voice, rendering Polish.
#
# This exact triple (sonic-3.5 / 43e52207-… / Polish) was VERIFIED WORKING by the
# client in the LiveKit Agent Builder on 2026-08-15 — it synthesized audio in the
# live preview. Keep it in sync with that screen; it is the known-good reference.
# Note the client asked for "Sonic 3" in writing but their verified config is
# Sonic 3.5, so 3.5 is what ships.
#
# Moved off ElevenLabs entirely. Both ElevenLabs voice ids the client picked came
# from the *voice library* — community voices, which the LiveKit Inference gateway
# cannot resolve (it serves only the default-voice set). That took the phone line
# silent for two calls; see the note in _build_tts. Cartesia default voices like
# this one resolve through the gateway fine — the limitation is specific to
# community/cloned voices, not to Inference generally.
TTS_MODEL = os.getenv("TTS_MODEL", "cartesia/sonic-3.5")
TTS_VOICE = os.getenv("CARTESIA_VOICE_ID", "43e52207-96fc-4e01-aaf8-cae317e43fdb")
TTS_LANGUAGE = os.getenv("TTS_LANGUAGE", "pl")

# Whether the TTS retunes to the caller's detected language each turn. ON.
#
# Cartesia's `language` does two things at once: it sets the accent AND it drives
# text normalisation. With "pl" held over an English sentence, digits and ordinals
# get expanded by POLISH rules — "August 16th … the 18th" came out as Polish
# number words mid-sentence (observed on a live call, 2026-08-15). Following the
# caller keeps numbers and dates readable in whichever language is being spoken.
#
# The greeting still opens on TTS_LANGUAGE (Polish-accented, and it contains no
# numbers), then adapts from the caller's first turn.
TTS_FOLLOW_CALLER_LANGUAGE = os.getenv("TTS_FOLLOW_CALLER_LANGUAGE", "1") == "1"

# Known-good FLOOR on a DIFFERENT voice: Cartesia's stock "Katie", the voice the
# agent ran on before today and therefore proven to synthesize. Its entire job is
# to still speak if the primary voice id ever stops resolving — the exact failure
# that took the line down earlier today. Never point it at the primary's voice.
TTS_FLOOR_MODEL = os.getenv("TTS_FLOOR_MODEL", "cartesia/sonic-3.5")
TTS_FLOOR_VOICE = os.getenv("TTS_FLOOR_VOICE", "f786b574-daa5-4673-aa0c-cbe3e8534c02")

# Cartesia generation config — forwarded to the LiveKit Inference gateway via
# inference.TTS(extra_kwargs=...). NOTE this is a COMPLETELY DIFFERENT parameter
# set to ElevenLabs' voice_settings (stability / similarity_boost / style /
# use_speaker_boost). Those keys are meaningless to Cartesia and are gone; leaving
# them in would silently drop all the anti-robotic tuning. Both knobs are
# env-tunable so the voice can be adjusted by ear without a rebuild.
#   speed:   numeric multiplier, valid range [0.6, 1.5] — same scale as the
#            ElevenLabs value it replaces, so the tuned 1.1 ports across directly
#            (1.0 read too slow/scripted).
#   emotion: Cartesia emotion string (neutral/calm/content/happy/excited/...).
#            "content" = warm and pleasant without the over-eager sales lilt that
#            "happy"/"excited" give a hotel concierge. Available on sonic-3+.
TTS_SPEED = float(os.getenv("TTS_SPEED", "1.1"))
TTS_EMOTION = os.getenv("TTS_EMOTION", "content")

# Turn-taking — env-tunable to balance "cutting in" vs "dead air" by ear without a
# rebuild. Earlier these were 0.8/4.0/0.75 to stop cut-in, which added noticeable
# silence after every caller turn; moderated here to cut dead air while still
# giving the caller a beat to keep talking.
MIN_ENDPOINTING_DELAY = float(os.getenv("MIN_ENDPOINTING_DELAY", "0.6"))   # silence after caller stops before agent speaks
MAX_ENDPOINTING_DELAY = float(os.getenv("MAX_ENDPOINTING_DELAY", "2.0"))   # cap when EOU is unsure — was 4.0s = the 4s dead-air gaps
VAD_MIN_SILENCE = float(os.getenv("VAD_MIN_SILENCE", "0.6"))               # Silero end-of-speech window

# Dead-air / duration guards — copied from agent.py so behaviour matches.
# Dead air is measured from when it became the CALLER's turn — the later of
# "they last said something" and "the agent finished speaking". Measuring from
# the caller's words alone would start the clock under the agent's own reply and
# fire a follow-up while it was still mid-sentence; measuring from the agent's
# speech alone (the previous behaviour) let a chatty agent reset the timer
# forever, so a silent caller was never noticed.
SILENCE_FOLLOWUP_S = float(os.getenv("SILENCE_FOLLOWUP_S", "7"))    # first nudge
SILENCE_MAX_FOLLOWUPS = int(os.getenv("SILENCE_MAX_FOLLOWUPS", "2"))
SILENCE_HANGUP_S = float(os.getenv("SILENCE_HANGUP_S", "30"))       # then end the call
MAX_CALL_DURATION = 7 * 60

# ── Front-desk opening hours ────────────────────────────────────────────────
# Local Sopot time, 24h, [open, close). transfer_call is gated on these: outside
# them there is nobody to transfer to, so the agent says so instead of dialling
# into an unanswered phone.
#
# ⚠️ THESE HOURS ARE UNVERIFIED. The knowledge base has no reception/front-desk
# hours anywhere — only check-in/check-out times (14:00-16:00 / 11:00-12:00). The
# client guessed "maybe 8am to 5pm, but I'm not 100% sure", and that guess is what
# ships here. Both ends are env-tunable so they can be corrected without a rebuild:
#   lk agent update-secrets --project molo-residence --id CA_9DeKbNqCaYHQ \
#     --secrets FRONT_DESK_OPEN_HOUR=9,FRONT_DESK_CLOSE_HOUR=18
FRONT_DESK_OPEN_HOUR = int(os.getenv("FRONT_DESK_OPEN_HOUR", "8"))
FRONT_DESK_CLOSE_HOUR = int(os.getenv("FRONT_DESK_CLOSE_HOUR", "17"))

# Weekdays the desk is staffed, as Python weekday() numbers (Mon=0 … Sun=6).
# Mon-Fri by default — closed all weekend (client, 2026-08-15). Env value is a
# comma-separated list, e.g. FRONT_DESK_DAYS=0,1,2,3,4,5 to add Saturday.
FRONT_DESK_DAYS = frozenset(
    int(d) for d in os.getenv("FRONT_DESK_DAYS", "0,1,2,3,4").split(",") if d.strip()
)


def _front_desk_is_open(now=None) -> bool:
    """Is the front desk staffed right now, in Sopot local time?

    Both the weekday and the hour must match. A Saturday inside 08:00-17:00 is
    still closed — the weekend check is not a nicety, it is the difference between
    a guest being told to email and being dialled into an empty office.
    """
    now = now or _now_warsaw()
    if now.weekday() not in FRONT_DESK_DAYS:
        return False
    return FRONT_DESK_OPEN_HOUR <= now.hour < FRONT_DESK_CLOSE_HOUR


def _spoken_hour(hour: int) -> str:
    """A 24h hour as something TTS reads naturally ("8 AM", "5 PM")."""
    suffix = "AM" if hour < 12 else "PM"
    h = hour % 12 or 12
    return f"{h} {suffix}"


# The email is written the way it should be SPOKEN, not as an address. TTS reads
# "info@moloresidence.pl" as a mangled URL; spelling it out loud is the client's
# own convention (they use the same form in the system prompt).
SPOKEN_EMAIL = "info at molo residence dot pl"

# Where the "someone asked for erasure" alert goes. Staff-facing, not guest-facing.
# Unset it to turn the alert off; erasure still happens either way.
GDPR_ALERT_PHONE = os.getenv("GDPR_ALERT_PHONE", "+48608466046")


def _notify_gdpr_erasure(caller_phone: str, calls_redacted: int) -> None:
    """Text the operator that an erasure request came in and was carried out.

    Sent AFTER the deletion, so the message only ever reports something that
    actually happened. Guarded: a failed SMS must not undo or obscure a
    completed erasure — the dashboard still shows it, this is only the nudge.
    """
    if not GDPR_ALERT_PHONE:
        return
    try:
        plural = "call" if calls_redacted == 1 else "calls"
        sms.send_sms(
            GDPR_ALERT_PHONE,
            f"Molo Residence: {caller_phone} requested deletion of their data. "
            f"Done automatically — phone number and transcript removed from "
            f"{calls_redacted} {plural}. Visible in the dashboard.",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("GDPR alert SMS failed: %s", exc)


_DAY_NAMES = {
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    "pl": ("poniedziałku", "wtorku", "środy", "czwartku", "piątku", "soboty", "niedzieli"),
}


def _spoken_days(language: str = "en") -> str:
    """Describe FRONT_DESK_DAYS out loud, derived rather than hardcoded so the
    sentence stays truthful if the days are changed via env."""
    days = sorted(FRONT_DESK_DAYS)
    names = _DAY_NAMES.get(language, _DAY_NAMES["en"])
    if not days:
        return ""
    joiner = " to " if language == "en" else " do "
    # Contiguous run (the normal case, Mon-Fri) reads as a range.
    if days == list(range(days[0], days[-1] + 1)) and len(days) > 1:
        return f"{names[days[0]]}{joiner}{names[days[-1]]}"
    return ", ".join(names[d] for d in days)


def _closed_message(language: str = "en") -> str:
    """What the caller hears when they ask for a human out of hours."""
    open_s, close_s = _spoken_hour(FRONT_DESK_OPEN_HOUR), _spoken_hour(FRONT_DESK_CLOSE_HOUR)
    if language == "pl":
        return (
            f"Przepraszam, konsultanci są dostępni tylko od {_spoken_days('pl')}, "
            f"w godzinach od {FRONT_DESK_OPEN_HOUR}:00 do {FRONT_DESK_CLOSE_HOUR}:00. "
            f"Proszę zadzwonić ponownie w tych godzinach albo napisać na {SPOKEN_EMAIL}."
        )
    return (
        f"Sorry, humans are only available {_spoken_days('en')}, from {open_s} to "
        f"{close_s}. Please feel free to call back, or you can send a message to "
        f"{SPOKEN_EMAIL}."
    )


def _stt_kwargs() -> dict:
    """STT kwargs — pass `language` only when set. Whisper auto-detects (EN+PL) with
    no language, whereas Deepgram nova-3 needs language="multi" (set STT_LANGUAGE).

    Keyterms ride along in extra_kwargs as Deepgram's native `keyterm` parameter.
    The SDK's managed `STTContextOptions` would be tidier but does not exist in
    livekit-agents 1.4.4, which is pinned (see pyproject) — so this talks to the
    provider parameter directly.

    Only sent for Nova-3: keyterm prompting is a Nova-3 feature, and passing it to
    another model risks the gateway rejecting the whole request rather than
    ignoring one field.
    """
    kw: dict = {"model": STT_MODEL}
    if STT_LANGUAGE:
        kw["language"] = STT_LANGUAGE
    if STT_KEYTERMS and "nova-3" in STT_MODEL:
        kw["extra_kwargs"] = {"keyterm": list(STT_KEYTERMS)}
    return kw


def _cartesia_tts(model: str, voice: str, language: str | None = None):
    """One Cartesia leg via the LiveKit Inference gateway."""
    tts_kwargs = {"model": model}
    if voice:
        tts_kwargs["voice"] = voice
    if language:
        tts_kwargs["language"] = language
    # Cartesia generation config rides through the LiveKit Inference gateway as
    # extra_kwargs (inference.TTS forwards this dict verbatim).
    tts_kwargs["extra_kwargs"] = {
        "speed": TTS_SPEED,
        "emotion": TTS_EMOTION,
    }
    return inference.TTS(**tts_kwargs)


def _build_tts():
    """Ordered TTS preferences wrapped in a FallbackAdapter.

    1. Cartesia Sonic-3, the client's voice, rendering Polish.
    2. Cartesia Sonic-3.5 on stock "Katie" — the known-good floor, so the phone
       still gets a voice if the primary voice id can't be resolved.

    Why FallbackAdapter and not a try/except ladder: an unusable voice does NOT
    fail at construction. inference.TTS builds fine and only errors on the first
    real synthesis, per utterance —

        BAD_REQUEST: "A voice with voice_id ... does not exist." retryable:false

    A construction-time ladder therefore never fires, and the caller just hears
    silence for the whole call (observed live 2026-08-15 on an ElevenLabs
    community voice: two calls, both silent until the caller hung up).
    FallbackAdapter fails over at SYNTHESIS time, the only place this class of
    error surfaces. The two legs must stay on DIFFERENT voice ids, or the floor
    fails for exactly the same reason the primary did.
    """
    candidates = []

    try:
        candidates.append(_cartesia_tts(TTS_MODEL, TTS_VOICE, TTS_LANGUAGE))
        logger.info("TTS candidate 1: Cartesia %s voice=%s language=%s",
                    TTS_MODEL, TTS_VOICE, TTS_LANGUAGE)
    except Exception as exc:  # noqa: BLE001 — never let TTS setup kill the worker
        logger.error("primary Cartesia TTS unavailable: %s", exc)

    try:
        candidates.append(_cartesia_tts(TTS_FLOOR_MODEL, TTS_FLOOR_VOICE, TTS_LANGUAGE))
        logger.info("TTS candidate %d: Cartesia %s voice=%s (known-good floor)",
                    len(candidates), TTS_FLOOR_MODEL, TTS_FLOOR_VOICE)
    except Exception as exc:  # noqa: BLE001
        logger.error("Cartesia floor unavailable: %s", exc)

    if not candidates:
        # Nothing could even be constructed — almost always a missing
        # LIVEKIT_API_KEY. Fail loudly here rather than handing AgentSession a
        # TTS that cannot speak, which presents to the caller as pure silence.
        raise RuntimeError(
            "no TTS could be constructed — check LIVEKIT_API_KEY on the agent"
        )

    # max_retry_per_tts=1: the voice-does-not-exist error is flagged
    # retryable:false, so extra attempts only add dead air before failing over.
    # One attempt each keeps time-to-first-audio short on a phone call.
    #
    # The legs are returned alongside the adapter because FallbackAdapter has no
    # update_options() of its own — switching the spoken language at runtime means
    # calling update_options() on each leg directly (see _set_tts_language).
    return tts_api.FallbackAdapter(candidates, max_retry_per_tts=1), candidates


def _set_tts_language(legs, language: str) -> None:
    """Retune every TTS leg to `language`. Guarded — a failure here must not stop
    the agent speaking, it just means this utterance keeps the previous accent."""
    for leg in legs:
        try:
            leg.update_options(language=language)
        except Exception as exc:  # noqa: BLE001
            logger.warning("TTS language switch to %s failed: %s", language, exc)


def build_pipeline_session() -> AgentSession:
    """The one real difference from agent.py: a pipeline session instead of the
    native-audio RealtimeModel. VAD + turn detection + interruption knobs match
    agent.py — but here they are ACTIVE (they were inert with native audio)."""
    tts_adapter, tts_legs = _build_tts()
    session = AgentSession(
        # Silero VAD: widen the silence window 0.55 -> 0.75 so brief mid-sentence
        # pauses aren't read as end-of-turn. This is the ONLY end-of-turn guard on
        # Polish speech — the turn-detector model below has no Polish support.
        vad=silero.VAD.load(min_silence_duration=VAD_MIN_SILENCE),
        turn_detection=MultilingualModel(),
        # Turn-taking (env-tunable) — balanced to reduce dead air while still giving
        # the caller a beat before the agent speaks:
        min_endpointing_delay=MIN_ENDPOINTING_DELAY,
        max_endpointing_delay=MAX_ENDPOINTING_DELAY,
        min_interruption_words=2,       # was 10 — 10 made the agent almost impossible to barge in on
        min_interruption_duration=0.8,  # filters brief phone-line noise
        false_interruption_timeout=2.0, # telephony: resume after a brief false trip
        resume_false_interruption=True,
        stt=inference.STT(**_stt_kwargs()),   # Deepgram Nova-3, language="multi"
        llm=inference.LLM(model=LLM_MODEL),
        tts=tts_adapter,                      # FallbackAdapter over the Cartesia legs
    )
    # Stashed so the runner can retune the spoken language mid-call; FallbackAdapter
    # itself exposes no update_options().
    session._molo_tts_legs = tts_legs
    return session


# Marker tokens whose PRESENCE in a chunk means it carries Gemma-4 reasoning and
# must be run through the whole-message stripper. A chunk WITHOUT any of these is
# ordinary speech and must pass through untouched.
_MARKER_TOKENS = ("<think>", "<|channel|>")


def _clean_chunk(chunk: str) -> str:
    """Clean a SINGLE streaming LLM delta on its way to TTS.

    The framework feeds `tts_node` the raw per-delta text stream (the sentence
    tokenizer runs downstream), so deltas are word fragments like "Your", " Wi",
    "-Fi". `strip_thinking_tokens` is a WHOLE-MESSAGE cleaner: it ends with
    `re.sub(r"\\s+", " ", out).strip()`, which would strip the leading/trailing
    space off every delta and glue words together ("YourWi-Fi..."). So we only
    invoke it when a delta actually contains a reasoning marker; a marker-free
    delta is returned BYTE-FOR-BYTE UNCHANGED (spacing preserved). This keeps the
    safety-net intent (issue #6375) without corrupting normal speech."""
    low = chunk.lower()
    if any(tok in low for tok in _MARKER_TOKENS):
        return strip_thinking_tokens(chunk)
    return chunk


async def _clean_stream(source):
    """Async-generator wrapper over `_clean_chunk` for a delta stream.

    Every chunk is yielded (including lone-whitespace deltas) so inter-word
    spacing survives; only marker-bearing chunks are transformed."""
    async for chunk in source:
        yield _clean_chunk(chunk)


class PipelineMoloAgent(MoloAgent):
    """Same tools/prompt as MoloAgent; only the TTS text is cleaned.

    Overrides `tts_node` to strip Gemma-4 reasoning markers before synthesis
    (LiveKit issue #6375). The base `Agent.tts_node(self, text, model_settings)`
    returns an `AsyncIterable[AudioFrame]` (or a coroutine resolving to one); the
    framework awaits a coroutine result if needed, then iterates it. We insert a
    per-chunk cleaning stage (`_clean_stream`) in front of the incoming text
    stream and delegate the actual synthesis to the base implementation, matching
    that contract exactly."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # identify_guest hasn't run yet, so kb_content is still the general KB.
        # Capture it now — it is the only chance. agent.py overwrites kb_content
        # with the room's KB and keeps no reference to what it replaced.
        self._general_kb: str = self.kb_content or ""
        # Characters sent to / returned by the Vertex AI KB search. It runs
        # outside LiveKit, so its usage appears in no LiveKit metric; counting
        # the text here is the only way that line reaches the cost breakdown.
        # See call_cost.CallUsage.
        self.kb_input_chars: int = 0
        self.kb_output_chars: int = 0

    async def tts_node(self, text, model_settings):
        return super().tts_node(_clean_stream(text), model_settings)

    def _kb_with_general(self) -> str:
        """The room's KB PLUS the portfolio-wide general KB.

        Why this exists: agent.py's identify_guest REPLACES kb_content with the
        room's KB, and the kb_for_room view cannot supply the general one —

            JOIN knowledge_bases kb ON kb.property_id = p.id

        and a general KB has property_id NULL, so it never joins. (The view even
        has a `WHEN 'general' THEN 1` priority branch that is therefore dead.)

        The effect was that an identified guest lost all portfolio-level
        knowledge: they could ask for their Wi-Fi password and get it, then ask
        something answered only by the general KB — locations, room types,
        booking channels, Sopot info — and be told we don't have that detail.

        The room KB is placed FIRST and the general KB last, so kb_search.py's
        "ROOM-SPECIFIC INFO overrides the general info below" instruction keeps
        working: anything the room defines still wins.
        """
        room = self.kb_content or ""
        general = self._general_kb or ""
        if not general or general == room or general in room:
            return room          # pre-identification, or already included
        if not room:
            return general
        return (
            f"{room}\n\n---\n\n"
            f"### PORTFOLIO-WIDE GENERAL INFO (applies to all Molo Residence "
            f"properties; anything above about this specific room or property "
            f"takes precedence)\n{general}"
        )

    async def _answer_kb(self, question: str) -> str:
        """Same shape as agent.py's _answer_kb, but searching room + general."""
        key = question.strip().lower()
        cached = self._kb_answer_cache.get(key)
        if cached is not None:
            return cached

        combined = self._kb_with_general()
        # Counted BEFORE the call and only on a cache miss: a memoized answer
        # costs nothing, and a lookup that then fails still burned the prompt.
        self.kb_input_chars += len(combined) + len(question)
        result = await kb_search.answer_from_kb(question, combined)
        if result is not None:
            self.kb_output_chars += len(result)
        if result is None:
            # Keyword fallback reads self.kb_content, so point it at the combined
            # text for the duration and put it back afterwards.
            original = self.kb_content
            try:
                self.kb_content = combined
                result = self._search_kb_content(question)
            finally:
                self.kb_content = original
        self._kb_answer_cache[key] = result
        return result

    # Fixed, non-interruptible spoken filler per tool. Covers the tool-call gap
    # with a consistent phrase (this replaces the removed typing sound). Spoken
    # with allow_interruptions=False so a fast tool return can't cut it off; the
    # tool's result speech queues after it. Overrides the no-op hook on MoloAgent,
    # so only the pipeline speaks fillers (the native-audio agent is unaffected).
    # Varied phrasings that do NOT all open with the same acknowledgement word
    # ("Sure/Okay/Great/Perfect"): the model tends to open its own reply with
    # "Sure thing!" too, and stacking those read as robotic "sure … sure".
    # Client-authored wording (2026-08-15), per language. `session.say()` speaks
    # the literal string — nothing translates it — so a Polish caller would hear an
    # English filler unless we hold both and pick by detected language. The value
    # is keyed by the language code Deepgram reports for the caller's last turn
    # (see _on_caller_language); anything we have no translation for falls back to
    # English.
    #
    # search_kb is deliberately SILENT (None): the client wants no acknowledgement
    # while the knowledge base is queried. The slow-tool typing cover below still
    # applies if the lookup runs long, so a slow search isn't bare dead air.
    _TOOL_FILLERS = {
        "identify_guest": {
            "en": "thank you very much, I'll need just a moment to find your reservation.",
            "pl": "dziękuję bardzo, potrzebuję chwilę, żeby odnaleźć rezerwację.",
        },
        "search_kb": None,
        "suggest_available_rooms": {
            "en": "Okay perfect, let me quickly check on those dates for you.",
            "pl": "Okej, świetnie, już sprawdzam te terminy.",
        },
        "send_booking_link": {
            "en": "alright, great! I'll send that booking link over to you now.",
            "pl": "świetnie! Wysyłam teraz link do rezerwacji.",
        },
        "raise_maintenance_ticket": {
            "en": "okay thanks, I'll raise that ticket for you right now.",
            "pl": "dobrze, dziękuję, zgłaszam to teraz.",
        },
        "transfer_call": {
            "en": "Alright, I am now trying to transfer you to the front desk.",
            "pl": "Dobrze, próbuję teraz połączyć Pana z recepcją.",
        },
    }

    # When the model chains tools in one turn (e.g. identify_guest -> search_kb),
    # each tool would otherwise speak its filler ~3s apart, stacking two canned
    # lines back-to-back. Speak at most one filler per this window so only the
    # first of a rapid chain is heard. Fillers across separate caller turns are
    # always many seconds apart, so ordinary use is unaffected.
    _FILLER_COOLDOWN_S = 8.0

    # Dynamic slow-tool cover: a soft keyboard-typing sound that fills dead air ONLY
    # when a tool runs longer than _COVER_AFTER_S. Armed from _before_tool, so it can
    # ONLY fire during a tool call — never on a plain turn (that every-turn typing is
    # what the client removed). Low volume so it sits UNDER the voice. Env-tunable.
    _COVER_AFTER_S = float(os.getenv("COVER_AFTER_S", "2.0"))     # fast tools (<2s) never trigger it
    _COVER_VOLUME = float(os.getenv("COVER_VOLUME", "0.25"))      # subtle, under the speech
    _COVER_CLIP = BuiltinAudioClip.KEYBOARD_TYPING2              # shorter/lighter of the two clips

    def _stop_cover(self) -> None:
        """Stop any playing cover and invalidate a pending cover timer. Called when
        the agent leaves 'thinking' (result audio is starting) — idempotent."""
        self._cover_gen = getattr(self, "_cover_gen", 0) + 1
        h = getattr(self, "_cover_handle", None)
        if h is not None and not h.done():
            h.stop()
        self._cover_handle = None

    async def _start_cover_after_delay(self, gen: int) -> None:
        """After _COVER_AFTER_S, start the typing cover IFF this is still the current
        tool phase and the agent is still thinking (i.e. the tool is genuinely slow)."""
        try:
            await asyncio.sleep(self._COVER_AFTER_S)
        except asyncio.CancelledError:
            return
        bg = getattr(self, "_bg", None)
        if bg is None or gen != getattr(self, "_cover_gen", 0):
            return  # a newer tool phase superseded this, or no player wired
        try:
            if self.session.agent_state != "thinking":
                return  # fast tool already returned — no dead air to cover
            h = getattr(self, "_cover_handle", None)
            if h is None or h.done():
                self._cover_handle = bg.play(
                    AudioConfig(self._COVER_CLIP, volume=self._COVER_VOLUME), loop=True,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("slow-tool cover failed: %s", exc)

    # Language the caller last spoke, as reported by Deepgram. Drives both the
    # filler wording and the TTS accent. Starts as the greeting's language because
    # the agent speaks first, before there is anything to detect.
    # Language the FILLER WORDING uses. Starts English because the agent speaks
    # first and there is nothing to detect yet.
    caller_language = DEFAULT_FILLER_LANGUAGE

    # Language the TTS is CURRENTLY tuned to. Tracked separately from
    # caller_language and seeded from TTS_LANGUAGE, because the two genuinely start
    # out different: the greeting opens Polish-accented while the filler wording
    # defaults to English. Comparing against caller_language instead would make the
    # very first retune a no-op for an English caller (base "en" == caller_language
    # "en" → early return) and the voice would stay stuck on Polish numbers — the
    # exact bug this pairing is here to prevent.
    _tts_language = TTS_LANGUAGE

    def _on_caller_language(self, language: str | None) -> None:
        """Follow the caller: filler wording AND the TTS language.

        Deepgram nova-3 in multi mode reports a language per transcribed turn.

        Retuning the TTS matters for more than accent — Cartesia's `language` also
        drives text normalisation, so a Polish-tuned voice reads "August 16th" as
        Polish number words even inside an English sentence.
        """
        if not language:
            return
        # Deepgram may return a region-qualified tag ("en-US"); we want the base.
        base = language.split("-")[0].lower()
        self.caller_language = base          # filler wording, cheap to set every turn

        if not TTS_FOLLOW_CALLER_LANGUAGE or base == self._tts_language:
            return
        # Agent.session raises RuntimeError when the agent isn't attached to a
        # running session, so this can't be a plain getattr. Losing the retune is
        # survivable — the filler wording above has already switched.
        try:
            legs = getattr(self.session, "_molo_tts_legs", None)
        except Exception:  # noqa: BLE001
            legs = None
        if legs:
            logger.info("caller language %s -> %s; retuning TTS", self._tts_language, base)
            _set_tts_language(legs, base)
            self._tts_language = base

    def _filler_for(self, key: str) -> str | None:
        """The filler for `key` in the caller's current language, or None if the
        tool is meant to be silent."""
        variants = self._TOOL_FILLERS.get(key)
        if not variants:
            return None
        return variants.get(self.caller_language) or variants.get("en")

    @function_tool()
    async def transfer_call(self, context: RunContext) -> str:
        """Use to transfer the caller to a live human."""
        # Overrides MoloAgent.transfer_call to gate on front-desk opening hours.
        # agent.py is never edited, so the check lives here.
        #
        # Why gate at all: outside hours the transfer dials a phone nobody
        # answers. The caller sits through ringing and then a dead line, which is
        # worse than being told plainly that staff are unavailable.
        if not _front_desk_is_open():
            now = _now_warsaw()
            msg = _closed_message(self.caller_language)
            logger.info("transfer refused — front desk closed (local %s, open %d-%d)",
                        now.strftime("%H:%M"), FRONT_DESK_OPEN_HOUR, FRONT_DESK_CLOSE_HOUR)
            self._record_tool("transfer_call", {"local_time": now.isoformat()},
                              f"refused, front desk closed: {msg}")
            # SAY: so the model speaks it rather than treating it as a note. The
            # text is already guest-facing and in the caller's language.
            return f"SAY (word for word, do not add anything): {msg}"
        return await super().transfer_call(context)

    # Marks the injected "you already said this" notes so each one replaces the
    # last instead of piling up over a long call.
    _SPOKEN_NOTE_ID = "molo-spoken-filler"

    async def _note_already_spoken(self, phrase: str) -> None:
        """Tell the model, in its own context, that `phrase` was just spoken aloud.

        The filler is played with add_to_chat_ctx=False, so without this the model
        has NO IDEA it was said — and then narrates the same action itself. That is
        the observed double-up on send_booking_link (2026-08-15): the filler says
        "I'll send that booking link over to you now", the tool result says "tell
        them to tap it", and the model dutifully says the first sentence again.

        Injected as a SYSTEM message, deliberately NOT as an assistant turn. Adding
        it as assistant text is what add_to_chat_ctx=True does, and that made the
        model continue straight on from the filler ("Let me check that for
        you.Hmm, I'm sorry…") — the very reason it was turned off. A system note
        reads as an instruction instead of a half-finished sentence to complete.

        Replaces the previous note rather than appending, so a seven-minute call
        doesn't accumulate a stack of stale "you already said…" lines.
        """
        try:
            ctx = self.chat_ctx.copy()
            ctx.items[:] = [
                i for i in ctx.items
                if not str(getattr(i, "id", "")).startswith(self._SPOKEN_NOTE_ID)
            ]
            ctx.add_message(
                role="system",
                id=f"{self._SPOKEN_NOTE_ID}-{int(time.monotonic() * 1000)}",
                content=(
                    f'You have ALREADY said this out loud to the caller just now: "{phrase}" '
                    "The caller has heard it. Do NOT say it again, and do NOT restate the "
                    "same idea in different words. Continue from there with the NEW "
                    "information only."
                ),
            )
            await self.update_chat_ctx(ctx)
        except Exception as exc:  # noqa: BLE001 — never let this break a live call
            logger.warning("could not note spoken filler: %s", exc)

    async def _before_tool(self, context, key):
        # 1) Fixed spoken filler — one per 8s cooldown, audio-only, in the
        #    caller's language. None means this tool speaks nothing at all.
        phrase = self._filler_for(key)
        if phrase:
            now = time.monotonic()
            if now - getattr(self, "_last_filler_at", 0.0) >= self._FILLER_COOLDOWN_S:
                self._last_filler_at = now
                # add_to_chat_ctx=False: audio-only. The model is told about it via
                # _note_already_spoken below instead — see that docstring for why
                # the assistant-turn route is not used.
                context.session.say(phrase, allow_interruptions=False, add_to_chat_ctx=False)
                await self._note_already_spoken(phrase)
        # 2) Arm the dynamic slow-tool cover; it self-cancels if the tool is fast.
        self._cover_gen = getattr(self, "_cover_gen", 0) + 1
        asyncio.create_task(self._start_cover_after_delay(self._cover_gen))


server = AgentServer()


# EXPLICIT dispatch: the worker registers under agent_name "molo-pipeline", and
# the number's SIP dispatch rule (molo-inbound) names it via room_config.agents.
# This is LiveKit's recommended pattern for SIP inbound on Cloud — auto-dispatch
# (empty name) does not reliably provision a scaled-to-zero agent for SIP calls,
# so the call dropped with no room/job. Keep this name in sync with the dispatch
# rule's agent_name.
@server.rtc_session(agent_name=PIPELINE_AGENT_NAME)
async def molo_pipeline_session(ctx: agents.JobContext):
    # === BEGIN runner copied from agent.py molo_session (lines ~620-851) ===
    # Copied VERBATIM except: (a) instructions base is PIPELINE_INSTRUCTIONS,
    # (b) session = build_pipeline_session(), (c) agent = PipelineMoloAgent(...).
    await ctx.connect()
    participant = await ctx.wait_for_participant()

    caller_phone = participant.attributes.get("sip.phoneNumber", "")

    # Preload the default general KB so general questions work before the guest
    # is identified (guarded — a DB hiccup must never block the greeting).
    try:
        default_kb = db.get_default_general_kb()
    except Exception as exc:  # noqa: BLE001
        logger.warning("default KB load failed: %s", exc)
        default_kb = ""

    # Front-desk transfer number is configured by staff in the dashboard
    # (agent_settings.transfer_default_phone). Loaded once at call start (guarded).
    try:
        transfer_phone = (db.get_agent_settings() or {}).get("transfer_default_phone")
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent_settings load failed: %s", exc)
        transfer_phone = None

    # NOTE: the general KB is intentionally NOT appended to the system prompt — it
    # bloated time-to-first-token and pulled the model toward Polish. It's loaded
    # into the agent's kb_content below and served only via search_kb.
    # Give the live model the current LOCAL (Poland) date & time so it can reason
    # about relative dates the caller uses ("tonight", "tomorrow", "next Monday").
    # Substituted fresh per call into the prompt's inline sentinel (see
    # pipeline_prompt.CURRENT_TIME_TOKEN) so it's always accurate.
    _now_local = _now_warsaw()
    _current_time = (
        f"{_now_local.strftime('%A, %d %B %Y, %H:%M')} local time "
        f"(today's date is {_now_local.date().isoformat()}) — always use THIS as "
        "\"now\" for relative dates like \"tonight\", \"today\", \"tomorrow\", or \"next Monday\"."
    )
    instructions = render_instructions(_current_time)

    session = build_pipeline_session()

    # Initial call_logs row (insert_call_log is internally guarded — returns None
    # on any error, so a logging hiccup never blocks the call).
    call_id = db.insert_call_log({
        "started_at": _now_iso(),
        "direction": "inbound",
        "from_number": caller_phone or None,
        "mode": "unknown",
        "tool_calls": [],
    })

    agent = PipelineMoloAgent(instructions=instructions, default_kb_content=default_kb,
                              from_number=caller_phone, call_id=call_id, room_name=ctx.room.name,
                              transfer_phone=transfer_phone)

    # Capture the full ordered transcript for the call_logs summary, so a wrong
    # answer can be reviewed against what was actually asked.
    transcript_log: list[str] = []

    # Follow the caller's language. Deepgram nova-3 (language="multi") reports the
    # detected language per turn; the agent retunes TTS so replies AND the spoken
    # tool fillers come out in the language actually being spoken.
    @session.on("user_input_transcribed")
    def _on_language(ev):
        try:
            agent._on_caller_language(getattr(ev, "language", None))
        except Exception:  # noqa: BLE001 — never let this interrupt the call
            pass

    @session.on("conversation_item_added")
    def _on_item(ev):
        try:
            item = ev.item
            role = getattr(item, "role", "?")
            text = getattr(item, "text_content", None) or getattr(item, "text", "") or ""
            if text:
                transcript_log.append(f"{role}: {text}")
        except Exception:  # noqa: BLE001
            pass

    # What the call actually consumed — LLM tokens, TTS characters, STT audio
    # seconds — accumulated from the pipeline's own metrics. This is what makes
    # call_logs.cost_usd a measurement rather than duration x a guessed rate.
    # UsageCollector.collect() ignores metric types it doesn't price, so every
    # event can be handed to it unfiltered.
    usage_collector = lk_metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics(ev):
        try:
            usage_collector.collect(ev.metrics)
        except Exception:  # noqa: BLE001 — cost accounting never interrupts a call
            pass

    call_start = time.time()

    await session.start(
        room=ctx.room,
        agent=agent,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVCTelephony(),
            ),
        ),
    )

    # Dynamic slow-tool cover: a soft keyboard-typing track that fills dead air ONLY
    # when a tool runs longer than PipelineMoloAgent._COVER_AFTER_S. It is armed in
    # _before_tool (so it can only ever fire during a tool call, never on a plain
    # turn — that every-turn typing was what the client removed) and stopped the
    # instant the agent leaves "thinking" (the answer audio is starting).
    # We deliberately do NOT pass thinking_sound= to BackgroundAudioPlayer: that
    # built-in fires on EVERY turn's thinking phase, which is the spam we're avoiding.
    bg = BackgroundAudioPlayer()
    try:
        await bg.start(room=ctx.room, agent_session=session)
        agent._bg = bg
    except Exception as exc:  # noqa: BLE001 — never let audio setup block the call
        logger.warning("BackgroundAudioPlayer start failed: %s", exc)

    @session.on("agent_state_changed")
    def _stop_cover_on_state(ev):
        if getattr(ev, "new_state", None) != "thinking":
            agent._stop_cover()

    # ── Start the conversation ──────────────────────────────
    # The TTS keeps TTS_LANGUAGE (Polish) here on purpose. An earlier version
    # pinned the greeting to English because it is English text — but that
    # overwrote the Polish setting one second into every call and never restored
    # it for an English-speaking caller, which is why the voice sounded fully
    # English. The client prefers the Polish-accented read in both languages.
    # say() not generate_reply(): the disclosure must be spoken WORD FOR WORD, and
    # generate_reply would let the model paraphrase it. allow_interruptions=False so
    # a caller talking over the opening can't cut the notice short.
    # add_to_chat_ctx=True (the default) is important here — unlike the tool
    # fillers, the model SHOULD see that it already introduced itself, otherwise it
    # opens the next turn by greeting the caller a second time.
    await session.say(WELCOME_MESSAGE, allow_interruptions=False)

    # ── Wait for the call to end (disconnect / dead air / max duration) ──────
    disconnect_event = asyncio.Event()
    end_reason = "caller_hangup"

    @ctx.room.on("participant_disconnected")
    def on_participant_left(p: rtc.RemoteParticipant):
        nonlocal end_reason
        if p.identity == participant.identity:
            logger.info("Caller %s disconnected", caller_phone)
            end_reason = "caller_hangup"
            disconnect_event.set()

    async def call_monitor():
        nonlocal end_reason
        # Two clocks. `last_user_at` is the caller's last WORDS; `turn_started_at`
        # is when the agent stopped talking. Silence counts from whichever came
        # later, so the caller always gets the full window to themselves.
        last_user_at = time.time()
        turn_started_at = time.time()
        followups_sent = 0

        @session.on("user_input_transcribed")
        def on_user_input(ev=None, *a, **kw):
            nonlocal last_user_at, followups_sent
            # Ignore interim transcripts with no words — Deepgram emits empty
            # partials on background noise, which would otherwise read as speech
            # and hold the line open indefinitely.
            text = (getattr(ev, "transcript", "") or "").strip() if ev is not None else ""
            if not text:
                return
            last_user_at = time.time()
            followups_sent = 0          # they spoke; start the count over

        @session.on("agent_state_changed")
        def on_agent_state(ev=None, *a, **kw):
            nonlocal turn_started_at
            # The caller's turn begins the moment the agent stops speaking.
            if getattr(ev, "old_state", None) == "speaking":
                turn_started_at = time.time()

        while not disconnect_event.is_set():
            await asyncio.sleep(1)

            if time.time() - call_start >= MAX_CALL_DURATION:
                end_reason = "max_duration"
                try:
                    await session.generate_reply(
                        instructions="We've been on the call for a while now. Warmly wrap up — it was great chatting, and they can always call back. Say goodbye."
                    )
                    await asyncio.sleep(4)
                except Exception:  # noqa: BLE001
                    pass
                disconnect_event.set()
                break

            # Never nudge or hang up over the agent's own voice — it is not the
            # caller's turn until it has stopped.
            if getattr(session, "agent_state", None) in ("speaking", "thinking"):
                continue

            silence_duration = time.time() - max(last_user_at, turn_started_at)

            # Hang up on total silence since the caller last spoke, regardless of
            # how many follow-ups went out.
            if time.time() - last_user_at >= SILENCE_HANGUP_S:
                end_reason = "dead_air"
                logger.info("dead air: %.0fs since the caller last spoke — ending call",
                            time.time() - last_user_at)
                try:
                    await session.generate_reply(
                        instructions="The caller hasn't responded. Say goodbye warmly and let them know they can call back anytime."
                    )
                    await asyncio.sleep(4)
                except Exception:  # noqa: BLE001
                    pass
                disconnect_event.set()
                break

            # Follow-ups at 7s, then 14s. Each one is spoken by the agent, which
            # moves turn_started_at, so the next window is measured from the end
            # of the nudge rather than overlapping it.
            if (followups_sent < SILENCE_MAX_FOLLOWUPS
                    and silence_duration >= SILENCE_FOLLOWUP_S * (followups_sent + 1)):
                followups_sent += 1
                logger.info("dead air: %.0fs quiet — follow-up %d of %d",
                            silence_duration, followups_sent, SILENCE_MAX_FOLLOWUPS)
                try:
                    await session.generate_reply(
                        instructions="The line has been quiet. Say ONLY a brief presence check and nothing about any previous topic — exactly like: 'Hello — are you still there?'"
                    )
                except Exception:  # noqa: BLE001
                    pass

    monitor_task = asyncio.create_task(call_monitor())
    try:
        await disconnect_event.wait()
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass
        agent._stop_cover()
        try:
            await bg.aclose()
        except Exception:  # noqa: BLE001
            pass

    call_duration = int(time.time() - call_start)
    logger.info("Call ended: duration=%ss caller=%s reason=%s", call_duration, caller_phone, end_reason)

    # Persist the call for review (transcript + tool trace incl. which KB answered).
    if call_id:
        transcript = "\n".join(transcript_log) if transcript_log else None

        # What the call did — a LIST now, not one label. The tool trace supplies
        # the outcomes it can prove; a single Gemini pass over the transcript
        # supplies the conversational ones. See call_outcomes for the rules,
        # notably that 'abandoned' now means an actual hang-up rather than
        # "no tool happened to run".
        #
        # `for_call` is internally guarded and awaits a model call, so it runs
        # BEFORE the write: the caller has already hung up, nothing is waiting
        # on it, and one write with everything beats two round trips.
        try:
            outcomes = await call_outcomes.for_call(
                tool_calls=agent.tool_calls,
                transcript=transcript,
                transcript_lines=transcript_log,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("outcome derivation failed: %s", exc)
            outcomes = []

        # What the call cost. Measured usage where LiveKit reports it; the flat
        # per-minute lines multiplied out from the duration. If no metrics
        # arrived at all (a session that died before the first turn), fall back
        # to the blended per-minute figure and mark it unmeasured.
        try:
            summary = usage_collector.get_summary()
            if summary.tts_characters_count or summary.llm_prompt_tokens:
                breakdown = call_cost.estimate_cost(call_cost.usage_from_summary(
                    summary, call_duration,
                    kb_input_chars=agent.kb_input_chars,
                    kb_output_chars=agent.kb_output_chars,
                ))
            else:
                breakdown = call_cost.estimate_from_duration(call_duration)
            cost_usd = breakdown["total_usd"]
            logger.info("Call cost: $%.4f (%s) %s", cost_usd,
                        "measured" if breakdown["measured"] else "estimated",
                        breakdown["components_usd"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("cost calculation failed: %s", exc)
            breakdown, cost_usd = None, None

        try:
            db.update_call_log(call_id, {
                "ended_at": _now_iso(),
                "duration_seconds": call_duration,
                "summary": (transcript or "")[:4000] or None,
                "tool_calls": agent.tool_calls,
                "mode": agent.mode,
                # Both columns: `outcomes` is the truth, `outcome` is the
                # highest-ranked entry of it and stays populated because the
                # home dashboard's category chart still groups by it.
                "outcomes": outcomes,
                "outcome": call_outcomes.primary(outcomes),
                "cost_usd": cost_usd,
                "cost_breakdown": breakdown,
                "property_id": agent.property_id,
                "room_number": agent.room_number,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("update_call_log failed: %s", exc)

        # ── GDPR: did the caller ask for their data to be deleted? ──────────
        # Runs AFTER the transcript is saved, deliberately: if the erasure
        # succeeds it wipes what we just wrote, and if anything here fails the
        # call is still recorded normally. The whole block is guarded — a caller
        # has already hung up by this point and nothing here may raise.
        try:
            if transcript and caller_phone and await gdpr_check.caller_requested_deletion(transcript):
                # Erase every call from this number, not just this one — a
                # request covers all of the caller's data, not one conversation.
                n = db.redact_calls_for_number(caller_phone)
                logger.info("GDPR erasure for %s: %s call(s) redacted", caller_phone, n)
                _notify_gdpr_erasure(caller_phone, n)
            # No else-branch logging: the answer is NO on almost every call and
            # would drown the logs.
        except Exception as exc:  # noqa: BLE001
            logger.warning("GDPR post-call check failed: %s", exc)

    # If we ended the call ourselves, remove the SIP participant and disconnect.
    if end_reason != "caller_hangup":
        try:
            from livekit.protocol.room import RoomParticipantIdentity
            async with LiveKitAPI() as lk:
                await lk.room.remove_participant(
                    RoomParticipantIdentity(room=ctx.room.name, identity=participant.identity)
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to remove SIP participant: %s", e)
        try:
            await ctx.room.disconnect()
        except Exception:  # noqa: BLE001
            pass
    # === END copied runner ===


if __name__ == "__main__":
    agents.cli.run_app(server)
