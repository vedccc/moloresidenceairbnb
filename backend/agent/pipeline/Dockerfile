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

# Bake the Silero VAD + multilingual turn-detector model files into the image so
# a cold start doesn't pay the download at first-call time (same rationale as the
# s2s agent's Dockerfile). Uses the pipeline entrypoint's own download-files.
RUN uv run python src/agent_pipeline.py download-files

CMD ["uv", "run", "python", "src/agent_pipeline.py", "start"]
