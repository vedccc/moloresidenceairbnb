# Remove the same-night (late-night) booking flow

**Date:** 2026-07-17
**Status:** Approved, ready for implementation plan
**Repos:** `molo-voice-agent` (bulk), `molo-dashboard`

## Why

KWHotel does not expose the endpoints the same-night flow depends on. Confirmed on the 2026-07-02 call and recorded in `kwhotel.py`: the create/patch reservation endpoint carries **no check-in/check-out dates** — only `bill`, `rooms[{id, guests}]`, `payment`, `assignToRooms`. A reservation could be created with a room assignment but no stay duration, requiring staff to set dates manually in the PMS. That makes direct same-night booking unworkable, so the flow is being withdrawn rather than finished.

The flow never left Phase 1: `createKwhotelReservation` in the dashboard and `create_reservation` in the agent are both unwired stubs that return "not wired yet". No guest has ever been booked through it.

## Key finding: this is a deletion, not a revert

The request was framed as "revert to the normal booking flow exactly as it was before the late-night variant". Investigation shows **there is nothing to restore**:

- The same-night variant was **added alongside** the normal flow, never in place of it.
- `src/booking_link.py` — the Profitroom deep-link builder behind `send_booking_link` — is **unmodified since the initial commit** (`26255f5`).
- The normal flow (collect dates + party → `suggest_available_rooms` → present options → `send_booking_link` → SMS a Profitroom link) is intact and untouched.

Therefore: deleting the same-night branch *is* the revert. The normal flow stands as it always did.

### A commit-range revert would be a regression

The same-night commits are interleaved with unrelated work that must survive. `git revert` across the range would destroy it.

Commit order, oldest → newest:

| Commit | Subject | Action |
|---|---|---|
| `26255f5` | Initial commit | keep |
| `28cd41d` | inject current Poland local date/time into the prompt | **keep** — powers "tonight"/"tomorrow" relative dates in the *normal* flow |
| `5a689c7` | kwhotel: `create_reservation()` scaffold | remove |
| `011bdbd` | agent: same-night flow — detection, tool, session | remove |
| `82ca6fb` | agent: refine same-night prompt + `NOW_OVERRIDE` | remove |
| `f0e7c5e` | kwhotel: DATED reservation schema | remove |
| `62ab41d` | sms: replace SMSAPI with Telnyx | **keep** — normal flow SMSes the Profitroom link too |
| `27d6307` | sms: normalize recipient to E.164 | **keep** — same reason |
| `6666e75` | agent: same-night link carries dates + party | remove |
| `65881ea` | agent: `book_same_night` reject message directive | remove |
| `e760c90` | kwhotel: `create_reservation` targets kiosk path | remove |

`28cd41d` is the last commit before the same-night work began — it is the reference state for the normal flow.

## Scope decision

**Code + scaffold removed; `same_night_bookings` table retained.**

The dead KWHotel scaffold goes because it advertises a capability KWHotel provably does not have — leaving it invites someone to try wiring it up again. The table stays because dropping it is irreversible, nothing will write to it once the code is gone, and the Supabase project is currently **paused (INACTIVE)**, so its contents cannot be verified before a drop.

## Removal surface

### molo-voice-agent

- `src/agent.py`
  - the `### Same-night booking …` prompt section (~L153–163)
  - the `book_same_night` tool (~L604–670)
  - the `same_night_link_sent` outcome hint
  - the `NOW_OVERRIDE` test hook inside `_now_warsaw()` (~L53–58) — keep `_now_warsaw()` itself
- `src/molo_supabase.py` — `create_same_night_booking()` (~L359–395)
- `src/kwhotel.py` — `create_reservation()` and its exclusive helpers `_post()`, `_kiosk_base()`, `_iso_dt()`

`_post`, `_kiosk_base` and `_iso_dt` are each used only by `create_reservation` (verified by grep); all four are removed together. `create_reservation` has zero callers.

### molo-dashboard

All of this is one commit at HEAD (`9d8891a`, 6 files), but is removed surgically rather than reverted so the migration file survives.

- delete `src/app/book/page.tsx`
- delete `supabase/functions/api/routes/public-booking.ts` (includes its `createKwhotelReservation` stub and `STUB_OPTIONS`)
- `supabase/functions/api/index.ts` — drop the `buildPublicBookingRoutes` import and the `/public/booking` mount
- `src/lib/auth-context.tsx` — drop the `/book` bypass, restoring the redirect condition to `pathname !== '/login'`
- `docs/ARCHITECTURE-DIAGRAMS.md` — remove diagram #10 (same-night flow), the `same_night_bookings` entity from the ERD, the `/book` node from the route map, and the `/public/booking` node from the API map
- `CLAUDE.md` — note that `same_night_bookings` is a retained-but-orphaned table with no writers

## What stays

Explicit guardrails — none of these may be touched:

- `src/sms.py` (Telnyx transport, E.164 normalization)
- `src/booking_link.py` and the `send_booking_link` tool — **the normal flow**
- `suggest_available_rooms` / `availability_offer` / `find_available_rooms` — shared by both flows
- `_now_warsaw()` core and the prompt's local date/time injection — the normal flow needs it for relative dates
- the `same_night_bookings` table and its migration file `20260702000000_same_night_bookings.sql` (left byte-untouched; applied migrations are not edited)

## Verification / acceptance

Acceptance bar, per the requester: **the normal booking flow still works.**

1. **Prove the normal flow matches its pre-same-night state.** Diff against `28cd41d`, scoped to booking-flow regions only:
   - `src/booking_link.py` must be **byte-identical** (it never changed).
   - The Step 2 Booking prompt section and the `send_booking_link` tool must be identical modulo the removal of same-night cross-references.
   - Scoped deliberately: `src/sms.py` must **not** match `28cd41d` — Telnyx landed afterward and matching would mean a regression.
2. **Static checks.** `pytest` (agent) and `npm test` (dashboard). No existing test references any same-night symbol, so nothing should break — and equally, nothing covers the deletion. This is stated plainly rather than presented as passing coverage.
3. **Dangler sweep.** Grep both repos for `same_night`, `book_same_night`, `create_reservation`, `NOW_OVERRIDE`, `public/booking`, `/book` — expect hits only in the retained migration file, historical specs/plans, and git history.
4. **Prompt coherence.** Read the assembled system prompt end to end and confirm the Booking section reads as a single unbroken flow with no orphaned references to same-night, "right now", or the midnight/6am time gate.
5. **Build.** `npm run build` (dashboard) must emit `out/` without the `/book` route.

## Risks and open items

- **The Supabase project is paused (INACTIVE).** Nothing here can be exercised against a live database or a live call. Verification is static only. Any runtime confirmation must happen after the project is resumed.
- **Live `/book` links will 404.** Any same-night link already SMSed to a guest breaks. Impact is nil in practice: the KWHotel call behind it was a stub that never completed a booking, so those links could not have produced a reservation.
- **The migration may never have been applied.** The migration file records that it was authored while the DB was unreachable. Whether `same_night_bookings` exists in the live database is unknown and unresolvable while the project is paused. This does not block the change — the retain-the-table decision is correct either way.
- **No automated test covers the normal booking flow**, so "it still works" rests on the diff-against-`28cd41d` proof plus prompt review, not on a green test. Adding coverage is out of scope here.

## Out of scope

- Dropping `same_night_bookings` (deliberately retained).
- Any change to Telnyx/SMS, Profitroom link construction, availability lookup, or the KB system.
- Adding test coverage for the normal booking flow.
- Resuming the Supabase project.
