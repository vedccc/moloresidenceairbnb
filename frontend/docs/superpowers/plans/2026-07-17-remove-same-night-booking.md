# Remove the Same-Night Booking Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the same-night (late-night) booking flow from both repos so the normal Profitroom booking flow stands exactly as it did before the variant was added.

**Architecture:** This is a **deletion, not a revert**. The same-night variant was added *alongside* the normal flow, never in place of it — so removing the same-night branch restores the normal flow by construction. A `git revert` of the same-night commits is forbidden: they are interleaved with the Telnyx SMS migration (`62ab41d`, `27d6307`) and the Poland date/time injection (`28cd41d`), which serve the normal flow and must survive. Removal is therefore surgical, using `28cd41d` (the last commit before same-night work began) as the reference state.

**Tech Stack:** Python 3 / LiveKit Agents (molo-voice-agent), Next.js static export + Hono on Deno (molo-dashboard), Supabase Postgres.

## Global Constraints

- **Two separate git repos.** `molo-voice-agent` and `molo-dashboard` each have their own `.git`. Never stage across them. Each task commits in exactly one repo.
- **Reference state:** `28cd41d` in `molo-voice-agent` — the last commit before same-night work started.
- **Never touch (spec guardrails):**
  - `src/sms.py` — Telnyx transport + E.164. It post-dates `28cd41d`; if it ever matches the reference, that is a regression.
  - `src/booking_link.py` — the Profitroom link builder. **The normal flow.** Unmodified since `26255f5`; must stay byte-identical.
  - the `send_booking_link` tool in `agent.py` — the normal flow's entry point.
  - `suggest_available_rooms` / `availability_offer` / `find_available_rooms` — **shared by both flows; explicitly confirmed by the requester as must-keep.**
  - the `_now_warsaw()` function body and the prompt's date/time injection — the normal flow needs them for relative dates.
  - `supabase/migrations/20260702000000_same_night_bookings.sql` — left byte-untouched; applied migrations are not edited.
  - the `same_night_bookings` table — retained by decision (drop is irreversible; project is paused).
- **Deliberate deviation from byte-exactness:** `28cd41d` already contained two *forward-looking* references to the same-night flow (in the `_now_warsaw()` docstring and the date-injection comment). Restoring them byte-exactly would reintroduce comments promising a feature now permanently cancelled. Task 2 restores `28cd41d` **minus those two clauses**. This is intentional and must not be "corrected" back.
- **Verification is static only.** The Supabase project is INACTIVE (paused); no live DB or live call can be exercised. Do not claim runtime verification.
- **No test covers the booking flow.** The agent repo's only test is `tests/test_search_kb_dedup.py`. Do not claim the deletion is covered by tests.

## File Structure

**molo-voice-agent** (all modifications, no new files):
| File | Responsibility after change |
|---|---|
| `src/agent.py` | Prompt + tools. Loses the same-night prompt section, the `book_same_night` tool, and the `NOW_OVERRIDE` hook. Keeps `send_booking_link`, `suggest_available_rooms`, `_now_warsaw()`. |
| `src/molo_supabase.py` | DB access. Loses `create_same_night_booking()`. Keeps `create_booking_link()` and call-log writers. |
| `src/kwhotel.py` | KWHotel API client. Loses `create_reservation()` and its exclusive helpers. Keeps reads (`_get`, availability, lookup). |

**molo-dashboard**:
| File | Responsibility after change |
|---|---|
| `src/app/book/page.tsx` | **Deleted.** |
| `supabase/functions/api/routes/public-booking.ts` | **Deleted.** |
| `supabase/functions/api/index.ts` | Router. Loses the `/public/booking` mount. |
| `src/lib/auth-context.tsx` | Auth redirect. Loses the `/book` bypass. |
| `docs/ARCHITECTURE-DIAGRAMS.md` | Loses diagram #10, the `same_night_bookings` entity, and the `/book` + `/public/booking` nodes. |
| `CLAUDE.md` | Gains a note that `same_night_bookings` is retained-but-orphaned. |

**Removal discipline for a deletion task (the TDD analogue):** there is no new behavior to test, so each task uses **baseline-grep → remove → confirm-grep**: prove the symbol exists, delete it, prove it is gone and nothing dangles. Treat a non-empty confirm-grep exactly as you would a failing test.

---

### Task 1: Remove the same-night prompt section and the `book_same_night` tool

