import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import bcrypt from 'bcryptjs';
import { buildAuthRoutes, type UserRecord } from './auth.ts';
import { Hono } from 'hono';

Deno.env.set('SESSION_SECRET', 'test-secret-at-least-32-chars-long-xx');

function appWith(user: UserRecord | null) {
  const app = new Hono();
  app.route('/auth', buildAuthRoutes(async () => user));
  return app;
}

Deno.test('login returns a token for valid credentials', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: true,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ADMIN', password: 'molo1234' }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.token, 'string');
  assertEquals(body.user.username, 'admin');
});

Deno.test('login rejects a wrong password with 401', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: true,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assertEquals(res.status, 401);
});

Deno.test('login rejects a deactivated user with 401', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: false,
  };
  const res = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'molo1234' }),
  });
  assertEquals(res.status, 401);
});

Deno.test('login returns 401 when the user does not exist', async () => {
  const res = await appWith(null).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: 'whatever' }),
  });
  assertEquals(res.status, 401);
});

Deno.test('login returns the same generic message for unknown user and wrong password', async () => {
  const user: UserRecord = {
    id: 'u1', username: 'admin', display_name: 'Admin',
    password_hash: bcrypt.hashSync('molo1234', 10), is_active: true,
  };

  const unknownRes = await appWith(null).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: 'whatever' }),
  });
  const wrongPwRes = await appWith(user).request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });

  assertEquals(unknownRes.status, 401);
  assertEquals(wrongPwRes.status, 401);
  const unknownBody = await unknownRes.json();
  const wrongPwBody = await wrongPwRes.json();
  assertEquals(unknownBody.error, 'Invalid credentials.');
  assertEquals(wrongPwBody.error, 'Invalid credentials.');
  assertEquals(unknownBody.error, wrongPwBody.error);
});
