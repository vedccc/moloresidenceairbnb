"""Strip Gemma-4 reasoning markers before they reach TTS (LiveKit issue #6375).

Gemma 4 can emit Harmony-style channel markers ("<|channel|>analysis …",
"<|channel|>final …") and/or <think>…</think> blocks. The framework's default
stripper only knows <think>, so channel-tagged reasoning could be spoken. This
removes both and keeps only the final speakable text.

Evidence note (2026-08-11): live probes against the agent-gateway deployment of
google/gemma-4-31b-it (both a simple prompt and one explicitly asking for
step-by-step reasoning) returned clean `content` with no `<|channel|>` or
`<think>` markers — `reasoning_content` was `null` and `reasoning_tokens: 0` in
both cases, meaning this gateway keeps reasoning out of the spoken text. No
leak was observed here. This filter is kept in as a safety net per LiveKit
issue #6375, since other Gemma-4 deployments/configurations are documented to
emit these markers inline in `content`.
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
    # Replace removed marker blocks with a space, not "", so words that sat on
    # either side of a stripped block don't get glued together (e.g. "Yes
    # indeed<think>oops</think>that's correct." must not become "Yes
    # indeedthat's correct."). The whitespace-collapse pass below normalizes
    # any resulting doubled/extra spaces.
    out = _THINK.sub(" ", text)
    if "<|channel|>" in out.lower():
        if re.search(r"<\|channel\|>\s*final", out, re.IGNORECASE):
            out = _FINAL.sub(" ", out)          # keep only post-final text
        else:
            # No "final" marker — e.g. a completion truncated mid-analysis by
            # max_tokens. Unconditionally dropping the whole analysis segment
            # here would erase all speakable text and hand TTS dead air, which
            # is worse than speaking the raw reasoning. Only drop the segment
            # if that leaves some text behind; otherwise fall through and just
            # strip the bare markers below, keeping the underlying text.
            candidate = _CHANNEL_SEG.sub(" ", out)
            if candidate.strip():
                out = candidate
        out = _STRAY.sub(" ", out)              # remove any leftover bare markers
    result = re.sub(r"\s+", " ", out).strip()
    if not result and text.strip():
        # Absolute safety net: this filter must never turn non-empty input
        # into empty output — dead air is worse than imperfect text reaching
        # TTS. Fall back to the original text with only <think> blocks gone.
        result = re.sub(r"\s+", " ", text).strip()
    return result
