import Elysia, { t } from 'elysia'
import { hostOrAdminPlugin } from '../middleware/auth'
import * as assetService from '../services/asset.service'

// Host/admin/super_admin can upload banner images. Returns the S3 object key
// so the caller can construct the public asset URL.
export const uploadsRoute = new Elysia({ prefix: '/uploads' })
  .use(hostOrAdminPlugin)

  .post(
    '/banner',
    async ({ body, set }) => {
      try {
        return await assetService.uploadBannerImage(body.file)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    {
      body: t.Object({
        file: t.File({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] }),
      }),
    },
  )
