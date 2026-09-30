import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { signToken, verifyToken } from './jwt.ts';

const SECRET = 'test-secret-at-least-32-chars-long-xx';

Deno.test('signToken + verifyToken round-trips the payload', async () => {
  const token = await signToken({ userId: 'u1', username: 'admin', displayName: 'Admin' }, SECRET);
  const payload = await verifyToken(token, SECRET);
  assertEquals(payload.userId, 'u1');
  assertEquals(payload.username, 'admin');
  assertEquals(payload.displayName, 'Admin');
});

Deno.test('verifyToken rejects a bad signature', async () => {
  const token = await signToken({ userId: 'u1', username: 'admin', displayName: null }, SECRET);
  await assertRejects(() => verifyToken(token, 'a-different-secret-also-32-chars-xx'));
});
