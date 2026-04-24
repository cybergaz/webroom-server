/**
 * Layer 1 — full 101-member room lifecycle, mocked Stream + WS pub/sub.
 *
 * Validates the entire control plane in-process against a real local Postgres,
 * without burning Stream minutes. Walks the user-stated scenario exactly:
 *
 *   1. Host starts the room (and confirms host-ready)
 *   2. 100 members join in parallel — all succeed, all get tokens
 *   3. Members leave one-by-one (host stays — room stays live)
 *   4. All 100 rejoin
 *   5. Host ends the room — every member is kicked + notified, status reverts
 *
 * Run with:  bun run test:layer1
 */

import { mock } from 'bun:test';
import { streamRecorder, wsRecorder } from './helpers/recorders';

// ─── Mock Stream (must be hoisted before any src import) ─────────────────────
mock.module('../src/lib/getstream', () => {
  const rec = (fn: string) =>
    async (...args: unknown[]) => {
      streamRecorder.push({ fn, args, at: Date.now() });
    };
  return {
    streamClient: { generateUserToken: () => 'fake-stream-token' },
    generateGetstreamToken: (uid: string) => {
      streamRecorder.push({ fn: 'generateGetstreamToken', args: [uid], at: Date.now() });
      return `fake-stream-token-${uid}`;
    },
    createGetstreamCall: rec('createGetstreamCall'),
    ensureCallHost: rec('ensureCallHost'),
    goLiveCall: rec('goLiveCall'),
    getGetstreamCall: () => ({}),
    muteUserInCall: rec('muteUserInCall'),
    muteAllInCall: rec('muteAllInCall'),
    kickUserFromCall: rec('kickUserFromCall'),
    grantUserSendAudio: rec('grantUserSendAudio'),
    endGetstreamCall: rec('endGetstreamCall'),
    getCallParticipants: async () => ({ call: {} }),
    startCallRecording: rec('startCallRecording'),
    stopCallRecording: rec('stopCallRecording'),
    listCallRecordings: async () => [],
  };
});

// ─── Mock WS manager (don't actually publish to Redis; just record) ──────────
mock.module('../src/lib/ws-manager', () => ({
  WS_CHANNEL: 'ws:events',
  connections: new Map(),
  set_ws_data: () => {},
  get_ws_data: () => undefined,
  is_user_online: () => false,
  unregisterConnection: () => {},
  sendToUser: async (userId: string, event: string, payload: unknown) => {
    wsRecorder.push({ fn: 'sendToUser', target: userId, event, payload, at: Date.now() });
  },
  sendToRoomMembers: async (roomId: string, event: string, payload: unknown) => {
    wsRecorder.push({ fn: 'sendToRoomMembers', target: roomId, event, payload, at: Date.now() });
  },
  startHostGracePeriod: async () => {},
  cancelHostGracePeriod: async () => {},
  initWsRouter: async () => {},
}));

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  resetTestDb,
  seedScenario,
  setupTestDb,
  type SeedResult,
  type TestDb,
} from './helpers/db';
import { bearerFor, buildTestApp, call, type TestApp } from './helpers/app';
import { clearRecorders, streamCallsOf, wsEventsOf } from './helpers/recorders';
import { rooms, roomSessions, sessionParticipants } from '../src/db/schema';

let db: TestDb;
let pgClient: { end: () => Promise<void> };
let app: TestApp;
let seed: SeedResult;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  pgClient = setup.client as unknown as { end: () => Promise<void> };
  app = await buildTestApp();
});

afterAll(async () => {
  await pgClient.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  clearRecorders();
  seed = await seedScenario(db);
});

/**
 * Wait until a count-based predicate over a query passes, or timeout.
 * Needed because room.service.ts fires recordParticipantJoin without await.
 */
