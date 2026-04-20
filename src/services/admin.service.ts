import { and, eq, exists, ilike, isNull, or, sql, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { adminUserAdoptions, adminLicenses, users, rooms, roomMembers, refreshTokens, roomSessions, sessionParticipants } from '../db/schema';
import { sendToUser, sendToRoomMembers } from '../lib/ws-manager';
import { ensureCallHost } from '../lib/getstream';
import { assertAdminLicenseActive } from './license.service';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

function isAdoptedBy(adminId: string) {
  return exists(
    db.select({ _: adminUserAdoptions.id })
      .from(adminUserAdoptions)
      .where(and(
        eq(adminUserAdoptions.adminId, adminId),
        eq(adminUserAdoptions.userId, users.id),
      )),
  );
}

async function autoAdopt(tx: Pick<typeof db, 'insert'>, adminId: string, userId: string) {
  await tx.insert(adminUserAdoptions).values({ adminId, userId }).onConflictDoNothing();
}

// ─── Admin management (super_admin only) ─────────────────────────────────────

export async function createAdmin(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string; },
) {
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required');

  // Check uniqueness of provided identifiers
  const conditions = [];
  if (data.phone) conditions.push(eq(users.phone, data.phone));
  if (data.email) conditions.push(eq(users.email, data.email));

  const existing = await db.query.users.findFirst({ where: or(...conditions) });
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email';
    throw err(409, `${field} already registered`);
  }

  const passwordHash = await Bun.password.hash(data.password);
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
    .returning({ id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role });

  return user;
}

export async function listAdmins() {
  const rows = await db
    .select({
      id: users.id,
      requestId: users.requestId,
      name: users.name,
      phone: users.phone,
      email: users.email,
      role: users.role,
      status: users.status,
      createdByUserId: users.createdByUserId,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      appVersion: users.appVersion,
      licensePlanDuration: adminLicenses.planDuration,
      licenseActivatedAt: adminLicenses.activatedAt,
      licenseExpiresAt: adminLicenses.expiresAt,
    })
    .from(users)
    .leftJoin(adminLicenses, eq(adminLicenses.adminId, users.id))
    .where(eq(users.role, 'admin'))
    .orderBy(users.name);

  const now = Date.now();
  return rows.map(({ licensePlanDuration, licenseActivatedAt, licenseExpiresAt, ...u }) => {
    if (!licenseExpiresAt) return { ...u, license: null };
    const exp = new Date(licenseExpiresAt).getTime();
    const expired = exp <= now;
    const daysRemaining = expired ? 0 : Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
    return {
      ...u,
      license: {
        planDuration: licensePlanDuration!,
        activatedAt: new Date(licenseActivatedAt!).toISOString(),
        expiresAt: new Date(licenseExpiresAt).toISOString(),
        status: expired ? ('expired' as const) : ('active' as const),
        daysRemaining,
      },
    };
  });
}

export async function updateAdmin(adminId: string, data: { name?: string; email?: string; password?: string; }) {
  const admin = await db.query.users.findFirst({
    where: and(eq(users.id, adminId), eq(users.role, 'admin')),
  });
  if (!admin) throw err(404, 'Admin not found');

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.password) updateData.passwordHash = await Bun.password.hash(data.password);

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, adminId))
    .returning({ id: users.id, name: users.name, email: users.email });

  return updated;
}

export async function activateAdmin(adminId: string) {
  return setUserStatusByRole(adminId, 'admin', 'approved');
}

export async function deactivateAdmin(adminId: string) {
  return setUserStatusByRole(adminId, 'admin', 'rejected');
}

export async function deleteAdmin(adminId: string) {
  const admin = await db.query.users.findFirst({
    where: and(eq(users.id, adminId), eq(users.role, 'admin')),
  });
  if (!admin) throw err(404, 'Admin not found');

  await db.delete(users).where(eq(users.id, adminId));
}

// ─── Host management (scoped to admin) ──────────────────────────────────────

export async function createHost(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string; },
) {
  await assertAdminLicenseActive(actorId);
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required');

  const conditions = [];
  if (data.phone) conditions.push(eq(users.phone, data.phone));
  if (data.email) conditions.push(eq(users.email, data.email));

  const existing = await db.query.users.findFirst({ where: or(...conditions) });
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email';
    throw err(409, `${field} already registered`);
  }

  const passwordHash = await Bun.password.hash(data.password);
  return db.transaction(async (tx) => {
    const [user] = await tx
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
      .returning({ id: users.id, name: users.name, phone: users.phone, role: users.role });

    await autoAdopt(tx, actorId, user.id);
    return user;
  });
}

