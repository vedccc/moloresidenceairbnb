import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchMaintenance, fetchMaintenanceTicket, updateMaintenanceTicket } from './maintenance-api';

beforeEach(() => vi.restoreAllMocks());

describe('maintenance-api', () => {
  it('fetchMaintenance GETs /maintenance', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([{ id: 't1' }] as never);
    const res = await fetchMaintenance();
    expect(spy).toHaveBeenCalledWith('/maintenance');
    expect(res[0].id).toBe('t1');
  });

  it('fetchMaintenanceTicket GETs /maintenance/:id', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ id: 'abc' } as never);
    await fetchMaintenanceTicket('abc');
    expect(spy).toHaveBeenCalledWith('/maintenance/abc');
  });

  it('updateMaintenanceTicket PATCHes /maintenance/:id with body', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    await updateMaintenanceTicket('t1', { status: 'closed' });
    expect(spy.mock.calls[0][0]).toBe('/maintenance/t1');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ status: 'closed' }));
  });
});
