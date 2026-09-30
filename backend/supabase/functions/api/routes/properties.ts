import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

export function buildPropertyRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  app.get('/', async (c) => {
    const sb = makeClient();
    const [{ data: properties }, { data: rooms }] = await Promise.all([
      sb.from('properties')
        .select('id, name, address, kwhotel_hotel_id, transfer_phone, aliases, language_default, timezone, notes')
        .order('name', { ascending: true }),
      sb.from('property_rooms').select('property_id, room_number'),
    ]);
    const roomMap: Record<string, string[]> = {};
    for (const r of rooms ?? []) (roomMap[r.property_id] ??= []).push(r.room_number);
    const out = (properties ?? []).map((p: Record<string, unknown>) => ({
      ...p,
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      rooms: (roomMap[p.id as string] ?? []).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })),
    }));
    return c.json(out);
  });

  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const { data, error } = await makeClient()
      .from('properties').insert(body).select('id').maybeSingle();
    if (error || !data) {
      console.error('POST /properties insert failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true, id: data.id });
  });

  app.patch('/:id', async (c) => {
    const patch = await c.req.json().catch(() => null);
    if (!patch) return c.json({ error: 'Invalid JSON body.' }, 400);
    const { error } = await makeClient()
      .from('properties').update(patch).eq('id', c.req.param('id'));
    if (error) {
      console.error('PATCH /properties/:id update failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const { error } = await makeClient()
      .from('properties').delete().eq('id', c.req.param('id'));
    if (error) {
      console.error('DELETE /properties/:id failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  app.post('/:id/rooms', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const { room_number } = body;
    if (typeof room_number !== 'string' || room_number.trim() === '') {
      return c.json({ error: 'room_number is required.' }, 400);
    }
    const { error } = await makeClient()
      .from('property_rooms').insert({ property_id: c.req.param('id'), room_number });
    if (error) {
      console.error('POST /properties/:id/rooms failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  app.delete('/:id/rooms', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const { room_number } = body;
    if (typeof room_number !== 'string' || room_number.trim() === '') {
      return c.json({ error: 'room_number is required.' }, 400);
    }
    const { error } = await makeClient()
      .from('property_rooms').delete()
      .eq('property_id', c.req.param('id')).eq('room_number', room_number);
    if (error) {
      console.error('DELETE /properties/:id/rooms failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
