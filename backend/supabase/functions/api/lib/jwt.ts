import { SignJWT, jwtVerify } from 'jose';

const TOKEN_TTL = '12h';
const JWT_ALG = 'HS256';

export interface TokenClaims {
  userId: string;
  username: string;
  displayName: string | null;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  return await new SignJWT({ username: claims.username, displayName: claims.displayName })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(key(secret));
}

export async function verifyToken(token: string, secret: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: [JWT_ALG] });
  return {
    userId: String(payload.sub),
    username: String(payload.username ?? ''),
    displayName: (payload.displayName as string | null) ?? null,
  };
}
