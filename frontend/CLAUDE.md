@AGENTS.md

# Molo Voice Agent Dashboard

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Molo Voice Agent Dashboard — a single-user, staff-facing web dashboard for managing properties, knowledge bases, call logs, maintenance tickets, and urgency rules for the Molo hotel group in Poland. The voice agent itself lives elsewhere; this repo is the dashboard (static frontend + Supabase edge `api`).

## Stack

- **Framework**: Next.js 14+ (App Router, TypeScript) compiled to a **static export** (`output: 'export'`, `out/` bundle) — no Next server at runtime
- **Styling**: Tailwind CSS + shadcn/ui
- **Database**: Supabase (PostgreSQL). The browser **never** talks to Postgres directly; all DB access is behind a single Supabase **Edge Function `api`** (Hono) that holds the service-role key
- **Auth**: Login posts to the edge `api`, which checks username + bcrypt password against the `users` table and returns a JWT. The browser stores the JWT and sends it as a `Bearer` token on every edge call. **Single-user** system
- **Forms**: React Hook Form + Zod
- **Client state**: TanStack Query — every page fetches from the edge `api`
- **Hosting**: Render **static_site** serving the `out/` bundle; the edge `api` runs on Supabase

## Commands

```bash
npm run dev          # local dev server
npm run build        # static production build → emits out/
npm test             # vitest run
npx shadcn@latest add <component>  # add shadcn components
```

## Architecture

### Auth Model
All auth is custom — no Supabase Auth, no OAuth, no magic links. Login posts credentials to the edge `api`, which verifies username + bcrypt password against the `users` table and returns a JWT. The client stores the JWT (and a lightweight user object in `localStorage`) and sends it as an `Authorization: Bearer` header on every edge call. There is no Next middleware and no server-side session cookie; the static client itself redirects unauthenticated users to `/login`. This is a **single-user** dashboard.

### Data Access Pattern
**All Supabase/Postgres access is server-side inside the edge `api` Edge Function, which alone holds the service-role key. The browser holds no secret.** This means:
- Every page is a static Client Component that reads/writes via TanStack Query against the edge `api`
- The service-role key lives only in the Edge Function env, never in the static bundle
- There are no Next Server Components, Server Actions, or API routes — the `out/` bundle is pure static assets
- Supabase RLS is not relied on for the dashboard (the edge `api`, gated by JWT, is the single trusted DB caller)

### Database Schema (Supabase)
Tables the dashboard surfaces: `users`, `properties` (8 seeded), `knowledge_bases` (general/property/exception kinds), `knowledge_base_rooms`, `urgency_rules` (4 tiers), `call_logs`, `maintenance_tickets`. (The booking-links, agent-settings, cost-rates, and feature-flags modules were cut from the dashboard during the static migration.)

`same_night_bookings` is a **retained orphan**: the same-night booking flow it backed was removed on 2026-07-17 (KWHotel doesn't expose the endpoints it needed — see `docs/superpowers/specs/2026-07-17-remove-same-night-booking-design.md`). Nothing reads or writes it. The table and its migration are kept deliberately — dropping is irreversible, and the Supabase project was paused when the flow was withdrawn, so its contents were never verified. Do not build on it.

A view `kb_for_room` resolves KB priority: exception > property > general for a given (property, room_number) pair.

The full idempotent SQL schema + seed lives in `MOLO_PLAN.md` section 10.

### Knowledge Base Priority System
KBs have three kinds with a load priority:
1. **General** — preloaded at call start, not tied to a property. Exactly one can be `is_default_general = true` (enforced by unique partial index).
2. **Property** — tied to one property, swapped in after reservation lookup.
3. **Exception** — overrides the property KB for a specific room number.

### Route Structure
```
/login                    — public
/                         — dashboard home (metrics + recent activity)
/properties/*             — CRUD for 8 properties
/knowledge-bases/*        — KB list (incl. a "General Knowledge Base" section) + KB editor (most-used page)
/maintenance/*            — tickets list + detail
/calls/*                  — call logs + detail (transcript, recording, tool trace)
/settings/users           — single-account profile (own username/display name + password)
/settings/urgency-rules   — drag-to-reorder urgency tiers
```

### Layout
Left sidebar (220px, collapsible) with grouped nav. Top bar with breadcrumbs and user menu. Toaster bottom-right via Sonner.

### Environment Variables
Static frontend (baked into the `out/` bundle — public, non-secret only):
```
NEXT_PUBLIC_SUPABASE_URL          # used to derive the edge `api` base URL
NEXT_PUBLIC_SUPABASE_ANON_KEY     # public anon key (no secret)
```
Edge Function `api` (Supabase env — never reaches the browser):
```
SUPABASE_SERVICE_ROLE_KEY    # service-role, edge-only
JWT_SECRET                   # signs/verifies the bearer token issued at login
```

## Key Conventions

- Room numbers are free-text strings (e.g., "101", "3a", "402")
- UUIDs follow a deterministic pattern for seeded data (see MOLO_PLAN.md § 3)
- Properties have aliases (JSONB array) for alternative names guests use
- The dashboard is single-user: `/settings/users` is a self-profile page (display name + password), not multi-user management
- The KB editor (`/knowledge-bases/[id]`) is the most complex page — two-column layout with form left, live preview right
- All destructive actions require a `ConfirmDialog` that quantifies impact
