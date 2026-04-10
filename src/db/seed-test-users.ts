/**
 * Seed Play Store / QA test accounts.
 *
 * Creates two pre-approved test users (user + host) and a shared test room,
 * then assigns both users as room members. Test accounts bypass device-lock
 * enforcement so reviewers can log in from any device any number of times.
 *
 * Usage:
 *   bun run db:seed:test
 *
 * Credentials are taken from env vars so you can override them in prod:
 *   TEST_USER_EMAIL     (default: test.user@webroom.app)
 *   TEST_USER_PASSWORD  (default: TestUser@123)
 *   TEST_HOST_EMAIL     (default: test.host@webroom.app)
 *   TEST_HOST_PASSWORD  (default: TestHost@123)
 *   TEST_ROOM_NAME      (default: Test Room)
 */

import { eq, or } from 'drizzle-orm'
import { db } from './client'
import { users, rooms, roomMembers } from './schema'

const TEST_USER_EMAIL    = process.env.TEST_USER_EMAIL    ?? 'test.user@webroom.app'
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'TestUser@123'
const TEST_HOST_EMAIL    = process.env.TEST_HOST_EMAIL    ?? 'test.host@webroom.app'
const TEST_HOST_PASSWORD = process.env.TEST_HOST_PASSWORD ?? 'TestHost@123'
const TEST_ROOM_NAME     = process.env.TEST_ROOM_NAME     ?? 'Test Room'

async function upsertTestUser(opts: {
  name: string
  email: string
  password: string
  role: 'user' | 'host'
}) {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, opts.email),
  })

  if (existing) {
    // Ensure it's approved and flagged as test account (idempotent re-run)
    await db.update(users)
      .set({ status: 'approved', isTestAccount: true, lockedDeviceId: null, lockedDeviceName: null })
      .where(eq(users.id, existing.id))
    console.log(`[seed:test] ${opts.role} already exists — refreshed (${opts.email})`)
    return existing.id
  }

  const passwordHash = await Bun.password.hash(opts.password)
  const [user] = await db.insert(users).values({
    name: opts.name,
    email: opts.email,
    passwordHash,
    role: opts.role,
    status: 'approved',
    isTestAccount: true,
  }).returning({ id: users.id })

  console.log(`[seed:test] created ${opts.role}: ${opts.email}`)
  return user.id
}

async function seedTestUsers() {
  // ── Users ──────────────────────────────────────────────────────────────────
  const [hostId, userId] = await Promise.all([
    upsertTestUser({
      name: 'Test Host',
      email: TEST_HOST_EMAIL,
      password: TEST_HOST_PASSWORD,
      role: 'host',
    }),
    upsertTestUser({
      name: 'Test User',
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      role: 'user',
    }),
  ])

  // ── Room ───────────────────────────────────────────────────────────────────
  let roomId: string

  const existingRoom = await db.query.rooms.findFirst({
    where: eq(rooms.name, TEST_ROOM_NAME),
  })

  if (existingRoom) {
    roomId = existingRoom.id
    console.log(`[seed:test] room already exists — skipping (${TEST_ROOM_NAME})`)
  } else {
    roomId = crypto.randomUUID()
    await db.insert(rooms).values({
      id: roomId,
      name: TEST_ROOM_NAME,
      description: 'Pre-created room for Play Store / QA testing',
      getstreamCallId: roomId,
      createdBy: hostId,
      hostId: hostId,
    })
    console.log(`[seed:test] created room: ${TEST_ROOM_NAME}`)
  }

  // ── Room members ───────────────────────────────────────────────────────────
  for (const [label, memberId] of [['host', hostId], ['user', userId]] as const) {
    const existing = await db.query.roomMembers.findFirst({
      where: (t, { and }) => and(eq(t.roomId, roomId), eq(t.userId, memberId)),
    })
    if (!existing) {
      await db.insert(roomMembers).values({ roomId, userId: memberId })
      console.log(`[seed:test] added ${label} to room`)
    } else {
      console.log(`[seed:test] ${label} already a room member — skipping`)
    }
  }

  console.log('\n[seed:test] done.')
  console.log(`  User  email : ${TEST_USER_EMAIL}`)
  console.log(`  User  pass  : ${TEST_USER_PASSWORD}`)
  console.log(`  Host  email : ${TEST_HOST_EMAIL}`)
  console.log(`  Host  pass  : ${TEST_HOST_PASSWORD}`)
  console.log(`  Room        : ${TEST_ROOM_NAME}\n`)
}

seedTestUsers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed:test] failed:', err)
    process.exit(1)
  })