**Files:**
- Modify: `molo-voice-agent/src/agent.py` (prompt section ~L152-163; `book_same_night` tool ~L603-670)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `agent.py` with no `book_same_night` symbol. Task 3 removes its only callee (`db.create_same_night_booking`); this task must land first so that callee is already unreferenced.

- [ ] **Step 1: Baseline — prove the symbols exist**

Run from `molo-voice-agent/`:
```bash
grep -c "book_same_night\|Same-night booking" src/agent.py
```
Expected: a non-zero count (currently `9`). If this is `0`, stop — you are on the wrong revision.

- [ ] **Step 2: Delete the same-night prompt section**

In `src/agent.py`, find this text and delete the blank line plus the entire `### Same-night booking` block, leaving item 9 immediately followed by the closing `"""`.

Replace this:
```
9. When they're ready to book, you can exclusively send them a customized booking link where they can fill in their details like name and payment information. Use `send_booking_link` to send the link.

### Same-night booking (a bed for the night already in progress, in the small hours)
Use the current local date & time (given at the very end of this prompt).
1. WHEN this applies: the caller wants a place to stay RIGHT NOW and the current local time is roughly between MIDNIGHT and 6am. At that hour the night they need already started YESTERDAY — so it is check-in = YESTERDAY's date, check-out = TODAY's date. (Example: it's 2am on 2 July → check-in = 1 July, check-out = 2 July.)
2. CONFIRM first, in one sentence: "Just to confirm — you'd like a room for the night from [yesterday's date] to [today's date], starting right now?" Only continue if they say yes.
3. "TODAY" CONFUSION — important: in those small hours a caller who says they want to book "today" might mean either the night in progress OR later today. Clarify: "Our earliest check-in is 3pm — would you like to check in at 3pm today, or do you need a place to stay right now?"
   - "right now" → same-night: check-in = yesterday, check-out = today. Continue below.
   - "3pm today" or any future date → this is a NORMAL booking: use the normal Booking flow with `send_booking_link`. Do NOT use same-night.
4. Once same-night is confirmed: ask how many adults and children, then call `suggest_available_rooms` with check_in = yesterday's date and check_out = today's date.
5. If rooms are available, call `book_same_night` with those same dates and party size. It texts the caller a link to pick a room and book directly — you do NOT take payment, a name, or choose the room yourself. Tell them to tap the link, pick a room, and enter their email; they'll get a text with check-in instructions.
6. If nothing is available, apologise briefly and let them know we're fully booked for tonight.
7. For ANY other request (a future date, or a normal daytime booking), use the normal Booking flow with `send_booking_link` — never same-night.
"""
```

With this:
```
9. When they're ready to book, you can exclusively send them a customized booking link where they can fill in their details like name and payment information. Use `send_booking_link` to send the link.
"""
```

This exactly reproduces the `28cd41d` prompt ending (verified: at `28cd41d`, item 9 is immediately followed by `"""`).

- [ ] **Step 3: Delete the `book_same_night` tool**

In `src/agent.py`, delete the whole decorated method — from the `@function_tool()` line above `async def book_same_night(` through the final `return` of that method, stopping immediately before the `@function_tool()` that precedes `async def transfer_call`.

