"""Thin data-access layer over the Molo Supabase schema.

Everything here runs server-side with the SERVICE-ROLE key — the Molo project
has NO edge functions and NO RLS, so the voice agent talks to Postgres directly
(via PostgREST through supabase-py v2).

Every public helper is defensive: on any DB error it logs and returns a safe
fallback (None / [] / 'medium') so a transient failure never crashes a live call.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from supabase import Client, create_client

logger = logging.getLogger("molo-agent.supabase")

# No caching: every KB read hits Supabase fresh, so dashboard edits take effect
# on the next call immediately (no stale TTL window). The KB is a single text
# blob — there are no precomputed Q&A pairs to amortize, so a cache buys little.

# Singleton client (PostgREST is stateless; one client is fine across the worker).
_client: Optional[Client] = None


def get_client() -> Client:
    """Return a cached supabase-py client built from env (service-role key)."""
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# -----------------------------------------------------------------------------
# Properties
# -----------------------------------------------------------------------------
def find_property_by_name_or_alias(text: str) -> Optional[dict[str, Any]]:
    """Find a property whose name (case-insensitive contains) or aliases array
    matches the given free text. Returns the property row or None.

    Aliases live in a JSONB array; we fetch candidates and match in Python so we
    can do a loose, case-insensitive comparison without a custom SQL function.
    """
    if not text or not text.strip():
        return None
    needle = text.strip().lower()
    try:
        sb = get_client()
        # 1) Try a direct name ILIKE match first (cheap, indexed-ish).
        res = (
            sb.table("properties")
            .select("*")
            .ilike("name", f"%{needle}%")
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

        # 2) Fall back to scanning aliases (8 properties — trivially small).
        res = sb.table("properties").select("*").execute()
        for row in res.data or []:
            aliases = row.get("aliases") or []
            if isinstance(aliases, list):
                for alias in aliases:
                    if isinstance(alias, str) and needle in alias.lower():
                        return row
            if needle in (row.get("name") or "").lower():
                return row
    except Exception as exc:  # noqa: BLE001 — never crash the call
        logger.warning("find_property_by_name_or_alias failed: %s", exc)
    return None


def get_property(property_id: str) -> Optional[dict[str, Any]]:
    """Fetch a single property row by id."""
    try:
        sb = get_client()
        res = sb.table("properties").select("*").eq("id", property_id).limit(1).execute()
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_property failed: %s", exc)
    return None


def list_all_property_rooms() -> list[dict[str, Any]]:
    """Every room across all properties (rooms are imported from the PMS into the
    dashboard). Each item: {property_id, property_name, address, aliases,
    transfer_phone, room_number}. Used for existing-guest identification — match
    the spoken room number here (and disambiguate by address only if the same
    room number exists in more than one property). No KWHotel call needed.
    """
    out: list[dict[str, Any]] = []
    try:
        sb = get_client()
        res = (
            sb.table("property_rooms")
            .select("property_id, room_number, properties(name,address,aliases,transfer_phone)")
            .execute()
        )
        for r in res.data or []:
            p = r.get("properties") or {}
            out.append(
                {
                    "property_id": r.get("property_id"),
                    "room_number": r.get("room_number"),
                    "property_name": p.get("name"),
                    "address": p.get("address"),
                    "aliases": p.get("aliases"),
                    "transfer_phone": p.get("transfer_phone"),
                }
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("list_all_property_rooms failed: %s", exc)
    return out


# -----------------------------------------------------------------------------
# Knowledge bases
# -----------------------------------------------------------------------------
def kb_for_room(property_id: str, room_number: Optional[str]) -> list[dict[str, Any]]:
    """Return the KB rows applicable to (property_id, room_number) ordered by
    priority DESC (exception > property > general).

    Uses the `kb_for_room` view. Exception KBs are tied to specific room numbers
    via knowledge_base_rooms; property KBs apply to the whole property (their
    room_number column in the view may be NULL). We therefore keep rows where the
    room matches OR where the row is not room-scoped (property/general kinds).
    The default general KB is appended as a final fallback.
    """
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        sb = get_client()

        # 1. KB assigned to THIS room AT THIS PROPERTY via the dashboard
        #    (knowledge_base_rooms). Room numbers repeat across properties (the
        #    "Rooms" properties all reuse 1-7), so we MUST scope by property_id —
        #    otherwise "room 5" pulls EVERY property's room-5 KB at once, and the
        #    matcher sees several conflicting Wi-Fi passwords and gives up. These
        #    room-specific rows load FIRST (highest priority) so a per-room override
        #    wins on conflict. Own try/except so a hiccup here (or the property_id
        #    column not existing pre-migration) never skips the property view below.
        if room_number:
            try:
                assigned = (
                    sb.table("knowledge_base_rooms")
                    .select("knowledge_bases(id, name, kind, content)")
                    .eq("property_id", property_id)
                    .eq("room_number", room_number)
                    .execute()
                )
                for r in assigned.data or []:
                    kb = r.get("knowledge_bases") or {}
                    kid = kb.get("id")
                    if kid and kid not in seen and (kb.get("content") or "").strip():
                        seen.add(kid)
                        rows.append({
                            "property_id": property_id,
                            "room_number": room_number,
                            "kb_id": kid,
                            "kb_name": kb.get("name"),
                            "kind": kb.get("kind") or "room",
                            "content": kb.get("content", ""),
                            "priority": 3,
                        })
            except Exception as exc:  # noqa: BLE001
                logger.warning("room-assigned KB lookup failed (property-scoped): %s", exc)

        # 2. Property / general KBs for this property, via the view (seeded data
        #    that carries a real property_id and kind).
        res = (
            sb.table("kb_for_room")
            .select("*")
            .eq("property_id", property_id)
            .order("priority", desc=True)
            .execute()
        )
        for row in res.data or []:
            kid = row.get("kb_id")
            if kid in seen:
                continue
            kind = row.get("kind")
            row_room = row.get("room_number")
            if kind in ("property", "general"):
                seen.add(kid)
                rows.append(row)
            elif kind == "exception" and room_number and row_room == room_number:
                seen.add(kid)
                rows.append(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("kb_for_room failed: %s", exc)

    # 3. Ensure the default general KB is present as a last-resort fallback.
    default = get_default_general_kb_row()
    if default and default.get("id") not in seen:
        rows.append(
            {
                "property_id": property_id,
                "property_name": None,
                "room_number": None,
                "kb_id": default.get("id"),
                "kb_name": default.get("name"),
                "kind": "general",
                "content": default.get("content", ""),
                "priority": 1,
            }
        )
    return rows


def get_default_general_kb_row() -> Optional[dict[str, Any]]:
    """Return the full default general KB row (is_default_general = true)."""
    try:
        sb = get_client()
        res = (
            sb.table("knowledge_bases")
            .select("*")
            .eq("is_default_general", True)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_default_general_kb_row failed: %s", exc)
    return None


def get_default_general_kb() -> str:
    """Return just the content text of the default general KB ('' if none).

    Read once at call start, before the greeting, so the general KB is loaded
    into the agent before the first guest question. Fetched fresh from Supabase
    every call so dashboard edits to the general KB surface immediately.
    """
    row = get_default_general_kb_row()
    return (row or {}).get("content", "") if row else ""


# -----------------------------------------------------------------------------
# Urgency classification
# -----------------------------------------------------------------------------
def match_urgency(description: str) -> tuple[str, Optional[str]]:
    """Classify a maintenance description into an urgency level.

    Walks urgency_rules ordered by sort_order ASC (critical first) and returns
    the first rule whose keywords or examples appear (case-insensitive substring)
    in the description. Returns (level, urgency_rule_id). Defaults to
    ('medium', None) if nothing matches or on error.
    """
    text = (description or "").lower()
    try:
        sb = get_client()
        res = (
            sb.table("urgency_rules")
            .select("id, level, keywords, examples, sort_order")
            .order("sort_order", desc=False)
            .execute()
        )
        for rule in res.data or []:
            terms: list[str] = []
            for bucket in (rule.get("keywords"), rule.get("examples")):
                if isinstance(bucket, list):
                    terms.extend(t for t in bucket if isinstance(t, str))
            for term in terms:
                if term and term.lower() in text:
                    return rule.get("level", "medium"), rule.get("id")
    except Exception as exc:  # noqa: BLE001
        logger.warning("match_urgency failed: %s", exc)
    return "medium", None


# -----------------------------------------------------------------------------
# Maintenance tickets
# -----------------------------------------------------------------------------
def create_maintenance_ticket(
    property_id: str,
    room_number: str,
    description: str,
    reservation_id: Optional[str] = None,
    call_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Insert a maintenance ticket (created_via='call'), auto-classifying urgency.

    property_id and room_number are NOT NULL in the schema, so callers must have
    resolved a reservation/property first. Returns the inserted row or None.
    """
    if not property_id or not room_number:
        logger.warning("create_maintenance_ticket missing property_id/room_number")
        return None
    level, rule_id = match_urgency(description)
    payload = {
        "property_id": property_id,
        "room_number": room_number,
        "reservation_id": reservation_id,
        "call_id": call_id,
        "description": description,
        "urgency": level,
        "urgency_rule_id": rule_id,
        "status": "open",
        "created_via": "call",
    }
    try:
        sb = get_client()
        res = sb.table("maintenance_tickets").insert(payload).execute()
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("create_maintenance_ticket failed: %s", exc)
    return None


