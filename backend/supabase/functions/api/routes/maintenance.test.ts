import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildMaintenanceRoutes } from './maintenance.ts';

// Minimal chainable fake of the supabase-js query builder for the calls we make.
// `_terminal` is what awaiting the builder (or a chain end) resolves to.
function fakeClient(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const single = () =>
        Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } });
      const builder: Record<string, unknown> = {
        // Thenable: `await sb.from(t).select('*')` → list of rows.
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        select() { return builder; },
        order() { return builder; },
        eq() { return builder; },
        single,
        maybeSingle: single,
        update() { return { eq() { return Promise.resolve({ error: null }); } }; },
        insert() { return Promise.resolve({ error: null }); },
      };
      return builder;
    },
  };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/maintenance', buildMaintenanceRoutes(() => client as never));
  return a;
}

Deno.test('GET /maintenance returns the ticket list', async () => {
  const client = fakeClient({
    maintenance_tickets: [
      { id: 't1', property_id: 'p1', room_number: '101', description: 'Leak', urgency: 'high', status: 'open' },
    ],
  });
  const res = await app(client).request('/maintenance');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body[0].id, 't1');
});

Deno.test('GET /maintenance/:id returns a single ticket', async () => {
  const client = fakeClient({
    maintenance_tickets: [{ id: 't1', room_number: '101', status: 'open' }],
  });
  const res = await app(client).request('/maintenance/t1');
  assertEquals(res.status, 200);
  assertEquals((await res.json()).id, 't1');
});

Deno.test('GET /maintenance/:id returns 404 when missing', async () => {
  const res = await app(fakeClient({ maintenance_tickets: [] })).request('/maintenance/nope');
  assertEquals(res.status, 404);
});

Deno.test('PATCH /maintenance/:id returns { ok: true }', async () => {
  const res = await app(fakeClient({})).request('/maintenance/t1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test('PATCH /maintenance/:id with a malformed body returns 400', async () => {
  const res = await app(fakeClient({})).request('/maintenance/t1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assertEquals(res.status, 400);
});

Deno.test('POST /maintenance creates a ticket', async () => {
  const res = await app(fakeClient({})).request('/maintenance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: 'p1', room_number: '101', description: 'Leak', urgency: 'high' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test('POST /maintenance with missing fields returns 400', async () => {
  const res = await app(fakeClient({})).request('/maintenance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_number: '101' }),
  });
  assertEquals(res.status, 400);
});
