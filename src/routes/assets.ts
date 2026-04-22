import Elysia, { t } from 'elysia'
import * as assetService from '../services/asset.service'

// Public asset proxy. The S3 bucket stays private; this endpoint streams the
// bytes back to the caller so our CORS headers apply (S3 presigned URLs
// don't set Access-Control-Allow-Origin, which breaks browser clients).
export const assetsRoute = new Elysia({ prefix: '/assets' })
  .get(
    '/banners/:filename',
    async ({ params, set }) => {
      try {
        const { bytes, contentType } = await assetService.getBannerBytes(
          params.filename,
        )
        set.headers['Content-Type'] = contentType
        // One day public cache — bytes are immutable per filename.
        set.headers['Cache-Control'] = 'public, max-age=86400, immutable'
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, immutable',
          },
        })
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ filename: t.String() }) },
  )
