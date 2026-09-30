'use client';

/**
 * Dashboard charts, as inline SVG.
 *
 * No charting library on purpose: the dashboard is a static export served from
 * Render, and a chart lib is a large dependency for two simple forms. Both
 * charts are a single series, so they carry no legend — the card title names
 * what is plotted (a legend box for one series is noise).
 *
 * Marks use vector-effect="non-scaling-stroke" with preserveAspectRatio="none",
 * so the SVG stretches to the container width while stroke weights stay exactly
 * 2px instead of being scaled into wedges.
 */

import { useState } from 'react';
import type { SeriesPoint, CategoryCount } from '@/lib/metrics-api';

// Single-series blue. Validated against both surfaces (light #ffffff, dark
// #09090b): inside the lightness band, above the chroma floor, >= 3:1 contrast.
const SERIES = 'var(--chart-series-1)';

const VB_W = 800;
const VB_H = 220;
const PAD = { top: 12, right: 8, bottom: 24, left: 32 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

function formatBucket(date: string, bucket: 'hour' | 'day' | 'month'): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  if (bucket === 'hour') return d.toLocaleTimeString(undefined, { hour: 'numeric' });
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Calls over time — area with a gradient fill under a 2px line. */
export function CallsOverTime({
  series,
  bucket,
}: {
  series: SeriesPoint[];
  bucket: 'hour' | 'day' | 'month';
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (series.length === 0) {
    return <EmptyPlot label="No calls in this period." />;
  }

  const max = niceMax(Math.max(...series.map((p) => p.count), 0));
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.count)}`).join(' ');
  const area =
    `M${x(0)},${PAD.top + plotH} ` +
    series.map((p, i) => `L${x(i)},${y(p.count)}`).join(' ') +
    ` L${x(series.length - 1)},${PAD.top + plotH} Z`;

  // Roughly one label per 90px of plot, so ticks never collide.
  const step = Math.max(1, Math.ceil(series.length / Math.floor(plotW / 90)));
  const active = hover != null ? series[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="h-[220px] w-full"
        role="img"
        aria-label={`Calls per ${bucket}`}
      >
        <defs>
          <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES} stopOpacity="0.28" />
            <stop offset="100%" stopColor={SERIES} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive gridlines + y labels */}
        {[0, 0.5, 1].map((f) => {
          const gy = PAD.top + plotH - f * plotH;
          return (
            <g key={f}>
              <line
                x1={PAD.left} y1={gy} x2={VB_W - PAD.right} y2={gy}
                stroke="var(--chart-grid)" strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={PAD.left - 6} y={gy + 3} textAnchor="end"
                className="fill-muted-foreground" style={{ fontSize: 9 }}
              >
                {Math.round(f * max)}
              </text>
            </g>
          );
        })}

        <path d={area} fill="url(#callsFill)" />
        <path
          d={line} fill="none" stroke={SERIES} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active && hover != null && (
          <>
            <line
              x1={x(hover)} y1={PAD.top} x2={x(hover)} y2={PAD.top + plotH}
              stroke="var(--chart-grid)" strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* 2px surface ring so the marker reads against the fill */}
            <circle
              cx={x(hover)} cy={y(active.count)} r="4"
              fill={SERIES} stroke="var(--chart-surface)" strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}

        {series.map((p, i) =>
          i % step === 0 ? (
            <text
              key={p.date} x={x(i)} y={VB_H - 6} textAnchor="middle"
              className="fill-muted-foreground" style={{ fontSize: 9 }}
            >
              {formatBucket(p.date, bucket)}
            </text>
          ) : null,
        )}

        {/* Hit targets — wider than the marks, one per bucket */}
        {series.map((p, i) => (
          <rect
            key={`hit-${p.date}`}
            x={x(i) - plotW / series.length / 2}
            y={PAD.top}
            width={plotW / series.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {active && hover != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-sm"
          style={{ left: `${(x(hover) / VB_W) * 100}%`, top: `${(y(active.count) / VB_H) * 100}%` }}
        >
          <div className="font-medium">
            {active.count} {active.count === 1 ? 'call' : 'calls'}
          </div>
          <div className="text-muted-foreground">{formatBucket(active.date, bucket)}</div>
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  booking_link_sent: 'Booking link sent',
  maintenance_ticket_raised: 'Maintenance ticket',
  transferred_to_human: 'Transferred to human',
  abandoned: 'Abandoned',
  other: 'Other',
};

/** Calls by outcome — horizontal bars, one hue. The bars measure the same
 *  thing across categories, so colouring them differently would encode nothing. */
export function CallsByCategory({ categories }: { categories: CategoryCount[] }) {
  if (categories.length === 0) {
    return <EmptyPlot label="No calls in this period." />;
  }
  const max = Math.max(...categories.map((c) => c.count), 1);

  return (
    <ul className="space-y-3">
      {categories.map((c) => {
        const label = OUTCOME_LABEL[c.outcome] ?? c.outcome;
        const pct = (c.count / max) * 100;
        return (
          <li key={c.outcome} className="group">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{label}</span>
              {/* Direct label — the value is always visible, so the bar length
                  is reinforcement rather than the only encoding. */}
              <span className="tabular-nums text-muted-foreground">{c.count}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(pct, 2)}%`, background: SERIES }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyPlot({ label }: { label: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
