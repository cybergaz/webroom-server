import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

export type UserRole = 'user' | 'host' | 'admin' | 'super_admin';

export interface AccessTokenPayload {
  jti: string;
  sub: string;           // userId
  role: UserRole;
  type: 'access';
}

export interface RefreshTokenPayload {
  jti: string;
  sub: string;           // userId
  type: 'refresh';
}

export interface StatusTokenPayload {
  sub: string;           // userId
  type: 'status';        // limited scope: only for WS status updates (pending users)
}

const accessSecret = new TextEncoder().encode(env.jwt.accessSecret);
const refreshSecret = new TextEncoder().encode(env.jwt.refreshSecret);

function parseDuration(d: string): number {
  const match = d.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${d}`);
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  throw new Error(`Unknown unit: ${unit}`);
}

export async function signAccessToken(
  userId: string,
  role: UserRole,
): Promise<string> {
  const jti = crypto.randomUUID();
  console.log("jti -> ", jti);
  const claims: Omit<AccessTokenPayload, 'sub'> = {
    role,
    type: 'access',
    jti,
  };

  console.log('Signing access token time: ', `${parseDuration(env.jwt.accessExpiresIn)}s`);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${parseDuration(env.jwt.accessExpiresIn)}s`)
    .sign(accessSecret);
}

export async function signRefreshToken(userId: string): Promise<{ token: string; jti: string; }> {
  const jti = crypto.randomUUID();

  console.log('Signing refresh token time: ', `${parseDuration(env.jwt.refreshExpiresIn)}s`);
  const token = await new SignJWT({ type: 'refresh', jti } satisfies Omit<RefreshTokenPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${parseDuration(env.jwt.refreshExpiresIn)}s`)
    .sign(refreshSecret);
  return { token, jti };
}

export async function signStatusToken(userId: string): Promise<string> {
  return new SignJWT({ type: 'status' } satisfies Omit<StatusTokenPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecret);
    if ((payload as any).type !== 'access') return null;
    return payload as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, refreshSecret);
    if ((payload as any).type !== 'refresh') return null;
    return payload as unknown as RefreshTokenPayload;
  } catch {
    return null;
  }
}

export async function verifyWsToken(
  token: string,
): Promise<{ sub: string; role?: UserRole; type: 'access' | 'status'; } | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecret);
    const p = payload as any;
    if (p.type !== 'access' && p.type !== 'status') return null;
    return {
      sub: p.sub as string,
      role: p.role,
      type: p.type,
    };
  } catch {
    return null;
  }
}

export function refreshTokenExpiresAt(): Date {
  const seconds = parseDuration(env.jwt.refreshExpiresIn);
  return new Date(Date.now() + seconds * 1000);
}

export function accessTokenTtlSeconds(): number {
  return parseDuration(env.jwt.accessExpiresIn);
}
