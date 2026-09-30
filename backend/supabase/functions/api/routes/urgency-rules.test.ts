import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildUrgencyRuleRoutes } from './urgency-rules.ts';

// Records every `.update(patch).eq('id', id)` so the PUT test can assert the
// per-rule update shape was used (mirrors saveUrgencyExamples in the backend).
function fakeClient(tables: Record<string, unknown[]>, updates: Array<{ patch: unknown; id: unknown }>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        select() { return builder; },
        in() { return builder; },
        update(patch: unknown) {
          return {
            eq(_col: string, id: unknown) {
              updates.push({ patch, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return builder;
    },
  };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/urgency-rules', buildUrgencyRuleRoutes(() => client as never));
  return a;
}

Deno.test('GET /urgency-rules returns the rules', async () => {
  const client = fakeClient({
    urgency_rules: [
      { id: 'r1', level: 'critical', name: 'Critical', examples: [], keywords: [], sort_order: 1 },
    ],
  }, []);
  const res = await app(client).request('/urgency-rules');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body[0].id, 'r1');
});

Deno.test('PUT /urgency-rules updates each rule and returns { ok: true }', async () => {
  const updates: Array<{ patch: unknown; id: unknown }> = [];
  const res = await app(fakeClient({}, updates)).request('/urgency-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: [
        { id: 'r1', examples: ['fire'], sort_order: 1 },
        { id: 'r2', examples: ['noise'], sort_order: 2 },
      ],
    }),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(updates.length, 2);
  assertEquals(updates[0].id, 'r1');
  // The id must not leak into the update payload.
  assertEquals((updates[0].patch as Record<string, unknown>).id, undefined);
  assertEquals((updates[0].patch as Record<string, unknown>).examples, ['fire']);
  assertEquals(updates[1].id, 'r2');
});

Deno.test('PUT /urgency-rules with a malformed body returns 400', async () => {
  const res = await app(fakeClient({}, [])).request('/urgency-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assertEquals(res.status, 400);
});

Deno.test('PUT /urgency-rules without a rules array returns 400', async () => {
  const res = await app(fakeClient({}, [])).request('/urgency-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: 'nope' }),
  });
  assertEquals(res.status, 400);
});
