import { and, eq, or } from 'drizzle-orm';
import { db } from '../db/client';
import { rooms, roomMembers } from '../db/schema';
import {
  createGetstreamCall,
  ensureCallHost,
  generateGetstreamToken,
  muteUserInCall,
  muteAllInCall,
  kickUserFromCall,
  endGetstreamCall,
} from '../lib/getstream';
import { env } from '../config/env';
import type { UserRole } from '../lib/jwt';
import * as sessionService from './session.service';
import { nanoid } from 'nanoid';
import { sendToUser } from '../lib/ws-manager';

// ─── List rooms ───────────────────────────────────────────────────────────────

export async function listRooms(userId: string, role: UserRole) {
  if (role === 'super_admin' || role === 'admin') {
    return db.query.rooms.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  if (role === 'host') {
    return db.query.rooms.findMany({
      where: or(eq(rooms.hostId, userId), eq(rooms.createdBy, userId)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  // user: rooms they've been assigned to
  const memberships = await db.query.roomMembers.findMany({
    where: eq(roomMembers.userId, userId),
    with: { room: true },
  });
  return memberships.map((m) => m.room);
}

// ─── Create room ──────────────────────────────────────────────────────────────

export async function createRoom(
  actorId: string,
  name: string,
  description?: string,
  hostId?: string,
) {
  const roomId = crypto.randomUUID();
  // const getstreamCallId = nanoid(26);
  const getstreamCallId = roomId;

  // await createGetstreamCall(getstreamCallId, actorId, name);

  const [room] = await db
    .insert(rooms)
    .values({
      id: roomId,
      name,
      description,
      getstreamCallId,
      createdBy: actorId,
      hostId: hostId ?? null,
    })
    .returning();

  if (hostId) {
    await addMember(room.id, actorId, hostId, 'host');
  }

  return {
    roomId: room.id,
    name: room.name,
    status: room.status,
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
  };
}

// ─── Get room ─────────────────────────────────────────────────────────────────

export async function getRoom(roomId: string, userId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

  await assertRoomAccess(roomId, userId);

  const isHost = room.hostId === userId || room.createdBy === userId;

  // all group members with their id and names (for host to manage them if needed)
  const all_members = await db.query.roomMembers.findMany({
    where: eq(roomMembers.roomId, roomId),
    with: { user: { columns: { id: true, name: true } } },
  });


  return {
    id: room.id,
    name: room.name,
    description: room.description,
    status: room.status,
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
    isHost,
    getstreamToken: generateGetstreamToken(userId),
    allMembers: all_members.map((m) => ({ member_id: m.id, id: m.user.id, name: m.user.name })),
  };
}

// ─── Get session history for a room (host-scoped) ────────────────────────────

export async function getRoomSessions(roomId: string, actorId: string, actorRole: UserRole) {
  await assertRoomManager(roomId, actorId, actorRole);
  return sessionService.getSessionHistory(roomId);
}

// ─── Start room (host action) ─────────────────────────────────────────────────
// Sets status: active → live. Opens a session. Returns GetStream credentials
// so the host can join the call immediately.

export async function startRoom(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  if (room.status === 'inactive') {
    throw Object.assign(new Error('Room has been disabled by admin'), { status: 403 });
  }
  // if (room.status === 'live') {
  //   throw Object.assign(new Error('Room is already live'), { status: 409 });
  // }
  if (room.status === 'ended') {
    throw Object.assign(new Error('Room has been permanently ended'), { status: 410 });
  }

  await db.update(rooms).set({ status: 'live' }).where(eq(rooms.id, roomId));
  const session = await sessionService.getOrCreateSession(roomId);

  // Ensure the current host has the 'host' role on the GetStream call,
  // even if they weren't the original creator (e.g. admin reassigned hosts).
  await ensureCallHost(room.getstreamCallId, actorId);

  // Record the host as the first participant
  await sessionService.recordParticipantJoin(session.id, actorId);

  return {
    roomId: room.id,
    name: room.name,
    status: 'live' as const,
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
    getstreamToken: generateGetstreamToken(actorId),
    getstreamApiKey: env.getstream.apiKey,
  };
}

// ─── Join room (user action) ──────────────────────────────────────────────────
// Only allowed when room is live (host is present).

export async function joinRoom(roomId: string, userId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

  if (room.status === 'inactive') {
    throw Object.assign(new Error('Room has been disabled by admin'), { status: 403 });
  }
  if (room.status === 'active') {
    throw Object.assign(new Error('Room not started yet — waiting for host'), { status: 403 });
  }
  if (room.status === 'ended') {
    throw Object.assign(new Error('Room has ended'), { status: 410 });
  }
  // status === 'live' — proceed

  await assertRoomAccess(roomId, userId);

  // Record this user joining the active session
  const session = await sessionService.getActiveSession(roomId);
  if (session) await sessionService.recordParticipantJoin(session.id, userId);

  return {
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
    getstreamToken: generateGetstreamToken(userId),
    getstreamApiKey: env.getstream.apiKey,
  };
}

// ─── Leave room ───────────────────────────────────────────────────────────────
// If the host leaves, kick everyone, close the session, set status back to active.

export async function leaveRoom(roomId: string, userId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room || room.status !== 'live') return;

  const isHost = room.hostId === userId || room.createdBy === userId;

  if (!isHost) {
    // Regular user leaving — just record their departure
    const session = await sessionService.getActiveSession(roomId);
    if (session) await sessionService.recordParticipantLeave(session.id, userId);
    return;
  }

  // Host left — shut down the session
  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  await Promise.allSettled(members.map((m) => kickUserFromCall(room.getstreamCallId, m.userId)));

  await endGetstreamCall(room.getstreamCallId).catch(() => { });

  const activeSession = await sessionService.getActiveSession(roomId);
  if (activeSession) await sessionService.endSession(activeSession.id);

  await db.update(rooms).set({ status: 'active' }).where(eq(rooms.id, roomId));
}

// ─── Delete room ──────────────────────────────────────────────────────────────

export async function deleteRoom(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  await endGetstreamCall(room.getstreamCallId).catch(() => { });

  const activeSession = await sessionService.getActiveSession(roomId);
  if (activeSession) await sessionService.endSession(activeSession.id);

  await db.delete(rooms).where(eq(rooms.id, roomId));
}

// ─── List members ────────────────────────────────────────────────────────────

export async function listMembers(roomId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

  const rows = await db.query.roomMembers.findMany({
    where: eq(roomMembers.roomId, roomId),
    with: { user: { columns: { id: true, name: true, phone: true, email: true, role: true } } },
    orderBy: (t, { asc }) => [asc(t.addedAt)],
  });

  return rows.map((m) => ({ ...m.user, addedAt: m.addedAt }));
}

// ─── Add member ───────────────────────────────────────────────────────────────

export async function addMember(roomId: string, actorId: string, targetUserId: string, actorRole: UserRole) {
  await assertRoomManager(roomId, actorId, actorRole);

  const [member] = await db
    .insert(roomMembers)
    .values({ roomId, userId: targetUserId })
    .onConflictDoNothing()
    .returning();

  if (!member) throw Object.assign(new Error('User is already a member of this room'), { status: 409 });

  return { userId: member.userId, roomId: member.roomId, addedAt: member.addedAt };
}

// ─── Add member to multiple rooms ────────────────────────────────────────────

export async function addMemberToRooms(roomIds: string[], actorId: string, targetUserId: string, actorRole: UserRole) {
  const results = await Promise.all(
    roomIds.map(async (roomId) => {
      await assertRoomManager(roomId, actorId, actorRole);

      const [member] = await db
        .insert(roomMembers)
        .values({ roomId, userId: targetUserId })
        .onConflictDoNothing()
        .returning();

      return member ? { userId: member.userId, roomId: member.roomId, addedAt: member.addedAt } : null;
    }),
  );

  return results.filter(Boolean);
}

// ─── Remove member ────────────────────────────────────────────────────────────

export async function removeMember(roomId: string, actorId: string, targetUserId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, targetUserId)));

  await kickUserFromCall(room.getstreamCallId, targetUserId).catch(() => { });

  if (room.status === 'live') {
    const session = await sessionService.getActiveSession(roomId);
    if (session) await sessionService.recordParticipantLeave(session.id, targetUserId);
  }
}

// ─── Mute user ────────────────────────────────────────────────────────────────

export async function muteUser(
  roomId: string,
  actorId: string,
  targetUserId: string,
  muted: boolean,
  actorRole: UserRole,
) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  if (muted) {
    await muteUserInCall(room.getstreamCallId, targetUserId, actorId);
  }

  return { userId: targetUserId, isMuted: muted };
}

