import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildKnowledgeBaseRoutes } from './knowledge-bases.ts';

// Recorder for the mutations the routes perform so tests can assert query shapes.
interface Calls {
  updates: Array<{ table: string; patch: Record<string, unknown>; eq: Array<[string, unknown]> }>;
  inserts: Array<{ table: string; payload: unknown }>;
  deletes: Array<{ table: string; eq: Array<[string, unknown]> }>;
}

// Minimal chainable fake of the supabase-js query builder for the calls we make.
function fakeClient(tables: Record<string, unknown[]>, calls: Calls) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {
        // Thenable so chains that end on `.select()` / `.order()` resolve to
        // `{ data, error }` when awaited.
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        select() { return builder; },
        order() {
          // Used both as a terminal (await ...order()) and mid-chain.
          const term: Record<string, unknown> = {
            then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
            },
            order() { return term; },
          };
          return term;
        },
        eq() { return builder; },
        neq() { return builder; },
        single() { return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }); },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        insert(payload: unknown) {
          calls.inserts.push({ table, payload });
          const result = { data: { id: 'new-id' }, error: null };
          return {
            select() {
              return {
                single() { return Promise.resolve(result); },
                maybeSingle() { return Promise.resolve(result); },
              };
            },
            then(onFulfilled: (value: { data: null; error: null }) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(onFulfilled);
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const eqs: Array<[string, unknown]> = [];
          const rec = { table, patch, eq: eqs };
          const chain: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              calls.updates.push(rec);
              return Promise.resolve({ error: null });
            },
          };
          return chain;
        },
        delete() {
          const eqs: Array<[string, unknown]> = [];
          const rec = { table, eq: eqs };
          calls.deletes.push(rec);
          const chain: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              return chain;
            },
            then(onFulfilled: (value: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return chain;
        },
      };
      return builder;
    },
  };
}

function emptyCalls(): Calls {
  return { updates: [], inserts: [], deletes: [] };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/knowledge-bases', buildKnowledgeBaseRoutes(() => client as never));
  return a;
}

Deno.test('GET /knowledge-bases returns rows including is_default_general', async () => {
  const client = fakeClient({
    knowledge_bases: [
      { id: 'k1', name: 'General', content: 'hi', updated_at: '2026-01-01', is_default_general: true, knowledge_base_rooms: [{ room_number: '101' }] },
    ],
  }, emptyCalls());
  const res = await app(client).request('/knowledge-bases');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body[0].id, 'k1');
  assertEquals(body[0].is_default_general, true);
  assertEquals(body[0].knowledge_base_rooms[0].room_number, '101');
});

Deno.test('GET /knowledge-bases/general returns the flagged row', async () => {
  const client = fakeClient({
    knowledge_bases: [
      { id: 'k1', name: 'General', content: 'hi', updated_at: '2026-01-01', is_default_general: true },
    ],
  }, emptyCalls());
  const res = await app(client).request('/knowledge-bases/general');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.id, 'k1');
  assertEquals(body.is_default_general, true);
});

Deno.test('GET /knowledge-bases/general returns null when none flagged', async () => {
  const client = fakeClient({ knowledge_bases: [] }, emptyCalls());
  const res = await app(client).request('/knowledge-bases/general');
  assertEquals(res.status, 200);
  assertEquals(await res.json(), null);
});

Deno.test('GET /knowledge-bases/:id returns the detail bundle', async () => {
  const client = fakeClient({
    knowledge_bases: [{ id: 'k1', name: 'General', content: 'hi', is_default_general: true }],
    properties: [{ id: 'p1', name: 'Old Town' }],
    property_rooms: [{ property_id: 'p1', room_number: '101' }],
    knowledge_base_rooms: [{ room_number: '101', knowledge_base_id: 'k1', knowledge_bases: { id: 'k1', name: 'General', property_id: null } }],
  }, emptyCalls());
  const res = await app(client).request('/knowledge-bases/k1');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.kb.id, 'k1');
  assertEquals(body.properties[0].id, 'p1');
  assertEquals(body.propRooms[0].room_number, '101');
  assertEquals(body.allKbRooms[0].knowledge_base_id, 'k1');
});

Deno.test('POST /knowledge-bases creates a KB and returns the new id', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '  New KB  ' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).id, 'new-id');
  assertEquals(calls.inserts.length, 1);
  const payload = calls.inserts[0].payload as Record<string, unknown>;
  assertEquals(payload.name, 'New KB');
  assertEquals(payload.kind, 'general');
  assertEquals(payload.property_id, null);
  assertEquals(payload.content, '');
  // No general flag was requested, so no updates ran.
  assertEquals(calls.updates.length, 0);
});

Deno.test('POST /knowledge-bases {general:true} triggers the set-general path', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Primary', general: true }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).id, 'new-id');
  // setDefaultGeneralKb(newId, true): first unset existing general, then set this one.
  assertEquals(calls.updates.length, 2);
  assertEquals(calls.updates[0].patch.is_default_general, false);
  assertEquals(calls.updates[0].eq[0], ['is_default_general', true]);
  assertEquals(calls.updates[1].patch.is_default_general, true);
  assertEquals(calls.updates[1].eq[0], ['id', 'new-id']);
});

