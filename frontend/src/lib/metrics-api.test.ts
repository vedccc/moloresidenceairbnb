import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchMetrics } from './metrics-api';

beforeEach(() => vi.restoreAllMocks());

const metrics = {
  range: 'week',
  bucket: 'day',
  totalCalls: 12,
  totalMinutes: 48,
  totalCostUsd: 0.42,
  minutesSaved: 96,
  moneySavedEur: 30,
  openTickets: 1,
  criticalTickets: 0,
  highTickets: 1,
  series: [{ date: '2026-08-16', count: 3 }],
  categories: [{ outcome: 'booking_link_sent', count: 2 }],
  topTickets: [],
  calls: [],
};

describe('metrics-api', () => {
  it('defaults to the week range', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue(metrics as never);
    await fetchMetrics();
    expect(spy).toHaveBeenCalledWith('/metrics?range=week');
  });

  it('passes the selected range through', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue(metrics as never);
    for (const r of ['day', 'week', 'month', 'year'] as const) {
      await fetchMetrics(r);
      expect(spy).toHaveBeenCalledWith(`/metrics?range=${r}`);
    }
  });

  it('returns the stats, series and categories the dashboard renders', async () => {
    vi.spyOn(client, 'apiFetch').mockResolvedValue(metrics as never);
    const res = await fetchMetrics('week');
    expect(res.totalCalls).toBe(12);
    // Saved time is derived server-side; the client must never recompute it, so
    // that the labour-cost model lives in exactly one place.
    expect(res.minutesSaved).toBe(96);
    expect(res.moneySavedEur).toBe(30);
    expect(res.series[0].count).toBe(3);
    expect(res.categories[0].outcome).toBe('booking_link_sent');
  });
});

describe('metrics-api resilience', () => {
  it('survives an API that predates the new fields', async () => {
    // The dashboard (Render) and the API (Supabase edge) deploy separately, so
    // new frontend against old API is a real state. This used to throw on
    // series.length and render "This page couldn't load".
    vi.spyOn(client, 'apiFetch').mockResolvedValue({
      callsToday: 5, openTickets: 2, bookingCtr: '50%', recentCalls: [],
    } as never);
    const res = await fetchMetrics('week');
    expect(res.series).toEqual([]);
    expect(res.categories).toEqual([]);
    expect(res.calls).toEqual([]);
    expect(res.totalCalls).toBe(0);
    expect(res.bucket).toBe('day');
  });

  it('survives null and non-array fields', async () => {
    vi.spyOn(client, 'apiFetch').mockResolvedValue(null as never);
    const a = await fetchMetrics('day');
    expect(a.series).toEqual([]);
    expect(a.range).toBe('day');

    vi.spyOn(client, 'apiFetch').mockResolvedValue({ series: 'nope', calls: null } as never);
    const b = await fetchMetrics('year');
    expect(b.series).toEqual([]);
    expect(b.calls).toEqual([]);
  });
});