// ─── Mute all ─────────────────────────────────────────────────────────────────

export async function muteAll(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  await muteAllInCall(room.getstreamCallId, actorId);

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  return { mutedCount: members.length };
}

// ─── Unmute all ───────────────────────────────────────────────────────────────

export async function unmuteAll(roomId: string, actorId: string, actorRole: UserRole) {
  await assertRoomManager(roomId, actorId, actorRole);

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  return { unmutedCount: members.length };
}

// ─── Kick all ─────────────────────────────────────────────────────────────────

export async function kickAll(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });

  await Promise.allSettled(
    members.map((m) => kickUserFromCall(room.getstreamCallId, m.userId)),
  );

  if (room.status === 'live') {
    const session = await sessionService.getActiveSession(roomId);
    if (session) {
      await Promise.allSettled(
        members.map((m) => sessionService.recordParticipantLeave(session.id, m.userId)),
      );
    }
  }

  return { kickedCount: members.length };
}

// ─── End room (host action — ends session, room resets to active) ─────────────

export async function endRoom(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await assertRoomManager(roomId, actorId, actorRole);

  if (room.status !== 'live') {
    throw Object.assign(new Error('Room is not live'), { status: 409 });
  }

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  // console.log('Ending room, kicking members:', members.map((m) => m.userId));
  await Promise.allSettled(members.map((m) => kickUserFromCall(room.getstreamCallId, m.userId)));

  await endGetstreamCall(room.getstreamCallId);

  const activeSession = await sessionService.getActiveSession(roomId);
  if (activeSession) await sessionService.endSession(activeSession.id);

  // send ws message for room end to all members in the room
  // console.log('Notifying members of room end:');
  members.map(async (m) =>
    await sendToUser(
      m.userId,
      'room.ended',
      { roomId },
    )
  );

  const [updated] = await db
    .update(rooms)
    .set({ status: 'active' })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id, status: rooms.status });

  return updated;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function assertRoomManager(roomId: string, actorId: string, actorRole: UserRole) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

  const isCreator = room.createdBy === actorId;
  const isRoomHost = room.hostId === actorId;
  const isAdmin = actorRole === 'admin' || actorRole === 'super_admin';

  if (!isCreator && !isRoomHost && !isAdmin) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }

  return room;
}

async function assertRoomAccess(roomId: string, userId: string) {
  const [membership, room] = await Promise.all([
    db.query.roomMembers.findFirst({
      where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)),
    }),
    db.query.rooms.findFirst({ where: eq(rooms.id, roomId) }),
  ]);

  const isCreator = room?.createdBy === userId;
  const isRoomHost = room?.hostId === userId;

  if (!membership && !isCreator && !isRoomHost) {
    throw Object.assign(new Error('Not a member of this room'), { status: 403 });
  }
}