Delete this entire block:
```python
    @function_tool()
    async def book_same_night(
        self,
        context: RunContext,
        check_in: Annotated[str, Field(
            description="Check-in date YYYY-MM-DD. For a same-night booking this is "
            "YESTERDAY's date (the night already in progress)."
        )],
        check_out: Annotated[str, Field(
            description="Check-out date YYYY-MM-DD. For a same-night booking this is TODAY's date."
        )],
        num_adults: Annotated[int, Field(description="The confirmed number of adults.")],
        num_children: Annotated[int, Field(description="The confirmed number of children.")],
    ) -> str:
        """Use ONLY for a same-night booking — the caller wants to stay the night that
        is already in progress (they're calling after midnight). Texts the caller a link
        where they pick a room and it is booked directly; no payment or room choice is
        needed on the call. For any future/normal date use send_booking_link instead."""
        # Guard: same-night is only for a check-in that is in the PAST (the in-progress
        # night). A today/future check-in is bookable normally via Profitroom.
        try:
            ci = datetime.fromisoformat(check_in).date()
            if ci >= _now_warsaw().date():
                return ("NOT a same-night booking — this date is bookable normally. Do NOT tell the "
                        "caller you've sent anything yet. Call `send_booking_link` NOW with these "
                        "same dates and party size; only AFTER it returns do you tell them the link "
                        "is on its way.")
        except Exception:  # noqa: BLE001
            pass

        hotel_id = (self.property or {}).get("kwhotel_hotel_id") or os.getenv("KWHOTEL_HOTEL_ID")
        session = db.create_same_night_booking(
            phone=self.from_number or "", check_in=check_in, check_out=check_out,
            num_adults=num_adults, num_children=num_children,
            hotel_id=hotel_id, property_id=self.property_id, call_id=self.call_id,
        )
        if not session or not session.get("token"):
            self._record_tool("book_same_night",
                              {"check_in": check_in, "check_out": check_out}, "session create failed")
            return ("I couldn't set up the same-night booking just now. Apologize briefly and ask "
                    "them to try again in a moment.")

        base = (os.getenv("BOOKING_UI_BASE") or "https://moloresidence.onrender.com").rstrip("/")
        from urllib.parse import urlencode
        # token is the auth/lookup key; the dates + party ride along as params so the
        # UI URL is self-descriptive and can render the stay + prefill before it
        # fetches the full option list from the edge by token.
        url = f"{base}/book?" + urlencode({
            "token": session["token"],
            "checkin": check_in,
            "checkout": check_out,
            "adults": num_adults,
            "children": num_children,
        })
        sent = sms.send_sms(self.from_number, f"Molo Residence — pick your room for tonight and "
                            f"book: {url}") if self.from_number else False

        self.mode = "booking"
        self.outcome_hint = "same_night_link_sent"
        self._record_tool("book_same_night", {"check_in": check_in, "check_out": check_out,
                          "num_adults": num_adults, "num_children": num_children},
                          {"token": session["token"], "sms_sent": sent, "url": url})
        if sent:
            return ("Same-night booking link texted to the guest. Tell them to tap it, pick a room, "
                    "and enter their email — it'll be booked for tonight and they'll get a text with "
                    "check-in instructions. Then ask if there's anything else.")
        return ("I set up the booking but couldn't text the link just now. Apologize briefly and ask "
                "them to double-check their mobile number so you can try again.")

```

The result must read: the `send_booking_link` method's final `return` line, one blank line, then `    @function_tool()` / `    async def transfer_call(self, context: RunContext) -> str:`.

This also removes the only assignment of `self.outcome_hint = "same_night_link_sent"` and the only use of the `BOOKING_UI_BASE` env var and the local `from urllib.parse import urlencode`. No module-level import becomes unused (`sms`, `db`, `os`, `datetime` all remain used elsewhere — verified by grep).

- [ ] **Step 4: Confirm the symbols are gone and nothing dangles**

Run from `molo-voice-agent/`:
```bash
grep -n "book_same_night\|Same-night booking\|same_night_link_sent\|BOOKING_UI_BASE\|urlencode" src/agent.py
```
Expected: **no output** (exit 1).

```bash
grep -n "suggest_available_rooms\|send_booking_link" src/agent.py | head
```
Expected: still present — these are must-keep. If either is missing, you have deleted too much; revert and redo.

- [ ] **Step 5: Verify the file still parses**

```bash
python -m py_compile src/agent.py && echo OK
```
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
cd molo-voice-agent
git add src/agent.py
git commit -m "agent: remove same-night booking prompt section + book_same_night tool

KWHotel doesn't expose the endpoints the flow needed, so it's withdrawn.
The normal Profitroom flow (send_booking_link) is untouched and becomes
the only booking path again.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Restore `_now_warsaw()` and the date-injection comment to the reference state

**Files:**
- Modify: `molo-voice-agent/src/agent.py` (`_now_warsaw()` ~L49-75; date-injection comment ~L741-744)

**Interfaces:**
- Consumes: Task 1's `agent.py` (the `book_same_night` caller of `_now_warsaw()` is already gone, so the only remaining caller is the prompt injection).
- Produces: `_now_warsaw()` with no `NOW_OVERRIDE` branch, still returning `datetime`. The prompt injection at `_now_local = _now_warsaw()` keeps working unchanged.

**Why this task exists separately:** it carries the one deliberate deviation from byte-exactness (see Global Constraints), so a reviewer may want to accept Task 1 while debating this.

- [ ] **Step 1: Baseline — prove the hook exists**

```bash
grep -c "NOW_OVERRIDE" src/agent.py
```
Expected: `3`. If `0`, stop.

- [ ] **Step 2: Replace `_now_warsaw()`**

