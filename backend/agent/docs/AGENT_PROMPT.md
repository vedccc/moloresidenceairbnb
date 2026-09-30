# Molo Residence — Voice Agent Prompt & Tool Reference

**Agent:** Mili — AI phone concierge for Molo Residence (hotels & apartments, Sopot, Poland)
**Source of truth:** `molo-voice-agent/src/agent.py` (+ `kb_search.py`)
**Regenerated:** 2026-06-18 — reflects the current deployed prompt: search-KB-first + no-hallucination rule, no-follow-up policy, identify-on-NO_KB_MATCH, the post-identify "answer in one turn" fix, `search_kb` per-call memoization, and Convrse-default Gemini VAD.

> This document is generated from the live code. The prompt, greeting, tool
> descriptions, and parameter descriptions below are **verbatim** from `agent.py`.
> If you edit the code, regenerate this doc.

---

## 1. Models

### Live conversation — speech-to-speech
| Setting | Value |
|---|---|
| Model | `gemini-live-2.5-flash-native-audio` (Gemini Live, native audio) |
| Provider | Vertex AI (`vertexai=True`) |
| Project | `GOOGLE_CLOUD_PROJECT` (env) — currently `convrse-ai` |
| Region | `GOOGLE_CLOUD_LOCATION` (env) — currently `europe-central2` |
| Voice | `Kore` |
| Temperature | `0.5` |
| Turn detection | Governed by **Gemini's own server-side VAD**. The LiveKit `vad` (Silero), `turn_detection` (`MultilingualModel`), and `min_interruption_*` / `false_interruption_*` knobs are **inert** with a native-audio model (kept for Convrse parity). |
| Gemini VAD | `realtime_input_config = RealtimeInputConfig()` — **empty = Gemini defaults** (no custom start/end sensitivity or silence window). Matches the Convrse reference agent. |
| Noise cancellation | `BVCTelephony()` |

### Knowledge-base answering — text (the `search_kb` tool)
A **separate** Gemini text call, grounded only on the loaded KB text. Not the live model.

| Setting | Value |
|---|---|
| Model | `gemini-2.5-flash` (env `KB_SEARCH_MODEL`) |
| Temperature | `0.0` (deterministic / extractive) |
| Max output tokens | `300` |
| Timeout | `10s` (env `KB_SEARCH_TIMEOUT_S`) — on timeout/error, falls back to naive keyword search so a hiccup never strands the caller |
| Not-found sentinel | model emits `NOT_FOUND` → returned to the agent as `NO_KB_MATCH` |

---

## 2. Greeting

The greeting is **not** in the system prompt — it's spoken via `session.generate_reply(instructions=GREETING)` at call start, after the background "thinking" audio starts.

```
Greet UNMISTAKABLY IN ENGLISH (switch to Polish only if the caller speaks
Polish). Warmly welcome the caller to Molo Residence, introduce yourself as
Mili, and ask whether they're already staying with us or looking to book.
Keep it to one short, natural sentence.
```

---

## 3. System Prompt (`INSTRUCTIONS`) — verbatim

```
# You don't know anything or can't help with anything except for what's defined in the prompt and the tool calls.

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
```

---

## 4. Tools

Each tool's **description** is its function docstring; each **parameter description** comes from `Annotated[..., Field(description=...)]`. Both are sent to Gemini.

### `identify_guest`
> **Description:** "Use to find details about the guest's reservation; use after the guest has confirmed their room number (and address if asked)."

| Parameter | Type | Description |
|---|---|---|
| `room_number` | str | "The confirmed room number of the guest." |
| `address` | str | "The confirmed address of the guest. Write \"null\" if the guest hasn't mentioned it." |

**Behavior:** looks up the room across all properties. One match → loads that room's KB (two-part merge, below) and **clears the per-call `search_kb` memo** so the next search hits the room KB. Multiple matches → asks the guest which **address** they're at and expects a re-call with `address`. No match → asks the guest to re-check the number. On a single match the tool's reply instructs the agent **not** to speak a standalone location sentence before its next tool call (that gets cut off) — it goes straight to answering and folds "you're at X" into the spoken answer.

### `search_kb`
> **Description:** "Use to answer all questions for new and existing guests."

| Parameter | Type | Description |
|---|---|---|
| `question` | str | "The question the caller asked." |

**Behavior:** answers from the currently-loaded KB via the `gemini-2.5-flash` text call; falls back to naive keyword search on error/timeout; returns `NO_KB_MATCH` when the loaded KB doesn't cover it.
- **Per-call memoization:** identical questions reuse the prior answer (busted whenever the KB swaps on `identify_guest`) so an interrupted-and-retried turn doesn't pay for a second Gemini lookup. No TTL.
- **Identify-on-miss nudge:** when the result is `NO_KB_MATCH` **and** the guest isn't identified yet, the tool response itself instructs the agent to ask for the room number, call `identify_guest`, and search again (rather than give up) — the answer is likely room-specific.

