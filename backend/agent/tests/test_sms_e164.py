"""Regression tests for sms._e164 (E.164 normalization for Telnyx).

Live call RM_CVpcsEsEyKCj (2026-07-22) failed to text the booking link:

    Telnyx SMS error 400: {"errors":[{"code":"40310",
      "title":"Invalid 'to' address",
      "detail":"The 'to' address should be a single valid number."}]}

SIP delivered the caller as `sip.phoneNumber = "4044000721"` — a 10-digit US
national number with NO country code. The old _e164 just prepended "+", giving
"+4044000721", which parses as country code +40 (Romania) followed by 8 digits —
too short to be a real Romanian number, so Telnyx rejected it. The correct E.164
is "+14044000721".

The fix must ALSO keep working for the case the old code was built for: SIP
often delivers a number that already carries its country code but no "+"
(e.g. "917724958567" = India +91). Those must not be mangled by the default
region.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import sms  # noqa: E402


# --- The bug -----------------------------------------------------------------

def test_us_national_number_gains_its_country_code(monkeypatch):
    """THE REGRESSION: a bare 10-digit NANP number must become +1...

    Old behaviour returned "+4044000721" (invalid -> Telnyx 40310).
    """
    monkeypatch.setenv("SMS_DEFAULT_REGION", "US")
    assert sms._e164("4044000721") == "+14044000721"


def test_polish_national_number_gains_its_country_code(monkeypatch):
    """The same bug in the hotel's own country: 9-digit PL national -> +48..."""
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164("512345678") == "+48512345678"


# --- Must not regress: numbers that already carry a country code -------------

def test_number_with_country_code_but_no_plus_is_preserved(monkeypatch):
    """SIP's usual shape. "917724958567" is India +91 — the default region
    must NOT be applied to it."""
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164("917724958567") == "+917724958567"


def test_already_e164_passes_through(monkeypatch):
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164("+48512345678") == "+48512345678"


def test_sip_uri_wrapper_is_stripped(monkeypatch):
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164("sip:+48512345678@example.com") == "+48512345678"


# --- Garbage must never reach Telnyx -----------------------------------------

def test_number_invalid_for_the_default_region_returns_empty(monkeypatch):
    """A US national number with a PL default region is not a valid number.

    Returning "" means send_sms skips the request entirely rather than earning
    another 40310 — the failure is logged locally instead.
    """
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164("4044000721") == ""


@pytest.mark.parametrize("junk", ["", "   ", "abc", "+", "12"])
def test_unparseable_input_returns_empty(junk, monkeypatch):
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    assert sms._e164(junk) == ""


def test_send_sms_skips_the_request_when_the_number_is_unusable(monkeypatch):
    """The guard that keeps a bad number from ever hitting the Telnyx API."""
    monkeypatch.setenv("SMS_DEFAULT_REGION", "PL")
    monkeypatch.setenv("TELNYX_API_KEY", "test-key")
    monkeypatch.setenv("TELNYX_FROM", "+48123456789")

    def explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("send_sms called Telnyx with an invalid number")

    monkeypatch.setattr(sms.httpx, "post", explode)
    assert sms.send_sms("4044000721", "hello") is False
