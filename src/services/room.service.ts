import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rooms, roomMembers, adminUserAdoptions, users } from '../db/schema';
import {
  createGetstreamCall,
  ensureCallHost,
  generateGetstreamToken,
  goLiveCall,
  grantUserSendAudio,
  muteUserInCall,
  muteAllInCall,
  kickUserFromCall,
  endGetstreamCall,
  startCallRecording,
  stopCallRecording,
  listCallRecordings,
} from '../lib/getstream';
import { env } from '../config/env';
import type { UserRole } from '../lib/jwt';
import * as sessionService from './session.service';
import { nanoid } from 'nanoid';
import { sendToUser, sendToRoomMembers } from '../lib/ws-manager';
import {
  assertLicenseActiveForActor,
  assertLicenseActiveForRoom,
} from './license.service';

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
  await assertLicenseActiveForActor(actorId);
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

  // Get active session ID (if room is live)
  const activeSession = await sessionService.getActiveSession(roomId);

  return {
    id: room.id,
    name: room.name,
    description: room.description,
    status: room.status,
    sessionId: activeSession?.id ?? null,
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
    isHost,
    getstreamToken: generateGetstreamToken(userId),
    banners: room.banners ?? [],
    marqueeText: room.marqueeText,
    allMembers: all_members.map((m) => ({ member_id: m.id, id: m.user.id, name: m.user.name })),
  };
}

// ─── Update room content (banners + marquee text, admin/host action) ─────────

export async function updateRoomContent(
  roomId: string,
  actorId: string,
  actorRole: UserRole,
  input: { banners?: string[]; marqueeText?: string | null },
) {
  await assertRoomManager(roomId, actorId, actorRole);

  const patch: Record<string, unknown> = {};
  if (input.banners !== undefined) patch.banners = input.banners;
  if (input.marqueeText !== undefined) patch.marqueeText = input.marqueeText;

  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error('No fields to update'), { status: 400 });
  }

  const [updated] = await db
    .update(rooms)
    .set(patch)
    .where(eq(rooms.id, roomId))
    .returning({
      id: rooms.id,
      banners: rooms.banners,
      marqueeText: rooms.marqueeText,
    });

  return {
    roomId: updated.id,
    banners: updated.banners ?? [],
    marqueeText: updated.marqueeText,
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
  await assertLicenseActiveForRoom(roomId);
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

  // Run all independent start-up work in parallel. `ensureCallHost` makes
  // getOrCreate on the GetStream side (needed before the host can join);
  // the DB flip and session creation are independent.
  const [, session] = await Promise.all([
    db.update(rooms).set({ status: 'live' }).where(eq(rooms.id, roomId)),
    sessionService.getOrCreateSession(roomId),
    ensureCallHost(room.getstreamCallId, actorId),
  ]);

  // Record the host as the first participant (fire-and-forget; not on critical path)
  sessionService.recordParticipantJoin(session.id, actorId).catch((err) => {
    console.error('[Room] recordParticipantJoin (host) failed:', err?.message ?? err);
  });

  // NOTE: We do NOT broadcast room.status_changed here.
  // The host client calls /rooms/:roomId/host-ready after join() succeeds,
  // which then goLives + broadcasts to members. This prevents the race where
  // a fast user joins the GetStream call before the host is actually ready.

  return {
    roomId: room.id,
    name: room.name,
    status: 'live' as const,
    sessionId: session.id,
    getstreamCallId: room.getstreamCallId,
    getstreamCallType: env.getstream.callType,
    getstreamToken: generateGetstreamToken(actorId),
    getstreamApiKey: env.getstream.apiKey,
  };
}

// ─── Host ready (host confirms they joined the call and went live) ───────────
// Called by the host client after goLive() succeeds. Broadcasts to all members
// so they know the room is truly ready to join.

export async function confirmHostReady(roomId: string, actorId: string, actorRole: UserRole) {
  await assertLicenseActiveForRoom(roomId);
  const room = await assertRoomManager(roomId, actorId, actorRole);

  if (room.status !== 'live') {
    throw Object.assign(new Error('Room is not live'), { status: 409 });
  }

  // Take the call out of backstage first (fast), then fire recording and
  // the member broadcast in parallel. Recording requires the call to be
  // live, so goLive must land before it.
  const callId = room.getstreamCallId;
  await goLiveCall(callId).catch((err) => {
    console.error('[GoLive] failed for call', callId, err?.message ?? err);
  });
  await Promise.all([
    startCallRecording(callId).catch((err) => {
      console.error('[Recording] failed for call', callId, err?.message ?? err);
    }),
    sendToRoomMembers(roomId, 'room.status_changed', {
      roomId,
      roomName: room.name,
      status: 'live',
    }),
  ]);
}