export async function listHosts(adminId: string) {
  const latestToken = db
    .select({
      userId: refreshTokens.userId,
      deviceName: sql<string | null>`(
        SELECT rt2.device_name FROM refresh_tokens rt2
        WHERE rt2.user_id = ${refreshTokens.userId}
        ORDER BY rt2.created_at DESC
        LIMIT 1
      )`.as('device_name'),
    })
    .from(refreshTokens)
    .groupBy(refreshTokens.userId)
    .as('latest_token');

  return db.select({
    id: users.id, requestId: users.requestId, name: users.name, phone: users.phone,
    email: users.email, role: users.role, status: users.status,
    createdByUserId: users.createdByUserId, createdAt: users.createdAt,
    lastSeenAt: users.lastSeenAt,
    deviceName: latestToken.deviceName,
    lockedDeviceId: users.lockedDeviceId,
    lockedDeviceName: users.lockedDeviceName,
    allowDeviceChange: users.allowDeviceChange,
    appVersion: users.appVersion,
    assignedRoomCount: sql<number>`(
      SELECT COUNT(*) FROM rooms r
      WHERE r.host_id = ${users.id}
      AND r.created_by = ${adminId}
    )`.mapWith(Number),
  })
    .from(users)
    .leftJoin(latestToken, eq(latestToken.userId, users.id))
    .where(and(eq(users.role, 'host'), isAdoptedBy(adminId)))
    .orderBy(users.name);
}

export async function updateHost(hostId: string, adminId: string, data: { name?: string; email?: string; password?: string; }) {
  await assertAdminLicenseActive(adminId);
  const [host] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, 'host'), isAdoptedBy(adminId)))
    .limit(1);
  if (!host) throw err(404, 'Host not found');

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.password) updateData.passwordHash = await Bun.password.hash(data.password);

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, hostId))
    .returning({ id: users.id, name: users.name, email: users.email });

  return updated;
}

export async function activateHost(hostId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [host] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, 'host'), isAdoptedBy(adminId)))
    .limit(1);
  if (!host) throw err(404, 'Host not found');

  return setUserStatusByRole(hostId, 'host', 'approved');
}

export async function deactivateHost(hostId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [host] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, 'host'), isAdoptedBy(adminId)))
    .limit(1);
  if (!host) throw err(404, 'Host not found');

  return setUserStatusByRole(hostId, 'host', 'rejected');
}

export async function deleteHost(hostId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [host] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, 'host'), isAdoptedBy(adminId)))
    .limit(1);
  if (!host) throw err(404, 'Host not found');

  await db.delete(users).where(eq(users.id, hostId));
}

export async function assignHostToRoom(roomId: string, hostId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw err(404, 'Room not found');

  const [host] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, 'host'), isAdoptedBy(adminId)))
    .limit(1);
  if (!host) throw err(404, 'Host not found');

  const [updated] = await db.transaction(async (tx) => {
    const result = await tx
      .update(rooms)
      .set({ hostId })
      .where(eq(rooms.id, roomId))
      .returning({ id: rooms.id, hostId: rooms.hostId });

    await tx
      .insert(roomMembers)
      .values({ roomId, userId: hostId })
      .onConflictDoNothing();

    return result;
  });

  // Sync the new host's role on the GetStream call so they can goLive().
  if (room.getstreamCallId) {
    await ensureCallHost(room.getstreamCallId, hostId);
  }

  // Notify the host so their room list refreshes
  await sendToUser(hostId, 'room.member_added', {
    roomId,
    roomName: room.name,
    roomStatus: room.status,
  });

  return updated;
}

export async function unassignHostFromRoom(roomId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw err(404, 'Room not found');
  if (!room.hostId) throw err(409, 'Room has no host assigned');

  const [updated] = await db
    .update(rooms)
    .set({ hostId: null })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id, hostId: rooms.hostId });

  return updated;
}

export async function setRoomActive(roomId: string, active: boolean) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw err(404, 'Room not found');
  if (room.status === 'ended') throw err(409, 'Cannot change status of a permanently ended room');
  if (room.status === 'live') throw err(409, 'Room is currently live — end the session first');

  const newStatus = active ? 'active' : 'inactive';
  const [updated] = await db
    .update(rooms)
    .set({ status: newStatus })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id, status: rooms.status });

  // Notify all room members of status change
  await sendToRoomMembers(roomId, 'room.status_changed', {
    roomId,
    roomName: room.name,
    status: newStatus,
  });

  return updated;
}

