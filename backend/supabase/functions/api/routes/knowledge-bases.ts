import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

/**
 * Mark (or unmark) a KB as THE general knowledge base. Only one KB can be
 * general at a time, so setting a new one first clears the previous (the DB
 * also enforces this via a unique partial index). Ported 1:1 from
 * src/backend/knowledge-bases.ts → setDefaultGeneralKb.
 */
async function setGeneral(sb: SupabaseClient, id: string, value: boolean): Promise<string | null> {
  if (value) {
    const { error: clearError } = await sb
      .from('knowledge_bases')
      .update({ is_default_general: false })
      .eq('is_default_general', true);
    if (clearError) return clearError.message;
  }
  const { error } = await sb
    .from('knowledge_bases')
    .update({ is_default_general: value })
    .eq('id', id);
  if (error) return error.message;
  return null;
}

export function buildKnowledgeBaseRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  // List query ported from src/app/(dashboard)/knowledge-bases/page.tsx.
  app.get('/', async (c) => {
    const { data, error } = await makeClient()
      .from('knowledge_bases')
      .select('id, name, content, updated_at, is_default_general, knowledge_base_rooms(room_number)')
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('GET /knowledge-bases failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json(data ?? []);
  });

  // The single default-general KB (or null).
  app.get('/general', async (c) => {
    const { data, error } = await makeClient()
      .from('knowledge_bases')
      .select('id, name, content, updated_at, is_default_general')
      .eq('is_default_general', true)
      .maybeSingle();
    if (error) {
      console.error('GET /knowledge-bases/general failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json(data ?? null);
  });

  // The detail-editor bundle. Ported 1:1 from getKbDetailData(id).
  app.get('/:id', async (c) => {
    const sb = makeClient();
    const id = c.req.param('id');
    const [{ data: kb }, { data: properties }, { data: propRooms }, { data: allKbRooms }] =
      await Promise.all([
        sb.from('knowledge_bases').select('id, name, content, is_default_general, property_id').eq('id', id).single(),
        sb.from('properties').select('id, name').order('name'),
        sb.from('property_rooms').select('property_id, room_number').order('room_number'),
        sb
          .from('knowledge_base_rooms')
          .select('room_number, property_id, knowledge_base_id, knowledge_bases(id, name, property_id)')
          .order('room_number'),
      ]);

    return c.json({
      kb: kb ?? null,
      properties: properties ?? [],
      propRooms: propRooms ?? [],
      allKbRooms: allKbRooms ?? [],
    });
  });

  // Create a KB (kind:'general', property_id:null). Ported from createKnowledgeBase.
  // If `general === true`, apply setDefaultGeneralKb(newId, true) after insert.
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required.' }, 400);

    const sb = makeClient();
    const { data, error } = await sb
      .from('knowledge_bases')
      .insert({ name, kind: 'general', property_id: null, content: '' })
      .select('id')
      .single();
    if (error || !data) {
      console.error('POST /knowledge-bases insert failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }

    if (body.general === true) {
      const err = await setGeneral(sb, data.id, true);
      if (err) {
        console.error('POST /knowledge-bases set-general failed:', err);
        return c.json({ error: 'Request failed.' }, 400);
      }
    }
    return c.json({ ok: true, id: data.id });
  });

  // Update name and/or content. Ported from updateKbName / updateKbContent
  // (a single `.update({...}).eq('id', id)` with whichever fields are present).
  app.patch('/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);

    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.content === 'string') patch.content = body.content;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'No updatable fields provided.' }, 400);
    }

    const { error } = await makeClient()
      .from('knowledge_bases').update(patch).eq('id', c.req.param('id'));
    if (error) {
      console.error('PATCH /knowledge-bases/:id failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  // Set/unset this KB as the default general. Ported from setDefaultGeneralKb.
  app.post('/:id/general', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.value !== 'boolean') {
      return c.json({ error: 'value (boolean) is required.' }, 400);
    }
    const err = await setGeneral(makeClient(), c.req.param('id'), body.value);
    if (err) {
      console.error('POST /knowledge-bases/:id/general failed:', err);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  // Replace this KB's room assignments. Ported from saveRoomAssignments
  // (delete existing assignments for this KB then insert the new set).
  app.put('/:id/rooms', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const id = c.req.param('id');

    // Rooms are property-scoped: the same room NUMBER exists at several properties,
    // so an assignment is (property_id, room_number). Preferred payload:
    // rooms: [{property_id, room_number}]. Back-compat: a bare roomNumbers string[]
    // is still accepted (stored without a property).
    const seen = new Set<string>();
    const rooms: { property_id: string | null; room_number: string }[] = [];
    if (Array.isArray(body.rooms)) {
      for (const r of body.rooms as unknown[]) {
        const o = (r ?? {}) as { property_id?: unknown; room_number?: unknown };
        const pid = typeof o.property_id === 'string' && o.property_id ? o.property_id : null;
        const rn = typeof o.room_number === 'string' ? o.room_number.trim() : '';
        if (!rn) continue;
        const key = `${pid ?? ''}:${rn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rooms.push({ property_id: pid, room_number: rn });
      }
    } else if (Array.isArray(body.roomNumbers)) {
      for (const r of body.roomNumbers as unknown[]) {
        if (typeof r !== 'string' || r.trim() === '') continue;
        const rn = r.trim();
        if (seen.has(`:${rn}`)) continue;
        seen.add(`:${rn}`);
        rooms.push({ property_id: null, room_number: rn });
      }
    } else {
      return c.json({ error: 'rooms (array of {property_id, room_number}) is required.' }, 400);
    }

    const sb = makeClient();

    // Enforce one KB per (property, room): reject any (property, room) already
    // owned by a DIFFERENT KB, with a message naming it. The unique index
    // (property_id, room_number) is the backstop if two saves race.
    const scoped = rooms.filter((r) => r.property_id);
    if (scoped.length > 0) {
      const { data: existing } = await sb
        .from('knowledge_base_rooms')
        .select('property_id, room_number, knowledge_base_id, knowledge_bases(name)')
        .neq('knowledge_base_id', id);
      const owner = new Map<string, string>();
      for (const e of (existing ?? []) as Array<{ property_id: string | null; room_number: string; knowledge_bases: { name?: string } | null }>) {
        if (e.property_id) owner.set(`${e.property_id}:${e.room_number}`, e.knowledge_bases?.name ?? 'another knowledge base');
      }
      const conflicts = scoped
        .filter((r) => owner.has(`${r.property_id}:${r.room_number}`))
        .map((r) => ({ property_id: r.property_id, room_number: r.room_number, kb: owner.get(`${r.property_id}:${r.room_number}`) }));
      if (conflicts.length > 0) {
        return c.json({ error: 'One or more rooms are already assigned to another knowledge base.', conflicts }, 409);
      }
    }

    await sb.from('knowledge_base_rooms').delete().eq('knowledge_base_id', id);
    if (rooms.length > 0) {
      const { error } = await sb
        .from('knowledge_base_rooms')
        .insert(rooms.map((r) => ({ knowledge_base_id: id, property_id: r.property_id, room_number: r.room_number })));
      if (error) {
        console.error('PUT /knowledge-bases/:id/rooms failed:', error);
        return c.json({ error: 'Request failed.' }, 400);
      }
    }
    return c.json({ ok: true });
  });

  // Remove a single room assignment. Ported from removeRoomFromKb(otherKbId,
  // roomNumber) — the KB it targets is `otherKbId` when supplied, else the path
  // :id; the row is matched on (knowledge_base_id, room_number).
  app.delete('/:id/rooms', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);
    const roomNumber = body.roomNumber;
    if (typeof roomNumber !== 'string' || roomNumber.trim() === '') {
      return c.json({ error: 'roomNumber is required.' }, 400);
    }
    const kbId = typeof body.otherKbId === 'string' && body.otherKbId
      ? body.otherKbId
      : c.req.param('id');
    // Scope by property when supplied: the same room_number lives at several
    // properties, so only remove THIS property's room from that KB.
    let del = makeClient()
      .from('knowledge_base_rooms')
      .delete()
      .eq('knowledge_base_id', kbId)
      .eq('room_number', roomNumber);
    if (typeof body.property_id === 'string' && body.property_id) {
      del = del.eq('property_id', body.property_id);
    }
    const { error } = await del;
    if (error) {
      console.error('DELETE /knowledge-bases/:id/rooms failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  // Delete a KB. Ported from deleteKnowledgeBase — delete room assignments first,
  // then the KB itself (matching the existing order).
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const sb = makeClient();
    await sb.from('knowledge_base_rooms').delete().eq('knowledge_base_id', id);
    const { error } = await sb.from('knowledge_bases').delete().eq('id', id);
    if (error) {
      console.error('DELETE /knowledge-bases/:id failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
