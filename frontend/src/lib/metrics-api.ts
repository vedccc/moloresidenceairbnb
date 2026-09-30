import { apiFetch } from '@/lib/api-client';

export type RangeKey = 'day' | 'week' | 'month' | 'year';

export interface SeriesPoint {
  date: string;
  count: number;
}

export interface CategoryCount {
  outcome: string;
  count: number;
}

export interface DashboardMetrics {
  range: RangeKey;
  /** How the series is bucketed — drives x-axis label formatting. */
  bucket: 'hour' | 'day' | 'month';
  totalCalls: number;
  totalMinutes: number;
  totalCostUsd: number;
  /** Human minutes the AI handled instead. */
  minutesSaved: number;
  moneySavedEur: number;
  openTickets: number;
  criticalTickets: number;
  highTickets: number;
  series: SeriesPoint[];
  categories: CategoryCount[];
  topTickets: unknown[];
  calls: unknown[];
}

/**
 * Normalise whatever /metrics returns into a complete object.
 *
 * The dashboard is a static bundle on Render while the API is a Supabase edge
 * function, and the two deploy separately — so the browser can be running new
 * code against an older API for a while. Without this, a missing `series` meant
 * `series.length` threw and the whole page rendered as "This page couldn't
 * load". Missing fields now read as empty, which degrades to an empty chart
 * instead of a blank screen.
 */
function normalise(raw: Partial<DashboardMetrics> | null, range: RangeKey): DashboardMetrics {
  const d = raw ?? {};
  return {
    range: d.range ?? range,
    bucket: d.bucket ?? 'day',
    totalCalls: d.totalCalls ?? 0,
    totalMinutes: d.totalMinutes ?? 0,
    totalCostUsd: d.totalCostUsd ?? 0,
    minutesSaved: d.minutesSaved ?? 0,
    moneySavedEur: d.moneySavedEur ?? 0,
    openTickets: d.openTickets ?? 0,
    criticalTickets: d.criticalTickets ?? 0,
    highTickets: d.highTickets ?? 0,
    series: Array.isArray(d.series) ? d.series : [],
    categories: Array.isArray(d.categories) ? d.categories : [],
    topTickets: Array.isArray(d.topTickets) ? d.topTickets : [],
    calls: Array.isArray(d.calls) ? d.calls : [],
  };
}

export async function fetchMetrics(range: RangeKey = 'week'): Promise<DashboardMetrics> {
  const raw = await apiFetch<Partial<DashboardMetrics>>(`/metrics?range=${range}`);
  return normalise(raw, range);
}