// ─── User management (scoped to admin) ──────────────────────────────────────

export async function createUser(
  actorId: string,
  data: { name: string; phone?: string; email?: string; password: string; },
) {
  await assertAdminLicenseActive(actorId);
  if (!data.phone && !data.email) throw err(400, 'Phone or email is required');

  const conditions = [];
  if (data.phone) conditions.push(eq(users.phone, data.phone));
  if (data.email) conditions.push(eq(users.email, data.email));

  const existing = await db.query.users.findFirst({ where: or(...conditions) });
  if (existing) {
    const field = data.phone && existing.phone === data.phone ? 'Phone' : 'Email';
    throw err(409, `${field} already registered`);
  }

  const passwordHash = await Bun.password.hash(data.password);
  return db.transaction(async (tx) => {
    const [user] = await tx
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
      .returning({ id: users.id, name: users.name, phone: users.phone, role: users.role, status: users.status });

    await autoAdopt(tx, actorId, user.id);
    return user;
  });
}

export async function listUsers(adminId: string) {
  // Subquery: most recent refresh token per user
  const latestToken = db
    .select({
      userId: refreshTokens.userId,
      deviceName: sql<string | null>`(
        SELECT rt2.device_name FROM refresh_tokens rt2
        WHERE rt2.user_id = ${refreshTokens.userId}
        ORDER BY rt2.created_at DESC
        LIMIT 1
      )`.as('device_name'),
    })
    .from(refreshTokens)
    .groupBy(refreshTokens.userId)
    .as('latest_token');

  const result = await db.select({
    id: users.id,
    requestId: users.requestId,
    name: users.name,
    phone: users.phone,
    email: users.email,
    role: users.role,
    status: users.status,
    createdByUserId: users.createdByUserId,
    createdAt: users.createdAt,
    lastSeenAt: users.lastSeenAt,
    deviceName: latestToken.deviceName,
    lockedDeviceId: users.lockedDeviceId,
    lockedDeviceName: users.lockedDeviceName,
    allowDeviceChange: users.allowDeviceChange,
    appVersion: users.appVersion,
    assignedRoomCount: sql<number>`(
      SELECT COUNT(*) FROM room_members rm
      JOIN rooms r ON r.id = rm.room_id
      WHERE rm.user_id = ${users.id}
      AND r.created_by = ${adminId}
    )`.mapWith(Number),
  })
    .from(users)
    .leftJoin(latestToken, eq(latestToken.userId, users.id))
    .where(and(eq(users.role, 'user'), isAdoptedBy(adminId)))
    .orderBy(users.name);
  console.log('[ADMIN] listUsers result sample:', result.length > 0 ? { deviceName: result[0].deviceName, lastSeenAt: result[0].lastSeenAt } : 'no users');
  return result;
}

export async function updateUser(userId: string, adminId: string, data: { name?: string; email?: string; }) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.role, 'user'), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  const [updated] = await db
    .update(users)
    .set(data)
    .where(eq(users.id, userId))
    .returning({ id: users.id, name: users.name, email: users.email });

  return updated;
}

export async function activateUser(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.role, 'user'), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  return setUserStatusByRole(userId, 'user', 'approved');
}

export async function deactivateUser(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.role, 'user'), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  return setUserStatusByRole(userId, 'user', 'rejected');
}

export async function deleteUser(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.role, 'user'), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  await db.delete(users).where(eq(users.id, userId));
}

export async function searchUser(requestId: string, adminId: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.requestId, requestId),
    columns: { id: true, name: true, phone: true, email: true, requestId: true, status: true, createdByUserId: true, createdAt: true },
  });

  if (!user) return null;

  if (user.status === 'pending_approval') {
    const { createdByUserId, ...basicInfo } = user;
    return { user: basicInfo, code: 'PENDING_APPROVAL' as const };
  }

  const [adoption] = await db
    .select({ id: adminUserAdoptions.id })
    .from(adminUserAdoptions)
    .where(and(eq(adminUserAdoptions.adminId, adminId), eq(adminUserAdoptions.userId, user.id)))
    .limit(1);

  const code = adoption ? 'ALREADY_ADOPTED' as const : 'AVAILABLE_FOR_ADOPTION' as const;
  return { user, code };
}

