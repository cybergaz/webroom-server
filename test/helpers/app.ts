/**
 * Test app builder — same routes as production server.ts, no .listen().
 * Tests dispatch via app.handle(new Request(...)) for in-process speed.
 *
 * NOTE: import this file *after* any mock.module() calls in the test, so the
 * mocks are in place before the routes (and their service deps) are loaded.
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

export async function buildTestApp() {
  const { authRoute } = await import('../../src/routes/auth');
  const { roomsRoute } = await import('../../src/routes/rooms');
  const { adminRoute } = await import('../../src/routes/admin');
  const { superAdminRoute } = await import('../../src/routes/super-admin');
  const { sportsRoute } = await import('../../src/routes/sports');
  const { uploadsRoute } = await import('../../src/routes/uploads');
  const { assetsRoute } = await import('../../src/routes/assets');
  const { wsRoute } = await import('../../src/routes/ws');

  return new Elysia()
    .use(cors({ origin: true }))
    .onError(({ error, set }) => {
      const err = error as any;
      const status = err.status ?? 500;
      set.status = status;
      return { error: err.message ?? 'Internal server error' };
    })
    .get('/health', () => ({ status: 'ok' }))
    .group('/v1', (a) =>
      a
        .use(authRoute)
        .use(roomsRoute)
        .use(adminRoute)
        .use(superAdminRoute)
        .use(sportsRoute)
        .use(uploadsRoute)
        .use(assetsRoute)
        .use(wsRoute),
    );
}

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

export async function bearerFor(userId: string, role: 'user' | 'host' | 'admin' | 'super_admin') {
  const { signAccessToken } = await import('../../src/lib/jwt');
  const { token } = await signAccessToken(userId, role);
  return `Bearer ${token}`;
}

type ReqOpts = {
  method?: string;
  bearer?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export async function call(app: TestApp, path: string, opts: ReqOpts = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.bearer) headers['authorization'] = opts.bearer;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}
