import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from './api-client';
import { fetchProperties, createProperty, deleteProperty } from './properties-api';

beforeEach(() => vi.restoreAllMocks());

describe('properties-api', () => {
  it('fetchProperties GETs /properties', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue([{ id: 'p1' }] as never);
    const res = await fetchProperties();
    expect(spy).toHaveBeenCalledWith('/properties');
    expect(res[0].id).toBe('p1');
  });

  it('createProperty POSTs the body', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true, id: 'x' } as never);
    await createProperty({ name: 'N', address: 'A', kwhotel_hotel_id: null, transfer_phone: null, aliases: [], language_default: 'pl', timezone: 'Europe/Warsaw', notes: null });
    expect(spy.mock.calls[0][0]).toBe('/properties');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('deleteProperty DELETEs /properties/:id', async () => {
    const spy = vi.spyOn(client, 'apiFetch').mockResolvedValue({ ok: true } as never);
    await deleteProperty('p1');
    expect(spy.mock.calls[0][0]).toBe('/properties/p1');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});