# -----------------------------------------------------------------------------
# Booking links
# -----------------------------------------------------------------------------
def create_booking_link(
    phone: str,
    property_name: str,
    property_address: str,
    guest_name: str,
    num_guests: int,
    booking_option: str,
    check_in: str,
    check_out: str,
    generated_url: Optional[str] = None,
    call_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Insert a booking_links row. All listed columns are NOT NULL in the schema;
    check_out must be after check_in (DB constraint). Returns row or None."""
    payload = {
        "call_id": call_id,
        "phone": phone,
        "property_name": property_name,
        "property_address": property_address,
        "guest_name": guest_name,
        "num_guests": num_guests,
        "booking_option": booking_option,
        "check_in": check_in,
        "check_out": check_out,
        "generated_url": generated_url,
        "converted": False,
    }
    try:
        sb = get_client()
        res = sb.table("booking_links").insert(payload).execute()
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("create_booking_link failed: %s", exc)
    return None


# -----------------------------------------------------------------------------
# Call logs
# -----------------------------------------------------------------------------
def insert_call_log(payload: dict[str, Any]) -> Optional[str]:
    """Insert the initial call_logs row, returning its id (or None on failure)."""
    body = dict(payload)
    body.setdefault("started_at", _now_iso())
    body.setdefault("direction", "inbound")
    body.setdefault("tool_calls", [])
    try:
        sb = get_client()
        res = sb.table("call_logs").insert(body).execute()
        if res.data:
            return res.data[0].get("id")
    except Exception as exc:  # noqa: BLE001
        logger.warning("insert_call_log failed: %s", exc)
    return None


def update_call_log(call_id: str, patch: dict[str, Any]) -> bool:
    """Patch an existing call_logs row. Returns True on success."""
    if not call_id:
        return False
    try:
        sb = get_client()
        sb.table("call_logs").update(patch).eq("id", call_id).execute()
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("update_call_log failed: %s", exc)
        return False


def redact_calls_for_number(phone: str) -> int:
    """GDPR erasure for a phone number. Returns how many calls were scrubbed.

    Calls the `redact_calls_for_number` SQL function rather than issuing the
    updates from here, so the agent and the nightly retention sweep share one
    definition of what "erased" means — phone number and transcript cleared on
    EVERY call from that number, plus booking_links, with the rows themselves
    kept so the dashboard's stats are unaffected.

    Returns 0 on any error; the caller decides what to do about that.
    """
    if not phone or not phone.strip():
        return 0
    try:
        sb = get_client()
        resp = sb.rpc("redact_calls_for_number", {"target_phone": phone}).execute()
        return int(resp.data or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redact_calls_for_number failed for %s: %s", phone, exc)
        return 0


# -----------------------------------------------------------------------------
# Agent settings (singleton)
# -----------------------------------------------------------------------------
def get_agent_settings() -> dict[str, Any]:
    """Return the agent_settings singleton row, or {} on failure."""
    try:
        sb = get_client()
        res = sb.table("agent_settings").select("*").limit(1).execute()
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_agent_settings failed: %s", exc)
    return {}
