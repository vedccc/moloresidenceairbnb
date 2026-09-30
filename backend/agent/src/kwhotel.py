"""KWHotel PMS client — KWHotel Integrations API v1.0.

Confirmed against the KWHotel Swagger:
  Base:  {KWHOTEL_API_BASE}/api/integrations/hotels/{HotelId}/...
  Auth:  header  ApiKey: <key>
  Reservations:
    GET  /reservations?From=&To=&ModifiedSince=&ClearOtaEmails=   -> [reservation]
    GET  /reservations/{ReservationId}                            -> reservation
    GET  /reservations/online-number/{ReservationOnlineNumber}    -> reservation

Reservation shape (fields the agent uses):
  id, status, statusName, customer{name, phone, email, languageCode},
  rooms[]{ roomName, roomGroupName, checkInDate, checkOutDate, adultCount,
           keyCode, guests[]{name, phone, email, languageCode} }

Guest-identification flow agreed with the client (Molo): guests do NOT give a
reservation id. They say a property name + room number. We resolve the property
to its kwhotel_hotel_id (in Supabase), list the hotel's current reservations,
and fuzzy-match the spoken room against rooms[].roomName. See
find_current_reservation_by_room().

Everything degrades to None on error so the agent can fall back to asking.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger("molo-agent.kwhotel")


# -----------------------------------------------------------------------------
# Low-level request helpers
# -----------------------------------------------------------------------------
def _root() -> str:
    return (os.getenv("KWHOTEL_API_BASE") or "https://cloud.kwhotel.com/kwhotel").rstrip("/")


def _base(hotel_id: int | str) -> str:
    # integrations API — reads (reservations list/lookup, rooms)
    return f"{_root()}/api/integrations/hotels/{hotel_id}"


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    api_key = os.getenv("KWHOTEL_API_KEY")
    if api_key:
        headers["ApiKey"] = api_key  # confirmed header name from Swagger
    return headers


def _resolve_hotel(hotel_id: Optional[int | str]) -> Optional[str]:
    if hotel_id not in (None, ""):
        return str(hotel_id)
    env = os.getenv("KWHOTEL_HOTEL_ID")
    return env or None


async def _get(url: str, params: Optional[dict[str, Any]] = None) -> Optional[Any]:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params or {}, headers=_headers())
            if resp.status_code in (401, 403):
                logger.warning("KWHotel auth failed (%s) for %s", resp.status_code, url)
                return None
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — never crash a live call
        logger.warning("KWHotel GET %s failed: %s", url, exc)
        return None


# -----------------------------------------------------------------------------
# Normalization + fuzzy room matching
# -----------------------------------------------------------------------------
def _norm(text: Optional[str]) -> str:
    """Lowercase, strip 'room/pokój/apartment' filler, collapse whitespace."""
    if not text:
        return ""
    t = str(text).lower().strip()
    t = re.sub(r"\b(room|pokoj|pokój|apartment|apartament|unit|nr|no\.?)\b", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _digits(text: Optional[str]) -> str:
    return re.sub(r"\D", "", text or "")


def _room_tokens(text: Optional[str]) -> list[str]:
    """Alphanumeric room tokens: digits with an optional single letter suffix,
    e.g. '33 Sob 8/4A' -> ['33', '8', '4a'], '15 Ap 102' -> ['15', '102']."""
    return [t.lower() for t in re.findall(r"\d+[a-z]?", text or "", re.I)]


def room_matches(spoken: str, room_name: Optional[str]) -> bool:
    """True if a guest's spoken room (e.g. '402', '3A', 'apartment 5') matches a
    KWHotel roomName.

    KWHotel room names carry a leading internal index plus the real room number,
    e.g. '15 Ap 102' -> tokens ['15', '102']; '12 3A Boho' -> ['12', '3a']. A guest
    says the real room number ('102', '3a'). Matching rules, in order:

    - Exact alnum token: spoken '3a' matches a '3a' token (and NOT a plain '3').
      This lets a guest who knows the letter ('3A') target it precisely.
    - Fuzzy digits: a digits-ONLY spoken ('3') matches a token sharing those
      digits, letter suffix or not — so '3' surfaces both '3' and '3A' (we then
      ask which). We compare whole tokens, never substrings, so '8' never matches
      the '18' inside '18 Ap 103B' and grabs the wrong guest.
    """
    s, r = _norm(spoken), _norm(room_name)
    if not s or not r:
        return False
    if s == r:
        return True
    sp_tokens = re.findall(r"\d+[a-z]?", s, re.I)
    if sp_tokens:
        sp = sp_tokens[0].lower()
        rtokens = _room_tokens(room_name)
        if sp in rtokens:
            return True
        # Fuzzy match only when the guest gave digits with no letter suffix.
        if not re.search(r"[a-z]", sp):
            sd = _digits(sp)
            if sd and any(_digits(t) == sd for t in rtokens):
                return True
        return False
    # Word-named room (e.g. 'Superior'): loose containment.
    return s in r or r in s


# Map a KWHotel room_group string to a human building name + address, so the
# agent can offer concrete choices ("the hotel on Pułaskiego 6a, or the
# apartments on Pułaskiego 10b?") when a room number exists in several buildings.
# Order matters: check the more specific abbreviations (MRA/RRA) before MR/RR.
def building_for(room_group: Optional[str]) -> Optional[str]:
    g = (room_group or "").lower()
    if not g:
        return None
    if "mra" in g:
        return "Molo Residence Apartments (Pułaskiego 10b)"
    if "rra" in g:
        return "Riviera Residence Apartments (Pułaskiego 10b)"
    if "riviera" in g or re.search(r"\brr\b", g):
        return "Riviera Rooms (Chopina 40)"
    if "boho" in g:
        return "Boho (Pułaskiego 6)"
    if "baltic" in g:
        return "the Baltic apartments"
    if "chmiel" in g:
        return "Apartament Molo (Chmielewskiego 7)"
    if "puł 17" in g or "pul 17" in g or "pułaskiego 17" in g or "puł17" in g:
        return "Apartament Molo Superior (Pułaskiego 17)"
    if re.search(r"\bmr\b", g) or g.endswith(" mr") or "molo" in g:
        return "Hotel Molo Residence (Pułaskiego 6a)"
    return room_group  # fall back to the raw group if unmapped


def _normalize_reservation(raw: dict[str, Any]) -> dict[str, Any]:
    """Flatten a KWHotel reservation into the shape the agent expects."""
    customer = raw.get("customer") or {}
    rooms_raw = raw.get("rooms") or []
    rooms: list[dict[str, Any]] = []
    for rm in rooms_raw:
        guests = rm.get("guests") or []
        main_guest = next((g for g in guests if g.get("isMain")), guests[0] if guests else {})
        rooms.append(
            {
                "room_name": rm.get("roomName"),
                "room_group": rm.get("roomGroupName"),
                "room_id": rm.get("roomId"),
                "check_in": rm.get("checkInDate"),
                "check_out": rm.get("checkOutDate"),
                "status": rm.get("statusName"),
                "adults": rm.get("adultCount"),
                "key_code": rm.get("keyCode"),
                "guest_name": (main_guest or {}).get("name"),
                "notes": rm.get("notes"),
            }
        )
    first_room = rooms[0] if rooms else {}
    return {
        "reservation_id": raw.get("id"),
        "guest_name": customer.get("name") or first_room.get("guest_name"),
        "phone": customer.get("phone"),
        "email": customer.get("email"),
        "language": customer.get("languageCode"),
        "status": raw.get("statusName"),
        "room_number": first_room.get("room_name"),
        "room_group": first_room.get("room_group"),
        "check_in": first_room.get("check_in"),
        "check_out": first_room.get("check_out"),
        "rooms": rooms,
        "raw": raw,
    }


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------
async def get_reservation_by_id(
    reservation_id: str, hotel_id: Optional[int | str] = None
) -> Optional[dict[str, Any]]:
    hotel = _resolve_hotel(hotel_id)
    if not hotel or not reservation_id:
        return None
    data = await _get(f"{_base(hotel)}/reservations/{reservation_id}")
    return _normalize_reservation(data) if isinstance(data, dict) else None


async def get_reservation_by_online_number(
    online_number: str, hotel_id: Optional[int | str] = None
) -> Optional[dict[str, Any]]:
    hotel = _resolve_hotel(hotel_id)
    if not hotel or not online_number:
        return None
    data = await _get(f"{_base(hotel)}/reservations/online-number/{online_number}")
    return _normalize_reservation(data) if isinstance(data, dict) else None


async def list_reservations(
    hotel_id: Optional[int | str],
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """List a hotel's reservations in a date window (defaults to today ± a day)."""
    hotel = _resolve_hotel(hotel_id)
    if not hotel:
        return []
    now = datetime.now(timezone.utc)
    frm = (date_from or (now - timedelta(days=1))).date().isoformat()
    to = (date_to or (now + timedelta(days=1))).date().isoformat()
    data = await _get(f"{_base(hotel)}/reservations", {"From": frm, "To": to})
    if not isinstance(data, list):
        return []
    return [_normalize_reservation(r) for r in data if isinstance(r, dict)]


