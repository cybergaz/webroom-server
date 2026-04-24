import Elysia from 'elysia';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt';
import { isTokenBlacklisted } from '../lib/redis';

const err = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

async function verifyAndCheck(headers: Record<string, string | undefined>): Promise<AccessTokenPayload> {
  const auth = headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) throw err(401, 'Missing authorization token');

  const payload = await verifyAccessToken(token);
  if (!payload) throw err(401, 'Invalid or expired token');

  if (await isTokenBlacklisted(payload.jti)) throw err(401, 'Token has been revoked');

  return payload;
}

/**
 * Auth plugin — adds `ctx.user` to the request context.
 * Any valid access token (any role).
 */
export const authPlugin = new Elysia({ name: 'auth' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    return {
      user: {
        userId: payload.sub,
        role: payload.role,
        jti: payload.jti,
      },
    };
  },
);

/**
 * Super-admin guard — role must be 'super_admin'.
 */
export const superAdminPlugin = new Elysia({ name: 'super-admin' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    if (payload.role !== 'super_admin') throw err(403, 'Super-admin access required');
    return {
      user: {
        userId: payload.sub,
        role: payload.role as 'super_admin',
        jti: payload.jti,
      },
    };
  },
);

/**
 * Admin guard — role must be 'admin'.
 */
export const adminPlugin = new Elysia({ name: 'admin' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    if (payload.role !== 'admin') throw err(403, 'Admin access required');
    return {
      user: {
        userId: payload.sub,
        role: payload.role as 'admin',
        jti: payload.jti,
      },
    };
  },
);

/**
 * Host guard — role must be 'host'.
 */
export const hostPlugin = new Elysia({ name: 'host' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    if (payload.role !== 'host') throw err(403, 'Host access required');
    return {
      user: {
        userId: payload.sub,
        role: payload.role as 'host',
        jti: payload.jti,
      },
    };
  },
);

/**
 * Host-or-admin guard — role must be 'host', 'admin', or 'super_admin'.
 * Service layer enforces room-level ownership on top of this.
 */
export const hostOrAdminPlugin = new Elysia({ name: 'host-or-admin' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    if (payload.role !== 'host' && payload.role !== 'admin' && payload.role !== 'super_admin') {
      throw err(403, 'Host or admin access required');
    }
    return {
      user: {
        userId: payload.sub,
        role: payload.role as 'host' | 'admin' | 'super_admin',
        jti: payload.jti,
      },
    };
  },
);

/**
 * Admin-or-super-admin guard — role must be 'admin' or 'super_admin'.
 */
export const adminOrSuperAdminPlugin = new Elysia({ name: 'admin-or-super-admin' }).derive(
  { as: 'scoped' },
  async ({ headers }) => {
    const payload = await verifyAndCheck(headers);
    if (payload.role !== 'admin' && payload.role !== 'super_admin') {
      throw err(403, 'Admin or super-admin access required');
    }
    return {
      user: {
        userId: payload.sub,
        role: payload.role as 'admin' | 'super_admin',
        jti: payload.jti,
      },
    };
  },
);
