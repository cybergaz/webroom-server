import Elysia, { t } from 'elysia';
import { authPlugin } from '../middleware/auth';
import * as authService from '../services/auth.service';

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
    async ({ body, set }) => {
      try {
        return await authService.login(
          { phone: body.phone, email: body.email },
          body.password,
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
    async ({ body, set }) => {
      try {
        return await authService.refresh(body.refreshToken);
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
