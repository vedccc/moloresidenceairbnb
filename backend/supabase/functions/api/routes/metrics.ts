import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

const URGENCY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Labour-saving model ─────────────────────────────────────────────────────
// Every minute the AI spends on a call is a minute a person didn't. The client
// values that at 2 minutes of human labour per AI minute (the call itself plus
// the handling around it), against a 3,000 EUR/month salary.
//
// 160 h/month is the conventional full-time figure (40 h x 4 weeks). These are
// deliberately NOT surfaced in the UI — the dashboard shows the saving, not the
// arithmetic behind it.
const MONTHLY_SALARY_EUR = 3000;
const WORK_HOURS_PER_MONTH = 160;
const HUMAN_MINUTES_PER_AI_MINUTE = 2;
const EUR_PER_HUMAN_MINUTE = MONTHLY_SALARY_EUR / WORK_HOURS_PER_MONTH / 60;

export type RangeKey = 'day' | 'week' | 'month' | 'year';

/** Window start, and how the time series should be bucketed for it. */
export function rangeWindow(range: RangeKey, now = new Date()) {
  const start = new Date(now);
  switch (range) {
    case 'day':
      start.setHours(0, 0, 0, 0);
      return { start, bucket: 'hour' as const };
    case 'week':
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, bucket: 'day' as const };
    case 'year':
      start.setMonth(start.getMonth() - 11, 1);
      start.setHours(0, 0, 0, 0);
      return { start, bucket: 'month' as const };
    case 'month':
    default:
      start.setDate(start.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      return { start, bucket: 'day' as const };
  }
}

/** Bucket key for a timestamp — the x-axis value the chart plots. */
function bucketKey(iso: string, bucket: 'hour' | 'day' | 'month'): string {
  const d = new Date(iso);
  if (bucket === 'hour') return `${d.toISOString().slice(0, 13)}:00`;
  if (bucket === 'month') return `${d.toISOString().slice(0, 7)}-01`;
  return d.toISOString().slice(0, 10);
}

/** Every bucket in the window, including empty ones — a gap in a time series
 *  must read as zero, not as a missing point the line hops over. */
function emptyBuckets(start: Date, end: Date, bucket: 'hour' | 'day' | 'month') {
  const out: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(bucketKey(cur.toISOString(), bucket));
    if (bucket === 'hour') cur.setHours(cur.getHours() + 1);
    else if (bucket === 'month') cur.setMonth(cur.getMonth() + 1);
    else cur.setDate(cur.getDate() + 1);
  }
  return out;
}

interface Ticket {
  id: string;
  urgency: string;
  created_at: string;
  [k: string]: unknown;
}

interface CallRow {
  started_at: string;
  duration_seconds: number | null;
  cost_usd: number | null;
  outcome: string | null;
}

export function buildMetricsRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  app.get('/', async (c) => {
    const sb = makeClient();
    const range = (c.req.query('range') ?? 'week') as RangeKey;
    const { start, bucket } = rangeWindow(
      ['day', 'week', 'month', 'year'].includes(range) ? range : 'week',
    );
    const now = new Date();

    const [callsRes, openTicketsRes, criticalRes, highRes, topTicketsRes, recentCallsRes] =
      await Promise.all([
        sb.from('call_logs')
          .select('started_at, duration_seconds, cost_usd, outcome')
          .gte('started_at', start.toISOString())
          .order('started_at', { ascending: true }),
        sb.from('maintenance_tickets')
          .select('id', { count: 'exact', head: true }).eq('status', 'open'),
        sb.from('maintenance_tickets')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open').eq('urgency', 'critical'),
        sb.from('maintenance_tickets')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open').eq('urgency', 'high'),
        sb.from('maintenance_tickets')
          .select('*')
          .in('status', ['open', 'in_progress'])
          .in('urgency', ['critical', 'high'])
          .order('created_at', { ascending: false }),
        // The scrollable list under the charts. Capped so a busy year doesn't
        // ship thousands of rows to the browser.
        sb.from('call_logs')
          .select('*')
          .gte('started_at', start.toISOString())
          .order('started_at', { ascending: false })
          .limit(200),
      ]);

    const calls = (callsRes.data ?? []) as CallRow[];

    const totalSeconds = calls.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
    const totalCostUsd = calls.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

    const aiMinutes = totalSeconds / 60;
    const humanMinutesSaved = aiMinutes * HUMAN_MINUTES_PER_AI_MINUTE;
    const moneySavedEur = humanMinutesSaved * EUR_PER_HUMAN_MINUTE;

    // Time series — every bucket present, zeros included.
    const counts = new Map<string, number>();
    for (const k of emptyBuckets(start, now, bucket)) counts.set(k, 0);
    for (const r of calls) {
      const k = bucketKey(r.started_at, bucket);
      if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const series = [...counts.entries()].map(([date, count]) => ({ date, count }));

    // Calls by outcome, biggest first.
    const byOutcome = new Map<string, number>();
    for (const r of calls) {
      const k = r.outcome ?? 'other';
      byOutcome.set(k, (byOutcome.get(k) ?? 0) + 1);
    }
    const categories = [...byOutcome.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);

    const topTickets: Ticket[] = ((topTicketsRes.data ?? []) as Ticket[])
      .slice()
      .sort((a, b) => {
        const u = (URGENCY_ORDER[a.urgency] ?? 99) - (URGENCY_ORDER[b.urgency] ?? 99);
        if (u !== 0) return u;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, 5);

    return c.json({
      range,
      bucket,
      totalCalls: calls.length,
      totalMinutes: Math.round(aiMinutes),
      totalCostUsd,
      minutesSaved: Math.round(humanMinutesSaved),
      moneySavedEur,
      openTickets: openTicketsRes.count ?? 0,
      criticalTickets: criticalRes.count ?? 0,
      highTickets: highRes.count ?? 0,
      series,
      categories,
      topTickets,
      calls: recentCallsRes.data ?? [],
    });
  });

  return app;
}
