import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';
import type { AppEnv } from '../lib/types.ts';

type ClientFactory = () => SupabaseClient;

// Single-user profile for the signed-in staff member. The user id ALWAYS comes
// from the verified JWT (c.get('user').userId) — never from the request body.
// Typed Hono<AppEnv> so c.get('user') is the TokenClaims set by requireAuth.
export function buildMeRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { userId } = c.get('user');
    const { data, error } = await makeClient()
      .from('users')
      .select('id, username, display_name')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) {
      return c.json({ error: 'Not found.' }, 404);
    }
    return c.json(data);
  });

  // Ports the relevant bits of updateStaffUser in src/backend/users.ts:
  //   patch.display_name = displayName.trim() || null
  //   if password (>=8): patch.password_hash = await bcrypt.hash(password, 10)
  //   supabase.from('users').update(patch).eq('id', id)
  app.patch('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body.' }, 400);

    const { userId } = c.get('user');

    const patch: Record<string, unknown> = {};
    if (body.display_name !== undefined) {
      patch.display_name = String(body.display_name).trim() || null;
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return c.json({ error: 'Password must be at least 8 characters.' }, 400);
      }
      patch.password_hash = await bcrypt.hash(body.password, 10);
    }

    const { error } = await makeClient()
      .from('users').update(patch).eq('id', userId);
    if (error) {
      console.error('PATCH /me update failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