async function waitFor<T>(
  fetch: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 10_000,
  pollMs = 50,
): Promise<T> {
  const start = Date.now();
  let last = await fetch();
  while (!predicate(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    last = await fetch();
  }
  return last;
}

describe('Layer 1 — full 101-member room lifecycle (mocked Stream)', () => {
  test('host start → 100 join → leave-all → rejoin → host end', async () => {
    const hostBearer = await bearerFor(seed.host.id, 'host');
    const memberBearers = await Promise.all(
      seed.members.map((m) => bearerFor(m.id, 'user')),
    );

    // ── Step 1: Host starts the room ────────────────────────────────────────
    const startRes = await call(app, `/v1/rooms/${seed.roomId}/start`, {
      method: 'POST',
      bearer: hostBearer,
    });
    expect(startRes.status).toBe(200);
    expect((startRes.body as any).status).toBe('live');
    expect((startRes.body as any).sessionId).toBeTruthy();

    const readyRes = await call(app, `/v1/rooms/${seed.roomId}/host-ready`, {
      method: 'POST',
      bearer: hostBearer,
    });
    expect(readyRes.status).toBe(204);

    // Stream control-plane calls fired with the right host id
    const ensureHost = streamCallsOf('ensureCallHost');
    expect(ensureHost.length).toBe(1);
    expect(ensureHost[0].args[1]).toBe(seed.host.id);
    expect(streamCallsOf('goLiveCall').length).toBe(1);
    expect(streamCallsOf('startCallRecording').length).toBe(1);

    // Room is live
    const liveRoom = await db.query.rooms.findFirst({ where: eq(rooms.id, seed.roomId) });
    expect(liveRoom?.status).toBe('live');

    // 'room.status_changed' broadcast went out
    const liveBroadcasts = wsEventsOf('room.status_changed');
    expect(liveBroadcasts.length).toBe(1);
    expect((liveBroadcasts[0].payload as any).status).toBe('live');

    // Get the session (host record-join is fire-and-forget)
    const sessionRow = await waitFor(
      () =>
        db.query.roomSessions.findFirst({
          where: eq(roomSessions.roomId, seed.roomId),
        }),
      (s) => !!s,
    );
    expect(sessionRow).toBeTruthy();
    const sessionId = sessionRow!.id;

    // ── Step 2: 100 members join in parallel ────────────────────────────────
    clearRecorders();
    const joinResults = await Promise.all(
      seed.members.map((m, i) =>
        call(app, `/v1/rooms/${seed.roomId}/join`, {
          method: 'POST',
          bearer: memberBearers[i],
          headers: { 'x-device-id': `device-${m.id}` },
        }),
      ),
    );

    const failedJoins = joinResults.filter((r) => r.status !== 200);
    if (failedJoins.length) {
      console.error('Failed joins (first 3):', failedJoins.slice(0, 3));
    }
    expect(failedJoins.length).toBe(0);

    // Each response carries a session, call id, and a (mocked) Stream token
    for (const r of joinResults) {
      const body = r.body as any;
      expect(body.sessionId).toBe(sessionId);
      expect(body.getstreamCallId).toBe(seed.roomId);
      expect(body.getstreamCallType).toBe('audio_room');
      expect(typeof body.getstreamToken).toBe('string');
    }

    // grant-send-audio fired exactly once per member, never for the host
    const grants = streamCallsOf('grantUserSendAudio');
    expect(grants.length).toBe(100);
    const grantedIds = new Set(grants.map((g) => g.args[1] as string));
    expect(grantedIds.size).toBe(100);
    expect(grantedIds.has(seed.host.id)).toBe(false);
    for (const m of seed.members) {
      expect(grantedIds.has(m.id)).toBe(true);
    }

    // session_participants reaches 101 (host + 100)
    const partsAfterJoin = await waitFor(
      () =>
        db.query.sessionParticipants.findMany({
          where: eq(sessionParticipants.sessionId, sessionId),
        }),
      (rows) => rows.length >= 101,
    );
    expect(partsAfterJoin.length).toBe(101);
    expect(partsAfterJoin.every((p) => p.leftAt === null)).toBe(true);

    // ── Step 3: All 100 members leave one-by-one (host stays) ───────────────
    clearRecorders();
    for (let i = 0; i < seed.members.length; i++) {
      const res = await call(app, `/v1/rooms/${seed.roomId}/leave`, {
        method: 'POST',
        bearer: memberBearers[i],
      });
      expect(res.status).toBe(204);
    }

    // 100 members marked left; host still present
    const partsAfterLeave = await db.query.sessionParticipants.findMany({
      where: eq(sessionParticipants.sessionId, sessionId),
    });
    const memberIdSet = new Set(seed.members.map((m) => m.id));
    const leftMembers = partsAfterLeave.filter((p) => memberIdSet.has(p.userId));
    expect(leftMembers.length).toBe(100);
    expect(leftMembers.every((p) => p.leftAt !== null)).toBe(true);
    const hostPart = partsAfterLeave.find((p) => p.userId === seed.host.id);
    expect(hostPart?.leftAt).toBe(null);

    // Session still open, room still live (host hasn't left)
    const sessionStill = await db.query.roomSessions.findFirst({
      where: eq(roomSessions.id, sessionId),
    });
    expect(sessionStill?.endedAt).toBe(null);
    const roomStill = await db.query.rooms.findFirst({ where: eq(rooms.id, seed.roomId) });
    expect(roomStill?.status).toBe('live');

    // No Stream-side kicks for member-leave (DB-only path)
    expect(streamCallsOf('kickUserFromCall').length).toBe(0);

    // ── Step 4: All 100 members rejoin ──────────────────────────────────────
    clearRecorders();
    const rejoinResults = await Promise.all(
      seed.members.map((m, i) =>
        call(app, `/v1/rooms/${seed.roomId}/join`, {
          method: 'POST',
          bearer: memberBearers[i],
          headers: { 'x-device-id': `device-${m.id}` },
        }),
      ),
    );
    expect(rejoinResults.every((r) => r.status === 200)).toBe(true);

    // session reused, every member's leftAt cleared
    const partsAfterRejoin = await waitFor(
      () =>
        db.query.sessionParticipants.findMany({
          where: eq(sessionParticipants.sessionId, sessionId),
        }),
      (rows) =>
        rows
          .filter((p) => memberIdSet.has(p.userId))
          .every((p) => p.leftAt === null) &&
        rows.filter((p) => memberIdSet.has(p.userId)).length === 100,
    );
    const rejoinedMembers = partsAfterRejoin.filter((p) => memberIdSet.has(p.userId));
    expect(rejoinedMembers.length).toBe(100);
    expect(rejoinedMembers.every((p) => p.leftAt === null)).toBe(true);

    // grants re-fired
    expect(streamCallsOf('grantUserSendAudio').length).toBe(100);

    // ── Step 5: Host ends the room ──────────────────────────────────────────
    clearRecorders();
    const endRes = await call(app, `/v1/rooms/${seed.roomId}/end`, {
      method: 'POST',
      bearer: hostBearer,
    });
    expect(endRes.status).toBe(200);

    // Recording stopped, call ended on Stream side
    expect(streamCallsOf('stopCallRecording').length).toBe(1);
    expect(streamCallsOf('endGetstreamCall').length).toBe(1);

    // kick fired for every room_member (host + 100 = 101)
    const kicks = streamCallsOf('kickUserFromCall');
    expect(kicks.length).toBe(101);
    const kickedIds = new Set(kicks.map((k) => k.args[1] as string));
    expect(kickedIds.size).toBe(101);
    expect(kickedIds.has(seed.host.id)).toBe(true);
    for (const m of seed.members) {
      expect(kickedIds.has(m.id)).toBe(true);
    }

    // 'room.ended' WS event sent to every room_member
    const endedEvents = wsEventsOf('room.ended');
    expect(endedEvents.length).toBe(101);
    const notifiedIds = new Set(endedEvents.map((e) => e.target));
    expect(notifiedIds.size).toBe(101);
    expect(notifiedIds.has(seed.host.id)).toBe(true);
    for (const m of seed.members) {
      expect(notifiedIds.has(m.id)).toBe(true);
    }

    // 'room.status_changed' broadcast back to active
    const activeBroadcast = wsEventsOf('room.status_changed');
    expect(activeBroadcast.length).toBe(1);
    expect((activeBroadcast[0].payload as any).status).toBe('active');

    // DB final state
    const finalRoom = await db.query.rooms.findFirst({ where: eq(rooms.id, seed.roomId) });
    expect(finalRoom?.status).toBe('active');
    const finalSession = await db.query.roomSessions.findFirst({
      where: eq(roomSessions.id, sessionId),
    });
    expect(finalSession?.endedAt).not.toBe(null);
  }, 60_000);
});