Deno.test('PATCH /knowledge-bases/:id updates name and content', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '  Renamed  ', content: 'new body' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.updates.length, 1);
  assertEquals(calls.updates[0].patch.name, 'Renamed');
  assertEquals(calls.updates[0].patch.content, 'new body');
  assertEquals(calls.updates[0].eq[0], ['id', 'k1']);
});

Deno.test('PATCH /knowledge-bases/:id with no recognized fields returns 400', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(calls.updates.length, 0);
});

Deno.test('POST /knowledge-bases/:id/general {value:true} unsets others then sets this one', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k2/general', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: true }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.updates.length, 2);
  assertEquals(calls.updates[0].patch.is_default_general, false);
  assertEquals(calls.updates[0].eq[0], ['is_default_general', true]);
  assertEquals(calls.updates[1].patch.is_default_general, true);
  assertEquals(calls.updates[1].eq[0], ['id', 'k2']);
});

Deno.test('POST /knowledge-bases/:id/general {value:false} only updates this row', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k2/general', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: false }),
  });
  assertEquals(res.status, 200);
  assertEquals(calls.updates.length, 1);
  assertEquals(calls.updates[0].patch.is_default_general, false);
  assertEquals(calls.updates[0].eq[0], ['id', 'k2']);
});

Deno.test('PUT /knowledge-bases/:id/rooms deletes then inserts the property-scoped set', async () => {
  const calls = emptyCalls();
  // No existing knowledge_base_rooms rows -> no conflict.
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1/rooms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rooms: [
      { property_id: 'p1', room_number: '101' },
      { property_id: 'p2', room_number: '102' },
    ] }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.deletes.length, 1);
  assertEquals(calls.deletes[0].table, 'knowledge_base_rooms');
  assertEquals(calls.deletes[0].eq[0], ['knowledge_base_id', 'k1']);
  assertEquals(calls.inserts.length, 1);
  assertEquals(calls.inserts[0].payload, [
    { knowledge_base_id: 'k1', property_id: 'p1', room_number: '101' },
    { knowledge_base_id: 'k1', property_id: 'p2', room_number: '102' },
  ]);
});

Deno.test('PUT /knowledge-bases/:id/rooms rejects a room owned by another KB', async () => {
  const calls = emptyCalls();
  // Another KB already owns (p1, 101).
  const client = fakeClient(
    { knowledge_base_rooms: [
      { property_id: 'p1', room_number: '101', knowledge_base_id: 'kOther', knowledge_bases: { name: 'Riviera Rooms' } },
    ] },
    calls,
  );
  const res = await app(client).request('/knowledge-bases/k1/rooms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rooms: [{ property_id: 'p1', room_number: '101' }] }),
  });
  assertEquals(res.status, 409);
  const payload = await res.json();
  assertEquals(payload.conflicts[0].kb, 'Riviera Rooms');
  // Nothing was deleted or inserted.
  assertEquals(calls.deletes.length, 0);
  assertEquals(calls.inserts.length, 0);
});

Deno.test('PUT /knowledge-bases/:id/rooms with empty list deletes only', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1/rooms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rooms: [] }),
  });
  assertEquals(res.status, 200);
  assertEquals(calls.deletes.length, 1);
  assertEquals(calls.inserts.length, 0);
});

Deno.test('DELETE /knowledge-bases/:id/rooms removes a single room assignment', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k9/rooms', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomNumber: '101' }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.deletes.length, 1);
  assertEquals(calls.deletes[0].table, 'knowledge_base_rooms');
  assertEquals(calls.deletes[0].eq[0], ['knowledge_base_id', 'k9']);
  assertEquals(calls.deletes[0].eq[1], ['room_number', '101']);
});

Deno.test('DELETE /knowledge-bases/:id/rooms honors otherKbId override', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1/rooms', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otherKbId: 'k7', roomNumber: '202' }),
  });
  assertEquals(res.status, 200);
  assertEquals(calls.deletes[0].eq[0], ['knowledge_base_id', 'k7']);
  assertEquals(calls.deletes[0].eq[1], ['room_number', '202']);
});

Deno.test('DELETE /knowledge-bases/:id deletes room assignments then the KB', async () => {
  const calls = emptyCalls();
  const res = await app(fakeClient({}, calls)).request('/knowledge-bases/k1', { method: 'DELETE' });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.deletes.length, 2);
  assertEquals(calls.deletes[0].table, 'knowledge_base_rooms');
  assertEquals(calls.deletes[0].eq[0], ['knowledge_base_id', 'k1']);
  assertEquals(calls.deletes[1].table, 'knowledge_bases');
  assertEquals(calls.deletes[1].eq[0], ['id', 'k1']);
});

Deno.test('POST /knowledge-bases with a malformed body returns 400', async () => {
  const res = await app(fakeClient({}, emptyCalls())).request('/knowledge-bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assertEquals(res.status, 400);
});
