# Pipeline voice agent (`agent_pipeline.py`) — design

**Date:** 2026-07-22
**Status:** Approved (design), pending spec review
**Repo:** `molo-voice-agent`

## Why

The production agent uses a single speech-to-speech model — `google.realtime.RealtimeModel` (`gemini-live-2.5-flash-native-audio`) — that hears, thinks, and speaks as one unit. Turn-taking is governed server-side by Gemini, so while a `@function_tool` runs there is nothing driving audio and the agent **goes silent mid-call** (the client's chief complaint). Only English + Polish are needed, so a classic STT→LLM→TTS pipeline — where LiveKit's framework governs turn-taking and a spoken filler can cover tool latency — is a better fit and removes the silence.

The client asked for a **separate agent, same prompt + tools**, built as a **new file**, deployed **alongside** the current agent for A/B comparison.

## What it is

A second entrypoint, `src/agent_pipeline.py`, that reuses the existing `MoloAgent` (all six tools) and a lightly-reworded prompt, but builds a pipeline `AgentSession` instead of the realtime one. All three model legs run through **LiveKit Inference** (one LiveKit API key, no new Deepgram/Cartesia/Google accounts):

| Leg | Choice | Note |
|---|---|---|
| STT | **Cartesia Ink-Whisper** | `model="ink-whisper"` — the PL-capable model; `ink-2` is English-only |
| LLM | **Gemma 4 31B** | LiveKit-hosted, tuned for long prompts + heavy tool use (~354 ms to first audio) |
| TTS | **Cartesia Sonic** | multilingual voice; a specific voice ID chosen during build and auditioned by the client |
| VAD | **silero** | already in the code; unchanged |
| Turn detection | **MultilingualModel** | already in the code; **inert today**, becomes active in a pipeline |

The current s2s agent (`agent.py`, LiveKit agent `CA_9A3cUKL9gVwz`, number `+48 732 128 903`) is **not modified in behavior** and keeps running throughout.

## Architecture

### Component boundaries

**Hard constraint (client): `agent.py` is not edited at all** — not its behavior, not its source. The new file only *imports* from it.

- **`MoloAgent` (unchanged, imported):** the six tools (`identify_guest`, `search_kb`, `raise_maintenance_ticket`, `suggest_available_rooms`, `send_booking_link`, `transfer_call`) and all guest-facing logic. LLM-agnostic — works identically behind a pipeline. `agent_pipeline.py` does `from agent import MoloAgent, INSTRUCTIONS, GREETING, …` (importing is allowed; editing is not). Importing `agent.py` is side-effect-safe: its worker only starts under `if __name__ == "__main__"`, so an import does not launch the s2s agent.
- **Call runner (duplicated into `agent_pipeline.py`):** the ~150 lines both agents need — KB preload, `agent_settings`/`transfer_phone` load, initial `call_logs` insert, transcript capture, dead-air/max-duration monitor, final `update_call_log`, SIP participant cleanup. Copied into the new file rather than extracted, because `agent.py` must not change.
- **`agent.py` (untouched):** stays exactly as deployed.
- **`agent_pipeline.py` entrypoint (new, self-contained):** imports `MoloAgent` + prompt from `agent.py`, defines its own reworded prompt variant, builds the pipeline session, and runs its own copy of the call runner.

This is **structure option (B)** from the design discussion, selected by the client's "don't edit current agent" instruction over the DRY extraction (A). Accepted trade-off: the ~150-line runner exists in two places and must be kept in sync by hand. Because `agent.py` is imported rather than modified, the live s2s agent is guaranteed untouched — no behavior verification of `agent.py` is needed.

### Prompt handling — the s2s agent's prompt is NOT mutated

The three prompt lines being trimmed live in the **shared** `INSTRUCTIONS` string in `agent.py`, which must not be edited. Therefore:

- `INSTRUCTIONS` in `agent.py` stays **byte-identical** (guaranteed — the file is not touched).
- `agent_pipeline.py` **imports** `INSTRUCTIONS` and derives a pipeline variant by string-replacing the three native-audio-only lines with their reworded versions (`PIPELINE_INSTRUCTIONS = INSTRUCTIONS.replace(old, new)` for each). This keeps the prompt single-sourced in `agent.py` — only the three turn-mechanics lines diverge for the pipeline, and the replace is fail-loud if a target line ever changes upstream (assert each replacement actually happened).

The three lines to reword (all currently tell the model *not* to speak before a tool call — the opposite of what a pipeline wants):

1. **L93** — "Never speak a sentence and then call a tool in the same turn — that cuts your speech off mid-word. Either call the tool FIRST (a soft thinking sound covers the brief wait)…"
2. **L123** — "When the caller asks a question, call `search_kb` immediately (a soft thinking sound covers the brief wait). Don't speak a full filler sentence and hold the call back."
3. **L133** — "Only after the caller confirms, call `suggest_available_rooms` straight away. Do NOT say a sentence first and then call it (that cuts you off) — the soft thinking sound covers the brief wait."

Reworded to **encourage** a brief natural filler ("let me check that for you") before/around tool calls, and to drop the "thinking sound covers it" framing. Semantics otherwise identical. The exact reworded text goes in the implementation plan. The language line (L85, "speak both fluent Polish and English…") is **kept** — it is about language, not turn mechanics.

### Session construction (the only real difference)

Replace the `llm=google.realtime.RealtimeModel(...)` block with a pipeline `AgentSession(stt=…, llm=…, tts=…)` using LiveKit Inference model strings. The interruption knobs already present (`min_interruption_words`, `min_interruption_duration`, `false_interruption_timeout`, `resume_false_interruption`) are **inert today** but become active and useful in a pipeline — keep them.

## Known risks (designed around)

1. **Gemma 4 thinking-token leak.** Open LiveKit issue #6375: Gemma 4 emits `<|channel>thought<channel|>` markers that the default `strip_thinking_tokens` does not catch, so raw reasoning can be spoken by TTS. Mitigation: a text filter on the LLM output before it reaches TTS, verified clean on a real call. This is the single most likely item to overrun the ~1-day estimate.
2. **Language switching now depends on the STT.** Native audio handled EN/PL detection itself; now Ink-Whisper must detect PL vs EN per turn. The prompt still drives the LLM's response language, but mid-call switching must be tested with a real bilingual call.
3. **Tool-call filler UX.** The whole point. The pipeline keeps the turn alive across a tool call, and the reworded prompt plus the existing background "thinking" sound should eliminate dead air — but this is the behavior to validate on a live call, not assume.
4. **Cartesia voice quality in both languages.** Sonic voices are multilingual (not language-locked); the model adapts to the text language. Pick a voice that sounds good in **both** EN and PL and have the client audition before locking.

## Deployment — parallel test (client's choice)

- `agent_pipeline.py` registers as a **distinct LiveKit agent name** and deploys as a **second LiveKit Cloud agent**, separate from `CA_9A3cUKL9gVwz`.
- A **spare Telnyx number + a second SIP inbound trunk + dispatch rule** route calls to the pipeline agent. The client must free up or purchase one number (already on Telnyx).
- Secrets: reuse the existing agent secret set; add the chosen **Cartesia voice ID**. Because the models run via LiveKit Inference, access rides on the existing `LIVEKIT_API_KEY`/`SECRET` — likely **no new provider secrets**. Confirm during build whether Inference needs any extra config.
- The current s2s agent stays live on `+48 732 128 903` the entire time.

## Testing

- **Local first:** run `agent_pipeline.py` in console/dev mode to hear it and tune the Cartesia voice + latency before any deploy.
- **Reuse existing coverage:** tools and prompt logic are already exercised by the current suite; no new tool tests needed. A light smoke check that the pipeline session builds is enough.
- **Live call** to the spare number after deploy — the real acceptance test.

## Success criteria

1. New pipeline agent answers in **English and Polish**.
2. All six tools run end-to-end.
3. **No dead air during tool calls** — the specific failure this rebuild targets — confirmed on a real call.
4. No spoken thinking-tokens (risk #1 handled).
5. Current s2s agent unchanged and still serving `+48 732 128 903`.

## Out of scope

- Retiring or modifying the s2s agent (kept for A/B).
- Any change to the tools' behavior, the dashboard, or Supabase.
- Changing the prompt's meaning (only the three turn-mechanics lines are reworded, and only in the pipeline variant).
- Buying the spare number (client provides it).

## Open items for the plan

- Exact reworded text for the three prompt lines.
- Exact LiveKit Inference model strings for Ink-Whisper / Gemma 4 31B / Cartesia Sonic, and the chosen voice ID.
- Which of `agent.py`'s module-level helpers the pipeline imports vs. re-declares (e.g. `_now_warsaw`, `GREETING`, date-injection) — importing is fine, but keep the copied runner readable.
- LiveKit second-agent registration + Telnyx trunk/dispatch config.
