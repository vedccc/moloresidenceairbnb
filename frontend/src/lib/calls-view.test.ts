import { describe, it, expect } from 'vitest';
import { USD_TO_EUR } from './money';
import {
  ALL,
  OUTCOME_OPTIONS,
  callOutcomes,
  filterCalls,
  formatDuration,
  formatDurationLong,
  isEstimatedCost,
  matchesOutcome,
  summarize,
  type CallRow,
} from './calls-view';

function call(over: Partial<CallRow> = {}): CallRow {
  return {
    id: crypto.randomUUID(),
    started_at: '2026-08-16T10:00:00Z',
    duration_seconds: 60,
    cost_usd: 0.06,
    cost_breakdown: { measured: true },
    outcomes: ['question_answered'],
    outcome: 'question_answered',
    mode: 'guest',
    property_id: null,
    ...over,
  };
}

const noFilters = {
  fromDate: '',
  toDate: '',
  mode: ALL,
  outcome: ALL,
  propertyId: ALL,
};

describe('outcomes', () => {
  it('shows every outcome a call earned', () => {
    const c = call({ outcomes: ['maintenance_ticket_raised', 'question_answered'] });
    expect(callOutcomes(c)).toEqual(['maintenance_ticket_raised', 'question_answered']);
  });

  it('falls back to the singular column for calls logged before multi-outcome', () => {
    // Every historical row has `outcome` set and `outcomes` empty. They must
    // still show their badge rather than a dash.
    const legacy = call({ outcomes: [], outcome: 'booking_link_sent' });
    expect(callOutcomes(legacy)).toEqual(['booking_link_sent']);
  });

  it('reports nothing when a call has no outcome at all', () => {
    expect(callOutcomes(call({ outcomes: [], outcome: null }))).toEqual([]);
  });

  it('matches a filter against any outcome on the call, not just the first', () => {
    const c = call({ outcomes: ['maintenance_ticket_raised', 'question_answered'] });
    expect(matchesOutcome(c, 'question_answered')).toBe(true);
    expect(matchesOutcome(c, 'maintenance_ticket_raised')).toBe(true);
    expect(matchesOutcome(c, 'spam')).toBe(false);
  });

  it('offers the vocabulary the agent actually writes', () => {
    // Kept in step with call_outcomes.OUTCOMES in the agent. The two legacy
    // values are deliberately absent — filtering on one would always be empty.
    expect(OUTCOME_OPTIONS).toContain('question_answered');
    expect(OUTCOME_OPTIONS).toContain('transfer_unavailable');
    expect(OUTCOME_OPTIONS).not.toContain('troubleshoot_resolved');
    expect(new Set(OUTCOME_OPTIONS).size).toBe(OUTCOME_OPTIONS.length);
  });
});

describe('totals', () => {
  it('adds up duration and cost across the calls shown', () => {
    const totals = summarize([
      call({ duration_seconds: 60, cost_usd: 0.06 }),
      call({ duration_seconds: 90, cost_usd: 0.09 }),
    ]);
    expect(totals.count).toBe(2);
    expect(totals.totalSeconds).toBe(150);
    expect(totals.totalCostUsd).toBeCloseTo(0.15, 10);
    expect(totals.totalCostEur).toBeCloseTo(0.15 * USD_TO_EUR, 10);
  });

  it('handles the numeric column arriving as a string', () => {
    // Postgres numeric comes back over PostgREST as a string; summing those
    // with + would concatenate them into "0.060.09".
    const totals = summarize([
      call({ cost_usd: '0.06' }),
      call({ cost_usd: '0.09' }),
    ]);
    expect(totals.totalCostUsd).toBeCloseTo(0.15, 10);
  });

  it('counts calls with no cost instead of treating them as free', () => {
    const totals = summarize([call({ cost_usd: null }), call({ cost_usd: 0.06 })]);
    expect(totals.missingCostCount).toBe(1);
    expect(totals.totalCostUsd).toBeCloseTo(0.06, 10);
  });

  it('counts how many of the costs are estimates', () => {
    const totals = summarize([
      call({ cost_breakdown: { measured: true } }),
      call({ cost_breakdown: { measured: false } }),
      call({ cost_breakdown: null }), // seeded rows: no breakdown at all
    ]);
    expect(totals.estimatedCount).toBe(2);
  });

  it('is empty, not NaN, for an empty list', () => {
    expect(summarize([])).toMatchObject({
      count: 0,
      totalSeconds: 0,
      totalCostUsd: 0,
      totalCostEur: 0,
    });
  });

  it('describes the filtered list, not the whole table', () => {
    const calls = [
      call({ mode: 'guest', duration_seconds: 60, cost_usd: 0.06 }),
      call({ mode: 'booking', duration_seconds: 120, cost_usd: 0.12 }),
    ];
    const booking = filterCalls(calls, { ...noFilters, mode: 'booking' });
    expect(summarize(booking)).toMatchObject({ count: 1, totalSeconds: 120 });
  });
});

