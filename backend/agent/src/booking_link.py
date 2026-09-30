"""Profitroom booking-link builder (Option C).

KWHotel has no shareable booking URL, but the client's Profitroom booking engine
does. We construct a deep link with the dates + party size prefilled; the guest
lands on the availability page and completes room choice + name/email + payment
on Profitroom (which sidesteps the hard-to-capture-by-voice name/email problem).

Example link the params were reverse-engineered from:
  https://booking.profitroom.com/en/moloresidenceapartments/pricelist/multiroom/rooms/offer
    ?check-in=2026-07-16&check-out=2026-07-18&currency=PLN
    &r1_adults=2&r2_adults=2&master-site=moloresidencemasterid
    &Source=v7&source=v7&r1=49824&r2=49824

For a prospective guest we don't have a Profitroom room id, so we link to the
dated availability page (`/pricelist`) with adults prefilled. If a specific
Profitroom offer id is ever known, pass room_offer_id to deep-link the offer.
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlencode


def build_profitroom_url(
    check_in: str,
    check_out: str,
    num_guests: Optional[int] = None,
    room_offer_id: Optional[str] = None,
) -> Optional[str]:
    """Build a Profitroom booking deep link. Returns None if dates are missing."""
    if not check_in or not check_out:
        return None

    base = (os.getenv("PROFITROOM_BASE")
            or "https://booking.profitroom.com/en/moloresidenceapartments").rstrip("/")
    src = os.getenv("PROFITROOM_SOURCE", "v7")

    params: list[tuple[str, str]] = [
        ("check-in", check_in),
        ("check-out", check_out),
        ("currency", os.getenv("PROFITROOM_CURRENCY", "PLN")),
        ("master-site", os.getenv("PROFITROOM_MASTER_SITE", "moloresidencemasterid")),
        ("Source", src),
        ("source", src),
    ]
    if num_guests:
        params.append(("r1_adults", str(int(num_guests))))

    # Deep-link a specific offer when we have its Profitroom id; otherwise land
    # the guest on the dated availability list to pick a room.
    if room_offer_id:
        path = "/pricelist/multiroom/rooms/offer"
        params.append(("r1", str(room_offer_id)))
    else:
        path = "/pricelist"

    return f"{base}{path}?{urlencode(params)}"
