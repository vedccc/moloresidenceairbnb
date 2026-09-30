import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildCallRoutes } from './calls.ts';

// Chainable fake. Each table resolves to its rows; chains ending in
// `.single()` / `.maybeSingle()` resolve to the first row.
function fakeClient(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const single = () =>
        Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } });
      const builder: Record<string, unknown> = {
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        select() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        eq() { return builder; },
        single,
        maybeSingle: single,
      };
      return builder;
    },
  };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/calls', buildCallRoutes(() => client as never));
  return a;
}

Deno.test('GET /calls returns the call list ordered by started_at', async () => {
  const client = fakeClient({
    call_logs: [
      { id: 'c1', started_at: '2026-06-12T10:00:00Z', mode: 'voice', outcome: 'resolved' },
    ],
  });
  const res = await app(client).request('/calls');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body[0].id, 'c1');
});

Deno.test('GET /calls/:id returns the call with linked detail fields', async () => {
  const client = fakeClient({
    call_logs: [
      { id: 'c1', property_id: 'p1', transcript: [{ role: 'user', text: 'hi' }], recording_url: 'r.mp3', tool_trace: [{ tool: 'lookup' }] },
    ],
    properties: [{ name: 'Old Town' }],
    agent_settings: [{ cost_per_min_usd: { voice: 0.1 } }],
    maintenance_tickets: [{ id: 't1', room_number: '101', status: 'open', urgency: 'high' }],
    booking_links: [{ id: 'b1', guest_name: 'Anna', converted: true }],
  });
  const res = await app(client).request('/calls/c1');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.call.id, 'c1');
  assertEquals(body.call.transcript[0].text, 'hi');
  assertEquals(body.propertyName, 'Old Town');
  assertEquals(body.costRates, { voice: 0.1 });
  assertEquals(body.tickets[0].id, 't1');
  assertEquals(body.bookings[0].id, 'b1');
});

Deno.test('GET /calls/:id returns 404 when the call is missing', async () => {
  const res = await app(fakeClient({ call_logs: [] })).request('/calls/nope');
  assertEquals(res.status, 404);
});

Deno.test('DELETE /calls/:id/transcript clears the transcript but keeps the call', async () => {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from() {
      const single = () => Promise.resolve({ data: { id: 'c1' }, error: null });
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        single,
        maybeSingle: single,
        update(patch: Record<string, unknown>) { updates.push(patch); return builder; },
        then(onFulfilled: (v: { data: null; error: null }) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
  const res = await app(client).request('/calls/c1/transcript', { method: 'DELETE' });
  assertEquals(res.status, 200);
  // Only `summary` (which holds the transcript) is nulled. Anything else in the
  // patch would risk the call metrics that the dashboard home is built on.
  assertEquals(updates, [{ summary: null }]);
});

Deno.test('DELETE /calls/:id/transcript 404s for an unknown call', async () => {
  const client = {
    from() {
      const single = () => Promise.resolve({ data: null, error: null });
      const builder: Record<string, unknown> = {
        select() { return builder; }, eq() { return builder; },
        single, maybeSingle: single,
        update() { throw new Error('must not update a call that does not exist'); },
      };
      return builder;
    },
  };
  const res = await app(client).request('/calls/nope/transcript', { method: 'DELETE' });
  assertEquals(res.status, 404);
});
