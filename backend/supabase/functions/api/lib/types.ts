import type { TokenClaims } from './jwt.ts';

// Shared Hono environment so `c.set('user', ...)` / `c.get('user')` are typed
// across the auth middleware and any route mounted behind it.
export interface AppEnv {
  Variables: {
    user: TokenClaims;
  };
}