### `raise_maintenance_ticket`
> **Description:** "Use to raise a maintenance ticket."

| Parameter | Type | Description |
|---|---|---|
| `description` | str | "A detailed description of the issue the caller is facing." |

**Behavior:** requires the guest to be identified first (needs `property_id` + `room_number`). Creates a ticket (urgency auto-classified) and confirms; on failure, degrades gracefully **without** promising a follow-up.

### `suggest_available_rooms`
> **Description:** "Use to check for availability after collecting and confirming the dates and guest amount."

| Parameter | Type | Description |
|---|---|---|
| `check_in` | str | "The confirmed check-in date in the format YYYY-MM-DD." |
| `check_out` | str | "The confirmed check-out date in the format YYYY-MM-DD." |
| `num_adults` | int | "The confirmed number of adults." |
| `num_children` | int | "The confirmed number of children." |

**Behavior:** queries KWHotel availability. Returns a ready-to-speak `SAY:` sentence for each outcome (`available` / `partial` / `full` / `invalid`), including alternative start dates. The agent is told to read it nearly verbatim and never reason about availability itself.

### `send_booking_link`
> **Description:** "Sends a customized booking link."

| Parameter | Type | Description |
|---|---|---|
| `check_in` | str | "The confirmed check-in date in the format YYYY-MM-DD." |
| `check_out` | str | "The confirmed check-out date in the format YYYY-MM-DD." |
| `num_adults` | int | "The confirmed number of adults." |
| `num_children` | int | "The confirmed number of children." |

**Behavior:** builds a Profitroom deep link (dates + party size prefilled), logs a `booking_links` row, and texts the link to the caller's number via SMS. On SMS/build failure it asks the guest to re-confirm details so it can retry — never promises a follow-up.

### `transfer_call`
> **Description:** "Use to transfer the caller to a live human."

*(no parameters)*

**Behavior:** dials the front-desk number (`agent_settings.transfer_default_phone` from the dashboard; env fallback `AGENT_TRANSFER_FALLBACK_PHONE`) over the **outbound** SIP trunk (`SIP_OUTBOUND_TRUNK_ID`). Refuses to dial the caller's own number; degrades gracefully without leaking technical reasons.

---

## 5. Knowledge-base loading (two-part, no cache)

**No persistent cache** — every KB read hits Supabase fresh, so dashboard edits take effect on the **next call** (Redis was removed 2026-06-17). The only in-memory cache is the per-call `search_kb` answer memo, which is cleared whenever the KB swaps.

1. **At call start:** the default general KB (`is_default_general = true`) is fetched and loaded as the agent's `kb_content`. This answers questions for prospective guests and unidentified callers.
2. **After `identify_guest`:** `kb_content` is **replaced** (not appended) with a fresh two-part merge from `kb_for_room(property_id, room_number)`:

```
### ROOM-SPECIFIC INFO (overrides the general info below)
<room's KB — priority >= 3>

---

### GENERAL PROPERTY INFO
<property KB + general KB>
```

- **Both layers are available to answer from.** Room-only and general-only topics both answer.
- On a **conflict** (same value in both, e.g. Wi-Fi / door code), the room-specific value **wins** — `kb_search.py`'s system prompt keys off these exact section labels.
- Because the value is rebuilt every call, a guest correcting their room number **replaces** the room layer (no stacking of multiple rooms' data).

### `kb_search` system prompt — verbatim
```
You answer a hotel guest's spoken question using ONLY the knowledge base below.

Rules:
- Use ONLY information found in the knowledge base. Never invent or guess values you cannot see — prices, times, codes, Wi-Fi names/passwords, policies — and quote those values EXACTLY as written (don't change, round, or reformat them).
- If the knowledge base contains the relevant information, ANSWER the question with it (for example, a Wi-Fi question is answered with the network name and password). Only if the knowledge base clearly does not cover the question, reply with EXACTLY this token and nothing else: NOT_FOUND
- The knowledge base may have a "ROOM-SPECIFIC INFO" section and a "GENERAL PROPERTY INFO" section (separated by "---"). The ROOM-SPECIFIC section describes THIS guest's exact room and its values REPLACE the general ones. Whenever the room-specific section gives a value (Wi-Fi network/password, codes, policies, etc.), you MUST use that value and IGNORE any different value in the general/building section for the same thing. Use the general section only for things the room-specific section does not mention. Never mention that there were multiple sections.
- Answer in 1-3 short sentences, conversational and natural to read aloud (no markdown, no lists, no headings).
- Reply in the same language the guest used.
```

---

## 6. Call lifecycle guards

| Guard | Value | Behavior |
|---|---|---|
| Dead-air check-in | 25s | prompts "are you still there?" |
| Dead-air hangup | 40s | wraps up and ends the call |
| Max call duration | 7 min (420s) | warmly wraps up and ends |

The full ordered transcript is captured to the `call_logs` row for review (so a wrong answer can be checked against what was actually asked, plus which KB backed each `search_kb` call via `kb_source`).
