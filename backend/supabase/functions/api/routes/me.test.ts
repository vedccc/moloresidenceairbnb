import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildMeRoutes } from './me.ts';
import type { AppEnv } from '../lib/types.ts';
import type { TokenClaims } from '../lib/jwt.ts';

// Fake client that records the last update payload so password-hashing can be
// asserted. GET resolves to the single seeded user row.
function fakeClient(
  user: Record<string, unknown> | null,
  sink: { patch?: Record<string, unknown>; id?: unknown },
) {
  return {
    from(_table: string) {
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(_col: string, id: unknown) { sink.id = id; return builder; },
        maybeSingle() { return Promise.resolve({ data: user, error: null }); },
        single() { return Promise.resolve({ data: user, error: user ? null : { message: 'missing' } }); },
        update(patch: Record<string, unknown>) {
          sink.patch = patch;
          return { eq(_c: string, id: unknown) { sink.id = id; return Promise.resolve({ error: null }); } };
        },
      };
      return builder;
    },
  };
}

// Mirror middleware/auth.test.ts: set the user claim before mounting the route,
// so c.get('user') is present (the real /me routes run behind requireAuth).
function app(client: unknown, claims: TokenClaims) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => { c.set('user', claims); await next(); });
  a.route('/me', buildMeRoutes(() => client as never));
  return a;
}

const CLAIMS: TokenClaims = { userId: 'u1', username: 'admin', displayName: 'Admin' };

Deno.test('GET /me returns the profile from the JWT user id', async () => {
  const sink: { patch?: Record<string, unknown>; id?: unknown } = {};
  const client = fakeClient(
    { id: 'u1', username: 'admin', display_name: 'Admin' },
    sink,
  );
  const res = await app(client, CLAIMS).request('/me');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { id: 'u1', username: 'admin', display_name: 'Admin' });
  // The lookup must use the verified JWT id, not anything from the request.
  assertEquals(sink.id, 'u1');
});

Deno.test('PATCH /me updates display_name and returns { ok: true }', async () => {
  const sink: { patch?: Record<string, unknown>; id?: unknown } = {};
  const res = await app(fakeClient({ id: 'u1' }, sink), CLAIMS).request('/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'New Name' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(sink.patch?.display_name, 'New Name');
  assertEquals(sink.id, 'u1');
  // No password supplied → no hash written.
  assertEquals('password_hash' in (sink.patch ?? {}), false);
});

Deno.test('PATCH /me hashes a password (>=8 chars) into password_hash', async () => {
  const sink: { patch?: Record<string, unknown>; id?: unknown } = {};
  const res = await app(fakeClient({ id: 'u1' }, sink), CLAIMS).request('/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'X', password: 'longenough1' }),
  });
  assertEquals(res.status, 200);
  const hash = sink.patch?.password_hash as string;
  // bcrypt hashes start with $2 and must never equal the plaintext.
  assertEquals(typeof hash, 'string');
  assertEquals(hash.startsWith('$2'), true);
  assertEquals(hash === 'longenough1', false);
});

Deno.test('PATCH /me rejects a password shorter than 8 chars with 400', async () => {
  const sink: { patch?: Record<string, unknown>; id?: unknown } = {};
  const res = await app(fakeClient({ id: 'u1' }, sink), CLAIMS).request('/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'short' }),
  });
  assertEquals(res.status, 400);
  // Nothing should have been written.
  assertEquals(sink.patch, undefined);
});

Deno.test('PATCH /me with a malformed body returns 400', async () => {
  const res = await app(fakeClient({ id: 'u1' }, {}), CLAIMS).request('/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assertEquals(res.status, 400);
});
