import Elysia, { t } from 'elysia';
import { adminPlugin } from '../middleware/auth';
import * as adminService from '../services/admin.service';
import * as sessionService from '../services/session.service';
import * as roomService from '../services/room.service';
import * as recordingService from '../services/recording.service';
import * as transcriptionService from '../services/transcription.service';

export const adminRoute = new Elysia({ prefix: '/admin' })
  .use(adminPlugin)

  // ─── Host CRUD ───────────────────────────────────────────────────────────────

  .get('/hosts', async ({ user }) => {
    const hosts = await adminService.listHosts(user.userId);
    return { hosts };
  })

  .post(
    '/hosts',
    async ({ body, user, set }) => {
      try {
        const host = await adminService.createHost(user.userId, body);
        set.status = 201;
        return host;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        phone: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String()),
        password: t.String({ minLength: 6 }),
      }),
    },
  )

  .patch(
    '/hosts/:hostId',
    async ({ params, body, user, set }) => {
      try {
        return await adminService.updateHost(params.hostId, user.userId, body);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String()),
        password: t.Optional(t.String({ minLength: 6 })),
      }),
    },
  )

  .post(
    '/hosts/:hostId/activate',
    async ({ params, user, set }) => {
      try {
        return await adminService.activateHost(params.hostId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .post(
    '/hosts/:hostId/deactivate',
    async ({ params, user, set }) => {
      try {
        return await adminService.deactivateHost(params.hostId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .delete(
    '/hosts/:hostId',
    async ({ params, user, set }) => {
      try {
        await adminService.deleteHost(params.hostId, user.userId);
        set.status = 204;
        return null;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .post(
    '/hosts/:hostId/adopt',
    async ({ params, user, set }) => {
      try {
        return await adminService.adoptUser(user.userId, params.hostId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .delete(
    '/hosts/:hostId/adopt',
    async ({ params, user, set }) => {
      try {
        return await adminService.unadoptUser(user.userId, params.hostId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .post(
    '/hosts/:hostId/allow-device-change',
    async ({ params, user, set }) => {
      try {
        return await adminService.allowDeviceChange(params.hostId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  .post(
    '/hosts/:hostId/reset-device-lock',
    async ({ params, user, set }) => {
      try {
        return await adminService.resetDeviceLock(params.hostId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ hostId: t.String() }) },
  )

  // ─── User management ────────────────────────────────────────────────────────

  .get(
    '/users/search',
    async ({ query, user, set }) => {
      try {
        const result = await adminService.searchUser(query.requestId, user.userId);
        if (!result) {
          set.status = 404;
          return { error: 'No user found with this request ID', code: 'USER_NOT_FOUND' };
        }
        return result;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { query: t.Object({ requestId: t.String({ minLength: 1 }) }) },
  )

  .post(
    '/users/:userId/approve',
    async ({ params, body, user, set }) => {
      try {
        return await adminService.approveOrAdopt(params.userId, user.userId, body?.temporaryPassword);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ userId: t.String() }),
      body: t.Optional(t.Object({ temporaryPassword: t.Optional(t.String()) })),
    },
  )

  .post(
    '/users/:userId/reject',
    async ({ params, set }) => {
      try {
        return await adminService.rejectUser(params.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/users/:userId/force-logout',
    async ({ params, user, set }) => {
      try {
        return await adminService.forceLogoutUser(params.userId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/users/:userId/allow-device-change',
    async ({ params, user, set }) => {
      try {
        return await adminService.allowDeviceChange(params.userId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/users/:userId/reset-device-lock',
    async ({ params, user, set }) => {
      try {
        return await adminService.resetDeviceLock(params.userId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .get('/users', async ({ user }) => {
    const usersList = await adminService.listUsers(user.userId);
    return { users: usersList };
  })

  .post(
    '/users',
    async ({ body, user, set }) => {
      try {
        const created = await adminService.createUser(user.userId, body);
        set.status = 201;
        return created;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        phone: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String()),
        password: t.String({ minLength: 6 }),
      }),
    },
  )

  .patch(
    '/users/:userId',
    async ({ params, body, user, set }) => {
      try {
        return await adminService.updateUser(params.userId, user.userId, body);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ userId: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String()),
      }),
    },
  )

  .post(
    '/users/:userId/activate',
    async ({ params, user, set }) => {
      try {
        return await adminService.activateUser(params.userId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/users/:userId/deactivate',
    async ({ params, user, set }) => {
      try {
        return await adminService.deactivateUser(params.userId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .delete(
    '/users/:userId',
    async ({ params, user, set }) => {
      try {
        await adminService.deleteUser(params.userId, user.userId);
        set.status = 204;
        return null;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/users/:userId/adopt',
    async ({ params, user, set }) => {
      try {
        return await adminService.adoptUser(user.userId, params.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .delete(
    '/users/:userId/adopt',
    async ({ params, user, set }) => {
      try {
        return await adminService.unadoptUser(user.userId, params.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // ─── Room management ────────────────────────────────────────────────────────

  .get('/rooms', async ({ user }) => {
    const roomsList = await adminService.listAllRooms(user.userId);
    return { rooms: roomsList };
  })

  .get('/rooms-with-membership/:userId', async ({ user, params }) => {
    const roomsList = await adminService.listAllRoomsWithMembership(user.userId, params.userId);
    return { rooms: roomsList };
  },
    { params: t.Object({ userId: t.String() }) },
  )

  .post(
    '/rooms/:roomId/assign-host',
    async ({ params, body, user, set }) => {
      try {
        return await adminService.assignHostToRoom(params.roomId, body.hostId, user.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ roomId: t.String() }),
      body: t.Object({ hostId: t.String() }),
    },
  )

  .post(
    '/rooms/:roomId/unassign-host',
    async ({ params, set }) => {
      try {
        return await adminService.unassignHostFromRoom(params.roomId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  .post(
    '/rooms/:roomId/activate',
    async ({ params, set }) => {
      try {
        return await adminService.setRoomActive(params.roomId, true);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  .post(
    '/rooms/:roomId/deactivate',
    async ({ params, set }) => {
      try {
        return await adminService.setRoomActive(params.roomId, false);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── Sessions ───────────────────────────────────────────────────────────────

  .get('/sessions', async ({ user }) => {
    const sessions = await sessionService.getSessionHistory(undefined, user.userId);
    return { sessions };
  })

  .get(
    '/sessions/:roomId',
    async ({ params, user }) => {
      const sessions = await sessionService.getSessionHistory(params.roomId, user.userId);
      return { sessions };
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── Room Recordings ─────────────────────────────────────────────────────

  .get(
    '/rooms/:roomId/recordings',
    async ({ params, set }) => {
      try {
        const recordings = await roomService.getRoomRecordings(params.roomId);
        return { recordings };
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  // ─── PTT Recordings ──────────────────────────────────────────────────────

  .get(
    '/ptt-recordings',
    async ({ query, user }) => {
      return recordingService.listPttRecordings({
        roomId: query.roomId || undefined,
        userId: query.userId || undefined,
        adminId: user.userId,
        page: query.page ? parseInt(query.page as string, 10) : 1,
        limit: query.limit ? parseInt(query.limit as string, 10) : 20,
      });
    },
    {
      query: t.Object({
        roomId: t.Optional(t.String()),
        userId: t.Optional(t.String()),
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  .get(
    '/ptt-recordings/:recordingId/url',
    async ({ params, set }) => {
      try {
        return await recordingService.getPttRecordingUrl(params.recordingId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ recordingId: t.String() }) },
  )

  // ─── Attendance ──────────────────────────────────────────────────────────

  .get(
    '/attendance',
    async ({ query, user }) => {
      const date = query.date || new Date().toISOString().slice(0, 10);
      const result = await adminService.getAttendance(user.userId, {
        date,
        search: query.search || undefined,
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
      });
      return { ...result, date };
    },
    {
      query: t.Object({
        date: t.Optional(t.String()),
        search: t.Optional(t.String()),
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  // ─── Room Activity (live rooms with active participants) ──────────────────

  .get('/room-activity', async ({ user }) => {
    const liveRooms = await adminService.getLiveRoomsWithParticipants(user.userId);
    return { rooms: liveRooms };
  })

  // ─── Transcriptions ────────────────────────────────────────────────────────

  .get(
    '/rooms/:roomId/transcriptions',
    async ({ params, set }) => {
      try {
        const sessions = await transcriptionService.getRoomSessionTranscriptions(params.roomId);
        return { sessions };
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String() }) },
  )

  .get(
    '/transcriptions/:roomId/:sessionId',
    async ({ params, set }) => {
      try {
        const transcriptions = await transcriptionService.getSessionTranscriptions(params.sessionId);
        return { transcriptions };
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ roomId: t.String(), sessionId: t.String() }) },
  );