export async function approveOrAdopt(userId: string, adminId: string, temporaryPassword?: string) {
  await assertAdminLicenseActive(adminId);
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, status: true },
  });
  if (!user) throw err(404, 'User not found');

  if (user.status === 'pending_approval') {
    const updates: Partial<typeof users.$inferInsert> = { status: 'approved', createdByUserId: adminId };
    if (temporaryPassword) updates.passwordHash = await Bun.password.hash(temporaryPassword);

    const [updated] = await db.transaction(async (tx) => {
      const result = await tx
        .update(users)
        .set(updates)
        .where(eq(users.id, userId))
        .returning({ id: users.id, status: users.status });
      await autoAdopt(tx, adminId, userId);
      return result;
    });

    await sendToUser(userId, 'user.approved', { userId });
    return { ...updated, code: 'APPROVED_AND_ADOPTED' as const };
  }

  if (user.status === 'approved') {
    const [existing] = await db
      .select({ id: adminUserAdoptions.id })
      .from(adminUserAdoptions)
      .where(and(eq(adminUserAdoptions.adminId, adminId), eq(adminUserAdoptions.userId, userId)))
      .limit(1);

    if (existing) return { id: userId, status: user.status, code: 'ALREADY_ADOPTED' as const };

    await db.insert(adminUserAdoptions).values({ adminId, userId }).onConflictDoNothing();
    return { id: userId, status: user.status, code: 'ADOPTED' as const };
  }

  throw err(409, `Cannot process user with status: ${user.status}`);
}

export async function rejectUser(userId: string, adminId?: string) {
  if (adminId) await assertAdminLicenseActive(adminId);
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.status, 'pending_approval')),
  });
  if (!user) throw err(404, 'User not found or already processed');

  const [updated] = await db
    .update(users)
    .set({ status: 'rejected' })
    .where(eq(users.id, userId))
    .returning({ id: users.id, status: users.status });

  await sendToUser(userId, 'user.rejected', { userId });

  return updated;
}

export async function allowDeviceChange(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), or(eq(users.role, 'user'), eq(users.role, 'host')), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  const [updated] = await db
    .update(users)
    .set({ allowDeviceChange: true })
    .where(eq(users.id, userId))
    .returning({ id: users.id, allowDeviceChange: users.allowDeviceChange });

  return updated;
}

export async function resetDeviceLock(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), or(eq(users.role, 'user'), eq(users.role, 'host')), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  const [updated] = await db
    .update(users)
    .set({ lockedDeviceId: null, lockedDeviceName: null, allowDeviceChange: false })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  return updated;
}

export async function forceLogoutUser(userId: string, adminId: string) {
  await assertAdminLicenseActive(adminId);
  const [user] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isAdoptedBy(adminId)))
    .limit(1);
  if (!user) throw err(404, 'User not found');

  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));

  await sendToUser(userId, 'user.force_logout', {
    userId,
    reason: 'Logged out by administrator',
  });

  return { message: 'User force-logged out' };
}

export async function adoptUser(adminId: string, targetUserId: string) {
  await assertAdminLicenseActive(adminId);
  const [target] = await db.select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, targetUserId), or(eq(users.role, 'user'), eq(users.role, 'host'))))
    .limit(1);
  if (!target) throw err(404, 'User or host not found');

  await db.insert(adminUserAdoptions).values({ adminId, userId: targetUserId }).onConflictDoNothing();
  return { adminId, userId: targetUserId, adopted: true };
}

export async function unadoptUser(adminId: string, targetUserId: string) {
  const result = await db.delete(adminUserAdoptions)
    .where(and(eq(adminUserAdoptions.adminId, adminId), eq(adminUserAdoptions.userId, targetUserId)))
    .returning({ id: adminUserAdoptions.id });
  if (result.length === 0) throw err(404, 'Adoption not found');
  return { adminId, userId: targetUserId, adopted: false };
}

export async function forceLogoutRoomUsers(roomId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw err(404, 'Room not found');

  const { roomMembers } = await import('../db/schema');
  const members = await db.query.roomMembers.findMany({
    where: eq(roomMembers.roomId, roomId),
    columns: { userId: true },
  });

  await Promise.all(
    members.map(async (m) => {
      await db.delete(refreshTokens).where(eq(refreshTokens.userId, m.userId));
      await sendToUser(m.userId, 'user.force_logout', {
        userId: m.userId,
        reason: 'Logged out by administrator',
      });
    }),
  );

  return { loggedOutCount: members.length };
}

// ─── Room listing ────────────────────────────────────────────────────────────

