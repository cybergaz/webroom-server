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
 */

import Elysia from 'elysia';
import { verifyWsToken, type UserRole } from '../lib/jwt';
import { connections, get_ws_data, set_ws_data, unregisterConnection, WebSocketData } from '../lib/ws-manager';
import { getActiveSession, recordSpeakingStart, recordSpeakingEnd } from '../services/session.service';
import { ElysiaWS } from 'elysia/dist/ws';

async function handleSpeakingStart(roomId: string, userId: string): Promise<void> {
  const session = await getActiveSession(roomId);
  if (!session) return;
  await recordSpeakingStart(session.id, userId);
}

async function handleSpeakingEnd(roomId: string, userId: string): Promise<void> {
  const session = await getActiveSession(roomId);
  if (!session) return;
  await recordSpeakingEnd(session.id, userId);
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
      // connections.forEach((value, key) => {
      //   console.log(`Connection - userId: ${key}, readyState: ${value.ws.readyState}`);
      // });

      // const { userId } = (ws.data as unknown) as ;
      // console.log("open ws userId -> ", userId);
      // registerConnection(userId, ws as any);
    },

    message: async (ws, raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        console.log("msg -> ", msg);
        const userId = get_ws_data(ws, 'userId');
        console.log("userId -> ", userId);
        // console.log("message: userId -> ", userId);
        // console.log("event -> ", msg.event);

        if (msg.event === 'ws.ping') {
          ws.send(JSON.stringify({ event: 'ws.pong', payload: {}, timestamp: new Date().toISOString() }));
          return;
        }

        if (msg.event === 'room.leave') {
          // Informational — no server action needed.
          return;
        }

        if (msg.event === 'speaking.start') {
          return;
        }

        if (msg.event === 'speaking.end') {
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
      unregisterConnection(userId!);
    },
  });
