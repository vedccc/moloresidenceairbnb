'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Tables } from '@/backend/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { RelativeTime } from '@/components/shared/relative-time';
import { CopyButton } from '@/components/shared/copy-button';
import { PhoneCall } from 'lucide-react';
import { formatEur, formatEurFromUsd } from '@/lib/money';
import {
  ALL,
  MODE_OPTIONS,
  OUTCOME_OPTIONS,
  callOutcomes,
  filterCalls,
  formatDuration,
  formatDurationLong,
  humanize,
  isEstimatedCost,
  summarize,
  type CallRow,
} from '@/lib/calls-view';

type CallLog = Tables<'call_logs'>;
type Property = Pick<Tables<'properties'>, 'id' | 'name'>;

/**
 * Shared by both sticky header rows.
 *
 * The bottom rule is a box-shadow, not a border: Tailwind collapses table
 * borders, and a collapsed border belongs to the table's border grid rather
 * than to the cell — so it stays behind while the sticky cell scrolls over the
 * rows, leaving the header hanging with no edge. An inset shadow travels with
 * the cell.
 */
const STICKY_CELL =
  'sticky z-20 shadow-[inset_0_-1px_0_var(--border)]';

/**
 * One filter control.
 *
 * Exists so every filter has the SAME label height and the SAME control
 * height. They used to be assembled inline, and a native date input is taller
 * than a select trigger however both are styled — so the row sat at three
 * different heights with the labels stepping up and down with it. Fixing the
 * control row to a single height (`h-9` everywhere, `items-stretch` inside)
 * makes them line up whatever the browser decides a date field should be.
 */
function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="h-4 text-xs leading-4 text-muted-foreground">{label}</Label>
      <div className="flex h-9 items-stretch">{children}</div>
    </div>
  );
}

/**
 * A filter dropdown with an "all" option.
 *
 * `Select.Value` renders the raw selected VALUE unless it is told how to label
 * it — which is why every filter read a literal "__all__" on screen. The
 * function child maps value to label; `placeholder` alone never applies,
 * because "all" is a real selected value rather than an empty one.
 */
