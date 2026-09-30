import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

export function buildMaintenanceRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  // Ported from src/app/(dashboard)/maintenance/page.tsx:
  //   supabase.from('maintenance_tickets').select('*')
  app.get('/', async (c) => {
    const { data, error } = await makeClient()
      .from('maintenance_tickets').select('*');
    if (error) {
      console.error('GET /maintenance failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json(data ?? []);
  });

  // Ported from src/app/(dashboard)/maintenance/detail/page.tsx:
  //   supabase.from('maintenance_tickets').select('*').eq('id', id).single()
  app.get('/:id', async (c) => {
    const { data, error } = await makeClient()
      .from('maintenance_tickets').select('*').eq('id', c.req.param('id')).single();
    if (error || !data) {
      return c.json({ error: 'Not found.' }, 404);
    }
    return c.json(data);
  });

  // Ported from src/backend/maintenance.ts updateTicket():
  //   supabase.from('maintenance_tickets').update(patch).eq('id', id)
  app.patch('/:id', async (c) => {
    const patch = await c.req.json().catch(() => null);
    if (!patch) return c.json({ error: 'Invalid JSON body.' }, 400);
    const { error } = await makeClient()
      .from('maintenance_tickets').update(patch).eq('id', c.req.param('id'));
    if (error) {
      console.error('PATCH /maintenance/:id update failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  // Ported from src/backend/maintenance.ts createTicket():
  //   insert({ property_id, room_number, description, urgency, status:'open', created_via:'dashboard' })
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.property_id !== 'string' ||
      typeof body.room_number !== 'string' ||
      typeof body.description !== 'string' ||
      typeof body.urgency !== 'string'
    ) {
      return c.json({ error: 'property_id, room_number, description and urgency are required.' }, 400);
    }
    const { error } = await makeClient().from('maintenance_tickets').insert({
      property_id: body.property_id,
      room_number: body.room_number,
      description: body.description,
      urgency: body.urgency,
      status: 'open',
      created_via: 'dashboard',
    });
    if (error) {
      console.error('POST /maintenance insert failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
