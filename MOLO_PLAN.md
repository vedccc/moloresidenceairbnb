# Molo Voice Agent — Dashboard & Database Plan

One document covering everything you need to ship: the Supabase database (schema + seed) and the staff dashboard (UI spec + auth). Designed to be executed top-to-bottom.

> This is a single self-contained spec. Section 10 (Appendix) contains the complete Supabase SQL — copy from the code block there and paste it into the Supabase SQL Editor in one go. The script is idempotent.

---

## 1. Stack

| Layer | Pick |
|---|---|
| Frontend framework | **Next.js 14+** (App Router, TypeScript) |
| Styling | **Tailwind CSS** + **shadcn/ui** components |
| Data client | **@supabase/supabase-js** (with `@supabase/ssr` helpers) |
| Forms | **React Hook Form** + **Zod** |
| Server state | **TanStack Query** |
| Password hashing | **bcryptjs** (pure JS, no native deps) |
| Session cookies | **iron-session** or a signed JWT — whichever is cleaner for you |
| Icons | **Lucide** |
| Toasts | **Sonner** |
| Hosting | **Render** (single Web Service) |

```bash
npx create-next-app@latest molo-dashboard --typescript --tailwind --app
cd molo-dashboard
npx shadcn@latest init
npm i @supabase/supabase-js @supabase/ssr @tanstack/react-query \
      react-hook-form zod @hookform/resolvers \
      bcryptjs iron-session lucide-react sonner date-fns
npm i -D @types/bcryptjs
```

---

## 2. Authentication — username + password, no provider

Deliberately simple. No Supabase Auth, no magic links, no OAuth, no email verification, no password reset flow. Just username + password against a `users` table, with bcrypt and a signed session cookie.

### What's in the database

A `users` table:

```sql
create extension if not exists pgcrypto;  -- for crypt() / gen_salt('bf')

create table if not exists users (
  id              uuid primary key default uuid_generate_v4(),
  username        text not null unique,
  password_hash   text not null,
  display_name    text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

create index if not exists idx_users_username on users(lower(username));
```

### Creating the first user (run once after schema creation)

There's no UI to bootstrap the very first user — you create it directly in SQL, then use the dashboard for everyone after that:

```sql
insert into users (username, password_hash, display_name) values
  ('admin', crypt('your-strong-password-here', gen_salt('bf')), 'Owner');
```

`pgcrypto`'s `crypt(plain, gen_salt('bf'))` produces a standard bcrypt hash compatible with Node's `bcryptjs.compare()`. So all later password operations can happen in the app.

### Login flow (server action)

```ts
// app/login/actions.ts
'use server'
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { sealData } from 'iron-session';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function login(_: unknown, formData: FormData) {
  const username = (formData.get('username') as string).trim();
  const password = formData.get('password') as string;

  const { data: user } = await supabase
    .from('users')
    .select('id, username, password_hash, display_name, is_active')
    .eq('username', username)
    .eq('is_active', true)
    .maybeSingle();

  if (!user) return { error: 'Invalid credentials' };
  if (!(await bcrypt.compare(password, user.password_hash)))
    return { error: 'Invalid credentials' };

  await supabase.from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id);

  const sealed = await sealData(
    { userId: user.id, displayName: user.display_name },
    { password: process.env.SESSION_SECRET!, ttl: 60 * 60 * 24 * 30 }
  );

  cookies().set('molo_session', sealed, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, path: '/',
  });

  redirect('/');
}
```

### Route protection (middleware)

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';
import { unsealData } from 'iron-session';

export async function middleware(req: NextRequest) {
  const sealed = req.cookies.get('molo_session')?.value;
  if (!sealed) return NextResponse.redirect(new URL('/login', req.url));
  try {
    await unsealData(sealed, { password: process.env.SESSION_SECRET! });
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL('/login', req.url));
  }
}

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|favicon|api/health).*)'],
};
```

### Required env vars

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...         # server-only, NEVER expose
SESSION_SECRET=<random 32+ char string>
```

Generate `SESSION_SECRET` with: `openssl rand -base64 48` or any password manager.

### Notes on what this is and isn't

- **What it is**: enough auth to keep the dashboard from being world-readable, with users you can create/disable/delete from the UI.
- **What it isn't**: not a multi-tenant system, not role-based, no MFA, no password complexity rules, no rate limiting on login (add some if exposed to the open internet — Render's free tier with a few login attempts/min is realistically fine for a private staff tool).
- All Supabase queries from the dashboard go through the **server** with the **service-role key**. The anon key isn't really used since there's no client-side Supabase access happening directly. This is deliberate — keeps the auth model simple.

---

## 3. Database

### Tables at a glance

| Table | Purpose |
|---|---|
| `users` | Staff who can sign into the dashboard |
| `properties` | The 8 Molo properties (seeded) |
| `knowledge_bases` | Free-text content the voice agent reads from |
| `knowledge_base_rooms` | Maps each KB to the room numbers it covers |
| `urgency_rules` | Rules used by the urgency classifier (seeded with 4 tiers) |
| `call_logs` | Every call answered by the agent |
| `maintenance_tickets` | Issues raised by guests (tool is no-op for now) |
| `booking_links` | SMS booking links sent to prospective bookers |
| `agent_settings` | Singleton row of agent config |

Plus a convenience **view** `kb_for_room` that returns all KBs applicable to a `(property, room_number)` pair, ordered by priority (`exception` > `property` > `general`).

### UUID strategy (for readability when debugging)

```
users:             40000000-0000-0000-0000-00000000000N    (generated, no seed)
properties:        11111111-1111-1111-1111-00000000000{1..8}
general KBs:       22222222-2222-2222-2222-00000000000N
property KBs:      22222222-2222-2222-2222-10000000000{1..8}   ← matches property suffix
exception KBs:     22222222-2222-2222-2222-20000000000N
urgency_rules:     33333333-3333-3333-3333-00000000000{1..4}
```

### How to run

Open the Supabase SQL Editor, copy the entire SQL block from section 10 below, paste it, click Run. It's idempotent — re-running is safe and won't overwrite client-edited content (every `INSERT` uses `ON CONFLICT DO NOTHING`).

After running, sanity-check:

```sql
select count(*) from properties;            -- expect 8
select count(*) from knowledge_bases;       -- expect 10
select count(*) from knowledge_base_rooms;  -- expect 43
select count(*) from urgency_rules;         -- expect 4
select count(*) from agent_settings;        -- expect 1

-- Verify the exception priority works:
select kb_name, kind, priority from kb_for_room
  where room_number = '402' order by priority desc;
-- → returns the exception KB (priority 3) AND the property KB (priority 2)

-- Verify the collision case for room "4":
select property_name from kb_for_room
  where room_number = '4' order by property_name;
-- → returns 4 different properties (this is the case property_resolver disambiguates)
```

Then create your first user (see § 2).

### What's seeded

