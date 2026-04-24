import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { env } from './config/env';
import { initWsRouter } from './lib/ws-manager';
import { authRoute } from './routes/auth';
import { roomsRoute } from './routes/rooms';
import { superAdminRoute } from './routes/super-admin';
import { adminRoute } from './routes/admin';
import { hostRoute } from './routes/host';
import { wsRoute } from './routes/ws';
import { sportsRoute } from './routes/sports';
import { uploadsRoute } from './routes/uploads';
import { assetsRoute } from './routes/assets';

async function bootstrap() {
  // Initialize Redis pub/sub for cross-instance WS event routing
  await initWsRouter();

  const app = new Elysia()
    .use(
      cors({
        origin: true, // tighten in production
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Name', 'X-App-Version', 'X-Device-Id'],
        credentials: true,
      }),
    )

    // Global error handler
    .onError(({ error, set, request }) => {
      const err = error as any;
      const status = err.status ?? 500;
      set.status = status;
      if (status >= 500) {
        console.error(`[error] ${request.method} ${new URL(request.url).pathname} → ${status}`, err);
      }
      return { error: err.message ?? 'Internal server error' };
    })

    // Health check (no auth)
    .get('/health', () => ({ status: 'ok', ts: Date.now() }))

    // API v1
    .group('/v1', (app) =>
      app
        .use(authRoute)
        .use(roomsRoute)
        .use(superAdminRoute)
        .use(adminRoute)
        .use(hostRoute)
        .use(wsRoute)
        .use(sportsRoute)
        .use(uploadsRoute)
        .use(assetsRoute),
    )

    .listen(env.port);

  console.log(`[server] running at ${app.server?.url}`);
  console.log(`[ws]     ws://localhost:${env.port}/v1/ws`);
}

bootstrap().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
