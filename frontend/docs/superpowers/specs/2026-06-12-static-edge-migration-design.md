# Design: Molo Dashboard → Static Frontend + Supabase Edge API

**Date:** 2026-06-12
**Status:** Approved (design), pending implementation plan
**Author:** Liam (via Claude Code)

## Problem

The dashboard runs as a Render **free-tier web service**. Free web services spin
down after ~15 min of inactivity, so the next visit shows Render's branded
"application is starting" interstitial for ~30–60s before the UI loads. The
requirement: **the dashboard must open instantly, at $0 hosting cost.**

On Render, the only free option that never cold-starts is a **static site** (CDN
files). But the current app is server-rendered end-to-end (Server Components +
Server Actions + the Supabase **service-role** key + `iron-session` middleware),
so it cannot simply be exported to static without losing auth, all mutations, and
database security.

**Decision:** convert to a **static frontend** (Render free `static_site`) backed
by a **Supabase Edge Function** that holds all secrets and does all DB work. Cost
stays $0; the loading-screen interstitial disappears.

## Hard constraints

- **$0 hosting.** Frontend on Render free `static_site`; backend on Supabase Edge
  Functions (free tier). No paid Render instance.
- **No secret in the browser.** The static bundle must contain **zero** secrets —
  no `SUPABASE_SERVICE_ROLE_KEY`, no bcrypt, no JWT signing secret. Anything in a
  static bundle is world-readable.
- **Browser never touches Postgres directly.** All DB access flows through the
  edge function. RLS therefore stays **off** (as it is today) — the only client of
  Postgres is the trusted edge function using the service-role key.

## Decisions locked during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | Frontend: Render free `static_site`. Backend: Supabase Edge Functions | $0, no cold-start interstitial |
| Backend shape | **Single** edge function `api` with an internal **Hono** router | One deploy unit; auth + CORS middleware defined once |
| Data access | Everything through the edge function (service-role); RLS stays off | Browser never speaks to Postgres; coherent with custom auth |
| Frontend data layer | Static export + **TanStack Query** (already a dependency, currently unused) | Adopt the stack as intended; caching + loading states for free |
| Session | Signed **JWT** in `Authorization: Bearer` header (not a cookie) | Static site (`*.onrender.com`) and functions (`*.supabase.co`) are different domains; a header token avoids `SameSite=None` + credentialed-CORS complexity |
| Auth | **Real** auth — `users` table + bcrypt in the edge function | Staff dashboard with real guest/maintenance/call data on a public CDN URL; demo-mode login (any creds) is unacceptable there. (Currently the code is in demo mode; this restores the pre-demo real-auth behavior.) |

## Scope amendment — 2026-06-12 (module pruning + single user)

Confirmed during planning. These reduce the migration surface:

- **Removed entirely** (pages + `src/backend/*.ts` modules + sidebar nav; never ported to the edge function): `settings/agent` (`agent-settings`), `settings/cost-rates` (`cost-rates`), `settings/feature-flags` (`feature-flags`). The voice agent's prompt/greeting/transfer-phone is managed in the separate `molo-voice-agent` service, not here.
- **Kept** under settings: `settings/urgency-rules` and `users`.
- **Single-user system:** the `users` table holds **exactly one** row. The `users` page collapses to a **single-account profile editor** (change display name + password) — no create / list / deactivate. The edge API exposes `GET /me` + `PATCH /me` instead of a `/users` collection. Authentication (bcrypt login) is still required for that one user.

### Amendment 2 — 2026-06-16 (from client meeting; folded into Slice 2)

- **Remove Booking Links too.** Delete the `/booking-links` page + nav (and the `/booking-links` link in calls detail). The `booking_links` DB table stays (external system writes it); only the dashboard UI goes. So the removed set is now: agent-settings, cost-rates, feature-flags, **booking-links**.
- **General Knowledge Base section (UX reframe, no schema change).** Replace the confusing per-KB *"Set as default/general"* button/toggle with a first-class **"General Knowledge Base"** section on the KB list page (top), above the room-specific KBs. It shows/edits the single `is_default_general = true` KB (create one there if none). The per-row toggle and the editor's "Set as general" toggle are removed; the editor hides the room-assignment panel when editing the general KB. **Section-only** model (no "promote an existing KB"). Backed entirely by the existing `is_default_general` flag + unique partial index. Detailed in plan `docs/superpowers/plans/2026-06-16-static-edge-migration-slice2.md`.

## Architecture

```
Browser  (static files served from Render CDN, https://<app>.onrender.com)
   │   fetch() + header: Authorization: Bearer <jwt>
   ▼
Supabase Edge Function "api"  (Deno + Hono, https://<ref>.functions.supabase.co/api)
   │   holds SERVICE_ROLE_KEY, bcrypt, JWT signing secret
   │   middleware: CORS (allow Render origin) + auth (verify JWT) on every non-login route
   ▼
Supabase Postgres  (RLS OFF — only the edge function connects, via service-role)
```

The static bundle is a "dumb" client. **All** privilege (secrets, hashing, DB
writes, identity) lives in the edge function.

## Component 1 — Auth & session

**Login** — `POST /auth/login { username, password }`:
1. Edge fn `SELECT`s the user from `users` by username (service-role client).
2. `bcrypt.compare(password, user.password_hash)` — Deno-compatible bcrypt.
3. Reject if no match or the account is deactivated (`is_active = false`).
4. On success, sign a **JWT (HS256)** with `{ userId, displayName }` and a short
   expiry (e.g. 12h); secret = `SESSION_SECRET` from edge env.
