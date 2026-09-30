import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchMe, updateMe } from './me-api';

beforeEach(() => vi.restoreAllMocks());

describe('me-api', () => {
  it('fetchMe GETs /me', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ id: 'u1', username: 'admin', display_name: 'Admin' } as never);
    const res = await fetchMe();
    expect(spy).toHaveBeenCalledWith('/me');
    expect(res.username).toBe('admin');
  });

  it('updateMe PATCHes /me with the body', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    await updateMe({ display_name: 'New Name' });
    expect(spy.mock.calls[0][0]).toBe('/me');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ display_name: 'New Name' }));
  });

  it('updateMe accepts password field', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    await updateMe({ password: 'newpass123' });
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ password: 'newpass123' }));
  });
});
