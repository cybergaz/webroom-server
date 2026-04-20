import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { adminLicenses, users, rooms, type PlanDuration } from '../db/schema';
import { redis } from '../lib/redis';

const err = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export const LICENSE_EXPIRED_MESSAGE =
  'Your plan has expired, please contact your administrator to renew your plan.';

export type LicenseStatus = 'active' | 'expired' | 'none';

export interface LicenseSummary {
  status: LicenseStatus;
  expiresAt: string | null;
  daysRemaining: number | null;
  planDuration: PlanDuration | null;
  activatedAt: string | null;
}

const CACHE_PREFIX = 'license:';
const CACHE_TTL_SECONDS = 60;

// ─── Date math ──────────────────────────────────────────────────────────────

const DURATION_DAYS: Record<PlanDuration, number> = {
  '1_month': 30,
  '3_months': 90,
  '6_months': 180,
  '1_year': 365,
};

export function computeExpiresAt(from: Date, duration: PlanDuration): Date {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + DURATION_DAYS[duration]);
  return next;
}

function computeDaysRemaining(expiresAt: Date): number {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

async function cacheSet(adminId: string, summary: LicenseSummary): Promise<void> {
  await redis.set(
    `${CACHE_PREFIX}${adminId}`,
    JSON.stringify(summary),
    'EX',
    CACHE_TTL_SECONDS,
  );
}

async function cacheGet(adminId: string): Promise<LicenseSummary | null> {
  const raw = await redis.get(`${CACHE_PREFIX}${adminId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseSummary;
  } catch {
    return null;
  }
}

async function cacheInvalidate(adminId: string): Promise<void> {
  await redis.del(`${CACHE_PREFIX}${adminId}`);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

async function loadLicenseRow(adminId: string) {
  return db.query.adminLicenses.findFirst({
    where: eq(adminLicenses.adminId, adminId),
  });
}

function summarize(row: Awaited<ReturnType<typeof loadLicenseRow>>): LicenseSummary {
  if (!row) {
    return {
      status: 'none',
      expiresAt: null,
      daysRemaining: null,
      planDuration: null,
      activatedAt: null,
    };
  }
  const expiresAt = new Date(row.expiresAt);
  const expired = expiresAt.getTime() <= Date.now();
  return {
    status: expired ? 'expired' : 'active',
    expiresAt: expiresAt.toISOString(),
    daysRemaining: expired ? 0 : computeDaysRemaining(expiresAt),
    planDuration: row.planDuration,
    activatedAt: new Date(row.activatedAt).toISOString(),
  };
}

export async function getLicense(adminId: string): Promise<LicenseSummary> {
  const cached = await cacheGet(adminId);
  if (cached) {
    // Re-derive daysRemaining + status so cached 'active' doesn't linger
    // past expiry if expiresAt has crossed zero while cached.
    if (cached.expiresAt) {
      const exp = new Date(cached.expiresAt);
      const expired = exp.getTime() <= Date.now();
      return {
        ...cached,
        status: expired ? 'expired' : 'active',
        daysRemaining: expired ? 0 : computeDaysRemaining(exp),
      };
    }
    return cached;
  }

  const row = await loadLicenseRow(adminId);
  const summary = summarize(row);
  await cacheSet(adminId, summary);
  return summary;
}

export async function assertAdminLicenseActive(adminId: string): Promise<void> {
  const summary = await getLicense(adminId);
  if (summary.status === 'expired') {
    throw err(403, LICENSE_EXPIRED_MESSAGE, 'LICENSE_EXPIRED');
  }
}

export async function assertLicenseActiveForHost(hostUserId: string): Promise<void> {
  const host = await db.query.users.findFirst({
    where: eq(users.id, hostUserId),
    columns: { createdByUserId: true, role: true },
  });
  if (!host?.createdByUserId) return;
  // Only gate if the creator is actually an admin — super_admin-created hosts
  // (edge case) are not subject to any license.
  const creator = await db.query.users.findFirst({
    where: eq(users.id, host.createdByUserId),
    columns: { role: true },
  });
  if (creator?.role !== 'admin') return;
  await assertAdminLicenseActive(host.createdByUserId);
}

/**
 * Gate an arbitrary actor (admin / host / user). Admins are checked
 * against their own license; hosts/users against the admin that created them.
 * super_admin and orphan accounts pass through.
 */
export async function assertLicenseActiveForActor(actorId: string): Promise<void> {
  const actor = await db.query.users.findFirst({
    where: eq(users.id, actorId),
    columns: { id: true, role: true, createdByUserId: true },
  });
  if (!actor) return;
  if (actor.role === 'admin') {
    await assertAdminLicenseActive(actor.id);
    return;
  }
  if (actor.role === 'super_admin') return;
  if (!actor.createdByUserId) return;
  const creator = await db.query.users.findFirst({
    where: eq(users.id, actor.createdByUserId),
    columns: { role: true },
  });
  if (creator?.role !== 'admin') return;
  await assertAdminLicenseActive(actor.createdByUserId);
}

export async function assertLicenseActiveForRoom(roomId: string): Promise<void> {
  const room = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    columns: { createdBy: true, hostId: true },
  });
  if (!room) return;

  let owningAdminId: string | null = null;
  if (room.createdBy) {
    const creator = await db.query.users.findFirst({
      where: eq(users.id, room.createdBy),
      columns: { id: true, role: true, createdByUserId: true },
    });
    if (creator?.role === 'admin') owningAdminId = creator.id;
    else if (creator?.createdByUserId) {
      // Creator is a host/user created by an admin
      const owner = await db.query.users.findFirst({
        where: eq(users.id, creator.createdByUserId),
        columns: { id: true, role: true },
      });
      if (owner?.role === 'admin') owningAdminId = owner.id;
    }
  }

  if (!owningAdminId && room.hostId) {
    const host = await db.query.users.findFirst({
      where: eq(users.id, room.hostId),
      columns: { createdByUserId: true },
    });
    if (host?.createdByUserId) {
      const owner = await db.query.users.findFirst({
        where: eq(users.id, host.createdByUserId),
        columns: { id: true, role: true },
      });
      if (owner?.role === 'admin') owningAdminId = owner.id;
    }
  }

  if (!owningAdminId) return;
  await assertAdminLicenseActive(owningAdminId);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

async function assertIsAdmin(adminId: string): Promise<void> {
  const admin = await db.query.users.findFirst({
    where: and(eq(users.id, adminId), eq(users.role, 'admin')),
    columns: { id: true },
  });
  if (!admin) throw err(404, 'Admin not found');
}

export async function assignLicense(
  superAdminId: string,
  adminId: string,
  duration: PlanDuration,
): Promise<LicenseSummary> {
  await assertIsAdmin(adminId);

  const now = new Date();
  const expiresAt = computeExpiresAt(now, duration);

  await db
    .insert(adminLicenses)
    .values({
      adminId,
      planDuration: duration,
      activatedAt: now,
      expiresAt,
      assignedByUserId: superAdminId,
    })
    .onConflictDoUpdate({
      target: adminLicenses.adminId,
      set: {
        planDuration: duration,
        activatedAt: now,
        expiresAt,
        assignedByUserId: superAdminId,
        updatedAt: now,
      },
    });

  await cacheInvalidate(adminId);
  return (await getLicense(adminId));
}

export async function extendLicense(
  superAdminId: string,
  adminId: string,
  duration: PlanDuration,
): Promise<LicenseSummary> {
  await assertIsAdmin(adminId);

  const existing = await loadLicenseRow(adminId);
  if (!existing) throw err(404, 'No license to extend — assign one first');

  const now = new Date();
  const base =
    existing.expiresAt.getTime() > now.getTime() ? existing.expiresAt : now;
  const expiresAt = computeExpiresAt(base, duration);

  await db
    .update(adminLicenses)
    .set({
      planDuration: duration,
      expiresAt,
      assignedByUserId: superAdminId,
      updatedAt: now,
    })
    .where(eq(adminLicenses.adminId, adminId));

  await cacheInvalidate(adminId);
  return (await getLicense(adminId));
}

export async function revokeLicense(
  superAdminId: string,
  adminId: string,
): Promise<LicenseSummary> {
  await assertIsAdmin(adminId);

  const existing = await loadLicenseRow(adminId);
  if (!existing) throw err(404, 'No license to revoke');

  const now = new Date();
  await db
    .update(adminLicenses)
    .set({
      expiresAt: now,
      assignedByUserId: superAdminId,
      updatedAt: now,
    })
    .where(eq(adminLicenses.adminId, adminId));

  await cacheInvalidate(adminId);
  return (await getLicense(adminId));
}
