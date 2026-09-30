# Static + Edge Migration — Slice 2 (Remaining pages + go static) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Convert every remaining `force-dynamic` page to the edge API, remove Booking Links, reframe the general KB as a first-class "General Knowledge Base" section, collapse Users to a single-account `/me` profile, then delete the dead `src/backend/*` server layer and flip `output:'export'` back on so `next build` produces a deployable static site.

**Architecture:** Same as Slice 1 — static client frontend + single Supabase Edge Function `api` (Hono, service-role, JWT bearer). Slice 2 adds route groups to that one function and converts the remaining pages to TanStack Query against them. After every page is converted, the SSR-only `src/backend/*` modules are deleted and `output:'export'` is re-enabled.

**Tech Stack:** Deno + Hono edge function, jose/bcryptjs, Next.js static export, TanStack Query, Tiptap (KB editor stays), Vitest + Deno tests.

**Reference:** spec `docs/superpowers/specs/2026-06-12-static-edge-migration-design.md`; Slice 1 plan `docs/superpowers/plans/2026-06-12-static-edge-migration-slice1.md` (the **canonical pattern** every conversion follows).

---

## The canonical pattern (every resource follows this)

Slice 1 proved it on `properties`. For each resource:
1. **Edge route group** `supabase/functions/api/routes/<resource>.ts` — a Hono sub-app built by `build<Resource>Routes(makeClient = serviceClient)`, **porting the exact queries from `src/backend/<resource>.ts` 1:1** (same `.from(...).select(...)` shapes), with body-guards (`await c.req.json().catch(()=>null)` → 400) and generic error masking (`console.error` + `{error:'Request failed.'}`), exactly like `routes/properties.ts`. Mount it in `index.ts` behind `requireAuth` (except public ones). TDD with a Deno test using an injected fake client (mirror `routes/properties.test.ts`).
2. **Frontend wrapper** `src/lib/<resource>-api.ts` — typed functions over `apiFetch`, mirroring `src/lib/properties-api.ts`. TDD with Vitest mirroring `properties-api.test.ts`.
3. **Page conversion** — make the page `'use client'`, replace server reads with `useQuery`, replace Server Action calls with `useMutation` (+ `invalidateQueries`). Drop all `@/backend/*` value imports (type-only `import type` from `@/backend/types` is fine — it carries no secret). Mirror `properties/page.tsx`.

Edge route table to ADD (mount in `index.ts`, all behind `requireAuth`):

| Resource | Routes | Port from |
|---|---|---|
| knowledge-bases | `GET /knowledge-bases` (list incl. `is_default_general`, rooms), `GET /knowledge-bases/general`, `GET /knowledge-bases/:id` (detail bundle), `POST /knowledge-bases` (`?general=1` creates the general KB), `PATCH /knowledge-bases/:id` (name/content), `POST /knowledge-bases/:id/general` (set/unset), `PUT /knowledge-bases/:id/rooms` (replace assignments), `DELETE /knowledge-bases/:id/rooms` (one room from another KB), `DELETE /knowledge-bases/:id` | `src/backend/knowledge-bases.ts` |
| maintenance | `GET /maintenance`, `GET /maintenance/:id`, `PATCH /maintenance/:id` | `src/backend/maintenance.ts` |
| calls | `GET /calls`, `GET /calls/:id` (read-only) | `src/backend/*` + `calls/*` page reads |
| urgency-rules | `GET /urgency-rules`, `PUT /urgency-rules` (reorder/update) | `src/backend/urgency-rules.ts` |
| me | `GET /me`, `PATCH /me` (display_name + optional password→bcrypt) | `src/backend/users.ts` (single-user subset) |
| metrics | `GET /metrics` (dashboard home aggregate) | `(dashboard)/page.tsx` server reads |

---

## Task 1: Prune Booking Links

**Files:** delete `src/app/(dashboard)/booking-links/` (`page.tsx`, `booking-links-client.tsx`); edit `src/components/app-sidebar.tsx` (remove the `Booking Links` nav item, line ~35, and the now-unused `Link2` icon import if unused elsewhere); edit `src/app/(dashboard)/calls/detail/call-detail-client.tsx` (remove the `href="/booking-links"` link ~line 265 — render the booking entries as plain non-link cards instead).

- [ ] **Step 1:** `git rm -r "src/app/(dashboard)/booking-links"`
- [ ] **Step 2:** Remove the Booking Links nav entry + unused icon import in `app-sidebar.tsx`.
- [ ] **Step 3:** In `call-detail-client.tsx`, replace the `<Link href="/booking-links">…</Link>` wrapper around booking entries with a non-clickable element (keep the displayed info; drop the navigation). Confirm no other `/booking-links` references remain: `grep -rn "booking-links" src`.
- [ ] **Step 4:** `npx tsc --noEmit` → clean.
- [ ] **Step 5:** `git commit -m "chore: remove Booking Links page + nav"`

