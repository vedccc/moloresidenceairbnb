# Pipeline Voice Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a second, separate voice agent (`src/agent_pipeline.py`) that runs an STT→LLM→TTS pipeline (Cartesia Ink-Whisper → Gemma 4 31B → Cartesia Sonic, all via LiveKit Inference) reusing the current agent's tools and prompt, to eliminate the speech-to-speech silence during tool calls — deployed alongside the live agent for A/B testing.

**Architecture:** `agent_pipeline.py` **imports** `MoloAgent` + `INSTRUCTIONS` from `agent.py` (never edits it), derives a pipeline prompt variant by rewording three native-audio-only lines, builds a pipeline `AgentSession`, and carries its own copy of the ~150-line call runner. It registers as its own LiveKit worker and deploys as a second LiveKit Cloud agent on a spare Telnyx number.

**Tech Stack:** Python 3.12, `livekit-agents==1.4.4` (pinned — its `livekit.agents.inference` module already supports string model IDs), LiveKit Inference (one LiveKit key, no extra provider accounts/plugins), Supabase, Telnyx.

## Global Constraints

- **Do NOT edit `src/agent.py`** — not its behavior, not its source. `agent_pipeline.py` only imports from it. (Importing is side-effect-safe: `agent.py`'s worker only starts under `if __name__ == "__main__"`.)
- **Do NOT bump `livekit-agents`** (pinned `==1.4.4`; `pyproject.toml` warns a bump broke the realtime handshake before). The pipeline uses only APIs already present in 1.4.4 — verified. **No new Python dependencies** are expected; if any is added, run `uv lock` (the Dockerfile does `uv sync --frozen`, which fails on a stale lock).
- **Exact model strings (confirmed):** STT `cartesia/ink-whisper`; LLM `google/gemma-4-31b-it` (verified reachable via a live gateway probe returning HTTP 200 — `google/gemma-4-31b` without `-it` returns 404); TTS `cartesia/sonic-2`.
- **No fallback LLM** (client instruction): the agent uses Gemma 4 31B. Gemma reachability is already confirmed; if a future probe shows it unreachable, STOP and escalate — do not silently substitute another model.
- **The live s2s agent stays running** on `+48 732 128 903` throughout; this plan never touches its deployment, only adds a second one.
- Tests import from `src/` (existing convention: `sys.path.insert(0, ".../src")`). Run tests with `.venv/bin/python -m pytest` (the venv is uv-managed; system `python` lacks pytest).

## File Structure

| File | Responsibility |
|---|---|
| `src/pipeline_prompt.py` (new) | Derives `PIPELINE_INSTRUCTIONS` from the imported `INSTRUCTIONS` by rewording the 3 turn-mechanics lines; fail-loud if a target line changes upstream. |
| `src/thinking_filter.py` (new) | `strip_thinking_tokens(text)` — removes Gemma 4 channel/thinking markers (issue #6375) before TTS. |
| `src/agent_pipeline.py` (new) | Pipeline `AgentSession` builder + duplicated call runner + own `AgentServer`/entrypoint/`run_app`. |
| `tests/test_pipeline_prompt.py` (new) | Tests for the prompt reword. |
| `tests/test_thinking_filter.py` (new) | Tests for the token stripper. |
| `livekit.pipeline.toml` (new) | Second LiveKit agent config (distinct agent id). |
| `Dockerfile.pipeline` (new) | Image whose CMD launches `agent_pipeline.py`. |
| `src/agent.py` | **UNCHANGED** — imported only. |

---

### Task 1: Pipeline prompt variant (`PIPELINE_INSTRUCTIONS`)

**Files:**
- Create: `src/pipeline_prompt.py`
- Test: `tests/test_pipeline_prompt.py`

**Interfaces:**
- Consumes: `INSTRUCTIONS` (a module-level `str`) from `agent.py`.
- Produces: `PIPELINE_INSTRUCTIONS: str` — the same prompt with exactly three lines reworded.

The three original lines (must match `agent.py` verbatim) and their pipeline rewrites:

| # | Original (in `INSTRUCTIONS`) | Reworded |
|---|---|---|
| 1 | `- Never speak a sentence and then call a tool in the same turn — that cuts your speech off mid-word. Either call the tool FIRST (a soft thinking sound covers the brief wait) and speak once it returns, OR finish what you're saying and wait for the caller before calling anything. Do not do both in one turn.` | `- When you need to call a tool, say a short natural filler first so the caller isn't left in silence — e.g. "let me check that for you" — then call the tool and continue once it returns. A brief pause while the tool runs is fine.` |
| 2 | `1. When the caller asks a question, call \`search_kb\` immediately (a soft thinking sound covers the brief wait). Don't speak a full filler sentence and hold the call back.` | `1. When the caller asks a question, say a brief "let me check" and call \`search_kb\`, then answer from what it returns.` |
| 3 | `6. Only after the caller confirms, call \`suggest_available_rooms\` straight away. Do NOT say a sentence first and then call it (that cuts you off) — the soft thinking sound covers the brief wait.` | `6. Only after the caller confirms, say a brief "let me check availability" and call \`suggest_available_rooms\`, then present what it returns.` |

- [ ] **Step 1: Write the failing test**

```python
# tests/test_pipeline_prompt.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import agent as agent_mod           # noqa: E402
import pipeline_prompt              # noqa: E402


def test_the_three_s2s_lines_are_gone():
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert "a soft thinking sound covers the brief wait" not in p
    assert "that cuts you off" not in p
    assert "cuts your speech off mid-word" not in p


def test_reworded_lines_present():
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    assert 'say a short natural filler first' in p
    assert 'say a brief "let me check" and call `search_kb`' in p
    assert 'say a brief "let me check availability"' in p


def test_rest_of_prompt_preserved():
    # tools and non-reworded content still there; only 3 lines changed.
    p = pipeline_prompt.PIPELINE_INSTRUCTIONS
    for tool in ("search_kb", "suggest_available_rooms", "send_booking_link",
                 "identify_guest", "raise_maintenance_ticket", "transfer_call"):
        assert tool in p
    # same length ballpark as source (only 3 lines reworded)
    assert abs(len(p) - len(agent_mod.INSTRUCTIONS)) < 800


def test_fail_loud_if_a_target_line_changes(monkeypatch):
    # If agent.py's wording drifts, the replace must raise, not silently no-op.
    import importlib
    monkeypatch.setattr(agent_mod, "INSTRUCTIONS", "a prompt without the target lines")
    with __import__("pytest").raises(AssertionError):
        importlib.reload(pipeline_prompt)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_pipeline_prompt.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline_prompt'`.

- [ ] **Step 3: Write the implementation**

```python
# src/pipeline_prompt.py
"""Pipeline variant of the shared system prompt.

The current agent's INSTRUCTIONS contains three lines written for the
native-audio (speech-to-speech) model, which tell the model NOT to speak
before a tool call ("that cuts you off"). In a STT->LLM->TTS pipeline the
opposite is true: a short spoken filler is exactly what removes the dead air
during a tool call. We reword only those three lines and leave the rest of the
prompt identical, keeping it single-sourced from agent.py (which is never
edited).
"""
from __future__ import annotations

from agent import INSTRUCTIONS  # import only — agent.py is not modified

# (original, reworded) pairs. Each original MUST appear verbatim in INSTRUCTIONS;
# if agent.py's wording drifts, the assert below fails loudly instead of shipping
# an unchanged s2s instruction.
_REWORDS: list[tuple[str, str]] = [
    (
        "- Never speak a sentence and then call a tool in the same turn — that cuts "
        "your speech off mid-word. Either call the tool FIRST (a soft thinking sound "
        "covers the brief wait) and speak once it returns, OR finish what you're saying "
        "and wait for the caller before calling anything. Do not do both in one turn.",
        "- When you need to call a tool, say a short natural filler first so the caller "
        "isn't left in silence — e.g. \"let me check that for you\" — then call the tool "
        "and continue once it returns. A brief pause while the tool runs is fine.",
    ),
    (
        "1. When the caller asks a question, call `search_kb` immediately (a soft "
        "thinking sound covers the brief wait). Don't speak a full filler sentence and "
        "hold the call back.",
        "1. When the caller asks a question, say a brief \"let me check\" and call "
        "`search_kb`, then answer from what it returns.",
    ),
    (
        "6. Only after the caller confirms, call `suggest_available_rooms` straight away. "
        "Do NOT say a sentence first and then call it (that cuts you off) — the soft "
        "thinking sound covers the brief wait.",
        "6. Only after the caller confirms, say a brief \"let me check availability\" and "
        "call `suggest_available_rooms`, then present what it returns.",
    ),
]


def _build() -> str:
    text = INSTRUCTIONS
    for old, new in _REWORDS:
        assert old in text, f"pipeline prompt reword target not found in INSTRUCTIONS: {old[:60]!r}"
        text = text.replace(old, new)
    return text


PIPELINE_INSTRUCTIONS: str = _build()
```

**Note on the verbatim strings:** the `_REWORDS` originals above are line-wrapped for readability using Python implicit string concatenation. Before running the test, open `src/agent.py`, copy each of lines 93 / 123 / 133 exactly, and confirm the concatenated original equals the file line character-for-character (em dashes `—`, backticks, and the leading `- ` / `1. ` / `6. ` included). The `assert old in text` will catch any mismatch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_pipeline_prompt.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline_prompt.py tests/test_pipeline_prompt.py
git commit -m "feat(pipeline): PIPELINE_INSTRUCTIONS — reword 3 s2s-only prompt lines"
```

---

### Task 2: Gemma thinking-token filter

**Files:**
- Create: `src/thinking_filter.py`
- Test: `tests/test_thinking_filter.py`

**Interfaces:**
- Produces: `strip_thinking_tokens(text: str) -> str` — removes Gemma 4 channel/thinking markers, returns clean speakable text.

**Why:** LiveKit issue #6375 — Gemma 4 emits Harmony-style channel markers (`<|channel|>thought…`, and the analysis/final channel tags) that the framework's `<think>`-only stripper misses, so raw reasoning can reach TTS and be spoken.

- [ ] **Step 1: First gather evidence — does Gemma actually leak markers here?**

Run this probe and READ the raw output:
```bash
cd molo-voice-agent && .venv/bin/python - <<'PY'
import os, httpx
from dotenv import load_dotenv; load_dotenv(".env")
from livekit.agents.inference.llm import create_access_token
tok = create_access_token(os.getenv("LIVEKIT_API_KEY"), os.getenv("LIVEKIT_API_SECRET"))
r = httpx.post("https://agent-gateway.livekit.cloud/v1/chat/completions",
    headers={"Authorization": f"Bearer {tok}"},
    json={"model": "google/gemma-4-31b-it",
          "messages": [{"role": "user", "content": "A guest asks for late checkout. Think, then reply in one sentence."}],
          "max_tokens": 120}, timeout=30.0)
print(r.json()["choices"][0]["message"]["content"])
PY
```
Record the literal marker syntax you see (e.g. `<|channel|>analysis`, `<think>`, `<|channel|>final`). The regex in Step 3 must match what THIS gateway actually emits. If the output is already clean (no markers), the filter is a no-op safety net — still implement and test it, but note in the commit that no leak was observed.

- [ ] **Step 2: Write the failing test**

```python
# tests/test_thinking_filter.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import thinking_filter  # noqa: E402


def test_strips_channel_thought_block():
    raw = "<|channel|>analysis I should be warm and brief.<|channel|>final Sure, checkout at noon is fine."
    assert thinking_filter.strip_thinking_tokens(raw) == "Sure, checkout at noon is fine."


def test_strips_think_tags():
    raw = "<think>plan the answer</think>Of course, happy to help."
    assert thinking_filter.strip_thinking_tokens(raw) == "Of course, happy to help."


def test_leaves_clean_text_untouched():
    clean = "Yes, our earliest check-in is 3pm."
    assert thinking_filter.strip_thinking_tokens(clean) == clean


def test_collapses_leftover_whitespace():
    raw = "<think>x</think>   Hello there."
    assert thinking_filter.strip_thinking_tokens(raw) == "Hello there."
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_thinking_filter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'thinking_filter'`.

- [ ] **Step 4: Write the implementation**

Adjust the channel-marker regex to match what Step 1 actually showed if it differs.

```python
# src/thinking_filter.py
"""Strip Gemma-4 reasoning markers before they reach TTS (LiveKit issue #6375).

Gemma 4 can emit Harmony-style channel markers ("<|channel|>analysis …",
"<|channel|>final …") and/or <think>…</think> blocks. The framework's default
stripper only knows <think>, so channel-tagged reasoning could be spoken. This
removes both and keeps only the final speakable text.
"""
from __future__ import annotations

import re

# <think>...</think> blocks (any case, across newlines)
_THINK = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
# Everything up to and including the final-channel marker is reasoning; keep the
# text AFTER the last "final" channel marker. If no final marker, drop any
# analysis/commentary channel segments.
_FINAL = re.compile(r".*<\|channel\|>\s*final\s*", re.IGNORECASE | re.DOTALL)
_CHANNEL_SEG = re.compile(r"<\|channel\|>\s*(analysis|commentary|thought)\b.*?(?=<\|channel\|>|$)",
                          re.IGNORECASE | re.DOTALL)
_STRAY = re.compile(r"<\|channel\|>\s*\w*\s*", re.IGNORECASE)


def strip_thinking_tokens(text: str) -> str:
    if not text:
        return text
    out = _THINK.sub("", text)
    if "<|channel|>" in out.lower():
        if re.search(r"<\|channel\|>\s*final", out, re.IGNORECASE):
            out = _FINAL.sub("", out)          # keep only post-final text
        else:
            out = _CHANNEL_SEG.sub("", out)    # drop analysis/thought segments
        out = _STRAY.sub("", out)              # remove any leftover bare markers
    return re.sub(r"\s+", " ", out).strip()
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_thinking_filter.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/thinking_filter.py tests/test_thinking_filter.py
git commit -m "feat(pipeline): strip Gemma-4 thinking/channel markers before TTS (#6375)"
```

---

### Task 3: `agent_pipeline.py` — pipeline session + entrypoint

**Files:**
- Create: `src/agent_pipeline.py`
- Test: `tests/test_agent_pipeline.py`

**Interfaces:**
- Consumes: `MoloAgent`, `GREETING`, `_now_warsaw`, `_now_iso` from `agent.py`; `PIPELINE_INSTRUCTIONS` from `pipeline_prompt.py`; `strip_thinking_tokens` from `thinking_filter.py`; `molo_supabase as db`.
- Produces: `build_pipeline_session() -> AgentSession`; `PIPELINE_AGENT_NAME` constant; a `server = AgentServer()` with an `@server.rtc_session()` entrypoint; `run_app(server)` under `__main__`.

The entrypoint duplicates `agent.py`'s `molo_session` runner (KB preload, transfer-phone load, per-call date injection, `call_logs` insert, transcript capture, `session.start`, background thinking sound, greeting, dead-air/max-duration monitor, `update_call_log`, SIP cleanup) — **copied**, because `agent.py` must not change. The ONLY substantive differences from `molo_session`: (a) the session is built by `build_pipeline_session()`, (b) instructions come from `PIPELINE_INSTRUCTIONS`, (c) a distinct agent name.

- [ ] **Step 1: Write the failing test** (pure parts only — the session builder with stubbed inference)

```python
# tests/test_agent_pipeline.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def test_module_imports_and_uses_pipeline_prompt():
    import agent_pipeline as ap
    import pipeline_prompt
    assert ap.PIPELINE_INSTRUCTIONS_TEXT == pipeline_prompt.PIPELINE_INSTRUCTIONS


def test_model_constants_are_the_verified_strings():
    import agent_pipeline as ap
    assert ap.STT_MODEL == "cartesia/ink-whisper"
    assert ap.LLM_MODEL == "google/gemma-4-31b-it"
    assert ap.TTS_MODEL == "cartesia/sonic-2"


def test_build_session_wires_all_three_legs(monkeypatch):
    import agent_pipeline as ap
    seen = {}

    class FakeSTT:  # noqa: D401
        def __init__(self, model=None, **kw): seen["stt"] = model
    class FakeLLM:
        def __init__(self, model=None, **kw): seen["llm"] = model
    class FakeTTS:
        def __init__(self, model=None, voice=None, **kw): seen["tts"] = (model, voice)

    monkeypatch.setattr(ap.inference, "STT", FakeSTT)
    monkeypatch.setattr(ap.inference, "LLM", FakeLLM)
    monkeypatch.setattr(ap.inference, "TTS", FakeTTS)
    # silero.VAD.load / MultilingualModel are heavyweight; stub them too
    monkeypatch.setattr(ap.silero.VAD, "load", staticmethod(lambda: object()))
    monkeypatch.setattr(ap, "MultilingualModel", lambda: object())

    ap.build_pipeline_session()
    assert seen["stt"] == "cartesia/ink-whisper"
    assert seen["llm"] == "google/gemma-4-31b-it"
    assert seen["tts"][0] == "cartesia/sonic-2"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_agent_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_pipeline'`.

- [ ] **Step 3: Write the implementation**

Copy `molo_session`'s body from `agent.py` (read lines ~620–851) into the entrypoint below, changing only the three points noted. The skeleton fixes the session construction and imports; paste the runner body where marked.

```python
# src/agent_pipeline.py
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
from livekit.agents import (
    AgentServer, AgentSession, AudioConfig, BackgroundAudioPlayer,
    BuiltinAudioClip, room_io, inference,
)
from livekit.api import LiveKitAPI
from livekit.plugins import noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

# Import from the live agent — NEVER edit agent.py.
from agent import MoloAgent, GREETING, _now_warsaw, _now_iso  # noqa
import molo_supabase as db
from pipeline_prompt import PIPELINE_INSTRUCTIONS
from thinking_filter import strip_thinking_tokens

logger = logging.getLogger("molo-agent-pipeline")

PIPELINE_AGENT_NAME = "molo-pipeline"
PIPELINE_INSTRUCTIONS_TEXT = PIPELINE_INSTRUCTIONS

# Verified model strings (see plan Global Constraints).
STT_MODEL = "cartesia/ink-whisper"
LLM_MODEL = "google/gemma-4-31b-it"
TTS_MODEL = "cartesia/sonic-2"
# Cartesia voice: a multilingual (EN+PL) Sonic voice id. Set via env after
# auditioning (Task 6). If unset, Cartesia's default voice is used.
TTS_VOICE = os.getenv("CARTESIA_VOICE_ID") or None

# Dead-air / duration guards — copied from agent.py so behaviour matches.
DEAD_AIR_CHECKIN = 25
DEAD_AIR_HANGUP = 40
MAX_CALL_DURATION = 7 * 60


def build_pipeline_session() -> AgentSession:
    """The one real difference from agent.py: a pipeline session instead of the
    native-audio RealtimeModel. VAD + turn detection + interruption knobs match
    agent.py — but here they are ACTIVE (they were inert with native audio)."""
    tts_kwargs = {"model": TTS_MODEL}
    if TTS_VOICE:
        tts_kwargs["voice"] = TTS_VOICE
    return AgentSession(
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        min_interruption_words=10,
        min_interruption_duration=0.8,
        false_interruption_timeout=2.0,
        resume_false_interruption=True,
        stt=inference.STT(model=STT_MODEL),          # language auto-detect (EN+PL)
        llm=inference.LLM(model=LLM_MODEL),
        tts=inference.TTS(**tts_kwargs),
    )


server = AgentServer()


@server.rtc_session(agent_name=PIPELINE_AGENT_NAME)
async def molo_pipeline_session(ctx: agents.JobContext):
    # === BEGIN runner copied from agent.py molo_session (lines ~620-851) ===
    # Paste the body of molo_session here VERBATIM, with these three changes:
    #   1. instructions base: use PIPELINE_INSTRUCTIONS (not INSTRUCTIONS) when
    #      building `instructions = PIPELINE_INSTRUCTIONS + "\n\n# Current date & time\n\n" ...`
    #   2. session: `session = build_pipeline_session()` instead of the inline
    #      AgentSession(... google.realtime.RealtimeModel ...).
    #   3. strip thinking tokens before TTS — after building `session`, register:
    #        @session.output.on("...")  # OR set the transform below
    #      Preferred: add `tts_text_transforms` support. If TextTransforms does not
    #      cover custom regex, wrap the agent's tts via an Agent subclass overriding
    #      `tts_node` to apply strip_thinking_tokens (see Step 3a). Verify on the
    #      Step-1 probe of Task 2 whether stripping is even needed.
    #   Everything else (KB preload, transfer_phone, call_id insert, transcript
    #   capture, session.start, background_audio, greeting, dead-air monitor,
    #   update_call_log, SIP cleanup) is IDENTICAL to agent.py.
    raise NotImplementedError("paste molo_session runner body here per the notes above")
    # === END copied runner ===


if __name__ == "__main__":
    agents.cli.run_app(server)
```

- [ ] **Step 3a: Wire the thinking-token strip**

The cleanest hook in 1.4.4 is an `Agent` subclass overriding `tts_node`. Add to `agent_pipeline.py` and use it in place of `MoloAgent` when constructing the agent inside the runner, so tools/prompt are unchanged but TTS text is cleaned:

```python
class PipelineMoloAgent(MoloAgent):
    async def tts_node(self, text, model_settings):
        async def _clean(src):
            async for chunk in src:
                cleaned = strip_thinking_tokens(chunk)
                if cleaned:
                    yield cleaned
        return super().tts_node(_clean(text), model_settings)
```

In the copied runner, build `agent = PipelineMoloAgent(instructions=instructions, default_kb_content=default_kb, from_number=caller_phone, call_id=call_id, room_name=ctx.room.name, transfer_phone=transfer_phone)`.
(If Task 2 Step 1 showed Gemma emits no markers, keep this anyway — it is a harmless safety net. Confirm `tts_node`'s exact signature against `MoloAgent`'s base `Agent.tts_node` in 1.4.4 before finalizing.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_agent_pipeline.py -v`
Expected: PASS (3 tests). Then run the full suite: `.venv/bin/python -m pytest tests/ -q` — all green (existing + new).

- [ ] **Step 5: Local smoke — the worker boots and models resolve**

```bash
cd molo-voice-agent && .venv/bin/python src/agent_pipeline.py download-files
# then a dev run (Ctrl-C after it registers): confirms silero/turn-detector load,
# imports resolve, and no import-time crash from agent.py.
timeout 25 .venv/bin/python src/agent_pipeline.py dev 2>&1 | tail -20 || true
```
Expected: worker registers (look for "registered worker" / agent name `molo-pipeline`), no traceback.

- [ ] **Step 6: Commit**

```bash
git add src/agent_pipeline.py tests/test_agent_pipeline.py
git commit -m "feat(pipeline): agent_pipeline.py — Cartesia/Gemma pipeline agent (separate worker)"
```

---

### Task 4: Deploy as a second LiveKit Cloud agent

**Files:**
- Create: `livekit.pipeline.toml`
- Create: `Dockerfile.pipeline`

**Interfaces:**
- Consumes: `agent_pipeline.py` (registers agent name `molo-pipeline`).
- Produces: a running second LiveKit Cloud agent with its own agent id, separate from `CA_9A3cUKL9gVwz`.

- [ ] **Step 1: Create a new LiveKit agent id**

```bash
cd molo-voice-agent
lk agent create --subdomain molo-residence-lx6og0ck   # note the new CA_... id it returns
```
If the CLI needs a config, create `livekit.pipeline.toml` first (Step 2) and pass `--config livekit.pipeline.toml`. Record the returned agent id.

- [ ] **Step 2: Write `livekit.pipeline.toml`** (same project, new agent id from Step 1)

```toml
[project]
  subdomain = "molo-residence-lx6og0ck"

[agent]
  id = "CA_<new-id-from-step-1>"
```

- [ ] **Step 3: Write `Dockerfile.pipeline`** (identical to `Dockerfile` except the entrypoint)

```dockerfile
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . .
RUN uv run python src/agent_pipeline.py download-files
CMD ["uv", "run", "python", "src/agent_pipeline.py", "start"]
```

- [ ] **Step 4: Copy secrets to the new agent**

The pipeline reuses the same secret set as the s2s agent. List the source, then set them on the new agent (values are only visible where you already hold them — e.g. the local `.env` or the existing agent config). At minimum the new agent needs: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_API_KEY`, `TELNYX_FROM`, `TELNYX_MESSAGING_PROFILE_ID`, `SMS_DEFAULT_REGION`, `SIP_OUTBOUND_TRUNK_ID`, `KWHOTEL_*`, `PROFITROOM_*`, `UPSTASH_REDIS_*`. It does **not** need `GOOGLE_*` (the LLM is via Inference, not Vertex) or `NOW_OVERRIDE`.

```bash
# from .env (already holds the working values):
lk agent update-secrets --config livekit.pipeline.toml --secrets-file .env --ignore-empty-secrets
# then add the Cartesia voice once chosen (Task 6):
# lk agent update-secrets --config livekit.pipeline.toml --secrets CARTESIA_VOICE_ID=<id> --overwrite
```
Verify with `lk agent secrets list --config livekit.pipeline.toml`.

- [ ] **Step 5: Deploy**

```bash
lk agent deploy --config livekit.pipeline.toml   # uses Dockerfile.pipeline if named in the toml/build; else: --dockerfile Dockerfile.pipeline
```
Confirm the build/CMD launches `agent_pipeline.py`. Then:

- [ ] **Step 6: Verify the second agent is running (and the s2s agent still is)**

```bash
lk agent status --config livekit.pipeline.toml    # new agent: Running, 1/1
lk agent status                                   # CA_9A3cUKL9gVwz: still Running
```

- [ ] **Step 7: Commit**

```bash
git add livekit.pipeline.toml Dockerfile.pipeline
git commit -m "chore(pipeline): second LiveKit agent config + Dockerfile"
```

---

### Task 5: Route a spare Telnyx number to the pipeline agent

**Files:** none (infra config). Client provides the spare number.

**Interfaces:**
- Consumes: the deployed pipeline agent (name `molo-pipeline`, id from Task 4).
- Produces: a phone number that reaches the pipeline agent; the current number keeps reaching the s2s agent.

- [ ] **Step 1: Obtain the spare number** — client provides a spare Telnyx number (buy/assign in the Telnyx portal). Record it in E.164.

- [ ] **Step 2: Create a second LiveKit SIP inbound trunk for that number**

```bash
lk sip inbound create \
  --name molo-pipeline-inbound \
  --numbers <spare-number-e164>
# record the returned SIP trunk id
```

- [ ] **Step 3: Create a dispatch rule routing that trunk to the pipeline agent**

```bash
lk sip dispatch create \
  --trunks <pipeline-inbound-trunk-id> \
  --agent-name molo-pipeline \
  --individual                       # one room per call, matching the s2s setup
```
Confirm the agent name matches `PIPELINE_AGENT_NAME`. Point the Telnyx number's SIP connection/voice URI at the LiveKit SIP endpoint (same host the current number uses).

- [ ] **Step 4: Verify dispatch** — `lk sip dispatch list` shows the new rule → `molo-pipeline`; the existing rule for `+48 732 128 903` → the s2s agent is unchanged.

---

### Task 6: Live acceptance + voice selection

**Files:** none (config: set `CARTESIA_VOICE_ID`).

- [ ] **Step 1: Pick a Cartesia EN/PL voice** — in the Cartesia voice library (free account), find a Sonic voice that sounds good in **both** English and Polish; copy its voice id. Set it and redeploy secrets:
```bash
lk agent update-secrets --config livekit.pipeline.toml --secrets CARTESIA_VOICE_ID=<voice-id> --overwrite
```
(The agent runs with Cartesia's default voice until this is set, so this can follow a first test call.)

- [ ] **Step 2: Call the spare number and verify each acceptance criterion:**
  - Answers and converses in **English**.
  - Switches to **Polish** when the caller speaks Polish.
  - Runs the tools end-to-end (ask a KB question → `search_kb`; ask to book → `suggest_available_rooms` → `send_booking_link` texts a link).
  - **No dead air during tool calls** — the specific failure this rebuild targets. The agent should say a short filler ("let me check") and there should be no multi-second silence.
  - **No spoken thinking-tokens / reasoning** (Task 2 filter working).

- [ ] **Step 3: Confirm the s2s agent is unaffected** — call `+48 732 128 903`; it still answers via the original speech-to-speech agent.

- [ ] **Step 4: Record results** in `docs/superpowers/plans/2026-08-11-pipeline-agent.md` (append an outcomes note) and report to the client with the two numbers for A/B.

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| New `agent_pipeline.py`, `agent.py` not edited | 3 (import-only), Global Constraints |
| Cartesia Ink-Whisper STT | 3 (`STT_MODEL`) |
| Gemma 4 31B LLM (no fallback) | 3 (`LLM_MODEL`, verified reachable) |
| Cartesia Sonic TTS + EN/PL voice | 3 (`TTS_MODEL`), 6 (voice pick) |
| LiveKit Inference, one key, no new plugins/deps | Global Constraints, 3 |
| Reuse MoloAgent tools + import INSTRUCTIONS | 1, 3 |
| Reword 3 s2s-only prompt lines (pipeline variant only) | 1 |
| Gemma thinking-token leak (#6375) handled | 2, 3a |
| Duplicate call runner (don't extract) | 3 |
| Separate worker / agent name | 3, 4 |
| Deploy as 2nd LiveKit agent | 4 |
| Spare Telnyx number, parallel A/B | 5 |
| s2s agent stays live/untouched | 4/6 verification |
| Success: EN+PL, tools run, no dead air, no thinking-tokens | 6 |

No gaps.

**2. Placeholder scan:** The only deferred value is `CARTESIA_VOICE_ID` — intentionally an env-config with a working default (Cartesia default voice), tuned in Task 6, not a code placeholder. The runner body in Task 3 is a "paste verbatim from named source lines with 3 enumerated changes" instruction, which is concrete (the source is a specific file+line range), not a vague TODO. The new agent id in Task 4 is produced by a command in the same task.

**3. Type consistency:** `PIPELINE_INSTRUCTIONS` (Task 1) → imported in Task 3 and re-exported as `PIPELINE_INSTRUCTIONS_TEXT`. `strip_thinking_tokens` (Task 2) → used in Task 3a. `build_pipeline_session()`, `PIPELINE_AGENT_NAME` (Task 3) → used by Tasks 4–5. Model constants identical across Task 3 code and tests. Consistent.

**Ordering:** 1 → 2 → 3 (code, gated by 1+2) → 4 (deploy, gated by 3) → 5 (routing, gated by 4) → 6 (acceptance, gated by all). Tasks 1 and 2 are independent and could be done in either order.
