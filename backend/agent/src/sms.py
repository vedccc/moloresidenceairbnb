"""Outbound SMS via Telnyx (texts guests their booking link).

Guarded: returns False on any error / missing config so a live call never breaks
because an SMS couldn't be sent.

Config (Telnyx):
  TELNYX_API_KEY                — API key, sent as Bearer.
  TELNYX_FROM                   — sender number in E.164 (the provisioned Poland
                                  number), e.g. +48...   OR
  TELNYX_MESSAGING_PROFILE_ID   — a messaging profile to send from (Telnyx then
                                  picks a number from the profile).
At least one of TELNYX_FROM / TELNYX_MESSAGING_PROFILE_ID must be set.
"""

from __future__ import annotations

import logging
import os

import httpx
import phonenumbers

logger = logging.getLogger("molo-agent.sms")

_ENDPOINT = os.getenv("TELNYX_SMS_ENDPOINT", "https://api.telnyx.com/v2/messages")


def _e164(num: str) -> str:
    """Normalize to strict E.164 for Telnyx (which rejects anything else).

    SIP hands us the caller number in one of two shapes, and they need opposite
    treatment:

      1. WITH its country code but no '+'  — e.g. '917724958567' (India +91).
         Prepending '+' is correct here.
      2. In NATIONAL format, no country code — e.g. '4044000721' (US, area code
         404). Prepending '+' yields '+4044000721', which reads as country code
         +40 (Romania) plus 8 digits — not a real number. Telnyx rejects it with
         error 40310, and the guest never gets their booking link.

    We can't tell the two apart by shape alone, so we try (1) and fall back to
    (2) against SMS_DEFAULT_REGION, keeping whichever parses as a *valid*
    number. It may also arrive wrapped as 'sip:+48...@host'.

    Returns '' when nothing valid can be made of the input, so send_sms skips
    the API call instead of earning another 40310.
    """
    raw = (num or "").strip().split("@")[0]
    for p in ("sip:", "tel:"):
        if raw.startswith(p):
            raw = raw[len(p):]
    raw = raw.strip()

    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return ""

    region = os.getenv("SMS_DEFAULT_REGION", "PL").strip().upper() or "PL"

    # (1) assume the number already carries its country code; (2) fall back to
    # reading it as a national number in the default region. An explicit '+'
    # means the caller already told us it's international — no fallback.
    attempts = [("+" + digits, None)]
    if not raw.startswith("+"):
        attempts.append((digits, region))

    for text, parse_region in attempts:
        try:
            parsed = phonenumbers.parse(text, parse_region)
        except phonenumbers.NumberParseException:
            continue
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)

    logger.warning("Could not normalize %r to a valid E.164 number (region %s)", num, region)
    return ""


def send_sms(to: str, message: str) -> bool:
    """Send an SMS to `to` (any format; normalized to E.164) via Telnyx."""
    api_key = os.getenv("TELNYX_API_KEY")
    sender = os.getenv("TELNYX_FROM")
    profile_id = os.getenv("TELNYX_MESSAGING_PROFILE_ID")
    to_e164 = _e164(to)
    if not api_key or not to_e164 or not message or not (sender or profile_id):
        return False

    payload: dict[str, str] = {"to": to_e164, "text": message}
    if sender:
        payload["from"] = sender.strip()
    if profile_id:
        payload["messaging_profile_id"] = profile_id.strip()

    try:
        resp = httpx.post(
            _ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10.0,
        )
        if resp.status_code >= 400:
            logger.warning("Telnyx SMS error %s: %s", resp.status_code, resp.text[:300])
            return False
        data = resp.json()
        # Success: {"data": {"id": "...", "to": [{"status": "queued", ...}], ...}}
        ok = bool(isinstance(data, dict) and isinstance(data.get("data"), dict)
                  and data["data"].get("id"))
        if not ok:
            logger.warning("Telnyx SMS unexpected response: %s", str(data)[:200])
        return ok
    except Exception as exc:  # noqa: BLE001 — never crash a live call
        logger.warning("send_sms (telnyx) failed: %s", exc)
        return False
