import Elysia, { t } from 'elysia';
import { authPlugin } from '../middleware/auth';
import * as authService from '../services/auth.service';

function parseDeviceName(ua?: string, deviceHeader?: string, appVersion?: string): string {
  // Prefer explicit X-Device-Name header (sent by mobile apps)
  let device = deviceHeader || '';
  if (!device && ua) {
    if (/android/i.test(ua)) device = 'Android';
    else if (/iphone|ipad|ipod/i.test(ua)) device = 'iOS';
    else if (/windows/i.test(ua)) device = 'Windows';
    else if (/macintosh|mac os/i.test(ua)) device = 'Mac';
    else if (/linux/i.test(ua)) device = 'Linux';
  }
  if (!device) device = 'Unknown';
  return appVersion ? `${device} (${appVersion})` : device;
}

export const authRoute = new Elysia({ prefix: '/auth' })
  .onError(({ error, set, path }) => {
    const err = error as any;
    switch (err.code) {
      case "VALIDATION":
        console.error("[AUTH_API] Endpoint validation error at", path);
        set.status = 422;
        return {
          success: false,
          code: 422,
          message: `Endpoint validation error`,
          error: {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            }
          },
        };
    }
  })
  // ─── POST /auth/signup ──────────────────────────────────────────────────────
  .post(
    '/signup',
    async ({ body, set }) => {
      try {
        const result = await authService.signup(body);
        set.status = 201;
        return result;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        phone: t.Optional(t.String({ minLength: 7 })),
        email: t.Optional(t.String({ format: 'email' })),
        password: t.String({ minLength: 6 }),
      }),
    },
  )

  // ─── GET /auth/status ───────────────────────────────────────────────────────
  .get(
    '/status',
    async ({ query }) => authService.checkStatus(query.requestId),
    {
      query: t.Object({ requestId: t.String() }),
    },
  )

  // ─── POST /auth/login ───────────────────────────────────────────────────────
  .post(
    '/login',
    async ({ body, set, headers }) => {
      try {
        console.log('[AUTH] user-agent:', headers['user-agent']);
        console.log('[AUTH] x-device-name:', headers['x-device-name']);
        console.log('[AUTH] x-app-version:', headers['x-app-version']);
        const deviceName = parseDeviceName(headers['user-agent'], headers['x-device-name'], headers['x-app-version']);
        console.log('[AUTH] Parsed deviceName:', deviceName);
        return await authService.login(
          { phone: body.phone, email: body.email },
          body.password,
          deviceName,
        );
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({
        phone: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
        password: t.String({ minLength: 6 }),
      }),
    },
  )

  // ─── POST /auth/refresh ─────────────────────────────────────────────────────
  .post(
    '/refresh',
    async ({ body, set, headers }) => {
      console.log("refreshing token");
      try {
        const deviceName = parseDeviceName(headers['user-agent'], headers['x-device-name'], headers['x-app-version']);
        return await authService.refresh(body.refreshToken, deviceName);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({ refreshToken: t.String() }),
    },
  )

  // ─── POST /auth/logout (auth required) ─────────────────────────────────────
  .use(authPlugin)
  .post(
    '/logout',
    async ({ body, user, set }) => {
      try {
        await authService.logout(user.userId, user.jti, body.refreshToken);
        set.status = 204;
        return null;
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({ refreshToken: t.String() }),
    },
  )

  // ─── POST /auth/set-password (OTP flow) ─────────────────────────────────────
  .post(
    '/set-password',
    async ({ body, set }) => {
      try {
        return await authService.setPassword(body.phone, body.otp, body.newPassword);
      } catch (err: any) {
        set.status = err.status ?? 500;
        return { error: err.message };
      }
    },
    {
      body: t.Object({
        phone: t.String(),
        otp: t.String(),
        newPassword: t.String({ minLength: 6 }),
      }),
    },
  );
