/**
 * Test DB helpers.
 *
 * Connects to the local test Postgres (docker-compose.test.yml), runs all
 * pending migrations, truncates everything, then seeds the canonical
 * 101-member scenario:
 *
 *   • 1 admin (with an active 1-year license)
 *   • 1 host (created by the admin)
 *   • 100 members (created by the admin)
 *   • 1 room (admin is creator, host is host, all 101 are room_members)
 *
 * isTestAccount is true on every seeded user so device-gating is bypassed.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { adminLicenses, roomMembers, rooms, users } from '../../src/db/schema';

export const TOTAL_MEMBERS = 100;

export type SeededUser = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'host' | 'user';
};

export type SeedResult = {
  admin: SeededUser;
  host: SeededUser;
  members: SeededUser[];
  roomId: string;
};

export type TestDb = ReturnType<typeof drizzle<typeof schema & typeof relations>>;

export async function setupTestDb() {
  const client = postgres(process.env.DATABASE_URL!, {
    max: 10,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema: { ...schema, ...relations } });
  // Schema is pushed via `bun run test:up` (drizzle-kit push --force) before
  // tests run — we don't migrate() here because the historical migration
  // chain has a no-op DROP CONSTRAINT that fails on a fresh DB.
  return { db, client };
}

export async function resetTestDb(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      speaking_events,
      ptt_recordings,
      session_participants,
      room_sessions,
      room_members,
      refresh_tokens,
      admin_user_adoptions,
      admin_licenses,
      rooms,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function seedScenario(db: TestDb): Promise<SeedResult> {
  const dummyHash = await Bun.password.hash('test-password');

  const [admin] = await db
    .insert(users)
    .values({
      name: 'Test Admin',
      email: 'test-admin@webroom.test',
      passwordHash: dummyHash,
      role: 'admin',
      status: 'approved',
      isTestAccount: true,
    })
    .returning({ id: users.id });

  const [host] = await db
    .insert(users)
    .values({
      name: 'Test Host',
      email: 'test-host@webroom.test',
      passwordHash: dummyHash,
      role: 'host',
      status: 'approved',
      isTestAccount: true,
      createdByUserId: admin.id,
    })
    .returning({ id: users.id });

  const memberRows = Array.from({ length: TOTAL_MEMBERS }, (_, i) => ({
    name: `Test Member ${String(i + 1).padStart(3, '0')}`,
    email: `test-member-${i + 1}@webroom.test`,
    passwordHash: dummyHash,
    role: 'user' as const,
    status: 'approved' as const,
    isTestAccount: true,
    createdByUserId: admin.id,
  }));
  const memberInserted = await db.insert(users).values(memberRows).returning({ id: users.id });

  // Active license so license gates pass.
  await db.insert(adminLicenses).values({
    adminId: admin.id,
    planDuration: '1_year',
    activatedAt: new Date(),
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  const roomId = crypto.randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    name: 'Stress Test Room',
    description: '101-member end-to-end test',
    getstreamCallId: roomId,
    createdBy: admin.id,
    hostId: host.id,
  });

  await db.insert(roomMembers).values([
    { roomId, userId: host.id, addedByAdminId: admin.id },
    ...memberInserted.map((m) => ({ roomId, userId: m.id, addedByAdminId: admin.id })),
  ]);

  return {
    admin: { id: admin.id, name: 'Test Admin', email: 'test-admin@webroom.test', role: 'admin' },
    host: { id: host.id, name: 'Test Host', email: 'test-host@webroom.test', role: 'host' },
    members: memberInserted.map((m, i) => ({
      id: m.id,
      name: `Test Member ${String(i + 1).padStart(3, '0')}`,
      email: `test-member-${i + 1}@webroom.test`,
      role: 'user' as const,
    })),
    roomId,
  };
}
