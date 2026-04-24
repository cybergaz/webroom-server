/**
 * Layer 2 — full 101-member room lifecycle against the *real* Stream backend.
 *
 * Walks the same scenario as Layer 1 but lets every Stream call hit the live
 * API. After each phase we query Stream itself to verify what our server said
 * really did land:
 *
 *   • call exists + transitions backstage → live → backstage as expected
 *   • host is registered with role='host' on the Stream call
 *   • each member's /join returns a valid Stream JWT bound to that user
 *   • call recording is enabled when host-ready fires
 *   • call.delete() cleans up at the end
 *
 * Requires real Stream credentials. The test reads them from `.env` (the
 * production-style env file) at startup; if not found, the test is skipped
 * with a clear message rather than failing.
 *
 * Run with:  bun run test:layer2
 */

// ─── Load real Stream creds from .env (must run before any import) ──────────
import { existsSync, readFileSync } from 'node:fs';

const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const matchEnv = (key: string) => {
  const m = envFile.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m?.[1].trim().replace(/^['"]|['"]$/g, '');
};
const realKey = matchEnv('GETSTREAM_API_KEY');
const realSecret = matchEnv('GETSTREAM_API_SECRET');
const HAVE_REAL_STREAM = !!(realKey && realSecret && !realKey.startsWith('fake-'));
if (HAVE_REAL_STREAM) {
  process.env.GETSTREAM_API_KEY = realKey!;
  process.env.GETSTREAM_API_SECRET = realSecret!;
}

import { mock } from 'bun:test';
import { wsRecorder } from './helpers/recorders';

// ─── Mock WS manager only — let Stream calls through ─────────────────────────
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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  resetTestDb,
  seedScenario,
  setupTestDb,
  type SeedResult,
  type TestDb,
} from './helpers/db';
import { bearerFor, buildTestApp, call, type TestApp } from './helpers/app';
import { clearRecorders, wsEventsOf } from './helpers/recorders';
import { rooms } from '../src/db/schema';

let db: TestDb;
let pgClient: { end: () => Promise<void> };
let app: TestApp;
let seed: SeedResult;
let streamClient: any;
let createdCallId: string | null = null;

beforeAll(async () => {
  if (!HAVE_REAL_STREAM) return;
  const setup = await setupTestDb();
  db = setup.db;
  pgClient = setup.client as unknown as { end: () => Promise<void> };
  app = await buildTestApp();
  // Pull the real client so we can query Stream state directly
  const gs = await import('../src/lib/getstream');
  streamClient = gs.streamClient;
});

afterAll(async () => {
  if (!HAVE_REAL_STREAM) return;
  // Best-effort cleanup of the Stream call
  if (createdCallId) {
    try {
      await streamClient.video.call('audio_room', createdCallId).delete({ hard: true });
    } catch (e) {
      console.warn(`[layer2 cleanup] failed to delete call ${createdCallId}:`, (e as Error).message);
    }
  }
  await pgClient?.end();
});

const decodeJwtSub = (jwt: string): string | null => {
  try {
    const [, payload] = jwt.split('.');
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return json.user_id ?? json.sub ?? null;
  } catch {
    return null;
  }
};

if (!HAVE_REAL_STREAM) {
  describe('Layer 2 — real Stream', () => {
    test.skip('skipped: no real GETSTREAM_API_KEY/SECRET found in .env', () => {});
  });
} else {
  describe('Layer 2 — full 101-member lifecycle (real Stream)', () => {
    test('host start → 100 join → leave-all → rejoin → host end', async () => {
      await resetTestDb(db);
      clearRecorders();
      seed = await seedScenario(db);
      createdCallId = seed.roomId;

      // Stream auto-creates users when their token is first used, but
      // ensureCallHost / updateUserPermissions need them to exist server-side
      // first. Production gets this for free via login; here we upsert.
      // Stream caps upsertUsers at 100 per call, so batch.
      const allUsers = [
        { id: seed.host.id, name: seed.host.name, role: 'user' },
        ...seed.members.map((m) => ({ id: m.id, name: m.name, role: 'user' })),
      ];
      for (let i = 0; i < allUsers.length; i += 100) {
        await streamClient.upsertUsers(allUsers.slice(i, i + 100));
      }

      const hostBearer = await bearerFor(seed.host.id, 'host');
      const memberBearers = await Promise.all(
        seed.members.map((m) => bearerFor(m.id, 'user')),
      );
      const callType = process.env.GETSTREAM_CALL_TYPE ?? 'audio_room';
      const streamCall = streamClient.video.call(callType, seed.roomId);

      // ── Step 1: Host /start + /host-ready ─────────────────────────────────
      const startRes = await call(app, `/v1/rooms/${seed.roomId}/start`, {
        method: 'POST',
        bearer: hostBearer,
      });
      expect(startRes.status).toBe(200);

      const readyRes = await call(app, `/v1/rooms/${seed.roomId}/host-ready`, {
        method: 'POST',
        bearer: hostBearer,
      });
      expect(readyRes.status).toBe(204);

      // Verify against Stream that the call exists, host is configured, live
      const callStateAfterStart = await streamCall.get();
      expect(callStateAfterStart.call.id).toBe(seed.roomId);
      expect(callStateAfterStart.call.backstage).toBe(false); // goLive flipped it
      const hostMember = (callStateAfterStart.members as any[] | undefined)?.find(
        (m: any) => m.user_id === seed.host.id,
      );
      expect(hostMember).toBeTruthy();
      expect(hostMember!.role).toBe('host');

      // Recording config got applied (audio_only true for audio rooms)
      const recordingSettings = (callStateAfterStart.call.settings as any)?.recording;
      expect(recordingSettings?.mode).toBe('available');
      expect(recordingSettings?.audio_only).toBe(true);

      // Local DB also flipped to live
      const liveRoom = await db.query.rooms.findFirst({ where: eq(rooms.id, seed.roomId) });
      expect(liveRoom?.status).toBe('live');

      // ── Step 2: 100 members join in parallel ──────────────────────────────
      // Real Stream rate limits: throttle to small batches so we don't get 429d.
      const memberJoin = (i: number) =>
        call(app, `/v1/rooms/${seed.roomId}/join`, {
          method: 'POST',
          bearer: memberBearers[i],
          headers: { 'x-device-id': `device-${seed.members[i].id}` },
        });

      const BATCH = 10;
      const joinResults: { status: number; body: unknown }[] = [];
      for (let i = 0; i < seed.members.length; i += BATCH) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(BATCH, seed.members.length - i) }, (_, k) =>
            memberJoin(i + k),
          ),
        );
        joinResults.push(...batch);
      }

      const failedJoins = joinResults.filter((r) => r.status !== 200);
      if (failedJoins.length) {
        console.error('Failed joins (first 3):', failedJoins.slice(0, 3));
      }
      expect(failedJoins.length).toBe(0);

      // Each /join returned a real Stream JWT whose user_id matches the user
      for (let i = 0; i < seed.members.length; i++) {
        const body = joinResults[i].body as any;
        expect(typeof body.getstreamToken).toBe('string');
        expect(decodeJwtSub(body.getstreamToken)).toBe(seed.members[i].id);
      }

      // ── Step 3: Leave one-by-one ──────────────────────────────────────────
      for (let i = 0; i < seed.members.length; i++) {
        const res = await call(app, `/v1/rooms/${seed.roomId}/leave`, {
          method: 'POST',
          bearer: memberBearers[i],
        });
        expect(res.status).toBe(204);
      }

      // Stream side: call is still live, host is still a member
      const stateAfterLeave = await streamCall.get();
      expect(stateAfterLeave.call.backstage).toBe(false);

      // ── Step 4: Rejoin ────────────────────────────────────────────────────
      const rejoinResults: { status: number; body: unknown }[] = [];
      for (let i = 0; i < seed.members.length; i += BATCH) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(BATCH, seed.members.length - i) }, (_, k) =>
            memberJoin(i + k),
          ),
        );
        rejoinResults.push(...batch);
      }
      expect(rejoinResults.every((r) => r.status === 200)).toBe(true);

      // ── Step 5: Host /end ─────────────────────────────────────────────────
      const endRes = await call(app, `/v1/rooms/${seed.roomId}/end`, {
        method: 'POST',
        bearer: hostBearer,
      });
      expect(endRes.status).toBe(200);

      // Stream side: call is back to backstage (stopLive)
      const stateAfterEnd = await streamCall.get();
      expect(stateAfterEnd.call.backstage).toBe(true);

      // Local DB: status reverted, all members notified via WS recorder
      const finalRoom = await db.query.rooms.findFirst({ where: eq(rooms.id, seed.roomId) });
      expect(finalRoom?.status).toBe('active');
      expect(wsEventsOf('room.ended').length).toBe(101);
    }, 180_000);
  });
}
