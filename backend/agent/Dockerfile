FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY . .

# Pre-download the Silero VAD + multilingual turn-detector model files into the
# image so a cold start (the agent scales to zero when idle) doesn't pay the
# download cost at first-call time — which was making the SIP call ring out
# before the worker registered. This is the agent CLI's own download-files
# subcommand; the previous `python -m livekit.agents download-files` did not
# exist and silently failed under `|| true`, so nothing was ever baked.
RUN uv run python src/agent.py download-files

CMD ["uv", "run", "python", "src/agent.py", "start"]