export async function listAllRooms(adminId: string) {
  return db.query.rooms.findMany({
    where: eq(rooms.createdBy, adminId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

export async function listAllRoomsWithMembership(adminId: string, userId: string) {
  const rows = await db
    .select({
      id: rooms.id,
      name: rooms.name,
      description: rooms.description,
      status: rooms.status,
      getstreamCallId: rooms.getstreamCallId,
      hostId: rooms.hostId,
      createdAt: rooms.createdAt,
      isMember: roomMembers.userId,
    })
    .from(rooms)
    .leftJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.userId, userId)),
    )
    .where(eq(rooms.createdBy, adminId))
    .orderBy(rooms.createdAt);

  return rows.map(({ isMember, ...room }) => ({
    ...room,
    isMember: isMember !== null,
  }));
}

// ─── Room Activity (live rooms + active participants) ────────────────────────

export async function getLiveRoomsWithParticipants(adminId: string) {
  const liveRooms = await db.query.rooms.findMany({
    where: and(eq(rooms.createdBy, adminId), eq(rooms.status, 'live')),
    columns: { id: true, name: true, hostId: true },
  });

  const result = await Promise.all(
    liveRooms.map(async (room) => {
      const session = await db.query.roomSessions.findFirst({
        where: and(eq(roomSessions.roomId, room.id), isNull(roomSessions.endedAt)),
        columns: { id: true },
      });

      // Resolve host name
      let hostName: string | null = null;
      if (room.hostId) {
        const host = await db.query.users.findFirst({
          where: eq(users.id, room.hostId),
          columns: { name: true },
        });
        hostName = host?.name ?? null;
      }

      if (!session) return { ...room, hostName, participants: [] };

      const participants = await db
        .select({
          userId: sessionParticipants.userId,
          name: users.name,
        })
        .from(sessionParticipants)
        .innerJoin(users, eq(users.id, sessionParticipants.userId))
        .where(
          and(
            eq(sessionParticipants.sessionId, session.id),
            isNull(sessionParticipants.leftAt),
          ),
        );

      // Exclude host from participants list
      const filtered = participants.filter((p) => p.userId !== room.hostId);

      return { ...room, hostName, participants: filtered };
    }),
  );

  return result;
}

// ─── Attendance ─────────────────────────────────────────────────────────────

export async function getAttendance(
  adminId: string,
  opts: { date: string; search?: string; page?: number; limit?: number },
) {
  const { date, search, page = 1, limit = 20 } = opts;
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const offset = (page - 1) * limit;

  // Build WHERE conditions
  const conditions = [
    or(eq(users.role, 'user'), eq(users.role, 'host')),
    eq(users.status, 'approved'),
  ];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(users.name, pattern),
        ilike(users.phone, pattern),
        ilike(users.email, pattern),
      )!,
    );
  }

  // Count total matching rows (without pagination)
  const [{ count }] = await db
    .select({ count: sql<number>`count(DISTINCT ${users.id})` })
    .from(users)
    .innerJoin(
      adminUserAdoptions,
      and(eq(adminUserAdoptions.userId, users.id), eq(adminUserAdoptions.adminId, adminId)),
    )
    .where(and(...conditions));

  // Main query with pagination
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
      email: users.email,
      role: users.role,
      firstJoinAt: sql<string | null>`
        MIN(CASE
          WHEN ${sessionParticipants.joinedAt} >= ${dayStart}::timestamptz
           AND ${sessionParticipants.joinedAt} <= ${dayEnd}::timestamptz
          THEN ${sessionParticipants.joinedAt}
        END)
      `.as('first_join_at'),
    })
    .from(users)
    .innerJoin(
      adminUserAdoptions,
      and(eq(adminUserAdoptions.userId, users.id), eq(adminUserAdoptions.adminId, adminId)),
    )
    .leftJoin(
      sessionParticipants,
      eq(sessionParticipants.userId, users.id),
    )
    .where(and(...conditions))
    .groupBy(users.id, users.name, users.phone, users.email, users.role)
    .orderBy(users.name)
    .limit(limit)
    .offset(offset);

  return {
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      role: r.role,
      present: r.firstJoinAt !== null,
      firstJoinAt: r.firstJoinAt,
    })),
    total: Number(count),
    page,
    limit,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setUserStatusByRole(
  userId: string,
  role: 'user' | 'host' | 'admin',
  status: 'approved' | 'rejected',
) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.role, role)),
  });
  if (!user) throw err(404, `${role.charAt(0).toUpperCase() + role.slice(1)} not found`);

  const [updated] = await db
    .update(users)
    .set({ status })
    .where(eq(users.id, userId))
    .returning({ id: users.id, status: users.status });

  return updated;
}
