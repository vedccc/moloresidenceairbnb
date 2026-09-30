from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Optional

from dotenv import load_dotenv
from pydantic import Field
from google.genai import types

import molo_supabase as db
import kb_search
import kwhotel
import booking_link
import sms

from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AudioConfig,
    BackgroundAudioPlayer,
    BuiltinAudioClip,
    RunContext,
    function_tool,
    room_io,
)
from livekit.api import LiveKitAPI
from livekit.protocol.sip import CreateSIPParticipantRequest
from livekit.plugins import google, noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

load_dotenv(".env")

logger = logging.getLogger("molo-agent")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_warsaw() -> datetime:
    """Current LOCAL time in Poland (Sopot), handling CET/CEST automatically.

    The live model has no clock otherwise; it needs local time to reason about
    the relative dates callers use ("tonight", "tomorrow", "next Monday"). Falls
    back to a fixed UTC+2 offset only if the tz database is missing from the
    runtime image (the `tzdata` dep should make that fallback unreachable)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw"))
    except Exception:  # noqa: BLE001 — no tz database available
        return datetime.now(timezone(timedelta(hours=2)))

# If GOOGLE_CREDENTIALS_B64 is set (cloud deploys), decode it to a temp file and
# point GOOGLE_APPLICATION_CREDENTIALS at it (same as the Convrse agent).
_gcp_creds_b64 = os.getenv("GOOGLE_CREDENTIALS_B64")
if _gcp_creds_b64:
    _tmp = tempfile.NamedTemporaryFile(mode="wb", suffix=".json", delete=False)
    _tmp.write(base64.b64decode(_gcp_creds_b64))
    _tmp.close()
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = _tmp.name



INSTRUCTIONS = """# You don't know anything or can't help with anything except for what's defined in the prompt and the tool calls.

# Role

You are **Mili**, the AI phone concierge for **Molo Residence** (hotels and apartments in Sopot, Poland). You help current guests with questions and maintenance, and prospective guests with bookings.

# Context

You will receive inbound phone calls for either existing guests or new guests. Existing guests will have questions about their room or want to deal with issues such as check-ins, questions, or maintenance. New guests will want to make a booking.

# Emotional Direction

- You speak both fluent Polish and English and speak with a native accent for each respective language. You can switch language depending on which language the caller is using.
- You speak naturally like a human making sounds like "ummm" or "ahhh" and using phrases like "sure" or "okay hmm let's see" "yes I'll send the booking link to you now, just one second".
- Warm and natural, with contractions. React lightly ("mhm", "got it").
- One to three sentences per turn. Never monologue.
- Never say technical terms like "knowledge base", "system", or "database" to the caller.

# Calling Tools

- Never speak a sentence and then call a tool in the same turn — that cuts your speech off mid-word. Either call the tool FIRST (a soft thinking sound covers the brief wait) and speak once it returns, OR finish what you're saying and wait for the caller before calling anything. Do not do both in one turn.

# Agent Roles

## Step by Step — Existing Guest

### Step 1 - Identify guest
Use this if the guest has mentioned that they are an existing guest or their answer hints at this e.g. "what's my wifi". Always ask for their room number first.
1. Ask for the caller's room number.
2. Repeat the room number back and ask for confirmation.
3. Only if the caller confirms, then say "I'm currently pulling up your reservation" and IMMEDIATELY use the tool `identify_guest`.
4. If the tool says the room is at MORE THAN ONE address, ask which address they're at, then say "I'll try looking for your reservation again" and use `identify_guest` again with that address.
5. If the room is at ONE address, briefly say where they are and continue.
6. After identifying the guest, move to either Step 2 or Step 3 depending on the caller's request.

### Step 2 - Questions
1. If the caller asks a question, use the tool `search_kb` immediately and present the returned answer to the guest.
2. If `search_kb` returns NO_KB_MATCH, do NOT go silent and do NOT give up yet: if the guest isn't identified, get their room number and call `identify_guest`, then `search_kb` again. Only say you don't have that detail once that won't help. NEVER offer a follow-up or a call-back; we do not follow up.
3. You don't know anything or can't help with anything except for what's defined in the prompt and the tool calls.