def _is_current(res: dict[str, Any], on_date: datetime) -> bool:
    """True if `on_date` falls within any room's check-in/out window."""
    day = on_date.date().isoformat()
    for rm in res.get("rooms") or []:
        ci, co = rm.get("check_in"), rm.get("check_out")
        if ci and co and ci[:10] <= day <= co[:10]:
            return True
    return not (res.get("rooms"))  # if no room dates, don't exclude


async def find_reservations_by_room(
    hotel_id: Optional[int | str],
    room_query: str,
    on_date: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """Return ALL current reservations whose room matches the spoken room number.

    Usually one, but a spoken room (e.g. '3A') can exist in more than one Molo
    building, so the caller must disambiguate by property/address when >1 is
    returned. Each result is narrowed to its matched room (incl. room_group,
    which hints at the brand/building).
    """
    on = on_date or datetime.now(timezone.utc)
    # KWHotel /reservations filters by CHECK-IN date, so a narrow window misses
    # guests who checked in earlier and are still staying. Query a 30-day back-
    # window (covers any realistic stay length) and filter to current below.
    reservations = await list_reservations(hotel_id, on - timedelta(days=30), on + timedelta(days=1))
    out: list[dict[str, Any]] = []
    for res in reservations:
        if not _is_current(res, on):
            continue
        for rm in res.get("rooms") or []:
            if room_matches(room_query, rm.get("room_name")):
                out.append({
                    **res,
                    "room_number": rm.get("room_name"),
                    "room_group": rm.get("room_group"),
                    "building": building_for(rm.get("room_group")),
                    "check_in": rm.get("check_in"),
                    "check_out": rm.get("check_out"),
                    "guest_name": rm.get("guest_name") or res.get("guest_name"),
                    "matched_room": rm,
                })
                break  # one matched room per reservation
    return out


async def find_current_reservation_by_room(
    hotel_id: Optional[int | str],
    room_query: str,
    on_date: Optional[datetime] = None,
) -> Optional[dict[str, Any]]:
    """First current reservation matching the spoken room (or None)."""
    matches = await find_reservations_by_room(hotel_id, room_query, on_date)
    return matches[0] if matches else None


async def list_rooms(hotel_id: Optional[int | str]) -> list[dict[str, Any]]:
    """List the hotel's physical rooms (GET /property/rooms).

    Returns [{room_id, name, room_group, group_type, description}]. Useful for
    validating a spoken room number against real room names, and for importing
    rooms into the Molo `property_rooms` table.
    """
    hotel = _resolve_hotel(hotel_id)
    if not hotel:
        return []
    data = await _get(f"{_base(hotel)}/property/rooms", {"IncludeAdditionalDescriptions": "true"})
    if not isinstance(data, list):
        return []
    rooms: list[dict[str, Any]] = []
    for rm in data:
        if not isinstance(rm, dict):
            continue
        group = rm.get("roomGroup") or {}
        rooms.append(
            {
                "room_id": rm.get("id"),
                "name": rm.get("name"),
                "room_group": group.get("name"),
                "group_type": group.get("type"),
                "description": rm.get("description"),
            }
        )
    return rooms


async def match_room_name(hotel_id: Optional[int | str], room_query: str) -> Optional[dict[str, Any]]:
    """Fuzzy-match a spoken room against the hotel's real room list."""
    for rm in await list_rooms(hotel_id):
        if room_matches(room_query, rm.get("name")):
            return rm
    return None


# -----------------------------------------------------------------------------
# Availability (computed: rooms NOT held by an overlapping reservation)
# -----------------------------------------------------------------------------
def _to_date_str(value: Any) -> Optional[str]:
    """Coerce a date/datetime/ISO string to a 'YYYY-MM-DD' string."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value)[:10]


def _overlaps(res_in: str, res_out: str, req_in: str, req_out: str) -> bool:
    """True if a reservation [res_in, res_out) overlaps the request
    [req_in, req_out). Checkout day frees the room (half-open intervals)."""
    return res_in < req_out and res_out > req_in


# KWHotel reservation statuses that DO hold inventory (anything not canceled).
def _is_canceled(status: Optional[str]) -> bool:
    return (status or "").strip().lower().startswith("cancel")


_GROUP_TYPE_CAP = {
    "single": 1, "double": 2, "twin": 2, "triple": 3, "quadruple": 4, "quad": 4,
}


def _capacity(room: dict[str, Any]) -> int:
    """Best-effort sleeping capacity for a room from its group naming.

    KWHotel encodes capacity loosely: 'Riviera Rooms 2os', '02 (3os) MR',
    'APP 4 MRA' (os = osób = persons). Prefer an explicit 'Nos', else the
    group_type (Double=2…), else a small standalone number for apartments,
    else a sane default."""
    grp = (room.get("room_group") or "").lower()
    m = re.search(r"(\d+)\s*os", grp)
    if m:
        return int(m.group(1))
    t = (room.get("group_type") or "").lower()
    if t in _GROUP_TYPE_CAP:
        return _GROUP_TYPE_CAP[t]
    m2 = re.search(r"\b([1-9])\b", grp)
    if m2 and "apart" in t:
        return int(m2.group(1))
    return 4 if "apart" in t else 2


def _occupied_ids(reservations: list[dict[str, Any]], ci: str, co: str) -> set[Any]:
    """room_ids held by a NON-canceled reservation overlapping [ci, co)."""
    occupied: set[Any] = set()
    for res in reservations:
        if _is_canceled(res.get("status")):
            continue
        for rm in res.get("rooms") or []:
            r_in, r_out = _to_date_str(rm.get("check_in")), _to_date_str(rm.get("check_out"))
            if r_in and r_out and _overlaps(r_in, r_out, ci, co):
                rid = rm.get("room_id")
                if rid is not None:
                    occupied.add(rid)
    return occupied


def _group_free(
    free: list[dict[str, Any]], limit: int, fit_to: Optional[int] = None
) -> list[dict[str, Any]]:
    """Group free rooms by room_group, capped to `limit`.

    If `fit_to` (party size) is given, order BEST-FIT first: the smallest room
    that still fits the party comes first (so a couple sees doubles before a
    4-person apartment), tie-broken by availability count. Otherwise order by
    availability count descending.
    """
    groups: dict[str, dict[str, Any]] = {}
    for r in free:
        g = (r.get("room_group") or "Other").strip()
        slot = groups.setdefault(
            g, {"room_group": g, "group_type": r.get("group_type"),
                "capacity": _capacity(r), "count": 0, "example_room": r.get("name")},
        )
        slot["count"] += 1
    vals = list(groups.values())
    if fit_to is not None:
        # oversize amount ascending (exact fit first), then most availability
        vals.sort(key=lambda x: (max(0, x["capacity"] - fit_to), -x["count"]))
    else:
        vals.sort(key=lambda x: x["count"], reverse=True)
    return vals[:limit]


def _free_rooms(rooms: list[dict[str, Any]], reservations: list[dict[str, Any]],
                ci: str, co: str) -> list[dict[str, Any]]:
    occ = _occupied_ids(reservations, ci, co)
    return [r for r in rooms if r.get("room_id") not in occ]


async def find_available_rooms(
    hotel_id: Optional[int | str],
    check_in: str,
    check_out: str,
    num_guests: Optional[int] = None,
) -> dict[str, Any]:
    """Compute raw room availability for [check_in, check_out) (YYYY-MM-DD).

    KWHotel exposes no availability endpoint, so we derive it: list every room,
    list reservations overlapping the window, and a room is free if no
    non-canceled reservation holds it across the dates. Returns groups +
    raw free rooms (each tagged with capacity). Failures degrade to empty.
    """
    ci, co = _to_date_str(check_in), _to_date_str(check_out)
    out: dict[str, Any] = {
        "check_in": ci, "check_out": co, "num_guests": num_guests,
        "free_count": 0, "total_rooms": 0, "groups": [], "rooms": [],
    }
    if not ci or not co or ci >= co:
        return out
    rooms = await list_rooms(hotel_id)
    out["total_rooms"] = len(rooms)
    if not rooms:
        return out
    try:
        win_from = datetime.fromisoformat(ci) - timedelta(days=30)
        win_to = datetime.fromisoformat(co)
    except ValueError:
        return out
    reservations = await list_reservations(hotel_id, win_from, win_to)
    free = _free_rooms(rooms, reservations, ci, co)
    out["free_count"] = len(free)
    out["rooms"] = [
        {"room_id": r.get("room_id"), "name": r.get("name"),
         "room_group": r.get("room_group"), "group_type": r.get("group_type"),
         "capacity": _capacity(r)}
        for r in free
    ]
    out["groups"] = _group_free(free, limit=99)
    return out


async def suggest_rooms(
    hotel_id: Optional[int | str],
    check_in: str,
    check_out: str,
    num_guests: Optional[int] = None,
) -> dict[str, Any]:
    """Two-tier suggestions for a prospective guest.

    primary       — up to 3 room groups free for the exact dates that fit the
                    party size (capacity >= num_guests).
    alternatives  — only when there's no exact fit:
                      * 'smaller_capacity': rooms free for the dates but smaller
                        than the party (offer to split / squeeze).
                      * 'nearby_dates': a shifted ±N-day window that has a
                        fitting room.
    All availability is computed from ONE rooms fetch + ONE broad reservation
    fetch (covering exact + nearby windows) — no extra API calls per option.
    """
    ci, co = _to_date_str(check_in), _to_date_str(check_out)
    n = int(num_guests) if num_guests else 1
    out: dict[str, Any] = {
        "check_in": ci, "check_out": co, "num_guests": n,
        "primary": [], "alternatives": [],
    }
    if not ci or not co or ci >= co:
        return out
    rooms = await list_rooms(hotel_id)
    if not rooms:
        return out
    try:
        d_ci, d_co = datetime.fromisoformat(ci), datetime.fromisoformat(co)
    except ValueError:
        return out
    # One broad fetch covering exact + nearby windows.
    reservations = await list_reservations(hotel_id, d_ci - timedelta(days=30), d_co + timedelta(days=10))

    free = _free_rooms(rooms, reservations, ci, co)
    fitting = [r for r in free if _capacity(r) >= n]
    if fitting:
        out["primary"] = _group_free(fitting, limit=3, fit_to=n)
        return out

    # No exact fit → build alternatives.
    if free:  # smaller rooms exist for the dates
        out["alternatives"].append({"kind": "smaller_capacity", "groups": _group_free(free, limit=2)})

    # Nearby dates: shift the whole window, keep the same length, find a fit.
    nights = (d_co - d_ci).days
    for shift in (2, -2, 3, -3, 7):
        s_ci = d_ci + timedelta(days=shift)
        s_co = s_ci + timedelta(days=nights)
        s_ci_s, s_co_s = s_ci.date().isoformat(), s_co.date().isoformat()
        s_free = [r for r in _free_rooms(rooms, reservations, s_ci_s, s_co_s) if _capacity(r) >= n]
        if s_free:
            out["alternatives"].append({
                "kind": "nearby_dates", "check_in": s_ci_s, "check_out": s_co_s,
                "groups": _group_free(s_free, limit=2),
            })
            break
    return out


async def availability_offer(
    hotel_id: Optional[int | str],
    check_in: str,
    check_out: str,
    num_adults: int = 1,
    num_children: int = 0,
) -> dict[str, Any]:
    """Deterministic booking-availability decision (no AI). Computes one of three
    outcomes from ONE rooms fetch + ONE broad reservation fetch, so the agent can
    just speak a fixed sentence with the numbers filled in:

      status='available' → at least one room is free for the WHOLE window.
                           `options` = number of distinct free room groups.
      status='partial'   → not the whole window, but the first `max_nights`
                           nights are stayable (offer a shorter stay).
      status='full'      → the window is fully booked from check-in. `alternatives`
                           holds up to 3 same-length windows (shifted forward, then
                           a little back) that ARE free — alternative start dates.

    Also: 'invalid' (bad dates), 'error' (no rooms / API failure).
    """
    ci, co = _to_date_str(check_in), _to_date_str(check_out)
    party = (int(num_adults or 0)) + (int(num_children or 0)) or 1
    out: dict[str, Any] = {
        "check_in": ci, "check_out": co, "party": party,
        "status": "error", "options": 0, "nights": 0, "max_nights": 0, "alternatives": [],
    }
    if not ci or not co or ci >= co:
        out["status"] = "invalid"
        return out
    try:
        d_ci, d_co = datetime.fromisoformat(ci), datetime.fromisoformat(co)
    except ValueError:
        out["status"] = "invalid"
        return out
    nights = (d_co - d_ci).days
    out["nights"] = nights

    rooms = await list_rooms(hotel_id)
    if not rooms:
        return out
    # One broad fetch covering the exact window + the forward/back search horizon.
    reservations = await list_reservations(
        hotel_id, d_ci - timedelta(days=30), d_co + timedelta(days=28)
    )

    def free_for(a: datetime, b: datetime) -> list[dict[str, Any]]:
        return _free_rooms(rooms, reservations, a.date().isoformat(), b.date().isoformat())

    # 1) Exact window — any room free across the whole stay?
    free_exact = free_for(d_ci, d_co)
    if free_exact:
        out["status"] = "available"
        out["options"] = len(_group_free(free_exact, limit=99, fit_to=party))
        return out

    # 2) Partial — longest stayable run starting from check-in.
    max_nights = 0
    for length in range(nights - 1, 0, -1):
        if free_for(d_ci, d_ci + timedelta(days=length)):
            max_nights = length
            break
    out["max_nights"] = max_nights

    # 3) Alternatives — same-length windows, forward first then slightly back.
    alts: list[dict[str, Any]] = []
    for shift in list(range(1, 29)) + [-1, -2, -3, -7]:
        s_ci = d_ci + timedelta(days=shift)
        s_co = s_ci + timedelta(days=nights)
        if free_for(s_ci, s_co):
            alts.append({"check_in": s_ci.date().isoformat(), "check_out": s_co.date().isoformat()})
            if len(alts) >= 3:
                break
    out["alternatives"] = alts
    out["status"] = "partial" if max_nights > 0 else "full"
    return out


# Backwards-compatible alias used by older agent code: try id, then online number.
async def lookup_reservation(
    reservation_id: str, hotel_id: Optional[int | str] = None
) -> Optional[dict[str, Any]]:
    return await get_reservation_by_id(reservation_id, hotel_id) or await get_reservation_by_online_number(
        reservation_id, hotel_id
    )
