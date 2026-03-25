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

export async function blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
  await redis.set(`${BLACKLIST_PREFIX}${jti}`, '1', 'EX', ttlSeconds)
}

export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  const result = await redis.get(`${BLACKLIST_PREFIX}${jti}`)
  return result !== null
}
