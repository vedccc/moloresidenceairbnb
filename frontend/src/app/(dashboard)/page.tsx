'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMetrics, type RangeKey } from '@/lib/metrics-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/shared/relative-time';
import { StatusBadge } from '@/components/shared/status-badge';
import { CallsOverTime, CallsByCategory } from '@/components/shared/call-charts';
import { WrenchIcon, ArrowRight } from 'lucide-react';
import type { Tables } from '@/backend/types';
import { RefreshButton } from './refresh-button';

type CallLog = Tables<'call_logs'>;
type Ticket = Tables<'maintenance_tickets'>;

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Minutes as "3h 20m" — hours read faster than a four-digit minute count. */
function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeKey>('week');

  const { data, isLoading } = useQuery({
    queryKey: ['metrics', range],
    queryFn: () => fetchMetrics(range),
    // Keeps the previous range on screen while the new one loads, so switching
    // tabs doesn't blank the whole page.
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-muted-foreground">
            Overview of your Molo Residence operations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Filters in one row above the charts */}
          <div className="flex rounded-md border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                aria-pressed={range === r.key}
                className={`rounded px-3 py-1 text-sm transition-colors ${
                  range === r.key
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <RefreshButton
            onClick={() => queryClient.invalidateQueries({ queryKey: ['metrics'] })}
          />
        </div>
      </div>

      {!data ? (
        <p className="text-sm text-muted-foreground">
          {isLoading ? 'Loading metrics…' : 'No data.'}
        </p>
      ) : (
        <>
          {/* Stat tiles — bare numbers, no plot, so no hover layer. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Calls handled" value={data.totalCalls.toLocaleString()} />
            <Stat label="Time on calls" value={formatMinutes(data.totalMinutes)} />
            <Stat label="Staff time saved" value={formatMinutes(data.minutesSaved)} />
            <Stat
              label="Staff cost saved"
              value={`€${Math.round(data.moneySavedEur).toLocaleString()}`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Calls over time</CardTitle>
              </CardHeader>
              <CardContent>
                <CallsOverTime series={data.series} bucket={data.bucket} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Calls by outcome</CardTitle>
              </CardHeader>
              <CardContent>
                <CallsByCategory categories={data.categories} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Open maintenance — kept */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm font-medium">Open maintenance</CardTitle>
                  <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/maintenance" />}>
                    View all
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-baseline gap-4">
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{data.openTickets}</div>
                    <div className="text-xs text-muted-foreground">open</div>
                  </div>
                  {data.criticalTickets > 0 && (
                    <div>
                      <div className="text-2xl font-semibold tabular-nums">{data.criticalTickets}</div>
                      <div className="text-xs text-muted-foreground">critical</div>
                    </div>
                  )}
                  {data.highTickets > 0 && (
                    <div>
                      <div className="text-2xl font-semibold tabular-nums">{data.highTickets}</div>
                      <div className="text-xs text-muted-foreground">high</div>
                    </div>
                  )}
                </div>

                {(data.topTickets as Ticket[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing urgent open.</p>
                ) : (
                  <ul className="space-y-2">
                    {(data.topTickets as Ticket[]).map((t) => (
                      <li key={t.id}>
                        <Link
                          href={`/maintenance/detail?id=${t.id}`}
                          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                        >
                          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">Room {t.room_number}</span>
                          <span className="ml-auto shrink-0">
                            <StatusBadge kind="urgency" value={t.urgency} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* All calls in the selected range, scrollable */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm font-medium">
                    Calls
                    <span className="ml-2 font-normal text-muted-foreground">
                      {data.calls.length}
                      {data.calls.length === 200 ? '+' : ''}
                    </span>
                  </CardTitle>
                  <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/calls" />}>
                    View all
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {(data.calls as CallLog[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No calls in this period.</p>
                ) : (
                  <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
                    {(data.calls as CallLog[]).map((call) => (
                      <li key={call.id}>
                        <Link
                          href={`/calls/detail?id=${call.id}`}
                          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                        >
                          <span className="w-28 shrink-0 text-muted-foreground">
                            <RelativeTime date={call.started_at} />
                          </span>
                          <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                            {formatDuration(call.duration_seconds)}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {call.from_number ?? (
                              <span className="font-sans italic text-muted-foreground">
                                number removed
                              </span>
                            )}
                          </span>
                          <span className="shrink-0">
                            <StatusBadge kind="outcome" value={call.outcome} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
