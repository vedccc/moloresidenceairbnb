# Static + Edge Migration — Slice 1 (Auth + Properties) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the entire static-frontend + Supabase-edge-API path on one resource — stand up the `api` edge function with real `auth/login` (users table + bcrypt) and full `properties` CRUD, convert the login + properties pages to a static client build, deploy both, and verify login→list→create→update→delete works end-to-end against the deployed function.

**Architecture:** A single Supabase Edge Function (`api`, Deno + Hono) holds the service-role key and all DB logic; it exposes JSON routes guarded by a JWT bearer token. The Next.js app builds to a static export (`output: 'export'`) served from a Render `static_site`; pages fetch the `api` function via TanStack Query. No secret ever ships in the static bundle.

**Tech Stack:** Deno, Hono (`jsr:@hono/hono`), jose (`npm:jose`, HS256 JWT), bcryptjs (`npm:bcryptjs`), `@supabase/supabase-js` v2, Next.js static export, TanStack Query, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-12-static-edge-migration-design.md`

---

## Scope of Slice 1

IN: **Task 0 prune** (delete the 3 removed settings modules); `api` function scaffold; CORS + JWT auth middleware; `POST /auth/login`; `GET/POST/PATCH/DELETE /properties` + `POST/DELETE /properties/:id/rooms`; frontend `apiClient`; token storage in `auth-context`; login page conversion; `output: 'export'` + middleware removal; properties page conversion; local + deployed verification.

OUT (later slices): the remaining backend modules to port — `knowledge-bases`, `maintenance`, `calls` (read), `booking-links`, `urgency-rules`, `me`/profile (collapsed single-user `users`), `metrics`; `importRoomsFromKwhotel` (external API — deferred); deleting the old `molo-dashboard` web service (only after all slices land).

**Scope amendment applied (2026-06-12):** `agent-settings`, `cost-rates`, `feature-flags` are **removed**, not ported (Task 0). `users` collapses to a single-account `me` profile (`GET /me`, `PATCH /me`) in a later slice; the DB keeps exactly one user. See the spec's "Scope amendment" section.

## File Structure

**New — edge function (Deno):**
- `supabase/functions/api/deno.json` — import map + tasks
- `supabase/functions/api/index.ts` — Hono app wiring (CORS, auth gate, route mounting)
- `supabase/functions/api/lib/jwt.ts` — sign/verify JWT (jose, HS256)
- `supabase/functions/api/lib/jwt.test.ts` — Deno tests
- `supabase/functions/api/lib/supabase.ts` — service-role client factory
- `supabase/functions/api/middleware/auth.ts` — bearer-token verify middleware
- `supabase/functions/api/middleware/auth.test.ts` — Deno tests
- `supabase/functions/api/routes/auth.ts` — `POST /auth/login`
- `supabase/functions/api/routes/auth.test.ts` — Deno tests (mocked client)
- `supabase/functions/api/routes/properties.ts` — properties CRUD + rooms
- `supabase/functions/api/routes/properties.test.ts` — Deno tests (mocked client)

**New — frontend:**
- `src/lib/api-client.ts` — fetch wrapper (base URL, bearer token, error/401 handling)
- `src/lib/api-client.test.ts` — Vitest
- `src/lib/properties-api.ts` — typed property fetchers/mutators used by the page
- `vitest.config.ts`, `vitest.setup.ts` — test harness

**Modified — frontend:**
- `next.config.ts` — add `output: 'export'`
- `src/lib/auth-context.tsx` — also store/expose the JWT token
- `src/app/login/page.tsx` — call `apiClient` instead of the `loginAction` Server Action
- `src/app/(dashboard)/properties/page.tsx` — Server Component read → client `useQuery`
- `src/app/(dashboard)/properties/properties-client.tsx` and `new-property-drawer.tsx` — Server Action calls → `useMutation` via `properties-api.ts`
- `package.json` — add `vitest`, `@testing-library/*`, test scripts
- delete `middleware.ts`

**Env:**
- `.env.local` / Render static env: `NEXT_PUBLIC_API_URL`
- Supabase function secrets: `SESSION_SECRET` (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by Supabase into edge functions)

---

## Task 0: Prune removed settings modules

Do this first — it shrinks the surface the migration must convert and keeps the
static-export build (Task 12) from tripping on pages we're deleting anyway.

**Files:**
- Delete: `src/app/(dashboard)/settings/agent/` (whole dir)
- Delete: `src/app/(dashboard)/settings/cost-rates/` (whole dir)
- Delete: `src/app/(dashboard)/settings/feature-flags/` (whole dir)
- Delete: `src/backend/agent-settings.ts`, `src/backend/cost-rates.ts`, `src/backend/feature-flags.ts`
- Modify: `src/components/app-sidebar.tsx` (remove the 3 nav entries)

- [ ] **Step 1: Confirm nothing else imports the removed backend modules**

Run: `grep -rn "agent-settings\|cost-rates\|feature-flags" src | grep -v "src/backend/\(agent-settings\|cost-rates\|feature-flags\).ts" | grep -v "settings/\(agent\|cost-rates\|feature-flags\)/"`
Expected: only `src/components/app-sidebar.tsx` matches (the nav). If anything else references them, note it before deleting.

- [ ] **Step 2: Delete the pages and backend modules**

```bash
git rm -r "src/app/(dashboard)/settings/agent" \
         "src/app/(dashboard)/settings/cost-rates" \
         "src/app/(dashboard)/settings/feature-flags" \
         src/backend/agent-settings.ts src/backend/cost-rates.ts src/backend/feature-flags.ts
```

- [ ] **Step 3: Remove the 3 nav entries from the sidebar**

In `src/components/app-sidebar.tsx`, delete the nav items pointing at `/settings/agent`, `/settings/cost-rates`, and `/settings/feature-flags`. Keep `/settings/urgency-rules` and `/settings/users`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (no dangling imports of the removed modules).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove agent/cost-rates/feature-flags settings modules"
```

---

## Task 1: Scaffold the `api` edge function

**Files:**
- Create: `supabase/functions/api/deno.json`
- Create: `supabase/functions/api/index.ts`

- [ ] **Step 1: Create the import map / deno config**

`supabase/functions/api/deno.json`:
```json
{
  "imports": {
    "hono": "jsr:@hono/hono@^4.6.0",
    "hono/cors": "jsr:@hono/hono@^4.6.0/cors",
    "jose": "npm:jose@^5.9.0",
    "bcryptjs": "npm:bcryptjs@^2.4.3",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2.45.0"
  },
  "tasks": {
    "test": "deno test --allow-env --allow-net"
  }
}
```

- [ ] **Step 2: Create the minimal Hono app**

`supabase/functions/api/index.ts`:
```ts
import { Hono } from 'hono';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true }));

Deno.serve(app.fetch);

export default app;
```

- [ ] **Step 3: Serve locally and verify health**

Run: `supabase functions serve api --no-verify-jwt`
Then in another shell: `curl -s http://localhost:54321/functions/v1/api/health`
Expected: `{"ok":true}`

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/api/deno.json supabase/functions/api/index.ts
git commit -m "feat(api): scaffold Supabase edge function with Hono"
```

---

## Task 2: JWT sign/verify utility (TDD)

**Files:**
- Create: `supabase/functions/api/lib/jwt.ts`
- Test: `supabase/functions/api/lib/jwt.test.ts`

- [ ] **Step 1: Write the failing test**

`supabase/functions/api/lib/jwt.test.ts`:
```ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { signToken, verifyToken } from './jwt.ts';

const SECRET = 'test-secret-at-least-32-chars-long-xx';

Deno.test('signToken + verifyToken round-trips the payload', async () => {
  const token = await signToken({ userId: 'u1', username: 'admin', displayName: 'Admin' }, SECRET);
  const payload = await verifyToken(token, SECRET);
  assertEquals(payload.userId, 'u1');
  assertEquals(payload.username, 'admin');
  assertEquals(payload.displayName, 'Admin');
});

Deno.test('verifyToken rejects a bad signature', async () => {
  const token = await signToken({ userId: 'u1', username: 'admin', displayName: null }, SECRET);
  await assertRejects(() => verifyToken(token, 'a-different-secret-also-32-chars-xx'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net lib/jwt.test.ts`
Expected: FAIL — module `./jwt.ts` not found.

- [ ] **Step 3: Write the implementation**

`supabase/functions/api/lib/jwt.ts`:
```ts
import { SignJWT, jwtVerify } from 'jose';

export interface TokenClaims {
  userId: string;
  username: string;
  displayName: string | null;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  return await new SignJWT({ username: claims.username, displayName: claims.displayName })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret));
}

export async function verifyToken(token: string, secret: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, key(secret));
  return {
    userId: String(payload.sub),
    username: String(payload.username ?? ''),
    displayName: (payload.displayName as string | null) ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net lib/jwt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/lib/jwt.ts supabase/functions/api/lib/jwt.test.ts
git commit -m "feat(api): add HS256 JWT sign/verify util"
```

---

## Task 3: Bearer-token auth middleware (TDD)

**Files:**
- Create: `supabase/functions/api/middleware/auth.ts`
- Test: `supabase/functions/api/middleware/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`supabase/functions/api/middleware/auth.test.ts`:
```ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { requireAuth } from './auth.ts';
import { signToken } from '../lib/jwt.ts';

const SECRET = 'test-secret-at-least-32-chars-long-xx';
Deno.env.set('SESSION_SECRET', SECRET);

function appUnderTest() {
  const app = new Hono();
  app.use('*', requireAuth);
  app.get('/x', (c) => c.json({ user: c.get('user') }));
  return app;
}

Deno.test('requireAuth rejects a missing token with 401', async () => {
  const res = await appUnderTest().request('/x');
  assertEquals(res.status, 401);
});

Deno.test('requireAuth passes a valid token and sets c.get("user")', async () => {
  const token = await signToken({ userId: 'u1', username: 'admin', displayName: 'Admin' }, SECRET);
  const res = await appUnderTest().request('/x', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.user.userId, 'u1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net middleware/auth.test.ts`
Expected: FAIL — `./auth.ts` not found.

- [ ] **Step 3: Write the implementation**

`supabase/functions/api/middleware/auth.ts`:
```ts
import type { Context, Next } from 'hono';
import { verifyToken } from '../lib/jwt.ts';

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const secret = Deno.env.get('SESSION_SECRET');
  if (!secret) return c.json({ error: 'Server misconfigured' }, 500);

  try {
    const claims = await verifyToken(token, secret);
    c.set('user', claims);
    await next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net middleware/auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/middleware/auth.ts supabase/functions/api/middleware/auth.test.ts
git commit -m "feat(api): add bearer-token auth middleware"
```

---

## Task 4: Service-role Supabase client factory

**Files:**
- Create: `supabase/functions/api/lib/supabase.ts`

- [ ] **Step 1: Write the factory**

`supabase/functions/api/lib/supabase.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase into
// every edge function — no `supabase secrets set` needed for these two.
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
```

- [ ] **Step 2: Type-check it**

Run: `cd supabase/functions/api && deno check lib/supabase.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/api/lib/supabase.ts
git commit -m "feat(api): add service-role supabase client factory"
```

---

## Task 5: `POST /auth/login` route (TDD, mocked client)

**Files:**
- Create: `supabase/functions/api/routes/auth.ts`
- Test: `supabase/functions/api/routes/auth.test.ts`

The route accepts `{ username, password }`, lowercases the username, looks up `users`, runs `bcrypt.compare`, rejects deactivated accounts, updates `last_login_at`, and returns `{ token, user }`. To keep it testable, the DB lookup is injected via a `findUser` function (default = real Supabase; tests pass a fake).

- [ ] **Step 1: Write the failing test**

`supabase/functions/api/routes/auth.test.ts`:
```ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import bcrypt from 'bcryptjs';
import { buildAuthRoutes, type UserRecord } from './auth.ts';
import { Hono } from 'hono';

Deno.env.set('SESSION_SECRET', 'test-secret-at-least-32-chars-long-xx');

function appWith(user: UserRecord | null) {
  const app = new Hono();
  app.route('/auth', buildAuthRoutes(async () => user));
  return app;
}

Deno.test('login returns a token for valid credentials', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: true,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ADMIN', password: 'molo1234' }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.token, 'string');
  assertEquals(body.user.username, 'admin');
});

Deno.test('login rejects a wrong password with 401', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: true,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assertEquals(res.status, 401);
});

Deno.test('login rejects a deactivated user with 401', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: false,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'molo1234' }),
  });
  assertEquals(res.status, 401);
});

Deno.test('login returns 401 when the user does not exist', async () => {
  const res = await appWith(null).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: 'whatever' }),
  });
  assertEquals(res.status, 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net routes/auth.test.ts`
Expected: FAIL — `./auth.ts` not found.

- [ ] **Step 3: Write the implementation**

`supabase/functions/api/routes/auth.ts`:
```ts
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { signToken } from '../lib/jwt.ts';
import { serviceClient } from '../lib/supabase.ts';

export interface UserRecord {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  is_active: boolean;
}

export type FindUser = (username: string) => Promise<UserRecord | null>;

const defaultFindUser: FindUser = async (username) => {
  const { data } = await serviceClient()
    .from('users')
    .select('id, username, display_name, password_hash, is_active')
    .eq('username', username)
    .maybeSingle();
  return (data as UserRecord | null) ?? null;
};

export function buildAuthRoutes(findUser: FindUser = defaultFindUser) {
  const app = new Hono();

  app.post('/login', async (c) => {
    const { username, password } = await c.req.json().catch(() => ({}));
    if (!username || !password) {
      return c.json({ error: 'Username and password are required.' }, 400);
    }

    const user = await findUser(String(username).trim().toLowerCase());
    if (!user || !user.is_active) {
      return c.json({ error: 'Invalid credentials.' }, 401);
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return c.json({ error: 'Invalid credentials.' }, 401);

    const secret = Deno.env.get('SESSION_SECRET');
    if (!secret) return c.json({ error: 'Server misconfigured' }, 500);

    const token = await signToken(
      { userId: user.id, username: user.username, displayName: user.display_name },
      secret
    );
    return c.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.display_name },
    });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net routes/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/routes/auth.ts supabase/functions/api/routes/auth.test.ts
git commit -m "feat(api): add POST /auth/login with users-table + bcrypt"
```

---

## Task 6: Properties routes (TDD, mocked client)

**Files:**
- Create: `supabase/functions/api/routes/properties.ts`
- Test: `supabase/functions/api/routes/properties.test.ts`

Routes (all assume `requireAuth` has run upstream): `GET /properties` (list + rooms), `POST /properties`, `PATCH /properties/:id`, `DELETE /properties/:id`, `POST /properties/:id/rooms`, `DELETE /properties/:id/rooms`. The Supabase client is injected so tests can supply a fake. The list shape mirrors the current `properties/page.tsx` read.

- [ ] **Step 1: Write the failing test**

`supabase/functions/api/routes/properties.test.ts`:
```ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildPropertyRoutes } from './properties.ts';

// Minimal chainable fake of the supabase-js query builder for the calls we make.
function fakeClient(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {
        _rows: rows,
        select() { return builder; },
        order() { return Promise.resolve({ data: rows, error: null }); },
        eq() { return builder; },
        insert(payload: unknown) {
          return {
            select() {
              return { single() { return Promise.resolve({ data: { id: 'new-id' }, error: null }); } };
            },
          };
        },
        update() { return { eq() { return Promise.resolve({ error: null }); } }; },
        delete() { return { eq() { return Promise.resolve({ error: null }); } }; },
      };
      return builder;
    },
  };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/properties', buildPropertyRoutes(() => client as never));
  return a;
}

Deno.test('GET /properties returns properties with a rooms array', async () => {
  const client = fakeClient({
    properties: [{ id: 'p1', name: 'Old Town', address: 'A', kwhotel_hotel_id: null, transfer_phone: null, aliases: [], language_default: 'pl', timezone: 'Europe/Warsaw', notes: null }],
    property_rooms: [{ property_id: 'p1', room_number: '101' }],
  });
  const res = await app(client).request('/properties');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body[0].id, 'p1');
  assertEquals(body[0].rooms, ['101']);
});

Deno.test('POST /properties returns the new id', async () => {
  const res = await app(fakeClient({})).request('/properties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New', address: 'B', kwhotel_hotel_id: null, transfer_phone: null, aliases: [], language_default: 'pl', timezone: 'Europe/Warsaw', notes: null }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).id, 'new-id');
});

Deno.test('DELETE /properties/:id succeeds', async () => {
  const res = await app(fakeClient({})).request('/properties/p1', { method: 'DELETE' });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net routes/properties.test.ts`
Expected: FAIL — `./properties.ts` not found.

- [ ] **Step 3: Write the implementation**

`supabase/functions/api/routes/properties.ts`:
```ts
import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

export function buildPropertyRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  app.get('/', async (c) => {
    const sb = makeClient();
    const [{ data: properties }, { data: rooms }] = await Promise.all([
      sb.from('properties')
        .select('id, name, address, kwhotel_hotel_id, transfer_phone, aliases, language_default, timezone, notes')
        .order('name', { ascending: true }),
      sb.from('property_rooms').select('property_id, room_number'),
    ]);
    const roomMap: Record<string, string[]> = {};
    for (const r of rooms ?? []) (roomMap[r.property_id] ??= []).push(r.room_number);
    const out = (properties ?? []).map((p: Record<string, unknown>) => ({
      ...p,
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      rooms: (roomMap[p.id as string] ?? []).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })),
    }));
    return c.json(out);
  });

  app.post('/', async (c) => {
    const body = await c.req.json();
    const { data, error } = await makeClient()
      .from('properties').insert(body).select('id').single();
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true, id: data.id });
  });

  app.patch('/:id', async (c) => {
    const patch = await c.req.json();
    const { error } = await makeClient()
      .from('properties').update(patch).eq('id', c.req.param('id'));
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const { error } = await makeClient()
      .from('properties').delete().eq('id', c.req.param('id'));
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
  });

  app.post('/:id/rooms', async (c) => {
    const { room_number } = await c.req.json();
    const { error } = await makeClient()
      .from('property_rooms').insert({ property_id: c.req.param('id'), room_number });
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
  });

  app.delete('/:id/rooms', async (c) => {
    const { room_number } = await c.req.json();
    const { error } = await makeClient()
      .from('property_rooms').delete()
      .eq('property_id', c.req.param('id')).eq('room_number', room_number);
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
  });

  return app;
}
```

Note: the GET fake resolves on `.order()`; the real client also resolves on `.order()` for the properties query and is `await`ed directly for `property_rooms` via `.select()` returning a thenable — supabase-js builders are thenable, so `await sb.from(...).select(...)` works. The test fake models only the methods these routes call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net routes/properties.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/routes/properties.ts supabase/functions/api/routes/properties.test.ts
git commit -m "feat(api): add properties CRUD + rooms routes"
```

---

## Task 7: Wire routes + CORS into the app, verify locally

**Files:**
- Modify: `supabase/functions/api/index.ts`

- [ ] **Step 1: Replace index.ts with full wiring**

`supabase/functions/api/index.ts`:
```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth } from './middleware/auth.ts';
import { buildAuthRoutes } from './routes/auth.ts';
import { buildPropertyRoutes } from './routes/properties.ts';

const app = new Hono().basePath('/api');

// CORS: allow the static frontend origin(s). ALLOWED_ORIGINS is a comma-separated
// list set via `supabase secrets set`; falls back to localhost for dev.
const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:3000')
  .split(',').map((s) => s.trim());
app.use('*', cors({
  origin: origins,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (c) => c.json({ ok: true }));

// Public: login. Everything else requires a valid bearer token.
app.route('/auth', buildAuthRoutes());
app.use('/properties/*', requireAuth);
app.use('/properties', requireAuth);
app.route('/properties', buildPropertyRoutes());

Deno.serve(app.fetch);

export default app;
```

- [ ] **Step 2: Type-check the whole function**

Run: `cd supabase/functions/api && deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Run the full edge test suite**

Run: `cd supabase/functions/api && deno test --allow-env --allow-net`
Expected: PASS — all tests from Tasks 2,3,5,6 green.

- [ ] **Step 4: Manual local smoke test against a seeded DB**

Pre-req: `supabase start` (local stack) with the schema/seed applied, or `supabase functions serve api --env-file ./supabase/.env.local` pointed at the remote project. Set `SESSION_SECRET` in that env file.

Run login, capturing the token:
```bash
TOKEN=$(curl -s -X POST http://localhost:54321/functions/v1/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"molo1234"}' | jq -r .token)
echo "$TOKEN"
curl -s http://localhost:54321/functions/v1/api/properties -H "Authorization: Bearer $TOKEN" | jq 'length'
curl -s http://localhost:54321/functions/v1/api/properties | jq .   # no token
```
Expected: a non-empty token; a JSON array length for the authed call; `{"error":"Unauthorized"}` (401) for the no-token call.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/index.ts
git commit -m "feat(api): wire CORS + auth gate + auth/properties routes"
```

---

## Task 8: Frontend test harness (Vitest)

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `vitest.setup.ts`

- [ ] **Step 1: Install Vitest**

Run: `npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom`
Expected: packages added to devDependencies.

- [ ] **Step 2: Add the config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], globals: true },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

`vitest.setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Add the test script**

In `package.json` `"scripts"`, add: `"test": "vitest run"`.

- [ ] **Step 4: Verify the runner starts (no tests yet)**

Run: `npm test`
Expected: Vitest runs and reports "No test files found" (exit 0 or the no-tests message) — confirms the harness loads.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest.setup.ts
git commit -m "test: add vitest harness"
```

---

## Task 9: `apiClient` fetch wrapper (TDD)

**Files:**
- Create: `src/lib/api-client.ts`
- Test: `src/lib/api-client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/api-client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, setToken, clearToken } from './api-client';

beforeEach(() => {
  clearToken();
  localStorage.clear();
  vi.restoreAllMocks();
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test/api';
});

describe('apiFetch', () => {
  it('attaches the bearer token when set', async () => {
    setToken('tok123');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await apiFetch('/properties');
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok123');
  });

  it('throws with the server error message on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 400 })
    );
    await expect(apiFetch('/properties')).rejects.toThrow('boom');
  });

  it('clears the token and throws on 401', async () => {
    setToken('tok123');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );
    await expect(apiFetch('/properties')).rejects.toThrow();
    expect(localStorage.getItem('molo_token')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/api-client.test.ts`
Expected: FAIL — `./api-client` not found.

- [ ] **Step 3: Write the implementation**

`src/lib/api-client.ts`:
```ts
const TOKEN_KEY = 'molo_token';

export function setToken(token: string) {
  if (typeof window !== 'undefined') localStorage.setItem(TOKEN_KEY, token);
}
export function getToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
}
export function clearToken() {
  if (typeof window !== 'undefined') localStorage.removeItem(TOKEN_KEY);
}

function baseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) throw new Error('NEXT_PUBLIC_API_URL is not set');
  return url.replace(/\/$/, '');
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/api-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "feat(web): add apiClient fetch wrapper with bearer token + 401 handling"
```

---

## Task 10: Store the JWT in auth-context

**Files:**
- Modify: `src/lib/auth-context.tsx`

The context already persists the `User` to `localStorage['molo_session']`. Extend `login` to also store the token via `setToken`, and `logout` to `clearToken`, so `apiClient` and the user state stay in lockstep.

- [ ] **Step 1: Update the imports and signatures**

In `src/lib/auth-context.tsx`, add the import:
```ts
import { setToken, clearToken } from '@/lib/api-client';
```

Change the `login` signature from `login: (user: User) => void` to `login: (user: User, token: string) => void` in the `AuthContextType` interface and the default context value.

- [ ] **Step 2: Update the `login`/`logout` callbacks**

Replace the `login` callback:
```ts
const login = useCallback((u: User, token: string) => {
  localStorage.setItem('molo_session', JSON.stringify(u));
  setToken(token);
  setUser(u);
  router.replace('/');
}, [router]);
```
Replace the `logout` callback body to also clear the token:
```ts
const logout = useCallback(() => {
  localStorage.removeItem('molo_session');
  clearToken();
  setUser(null);
  router.replace('/login');
}, [router]);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the login page is updated in Task 11; if tsc is run before that, the only error will be in `login/page.tsx` — that is expected and resolved next task).

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth-context.tsx
git commit -m "feat(web): persist JWT alongside user in auth-context"
```

---

## Task 11: Convert the login page to apiClient

**Files:**
- Modify: `src/app/login/page.tsx`

Replace the `useActionState(loginAction)` Server Action flow with a client submit that calls `POST /auth/login`, then `auth.login(user, token)`.

- [ ] **Step 1: Rewrite the login page**

`src/app/login/page.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface LoginResponse {
  token: string;
  user: { id: string; username: string; displayName: string | null };
}

export default function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: String(form.get('username') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      });
      login(res.user, res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Molo Residence</CardTitle>
        <CardDescription>Sign in to your account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" type="text" autoComplete="username" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error && <p className="text-sm text-destructive" aria-live="polite">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (`@/backend/auth` is no longer imported here.)

- [ ] **Step 3: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat(web): login page calls edge /auth/login instead of server action"
```

---

## Task 12: Enable static export + remove middleware

**Files:**
- Modify: `next.config.ts`
- Delete: `middleware.ts`
- Create: `.env.local` (local dev value; not committed if gitignored)

- [ ] **Step 1: Add `output: 'export'`**

`next.config.ts`:
```ts
import type { NextConfig } from "next";

// Static export: the dashboard ships as plain files (Render static_site). All
// data + auth go through the Supabase edge function `api`; the browser holds no
// secret. See docs/superpowers/specs/2026-06-12-static-edge-migration-design.md
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
```

- [ ] **Step 2: Delete the middleware**

Run: `git rm middleware.ts`
Rationale: middleware cannot run on a static host; route protection is now the client auth-guard in `auth-context` (UX) plus the edge `requireAuth` gate (real security).

- [ ] **Step 3: Set the local API URL**

Create/append `.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:54321/functions/v1/api
```

- [ ] **Step 4: Verify the build emits a static export**

Run: `npm run build`
Expected: build succeeds and an `out/` directory is produced. If the build errors on a page still using a Server Action or server-only import (e.g. another dashboard page), that is expected at this stage — Slice 1 only guarantees `login` and `properties` are converted. Note any such page; those are handled in later slices. To get a clean Slice-1 build, temporarily confirm at minimum `/login` and `/properties` compile.

Note: if other unconverted pages block `output: 'export'`, keep this task's commit but expect a fully green `npm run build` only after later slices convert the remaining pages. Record the blocking pages in the plan for the next slice.

- [ ] **Step 5: Commit**

```bash
git add next.config.ts
git rm --cached middleware.ts 2>/dev/null; true
git commit -m "feat(web): enable static export, remove server middleware"
```

---

## Task 12b: Client auth shell — mount providers + convert dashboard layout

**Gap discovered during execution:** `AuthProvider` (`src/lib/auth-context.tsx`) was never mounted (dead code), and `(dashboard)/layout.tsx` was an async **Server Component** using `getSession()` + `redirect()` — which cannot run on a static host. With `middleware.ts` deleted (Task 12), the client auth context becomes the *only* route guard, so it must actually be mounted and the layout must be client-side.

Also note the **all-or-nothing static build**: `output: 'export'` builds the entire route tree, and the other ~10 dashboard pages are still `force-dynamic` Server Components. A clean `next build` (and thus the Render deploy, Tasks 15–17) is only possible after *all* pages are converted in later slices. For Slice 1, verification is via `next dev` (which still runs a server, so unconverted pages keep working) against the deployed edge function.

**Files:**
- Create: `src/app/providers.tsx`
- Modify: `src/app/layout.tsx` (wrap children in `<Providers>`)
- Modify: `src/app/(dashboard)/layout.tsx` (Server Component → client guard)
- Modify: `src/components/user-menu.tsx` (logout + displayName via client context, not server action/prop)

- [ ] **Step 1: Create the Providers component**

`src/app/providers.tsx`:
```tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Mount providers in the root layout**

In `src/app/layout.tsx`, import `{ Providers }` and wrap `{children}` (keep `<Toaster>` inside or after — it can stay in the body). The root layout stays a Server Component; `<Providers>` is the client boundary.

- [ ] **Step 3: Convert the dashboard layout to a client guard**

Rewrite `src/app/(dashboard)/layout.tsx` as a client component that no longer imports `getSession`/`redirect`:
```tsx
'use client';

import { useAuth } from '@/lib/auth-context';
import { AppSidebar } from '@/components/app-sidebar';
import { UserMenu } from '@/components/user-menu';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  // AuthProvider's effect redirects to /login when there's no user; render nothing meanwhile.
  if (loading || !user) return null;

  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex h-14 shrink-0 items-center border-b px-6">
          <div className="flex-1" />
          <UserMenu displayName={user.displayName} />
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
```
(A client layout can still render the as-yet-unconverted Server Component child pages via `children` — composition works.)

- [ ] **Step 4: Fix UserMenu logout/displayName**

Read `src/components/user-menu.tsx`. If it calls the server `logoutAction`, switch it to `const { logout } = useAuth();` and call `logout()` (client). Keep accepting `displayName` as a prop (now passed from `useAuth().user.displayName`). Ensure it's a client component (`'use client'`).

- [ ] **Step 5: Verify**

Run `npx tsc --noEmit` → clean. Run `npm run build` and RECORD the output: it is EXPECTED to fail on unconverted `force-dynamic` pages (e.g. knowledge-bases, maintenance, calls, booking-links, settings/*). Confirm the failure is NOT in `/login`, `/` provider wiring, or the dashboard layout — i.e. our converted surface compiles; only the not-yet-migrated pages block the export. List the blocking pages (input to the next slice).

- [ ] **Step 6: Commit**

```bash
git add src/app/providers.tsx src/app/layout.tsx "src/app/(dashboard)/layout.tsx" src/components/user-menu.tsx
git commit -m "feat(web): mount auth+query providers, client-side dashboard guard"
```

---

## Task 13: Properties data module (TDD)

**Files:**
- Create: `src/lib/properties-api.ts`
- Test: `src/lib/properties-api.test.ts`

Typed wrappers the page will call through TanStack Query.

- [ ] **Step 1: Write the failing test**

`src/lib/properties-api.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchProperties, createProperty, deleteProperty } from './properties-api';

beforeEach(() => vi.restoreAllMocks());

describe('properties-api', () => {
  it('fetchProperties GETs /properties', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([{ id: 'p1' }] as never);
    const res = await fetchProperties();
    expect(spy).toHaveBeenCalledWith('/properties');
    expect(res[0].id).toBe('p1');
  });

  it('createProperty POSTs the body', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true, id: 'x' } as never);
    await createProperty({ name: 'N', address: 'A', kwhotel_hotel_id: null, transfer_phone: null, aliases: [], language_default: 'pl', timezone: 'Europe/Warsaw', notes: null });
    expect(spy.mock.calls[0][0]).toBe('/properties');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('deleteProperty DELETEs /properties/:id', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    await deleteProperty('p1');
    expect(spy.mock.calls[0][0]).toBe('/properties/p1');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/properties-api.test.ts`
Expected: FAIL — `./properties-api` not found.

- [ ] **Step 3: Write the implementation**

`src/lib/properties-api.ts`:
```ts
import { apiFetch } from '@/lib/api-client';

export interface PropertyWithRooms {
  id: string;
  name: string;
  address: string;
  kwhotel_hotel_id: number | null;
  transfer_phone: string | null;
  aliases: string[];
  language_default: string;
  timezone: string;
  notes: string | null;
  rooms: string[];
}

export interface PropertyInput {
  name: string;
  address: string;
  kwhotel_hotel_id: number | null;
  transfer_phone: string | null;
  aliases: string[];
  language_default: string;
  timezone: string;
  notes: string | null;
}

export function fetchProperties(): Promise<PropertyWithRooms[]> {
  return apiFetch<PropertyWithRooms[]>('/properties');
}
export function createProperty(input: PropertyInput): Promise<{ ok: boolean; id?: string }> {
  return apiFetch('/properties', { method: 'POST', body: JSON.stringify(input) });
}
export function updateProperty(id: string, patch: Partial<PropertyInput>): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteProperty(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}`, { method: 'DELETE' });
}
export function addRoom(id: string, room_number: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}/rooms`, { method: 'POST', body: JSON.stringify({ room_number }) });
}
export function removeRoom(id: string, room_number: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}/rooms`, { method: 'DELETE', body: JSON.stringify({ room_number }) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/properties-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/properties-api.ts src/lib/properties-api.test.ts
git commit -m "feat(web): typed properties-api wrappers over apiClient"
```

---

## Task 14: Convert the properties page to client + TanStack Query

**Files:**
- Modify: `src/app/(dashboard)/properties/page.tsx`
- Modify: `src/app/(dashboard)/properties/properties-client.tsx`
- Modify: `src/app/(dashboard)/properties/new-property-drawer.tsx`

The page currently reads via `createServerClient()` in a Server Component. Replace with a client component using `useQuery(fetchProperties)`; the existing client children swap their Server Action imports (`@/backend/properties`) for `@/lib/properties-api` wrapped in `useMutation`.

Pre-req: confirm a `QueryClientProvider` exists. If the dashboard layout does not already wrap children in one, add it (TanStack Query is a dependency). Check: `grep -rn "QueryClientProvider" src/app src/lib`.

- [ ] **Step 1: Rewrite `properties/page.tsx` as a client query**

`src/app/(dashboard)/properties/page.tsx`:
```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchProperties } from '@/lib/properties-api';
import { PropertiesList } from './properties-client';
import { NewPropertyDrawer } from './new-property-drawer';

export default function PropertiesPage() {
  const { data: properties = [], isLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Properties</h1>
        <NewPropertyDrawer />
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading properties…</p>
      ) : (
        <PropertiesList properties={properties} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Repoint mutations in the child components**

In `properties-client.tsx` and `new-property-drawer.tsx`:
- Replace imports from `@/backend/properties` with the matching functions from `@/lib/properties-api` (`createProperty`, `updateProperty`, `deleteProperty`, `addRoom`, `removeRoom`).
- Wrap each call in a `useMutation` whose `onSuccess` calls `queryClient.invalidateQueries({ queryKey: ['properties'] })` (this replaces the old `revalidatePath('/properties')`).
- Keep the existing `PropertyWithRooms` type but import it from `@/lib/properties-api` instead of re-declaring it locally if it was defined in the page before.

Example mutation pattern to apply:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteProperty } from '@/lib/properties-api';
// ...
const qc = useQueryClient();
const del = useMutation({
  mutationFn: (id: string) => deleteProperty(id),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'] }),
});
// call: del.mutate(property.id)
```

- [ ] **Step 3: Type-check and run all frontend tests**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all Vitest suites pass.

- [ ] **Step 4: Manual local run**

Pre-req: edge function served locally (Task 7 Step 4) and `NEXT_PUBLIC_API_URL` pointing at it.
Run: `npm run dev`, open `http://localhost:3000/login`, sign in with `admin`/`molo1234`, navigate to Properties.
Expected: properties list loads from the edge function; creating, editing, deleting a property, and adding/removing a room all reflect after the mutation (list refetches).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/properties/"
git commit -m "feat(web): properties page reads/writes via edge api + react-query"
```

---

## Task 15: Deploy the edge function

**Files:** none (deployment).

- [ ] **Step 1: Set function secrets**

Run:
```bash
supabase secrets set SESSION_SECRET="<32+ char secret>" ALLOWED_ORIGINS="https://<your-static-site>.onrender.com"
```
Expected: secrets set confirmation. (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are auto-provided.)

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy api`
Expected: deploy succeeds; note the function URL `https://<ref>.functions.supabase.co/api` (or the `/functions/v1/api` path on the project URL).

- [ ] **Step 3: Verify the deployed function**

Run:
```bash
TOKEN=$(curl -s -X POST "https://<ref>.functions.supabase.co/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"molo1234"}' | jq -r .token)
curl -s "https://<ref>.functions.supabase.co/api/properties" -H "Authorization: Bearer $TOKEN" | jq 'length'
```
Expected: a token, then a properties count. A call without the token returns 401.

---

## Task 16: Deploy the static frontend to Render

**Files:** none (deployment).

- [ ] **Step 1: Point the build at the deployed function**

Set the production env var for the static site build: `NEXT_PUBLIC_API_URL=https://<ref>.functions.supabase.co/api`.

- [ ] **Step 2: Create a fresh Render `static_site`**

In Render: New → Static Site → connect the repo → branch `static-edge-migration`.
- Build command: `npm install && npm run build`
- Publish directory: `out`
- Environment: `NEXT_PUBLIC_API_URL` = the function URL.

(Use a fresh static site rather than the old broken `MoloResidence` to avoid inheriting its bad config; the old one can be deleted later.)

- [ ] **Step 3: Confirm `ALLOWED_ORIGINS` matches the Render URL**

Once Render assigns `https://<app>.onrender.com`, ensure it equals the `ALLOWED_ORIGINS` secret from Task 15 Step 1; re-run `supabase secrets set ALLOWED_ORIGINS=...` and redeploy the function if it differs.

---

## Task 17: End-to-end verification of the deployed slice

**Files:** none (verification — this is the whole point of Slice 1).

- [ ] **Step 1: Cold-load test (the original problem)**

Open the Render static URL in a fresh browser profile. Confirm the page paints **immediately** with no Render "application is starting" interstitial.

- [ ] **Step 2: Auth + CRUD path**

- Sign in with `admin` / `molo1234`. Expect redirect to the dashboard home.
- Go to Properties: the list loads from the edge function.
- Create a property → it appears.
- Edit it → change persists after refetch.
- Add a room, then remove it → reflects.
- Delete the property → it disappears.

- [ ] **Step 3: Auth gate test**

- Open dev tools → Application → Local Storage → delete `molo_token`. Reload Properties.
- Expect a 401 from the API and a redirect to `/login` (no data leaks).
- Confirm the static bundle contains no secret: in dev tools Sources / `grep` the built `out/` for `service_role` / the service key — expect zero matches.

- [ ] **Step 4: Record outcome**

If all pass, Slice 1 is proven. Document any blocking unconverted pages (from Task 12 Step 4) as the input to the Slice 2 plan (remaining 8 modules + read-only pages), after which the old `molo-dashboard` web service is deleted.

---

## Self-Review Notes

- **Spec coverage:** security boundary (no secret in bundle — verified Task 17.3), single edge fn + Hono (Tasks 1,7), JWT bearer session (Tasks 2,3,10), real auth users+bcrypt (Task 5), RLS untouched (service-role only, Task 4), static export + middleware removal (Task 12), TanStack Query frontend (Tasks 13,14), Render static_site + Supabase deploy (Tasks 15,16), incremental slice-first (whole plan scoped to auth+properties). ✅
- **Deferred by design:** other 8 modules, read-only pages, `importRoomsFromKwhotel`, deletion of the old web service — explicitly OUT of Slice 1, gated on a clean full `npm run build` (Task 12 Step 4 caveat).
- **Type consistency:** `apiFetch`/`setToken`/`clearToken` (Task 9) used consistently in Tasks 10,11,13; `login(user, token)` signature changed in Task 10 and consumed in Task 11; `PropertyWithRooms`/`PropertyInput` defined in Task 13 and used in Task 14.
