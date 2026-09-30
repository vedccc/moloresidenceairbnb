import type { Context, Next } from 'hono';
import { verifyToken } from '../lib/jwt.ts';
import type { AppEnv } from '../lib/types.ts';

const BEARER_PREFIX = 'Bearer ';

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const secret = Deno.env.get('SESSION_SECRET');
  if (!secret) return c.json({ error: 'Server misconfigured' }, 500);

  try {
    const claims = await verifyToken(token, secret);
    c.set('user', claims);
    await next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}
