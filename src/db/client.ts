import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env'
import * as schema from './schema'
import * as relations from './relations'

const queryClient = postgres(env.db.url, {
  max: 20,          // connection pool size
  idle_timeout: 30, // close idle connections after 30s
  connect_timeout: 10,
})

export const db = drizzle(queryClient, { schema: { ...schema, ...relations } })