Replace this entire function:
```python
def _now_warsaw() -> datetime:
    """Current LOCAL time in Poland (Sopot), handling CET/CEST automatically.

    The live model has no clock otherwise; it needs local time to reason about
    "tonight"/"tomorrow" and the same-night-after-midnight booking case.

    TESTING: set NOW_OVERRIDE to an ISO datetime (e.g. "2026-07-02T02:00") to pin
    "now" to a fixed time, so the same-night flow can be exercised at any hour
    instead of only after real midnight. Leave it UNSET in production."""
    override = os.getenv("NOW_OVERRIDE")
    if override:
        try:
            dt = datetime.fromisoformat(override)
            if dt.tzinfo is None:
                try:
                    from zoneinfo import ZoneInfo
                    dt = dt.replace(tzinfo=ZoneInfo("Europe/Warsaw"))
                except Exception:  # noqa: BLE001
                    dt = dt.replace(tzinfo=timezone(timedelta(hours=2)))
            return dt
        except Exception:  # noqa: BLE001 — malformed override, fall through to real time
            pass
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw"))
    except Exception:  # noqa: BLE001 — no tz database available
        return datetime.now(timezone(timedelta(hours=2)))
```

With this — the `28cd41d` version, restoring its `tzdata` explanation, minus the now-stale same-night clause:
```python
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
```

`timedelta` and `timezone` remain used by the fallback, so the module-level `from datetime import datetime, timedelta, timezone` stays as-is.

- [ ] **Step 3: Update the date-injection comment**

Replace this comment:
```python
    # Give the live model the current LOCAL (Poland) date & time so it can reason
    # about relative dates the caller uses ("tonight", "tomorrow", "next Monday")
    # and — later — recognise the same-night-after-midnight booking case. Injected
    # fresh per call so it's always accurate.
```

With this:
```python
    # Give the live model the current LOCAL (Poland) date & time so it can reason
    # about relative dates the caller uses ("tonight", "tomorrow", "next Monday").
    # Injected fresh per call so it's always accurate.
```

Leave the `_now_local = _now_warsaw()` line and the `instructions = INSTRUCTIONS + (...)` block below it completely unchanged.

- [ ] **Step 4: Confirm**

```bash
grep -n "NOW_OVERRIDE\|same-night\|same_night" src/agent.py
```
Expected: **no output** (exit 1). `agent.py` is now fully clean of same-night.

```bash
python -m py_compile src/agent.py && echo OK
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd molo-voice-agent
git add src/agent.py
git commit -m "agent: drop NOW_OVERRIDE test hook, restore _now_warsaw docstring

Restores the 28cd41d version (incl. its tzdata fallback note), minus the
forward-reference to the same-night case that is now cancelled for good.
The date/time injection itself stays — the normal flow needs it for
relative dates like 'tonight'/'tomorrow'.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Remove `create_same_night_booking()` from the Supabase client

**Files:**
- Modify: `molo-voice-agent/src/molo_supabase.py` (~L359-396)

**Interfaces:**
- Consumes: Task 1 removed the only caller (`db.create_same_night_booking` in `book_same_night`).
- Produces: `molo_supabase.py` with no `same_night_bookings` reference. `create_booking_link()` (normal flow) is untouched.

- [ ] **Step 1: Baseline — prove no caller remains**

```bash
grep -rn "create_same_night_booking" src/
```
Expected: exactly one hit — the definition in `src/molo_supabase.py`. If `src/agent.py` still appears, Task 1 is incomplete; finish it first.

- [ ] **Step 2: Delete the function**

In `src/molo_supabase.py`, delete this entire function plus the two blank lines separating it from `create_booking_link` above:
```python
def create_same_night_booking(
    phone: str,
    check_in: str,
    check_out: str,
    num_adults: int = 1,
    num_children: int = 0,
    hotel_id: Optional[str] = None,
    property_id: Optional[str] = None,
    call_id: Optional[str] = None,
    ttl_hours: int = 6,
) -> Optional[dict[str, Any]]:
    """Create a same-night direct-booking session; return its row (incl. `token`).

    The token backs the public `/book?token=...` UI where the guest picks a room +
    email, which triggers a direct KWHotel reservation. Returns None on failure."""
    import secrets
    from datetime import datetime, timedelta, timezone
    payload = {
        "token": secrets.token_urlsafe(24),
        "phone": phone or None,
        "hotel_id": str(hotel_id) if hotel_id else None,
        "property_id": property_id,
        "check_in": check_in,
        "check_out": check_out,
        "num_adults": int(num_adults or 1),
        "num_children": int(num_children or 0),
        "status": "pending",
        "call_id": call_id,
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=ttl_hours)).isoformat(),
    }
    try:
        sb = get_client()
        res = sb.table("same_night_bookings").insert(payload).execute()
        if res.data:
            return res.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("create_same_night_booking failed: %s", exc)
    return None
