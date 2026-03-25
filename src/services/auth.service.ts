import { eq, or } from 'drizzle-orm';
import { db } from '../db/client';
import { users, refreshTokens } from '../db/schema';
import type { UserRole } from '../lib/jwt';
import {
  signAccessToken,
  signRefreshToken,
  signStatusToken,
  verifyRefreshToken,
  refreshTokenExpiresAt,
  accessTokenTtlSeconds,
} from '../lib/jwt';
import { generateGetstreamToken } from '../lib/getstream';
import { blacklistToken } from '../lib/redis';

// ─── Request ID generator ────────────────────────────────────────────────────

const REQUEST_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion

async function generateRequestId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += REQUEST_ID_CHARS[Math.floor(Math.random() * REQUEST_ID_CHARS.length)];
    }
    const existing = await db.query.users.findFirst({
      where: eq(users.requestId, id),
      columns: { id: true },
    });
    if (!existing) return id;
  }
  throw Object.assign(new Error('Failed to generate unique request ID'), { status: 500 });
}

// ─── Signup ───────────────────────────────────────────────────────────────────

export async function signup(data: { name: string; phone?: string; email?: string; password: string; }) {
  if (!data.phone && !data.email) {
    throw Object.assign(new Error('Phone or email is required'), { status: 400 });
  }

  // Check uniqueness of provided identifiers
  const conditions = [];
  if (data.phone) conditions.push(eq(users.phone, data.phone));
  if (data.email) conditions.push(eq(users.email, data.email));

  const existing = await db.query.users.findFirst({
    where: or(...conditions),
  });
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email';
    throw Object.assign(new Error(`${field} already registered`), { status: 409 });
  }

  const passwordHash = await Bun.password.hash(data.password);
  const requestId = await generateRequestId();

  const [user] = await db
    .insert(users)
    .values({
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      passwordHash,
      requestId,
    })
    .returning({ id: users.id, status: users.status, requestId: users.requestId });

  // Issue a limited-scope token so pending users can connect to WS for status updates
  const statusToken = await signStatusToken(user.id);

  return {
    requestId: user.requestId,
    status: user.status,
    statusToken,
    message: 'Account created. Awaiting admin approval.',
  };
}

// ─── Check Status ─────────────────────────────────────────────────────────────

export async function checkStatus(requestId: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.requestId, requestId),
    columns: { status: true },
  });
  return { status: user?.status ?? 'not_found' };
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function login(identifier: { phone?: string; email?: string }, password: string) {
  if (!identifier.phone && !identifier.email) {
    throw Object.assign(new Error('Phone or email is required'), { status: 400 });
  }

  const user = await db.query.users.findFirst({
    where: identifier.phone
      ? eq(users.phone, identifier.phone)
      : eq(users.email, identifier.email!),
  });

  if (!user || !user.passwordHash) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  if (user.status === 'pending_approval') {
    throw Object.assign(new Error('Account not yet approved'), { status: 403 });
  }

  if (user.status === 'rejected') {
    throw Object.assign(new Error('Account rejected'), { status: 403 });
  }

  const valid = await Bun.password.verify(password, user.passwordHash);
  if (!valid) throw Object.assign(new Error('Invalid credentials'), { status: 401 });

  return issueTokens(user);
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function refresh(refreshToken: string) {
  const payload = await verifyRefreshToken(refreshToken);
  if (!payload) throw Object.assign(new Error('Invalid or expired refresh token'), { status: 401 });

  const tokenHash = await hashToken(refreshToken);
  const stored = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, tokenHash),
  });

  if (!stored || stored.expiresAt < new Date()) {
    throw Object.assign(new Error('Refresh token not found or expired'), { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
  });
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });

  // Rotate: delete old token, issue new pair
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));

  return issueTokens(user);
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(userId: string, jti: string, refreshToken: string) {
  await blacklistToken(jti, accessTokenTtlSeconds());

  const tokenHash = await hashToken(refreshToken);
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
}

// ─── Set Password (OTP flow) ──────────────────────────────────────────────────

export async function setPassword(phone: string, otp: string, newPassword: string) {
  // TODO: Validate OTP against your OTP provider (Twilio, etc.)
  const user = await db.query.users.findFirst({ where: eq(users.phone, phone) });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const passwordHash = await Bun.password.hash(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

  return { message: 'Password updated successfully' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function issueTokens(user: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: UserRole;
  status: 'pending_approval' | 'approved' | 'rejected';
}) {
  const [accessToken, { token: newRefresh }] = await Promise.all([
    signAccessToken(user.id, user.role),
    signRefreshToken(user.id),
  ]);

  const tokenHash = await hashToken(newRefresh);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: refreshTokenExpiresAt(),
  });

  return {
    accessToken,
    refreshToken: newRefresh,
    getstreamToken: generateGetstreamToken(user.id),
    user: {
      userId: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  };
}

async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(buf).toString('hex');
}

export { hashToken };
