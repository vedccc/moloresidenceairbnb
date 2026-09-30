import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchUrgencyRules, saveUrgencyRules } from './urgency-rules-api';

beforeEach(() => vi.restoreAllMocks());

describe('urgency-rules-api', () => {
  it('fetchUrgencyRules GETs /urgency-rules', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([{ id: 'r1' }] as never);
    const res = await fetchUrgencyRules();
    expect(spy).toHaveBeenCalledWith('/urgency-rules');
    expect(res[0].id).toBe('r1');
  });

  it('saveUrgencyRules PUTs /urgency-rules with body {rules}', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    const rules = [{ id: 'r1', label: 'Critical', level: 'critical' }];
    await saveUrgencyRules(rules);
    expect(spy.mock.calls[0][0]).toBe('/urgency-rules');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PUT');
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ rules }));
  });

  it('saveUrgencyRules returns ok', async () => {
    vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    const res = await saveUrgencyRules([]);
    expect(res.ok).toBe(true);
  });
});
