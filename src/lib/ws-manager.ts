/**
 * WebSocket Manager
 *
 * Handles real-time events that GetStream does NOT cover:
 *  - room.invite          (user received invite)
 *  - invite.accepted      (admin notification)
 *  - invite.declined      (admin notification)
 *  - room.member_added    (user/host assigned to a room — refreshes their room list)
 *  - room.member_removed  (user/host removed from a room — refreshes their room list)
 *  - room.status_changed  (room status changed — updates all members' room list & in-room UI)
 *  - room.host_disconnected (host WS dropped — members see countdown warning)
 *  - room.host_reconnected  (host reconnected within grace period — dismiss warning)
 *  - user.approved        (pending user notified on check-status screen)
 *  - user.rejected        (pending user notified on check-status screen)
 *  - user.force_logout    (admin forced a user out)
 *  - ws.pong              (heartbeat response)
 *
 * For horizontal scaling: Redis pub/sub routes events across instances.
 * Each instance holds local WS connections and forwards events published to Redis.
 */

import type { ServerWebSocket } from 'bun';
import { redis, redisSub } from './redis';
import type { UserRole } from './jwt';
import { ElysiaWS } from 'elysia/dist/ws';

export const WS_CHANNEL = 'ws:events';

const HOST_GRACE_PERIOD_MS = 30_000; // 30 seconds

// Local connection registry: userId → ServerWebSocket
export const connections = new Map<string, UserConnection>();

// Host grace timers: hostUserId → { timer, roomIds[] }
const hostGraceTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; roomIds: string[] }>();

export interface WebSocketData {
  userId: string;
  userName?: string;
  role?: UserRole;
  type: 'access' | 'status';
}

export interface UserConnection {
  ws: ElysiaWS;
}

export const set_ws_data = (ws: ElysiaWS, data: WebSocketData) => {
  Object.assign(ws.data, data);
};

export const get_ws_data = (ws: ElysiaWS, key: keyof WebSocketData) => {
  return (ws.data as WebSocketData)[key];
};

export const is_user_online = (user_id: string): boolean => {
  // Check WebSocket connections
  const ws_connection = connections.get(user_id);
  if (ws_connection && ws_connection.ws.readyState === 1) {
    return true;
  }
  return false;
};


// export function registerConnection(userId: string, ws: ElysiaWS) {
//   connections.set(userId, ws);
//   console.log("userId -> ", userId);
//   console.log("setting new connection -> ", connections.get(userId));
// }

export function unregisterConnection(userId: string) {
  connections.delete(userId);
}

/**
 * Send an event to a specific user.
 * Publishes to Redis so any instance can forward it.
 */
export async function sendToUser(userId: string, event: string, payload: Record<string, unknown> = {}) {
  // console.log(`[WS] Publishing event to redis "${event}" to user ${userId}`);
  await redis.publish(
    WS_CHANNEL,
    JSON.stringify({ userId, event, payload, timestamp: new Date().toISOString() }),
  );
}

/**
 * Send an event to all members of a room.
 */
export async function sendToRoomMembers(roomId: string, event: string, payload: Record<string, unknown> = {}) {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { roomMembers } = await import('../db/schema');

  const members = await db.query.roomMembers.findMany({
    where: eq(roomMembers.roomId, roomId),
    columns: { userId: true },
  });

  await Promise.all(members.map((m) => sendToUser(m.userId, event, payload)));
}

/**
 * Start a grace period for a host who disconnected from a live room.
 * Notifies room members immediately. If the host doesn't reconnect within
 * HOST_GRACE_PERIOD_MS, the room is automatically ended.
 */
export async function startHostGracePeriod(hostUserId: string) {
  const { eq, and, or } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { rooms } = await import('../db/schema');

  // Find all live rooms where this user is the host
  const liveRooms = await db.query.rooms.findMany({
    where: and(
      eq(rooms.status, 'live'),
      or(eq(rooms.hostId, hostUserId), eq(rooms.createdBy, hostUserId)),
    ),
    columns: { id: true, name: true },
  });

  if (liveRooms.length === 0) return;

  const roomIds = liveRooms.map((r) => r.id);
  console.log(`[WS] Host ${hostUserId} disconnected from live rooms: ${roomIds.join(', ')} — starting ${HOST_GRACE_PERIOD_MS / 1000}s grace period`);

  // Notify all members of affected rooms
  await Promise.all(
    liveRooms.map((room) =>
      sendToRoomMembers(room.id, 'room.host_disconnected', {
        roomId: room.id,
        roomName: room.name,
        gracePeriodSeconds: HOST_GRACE_PERIOD_MS / 1000,
      }),
    ),
  );

  // Start the grace timer
  const timer = setTimeout(async () => {
    hostGraceTimers.delete(hostUserId);
    console.log(`[WS] Grace period expired for host ${hostUserId} — ending rooms: ${roomIds.join(', ')}`);

    const { endRoom } = await import('../services/room.service');
    for (const roomId of roomIds) {
      try {
        // endRoom handles: kick members, end getstream call, close session,
        // set status back to active, notify members with room.ended + room.status_changed
        await endRoom(roomId, hostUserId, 'host');
      } catch (e) {
        console.error(`[WS] Failed to auto-end room ${roomId}:`, e);
      }
    }
  }, HOST_GRACE_PERIOD_MS);

  hostGraceTimers.set(hostUserId, { timer, roomIds });
}

/**
 * Cancel any pending grace period for a host who reconnected.
 * Notifies room members that the host is back.
 */
export async function cancelHostGracePeriod(hostUserId: string) {
  const entry = hostGraceTimers.get(hostUserId);
  if (!entry) return;

  clearTimeout(entry.timer);
  hostGraceTimers.delete(hostUserId);
  console.log(`[WS] Host ${hostUserId} reconnected — grace period cancelled for rooms: ${entry.roomIds.join(', ')}`);

  const { eq } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { rooms } = await import('../db/schema');

  await Promise.all(
    entry.roomIds.map(async (roomId) => {
      const room = await db.query.rooms.findFirst({
        where: eq(rooms.id, roomId),
        columns: { id: true, name: true, status: true },
      });
      if (room && room.status === 'live') {
        await sendToRoomMembers(roomId, 'room.host_reconnected', {
          roomId,
          roomName: room.name,
        });
      }
    }),
  );
}

/**
 * Initialize Redis subscription for cross-instance event routing.
 * Call once on server startup.
 */
export async function initWsRouter() {
  await redisSub.connect();
  await redis.connect();

  await redisSub.subscribe(WS_CHANNEL);

  redisSub.on('message', (_channel: string, raw: string) => {
    try {
      const { userId, event, payload, timestamp } = JSON.parse(raw);
      const ws_conn = connections.get(userId);
      // console.log("redis on message: ws_conn -> ", ws_conn);
      // console.log("redis on message: readyState -> ", ws_conn?.ws.readyState);
      if (ws_conn && ws_conn.ws.readyState === 1) {
        ws_conn.ws.send(JSON.stringify({ event, payload, timestamp }));
        console.log(`[WS] redis Routed event "${event}" to user ${userId}`);
      }
    } catch {
      // malformed message — ignore
    }
  });

  console.log('[WS] Redis pub/sub router initialized');
}
