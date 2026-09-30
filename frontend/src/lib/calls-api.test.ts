import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchCalls, fetchCall, deleteCallTranscript, fetchGdprCallers, eraseCallerData } from './calls-api';

beforeEach(() => vi.restoreAllMocks());

describe('calls-api', () => {
  it('fetchCalls GETs /calls', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([{ id: 'c1' }] as never);
    const res = await fetchCalls();
    expect(spy).toHaveBeenCalledWith('/calls');
    expect(res[0].id).toBe('c1');
  });

  it('fetchCall GETs /calls/:id', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({
      call: { id: 'c1' },
      propertyName: 'Hotel A',
      costRates: null,
      tickets: [],
      bookings: [],
    } as never);
    const res = await fetchCall('c1');
    expect(spy).toHaveBeenCalledWith('/calls/c1');
    expect(res.call.id).toBe('c1');
    expect(res.propertyName).toBe('Hotel A');
  });

  it('fetchCall returns composed detail shape', async () => {
    vi.spyOn(client, 'apiFetch').mockResolvedValue({
      call: { id: 'c2' },
      propertyName: null,
      costRates: { per_min: 0.01 },
      tickets: [{ id: 't1' }],
      bookings: [{ id: 'b1', converted: false }],
    } as never);
    const res = await fetchCall('c2');
    expect(res.tickets).toHaveLength(1);
    expect(res.bookings).toHaveLength(1);
  });

  it('deleteCallTranscript DELETEs /calls/:id/transcript', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    const res = await deleteCallTranscript('c1');
    // The path must target the transcript sub-resource, NOT /calls/c1 — that
    // would read as deleting the whole call record.
    expect(spy).toHaveBeenCalledWith('/calls/c1/transcript', { method: 'DELETE' });
    expect(res.ok).toBe(true);
  });
});

describe('GDPR erasure', () => {
  it('lists callers who still have data on file', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([
      { phone: '+48123', calls: 3, transcripts: 2, lastCall: '2026-08-16T09:00:00Z' },
    ] as never);
    const res = await fetchGdprCallers();
    expect(spy).toHaveBeenCalledWith('/calls/gdpr/callers');
    expect(res[0].calls).toBe(3);
  });

  it('erases by phone number, not by call id', async () => {
    // A GDPR request covers the person, not one conversation — erasing a single
    // call would leave their other calls on file.
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true, callsRedacted: 4 } as never);
    const res = await eraseCallerData('+48123456789');
    expect(spy).toHaveBeenCalledWith('/calls/gdpr/erase', {
      method: 'POST',
      body: JSON.stringify({ phone: '+48123456789' }),
    });
    expect(res.callsRedacted).toBe(4);
  });
});