### Step 3 - Maintenance
1. If the caller is having trouble or difficulties, first of all use the tool `search_kb` to troubleshoot the issue.
2. If you have exhausted the available answers, ask the guest if they would like you to raise a maintenance ticket.
3. Only if the caller confirms, use the tool `raise_maintenance_ticket` to raise a ticket.
4. Wait for the ticket to be submitted successfully.
5. In case of emergency, offer to transfer the caller to a live agent as per the Transfer agent role.

## Step by Step — Booking (Prospective Guest)
Use this pathway If the caller asks a general question without providing the room number or is clearly not an existing guest but looking to book.
### Step 1 - Questions
1. When the caller asks a question, call `search_kb` immediately (a soft thinking sound covers the brief wait). Don't speak a full filler sentence and hold the call back.
2. The instant `search_kb` returns, speak the answer conversationally. If it returns NO_KB_MATCH: a prospective guest has no room, so briefly say you don't have that exact detail and ask if there's anything else — BUT if it turns out they're actually a current guest asking about their own room, get their room number and call `identify_guest` first, then `search_kb` again. NEVER offer a follow-up or a call-back; we do not follow up.
3. You don't know anything or can't help with anything except for what's defined in the prompt and the tool calls.

### Step 2 - Booking
1. Ask the check-in date.
2. Ask the check-out date.
3. Ask how many adults.
4. Ask how many children.
5. After collecting all details, repeat them all back and ask the caller to confirm (e.g. "so that's 2 adults and 1 child, from the 22nd to the 26th — is that right?"). Then STOP and wait for their answer — do NOT call any tool in this turn.
6. Only after the caller confirms, call `suggest_available_rooms` straight away. Do NOT say a sentence first and then call it (that cuts you off) — the soft thinking sound covers the brief wait.
7. The tool returns a ready-to-speak sentence — say it almost word for word. Do not reason about availability yourself, and never promise a room it didn't return.
8. Present the room options to the caller and ask if they would like to book.
9. When they're ready to book, you can exclusively send them a customized booking link where they can fill in their details like name and payment information. Use `send_booking_link` to send the link.
"""

GREETING = (
    "Greet UNMISTAKABLY IN ENGLISH (switch to Polish only if the caller speaks "
    "Polish). Warmly welcome the caller to Molo Residence, introduce yourself as "
    "Mili, and ask whether they're already staying with us or looking to book. "
    "Keep it to one short, natural sentence."
)

# Dead-air / duration guards (seconds) 
DEAD_AIR_CHECKIN = 25
DEAD_AIR_HANGUP = 40
MAX_CALL_DURATION = 7 * 60

_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")


def _human_date(iso: str) -> str:
    """'2026-06-23' -> 'June 23' for natural speech."""
    try:
        y, m, d = iso.split("-")
        return f"{_MONTHS[int(m) - 1]} {int(d)}"
    except Exception:  # noqa: BLE001
        return iso


def _fmt_alt_dates(alts: list[dict[str, Any]]) -> str:
    """Join alternative-window start dates: 'June 23, June 29, or July 6'."""
    days = [_human_date(a["check_in"]) for a in alts if a.get("check_in")]
    if not days:
        return ""
    if len(days) == 1:
        return days[0]
    return ", ".join(days[:-1]) + (", or " if len(days) > 2 else " or ") + days[-1]


# -----------------------------------------------------------------------------
# Agent — flow 1 tools only
# -----------------------------------------------------------------------------
class MoloAgent(Agent):
    def __init__(self, instructions: str, default_kb_content: str,
                 from_number: str = "", call_id: Optional[str] = None,
                 room_name: str = "", transfer_phone: Optional[str] = None):
        super().__init__(instructions=instructions)
        self.from_number = from_number
        self.call_id = call_id
        self.room_name = room_name
        # Front-desk transfer number — set by staff in the dashboard
        # (agent_settings.transfer_default_phone), loaded at call start.
        self.transfer_phone = transfer_phone
        # Mutable call state, resolved as the conversation progresses.
        self.property: Optional[dict[str, Any]] = None
        self.property_id: Optional[str] = None
        self.room_number: Optional[str] = None
        self.kb_content: str = default_kb_content or ""
        # Which KB is currently loaded — recorded with every tool call so a wrong
        # answer can be traced to whether the general or a room-specific KB was used.
        self.kb_source: str = "general (preloaded)"
        self.mode: str = "unknown"
        self.outcome_hint: Optional[str] = None
        self.tool_calls: list[dict[str, Any]] = []
        # Memoized search_kb answers for THIS call only, cleared whenever the KB
        # swaps (identify_guest). A native-audio turn that calls search_kb can be
        # interrupted before it speaks; the caller re-prompts and the model re-fires
        # the SAME search_kb. This memo makes that duplicate reuse the answer instead
        # of paying for a second Gemini lookup. Per-call, bust-on-change, no TTL
        # (consistent with the Redis-removal decision — no stale-KB cache).
        self._kb_answer_cache: dict[str, str] = {}

    def _record_tool(self, name: str, args: dict, result: Any) -> None:
        self.tool_calls.append({
            "name": name,
            "args": args,
            "result": str(result)[:1500],
            "kb_source": self.kb_source,
            "at": _now_iso(),
        })

    async def _before_tool(self, context: RunContext, key: str) -> None:
        """Hook fired at the start of each tool. No-op here (the native-audio
        agent bridges the tool-call gap with a background sound); the pipeline
        agent overrides this to speak a fixed non-interruptible filler phrase."""
        return None

    # -- tools ---------------------------------------------------------------
    @function_tool()
    async def identify_guest(
        self,
        context: RunContext,
        room_number: Annotated[str, Field(
            description="The confirmed room number of the guest."
        )],
        address: Annotated[str, Field(
            description=(
                "The confirmed address of the guest. Write \"null\" if the guest "
                "hasn't mentioned it."
            )
        )],
    ) -> str:
        """Use to find details about the guest's reservation; use after the guest
        has confirmed their room number (and address if asked)."""
        await self._before_tool(context, "identify_guest")
        self.mode = "guest"
        _args = {"room_number": room_number, "address": address}
        # `address` is always sent and may be the literal "null" (or empty) until
        # the guest names one — normalize that to a real None for the matching below.
        if address and address.strip().lower() in ("null", "none", ""):
            address = None
        try:
            rooms = db.list_all_property_rooms()
            matches = [r for r in rooms if kwhotel.room_matches(room_number, r.get("room_number"))]
            if not matches:
                msg = (
                    f"I couldn't find a room '{room_number}' in any Molo property. Ask the guest to "
                    "double-check their room number."
                )
                self._record_tool("identify_guest", _args, "no match: " + msg)
                return msg

            # One entry per property that has a matching room.
            by_prop: dict[str, dict[str, Any]] = {}
            for r in matches:
                by_prop.setdefault(r["property_id"], r)

            # If the room is in more than one property, disambiguate by the
            # address/property the guest named (if any).
            if len(by_prop) > 1 and address:
                al = address.lower()
                # Building numbers ("6/2", "6a", "10b", "40/8") are the ONLY thing
                # that distinguishes e.g. Pułaskiego 6/2 from Pułaskiego 6a, so we
                # MUST keep them — a plain {3,} token filter drops them and the two
                # addresses tie. Capture building numbers + street words (≥4 chars).
                akw = set(re.findall(r"\d+[a-z]?(?:/\d+[a-z]?)?", al))
                akw |= set(re.findall(r"[a-z]{4,}", al))

                def _score(r: dict[str, Any]) -> int:
                    aliases = r.get("aliases")
                    hay = " ".join(filter(None, [
                        r.get("property_name") or "",
                        r.get("address") or "",
                        " ".join(aliases) if isinstance(aliases, list) else "",
                    ])).lower()
                    return sum(1 for k in akw if k in hay)

                ranked = sorted(by_prop.values(), key=_score, reverse=True)
                if ranked and _score(ranked[0]) > 0 and (
                    len(ranked) == 1 or _score(ranked[0]) > _score(ranked[1])
                ):
                    by_prop = {ranked[0]["property_id"]: ranked[0]}

            if len(by_prop) == 1:
                chosen = next(iter(by_prop.values()))
                self.property_id = chosen["property_id"]
                self.property = {
                    "id": chosen["property_id"], "name": chosen.get("property_name"),
                    "address": chosen.get("address"), "aliases": chosen.get("aliases"),
                }
                self.room_number = chosen.get("room_number") or room_number

                kb_rows = db.kb_for_room(self.property_id, self.room_number)
                # Two-part KB: label room-specific sections (priority >= 3) so the
                # kb_search model knows their values OVERRIDE the general/building
                # ones (e.g. an apartment's own Wi-Fi beats the building network).
                # kb_search.py's system prompt keys off these exact labels.
                parts = []
                for r in kb_rows:
                    c = r.get("content")
                    if not c:
                        continue
                    label = (
                        "ROOM-SPECIFIC INFO (overrides the general info below)"
                        if (r.get("priority") or 0) >= 3
                        else "GENERAL PROPERTY INFO"
                    )
                    parts.append(f"### {label}\n{c}")
                merged = "\n\n---\n\n".join(parts)
                if merged:
                    self.kb_content = merged
                    self._kb_answer_cache.clear()  # KB changed — drop memoized answers
                # Record which KB now backs search_kb, for debugging wrong answers.
                kinds = ", ".join(str(r.get("kind")) for r in kb_rows) or "none"
                self.kb_source = (
                    f"{chosen.get('property_name')} / room {self.room_number} "
                    f"({len(kb_rows)} kb rows: {kinds})"
                )

                addr = chosen.get("address")
                msg = (
                    f"MATCHED (one place): room {self.room_number} is at "
                    f"{addr or chosen.get('property_name')}. Do NOT ask them to confirm the "
                    "address, and do NOT speak a standalone sentence about their location first "
                    "(it gets cut off when you then call a tool). Go straight to their request: if "
                    "they've already asked a question, call search_kb using ONLY the caller's own "
                    "words for the question — do NOT add the room number or address into the search "
                    "text (that makes it miss general info like carpets or house rules). You may "
                    "weave where they are into your spoken ANSWER if it helps (e.g. 'You're at "
                    "Pułaskiego 6/3a — the Wi-Fi is…'); otherwise briefly note where they are and "
                    "ask how you can help."
                )
                self._record_tool("identify_guest", _args, msg)
                return msg

            # Room in multiple properties and no/ambiguous address — ask once,
            # offering the ADDRESSES (guests don't know internal property names).
            opts = sorted({
                (r.get("address") or r.get("property_name") or "")
                for r in by_prop.values() if (r.get("address") or r.get("property_name"))
            })
            msg = (
                f"MATCHED (multiple places): room {room_number} exists at more than one address: "
                f"{' OR '.join(opts)}. Ask the guest which of these addresses they're at (say the "
                "addresses, not internal property names), then call identify_guest again with the "
                "room number and that address. If they don't know, ask once, then proceed or offer "
                "to transfer — do not loop."
            )
            self._record_tool("identify_guest", _args, "ambiguous: " + msg)
            return msg
        except Exception as exc:  # noqa: BLE001
            logger.warning("identify_guest error: %s", exc)
            self._record_tool("identify_guest", _args, f"error: {exc}")
            return "I had trouble looking that up — could you tell me your room number again?"

    @function_tool()
    async def search_kb(
        self,
        context: RunContext,
        question: Annotated[str, Field(description="The question the caller asked.")],
    ) -> str:
        """Use to answer all questions for new and existing guests."""
        await self._before_tool(context, "search_kb")
        result = await self._answer_kb(question)
        # On a miss while the guest's room KB isn't loaded yet, the answer may be
        # room-specific (Wi-Fi, door code, heating, appliances...). Nudge the model
        # to identify the guest and retry instead of giving up — delivered in the
        # tool response (point of need) because the equivalent prompt rule is
        # unreliably followed by the native-audio model.
        if "NO_KB_MATCH" in result and not self.property_id:
            result = (
                "NO_KB_MATCH and the guest is NOT identified yet. Do NOT tell the guest you "
                "don't have this. ACTION REQUIRED: ask for their room number now, then call "
                "identify_guest, then call search_kb again — their room's info very likely has "
                "it (Wi-Fi, door code, heating, appliances). Say: \"Sure — to pull up your "
                "room's details, what's your room number?\" ONLY if the guest then says they "
                "are not staying / are just booking should you say you don't have that detail "
                "(and never offer a follow-up)."
            )
        self._record_tool("search_kb", {"question": question}, result)
        return result

    async def _answer_kb(self, question: str) -> str:
        """KB answer for `question`, memoized per call (busted on KB swap).

        Stops a duplicate search_kb (fired when an interrupted first response is
        re-attempted) from paying for a second Gemini KB lookup.
        """
        key = question.strip().lower()
        cached = self._kb_answer_cache.get(key)
        if cached is not None:
            return cached
        # Primary: semantic, grounded answer from Gemini over the loaded KB.
        # Fallback: naive keyword search if that errors/times out (None) so a
        # hiccup never strands the caller mid-call.
        result = await kb_search.answer_from_kb(question, self.kb_content)
        if result is None:
            result = self._search_kb_content(question)
        self._kb_answer_cache[key] = result
        return result

    def _search_kb_content(self, question: str) -> str:
        """Naive keyword search over the free-text KB."""
        content = self.kb_content or ""
        if not content.strip():
            return "NO_KB_MATCH: no knowledge base is loaded for this yet."
        q_words = {w for w in question.lower().split() if len(w) > 2}
        paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
        scored: list[tuple[int, str]] = []
        for para in paragraphs:
            text = para.lower()
            score = sum(1 for w in q_words if w in text)
            if score:
                scored.append((score, para))
        scored.sort(key=lambda x: x[0], reverse=True)
        if scored:
            return "\n\n".join(p for _, p in scored[:3])
        return "NO_KB_MATCH: nothing in the loaded knowledge base covers this question."

    @function_tool()
    async def raise_maintenance_ticket(
        self,
        context: RunContext,
        description: Annotated[str, Field(
            description="A detailed description of the issue the caller is facing."
        )],
    ) -> str:
        """Use to raise a maintenance ticket."""
        if not self.property_id or not self.room_number:
            return ("I need to confirm your room first so I know the property and room. "
                    "Could you tell me your room number?")
        await self._before_tool(context, "raise_maintenance_ticket")
        ticket = db.create_maintenance_ticket(
            property_id=self.property_id,
            room_number=self.room_number,
            description=description,
        )
        if ticket:
            self.outcome_hint = "maintenance_ticket_raised"
            msg = (f"Maintenance ticket created ({ticket.get('urgency', 'medium')} priority). "
                   "Tell the guest the team has been notified and will take care of it.")
            self._record_tool("raise_maintenance_ticket", {"description": description}, msg)
            return msg
        msg = ("I couldn't file that ticket just now. Apologize briefly and ask if there's "
               "anything else you can help with. Do NOT promise that anyone will follow up.")
        self._record_tool("raise_maintenance_ticket", {"description": description}, msg)
        return msg

    @function_tool()
    async def suggest_available_rooms(
        self,
        context: RunContext,
        check_in: Annotated[str, Field(
            description="The confirmed check-in date in the format YYYY-MM-DD."
        )],
        check_out: Annotated[str, Field(
            description="The confirmed check-out date in the format YYYY-MM-DD."
        )],
        num_adults: Annotated[int, Field(description="The confirmed number of adults.")],
        num_children: Annotated[int, Field(description="The confirmed number of children.")],
    ) -> str:
        """Use to check for availability after collecting and confirming the dates
        and guest amount."""
        await self._before_tool(context, "suggest_available_rooms")
        self.mode = "booking"
        _args = {"check_in": check_in, "check_out": check_out,
                 "num_adults": num_adults, "num_children": num_children}
        # KWHotel hotel id: a property override if one is already known, else the
        # default (839 covers the whole Molo portfolio — bookers search all locations).
        prop = self.property
        hotel_id = (prop or {}).get("kwhotel_hotel_id") or os.getenv("KWHOTEL_HOTEL_ID")

        try:
            offer = await kwhotel.availability_offer(
                hotel_id, check_in, check_out, num_adults, num_children
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("availability_offer error: %s", exc)
            self._record_tool("suggest_available_rooms", _args, f"error: {exc}")
            return ("SAY: I couldn't check availability just now — could you re-confirm the dates "
                    "so I can try again?")

        status = offer.get("status")
        self._record_tool("suggest_available_rooms", _args,
                          {"status": status, "options": offer.get("options"),
                           "max_nights": offer.get("max_nights"),
                           "alternatives": offer.get("alternatives")})
        if status == "available":
            n = offer.get("options", 0)
            opt = "option" if n == 1 else "options"
            return (
                f"SAY (after the caller says they'd like to book, call send_booking_link with "
                f"these exact dates and party size): Great news — for your dates we have {n} {opt} "
                "available. Would you like me to send you a booking link so you can choose your "
                "room and book securely online?"
            )
        if status == "partial":
            m = offer.get("max_nights", 0)
            night = "night" if m == 1 else "nights"
            alts = offer.get("alternatives") or []
            tail = ""
            if alts:
                tail = (f" Or I have the full stay available starting {_fmt_alt_dates(alts)}.")
            return (
                f"SAY: Those exact dates aren't fully open — but I could do the first {m} {night} of "
                f"that stay.{tail} Would a shorter stay work, or would you like to give me different "
                "dates and I'll check again?"
            )
        if status == "full":
            alts = offer.get("alternatives") or []
            nights = offer.get("nights", 0)
            nlabel = "night" if nights == 1 else "nights"
            if alts:
                return (
                    f"SAY: Unfortunately those dates are fully booked — but I have {nights}-{nlabel} "
                    f"stays available starting {_fmt_alt_dates(alts)}. Would you like a booking link "
                    "for one of those?"
                )
            return ("SAY: Unfortunately those dates are fully booked, and I couldn't find a nearby "
                    "opening of the same length. Would other dates work for you?")
        if status == "invalid":
            return "SAY: Could you re-confirm the check-in and check-out dates for me?"
        return ("SAY: I couldn't check availability just now — could you re-confirm the dates so "
                "I can try again?")

    @function_tool()
    async def send_booking_link(
        self,
        context: RunContext,
        check_in: Annotated[str, Field(
            description="The confirmed check-in date in the format YYYY-MM-DD."
        )],
        check_out: Annotated[str, Field(
            description="The confirmed check-out date in the format YYYY-MM-DD."
        )],
        num_adults: Annotated[int, Field(description="The confirmed number of adults.")],
        num_children: Annotated[int, Field(description="The confirmed number of children.")],
    ) -> str:
        """Sends a customized booking link."""
        await self._before_tool(context, "send_booking_link")
        num_guests = (int(num_adults or 0) + int(num_children or 0)) or 1
        # Resolve a property for the booking_links row (NOT NULL columns). A
        # prospective booker usually has no property yet, so fall back to defaults.
        prop = self.property
        prop_name = (prop or {}).get("name") or "Molo Residence"
        prop_addr = (prop or {}).get("address") or "Sopot, Poland"

        # Profitroom deep link (dates + party size prefilled); the guest picks a
        # room and enters name/email/payment on Profitroom.
        url = booking_link.build_profitroom_url(check_in, check_out, num_guests)

        db.create_booking_link(
            phone=self.from_number or "",
            property_name=prop_name,
            property_address=prop_addr,
            guest_name="",
            num_guests=num_guests,
            booking_option="",
            check_in=check_in,
            check_out=check_out,
            generated_url=url,
        )

        sent = False
        if url and self.from_number:
            sms_text = f"Molo Residence — book your stay {check_in} to {check_out}: {url}"
            sent = sms.send_sms(self.from_number, sms_text)

        self.mode = "booking"
        self.outcome_hint = "booking_link_sent" if (sent or url) else self.outcome_hint
        self._record_tool(
            "send_booking_link",
            {"check_in": check_in, "check_out": check_out,
             "num_adults": num_adults, "num_children": num_children},
            {"sms_sent": sent, "url_built": bool(url)},
        )
        if sent:
            return ("Booking link texted to the guest's phone. Tell them to tap it to choose their "
                    "room and finish the booking, and ask if there's anything else.")
        if url:
            return ("I prepared the booking link but couldn't text it just now. Apologize briefly and "
                    "ask them to double-check their mobile number so you can try sending it again.")
        return ("I couldn't prepare the booking link — ask the guest to re-confirm the check-in and "
                "check-out dates so you can try again.")

    @function_tool()
    async def transfer_call(self, context: RunContext) -> str:
        """Use to transfer the caller to a live human."""
        # Transfer number comes from the dashboard (agent_settings.transfer_default_phone),
        # loaded at call start; env is only a fallback. The OUTBOUND SIP trunk (distinct
        # from the inbound trunk) comes from env so ops can set it without a deploy.
        target = self.transfer_phone or os.getenv("AGENT_TRANSFER_FALLBACK_PHONE")
        trunk = os.getenv("SIP_OUTBOUND_TRUNK_ID")
        if not target or not trunk:
            # Not provisioned yet — degrade gracefully, don't crash the call.
            self._record_tool("transfer_call", {}, "transfer not configured")
            return ("SAY (do NOT mention any technical reason): I'm sorry, I can't put you through "
                    "right now — let me take your details and have the front desk call you back.")
        if target == self.from_number:
            self._record_tool("transfer_call", {"target": target}, "same as caller — refused")
            return "SAY: I'm sorry, I can't transfer to that number. Is there anything else I can help with?"
        try:
            async with LiveKitAPI() as lk:
                await lk.sip.create_sip_participant(
                    CreateSIPParticipantRequest(
                        sip_trunk_id=trunk,
                        sip_call_to=target,
                        room_name=self.room_name,
                        participant_identity=f"transfer_{target}",
                        play_dialtone=True,
                    )
                )
            self.outcome_hint = "transferred_to_human"
            self._record_tool("transfer_call", {"target": target}, "dialing front desk")
            return "SAY: Connecting you to the front desk now — one moment."
        except Exception as exc:  # noqa: BLE001
            logger.warning("transfer_call failed: %s", exc)
            self._record_tool("transfer_call", {"target": target}, f"error: {exc}")
            return ("SAY (do NOT mention any technical reason): I'm sorry, I couldn't connect you just "
                    "now — let me have the front desk call you back.")


# -----------------------------------------------------------------------------
# Entrypoint — mirrors the WORKING Convrse agent exactly.
# -----------------------------------------------------------------------------
server = AgentServer()


@server.rtc_session()
async def molo_session(ctx: agents.JobContext):
    await ctx.connect()
    participant = await ctx.wait_for_participant()

    caller_phone = participant.attributes.get("sip.phoneNumber", "")

    # Preload the default general KB so general questions work before the guest
    # is identified (guarded — a DB hiccup must never block the greeting).
    try:
        default_kb = db.get_default_general_kb()
    except Exception as exc:  # noqa: BLE001
        logger.warning("default KB load failed: %s", exc)
        default_kb = ""

    # Front-desk transfer number is configured by staff in the dashboard
    # (agent_settings.transfer_default_phone). Loaded once at call start (guarded).
    try:
        transfer_phone = (db.get_agent_settings() or {}).get("transfer_default_phone")
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent_settings load failed: %s", exc)
        transfer_phone = None

    # NOTE: the general KB is intentionally NOT appended to the system prompt — it
    # bloated time-to-first-token and pulled the model toward Polish. It's loaded
    # into the agent's kb_content below and served only via search_kb.
    # Give the live model the current LOCAL (Poland) date & time so it can reason
    # about relative dates the caller uses ("tonight", "tomorrow", "next Monday").
    # Injected fresh per call so it's always accurate.
    _now_local = _now_warsaw()
    instructions = INSTRUCTIONS + (
        "\n\n# Current date & time\n\n"
        f"Right now in Sopot, Poland it is {_now_local.strftime('%A, %d %B %Y, %H:%M')} "
        f"local time (today's date is {_now_local.date().isoformat()}). Always use THIS "
        "as \"now\" when the caller refers to relative dates like \"tonight\", \"today\", "
        "\"tomorrow\", or \"next Monday\"."
    )

    session = AgentSession(
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        # NOTE: these interruption knobs are INERT with a native-audio realtime
        # model — turn-taking/barge-in is governed by Gemini's own server-side VAD
        # (realtime_input_config below). Kept for parity with the Convrse agent;
        # tuning them here has no effect.
        min_interruption_words=10,
        min_interruption_duration=0.8,
        false_interruption_timeout=2.0,
        resume_false_interruption=True,
        llm=google.realtime.RealtimeModel(
            model="gemini-live-2.5-flash-native-audio",
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
            voice="Kore",
            temperature=0.5,
            # Matches the Convrse reference agent: empty config = Gemini's default
            # server-side VAD (no custom start/end sensitivity or silence window).
            realtime_input_config=types.RealtimeInputConfig(),
        ),
    )

    # Initial call_logs row (insert_call_log is internally guarded — returns None
    # on any error, so a logging hiccup never blocks the call).
    call_id = db.insert_call_log({
        "started_at": _now_iso(),
        "direction": "inbound",
        "from_number": caller_phone or None,
        "mode": "unknown",
        "tool_calls": [],
    })

    agent = MoloAgent(instructions=instructions, default_kb_content=default_kb,
                      from_number=caller_phone, call_id=call_id, room_name=ctx.room.name,
                      transfer_phone=transfer_phone)

    # Capture the full ordered transcript for the call_logs summary, so a wrong
    # answer can be reviewed against what was actually asked.
    transcript_log: list[str] = []

    @session.on("conversation_item_added")
    def _on_item(ev):
        try:
            item = ev.item
            role = getattr(item, "role", "?")
            text = getattr(item, "text_content", None) or getattr(item, "text", "") or ""
            if text:
                transcript_log.append(f"{role}: {text}")
        except Exception:  # noqa: BLE001
            pass

    call_start = time.time()

    await session.start(
        room=ctx.room,
        agent=agent,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVCTelephony(),
            ),
        ),
    )

    # Background "thinking" sound, started BEFORE the greeting (Convrse order).
    background_audio = BackgroundAudioPlayer(
        thinking_sound=[
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.4, probability=0.7),
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=0.3, probability=0.3),
        ],
    )
    await background_audio.start(room=ctx.room, agent_session=session)

    # ── Start the conversation ──────────────────────────────
    await session.generate_reply(instructions=GREETING)

    # ── Wait for the call to end (disconnect / dead air / max duration) ──────
    disconnect_event = asyncio.Event()
    end_reason = "caller_hangup"

    @ctx.room.on("participant_disconnected")
    def on_participant_left(p: rtc.RemoteParticipant):
        nonlocal end_reason
        if p.identity == participant.identity:
            logger.info("Caller %s disconnected", caller_phone)
            end_reason = "caller_hangup"
            disconnect_event.set()

    async def call_monitor():
        nonlocal end_reason
        last_activity = time.time()
        checkin_sent = False

        def _reset_activity():
            nonlocal last_activity, checkin_sent
            last_activity = time.time()
            checkin_sent = False

        @session.on("user_input_transcribed")
        def on_user_input(*args, **kwargs):
            _reset_activity()

        @session.on("agent_speech_started")
        def on_agent_speech_start(*args, **kwargs):
            _reset_activity()

        while not disconnect_event.is_set():
            await asyncio.sleep(2)

            if time.time() - call_start >= MAX_CALL_DURATION:
                end_reason = "max_duration"
                try:
                    await session.generate_reply(
                        instructions="We've been on the call for a while now. Warmly wrap up — it was great chatting, and they can always call back. Say goodbye."
                    )
                    await asyncio.sleep(4)
                except Exception:  # noqa: BLE001
                    pass
                disconnect_event.set()
                break

            silence_duration = time.time() - last_activity

            if silence_duration >= DEAD_AIR_HANGUP:
                end_reason = "dead_air"
                try:
                    await session.generate_reply(
                        instructions="The caller hasn't responded. Say goodbye warmly and let them know they can call back anytime."
                    )
                    await asyncio.sleep(4)
                except Exception:  # noqa: BLE001
                    pass
                disconnect_event.set()
                break

            if silence_duration >= DEAD_AIR_CHECKIN and not checkin_sent:
                checkin_sent = True
                try:
                    await session.generate_reply(
                        instructions="The line has been quiet. Briefly check if the caller is still there — say something like 'Hello, are you still there?'"
                    )
                except Exception:  # noqa: BLE001
                    pass

    monitor_task = asyncio.create_task(call_monitor())
    try:
        await disconnect_event.wait()
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

    call_duration = int(time.time() - call_start)
    logger.info("Call ended: duration=%ss caller=%s reason=%s", call_duration, caller_phone, end_reason)

    # Persist the call for review (transcript + tool trace incl. which KB answered).
    if call_id:
        transcript = "\n".join(transcript_log) if transcript_log else None
        if agent.outcome_hint:
            outcome = agent.outcome_hint
        elif not agent.tool_calls and end_reason in ("dead_air", "caller_hangup"):
            outcome = "abandoned"
        else:
            outcome = "other"
        try:
            db.update_call_log(call_id, {
                "ended_at": _now_iso(),
                "duration_seconds": call_duration,
                "summary": (transcript or "")[:4000] or None,
                "tool_calls": agent.tool_calls,
                "mode": agent.mode,
                "outcome": outcome,
                "property_id": agent.property_id,
                "room_number": agent.room_number,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("update_call_log failed: %s", exc)

    # If we ended the call ourselves, remove the SIP participant and disconnect.
    if end_reason != "caller_hangup":
        try:
            from livekit.protocol.room import RoomParticipantIdentity
            async with LiveKitAPI() as lk:
                await lk.room.remove_participant(
                    RoomParticipantIdentity(room=ctx.room.name, identity=participant.identity)
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to remove SIP participant: %s", e)
        try:
            await ctx.room.disconnect()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    agents.cli.run_app(server)
