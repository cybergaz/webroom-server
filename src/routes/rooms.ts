import Elysia, { t } from 'elysia'
import { authPlugin, hostOrAdminPlugin } from '../middleware/auth'
import * as roomService from '../services/room.service'
import * as sessionService from '../services/session.service'
import * as recordingService from '../services/recording.service'

// ─── User routes (any authenticated user) ────────────────────────────────────

const userRoomRoutes = new Elysia({ prefix: '/rooms' })
  .use(authPlugin)

  // ─── GET /rooms ──────────────────────────────────────────────────────────────
  .get('/', async ({ user }) => {
    const list = await roomService.listRooms(user.userId, user.role)
    return { rooms: list }
  })

  // ─── GET /rooms/:roomId ──────────────────────────────────────────────────────
  .get(
    '/:roomId',
    async ({ params, user, set }) => {
      try {
        return await roomService.getRoom(params.roomId, user.userId)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/join ────────────────────────────────────────────────
  .post(
    '/:roomId/join',
    async ({ params, user, set }) => {
      try {
        return await roomService.joinRoom(params.roomId, user.userId)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/leave ───────────────────────────────────────────────
  .post(
    '/:roomId/leave',
    async ({ params, user, set }) => {
      await roomService.leaveRoom(params.roomId, user.userId)
      set.status = 204
      return null
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── GET /my-recordings (list caller's own recordings, paginated) ────────────
  .get(
    '/my-recordings',
    async ({ user, query }) => {
      return recordingService.getMyRecordings({
        userId: user.userId,
        roomId: query.roomId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: query.page ?? 1,
        limit: query.limit ?? 50,
      });
    },
    {
      query: t.Object({
        roomId: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        page: t.Optional(t.Numeric()),
        limit: t.Optional(t.Numeric()),
      }),
    },
  )

  // ─── GET /my-recordings/:recordingId/url (presigned URL for own recording) ──
  .get(
    '/my-recordings/:recordingId/url',
    async ({ params, user, set }) => {
      try {
        return await recordingService.getMyRecordingUrl(params.recordingId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ recordingId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/ptt-recordings (upload PTT recording) ──────────────
  .post(
    '/:roomId/ptt-recordings',
    async ({ params, body, user, set }) => {
      try {
        const record = await recordingService.savePttRecording({
          roomId: params.roomId,
          sessionId: body.sessionId,
          userId: user.userId,
          file: body.audio,
          durationMs: body.durationMs,
        });
        set.status = 201;
        return record;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ roomId: t.String() }),
      body: t.Object({
        audio: t.File(),
        sessionId: t.String(),
        durationMs: t.Numeric(),
      }),
    },
  )

// ─── Management routes (host, admin, super_admin) ────────────────────────────

const managedRoomRoutes = new Elysia({ prefix: '/rooms' })
  .use(hostOrAdminPlugin)

  // ─── POST /rooms/:roomId/start ───────────────────────────────────────────────
  .post(
    '/:roomId/start',
    async ({ params, user, set }) => {
      try {
        return await roomService.startRoom(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/host-ready ───────────────────────────────────────────
  .post(
    '/:roomId/host-ready',
    async ({ params, user, set }) => {
      try {
        await roomService.confirmHostReady(params.roomId, user.userId, user.role)
        set.status = 204
        return null
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── GET /rooms/:roomId/sessions ────────────────────────────────────────────
  .get(
    '/:roomId/sessions',
    async ({ params, user, set }) => {
      try {
        return await roomService.getRoomSessions(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── GET /rooms/:roomId/members ──────────────────────────────────────────────
  .get(
    '/:roomId/members',
    async ({ params, set }) => {
      try {
        const members = await roomService.listMembers(params.roomId)
        return { members }
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms ─────────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ body, user, set }) => {
      try {
        const room = await roomService.createRoom(
          user.userId,
          body.name,
          body.description,
          body.hostId,
        )
        set.status = 201
        return room
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        hostId: t.Optional(t.String()),
      }),
    },
  )

  // ─── DELETE /rooms/:roomId ───────────────────────────────────────────────────
  .delete(
    '/:roomId',
    async ({ params, user, set }) => {
      try {
        await roomService.deleteRoom(params.roomId, user.userId, user.role)
        set.status = 204
        return null
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/members (assign user) ──────────────────────────────
  .post(
    '/:roomId/members',
    async ({ params, body, user, set }) => {
      try {
        const result = await roomService.addMember(
          params.roomId,
          user.userId,
          body.userId,
          user.role,
        )
        set.status = 201
        return result
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      params: t.Object({ roomId: t.String() }),
      body: t.Object({ userId: t.String() }),
    },
  )

  // ─── POST /rooms/members (assign user to multiple rooms) ────────────────────
  .post(
    '/members',
    async ({ body, user, set }) => {
      try {
        const result = await roomService.addMemberToRooms(body.roomIds, user.userId, body.userId, user.role)
        set.status = 201
        return result
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      body: t.Object({ roomIds: t.Array(t.String()), userId: t.String() }),
    },
  )

  // ─── DELETE /rooms/:roomId/members/:userId (kick) ────────────────────────────
  .delete(
    '/:roomId/members/:userId',
    async ({ params, user, set }) => {
      try {
        await roomService.removeMember(params.roomId, user.userId, params.userId, user.role)
        set.status = 204
        return null
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String(), userId: t.String() }) },
  )

  // ─── PATCH /rooms/:roomId/members/:userId/mute ───────────────────────────────
  .patch(
    '/:roomId/members/:userId/mute',
    async ({ params, body, user, set }) => {
      try {
        return await roomService.muteUser(
          params.roomId,
          user.userId,
          params.userId,
          body.muted,
          user.role,
        )
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      params: t.Object({ roomId: t.String(), userId: t.String() }),
      body: t.Object({ muted: t.Boolean() }),
    },
  )

  // ─── POST /rooms/:roomId/mute-all ────────────────────────────────────────────
  .post(
    '/:roomId/mute-all',
    async ({ params, user, set }) => {
      try {
        return await roomService.muteAll(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/unmute-all ──────────────────────────────────────────
  .post(
    '/:roomId/unmute-all',
    async ({ params, user, set }) => {
      try {
        return await roomService.unmuteAll(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/kick-all ────────────────────────────────────────────
  .post(
    '/:roomId/kick-all',
    async ({ params, user, set }) => {
      try {
        return await roomService.kickAll(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/end ─────────────────────────────────────────────────
  .post(
    '/:roomId/end',
    async ({ params, user, set }) => {
      try {
        return await roomService.endRoom(params.roomId, user.userId, user.role)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── POST /rooms/:roomId/force-logout-all ───────────────────────────────────
  .post(
    '/:roomId/force-logout-all',
    async ({ params, set }) => {
      try {
        const { forceLogoutRoomUsers } = await import('../services/admin.service')
        return await forceLogoutRoomUsers(params.roomId)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

// ─── Export combined ─────────────────────────────────────────────────────────

export const roomsRoute = new Elysia()
  .use(userRoomRoutes)
  .use(managedRoomRoutes)
