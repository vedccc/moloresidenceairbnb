'use client';

import { cn } from '@/lib/utils';

/**
 * Centralized color-coded pill for every enum the dashboard renders.
 * One color map so a "critical" ticket or "negative" call looks identical everywhere.
 */
export type StatusKind =
  | 'urgency'
  | 'status'
  | 'outcome'
  | 'kind'
  | 'mode'
  | 'sentiment'
  | 'direction';

const COLOR_MAPS: Record<StatusKind, Record<string, string>> = {
  urgency: {
    critical: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
    medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  status: {
    open: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    in_progress:
      'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
    resolved:
      'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    cancelled: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
  // A call carries SEVERAL of these at once (call_logs.outcomes), so they are
  // coloured by KIND rather than all-different: green/emerald = the agent
  // completed something, sky/teal = it looked something up, amber/rose = the
  // caller wanted something they didn't get, slate/zinc = nothing happened.
  // Sitting side by side in one cell, that reads far faster than 13 hues.
  outcome: {
    maintenance_ticket_raised: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
    booking_link_sent: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    transferred_to_human: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
    reservation_looked_up: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    availability_checked: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
    transfer_unavailable: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    question_answered: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    unresolved: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
    complaint: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    spam: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
    wrong_number: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
    abandoned: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    other: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    // Legacy values. Nothing writes them since 2026-08-16 and no row carries
    // one, but the CHECK constraint still accepts them — so if one ever turns
    // up it gets its old colour rather than the unknown-value grey.
    reservation_info_provided: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    troubleshoot_resolved: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  kind: {
    general: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    property: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    exception: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  },
  mode: {
    booking: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    guest: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    mixed: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
    unknown: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
  sentiment: {
    positive: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    negative: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  direction: {
    inbound: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    outbound: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
};

function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function StatusBadge({
  kind,
  value,
  className,
}: {
  kind: StatusKind;
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) {
    return (
      <span
        className={cn(
          'inline-flex h-5 w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium italic',
          'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
          className
        )}
      >
        —
      </span>
    );
  }

  const color =
    COLOR_MAPS[kind][value] ??
    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        color,
        className
      )}
    >
      {humanize(value)}
    </span>
  );
}