// ─── Join room (user action) ──────────────────────────────────────────────────
// Only allowed when room is live (host is present).

export async function joinRoom(roomId: string, userId: string, deviceId?: string, deviceName?: string) {
  await assertLicenseActiveForRoom(roomId);
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
  await assertDeviceAllowedForRoom(roomId, userId, room.hostId, room.createdBy, deviceId, deviceName);

  // Run the session lookup and the (slow) send-audio grant in parallel —
  // the user doesn't actually need either to be done before the SDK join
  // starts talking to the SFU, but we want both kicked off before we reply
  // so they don't block the subsequent participant insert / PTT.
  const [session] = await Promise.all([
    sessionService.getActiveSession(roomId),
    grantUserSendAudio(room.getstreamCallId, userId).catch((err) => {
      console.error(`[Room] Failed to pre-grant send-audio for user ${userId} on call ${room.getstreamCallId}:`, err?.message ?? err);
    }),
  ]);

  if (session) {
    sessionService.recordParticipantJoin(session.id, userId).catch((err) => {
      console.error(`[Room] recordParticipantJoin failed for user ${userId}:`, err?.message ?? err);
    });
  }

  return {
    sessionId: session?.id,
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
  await stopCallRecording(room.getstreamCallId).catch(() => { });

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  await Promise.allSettled(members.map((m) => kickUserFromCall(room.getstreamCallId, m.userId)));

  await endGetstreamCall(room.getstreamCallId).catch(() => { });

  const activeSession = await sessionService.getActiveSession(roomId);
  if (activeSession) await sessionService.endSession(activeSession.id);

  await db.update(rooms).set({ status: 'active' }).where(eq(rooms.id, roomId));

  // Notify all room members of status change back to active
  await sendToRoomMembers(roomId, 'room.status_changed', {
    roomId,
    roomName: room.name,
    status: 'active',
  });
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

  const addedByAdminId = actorRole === 'admin' ? actorId : null;

  const [member] = await db
    .insert(roomMembers)
    .values({ roomId, userId: targetUserId, addedByAdminId })
    .onConflictDoNothing()
    .returning();

  if (!member) {
    if (addedByAdminId) {
      await db
        .update(roomMembers)
        .set({ addedByAdminId })
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, targetUserId),
            isNull(roomMembers.addedByAdminId),
          ),
        );
    }
    throw Object.assign(new Error('User is already a member of this room'), { status: 409 });
  }

  // Notify the added user so their room list refreshes
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId), columns: { id: true, name: true, status: true } });
  await sendToUser(targetUserId, 'room.member_added', {
    roomId,
    roomName: room?.name,
    roomStatus: room?.status,
  });

  return { userId: member.userId, roomId: member.roomId, addedAt: member.addedAt };
}

// ─── Add member to multiple rooms ────────────────────────────────────────────

export async function addMemberToRooms(roomIds: string[], actorId: string, targetUserId: string, actorRole: UserRole) {
  const addedByAdminId = actorRole === 'admin' ? actorId : null;

  const results = await Promise.all(
    roomIds.map(async (roomId) => {
      await assertRoomManager(roomId, actorId, actorRole);

      const [member] = await db
        .insert(roomMembers)
        .values({ roomId, userId: targetUserId, addedByAdminId })
        .onConflictDoNothing()
        .returning();

      if (!member && addedByAdminId) {
        await db
          .update(roomMembers)
          .set({ addedByAdminId })
          .where(
            and(
              eq(roomMembers.roomId, roomId),
              eq(roomMembers.userId, targetUserId),
              isNull(roomMembers.addedByAdminId),
            ),
          );
      }

      if (member) {
        const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId), columns: { id: true, name: true, status: true } });
        await sendToUser(targetUserId, 'room.member_added', {
          roomId,
          roomName: room?.name,
          roomStatus: room?.status,
        });
      }
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

  // Notify the removed user so their room list refreshes
  await sendToUser(targetUserId, 'room.member_removed', { roomId });

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

  // Stop recording before ending the call
  await stopCallRecording(room.getstreamCallId).catch(() => { });

  const members = await db.query.roomMembers.findMany({ where: eq(roomMembers.roomId, roomId) });
  // console.log('Ending room, kicking members:', members.map((m) => m.userId));
  await Promise.allSettled(members.map((m) => kickUserFromCall(room.getstreamCallId, m.userId)));

  await endGetstreamCall(room.getstreamCallId);

  const activeSession = await sessionService.getActiveSession(roomId);
  if (activeSession) await sessionService.endSession(activeSession.id);

  // send ws message for room end to all members in the room
  // console.log('Notifying members of room end:');
  await Promise.all(members.map((m) =>
    sendToUser(
      m.userId,
      'room.ended',
      { roomId },
    )
  ));

  const [updated] = await db
    .update(rooms)
    .set({ status: 'active' })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id, status: rooms.status });

  // Notify all room members of status change back to active
  await sendToRoomMembers(roomId, 'room.status_changed', {
    roomId,
    roomName: room.name,
    status: 'active',
  });

  return updated;
}