Note: the `booking_links` DB table stays (an external system writes it); only the dashboard UI is removed.

---

## Task 2: Edge routes — maintenance, calls, urgency-rules, metrics (TDD)

For EACH of `maintenance`, `calls`, `urgency-rules`, `metrics`: create `supabase/functions/api/routes/<r>.ts` + `<r>.test.ts` following the canonical pattern (template: `routes/properties.ts` + `.test.ts`). Read `src/backend/<r>.ts` (and the page's inline reads for `calls`/`metrics`) and port the queries verbatim. Mount each behind `requireAuth` in `index.ts`.

- [ ] **Step 1 (maintenance):** port `GET /maintenance` (list), `GET /maintenance/:id`, `PATCH /maintenance/:id` (status/fields) from `src/backend/maintenance.ts`. Deno test (fake client): list returns rows; patch returns `{ok}`; malformed body → 400. Run `cd supabase/functions/api && deno test --allow-env --allow-net routes/maintenance.test.ts` → pass. Commit `feat(api): maintenance routes`.
- [ ] **Step 2 (calls):** port read-only `GET /calls`, `GET /calls/:id` (mirror the `calls/page.tsx` + `calls/detail/page.tsx` server reads — transcript, recording, tool-trace fields). Deno test. Commit `feat(api): calls read routes`.
- [ ] **Step 3 (urgency-rules):** port `GET /urgency-rules` + `PUT /urgency-rules` (reorder/update the 4 tiers) from `src/backend/urgency-rules.ts`. Deno test. Commit `feat(api): urgency-rules routes`.
- [ ] **Step 4 (metrics):** add `GET /metrics` returning the dashboard-home aggregate (port the counts/recent-activity queries from `(dashboard)/page.tsx`). Deno test. Commit `feat(api): metrics route`.
- [ ] **Step 5:** mount all four behind `requireAuth` in `index.ts`; `deno check index.ts`; full `deno test` green. Commit `feat(api): mount maintenance/calls/urgency/metrics`.

---

## Task 3: Edge routes — `/me` single-user profile (TDD)

Single-user system: no list/create/deactivate. `GET /me` returns the authenticated user's `{id, username, display_name}` (from `c.get('user')` claims + a DB read for freshness); `PATCH /me` updates `display_name` and, if `password` is provided (≥8 chars), `bcrypt.hash`es it to `password_hash`. Port the relevant bits of `src/backend/users.ts` (`updateStaffUser`'s display-name + password-hash logic). The user id comes from the verified JWT (`c.get('user').userId`) — never from the request body.

**Files:** `supabase/functions/api/routes/me.ts` + `me.test.ts`.

- [ ] **Step 1:** Write Deno tests (fake client + a token in context): `GET /me` returns the user; `PATCH /me {display_name}` → `{ok}`; `PATCH /me {password:'short'}` → 400; `PATCH /me {password:'longenough'}` hashes (assert the update payload contains a `$2` hash, not the plaintext). Run → fail.
- [ ] **Step 2:** Implement `buildMeRoutes(makeClient)`; routes read `c.get('user').userId`. Mount `app.use('/me', requireAuth); app.route('/me', buildMeRoutes())` in `index.ts`.
- [ ] **Step 3:** `deno test` green; `deno check index.ts`. Commit `feat(api): single-user /me profile routes`.

---

## Task 4: Edge routes — knowledge-bases incl. General KB (TDD)

Port `src/backend/knowledge-bases.ts` 1:1 into `routes/knowledge-bases.ts`, plus a convenience for the General KB section:
- `GET /knowledge-bases` — list with `is_default_general` + `knowledge_base_rooms(room_number)` (mirror `knowledge-bases/page.tsx` query).
- `GET /knowledge-bases/general` — the single row where `is_default_general = true` (or `null`).
- `GET /knowledge-bases/:id` — the detail bundle from `getKbDetailData` (kb + properties + propRooms + allKbRooms).
- `POST /knowledge-bases` — create; if `?general=1` (or body `{general:true}`), create then set `is_default_general=true` (reuse the unset-others logic).
- `PATCH /knowledge-bases/:id` — name and/or content.
- `POST /knowledge-bases/:id/general` — `{value:boolean}` (port `setDefaultGeneralKb`).
- `PUT /knowledge-bases/:id/rooms` — replace room assignments (port `saveRoomAssignments`).
- `DELETE /knowledge-bases/:id/rooms` — remove one room from another KB (port `removeRoomFromKb`).
- `DELETE /knowledge-bases/:id` — port `deleteKnowledgeBase`.

