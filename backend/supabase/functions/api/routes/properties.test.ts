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
        // supabase-js query builders are thenable: `await sb.from(t).select(...)`
        // resolves to `{ data, error }`. Model that so chains that end on
        // `.select()` (e.g. the property_rooms query) resolve correctly.
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        select() { return builder; },
        order() { return Promise.resolve({ data: rows, error: null }); },
        eq() { return builder; },
        insert(payload: unknown) {
          // property_rooms insert is awaited directly: `await sb.from(t).insert(...)`.
          const result = { data: { id: 'new-id' }, error: null };
          return {
            select() {
              return {
                single() { return Promise.resolve(result); },
                maybeSingle() { return Promise.resolve(result); },
              };
            },
            then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(onFulfilled);
            },
          };
        },
        update() { return { eq() { return Promise.resolve({ error: null }); } }; },
        delete() {
          // property delete: `.delete().eq(...)`; rooms delete: `.delete().eq().eq()`.
          const eqResult: Record<string, unknown> = {
            eq() { return eqResult; },
            then(onFulfilled: (value: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return { eq() { return eqResult; } };
        },
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

Deno.test('POST /properties with a malformed body returns 400', async () => {
  const res = await app(fakeClient({})).request('/properties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assertEquals(res.status, 400);
});

Deno.test('POST /properties/:id/rooms adds a room', async () => {
  const res = await app(fakeClient({})).request('/properties/p1/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_number: '202' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test('DELETE /properties/:id/rooms removes a room', async () => {
  const res = await app(fakeClient({})).request('/properties/p1/rooms', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_number: '202' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});
