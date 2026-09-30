import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { Hono } from 'hono';
import { buildMetricsRoutes, rangeWindow } from './metrics.ts';

// The home-page metrics fan out into many parallel queries with different
// shapes (head/count, gte, in, limit). The fake keys its response off the
// chain of methods called so each query resolves to the right rows + count.
function fakeClient(spec: {
  callsToday?: unknown[];
  openCount?: number;
  criticalCount?: number;
  highCount?: number;
  bookings?: unknown[];
  propertiesCount?: number;
  recentCalls?: unknown[];
  topTickets?: unknown[];
}) {
  let countQueue: (number | undefined)[] = [];
  return {
    _resetCounts() { countQueue = []; },
    from(table: string) {
      const state = { head: false, gte: false, hasIn: false, eqs: [] as string[] };
      let rows: unknown[] = [];
      let count: number | undefined;

      const resolve = () => {
        if (table === 'call_logs') {
          rows = state.gte ? (spec.callsToday ?? []) : (spec.recentCalls ?? []);
        } else if (table === 'booking_links') {
          rows = spec.bookings ?? [];
        } else if (table === 'maintenance_tickets') {
          if (state.head) {
            if (state.eqs.includes('critical')) count = spec.criticalCount;
            else if (state.eqs.includes('high')) count = spec.highCount;
            else count = spec.openCount;
            rows = [];
          } else {
            rows = spec.topTickets ?? [];
          }
        } else if (table === 'properties') {
          count = spec.propertiesCount;
          rows = [];
        }
        return { data: rows, count: count ?? null, error: null };
      };

      const builder: Record<string, unknown> = {
        then(onFulfilled: (value: unknown) => unknown) {
          return Promise.resolve(resolve()).then(onFulfilled);
        },
        select(_cols: string, opts?: { head?: boolean }) {
          if (opts?.head) state.head = true;
          return builder;
        },
        gte() { state.gte = true; return builder; },
        eq(_col: string, val: string) { state.eqs.push(val); return builder; },
        in() { state.hasIn = true; return builder; },
        order() { return builder; },
        limit() { return builder; },
      };
      return builder;
    },
  };
}

function app(client: unknown) {
  const a = new Hono();
  a.route('/metrics', buildMetricsRoutes(() => client as never));
  return a;
}

Deno.test('GET /metrics returns the aggregated home-page payload', async () => {
  const client = fakeClient({
    callsToday: [
      { duration_seconds: 120, cost_usd: 0.5 },
      { duration_seconds: 60, cost_usd: 0.25 },
    ],
    openCount: 7,
    criticalCount: 2,
    highCount: 3,
    bookings: [
      { clicked_at: '2026-06-12', converted: true },
      { clicked_at: null, converted: false },
    ],
    propertiesCount: 8,
    recentCalls: [{ id: 'c1' }, { id: 'c2' }],
    topTickets: [
      { id: 't1', urgency: 'high', created_at: '2026-06-10' },
      { id: 't2', urgency: 'critical', created_at: '2026-06-09' },
    ],
  });
  const res = await app(client).request('/metrics');
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.callsToday, 2);
  assertEquals(body.durationTodaySeconds, 180);
  assertEquals(body.costTodayUsd, 0.75);
  assertEquals(body.openTickets, 7);
  assertEquals(body.criticalTickets, 2);
  assertEquals(body.highTickets, 3);
  assertEquals(body.bookingLinks7d, 2);
  assertEquals(body.bookingCtr, '50%');
  assertEquals(body.bookingConv, '50%');
  assertEquals(body.activeProperties, 8);
  assertEquals(body.recentCalls.length, 2);
  // topTickets sorted by urgency (critical before high), capped at 5.
  assertEquals(body.topTickets[0].id, 't2');
  assertEquals(body.topTickets[1].id, 't1');
});

Deno.test('rangeWindow buckets each range the way the chart expects', () => {
  const now = new Date('2026-08-16T14:30:00Z');
  assertEquals(rangeWindow('day', now).bucket, 'hour');
  assertEquals(rangeWindow('week', now).bucket, 'day');
  assertEquals(rangeWindow('month', now).bucket, 'day');
  assertEquals(rangeWindow('year', now).bucket, 'month');
});

Deno.test('rangeWindow starts each window at the right point', () => {
  const now = new Date('2026-08-16T14:30:00Z');
  // Day starts at local midnight today, not 24h ago.
  const day = rangeWindow('day', now).start;
  assertEquals(day.getHours(), 0);
  // Week is 7 days INCLUSIVE of today, so the start is 6 days back.
  const week = rangeWindow('week', now).start;
  assertEquals(Math.round((now.getTime() - week.getTime()) / 86400000), 6);
});