// ─── Recordings ──────────────────────────────────────────────────────────────

export async function getRoomRecordings(roomId: string) {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

  return listCallRecordings(room.getstreamCallId);
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

// ─── Per-admin device gating at join-room ────────────────────────────────────
// The "gating admin" is the admin who allocated this seat to this user:
//   • For members: roomMembers.addedByAdminId
//   • For hosts joining their own room: rooms.createdBy (if an admin)
// If no gating admin is found, the join is not device-gated (creator joining
// their own room, legacy rows, super_admin-allocated rows).

async function assertDeviceAllowedForRoom(
  roomId: string,
  userId: string,
  roomHostId: string | null,
  roomCreatedBy: string | null,
  deviceId?: string,
  deviceName?: string,
) {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, role: true, isTestAccount: true },
  });
  if (!user) { console.log('[device-gate] skip: user not found', { userId }); return; }
  if (user.isTestAccount) { console.log('[device-gate] skip: test account', { userId }); return; }
  if (user.role !== 'user' && user.role !== 'host') {
    console.log('[device-gate] skip: role not gated', { userId, role: user.role });
    return;
  }

  let gatingAdminId: string | null = null;
  let gatingSource: string = 'none';

  const membership = await db.query.roomMembers.findFirst({
    where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)),
    columns: { id: true, addedByAdminId: true },
  });

  if (membership?.addedByAdminId) {
    gatingAdminId = membership.addedByAdminId;
    gatingSource = 'membership.addedByAdminId';
  } else if (roomHostId === userId && roomCreatedBy) {
    const creator = await db.query.users.findFirst({
      where: eq(users.id, roomCreatedBy),
      columns: { role: true },
    });
    if (creator?.role === 'admin') {
      gatingAdminId = roomCreatedBy;
      gatingSource = 'hostBranch.createdBy';
    }
  }

  // Fallback for legacy rows whose addedByAdminId was never backfilled:
  // if the room's creator is an admin who adopted this user, gate by them
  // and repair the room_members row so future joins are cheap.
  if (!gatingAdminId && membership && roomCreatedBy) {
    const [creatorIsAdoptingAdmin] = await db
      .select({ adminId: adminUserAdoptions.adminId })
      .from(adminUserAdoptions)
      .innerJoin(users, eq(users.id, adminUserAdoptions.adminId))
      .where(
        and(
          eq(adminUserAdoptions.adminId, roomCreatedBy),
          eq(adminUserAdoptions.userId, userId),
          eq(users.role, 'admin'),
        ),
      )
      .limit(1);
    if (creatorIsAdoptingAdmin) {
      gatingAdminId = creatorIsAdoptingAdmin.adminId;
      gatingSource = 'fallback.roomCreatedBy';
      await db
        .update(roomMembers)
        .set({ addedByAdminId: gatingAdminId })
        .where(eq(roomMembers.id, membership.id));
    }
  }

  console.log('[device-gate]', {
    roomId, userId, deviceId, deviceName,
    gatingAdminId, gatingSource,
    membershipAddedBy: membership?.addedByAdminId ?? null,
    roomCreatedBy, roomHostId,
  });

  if (!gatingAdminId) return;

  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 400 });
  }

  const adoption = await db.query.adminUserAdoptions.findFirst({
    where: and(eq(adminUserAdoptions.adminId, gatingAdminId), eq(adminUserAdoptions.userId, userId)),
  });
  if (!adoption) {
    console.log('[device-gate] skip: no adoption', { gatingAdminId, userId });
    return;
  }

  if (!adoption.lockedDeviceId) {
    await db
      .update(adminUserAdoptions)
      .set({ lockedDeviceId: deviceId, lockedDeviceName: deviceName || null })
      .where(eq(adminUserAdoptions.id, adoption.id));
    return;
  }

  if (adoption.lockedDeviceId === deviceId) return;

  if (!adoption.allowDeviceChange) {
    throw Object.assign(
      new Error(
        `You can only join this room from the device approved by your admin (${adoption.lockedDeviceName || 'Unknown'}). Ask your admin to approve this device.`,
      ),
      { status: 403, code: 'DEVICE_NOT_ALLOWED_FOR_ROOM' },
    );
  }

  await db
    .update(adminUserAdoptions)
    .set({ lockedDeviceId: deviceId, lockedDeviceName: deviceName || null, allowDeviceChange: false })
    .where(eq(adminUserAdoptions.id, adoption.id));
}
