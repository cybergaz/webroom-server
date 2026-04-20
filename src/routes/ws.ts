/**
 * WebSocket route
 *
 * Connection: wss://.../v1/ws?token=<accessToken|statusToken>
 *
 * - accessToken  → full user/host/org, receives all events relevant to them
 * - statusToken  → pending users on check-status screen, only receives
 *                  user.approved / user.rejected
 *
 * Client → Server messages:
 *   { "event": "ws.ping" }
 *   { "event": "room.leave",     "payload": { "roomId": "..." } }  (informational)
 *   { "event": "speaking.start", "payload": { "roomId": "..." } }
 *   { "event": "speaking.end",   "payload": { "roomId": "..." } }
 *   { "event": "transcription.caption", "payload": { "roomId", "text", "startTime", "endTime" } }
 */

import Elysia from 'elysia';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { verifyWsToken, type UserRole } from '../lib/jwt';
import { connections, get_ws_data, set_ws_data, unregisterConnection, sendToUser, startHostGracePeriod, cancelHostGracePeriod, WebSocketData } from '../lib/ws-manager';
import { db } from '../db/client';
import { rooms, users } from '../db/schema';
import { ElysiaWS } from 'elysia/dist/ws';
import { assertLicenseActiveForRoom } from '../services/license.service';

/** Update lastSeenAt only if it's null or older than 5 minutes (fire-and-forget). */
function touchLastSeen(userId: string) {
  db.update(users)
    .set({ lastSeenAt: new Date() })
    .where(and(
      eq(users.id, userId),
      or(
        isNull(users.lastSeenAt),
        sql`${users.lastSeenAt} < NOW() - INTERVAL '5 minutes'`,
      ),
    ))
    .catch(() => {});
}

async function relaySpeakingEvent(event: 'speaking.start' | 'speaking.end', roomId: string, userId: string): Promise<void> {
  const room = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    columns: { createdBy: true, name: true },
  });
  if (!room) return;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  });

  await sendToUser(room.createdBy, event, {
    roomId,
    roomName: room.name,
    userId,
    userName: user?.name ?? 'Unknown',
  });
}

async function relayTranscriptionCaption(roomId: string, userId: string, text: string, startTime: string, endTime: string): Promise<void> {
  const room = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    columns: { createdBy: true, name: true },
  });
  if (!room) return;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  });

  await sendToUser(room.createdBy, 'transcription.caption', {
    roomId,
    roomName: room.name,
    userId,
    userName: user?.name ?? 'Unknown',
    text,
    startTime,
    endTime,
  });
}

