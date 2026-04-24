import Elysia, { t } from 'elysia';
import { hostPlugin } from '../middleware/auth';
import * as hostService from '../services/host.service';

export const hostRoute = new Elysia({ prefix: '/host' })
  .use(hostPlugin)

  // ─── User management (scoped to the host's admin) ──────────────────────────

  .get('/users', async ({ user }) => {
    const usersList = await hostService.listUsers(user.userId);
    return { users: usersList };
  })

  .patch(
    '/users/:userId',
    async ({ params, body, user, set }) => {
      try {
        return await hostService.updateUser(user.userId, params.userId, body);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ userId: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        password: t.Optional(t.String({ minLength: 6 })),
      }),
    },
  )

  .post(
    '/users/:userId/activate',
    async ({ params, user, set }) => {
      try {
        return await hostService.activateUser(user.userId, params.userId);
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
        return await hostService.deactivateUser(user.userId, params.userId);
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
        return await hostService.forceLogoutUser(user.userId, params.userId);
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
        return await hostService.allowDeviceChange(user.userId, params.userId);
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
        return await hostService.resetDeviceLock(user.userId, params.userId);
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
        return await hostService.deleteUser(user.userId, params.userId);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    { params: t.Object({ userId: t.String() }) },
  );