describe('estimated costs', () => {
  it('treats a measured breakdown as measured and everything else as estimated', () => {
    expect(isEstimatedCost(call({ cost_breakdown: { measured: true } }))).toBe(false);
    expect(isEstimatedCost(call({ cost_breakdown: { measured: false } }))).toBe(true);
    expect(isEstimatedCost(call({ cost_breakdown: null }))).toBe(true);
  });

  it('says nothing about a call with no cost', () => {
    expect(isEstimatedCost(call({ cost_usd: null, cost_breakdown: null }))).toBe(false);
  });
});

describe('durations', () => {
  it('formats one call as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats a total in hours and minutes', () => {
    // 208 minutes of calls reads as "3h 28m", not "208:30".
    expect(formatDurationLong(12510)).toBe('3h 28m');
    expect(formatDurationLong(725)).toBe('12m 05s');
    expect(formatDurationLong(0)).toBe('0m 00s');
    expect(formatDurationLong(null)).toBe('—');
  });
});

describe('filters', () => {
  it('keeps everything when nothing is set', () => {
    const calls = [call(), call({ mode: 'booking' })];
    expect(filterCalls(calls, noFilters)).toHaveLength(2);
  });

  it('includes calls made late on the To date itself', () => {
    // The bound is the END of that LOCAL day — an inclusive range is what a
    // person means by "to 16 August". Built from local parts so the assertion
    // holds in Poland as well as in UTC: it is exactly the two-hour offset that
    // used to drop these calls.
    const lateOnTheSixteenth = new Date(2026, 7, 16, 22, 30).toISOString();
    const calls = [call({ started_at: lateOnTheSixteenth })];
    expect(filterCalls(calls, { ...noFilters, toDate: '2026-08-16' })).toHaveLength(1);
  });

  it('includes calls made just after midnight on the From date', () => {
    const justAfterMidnight = new Date(2026, 7, 16, 0, 30).toISOString();
    const calls = [call({ started_at: justAfterMidnight })];
    expect(filterCalls(calls, { ...noFilters, fromDate: '2026-08-16' })).toHaveLength(1);
  });

  it('excludes calls before the From date', () => {
    const calls = [
      call({ started_at: new Date(2026, 7, 14, 10, 0).toISOString() }),
      call({ started_at: new Date(2026, 7, 16, 10, 0).toISOString() }),
    ];
    expect(filterCalls(calls, { ...noFilters, fromDate: '2026-08-15' })).toHaveLength(1);
  });

  it('filters on any of a call’s outcomes', () => {
    const calls = [
      call({ outcomes: ['maintenance_ticket_raised', 'question_answered'] }),
      call({ outcomes: ['spam'] }),
    ];
    expect(
      filterCalls(calls, { ...noFilters, outcome: 'question_answered' }),
    ).toHaveLength(1);
  });

  it('combines filters', () => {
    const calls = [
      call({ mode: 'booking', outcomes: ['booking_link_sent'], property_id: 'p1' }),
      call({ mode: 'booking', outcomes: ['abandoned'], property_id: 'p1' }),
      call({ mode: 'guest', outcomes: ['booking_link_sent'], property_id: 'p2' }),
    ];
    const out = filterCalls(calls, {
      ...noFilters,
      mode: 'booking',
      outcome: 'booking_link_sent',
      propertyId: 'p1',
    });
    expect(out).toHaveLength(1);
  });
});
