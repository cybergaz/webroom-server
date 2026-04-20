import Redis from 'ioredis'
import { env } from '../config/env'

// Separate client for pub/sub (can't be used for regular commands while subscribed)
export const redis = new Redis(env.redis.url, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
})

export const redisSub = new Redis(env.redis.url, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
})

redis.on('error', (err) => console.error('[Redis] error:', err.message))
redisSub.on('error', (err) => console.error('[Redis sub] error:', err.message))

// ─── Token blacklist (for force-logout) ──────────────────────────────────────

const BLACKLIST_PREFIX = 'bl:jti:'
const ACTIVE_JTIS_PREFIX = 'user:active_jtis:'

export async function blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
  await redis.set(`${BLACKLIST_PREFIX}${jti}`, '1', 'EX', ttlSeconds)
}

export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  const result = await redis.get(`${BLACKLIST_PREFIX}${jti}`)
  return result !== null
}

// Per-user tracking of currently-issued access-token JTIs. Used to revoke all
// prior access tokens when a session is replaced (new-device login).
export async function addActiveJti(userId: string, jti: string, ttlSeconds: number): Promise<void> {
  const key = `${ACTIVE_JTIS_PREFIX}${userId}`
  await redis.sadd(key, jti)
  // Keep set alive at least as long as the access token; refresh TTL on each add.
  await redis.expire(key, Math.max(ttlSeconds * 2, 3600))
}

export async function getActiveJtis(userId: string): Promise<string[]> {
  return redis.smembers(`${ACTIVE_JTIS_PREFIX}${userId}`)
}

export async function removeActiveJti(userId: string, jti: string): Promise<void> {
  await redis.srem(`${ACTIVE_JTIS_PREFIX}${userId}`, jti)
}

export async function clearActiveJtis(userId: string): Promise<void> {
  await redis.del(`${ACTIVE_JTIS_PREFIX}${userId}`)
}