- [ ] **Step 1:** Deno tests (fake client) covering list (includes is_default_general), general-getter, create-as-general sets the flag, set-general toggle, room replace, delete, + body-guard 400s. Run → fail.
- [ ] **Step 2:** Implement `buildKnowledgeBaseRoutes(makeClient)`, porting queries verbatim. Mount behind `requireAuth` in `index.ts`.
- [ ] **Step 3:** `deno test` green; `deno check index.ts`. Commit `feat(api): knowledge-bases routes incl. general KB`.

---

## Task 5: Frontend wrappers (TDD)

Create `src/lib/<r>-api.ts` (+ `.test.ts`) for `maintenance`, `calls`, `urgency-rules`, `me`, `metrics`, `knowledge-bases`, mirroring `src/lib/properties-api.ts` / its test. Each wrapper's path+method must match its edge route (Task 2-4). Knowledge-bases wrapper includes `fetchGeneralKb()` (`GET /knowledge-bases/general`) and `createKnowledgeBase(name, {general})`.

- [ ] One commit per wrapper after its Vitest passes (`npm test -- src/lib/<r>-api.test.ts`). Commit message `feat(web): <r>-api wrappers`.

---

## Task 6: Convert mechanical pages (maintenance, calls, urgency-rules, home/metrics)

For each page, mirror the `properties/page.tsx` conversion: `'use client'` + `useQuery`; child mutations → `useMutation` + `invalidateQueries`; drop `@/backend/*` value imports; keep `import type` from `@/backend/types`.

- [ ] **Step 1:** `(dashboard)/maintenance/page.tsx` + `detail/page.tsx` (detail reads `useSearchParams().get('id')` — already client-friendly) + child clients → maintenance-api. tsc + dev sanity. Commit.
- [ ] **Step 2:** `(dashboard)/calls/page.tsx` + `detail/page.tsx` (read-only) → calls-api. Commit.
- [ ] **Step 3:** `(dashboard)/settings/urgency-rules/page.tsx` (+ drag-reorder client) → urgency-rules-api. Commit.
- [ ] **Step 4:** `(dashboard)/page.tsx` (home) → `useQuery(fetchMetrics)`. Commit.
- [ ] After each: `npx tsc --noEmit` clean; the page has no `force-dynamic`/`@/backend` value import (`grep`).

---

## Task 7: Users → single-account `/me` profile page

Reduce `(dashboard)/settings/users/` to a single-account profile editor (no list/create/deactivate). The page becomes `'use client'`, `useQuery(fetchMe)` shows the current account; a form edits display name + (optional) password via `useMutation(updateMe)`. Update the sidebar nav label if it says "Users" → keep "Users" or rename to "Account"/"Profile" (keep `/settings/users` route to avoid churn, or move to `/settings/profile` — pick `/settings/users` to minimize nav edits). Delete the old multi-user table/create/deactivate client components.

- [ ] **Step 1:** Rewrite `settings/users/page.tsx` as the profile editor against `me-api`. Delete the staff-CRUD client components no longer used.
- [ ] **Step 2:** tsc clean; nav still points at the kept route. Commit `feat(web): single-account profile (was users CRUD)`.

DB note: the table already has `admin` + `superadmin` rows. "Single user" is a UI/scope decision; we don't delete DB rows here (login still works for whichever account). If you want exactly one row, that's a separate manual DB step — out of scope for this plan.

---

## Task 8: Knowledge Bases — General KB section + editor reframe

Implement the approved **section-only** design.

**List page** `(dashboard)/knowledge-bases/page.tsx` (→ `'use client'`):
- `useQuery(['kbs'], fetchKnowledgeBases)` and `useQuery(['kb-general'], fetchGeneralKb)`.
- Render a top **"General Knowledge Base"** card: explainer text; if a general KB exists → its name + updated + an **Edit** link to `/knowledge-bases/detail?id=…`; if none → a **"Create general KB"** button (`createKnowledgeBase('General Knowledge Base', {general:true})` → redirect to its editor).
- Below: **"Property & Room Knowledge Bases"** — the list **excluding** the general KB, WITHOUT the old "General KB" column / "Set as default" button. Mirror the existing `kb-list-client.tsx` table minus the default column.