5. Return `{ token, user: { displayName } }`.

**Session carriage** — browser stores the token in memory + `localStorage` (so a
page reload stays logged in) and attaches `Authorization: Bearer <token>` to every
request.

**Authorization gate** — Hono auth middleware on every route except `/auth/login`:
verify signature + expiry; on failure return **401**. This is the *real* security
boundary. Client-side route guards are **UX only** (anyone can load the static JS;
they get nothing without a valid token).

**Logout** — client drops the token; no server state to clear.

## Component 2 — The `api` edge function

One Hono app. Middleware order: CORS → (login is public) → auth → route groups.
Route groups mirror the existing 9 `src/backend/*.ts` modules; the query logic is
**relocated** from the Server Actions into edge routes, not rewritten.

| Resource | Routes |
|---|---|
| `properties` (+ rooms) | `GET /properties`, `POST /properties`, `PATCH /properties/:id`, `DELETE /properties/:id` |
| `knowledge-bases` (+ rooms, default-general) | `GET /knowledge-bases`, `GET /knowledge-bases/:id`, `POST`, `PATCH /:id`, `DELETE /:id` |
| `maintenance` | `GET /maintenance`, `GET /maintenance/:id`, `PATCH /maintenance/:id` (status) |
| `calls` (read-only) | `GET /calls`, `GET /calls/:id` |
| `booking-links` | `GET /booking-links`, `POST /booking-links`, `POST /booking-links/:id/track` |
| `me` (single account) | `GET /me`, `PATCH /me` (display name + password) |
| `urgency-rules` | `GET /urgency-rules`, `PATCH /urgency-rules/reorder` |
| dashboard metrics | `GET /metrics` (aggregate for home page) |

*Removed (not ported): `agent-settings`, `cost-rates`, `feature-flags` — see Scope amendment above.*

The exact request/response shapes are derived 1:1 from the current
`src/backend/*.ts` functions during implementation.

## Component 3 — Frontend conversion

- `next.config.ts`: add `output: 'export'` (keep existing `images.unoptimized`).
- **Delete `middleware.ts`** (can't run on a static host). Replace with a
  lightweight client auth-guard in the dashboard layout: no token → redirect to
  `/login`; a `401` from the API → drop token + redirect to `/login`.
- Each remaining page (**12** after deleting the 3 removed settings pages):
  inline server `createServerClient()` reads become **TanStack Query `useQuery`**
  hooks against the `api` function; Server Action calls become **`useMutation`** →
  POST/PATCH/DELETE to the api.
- Add a small typed **`apiClient`** wrapper: base URL from `NEXT_PUBLIC_API_URL`,
  attaches the bearer token, centralizes error/401 handling.
- **Remove from the bundle**: `src/backend/supabase.ts` (service-role client) and
  the `'use server'` modules — their logic moves into the edge function. Verify no
  client import path can pull a secret into the static output.

Routing note: detail pages already use query-param routes
(`/knowledge-bases/detail?id=…`, `/calls/detail`, `/maintenance/detail`), not
dynamic `[id]` segments, so static export needs **no** `generateStaticParams`.

## Component 4 — Deployment & environment

**Backend (Supabase):**
- `supabase functions deploy api`.
- Secrets via `supabase secrets set`: `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`.
- CORS: allow the Render static origin.

**Frontend (Render `static_site`):**
- Build command `npm run build` (emits `out/`), publish directory `out/`.
- Public env: `NEXT_PUBLIC_API_URL` = the edge function URL. **No secret ships.**
- Reuse the existing broken `MoloResidence` static_site or create a fresh one.

**Cutover:** once the static site is verified end-to-end, **delete the Render web
service `molo-dashboard`**.

## Migration sequencing (incremental, not big-bang)

1. **Slice 1 (proving ground):** stand up `api` with `auth/login` + the
   **properties** resource end-to-end. Convert the login page + properties page to
   static/client. Deploy a throwaway static build. Verify the *entire path* works
   against the deployed function: login → list → create → update → delete, with
   CORS + bearer token. This de-risks every later resource.
2. **Replicate:** apply the proven pattern to the other 8 modules + read-only
   views (calls, dashboard metrics), one resource at a time.
3. **Cutover:** point the real Render `static_site` at the verified build, confirm,
   then delete the `molo-dashboard` web service.

## Risks & caveats

- **Free Supabase project pause** after long inactivity stalls the API until
  resumed. *Pre-existing* — the current app uses the same project — not a new risk.
- **JWT in `localStorage`** is XSS-exposed. Acceptable for an internal staff tool;
  mitigated by short expiry. Cookie-based sessions are the more secure alternative
  but add cross-domain (`SameSite=None` + credentialed CORS) complexity; revisit if
  requirements change.
- **No SSR fallback:** data views show a brief client loading state instead of
  arriving pre-rendered. This is the intended trade for instant CDN open.
- **Two deploy targets** (Render static + Supabase function) instead of one. The
  incremental sequencing keeps each verifiable in isolation.

## Out of scope

- Changing the database schema.
- Migrating to Supabase Auth (custom auth is retained).
- Any change to the separate `molo-voice-agent` service.
- Cookie-based sessions (documented as an alternative, not chosen).