```

The result must read: `create_booking_link`'s closing `return None`, two blank lines, then the `# ---` `# Call logs` comment banner.

`secrets` and the `datetime` names were function-local imports, so no module-level import cleanup is needed.

- [ ] **Step 3: Confirm**

```bash
grep -n "same_night\|create_same_night_booking" src/molo_supabase.py
```
Expected: **no output** (exit 1).

```bash
grep -n "create_booking_link" src/molo_supabase.py | head -1
```
Expected: still present (normal flow must-keep).

```bash
python -m py_compile src/molo_supabase.py && echo OK
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd molo-voice-agent
git add src/molo_supabase.py
git commit -m "supabase: remove create_same_night_booking()

Last writer to same_night_bookings. The table itself is retained by
decision (drop is irreversible; the project is paused), but nothing
writes to it now.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Remove the dead KWHotel `create_reservation()` scaffold

**Files:**
- Modify: `molo-voice-agent/src/kwhotel.py` (`_kiosk_base` ~L50-52; `_post` ~L86-101; the `⚠️` comment banner + `_iso_dt` + `create_reservation` ~L104-171)

**Interfaces:**
- Consumes: nothing. `create_reservation` has **zero callers** anywhere in `src/` (verified by grep) — it was always a scaffold.
- Produces: `kwhotel.py` exposing reads only. `_get`, `_root`, `_base`, `_headers`, `_resolve_hotel` all stay.

**Why:** KWHotel cannot support this flow. Leaving the scaffold advertises a capability the vendor does not have and invites someone to wire it up again.

- [ ] **Step 1: Baseline — prove it exists and has no callers**

```bash
grep -rn "create_reservation" src/
```
Expected: exactly one hit — `src/kwhotel.py:125:async def create_reservation(`.

```bash
grep -n "_post(\|_kiosk_base(\|_iso_dt(" src/kwhotel.py
```
Expected: 5 hits, all inside the region being deleted (the `_post`/`_kiosk_base`/`_iso_dt` definitions plus their uses at the `body`/`return` lines of `create_reservation`). This proves the three helpers are exclusive to it.

- [ ] **Step 2: Delete `_kiosk_base()`**

Remove:
```python
def _kiosk_base(hotel_id: int | str) -> str:
    # kiosk API — reservation CREATE lives here, not under integrations
    return f"{_root()}/api/kiosk/hotels/{hotel_id}"


```
Leave `_root()`, `_base()`, `_headers()`, `_resolve_hotel()` and `_get()` untouched.

- [ ] **Step 3: Delete `_post()`, the `⚠️` banner, `_iso_dt()` and `create_reservation()`**

Delete everything from the `async def _post(` line through the `return await _post(...)` line that ends `create_reservation`, stopping immediately before the `# ---` `# Normalization + fuzzy room matching` banner. That is one contiguous region: `_post` (L86-101), the `Reservation CREATION` comment block (L104-119), `_iso_dt` (L120-122), and `create_reservation` (L125-171).

The result must read: `_get()`'s final `return None`, two blank lines, then:
```python
# -----------------------------------------------------------------------------
# Normalization + fuzzy room matching
# -----------------------------------------------------------------------------
def _norm(text: Optional[str]) -> str:
```

- [ ] **Step 4: Confirm**

```bash
grep -n "create_reservation\|_kiosk_base\|_iso_dt\|_post(\|kiosk" src/kwhotel.py
```
Expected: **no output** (exit 1).

```bash
grep -c "async def _get\|def _headers\|async def availability_offer\|async def lookup_reservation" src/kwhotel.py
```
Expected: `4` — the read path is intact.

```bash
python -m py_compile src/kwhotel.py && echo OK
```
Expected: `OK`

`httpx` stays imported (still used by `_get`); `Any`/`Optional` stay used throughout.

- [ ] **Step 5: Commit**

```bash
cd molo-voice-agent
git add src/kwhotel.py
git commit -m "kwhotel: remove dead create_reservation() scaffold

Never had a caller. KWHotel doesn't expose a usable create path for the
same-night flow, so the scaffold only advertised a capability that isn't
there. Takes its exclusive helpers (_post, _kiosk_base, _iso_dt) with it;
the read path (_get, availability, lookup) is untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Prove the normal booking flow matches the reference state

**Files:**
- Read-only verification. No files modified, no commit.

**Interfaces:**
- Consumes: Tasks 1-4 complete.
- Produces: evidence for the requester's acceptance bar ("see the normal booking flow works fine").

**This task is the acceptance gate.** If any check fails, fix it in the owning task before proceeding.

- [ ] **Step 1: `booking_link.py` must be byte-identical to the reference**

```bash
cd molo-voice-agent
git diff 28cd41d -- src/booking_link.py
```
Expected: **empty output.** This file has not changed since `26255f5`; any diff means something was touched that must not have been.

- [ ] **Step 2: The Booking prompt must match the reference**

```bash
git show 28cd41d:src/agent.py | sed -n '/^### Step 2 - Booking/,/^"""/p' > /tmp/ref_booking.txt
sed -n '/^### Step 2 - Booking/,/^"""/p' src/agent.py > /tmp/now_booking.txt
diff /tmp/ref_booking.txt /tmp/now_booking.txt && echo "IDENTICAL"
```
Expected: `IDENTICAL`. The normal booking prompt is provably back to its pre-same-night text.

- [ ] **Step 3: `sms.py` must NOT match the reference**

```bash
git diff --quiet 28cd41d -- src/sms.py && echo "REGRESSION — Telnyx work was reverted" || echo "OK — Telnyx retained"
```
Expected: `OK — Telnyx retained`. This check is inverted on purpose: `sms.py` post-dates the reference, and matching it would mean the Telnyx/E.164 migration was destroyed.

- [ ] **Step 4: Run the test suite**

```bash
python -m pytest tests/ -v
```
Expected: `tests/test_search_kb_dedup.py` passes. Note honestly: **no test covers the booking flow**, so this proves only that nothing unrelated broke — it is not evidence the booking flow works.

- [ ] **Step 5: Read the assembled prompt end to end**

Print the system prompt and read the Booking section in full:
```bash
python -c "import sys; sys.path.insert(0,'src'); import agent; print(agent.INSTRUCTIONS)"
```
Confirm by eye:
- The Booking section flows Step 1 → Step 2 → item 9 → end, with no dangling reference to same-night, "right now", the midnight/6am gate, or `book_same_night`.
- `send_booking_link` and `suggest_available_rooms` are still described.
- No orphaned heading or numbering gap where the section was.

This is the one check that rests on judgment rather than a command — a deleted prompt section cannot break Python, but it can leave the instructions reading oddly.

---

### Task 6: Remove the dashboard `/book` UI and public booking routes

**Files:**
- Delete: `molo-dashboard/src/app/book/page.tsx`
- Delete: `molo-dashboard/supabase/functions/api/routes/public-booking.ts`
- Modify: `molo-dashboard/supabase/functions/api/index.ts` (import ~L12; mount ~L41)
- Modify: `molo-dashboard/src/lib/auth-context.tsx` (~L50)

**Interfaces:**
- Consumes: Task 1 removed the agent code that minted `/book` links, so nothing produces new tokens by this point.
- Produces: an edge `api` with no public booking surface. `/auth/login` remains the only public JSON route besides `/health`.

**Note:** this is all one commit at HEAD (`9d8891a`), but do **not** `git revert` it — that would also delete the migration file we are keeping and restore a stray `supabase/.temp/cli-latest`.

- [ ] **Step 1: Baseline**

```bash
cd molo-dashboard
ls src/app/book/page.tsx supabase/functions/api/routes/public-booking.ts
```
Expected: both paths listed.

- [ ] **Step 2: Delete the two files**

```bash
git rm src/app/book/page.tsx
git rm supabase/functions/api/routes/public-booking.ts
```

- [ ] **Step 3: Unmount the route in `index.ts`**

Remove this import line:
```typescript
import { buildPublicBookingRoutes } from './routes/public-booking.ts';
```

Then replace this:
```typescript
// Public: login + same-night booking (token-authenticated, no JWT). Everything
// else requires a valid bearer token.
app.route('/auth', buildAuthRoutes());
app.route('/public/booking', buildPublicBookingRoutes());
app.use('/properties/*', requireAuth);
```

With this:
```typescript
// Public: login only. Everything else requires a valid bearer token.
app.route('/auth', buildAuthRoutes());
app.use('/properties/*', requireAuth);
```

- [ ] **Step 4: Remove the `/book` auth bypass in `auth-context.tsx`**

Replace this:
```typescript
    if (!loading && !user && pathname !== '/login' && !pathname.startsWith('/book')) {
```

With this:
```typescript
    if (!loading && !user && pathname !== '/login') {
```

This restores the pre-`9d8891a` redirect condition exactly.

- [ ] **Step 5: Confirm**

```bash
grep -rn "public-booking\|public/booking\|buildPublicBookingRoutes\|startsWith('/book')" src/ supabase/functions/ 2>/dev/null
```
Expected: **no output** (exit 1).

- [ ] **Step 6: Run tests and build**

```bash
npm test
```
Expected: all pass. No test references the removed routes.

```bash
npm run build
```
Expected: build succeeds and emits `out/`. Confirm no `/book` route is emitted:
```bash
ls out/book 2>/dev/null && echo "FAIL — /book still emitted" || echo "OK — /book gone"
```
Expected: `OK — /book gone`

- [ ] **Step 7: Commit**

```bash
cd molo-dashboard
git add -A src/app supabase/functions/api src/lib/auth-context.tsx
git commit -m "web+api: remove the public /book UI and same-night booking routes

KWHotel can't support the flow, so the token-authenticated public booking
surface goes. /auth/login is once again the only public JSON route.

Removed surgically rather than reverting 9d8891a, so the
same_night_bookings migration file survives (the table is retained by
decision).

Any /book link already SMSed to a guest will now 404 — impact is nil, the
KWHotel call behind it was a stub that never completed a booking.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Update the docs

**Files:**
- Modify: `molo-dashboard/docs/ARCHITECTURE-DIAGRAMS.md`
- Modify: `molo-dashboard/CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1-6 — the docs must describe the post-removal system.
- Produces: documentation with no same-night flow, plus a recorded rationale for the orphaned table.

- [ ] **Step 1: Remove diagram #10 from `ARCHITECTURE-DIAGRAMS.md`**

Delete the entire `## 10. Same-night direct-booking flow (public /book)` section — its heading, the ```mermaid sequenceDiagram block, and the trailing "Status lifecycle: `pending → selected → booked`…" line.

- [ ] **Step 2: Remove `same_night_bookings` from the ERD (diagram #2)**

Delete these two relationship lines:
```
    properties ||..o{ same_night_bookings : "logical link (no FK)"
    call_logs ||..o{ same_night_bookings : "logical link (no FK)"
```

And delete this entity block:
```
    same_night_bookings {
        uuid id PK
        text token UK
        text status "pending|selected|booked|expired"
    }
```

- [ ] **Step 3: Remove the `/book` node from the route map (diagram #6)**

Delete this line:
```
    book["/book?token=… · public (guest)"]
```

And change this:
```
    classDef pubc fill:#e7f9ed,stroke:#2f9e57,color:#000
    class login,book pubc
```

To this:
```
    classDef pubc fill:#e7f9ed,stroke:#2f9e57,color:#000
    class login pubc
```

- [ ] **Step 4: Remove `/public/booking` from the API route map (diagram #5)**

Delete this line:
```
    root --> pub["/public/booking/:token · public<br/>(token IS the credential)"]
```

And change this:
```
    class health,auth,pub pubc
```

To this:
```
    class health,auth pubc
```

- [ ] **Step 5: Record the orphaned table in `CLAUDE.md`**

In the `### Database Schema (Supabase)` section, immediately after the paragraph listing the tables, add:

```markdown
`same_night_bookings` is a **retained orphan**: the same-night booking flow it backed was removed on 2026-07-17 (KWHotel doesn't expose the endpoints it needed — see `docs/superpowers/specs/2026-07-17-remove-same-night-booking-design.md`). Nothing reads or writes it. The table and its migration are kept deliberately — dropping is irreversible, and the Supabase project was paused when the flow was withdrawn, so its contents were never verified. Do not build on it.
```

- [ ] **Step 6: Confirm**

```bash
cd molo-dashboard
grep -n "same.night\|same_night\|/book" docs/ARCHITECTURE-DIAGRAMS.md
```
Expected: **no output** (exit 1).

```bash
grep -c "same_night_bookings" CLAUDE.md
```
Expected: `1` — the new orphan note.

- [ ] **Step 7: Commit**

```bash
cd molo-dashboard
git add docs/ARCHITECTURE-DIAGRAMS.md CLAUDE.md
git commit -m "docs: drop same-night flow from diagrams, note the orphaned table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Final cross-repo dangler sweep

**Files:**
- Read-only verification. No commit.

**Interfaces:**
- Consumes: Tasks 1-7 complete.
- Produces: the final report to the requester.

- [ ] **Step 1: Sweep the voice agent**

```bash
cd molo-voice-agent
grep -rn "same_night\|book_same_night\|create_reservation\|NOW_OVERRIDE\|BOOKING_UI_BASE" src/ tests/
```
Expected: **no output** (exit 1).

- [ ] **Step 2: Sweep the dashboard**

```bash
cd molo-dashboard
grep -rn "same_night\|public/booking\|public-booking" src/ supabase/functions/ docs/ARCHITECTURE-DIAGRAMS.md
```
Expected: **no output** (exit 1).

- [ ] **Step 3: Confirm the intentional survivors**

```bash
cd molo-dashboard
grep -rln "same_night" supabase/migrations/ CLAUDE.md docs/superpowers/
```
Expected: exactly these — and nothing else:
- `supabase/migrations/20260702000000_same_night_bookings.sql` (retained table)
- `CLAUDE.md` (the orphan note)
- `docs/superpowers/specs/2026-07-17-remove-same-night-booking-design.md` (this change's spec)
- `docs/superpowers/plans/2026-07-17-remove-same-night-booking.md` (this plan)
- possibly older specs/plans under `docs/superpowers/` — historical records; **do not edit them**.

- [ ] **Step 4: Confirm the guardrails survived**

```bash
cd molo-voice-agent
grep -c "def send_sms" src/sms.py                    # expect 1 — Telnyx intact
grep -c "def build_profitroom_url" src/booking_link.py  # expect 1 — normal flow intact
grep -c "suggest_available_rooms" src/agent.py       # expect >=1 — must-keep tool intact
```
Expected: `1`, `1`, and a non-zero count respectively.

- [ ] **Step 5: Report**

Report to the requester:
- The normal flow is provably unchanged: `booking_link.py` byte-identical to `28cd41d`, Booking prompt identical, `suggest_available_rooms` and `send_booking_link` intact.
- Telnyx SMS and the date/time injection survived.
- **Not verified at runtime** — the Supabase project is paused and no test covers the booking flow. State this plainly; do not imply the flow was exercised.
- Live `/book` links now 404 (nil impact — the flow never completed a booking).
- `same_night_bookings` remains in the DB, orphaned by design.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

| Spec requirement | Task |
|---|---|
| `agent.py`: same-night prompt section | 1 |
| `agent.py`: `book_same_night` tool | 1 |
| `agent.py`: `same_night_link_sent` outcome hint | 1 (Step 3 — removed with the tool body) |
| `agent.py`: `NOW_OVERRIDE` hook, keep `_now_warsaw()` | 2 |
| `molo_supabase.create_same_night_booking()` | 3 |
| `kwhotel.create_reservation()` + `_post`/`_kiosk_base`/`_iso_dt` | 4 |
| dashboard: `book/page.tsx`, `public-booking.ts`, `index.ts`, `auth-context.tsx` | 6 |
| `ARCHITECTURE-DIAGRAMS.md` | 7 |
| `CLAUDE.md` orphan note | 7 |
| Verify normal flow vs `28cd41d` | 5 |
| `sms.py` must NOT match reference | 5 (Step 3, inverted check) |
| Dangler sweep | 8 |
| Keep table + migration untouched | Global Constraints; asserted in 8 Step 3 |
| Keep `suggest_available_rooms` (requester's explicit instruction) | Global Constraints; asserted in 1 Step 4 and 8 Step 4 |

No gaps.

**2. Placeholder scan** — no TBD/TODO/"handle edge cases"/"similar to Task N". Every code-changing step shows the exact text to remove and the exact result. Every command has expected output.

**3. Type consistency** — no new types or signatures are introduced; this plan only deletes. `_now_warsaw() -> datetime` keeps its signature across Tasks 1, 2 and 5. Symbol names used in the confirm-greps (`book_same_night`, `create_same_night_booking`, `create_reservation`, `_kiosk_base`, `_iso_dt`, `_post`, `NOW_OVERRIDE`, `BOOKING_UI_BASE`, `buildPublicBookingRoutes`) each match their definition sites exactly as read from the source.

**Ordering constraint:** Task 1 must precede Task 3 (it removes `create_same_night_booking`'s only caller) and Task 2 (it removes one of `_now_warsaw()`'s two callers). Tasks 4, 6, 7 are independent. Task 5 gates on 1-4; Task 8 gates on all.
