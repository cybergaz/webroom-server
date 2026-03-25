import { and, eq, or } from 'drizzle-orm'
import { db } from '../db/client'
import { users, rooms, roomMembers, refreshTokens } from '../db/schema'
import { sendToUser } from '../lib/ws-manager'

const err = (status: number, message: string) => Object.assign(new Error(message), { status })

// ─── Admin management (super_admin only) ─────────────────────────────────────

export async function createAdmin(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string },
) {
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required')

  // Check uniqueness of provided identifiers
  const conditions = []
  if (data.phone) conditions.push(eq(users.phone, data.phone))
  if (data.email) conditions.push(eq(users.email, data.email))

  const existing = await db.query.users.findFirst({ where: or(...conditions) })
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email'
    throw err(409, `${field} already registered`)
  }

  const passwordHash = await Bun.password.hash(data.password)
  const [user] = await db
    .insert(users)
    .values({
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      passwordHash,
      role: 'admin',
      status: 'approved',
      createdByUserId: actorId,
    })
    .returning({ id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role })

  return user
}

export async function listAdmins() {
  return db.query.users.findMany({
    where: eq(users.role, 'admin'),
    columns: { passwordHash: false },
    orderBy: (t, { asc }) => [asc(t.name)],
  })
}

export async function updateAdmin(adminId: string, data: { name?: string; email?: string }) {
  const admin = await db.query.users.findFirst({
    where: and(eq(users.id, adminId), eq(users.role, 'admin')),
  })
  if (!admin) throw err(404, 'Admin not found')

  const [updated] = await db
    .update(users)
    .set(data)
    .where(eq(users.id, adminId))
    .returning({ id: users.id, name: users.name, email: users.email })

  return updated
}

export async function activateAdmin(adminId: string) {
  return setUserStatusByRole(adminId, 'admin', 'approved')
}

export async function deactivateAdmin(adminId: string) {
  return setUserStatusByRole(adminId, 'admin', 'rejected')
}

export async function deleteAdmin(adminId: string) {
  const admin = await db.query.users.findFirst({
    where: and(eq(users.id, adminId), eq(users.role, 'admin')),
  })
  if (!admin) throw err(404, 'Admin not found')

  await db.delete(users).where(eq(users.id, adminId))
}

// ─── Host management (scoped to admin) ──────────────────────────────────────

export async function createHost(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string },
) {
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required')

  const conditions = []
  if (data.phone) conditions.push(eq(users.phone, data.phone))
  if (data.email) conditions.push(eq(users.email, data.email))

  const existing = await db.query.users.findFirst({ where: or(...conditions) })
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email'
    throw err(409, `${field} already registered`)
  }

  const passwordHash = await Bun.password.hash(data.password)
  const [user] = await db
    .insert(users)
    .values({
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      passwordHash,
      role: 'host',
      status: 'approved',
      createdByUserId: actorId,
    })
    .returning({ id: users.id, name: users.name, phone: users.phone, role: users.role })

  return user
}

export async function listHosts(adminId: string) {
  return db.query.users.findMany({
    where: and(eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
    columns: { passwordHash: false },
    orderBy: (t, { asc }) => [asc(t.name)],
  })
}

export async function updateHost(hostId: string, adminId: string, data: { name?: string; email?: string }) {
  const host = await db.query.users.findFirst({
    where: and(eq(users.id, hostId), eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
  })
  if (!host) throw err(404, 'Host not found')

  const [updated] = await db
    .update(users)
    .set(data)
    .where(eq(users.id, hostId))
    .returning({ id: users.id, name: users.name, email: users.email })

  return updated
}

export async function activateHost(hostId: string, adminId: string) {
  const host = await db.query.users.findFirst({
    where: and(eq(users.id, hostId), eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
  })
  if (!host) throw err(404, 'Host not found')

  return setUserStatusByRole(hostId, 'host', 'approved')
}

export async function deactivateHost(hostId: string, adminId: string) {
  const host = await db.query.users.findFirst({
    where: and(eq(users.id, hostId), eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
  })
  if (!host) throw err(404, 'Host not found')

  return setUserStatusByRole(hostId, 'host', 'rejected')
}

export async function deleteHost(hostId: string, adminId: string) {
  const host = await db.query.users.findFirst({
    where: and(eq(users.id, hostId), eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
  })
  if (!host) throw err(404, 'Host not found')

  await db.delete(users).where(eq(users.id, hostId))
}

export async function assignHostToRoom(roomId: string, hostId: string, adminId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) })
  if (!room) throw err(404, 'Room not found')

  const host = await db.query.users.findFirst({
    where: and(eq(users.id, hostId), eq(users.role, 'host'), eq(users.createdByUserId, adminId)),
  })
  if (!host) throw err(404, 'Host not found')

  const [updated] = await db.transaction(async (tx) => {
    const result = await tx
      .update(rooms)
      .set({ hostId })
      .where(eq(rooms.id, roomId))
      .returning({ id: rooms.id, hostId: rooms.hostId })

    await tx
      .insert(roomMembers)
      .values({ roomId, userId: hostId })
      .onConflictDoNothing()

    return result
  })

  return updated
}

export async function setRoomActive(roomId: string, active: boolean) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) })
  if (!room) throw err(404, 'Room not found')
  if (room.status === 'ended') throw err(409, 'Cannot change status of a permanently ended room')
  if (room.status === 'live') throw err(409, 'Room is currently live — end the session first')

  const [updated] = await db
    .update(rooms)
    .set({ status: active ? 'active' : 'inactive' })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id, status: rooms.status })

  return updated
}

