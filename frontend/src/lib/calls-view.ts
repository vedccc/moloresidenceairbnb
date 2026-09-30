/**
 * Pure view logic for the calls page — no React, so it can be tested directly.
 *
 * The page itself is a client component fed by TanStack Query; everything here
 * is the arithmetic and the vocabulary it renders, kept out of the component so
 * "does the total add up" is a unit test rather than a screenshot.
 */

import { usdToEur } from '@/lib/money';

/** A call row as the edge `api` returns it (`select('*')` on `call_logs`). */
export interface CallRow {
  id: string;
  started_at: string;
  duration_seconds?: number | null;
  cost_usd?: number | string | null;
  cost_breakdown?: unknown;
  outcome?: string | null;
  outcomes?: string[] | null;
  mode?: string | null;
  property_id?: string | null;
  from_number?: string | null;
}

/**
 * Every outcome the agent can record, in the order the dashboard ranks them.
 *
 * Mirrors OUTCOMES in backend/agent/src/call_outcomes.py and the CHECK
 * constraint in migration 20260816010000. The two legacy values that migration
 * still accepts (reservation_info_provided, troubleshoot_resolved) are left out
 * on purpose: nothing writes them and no row uses them, so offering them in the
 * filter would only ever return nothing.
 */
export const OUTCOME_OPTIONS = [
  'maintenance_ticket_raised',
  'booking_link_sent',
  'transferred_to_human',
  'reservation_looked_up',
  'availability_checked',
  'transfer_unavailable',
  'question_answered',
  'unresolved',
  'complaint',
  'spam',
  'wrong_number',
  'abandoned',
  'other',
] as const;

export const MODE_OPTIONS = ['booking', 'guest', 'mixed', 'unknown'] as const;

/** "booking_link_sent" -> "Booking Link Sent". */
export function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The outcomes of a call, as a list.
 *
 * Falls back to the singular `outcome` column for calls logged before
 * multi-outcome logging existed — every historical row has one but an empty
 * `outcomes`, and they should still show a badge rather than a dash.
 */
export function callOutcomes(call: CallRow): string[] {
  if (call.outcomes?.length) return call.outcomes;
  return call.outcome ? [call.outcome] : [];
}

/** Does this call carry `outcome`? Used by the Outcome filter. */
export function matchesOutcome(call: CallRow, outcome: string): boolean {
  return callOutcomes(call).includes(outcome);
}

/**
 * Was this cost measured from real usage, or estimated from duration?
 *
 * Backfilled and metrics-less rows carry `measured: false`; the seeded demo
 * rows carry no breakdown at all. Both are estimates, and the table marks them
 * so nobody reconciles one against an invoice and wonders where it went.
 */
export function isEstimatedCost(call: CallRow): boolean {
  if (call.cost_usd == null) return false;
  const breakdown = call.cost_breakdown as { measured?: boolean } | null | undefined;
  return breakdown?.measured !== true;
}

export interface CallsSummary {
  /** Calls in the current view. */
  count: number;
  totalSeconds: number;
  totalCostUsd: number;
  totalCostEur: number;
  /** Calls whose cost is an estimate rather than a measurement. */
  estimatedCount: number;
  /** Calls carrying no cost at all — they contribute nothing to the total. */
  missingCostCount: number;
}

/**
 * The pinned totals row.
 *
 * Summarises the FILTERED list, not the whole table: the number under a
 * "March, booking calls" filter has to be March's booking spend, or the row is
 * worse than useless.
 */
export function summarize(calls: CallRow[]): CallsSummary {
  let totalSeconds = 0;
  let totalCostUsd = 0;
  let estimatedCount = 0;
  let missingCostCount = 0;

  for (const call of calls) {
    totalSeconds += call.duration_seconds ?? 0;
    const cost = call.cost_usd == null ? null : Number(call.cost_usd);
    if (cost == null || !Number.isFinite(cost)) {
      missingCostCount += 1;
    } else {
      totalCostUsd += cost;
      if (isEstimatedCost(call)) estimatedCount += 1;
    }
  }

  return {
    count: calls.length,
    totalSeconds,
    totalCostUsd,
    totalCostEur: usdToEur(totalCostUsd) ?? 0,
    estimatedCount,
    missingCostCount,
  };
}

/** A single call's length, "m:ss". An em dash when it was never recorded. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * A TOTAL length, "3h 28m" / "12m 05s".
 *
 * Deliberately not the "m:ss" form used for one call: three and a half hours of
 * calls reads as "208:30", which nobody parses as hours at a glance.
 */
export function formatDurationLong(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${mins.toString().padStart(2, '0')}m`;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

export interface CallFilters {
  fromDate: string;
  toDate: string;
  mode: string;
  outcome: string;
  propertyId: string;
}

/** The sentinel a filter uses for "no filter" — Select has no empty value. */
export const ALL = '__all__';

/**
 * A "yyyy-mm-dd" from a date input, as a local-time instant.
 *
 * `new Date('2026-08-16')` is parsed as UTC midnight, not local midnight. In
 * Poland (UTC+2 in summer) that put both ends of the range two hours out: "to
 * 16 August" cut off at 21:59 UTC and dropped every call made between midnight
 * and 2am local on the 16th, and "from 16 August" quietly included the last two
 * hours of the 15th. Building the date from its parts pins it to the local day
 * the staff member actually picked.
 */
function localDay(value: string, end: boolean): number | null {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return end
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** Apply the filter bar to the fetched list. Both dates are inclusive. */
export function filterCalls(calls: CallRow[], f: CallFilters): CallRow[] {
  const fromTime = f.fromDate ? localDay(f.fromDate, false) : null;
  const toTime = f.toDate ? localDay(f.toDate, true) : null;

  return calls.filter((call) => {
    const started = new Date(call.started_at).getTime();
    if (fromTime != null && started < fromTime) return false;
    if (toTime != null && started > toTime) return false;
    if (f.mode !== ALL && call.mode !== f.mode) return false;
    if (f.outcome !== ALL && !matchesOutcome(call, f.outcome)) return false;
    if (f.propertyId !== ALL && call.property_id !== f.propertyId) return false;
    return true;
  });
}