function FilterSelect({
  label,
  value,
  onValueChange,
  allLabel,
  options,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const labelFor = (v: unknown) =>
    v === ALL || v == null
      ? allLabel
      : options.find((o) => o.value === v)?.label ?? String(v);

  return (
    <Filter label={label}>
      <Select value={value} onValueChange={(v) => onValueChange((v as string) ?? ALL)}>
        {/* h-9! and not h-9: SelectTrigger sets its height through
            `data-[size=default]:h-8`, and a class+attribute selector outranks a
            plain utility class — so a bare h-9 loses and the trigger stays 32px
            while the date inputs sit at 36px. That 4px is the misalignment. */}
        <SelectTrigger className={`h-9! w-full ${className ?? ''}`}>
          <SelectValue>{labelFor}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Filter>
  );
}

export function CallsList({
  calls,
  properties,
}: {
  calls: CallLog[];
  properties: Property[];
}) {
  // Filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [mode, setMode] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [propertyId, setPropertyId] = useState<string>(ALL);

  const propertyName = useMemo(() => {
    const map = new Map(properties.map((p) => [p.id, p.name]));
    return (id: string | null | undefined): string | null => {
      if (!id) return null;
      return map.get(id) ?? null;
    };
  }, [properties]);

  const filtered = useMemo(
    () =>
      filterCalls(calls as unknown as CallRow[], {
        fromDate,
        toDate,
        mode,
        outcome,
        propertyId,
      }),
    [calls, fromDate, toDate, mode, outcome, propertyId],
  );

  // Totals for the pinned row — of the FILTERED list, so they always describe
  // what is on screen.
  const totals = useMemo(() => summarize(filtered), [filtered]);

  function clearFilters() {
    setFromDate('');
    setToDate('');
    setMode(ALL);
    setOutcome(ALL);
    setPropertyId(ALL);
  }

  const hasFilters =
    !!fromDate || !!toDate || mode !== ALL || outcome !== ALL || propertyId !== ALL;

  return (
    <>
      {/* Filters — a grid, so the columns line up on every breakpoint instead
          of re-wrapping into ragged rows. */}
      <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Filter label="From">
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 w-full py-0 leading-none"
          />
        </Filter>
        <Filter label="To">
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 w-full py-0 leading-none"
          />
        </Filter>

        <FilterSelect
          label="Mode"
          value={mode}
          onValueChange={setMode}
          allLabel="All modes"
          options={MODE_OPTIONS.map((m) => ({ value: m, label: humanize(m) }))}
        />
        <FilterSelect
          label="Outcome"
          value={outcome}
          onValueChange={setOutcome}
          allLabel="All outcomes"
          options={OUTCOME_OPTIONS.map((o) => ({ value: o, label: humanize(o) }))}
        />
        <FilterSelect
          label="Property"
          value={propertyId}
          onValueChange={setPropertyId}
          allLabel="All properties"
          options={properties.map((p) => ({ value: p.id, label: p.name }))}
        />

        <div className="flex h-9 items-center">
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <PhoneCall className="mx-auto mb-3 size-8 text-muted-foreground/60" />
          <p className="text-muted-foreground">
            {hasFilters
              ? 'No calls match the current filters.'
              : 'No calls logged yet. Calls appear here once the voice agent starts handling them.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Table containerClassName="max-h-[calc(100vh-19rem)] min-h-40 overflow-auto rounded-lg border">
            {/* No row borders in the header: a collapsed border adds a pixel to
                the row box, which put the totals row one pixel below the column
                headers — and scrolling rows showed through the gap. The two
                rules are drawn by STICKY_CELL's inset shadow instead, so the
                header block is exactly two 40px rows and `top-10` lands flush. */}
            <TableHeader className="[&_tr]:border-b-0">
              <TableRow className="hover:bg-transparent">
                {['Started', 'Duration', 'From', 'Mode', 'Property', 'Outcome'].map(
                  (head) => (
                    <TableHead key={head} className={`${STICKY_CELL} top-0 bg-background`}>
                      {head}
                    </TableHead>
                  ),
                )}
                <TableHead className={`${STICKY_CELL} top-0 bg-background text-right`}>
                  Cost
                </TableHead>
              </TableRow>

              {/* Totals, pinned under the column headers (top-10 = the header
                  row's own height) so they stay in view while the list scrolls.
                  Each figure sits in ITS OWN column: the duration under
                  Duration, the spend under Cost. */}
              <TableRow className="hover:bg-transparent">
                <TableHead
                  className={`${STICKY_CELL} top-10 bg-muted font-semibold text-foreground`}
                >
                  Total
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {totals.count} {totals.count === 1 ? 'call' : 'calls'}
                    {hasFilters ? ' (filtered)' : ''}
                  </span>
                </TableHead>
                <TableHead
                  className={`${STICKY_CELL} top-10 bg-muted font-semibold text-foreground tabular-nums`}
                >
                  {formatDurationLong(totals.totalSeconds)}
                </TableHead>
                <TableHead className={`${STICKY_CELL} top-10 bg-muted`} colSpan={4} />
                <TableHead
                  className={`${STICKY_CELL} top-10 bg-muted text-right font-semibold text-foreground tabular-nums`}
                >
                  {formatEur(totals.totalCostEur, { decimals: 2 })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((call) => {
                const outcomes = callOutcomes(call);
                const estimated = isEstimatedCost(call);
                return (
                  <TableRow key={call.id} className="group">
                    <TableCell>
                      <Link
                        href={`/calls/detail?id=${call.id}`}
                        className="block hover:underline"
                      >
                        <RelativeTime date={call.started_at} />
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatDuration(call.duration_seconds)}
                    </TableCell>
                    <TableCell>
                      {call.from_number ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                          {call.from_number}
                          <CopyButton text={call.from_number} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="mode" value={call.mode} />
                    </TableCell>
                    <TableCell>
                      {propertyName(call.property_id) ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {/* A call is rarely one thing — every outcome it earned,
                        in rank order, wrapping rather than truncating. */}
                    <TableCell className="whitespace-normal">
                      {outcomes.length === 0 ? (
                        <StatusBadge kind="outcome" value={null} />
                      ) : (
                        <div className="flex max-w-72 flex-wrap gap-1">
                          {outcomes.map((o) => (
                            <StatusBadge key={o} kind="outcome" value={o} />
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {call.cost_usd != null ? (
                        <span
                          className={estimated ? 'text-muted-foreground' : undefined}
                          title={
                            estimated
                              ? 'Estimated from call duration — this call predates per-call usage metering.'
                              : 'Measured from the call’s actual model usage.'
                          }
                        >
                          {estimated ? '~' : ''}
                          {formatEurFromUsd(call.cost_usd)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* Only worth saying while estimates are still in the mix; it stops
              being true on its own as metered calls come in. */}
          {(totals.estimatedCount > 0 || totals.missingCostCount > 0) && (
            <p className="text-xs text-muted-foreground">
              {totals.estimatedCount > 0 && (
                <>
                  <span className="font-medium">~</span> {totals.estimatedCount} of{' '}
                  {totals.count} costs are estimated from call duration rather than
                  measured usage.{' '}
                </>
              )}
              {totals.missingCostCount > 0 && (
                <>
                  {totals.missingCostCount}{' '}
                  {totals.missingCostCount === 1 ? 'call has' : 'calls have'} no cost
                  recorded and {totals.missingCostCount === 1 ? 'is' : 'are'} not in the
                  total.
                </>
              )}
            </p>
          )}
        </div>
      )}
    </>
  );
}
