# Pipeline agent (deploy files)

Deploy artifacts for the STT->LLM->TTS pipeline agent. The agent's Python lives
in `../src/` (`agent_pipeline.py`, `pipeline_prompt.py`, `thinking_filter.py`) —
it imports `agent.py` (MoloAgent, INSTRUCTIONS) and must stay there, single-sourced.

- `Dockerfile`  — launches `src/agent_pipeline.py` (build context = `backend/agent/`).
- `livekit.toml`— targets `CA_9DeKbNqCaYHQ`, the agent actually serving calls.

## Current deployment

The pipeline runs as agent **`CA_9DeKbNqCaYHQ`**, dispatch name **`molo-gemma`** —
the id in *this directory's* `livekit.toml`. The number's SIP dispatch rule
(`molo-inbound`) names `molo-gemma`, so this is the agent that answers the phone.

> **Both files in the repo root are stale — do not deploy with them.**
> Root `livekit.toml` still points at `CA_9A3cUKL9gVwz`, an agent slot that no
> longer exists on the project, and root `Dockerfile` still launches
> `src/agent.py` (the retired speech-to-speech agent). A bare `lk agent deploy`
> from `backend/agent/` therefore builds the WRONG agent against a DEAD id.
> Both root files are kept only because `agent.py` is still imported by the
> pipeline and must not be edited.

Deploy from `backend/agent/` (build context is this directory, so both files have
to be swapped in and then restored):

    cp pipeline/Dockerfile Dockerfile
    cp pipeline/livekit.toml livekit.toml
    lk agent deploy --project molo-residence
    git checkout Dockerfile livekit.toml

Check it came up, and roll back if not:

    lk agent status   --project molo-residence --id CA_9DeKbNqCaYHQ
    lk agent logs     --project molo-residence --id CA_9DeKbNqCaYHQ
    lk agent rollback --project molo-residence --id CA_9DeKbNqCaYHQ

Always pass `--project molo-residence` explicitly: four other LiveKit projects
share the same login, and the CLI default is easy to change by accident.

## Secrets

Set with `lk agent update-secrets` (this restarts the agent — no redeploy needed):

    lk agent update-secrets --project molo-residence --id CA_9DeKbNqCaYHQ \
      --secrets ELEVEN_API_KEY=...

`ELEVEN_API_KEY` is optional but recommended — see the TTS tier notes in
`../src/agent_pipeline.py` (`_build_tts`). Without it the agent reaches ElevenLabs
through the LiveKit Inference gateway, where every `elevenlabs/*` model is
deprecated and **retires 2026-08-31**, and where community-library voices cannot
be resolved at all. With the key set, the ElevenLabs plugin is used instead and
neither limit applies.
