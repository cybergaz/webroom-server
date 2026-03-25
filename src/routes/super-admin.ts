import Elysia, { t } from 'elysia'
import { superAdminPlugin } from '../middleware/auth'
import * as adminService from '../services/admin.service'

export const superAdminRoute = new Elysia({ prefix: '/super-admin' })
  .use(superAdminPlugin)

  // ─── Admin CRUD ──────────────────────────────────────────────────────────────

  .post(
    '/admins',
    async ({ body, user, set }) => {
      try {
        const admin = await adminService.createAdmin(user.userId, body)
        set.status = 201
        return admin
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
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

  .get('/admins', async () => {
    const admins = await adminService.listAdmins()
    return { admins }
  })

  .patch(
    '/admins/:adminId',
    async ({ params, body, set }) => {
      try {
        return await adminService.updateAdmin(params.adminId, body)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      params: t.Object({ adminId: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String()),
      }),
    },
  )

  .post(
    '/admins/:adminId/activate',
    async ({ params, set }) => {
      try {
        return await adminService.activateAdmin(params.adminId)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ adminId: t.String() }) },
  )

  .post(
    '/admins/:adminId/deactivate',
    async ({ params, set }) => {
      try {
        return await adminService.deactivateAdmin(params.adminId)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ adminId: t.String() }) },
  )

  .delete(
    '/admins/:adminId',
    async ({ params, set }) => {
      try {
        await adminService.deleteAdmin(params.adminId)
        set.status = 204
        return null
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ adminId: t.String() }) },
  )