// ─── User management (scoped to admin) ──────────────────────────────────────

export async function createUser(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string },
) {
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required')

  const conditions = []
  if (data.phone) conditions.push(eq(users.phone, data.phone))
  if (data.email) conditions.push(eq(users.email, data.email))

  const existing = await db.query.users.findFirst({ where: or(...conditions) })
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email'
    throw err(409, `${field} already registered`)
  }

  const passwordHash = await Bun.password.hash(data.password)
  const [user] = await db
    .insert(users)
    .values({
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      passwordHash,
      role: 'user',
      status: 'approved',
      createdByUserId: actorId,
    })
    .returning({ id: users.id, name: users.name, phone: users.phone, role: users.role, status: users.status })

  return user
}

export async function listUsers(adminId: string) {
  return db.query.users.findMany({
    where: and(eq(users.role, 'user'), eq(users.createdByUserId, adminId)),
    columns: { passwordHash: false },
    orderBy: (t, { asc }) => [asc(t.name)],
  })
}

export async function updateUser(userId: string, adminId: string, data: { name?: string; email?: string }) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, 'user'), eq(users.createdByUserId, adminId)),
  })
  if (!user) throw err(404, 'User not found')

  const [updated] = await db
    .update(users)
    .set(data)
    .where(eq(users.id, userId))
    .returning({ id: users.id, name: users.name, email: users.email })

  return updated
}

export async function activateUser(userId: string, adminId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, 'user'), eq(users.createdByUserId, adminId)),
  })
  if (!user) throw err(404, 'User not found')

  return setUserStatusByRole(userId, 'user', 'approved')
}

export async function deactivateUser(userId: string, adminId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, 'user'), eq(users.createdByUserId, adminId)),
  })
  if (!user) throw err(404, 'User not found')

  return setUserStatusByRole(userId, 'user', 'rejected')
}

export async function deleteUser(userId: string, adminId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, 'user'), eq(users.createdByUserId, adminId)),
  })
  if (!user) throw err(404, 'User not found')

  await db.delete(users).where(eq(users.id, userId))
}

export async function searchPendingUser(requestId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.requestId, requestId), eq(users.status, 'pending_approval')),
    columns: { id: true, name: true, phone: true, email: true, requestId: true, createdAt: true },
  })
  return user ?? null
}

export async function approveUser(userId: string, adminId: string, temporaryPassword?: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.status, 'pending_approval')),
  })
  if (!user) throw err(404, 'User not found or already processed')

  const updates: Partial<typeof users.$inferInsert> = {
    status: 'approved',
    createdByUserId: adminId,
  }
  if (temporaryPassword) {
    updates.passwordHash = await Bun.password.hash(temporaryPassword)
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, userId))
    .returning({ id: users.id, status: users.status })

  await sendToUser(userId, 'user.approved', { userId })

  return updated
}

export async function rejectUser(userId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.status, 'pending_approval')),
  })
  if (!user) throw err(404, 'User not found or already processed')

  const [updated] = await db
    .update(users)
    .set({ status: 'rejected' })
    .where(eq(users.id, userId))
    .returning({ id: users.id, status: users.status })

  await sendToUser(userId, 'user.rejected', { userId })

  return updated
}

export async function forceLogoutUser(userId: string, adminId: string) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.createdByUserId, adminId)),
  })
  if (!user) throw err(404, 'User not found')

  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId))

  await sendToUser(userId, 'user.force_logout', {
    userId,
    reason: 'Logged out by administrator',
  })

  return { message: 'User force-logged out' }
}

export async function forceLogoutRoomUsers(roomId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) })
  if (!room) throw err(404, 'Room not found')

  const { roomMembers } = await import('../db/schema')
  const members = await db.query.roomMembers.findMany({
    where: eq(roomMembers.roomId, roomId),
    columns: { userId: true },
  })

  await Promise.all(
    members.map(async (m) => {
      await db.delete(refreshTokens).where(eq(refreshTokens.userId, m.userId))
      await sendToUser(m.userId, 'user.force_logout', {
        userId: m.userId,
        reason: 'Logged out by administrator',
      })
    }),
  )

  return { loggedOutCount: members.length }
}

// ─── Room listing ────────────────────────────────────────────────────────────

export async function listAllRooms() {
  return db.query.rooms.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setUserStatusByRole(
  userId: string,
  role: 'user' | 'host' | 'admin',
  status: 'approved' | 'rejected',
) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, role)),
  })
  if (!user) throw err(404, `${role.charAt(0).toUpperCase() + role.slice(1)} not found`)

  const [updated] = await db
    .update(users)
    .set({ status })
    .where(eq(users.id, userId))
    .returning({ id: users.id, status: users.status })

  return updated
}