- **8 properties** — Hotel Molo Residence, Molo Residence Apartments, Riviera Residence Apartments, Riviera Rooms, Boho Rooms, Boho Apartment, Apartament Molo Superior, Apartament Molo. Names, addresses, aliases, and notes pre-filled from the client spreadsheet.
- **10 knowledge bases** — 1 general (default booking-inquiry KB), 8 property (one per property, fully populated with the parking / breakfast / wifi / check-in/out / kitchen / kids / pets / room-types info from the spreadsheet), 1 exception (Riviera Residence apartment 402's separate wifi).
- **43 room assignments** in `knowledge_base_rooms` — every room from the spreadsheet, plus the 402 exception.
- **4 urgency rules** — critical / high / medium / low with starter examples and keywords.
- **1 `agent_settings`** row with placeholder system prompt and the per-minute cost defaults.

KW Hotel IDs are nullable and not yet populated; staff can add them via the dashboard once the client provides them.

---

## 4. Dashboard UI

### Sitemap

```
/login                            — public, username + password

/                                 — dashboard home (overview)

/properties                       — list of 8 properties
/properties/new                   — add
/properties/[id]                  — edit

/knowledge-bases                  — list, with filters
/knowledge-bases/new              — create
/knowledge-bases/[id]             — edit (this is THE page staff use most)

/maintenance                      — tickets list
/maintenance/[id]                 — ticket detail

/calls                            — call logs list
/calls/[id]                       — call detail (transcript, recording, tool trace)

/booking-links                    — sent SMS links + conversion tracking

/settings/users                   — manage staff accounts (NEW)
/settings/agent                   — system prompt + greeting + transfer phone
/settings/urgency-rules           — urgency tiers + matching rules
/settings/cost-rates              — per-minute pricing for cost calculation
/settings/feature-flags           — toggles (record_audio, etc.)
```

### Layout shell

- **Left sidebar** (220px, collapsible) — nav grouped: Overview, Content (Properties, KBs), Operations (Maintenance, Calls, Booking Links), Settings (Users, Agent, Urgency Rules, Cost Rates, Flags).
- **Top bar** — page title + breadcrumbs, user menu top-right (initial, display_name, Sign out).
- **Main** — padded content area.
- **Toaster** bottom-right.

shadcn's `sidebar`, `breadcrumb`, `dropdown-menu`, and `avatar` compose into this shell directly.

### Pages

#### `/login`
Single centered card. Username + password fields. Submit calls the server action from § 2. Error message inline on failure.

#### `/` — Dashboard home
Top row: 4 metric cards.

1. **Calls today** — count of `call_logs` started today, with subtotal duration and cost.
2. **Open maintenance** — count where `status = 'open'`, with critical/high breakdown.
3. **Booking links (7d)** — count + click-through % + conversion %.
4. **Active properties** — count of `properties`. Sanity check (always 8 to start).

Bottom-left: last 10 calls (compact rows: time, duration, mode pill, outcome pill, → call detail).
Bottom-right: top 5 open critical/high tickets (→ ticket detail).

No realtime needed; a refresh button is enough.

#### `/properties` — list
Table. Columns: name, address, KW Hotel ID (italic if null), # rooms assigned, # KBs covering this property, language default (badge), updated at (relative). `+ New property` top-right. Click row → edit.

#### `/properties/[id]` and `/properties/new` — edit / create
Form fields:
- **Name** (text, required, unique)
- **Address** (text, required)
- **KW Hotel ID** (integer, optional) — tooltip explains it's the KWHotel PMS HotelId
- **Transfer phone** (text, optional, E.164)
- **Aliases** (chip input) — alternative names guests use; stored as JSONB array
- **Default language** (radio: EN / PL)
- **Timezone** (select, default Europe/Warsaw)
- **Notes** (textarea, internal — *not* shown to agent)

Right panel (edit only): list of KBs linked to this property with room numbers each covers; quick-link to add a new KB pre-filled with this property_id.

Delete is destructive (cascades to KBs and room assignments) — show a confirmation that quantifies what'll be deleted.

#### `/knowledge-bases` — list
Filter bar: search (debounced), filter by property, filter by kind. Columns: name, kind (color badge), property (— for general), rooms covered (chips, +N more), content length, updated at.

#### `/knowledge-bases/[id]` — KB editor (the most-used page)

Two columns: left = editor, right = live preview.

**Left (form)**:
- **Name** (text, required)
- **Kind** (segmented: General / Property / Exception)
  - *General* — preloaded into Redis at call start. Not tied to a property.
  - *Property* — tied to one property; swapped into Redis after `reservation_lookup`.
  - *Exception* — overrides the property KB for one specific room.
- **Property** (select, required if kind ≠ general; disabled otherwise)
- **Default general?** (checkbox, only visible if kind = general) — exactly one KB can have `is_default_general = true`; a unique partial index in the database enforces this. Show inline warning if the user tries to set a second one.
- **Content** (monospace textarea, autoresizing, min ~500px) — the actual KB text.
- **Room numbers** (chip input, required if kind ≠ general) — assign rooms by number. Auto-suggest from existing room numbers in this property's other KBs; allow new ones too. Room numbers are stored as free-text strings ("101", "3a", etc.).

**Right (preview)**:
- Read-only render of the content as a styled card with a header: "What the AI will see for `[property name]` · room `[N]`".
- Below: a small explainer of where this KB falls in the load priority (general → property → exception).

Save = upsert into `knowledge_bases`, then delete-then-insert on `knowledge_base_rooms` for the room list. Duplicate button creates a copy for editing (useful when spinning up an exception KB from a property one). Delete with confirmation showing # rooms that'll be unassigned.

#### `/maintenance` — tickets list
Filter bar: status (multi, default open + in_progress), urgency (multi), property, date range. Columns: created (relative), property, room, urgency (color badge), status (color badge), description (truncated), source (call/dashboard). Sort: urgency tier first, then created_at DESC.

`+ New ticket` top-right.

#### `/maintenance/[id]` — ticket detail
Left column (form): property + room (read-only after creation), description (textarea), urgency (select), status (select), notes (append-only textarea), linked reservation_id (optional). Right column (audit): created/resolved timestamps, created_via badge, matched urgency rule, linked call (→ call detail).

#### `/calls` — calls list
Filters: date range, mode, outcome, property. Columns: started_at, duration, from (phone), mode (badge), property, outcome (badge), cost. Sort: started_at DESC.

#### `/calls/[id]` — call detail
Top metadata block (always visible): call ID, time, duration, mode, from/to_did, property, reservation_id, outcome + sentiment badges, cost (with breakdown tooltip).

Tabs:
1. **Summary** — AI-generated summary, plus linked entities (maintenance ticket, booking link).
2. **Transcript** — readable, alternating speakers, with search.
3. **Recording** — audio player if `recording_url`, else "Recording disabled / not available".
4. **Tool calls** — vertical timeline of each tool call with name, args, result, latency (for debugging agent behavior).
5. **Raw JSON** — pretty-printed `tool_calls` for support.

#### `/booking-links`
Table. Columns: sent_at, phone (masked except last 4, hover to reveal), guest_name, property, booking_option, dates, # guests, clicked? icon, converted? icon, call (link). Top metrics: total sent 7d/30d, click-through %, conversion %.

#### `/settings/users` — NEW
Staff account management.

Table columns: username, display_name, last_login_at (relative), is_active (toggle), actions.

`+ Add user` button → modal:
- Username (text, required, lowercased on submit, unique)
- Display name (text)
- Password (text, min 8 chars)
- Confirm password (text, must match)

Server action hashes with `bcryptjs.hash(password, 10)` and inserts.

Click row to edit → modal:
- Display name (editable)
- Change password (two fields, optional — only updates if filled)
- Active toggle

Deactivate instead of delete (preserves `created_by` references on call_logs/tickets if you add those later). Hard delete only via SQL.

No role concept in v1 — any logged-in user can manage other users. Add roles later if needed.

#### `/settings/agent`
- **System prompt** (large monospace textarea, ~600px, autoresize) — main agent prompt; reset-to-default button; warning: "Changes take effect on the next call."
- **Greeting text** (single-line)
- **Transfer default phone** (text, E.164) — used when no property-specific transfer_phone is set, or when `transfer_call` runs before guest identification.

Saves to `agent_settings` (singleton row).

#### `/settings/urgency-rules`
Drag-handle list ordered by `sort_order` (which controls match priority — first match wins). Each card: level badge, name, examples (chips), keywords (chips), Edit, Delete. Modal for editing: level (radio), name, examples (chip input), keywords (chip input). Drag-to-reorder updates `sort_order` for all affected rows in a single batch.

The SQL seeds 4 default rules so this page is never empty.

#### `/settings/cost-rates`
Three number inputs (4 decimals): Telnyx per minute, LiveKit Cloud per minute, Gemini Live per minute. Save updates `agent_settings.cost_per_min_usd` JSONB. Note: changes don't backfill existing call_logs.

#### `/settings/feature-flags`
Toggles. `record_audio` (whether call recordings are saved). Room to add more.

---

## 5. Shared components

Build these once, use everywhere:

- **`<DataTable>`** — sortable, filterable, paginated. shadcn has a starting template; add debounced search and URL-state filters.
- **`<StatusBadge variant="urgency|status|outcome|kind|mode" value="..." />`** — color-coded pills with a centralized color map.
- **`<PhoneInput>`** — E.164 validation, default country +48 (Poland).
- **`<ChipInput>`** — for aliases, room_numbers, examples, keywords. Comma/Enter to add, backspace to remove last.
- **`<ConfirmDialog>`** — for destructive actions. Quantifies impact ("Delete property — this will also delete 1 KB and 11 room assignments.").
- **`<RelativeTime date={...} />`** — "3 days ago", absolute time on hover.
- **`<JsonView>`** — collapsible pretty JSON for tool_calls debug.
- **`<CopyButton text="...">`** — tiny clipboard helper, useful on UUIDs and phones.

---

## 6. Data-fetching patterns

- **Server Components** for list pages — initial render is server-side, filters live in URL search params.
- **Server Actions** for mutations (create/update/delete) — no API routes needed, plays nicely with shadcn forms.
- **TanStack Query on the client** for anything that updates without navigation (e.g. real-time ticket status changes in detail views).
- **Supabase Realtime** — skip in v1. Add later if you want live "new call just came in" on the dashboard home.

All Supabase calls happen on the server with the service-role key. Don't ship the anon key to the browser; the dashboard doesn't need direct client-side DB access.

---

## 7. Render deployment

Single Web Service.

- **Build**: `npm install && npm run build`
- **Start**: `npm start`
- **Env vars** (set in Render dashboard):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SESSION_SECRET`
- Free tier works to start; bump to Starter ($7/mo) when you want zero cold starts.

---

## 8. Build order

A focused dev gets v1 done in about a week:

1. **Auth + shell** (login, layout, sidebar, top bar, middleware) — half a day
2. **`/settings/users`** + bootstrap admin user — couple of hours
3. **Properties list + edit** — half day (data already seeded)
4. **Knowledge bases list + edit** — *one full day*, this is the meatiest page
5. **Dashboard home** — couple of hours
6. **Calls list + detail** — half day (skip recording player initially)
7. **Maintenance list + detail** — half day
8. **Booking links list** — hour or two
9. **Other settings pages** (agent prompt, urgency rules, cost rates, feature flags) — half day total

---

## 9. Out of scope for v1 (deliberate)

- Roles / permissions tiers — any logged-in user is staff
- Password reset via email — admin resets passwords from `/settings/users`
- MFA, OAuth, magic links — username + password is enough
- Audit log of who edited what — add later when needed
- Bulk import/export — KB editing is page-by-page
- Mobile-optimized layout — desktop-first, mobile readable but not pretty
- Dashboard UI localization — English-only (the *agent* speaks PL/EN; staff dashboard is EN)
- Supabase RLS — since the dashboard always uses the service-role key on the server, RLS isn't needed. **If you ever want to give the browser direct Supabase access**, turn RLS on with authenticated-only policies on each table at that point.

---

## 10. Appendix — Full Supabase SQL

This is the complete, runnable script. Copy the entire code block below and paste it into the Supabase SQL Editor in one go. It's idempotent — safe to re-run; seeded content uses `ON CONFLICT DO NOTHING` so client edits via the dashboard survive untouched.

```sql
-- =============================================================================
-- MOLO VOICE AGENT  —  Supabase Setup
-- =============================================================================
-- Run this once in the Supabase SQL Editor.
-- It is idempotent: safe to re-run (CREATE IF NOT EXISTS for tables,
-- ON CONFLICT DO NOTHING for seeds — so client edits won't be clobbered).
--
-- TABLES (9):
--   users                   staff dashboard login (username + bcrypt password)
--   properties              physical Molo properties
--   knowledge_bases         content the agent reads from (general | property | exception)
--   knowledge_base_rooms    which room numbers each KB covers
--   urgency_rules           categorization rules for maintenance tickets
--   call_logs               every call answered by the agent
--   maintenance_tickets     issues raised (tool is no-op for now; UI can create manually)
--   booking_links           SMS booking links sent to prospective bookers
--   agent_settings          singleton row of agent config
--
-- AUTH MODEL:
--   No Supabase Auth, no providers. The Next.js dashboard checks credentials
--   against the users table, hashes with bcryptjs (compatible with pgcrypto's
--   crypt()), and sets a signed session cookie.
--
-- SEEDED DATA:
--   8 properties (Hotel Molo Residence, Molo Apartments, Riviera Apartments,
--                 Riviera Rooms, Boho Rooms, Boho Apartment, Apartament Molo
--                 Superior, Apartament Molo)
--   1 default general KB
--   8 property KBs (one per property, content extracted from the client
--                   spreadsheet — staff can edit freely in the dashboard)
--   1 exception KB (Riviera Apartments room 402 has its own wifi)
--   knowledge_base_rooms entries linking each KB to its rooms (43 rows)
--   4 default urgency rules (critical/high/medium/low)
--   1 agent_settings row with placeholder system prompt
--
-- NOT SEEDED:
--   users — create the first user manually after the script (see end of file).
--
-- UUID strategy (deterministic so cross-references stay readable):
--   properties:      11111111-1111-1111-1111-00000000000N  (N = 1..8)
--   general KBs:     22222222-2222-2222-2222-00000000000N
--   property KBs:    22222222-2222-2222-2222-10000000000N
--   exception KBs:   22222222-2222-2222-2222-20000000000N
--   urgency_rules:   33333333-3333-3333-3333-00000000000N
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions + helpers
-- -----------------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;   -- for crypt() / gen_salt('bf')

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- TABLE: users  (staff dashboard login — simple username + password)
-- =============================================================================
-- Authentication is intentionally minimal: no Supabase Auth, no providers,
-- no magic links. Just username + bcrypt'd password + a signed session cookie
-- managed by the Next.js app. See MOLO_PLAN.md § 2 for the full flow.
--
-- Password hashing uses bcrypt via pgcrypto. The Node side uses bcryptjs
-- which produces compatible $2 hashes, so passwords created in SQL and
-- passwords created in the app are interchangeable.
--
-- BOOTSTRAP THE FIRST USER (after the script finishes):
--   insert into users (username, password_hash, display_name)
--   values ('admin', crypt('your-strong-password', gen_salt('bf')), 'Owner');
-- =============================================================================
create table if not exists users (
  id              uuid primary key default uuid_generate_v4(),
  username        text not null unique,
  password_hash   text not null,
  display_name    text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

create index if not exists idx_users_username on users(lower(username));

comment on table users is 'Staff accounts for the dashboard. Username + bcrypt password. No Supabase Auth.';


-- =============================================================================
-- TABLE: properties
-- =============================================================================
create table if not exists properties (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null unique,
  address           text not null,
  kwhotel_hotel_id  integer,
  transfer_phone    text,
  aliases           jsonb not null default '[]'::jsonb,
  language_default  text not null default 'en' check (language_default in ('en','pl')),
  timezone          text not null default 'Europe/Warsaw',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_properties_kwhotel_id on properties(kwhotel_hotel_id);
create index if not exists idx_properties_name_lower on properties(lower(name));

drop trigger if exists properties_updated_at on properties;
create trigger properties_updated_at before update on properties
  for each row execute function set_updated_at();

comment on table properties is 'Physical Molo properties (8 of them).';
comment on column properties.aliases is 'JSON array of alternative names/spellings guests might use.';
comment on column properties.kwhotel_hotel_id is 'HotelId in KWHotel PMS, for the reservations API. Nullable until populated.';
comment on column properties.notes is 'Internal staff notes. NOT shown to the agent.';


-- =============================================================================
-- TABLE: knowledge_bases
-- =============================================================================
create table if not exists knowledge_bases (
  id                  uuid primary key default uuid_generate_v4(),
  property_id         uuid references properties(id) on delete cascade,
  name                text not null,
  kind                text not null check (kind in ('general','property','exception')),
  content             text not null default '',
  is_default_general  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- general KBs have no property; property and exception KBs require one
  constraint kb_property_link check (
    (kind = 'general'   and property_id is null) or
    (kind in ('property','exception') and property_id is not null)
  )
);

-- Only one default general KB at a time
create unique index if not exists uq_default_general
  on knowledge_bases ((1)) where is_default_general = true;

create index if not exists idx_kb_property on knowledge_bases(property_id);
create index if not exists idx_kb_kind     on knowledge_bases(kind);

drop trigger if exists kb_updated_at on knowledge_bases;
create trigger kb_updated_at before update on knowledge_bases
  for each row execute function set_updated_at();

comment on table knowledge_bases is
  'Free-form text content the agent reads. Loaded into Redis cache during calls.';
comment on column knowledge_bases.kind is
  'general = preloaded at call start (no property). property = swapped in after reservation_lookup. exception = overrides property KB for a specific room.';


-- =============================================================================
-- TABLE: knowledge_base_rooms
-- =============================================================================
create table if not exists knowledge_base_rooms (
  id                 uuid primary key default uuid_generate_v4(),
  knowledge_base_id  uuid not null references knowledge_bases(id) on delete cascade,
  room_number        text not null,
  created_at         timestamptz not null default now(),

  unique (knowledge_base_id, room_number)
);

create index if not exists idx_kbr_room on knowledge_base_rooms(room_number);

comment on table knowledge_base_rooms is
  'Maps each KB to the room numbers it covers. A KB lists multiple rooms; a room may be covered by multiple KBs (exception > property > general).';


-- =============================================================================
-- TABLE: urgency_rules
-- =============================================================================
create table if not exists urgency_rules (
  id          uuid primary key default uuid_generate_v4(),
  level       text not null check (level in ('critical','high','medium','low')),
  name        text not null,
  examples    jsonb not null default '[]'::jsonb,
  keywords    jsonb not null default '[]'::jsonb,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_urgency_sort on urgency_rules(sort_order);

drop trigger if exists urgency_updated_at on urgency_rules;
create trigger urgency_updated_at before update on urgency_rules
  for each row execute function set_updated_at();

comment on table urgency_rules is
  'Rules used by urgency_classifier sub-prompt. First match wins, ordered by sort_order ASC.';


-- =============================================================================
-- TABLE: call_logs
-- =============================================================================
create table if not exists call_logs (
  id                  uuid primary key default uuid_generate_v4(),
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  duration_seconds    integer,
  direction           text not null default 'inbound' check (direction in ('inbound','outbound')),
  from_number         text,
  to_did              text,
  mode                text check (mode in ('booking','guest','mixed','unknown')),
  property_id         uuid references properties(id) on delete set null,
  reservation_id      text,
  room_number         text,
  language            text,
  transcript_url      text,
  recording_url       text,
  summary             text,
  outcome             text check (outcome in (
                        'booking_link_sent',
                        'reservation_info_provided',
                        'maintenance_ticket_raised',
                        'troubleshoot_resolved',
                        'transferred_to_human',
                        'unresolved',
                        'abandoned',
                        'spam',
                        'other'
                      )),
  sentiment           text check (sentiment in ('positive','neutral','negative')),
  cost_usd            numeric(8,4),
  tool_calls          jsonb not null default '[]'::jsonb
);

create index if not exists idx_calls_started_desc on call_logs(started_at desc);
create index if not exists idx_calls_property     on call_logs(property_id);
create index if not exists idx_calls_outcome      on call_logs(outcome);
create index if not exists idx_calls_from         on call_logs(from_number);


-- =============================================================================
-- TABLE: maintenance_tickets
-- =============================================================================
create table if not exists maintenance_tickets (
  id                uuid primary key default uuid_generate_v4(),
  property_id       uuid not null references properties(id) on delete restrict,
  room_number       text not null,
  reservation_id    text,
  call_id           uuid references call_logs(id) on delete set null,
  description       text not null,
  urgency           text not null check (urgency in ('critical','high','medium','low')),
  urgency_rule_id   uuid references urgency_rules(id) on delete set null,
  status            text not null default 'open'
                       check (status in ('open','in_progress','resolved','cancelled')),
  notes             text,
  created_via       text not null default 'dashboard' check (created_via in ('call','dashboard')),
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_mt_property        on maintenance_tickets(property_id);
create index if not exists idx_mt_status          on maintenance_tickets(status);
create index if not exists idx_mt_urgency         on maintenance_tickets(urgency);
create index if not exists idx_mt_created_desc    on maintenance_tickets(created_at desc);

drop trigger if exists mt_updated_at on maintenance_tickets;
create trigger mt_updated_at before update on maintenance_tickets
  for each row execute function set_updated_at();

comment on table maintenance_tickets is
  'Maintenance issues. raise_maintenance_ticket tool is NO-OP currently; staff create rows manually via the dashboard until the tool is wired up.';


-- =============================================================================
-- TABLE: booking_links
-- =============================================================================
create table if not exists booking_links (
  id                  uuid primary key default uuid_generate_v4(),
  call_id             uuid references call_logs(id) on delete set null,
  phone               text not null,
  property_name       text not null,
  property_address    text not null,
  guest_name          text not null,
  num_guests          integer not null check (num_guests > 0),
  booking_option      text not null,
  check_in            date not null,
  check_out           date not null,
  generated_url       text,
  sent_at             timestamptz not null default now(),
  clicked_at          timestamptz,
  converted           boolean not null default false,

  constraint dates_valid check (check_out > check_in)
);

create index if not exists idx_bl_call      on booking_links(call_id);
create index if not exists idx_bl_sent_desc on booking_links(sent_at desc);
create index if not exists idx_bl_phone     on booking_links(phone);


-- =============================================================================
-- TABLE: agent_settings   (singleton)
-- =============================================================================
create table if not exists agent_settings (
  id                       uuid primary key default uuid_generate_v4(),
  system_prompt_main       text not null default '(to be defined — edit in the dashboard)',
  greeting_text            text not null default 'Hi, thanks for calling Molo Residence. How can I help you today?',
  transfer_default_phone   text,
  cost_per_min_usd         jsonb not null default
                              '{"telnyx": 0.0085, "livekit_cloud": 0.0075, "gemini_live": 0.045}'::jsonb,
  feature_flags            jsonb not null default '{"record_audio": false}'::jsonb,
  updated_at               timestamptz not null default now(),

  is_singleton             boolean not null default true,
  constraint singleton_only check (is_singleton = true)
);

create unique index if not exists uq_agent_settings_singleton
  on agent_settings (is_singleton);

drop trigger if exists agent_settings_updated_at on agent_settings;
create trigger agent_settings_updated_at before update on agent_settings
  for each row execute function set_updated_at();


-- =============================================================================
-- VIEW: kb_for_room   (resolve KB priority for a (property, room) lookup)
-- =============================================================================
-- Convenience view: returns all KBs that apply to a given (property_id, room_number)
-- with a priority column (exception > property > general).
-- Application code can ORDER BY priority DESC to pick the winning KB or merge them.
create or replace view kb_for_room as
select
  p.id                   as property_id,
  p.name                 as property_name,
  kbr.room_number,
  kb.id                  as kb_id,
  kb.name                as kb_name,
  kb.kind,
  kb.content,
  case kb.kind
    when 'exception' then 3
    when 'property'  then 2
    when 'general'   then 1
  end                    as priority
from properties p
join knowledge_bases kb       on kb.property_id = p.id
left join knowledge_base_rooms kbr on kbr.knowledge_base_id = kb.id;


-- =============================================================================
-- =============================================================================
--                            SEED DATA
-- =============================================================================
-- =============================================================================
-- All inserts use ON CONFLICT DO NOTHING so re-running this script will NOT
-- overwrite anything the client has edited via the dashboard.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SEED: properties  (8 rows)
-- -----------------------------------------------------------------------------
insert into properties (id, name, address, language_default, aliases, notes) values
  ('11111111-1111-1111-1111-000000000001'::uuid,
   'Hotel Molo Residence',
   'Pułaskiego 6a, Sopot',
   'en',
   '["Hotel Molo","Molo Hotel"]'::jsonb,
   '7 hotel rooms. Classic + Superior. KWHotel ID TBD.'),

  ('11111111-1111-1111-1111-000000000002'::uuid,
   'Molo Residence Apartments',
   'Pułaskiego 10b, Sopot',
   'en',
   '["Molo Apartments","Molo Apt"]'::jsonb,
   '11 apartments. SAME BUILDING as Riviera Residence Apartments. Building code 1key1111.'),

  ('11111111-1111-1111-1111-000000000003'::uuid,
   'Riviera Residence Apartments',
   'Pułaskiego 10b, Sopot',
   'en',
   '["Riviera Apartments","Riviera Apt"]'::jsonb,
   '7 apartments. SAME BUILDING as Molo Residence Apartments. Building code 1key1111. Apartment 402 has its own wifi (see exception KB).'),

  ('11111111-1111-1111-1111-000000000004'::uuid,
   'Riviera Rooms',
   'Chopina 40/8, Sopot',
   'en',
   '["Riviera Rooms shared","Riviera shared bath"]'::jsonb,
   '7 rooms with shared bathrooms.'),

  ('11111111-1111-1111-1111-000000000005'::uuid,
   'Boho Rooms',
   'Pułaskiego 6/2, Sopot',
   'en',
   '["Boho","Boho shared","Boho rooms"]'::jsonb,
   '5 rooms with shared bathrooms. SAME BUILDING as Boho Apartment. Building code 2key2222.'),

  ('11111111-1111-1111-1111-000000000006'::uuid,
   'Boho Apartment',
   'Pułaskiego 6/3a, Sopot',
   'en',
   '["Boho Apartament","Boho apt"]'::jsonb,
   '1 two-bedroom apartment (room "3a"). SAME BUILDING as Boho Rooms. Building code 2key2222.'),

  ('11111111-1111-1111-1111-000000000007'::uuid,
   'Apartament Molo Superior',
   'Pułaskiego 17/4, Sopot',
   'en',
   '["Molo Superior","Apartament Molo Superior"]'::jsonb,
   '1 one-bedroom apartment (unit "4"). Standalone.'),

  ('11111111-1111-1111-1111-000000000008'::uuid,
   'Apartament Molo',
   'Chmielewskiego 7/5, Sopot',
   'en',
   '["Apartament Molo Chmielewskiego","Molo Chmielewskiego"]'::jsonb,
   '1 one-bedroom apartment (unit "5"). Standalone.')
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: default general KB
-- -----------------------------------------------------------------------------
insert into knowledge_bases (id, property_id, name, kind, is_default_general, content) values
  ('22222222-2222-2222-2222-000000000001'::uuid,
   null,
   'Default general KB — booking inquiries',
   'general',
   true,
   $kb$
ABOUT MOLO RESIDENCE
We are a portfolio of 8 properties in Sopot, on the Baltic coast of Poland.
Brands: Molo Residence (hotel + apartments), Riviera (apartments + rooms), Boho (rooms + apartment),
plus two standalone units.

LOCATIONS
- Pułaskiego 6a — Hotel Molo Residence (hotel rooms)
- Pułaskiego 10b — Molo Residence Apartments AND Riviera Residence Apartments (same building)
- Chopina 40/8 — Riviera Rooms (rooms with shared bathrooms)
- Pułaskiego 6/2 — Boho Rooms (rooms with shared bathrooms)
- Pułaskiego 6/3a — Boho Apartment (one apartment, same building as Boho Rooms)
- Pułaskiego 17/4 — Apartament Molo Superior
- Chmielewskiego 7/5 — Apartament Molo

ROOM TYPES AVAILABLE ACROSS THE PORTFOLIO
- Hotel rooms: Classic (max 2), Superior (max 3). Hotel Molo Residence only.
- Studio apartments (max 2–4)
- One bedroom apartments (max 4–6), some with balcony
- Two bedroom apartments (max 6–9), some with balcony
- Four bedroom apartments (max 11)
- Rooms with shared bathrooms: Double (max 2), Triple (max 3), Quadruple (max 4). Some with balcony.

LANGUAGES
Staff speak English and Polish.

BOOKING
Most properties are listed on Booking.com (each property has its own listing). Direct bookings
also via the websites moloresidence.pl, rivierasopot.pl, bohorooms.pl.

ABOUT SOPOT
Sopot is famous for its long wooden pier ("molo" in Polish), beach, and the Forest Opera amphitheater.
Most properties are walking distance to the beach and the main pedestrian street (Bohaterów Monte Cassino).
$kb$)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: property KBs (one per property)
-- -----------------------------------------------------------------------------

-- Hotel Molo Residence ----------------------------------------------------
insert into knowledge_bases (id, property_id, name, kind, content) values
  ('22222222-2222-2222-2222-100000000001'::uuid,
   '11111111-1111-1111-1111-000000000001'::uuid,
   'Hotel Molo Residence — main KB',
   'property',
   $kb$
PROPERTY: Hotel Molo Residence
ADDRESS: Pułaskiego 6a, Sopot
WEBSITE: moloresidence.pl
BOOKING.COM: booking.com/Share-poqgCaI

CHECK-IN: 2 PM (14:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 1234#
ROOM ACCESS: card or code (smart lock)

WIFI
  Network: MoloResidence
  Password: molo1234

PARKING
  Private on-site parking, 70 PLN per day extra.

BREAKFAST
  Delivered to the room or served in the dining area between 7 and 11 AM.
  Guests must place their order each day in advance at https://breakfasts.moloresidence.pl/
  by 8 PM the previous evening. Cost: 60 PLN per person.

BATHROOMS
  All rooms have showers. Room 2 also has a bathtub.

KITCHEN
  No in-room kitchen. Minibar and tea-making facilities only.
  Free coffee at reception.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Due to limited space, extra beds are not available — children must share
  the existing bed with a parent. Cot available on request, free of charge.

PETS
  Not allowed.

ROOM TYPES
- Classic room (max 2 guests): rooms 2, 3, 4, 6, 7, 9, 10. Double or twin bed.
- Superior room (max 3 guests): rooms 5, 8. Double or twin bed plus sofa bed.
$kb$),

-- Molo Residence Apartments -----------------------------------------------
  ('22222222-2222-2222-2222-100000000002'::uuid,
   '11111111-1111-1111-1111-000000000002'::uuid,
   'Molo Residence Apartments — main KB',
   'property',
   $kb$
PROPERTY: Molo Residence Apartments
ADDRESS: Pułaskiego 10b, Sopot  (same building as Riviera Residence Apartments)
WEBSITE: moloresidence.pl
BOOKING.COM: booking.com/Share-VeXQYhn

CHECK-IN: 3 PM (15:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 1key1111
APARTMENT ACCESS: card or code (smart lock)

WIFI
  Network: MoloResidence Apartments
  Password: molo1234

PARKING
  Private on-site parking, 70 PLN per day extra.

BREAKFAST
  Delivered to the apartment between 7 and 11 AM.
  Place order each day in advance at https://breakfasts.moloresidence.pl/ by 8 PM the previous evening.
  Cost: 60 PLN per person.

BATHROOMS
  Shower in every apartment.

KITCHEN
  Yes. Refrigerator with freezer, induction cooktop, microwave, coffee and tea facilities,
  coffee machine, basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Due to limited space, extra beds are not available.
  Cot available on request, free of charge.

PETS
  Small dogs up to 5 kg allowed, 60 PLN per night extra.

APARTMENT TYPES
- Studio apartment (max 2): rooms 101, 104, 201, 204. Double or twin bed.
- One bedroom apartment (max 4): rooms 102, 202, 302. Double bed and sofa bed.
- One bedroom apartment with balcony (max 4): rooms 103, 203, 303, 304. Double bed and sofa bed.
$kb$),

-- Riviera Residence Apartments --------------------------------------------
  ('22222222-2222-2222-2222-100000000003'::uuid,
   '11111111-1111-1111-1111-000000000003'::uuid,
   'Riviera Residence Apartments — main KB',
   'property',
   $kb$
PROPERTY: Riviera Residence Apartments
ADDRESS: Pułaskiego 10b, Sopot  (same building as Molo Residence Apartments)
WEBSITE: rivierasopot.pl
BOOKING.COM: booking.com/Share-31Z1oK

CHECK-IN: 4 PM (16:00)
CHECK-OUT: 12 PM (noon)

BUILDING ACCESS CODE: 1key1111
APARTMENT ACCESS: key in the lockbox

WIFI
  Network: Riviera Residence Apartments
  Password: molo1234
  (Apartment 402 has its own dedicated wifi — see the exception KB for that room.)

PARKING
  Private on-site parking, 70 PLN per day extra.

BREAKFAST
  Delivered to the apartment between 7 and 11 AM.
  Place order each day in advance at https://breakfasts.moloresidence.pl/ by 8 PM the previous evening.
  Cost: 60 PLN per person.

BATHROOMS
  Mostly showers. Apartment 105 has two bathrooms with showers and a washing machine.

KITCHEN
  Yes. Refrigerator with freezer, induction cooktop, microwave, tea-making facilities,
  basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Extra beds not available. Cot available on request, free of charge.

PETS
  Small dogs up to 5 kg allowed, 60 PLN per night extra.

APARTMENT TYPES
- Four bedroom apartment (max 11): apartment 105.
    First bedroom: double bed + sofa bed.
    Second bedroom: double bed + sofa bed.
    Third bedroom: double bed.
    Fourth bedroom: single bed.
    Two bathrooms with showers. Washing machine.
- Studio apartment (max 3): apartment 205. Double bed and single bed. Shower.
- Studio apartment (max 4): apartment 206. Two double beds. Shower.
- Two bedroom apartment (max 9): apartment 305. First bedroom: double bed. Second bedroom:
    double bed + sofa bed. Living room: sofa bed. Shower.
- One bedroom apartment with balcony (max 6): apartment 306. Bedroom: double + single + sofa
    bed. Living room: sofa bed. Shower.
- Two bedroom apartment with balcony (max 6): apartment 401. First bedroom: double. Second
    bedroom: double. Living room: sofa bed. Shower.
- Two bedroom apartment (max 6): apartment 402. First bedroom: double. Second bedroom: double
    + sofa bed. Shower. HAS OWN WIFI (see exception).
$kb$),

-- Riviera Rooms -----------------------------------------------------------
  ('22222222-2222-2222-2222-100000000004'::uuid,
   '11111111-1111-1111-1111-000000000004'::uuid,
   'Riviera Rooms — main KB',
   'property',
   $kb$
PROPERTY: Riviera Rooms
ADDRESS: Chopina 40/8, Sopot
WEBSITE: bohorooms.pl
BOOKING.COM: booking.com/Share-zKuRsdd

CHECK-IN: 2 PM (14:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 8key8888
ROOM ACCESS
  Use the building code to enter. Room key is in the lockbox.

WIFI
  Network: Riviera Rooms
  Password: Chopina40m8

PARKING
  Public street parking, OR use our private parking 200 meters away at Pułaskiego 21 for
  70 PLN per day extra. Advance reservation is required.

BREAKFAST
  Not available.

BATHROOMS
  Three shared bathrooms with showers, shared by 7 rooms. Washing machine on site.

KITCHEN
  Shared kitchen. Refrigerator with freezer, induction cooktop, microwave, coffee/tea
  facilities, coffee machine, basic kitchenware and utensils.

TV
  Smart TV with cable channels (in each room).

KIDS POLICY
  Children welcome. Extra beds not available — children must share existing bed with a parent.
  Cot not available.

PETS
  Not allowed.

ROOM TYPES
- Double Room with shared bathroom (max 2): rooms 2, 3, 6, 7. Double bed.
- Double Room with balcony, shared bathroom (max 2): rooms 1, 4. Double bed.
- Quadruple Room with shared bathroom (max 4): room 5. Double bed and sofa bed.
$kb$),

-- Boho Rooms --------------------------------------------------------------
  ('22222222-2222-2222-2222-100000000005'::uuid,
   '11111111-1111-1111-1111-000000000005'::uuid,
   'Boho Rooms — main KB',
   'property',
   $kb$
PROPERTY: Boho Rooms
ADDRESS: Pułaskiego 6/2, Sopot  (same building as Boho Apartment)
WEBSITE: bohorooms.pl
BOOKING.COM: booking.com/Share-zKuRsdd

CHECK-IN: 3 PM (15:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 2key2222
ROOM ACCESS
  Use the building code to enter. Room key is in the lockbox.

WIFI
  Network: Boho Rooms
  Password: boho1234

PARKING
  Restricted traffic zone — no street parking. Use our private parking 150 meters away at
  Pułaskiego 21 for 70 PLN per day extra (regular price 120 PLN). Advance reservation required.

BREAKFAST
  Not available.

BATHROOMS
  Two shared bathrooms with showers and a toilet, shared by 5 rooms. Washing machine on site.

KITCHEN
  Shared kitchen. Refrigerator with freezer, induction cooktop, microwave, coffee/tea
  facilities, coffee machine, basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. No extra beds — children share existing bed with a parent. Cot not available.

PETS
  Not allowed.

ROOM TYPES
- Double Room with shared bathroom (max 2): room 4. Double bed.
- Triple Room with shared bathroom (max 3): rooms 1, 3. Double bed and single bed.
- Quadruple Room with balcony, shared bathroom (max 4): rooms 2, 5. Double bed and sofa bed.
$kb$),

-- Boho Apartment ----------------------------------------------------------
  ('22222222-2222-2222-2222-100000000006'::uuid,
   '11111111-1111-1111-1111-000000000006'::uuid,
   'Boho Apartment — main KB',
   'property',
   $kb$
PROPERTY: Boho Apartment
ADDRESS: Pułaskiego 6/3a, Sopot  (same building as Boho Rooms)
BOOKING.COM: booking.com/Share-jB2u16s

CHECK-IN: 3 PM (15:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 2key2222
APARTMENT ACCESS: code (smart lock)

WIFI
  Network: Boho Apartament
  Password: Boho123456

PARKING
  Private on-site parking, 70 PLN per day extra.

BREAKFAST
  Delivered to the apartment between 7 and 11 AM.
  Place order at https://breakfasts.moloresidence.pl/ by 8 PM the previous evening.
  Cost: 60 PLN per person.

BATHROOMS
  First bathroom with a shower, second bathroom with a bathtub. Washing machine.

KITCHEN
  Yes. Refrigerator with freezer, induction cooktop, microwave, coffee/tea facilities,
  basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Extra beds not available. Cot available on request, free of charge.

PETS
  Not allowed.

APARTMENT
  Two bedroom apartment with balcony (max 7 guests), unit 3a.
    First bedroom: double bed and single bed.
    Second bedroom: double bed.
    Living room: sofa bed.
$kb$),

-- Apartament Molo Superior -----------------------------------------------
  ('22222222-2222-2222-2222-100000000007'::uuid,
   '11111111-1111-1111-1111-000000000007'::uuid,
   'Apartament Molo Superior — main KB',
   'property',
   $kb$
PROPERTY: Apartament Molo Superior
ADDRESS: Pułaskiego 17/4, Sopot
BOOKING.COM: booking.com/Share-hmbBW3

CHECK-IN: 3 PM (15:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 4key4444
APARTMENT ACCESS: code (smart lock)

WIFI
  Network: UPC1525080
  Password: cj66utkhykQG

PARKING
  Restricted traffic zone — no street parking. Use our private parking 30 meters away at
  Pułaskiego 21 for 70 PLN per day extra (regular price 120 PLN). Advance reservation required.

BREAKFAST
  Not available.

BATHROOM
  Shower and bathtub. Washing machine.

KITCHEN
  Yes. Refrigerator with freezer, induction cooktop, microwave, coffee/tea facilities,
  coffee machine, basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Extra beds not available. Cot available on request, free of charge.

PETS
  Small dogs up to 5 kg allowed, 60 PLN per night extra.

APARTMENT
  One bedroom apartment (max 6 guests), unit 4.
    Bedroom: double bed and single bed.
    Living room: sofa bed and single bed.
$kb$),

-- Apartament Molo ---------------------------------------------------------
  ('22222222-2222-2222-2222-100000000008'::uuid,
   '11111111-1111-1111-1111-000000000008'::uuid,
   'Apartament Molo — main KB',
   'property',
   $kb$
PROPERTY: Apartament Molo
ADDRESS: Chmielewskiego 7/5, Sopot
BOOKING.COM: booking.com/Share-hed5ci

CHECK-IN: 3 PM (15:00)
CHECK-OUT: 11 AM

BUILDING ACCESS CODE: 5key5555
APARTMENT ACCESS: key in the lockbox

WIFI
  Network: UPC1615937
  Password: HPDBLXFH

PARKING
  Public street parking.

BREAKFAST
  Not available.

BATHROOM
  Shower. Washing machine.

KITCHEN
  Yes. Refrigerator with freezer, induction cooktop, microwave, coffee/tea facilities,
  basic kitchenware and utensils.

TV
  Smart TV with cable channels.

KIDS POLICY
  Children welcome. Extra beds not available. Cot available on request, free of charge.

PETS
  Small dogs up to 5 kg allowed, 60 PLN per night extra.

APARTMENT
  One bedroom apartment with balcony (max 6 guests), unit 5.
    Bedroom: double bed and single bed.
    Living room: sofa bed and single bed.
$kb$)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: exception KB (room 402 at Riviera has its own wifi)
-- -----------------------------------------------------------------------------
insert into knowledge_bases (id, property_id, name, kind, content) values
  ('22222222-2222-2222-2222-200000000001'::uuid,
   '11111111-1111-1111-1111-000000000003'::uuid,
   'Riviera Apartments — apartment 402 wifi exception',
   'exception',
   $kb$
EXCEPTION FOR APARTMENT 402 at Riviera Residence Apartments

This apartment has its OWN wifi network — different from the rest of the building.
  Network: Riviera Residence 402
  Password: molo1234

Everything else about the apartment matches the property KB (check-in/out times,
building access code, room layout, etc.).
$kb$)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: knowledge_base_rooms  (which rooms each property/exception KB covers)
-- -----------------------------------------------------------------------------
-- General KBs are NOT in this table (they apply to no specific room).
-- Property KBs list every room of the property.
-- Exception KBs list only the rooms they override.

-- Hotel Molo Residence: rooms 2, 3, 4, 5, 6, 7, 8, 9, 10
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000001'::uuid, '2'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '3'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '4'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '5'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '6'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '7'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '8'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '9'),
  ('22222222-2222-2222-2222-100000000001'::uuid, '10')
on conflict (knowledge_base_id, room_number) do nothing;

-- Molo Residence Apartments: 101-104, 201-204, 302-304
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000002'::uuid, '101'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '102'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '103'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '104'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '201'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '202'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '203'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '204'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '302'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '303'),
  ('22222222-2222-2222-2222-100000000002'::uuid, '304')
on conflict (knowledge_base_id, room_number) do nothing;

-- Riviera Residence Apartments: 105, 205, 206, 305, 306, 401, 402
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000003'::uuid, '105'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '205'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '206'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '305'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '306'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '401'),
  ('22222222-2222-2222-2222-100000000003'::uuid, '402')
on conflict (knowledge_base_id, room_number) do nothing;

-- Riviera Rooms: 1-7
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000004'::uuid, '1'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '2'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '3'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '4'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '5'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '6'),
  ('22222222-2222-2222-2222-100000000004'::uuid, '7')
on conflict (knowledge_base_id, room_number) do nothing;

-- Boho Rooms: 1-5
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000005'::uuid, '1'),
  ('22222222-2222-2222-2222-100000000005'::uuid, '2'),
  ('22222222-2222-2222-2222-100000000005'::uuid, '3'),
  ('22222222-2222-2222-2222-100000000005'::uuid, '4'),
  ('22222222-2222-2222-2222-100000000005'::uuid, '5')
on conflict (knowledge_base_id, room_number) do nothing;

-- Boho Apartment: 3a
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000006'::uuid, '3a')
on conflict (knowledge_base_id, room_number) do nothing;

-- Apartament Molo Superior: 4
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000007'::uuid, '4')
on conflict (knowledge_base_id, room_number) do nothing;

-- Apartament Molo: 5
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-100000000008'::uuid, '5')
on conflict (knowledge_base_id, room_number) do nothing;

-- Exception KB: room 402 at Riviera (wifi override)
insert into knowledge_base_rooms (knowledge_base_id, room_number) values
  ('22222222-2222-2222-2222-200000000001'::uuid, '402')
on conflict (knowledge_base_id, room_number) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: urgency_rules  (4 default tiers, editable in dashboard)
-- -----------------------------------------------------------------------------
insert into urgency_rules (id, level, name, examples, keywords, sort_order) values
  ('33333333-3333-3333-3333-000000000001'::uuid,
   'critical',
   'Safety, lockout, or unable to occupy room',
   '["flood","fire","smoke","gas leak","cannot enter the room","locked out","broken window","no heat in winter","intruder"]'::jsonb,
   '["flood","fire","smoke","gas","locked out","intruder","emergency","danger","stuck"]'::jsonb,
   1),

  ('33333333-3333-3333-3333-000000000002'::uuid,
   'high',
   'Essential utilities not working',
   '["no hot water","no water","AC broken in summer","heating not working","toilet broken","fridge not working","broken lock"]'::jsonb,
   '["no hot water","no water","AC","heating","toilet broken","fridge","broken lock"]'::jsonb,
   2),

  ('33333333-3333-3333-3333-000000000003'::uuid,
   'medium',
   'Appliance or comfort issue',
   '["dishwasher not working","TV not working","microwave broken","wifi slow","slow drain","kettle broken"]'::jsonb,
   '["appliance","slow drain","wifi","TV","microwave","dishwasher","kettle"]'::jsonb,
   3),

  ('33333333-3333-3333-3333-000000000004'::uuid,
   'low',
   'Cosmetic or minor',
   '["light bulb out","stain","scuff","minor noise","loose handle","slow draining sink"]'::jsonb,
   '["cosmetic","light bulb","stain","scuff","minor noise","loose"]'::jsonb,
   4)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- SEED: agent_settings (singleton row)
-- -----------------------------------------------------------------------------
insert into agent_settings (system_prompt_main, greeting_text, transfer_default_phone)
values (
  '(to be defined — edit in the dashboard)',
  'Hi, thanks for calling Molo Residence. How can I help you today?',
  null
)
on conflict do nothing;


-- =============================================================================
-- DONE
-- =============================================================================
-- Sanity checks you can run after this script:
--
--   select count(*) from properties;              -- expect 8
--   select count(*) from knowledge_bases;         -- expect 10 (1 general + 8 property + 1 exception)
--   select count(*) from knowledge_base_rooms;    -- expect 43
--   select count(*) from urgency_rules;           -- expect 4
--   select count(*) from agent_settings;          -- expect 1
--   select count(*) from users;                   -- expect 0 (you create the first one below)
--
-- Or browse the convenience view:
--   select * from kb_for_room where room_number = '402';   -- both property + exception KB
--   select * from kb_for_room where room_number = '4';     -- 4 properties (collision case)
--
-- =============================================================================
-- BOOTSTRAP THE FIRST USER  (run this separately, with your own password)
-- =============================================================================
-- The dashboard checks against this table on /login. After this user exists,
-- additional users can be created from the dashboard at /settings/users.
--
-- REPLACE 'your-strong-password' before running, then run just this statement:
--
-- insert into users (username, password_hash, display_name)
-- values ('admin', crypt('your-strong-password', gen_salt('bf')), 'Owner');
--
-- The pgcrypto crypt() function produces a standard bcrypt hash that the
-- Node bcryptjs library reads natively — passwords created in SQL and in the
-- app are interchangeable.
-- =============================================================================
```

After the script finishes, create your first user with your chosen password:

```sql
insert into users (username, password_hash, display_name)
values ('admin', crypt('your-strong-password-here', gen_salt('bf')), 'Owner');
```

Then sign in at `/login`. All further users get created from the dashboard at `/settings/users` — no more SQL needed.
