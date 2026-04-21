import Elysia, { t } from 'elysia'
import * as assetService from '../services/asset.service'

// Public asset redirects. The S3 bucket stays private; this endpoint issues a
// time-limited presigned URL and 302-redirects the caller to it. Safe to hit
// anonymously because the only thing exposed is a derived presigned URL.
export const assetsRoute = new Elysia({ prefix: '/assets' })
  .get(
    '/banners/:filename',
    async ({ params, set, redirect }) => {
      try {
        const url = await assetService.getBannerPresignedUrl(params.filename)
        return redirect(url, 302)
      } catch (err: any) {
        set.status = err.status ?? 500
        return { error: err.message }
      }
    },
    { params: t.Object({ filename: t.String() }) },
  )