export const wsRoute = new Elysia()
  .ws('/ws', {
    // Validate token before upgrading the connection
    // beforeHandle: async ({ query, set }) => {
    //   const token = query.token as string | undefined;
    //   if (!token) {
    //     set.status = 401;
    //     return 'Missing token';
    //   }
    //
    //   const payload = await verifyWsToken(token);
    //   if (!payload) {
    //     set.status = 401;
    //     return 'Invalid or expired token';
    //   }
    // },
    //
    // // Attach userId to the WS connection data after upgrade
    // upgrade: async (ws) => {
    //   const token = ws.query.token as string;
    //   const payload = await verifyWsToken(token);
    //
    //   return {
    //     data: data,
    //   };
    // },

    open: async (ws) => {
      console.log('WebSocket connection opened');
      // Extract and validate JWT token
      const url = new URL(ws.data.request.url);
      const token = url.searchParams.get('token');
      // console.log("token -> ", token);

      if (!token) {
        ws.send({
          type: 'socket:error',
          error_code: 'AUTH_REQUIRED',
          message: 'Authentication token is required',
          timestamp: new Date().toISOString()
        }, true);
        ws.close(4001, "Missing authentication token");
        return;
      }

      const payload = await verifyWsToken(token);
      if (payload === null) {
        // console.log("payload 2 -> ", payload);
        // Send error message before closing so client can detect auth failure
        ws.send({
          type: 'socket:error',
          error_code: 'AUTH_INVALID',
          message: 'Invalid or expired authentication token',
          timestamp: new Date().toISOString()
        }, true);
        ws.close(4001, "Invalid authentication token");
        return;
      }

      const data = {
        userId: payload!.sub,
        role: payload!.role,
        type: payload!.type,
      } satisfies WebSocketData;

      // Store user_id in WebSocket data using type-safe helper
      set_ws_data(ws, data);

      connections.set(payload!.sub, { ws: ws });
      touchLastSeen(payload!.sub);

      // If this user is a host with a pending grace timer, cancel it
      if (payload!.role === 'host' || payload!.role === 'admin' || payload!.role === 'super_admin') {
        cancelHostGracePeriod(payload!.sub).catch(() => {});
      }
    },

    message: async (ws, raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // console.log("msg -> ", msg);
        const userId = get_ws_data(ws, 'userId');
        // console.log("userId -> ", userId);
        // console.log("message: userId -> ", userId);
        // console.log("event -> ", msg.event);

        if (msg.event === 'ws.ping') {
          ws.send(JSON.stringify({ event: 'ws.pong', payload: {}, timestamp: new Date().toISOString() }));
          if (userId) touchLastSeen(userId);
          return;
        }

        if (msg.event === 'room.leave') {
          // Informational — no server action needed.
          return;
        }

        if (msg.event === 'speaking.start') {
          const roomId = msg.payload?.roomId;
          if (roomId && userId) {
            try {
              await assertLicenseActiveForRoom(roomId);
              relaySpeakingEvent('speaking.start', roomId, userId);
            } catch (e: any) {
              if (e?.code === 'LICENSE_EXPIRED') {
                ws.send(
                  JSON.stringify({
                    event: 'ws.error',
                    payload: { code: 'LICENSE_EXPIRED', message: e.message },
                    timestamp: new Date().toISOString(),
                  }),
                );
                return;
              }
              throw e;
            }
          }
          return;
        }

        if (msg.event === 'speaking.end') {
          const roomId = msg.payload?.roomId;
          if (roomId && userId) relaySpeakingEvent('speaking.end', roomId, userId);
          return;
        }

        if (msg.event === 'transcription.caption') {
          const { roomId, text, startTime, endTime } = msg.payload ?? {};
          if (roomId && userId && text) {
            try {
              await assertLicenseActiveForRoom(roomId);
              relayTranscriptionCaption(roomId, userId, text, startTime ?? '', endTime ?? '');
            } catch (e: any) {
              if (e?.code === 'LICENSE_EXPIRED') {
                ws.send(
                  JSON.stringify({
                    event: 'ws.error',
                    payload: { code: 'LICENSE_EXPIRED', message: e.message },
                    timestamp: new Date().toISOString(),
                  }),
                );
                return;
              }
              throw e;
            }
          }
          return;
        }

        ws.send(
          JSON.stringify({
            event: 'ws.error',
            payload: { code: 'UNKNOWN_EVENT', message: `Unknown event: ${msg.event}` },
            timestamp: new Date().toISOString(),
          }),
        );
      } catch {
        ws.send(
          JSON.stringify({
            event: 'ws.error',
            payload: { code: 'PARSE_ERROR', message: 'Invalid JSON' },
            timestamp: new Date().toISOString(),
          }),
        );
      }
    },

    close(ws) {
      console.log('WebSocket connection closed');
      const userId = get_ws_data(ws, 'userId');
      const role = get_ws_data(ws, 'role');
      unregisterConnection(userId!);

      // If a host/admin disconnects, check if they're hosting any live rooms
      if (userId && (role === 'host' || role === 'admin' || role === 'super_admin')) {
        startHostGracePeriod(userId).catch((e) =>
          console.error('[WS] Failed to start host grace period:', e),
        );
      }
    },
  });
