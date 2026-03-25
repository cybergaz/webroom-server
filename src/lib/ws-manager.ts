/**
 * WebSocket Manager
 *
 * Handles real-time events that GetStream does NOT cover:
 *  - room.invite          (user received invite)
 *  - invite.accepted      (admin notification)
 *  - invite.declined      (admin notification)
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

// Local connection registry: userId → ServerWebSocket
export const connections = new Map<string, UserConnection>();

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
