# Molo Residence Voice Agent

A Python LiveKit + Gemini Live voice agent for the **Molo Residence** hotel group
(Sopot, Poland). Guests call a phone number, connect to a LiveKit Cloud room over
SIP, and talk to a bilingual (English / Polish) Gemini Live agent that can:

- look up a reservation by booking number (KWHotel PMS),
- answer questions from the knowledge base,
- raise a maintenance ticket,
- send a booking link to a prospective guest,
- transfer the call to a human.

## How this relates to the Convrse agent

This is a **separate agent** from `../whole/convrseVoiceAgent`. It **reuses the
same LiveKit Cloud project and credentials** (same subdomain, but a new agent id
in `livekit.toml`), and the same Vertex AI / Gemini setup.

The big difference: Convrse talks to a multi-tenant backend through **Supabase
Edge Functions**. **Molo has no edge functions** — this agent writes to the Molo
Supabase database **directly** with the **service-role key**. It runs server-side
only, so using the service-role key is safe (never ship it to a browser).

## Project layout

```
molo-voice-agent/
├── pyproject.toml          # deps (livekit-agents, gemini plugin, supabase-py, httpx, ...)
├── livekit.toml            # LiveKit Cloud project + Molo agent id
├── .env.example            # env var NAMES (no secrets)
├── README.md
└── src/
    ├── agent.py            # main entrypoint: session lifecycle + tools
    ├── molo_supabase.py    # data-access layer over the Molo schema (service role)
    └── kwhotel.py          # KWHotel PMS reservation lookups (httpx)
```

## Setup

```bash
# with uv (recommended)
uv sync

# or with pip
pip install -e .

cp .env.example .env        # then fill in real values
```

### Environment variables

See `.env.example` for the full list with comments. Summary:

- **LiveKit** — `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  (reuse the Convrse LiveKit Cloud project).
- **Supabase (Molo project)** — `SUPABASE_URL`
  (`https://sejbqspfwsgxuaevjwcf.supabase.co`), `SUPABASE_SERVICE_ROLE_KEY`.
- **Vertex AI / Gemini** — `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and
  either `GOOGLE_APPLICATION_CREDENTIALS` (file path) or `GOOGLE_CREDENTIALS_B64`
  (base64 service-account JSON for cloud deploys).
- **KWHotel** — `KWHOTEL_API_BASE`, `KWHOTEL_USER`, `KWHOTEL_PASSWORD`,
  `KWHOTEL_API_KEY`, `KWHOTEL_HOTEL_ID` (default; per-property
  `properties.kwhotel_hotel_id` overrides it).
- **Transfers** — `AGENT_TRANSFER_FALLBACK_PHONE`, `SIP_TRUNK_ID` (Telnyx trunk).

## Run locally

```bash
# dev (hot-reload-ish worker)
python src/agent.py dev

# or production worker
python src/agent.py start
```

The agent registers with LiveKit Cloud as agent id `CA_MoloResidence` and waits
for SIP calls dispatched to it.

## Call lifecycle

1. SIP call arrives. The agent reads `sip.trunkPhoneNumber` (→ `to_did`) and
   `sip.phoneNumber` (→ `from_number`) from the participant attributes.
2. An initial `call_logs` row is inserted (`started_at`, `direction='inbound'`,
   `from_number`, `to_did`, `tool_calls=[]`); its id is kept for the whole call.
3. Instructions are built from `agent_settings.system_prompt_main` +
   `greeting_text` (with sensible Molo defaults), and the default general KB is
   preloaded.
4. A Gemini Live `AgentSession` runs with Silero VAD, multilingual turn
   detection, and telephony noise cancellation. Tools: `reservation_lookup`,
   `search_kb`, `raise_maintenance_ticket`, `send_booking_link`, `transfer_call`.
   Each tool appends a `{name, args, result, latency_ms}` entry to an in-memory
   trace.
5. On call end (hangup / dead air / 7-min cap) the agent computes duration,
   estimates `cost_usd` from `agent_settings.cost_per_min_usd`
   (telnyx + livekit_cloud + gemini_live), derives a summary / outcome /
   sentiment best-effort, and patches the `call_logs` row.

Every DB/API call is guarded — a failure logs and continues; it never crashes a
live call.

## Not yet testable here

This project is structured to be runnable but needs live infrastructure that
isn't available in this environment:

- **Vertex AI credentials** — a real GCP service account with the Gemini Live
  model enabled (`GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CREDENTIALS_B64`).
- **Telnyx SIP trunk + phone number** — a Telnyx trunk wired into LiveKit Cloud
  (`SIP_TRUNK_ID`) and a DID routed to this agent, so inbound calls dispatch to
  `CA_MoloResidence` and outbound transfers can dial out.
- **KWHotel endpoint confirmation** — the exact reservation endpoint/paths and
  auth scheme must be confirmed against
  `https://cloud.kwhotel.com/kwhotel/swagger`. `src/kwhotel.py` has a clearly
  marked `# TODO` with a best-guess request shape and degrades gracefully (returns
  `None`) until confirmed.
- **Molo Supabase** — a reachable Molo project with the schema + seed applied and
  a valid service-role key.

### Phone-number / dispatch registration (LiveKit Cloud)

1. Create (or reuse) the Telnyx SIP trunk and import it into LiveKit Cloud; note
   the trunk id → `SIP_TRUNK_ID`.
2. Create an **inbound dispatch rule** that routes the Molo DID to a room and
   dispatches agent id `CA_MoloResidence`.
3. Deploy this agent (`python src/agent.py start`, or the Docker/host of your
   choice) so a worker is registered under that agent id.
4. Call the DID — the agent answers, logs the call, and runs the tools above.
```