**Editor** `(dashboard)/knowledge-bases/detail/page.tsx` (already client `DetailContent`):
- Reads/writes via `knowledge-bases-api` (replace the 7 server actions). Keep Tiptap + marked/turndown.
- **Remove** the header `★ General KB / Set as general` toggle button.
- When the open KB is the general one (`is_default_general`), replace the right-hand property/room assignment panel with a short note: *"This is the general knowledge base — loaded on every call, not tied to a room."* For non-general KBs, keep the room-assignment panel.

**New page** `(dashboard)/knowledge-bases/new/page.tsx` → `createKnowledgeBase(name)` via the wrapper.

- [ ] **Step 1:** Convert the new page. Commit.
- [ ] **Step 2:** Convert the editor (server actions → api wrappers; remove toggle; general-KB note). tsc clean; dev sanity (open a KB, edit content/name, rooms save). Commit.
- [ ] **Step 3:** Rebuild the list page with the General KB section + room-specific list (no default column). tsc clean; dev sanity (general card shows/creates; room KBs listed). Commit `feat(web): General Knowledge Base section`.

---

## Task 9: Delete the dead server layer + drop deps

Once Tasks 1-8 land, the converted pages import NOTHING from `@/backend/*` as values (only `import type` from `@/backend/types`). Confirm, then delete.

- [ ] **Step 1:** `grep -rn "from '@/backend/" src | grep -v "import type"` → expect ONLY `@/backend/types` type-imports (and none of the server modules). If any value import remains, that page isn't converted — fix before deleting.
- [ ] **Step 2:** `git rm` the now-unused server modules: `src/backend/{auth,session,supabase,knowledge-bases,maintenance,users,urgency-rules,properties,kwhotel}.ts`. KEEP `src/backend/types.ts` (type-only, used by the client). Also delete `src/lib/auth-actions.tsx`? (only if unused) and confirm `middleware.ts` is already gone.
- [ ] **Step 3:** Remove server-only deps from `package.json`: `iron-session`, `@supabase/ssr`, and the root `bcryptjs`/`@supabase/supabase-js` IF nothing in `src/` still imports them (the edge fn has its own copies via Deno; the browser must not bundle `@supabase/supabase-js`). Keep `@supabase/supabase-js` only if a client path still needs it (it shouldn't). `npm install` to update the lockfile.
- [ ] **Step 4:** `npx tsc --noEmit` clean; `npm test` green. Commit `chore: delete SSR server layer + server-only deps`.

---

## Task 10: Flip `output:'export'` + green static build

- [ ] **Step 1:** Re-add `output: 'export'` to `next.config.ts` (keep `images.unoptimized`).
- [ ] **Step 2:** `npm run build`. It must now SUCCEED and emit `out/`. If it still errors on a page, that page wasn't fully converted (a `force-dynamic` or Server Action remains) — fix it, re-run. List `out/` to confirm static HTML for `/login`, `/`, `/knowledge-bases`, `/maintenance`, `/calls`, `/settings/urgency-rules`, `/settings/users`.
- [ ] **Step 3:** Update `CLAUDE.md`: remove the deleted routes (agent/cost-rates/feature-flags/booking-links) from the Route Structure; note single-user `/settings/users` profile; note the General Knowledge Base section; note the static-export + edge-API architecture. Commit `feat: enable static export (all pages on edge API)` + `docs: update CLAUDE.md for static+edge architecture`.

---

## Task 11: Deploy (pair with user)

- [ ] **Step 1:** Redeploy the edge function with the new routes (MCP `deploy_edge_function`, `verify_jwt:false`, all files incl. new routes). Re-verify a couple endpoints by `curl` with a fresh token.
- [ ] **Step 2:** Set `ALLOWED_ORIGINS` secret to the Render static URL (and keep `localhost:3000` for dev) once the static site exists.
- [ ] **Step 3 (user):** Create the Render `static_site` (build `npm install && npm run build`, publish `out/`, env `NEXT_PUBLIC_API_URL` = the function URL). Verify instant load (no interstitial) + full login/CRUD across all pages.
- [ ] **Step 4 (user):** Delete the old Render **web service** `molo-dashboard` once the static site is verified.

---

## Self-Review Notes
- **Spec coverage:** all remaining pages converted (Tasks 2-8), booking-links removed (Task 1), General KB section (Task 8), single-user /me (Tasks 3,7), secret surface collapsed to the edge fn (Task 9), static build green (Task 10), deploy (Task 11). ✅
- **Pattern reuse:** every conversion cites the proven Slice 1 template (`properties` route/wrapper/page) rather than re-deriving — DRY.
- **KWHotel import** stays deferred/disabled (Slice 1 left the button disabled); not re-enabled here.
- **Type-only `@/backend/types` imports are allowed** in client code (no secret); only value imports of server modules are forbidden (Task 9 Step 1 enforces).
