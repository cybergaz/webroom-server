import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { roomSessions, sessionParticipants, speakingEvents } from '../db/schema'

// ─── Get or create open session ───────────────────────────────────────────────

export async function getOrCreateSession(roomId: string): Promise<{ id: string }> {
  const existing = await db.query.roomSessions.findFirst({
    where: and(eq(roomSessions.roomId, roomId), isNull(roomSessions.endedAt)),
    columns: { id: true },
  })

  if (existing) return existing

  const [session] = await db
    .insert(roomSessions)
    .values({ roomId })
    .returning({ id: roomSessions.id })

  return session
}

// ─── Get active (open) session for a room ────────────────────────────────────

export async function getActiveSession(roomId: string): Promise<{ id: string } | null> {
  const session = await db.query.roomSessions.findFirst({
    where: and(eq(roomSessions.roomId, roomId), isNull(roomSessions.endedAt)),
    columns: { id: true },
  })
  return session ?? null
}

// ─── End session ──────────────────────────────────────────────────────────────

export async function endSession(sessionId: string): Promise<void> {
  // Close all open speaking events
  await db
    .update(speakingEvents)
    .set({
      endedAt: sql`now()`,
      durationSeconds: sql`EXTRACT(EPOCH FROM (now() - started_at))::int`,
    })
    .where(and(eq(speakingEvents.sessionId, sessionId), isNull(speakingEvents.endedAt)))

  // Close all participants still marked as present
  await db
    .update(sessionParticipants)
    .set({ leftAt: sql`now()` })
    .where(and(eq(sessionParticipants.sessionId, sessionId), isNull(sessionParticipants.leftAt)))

  await db
    .update(roomSessions)
    .set({ endedAt: sql`now()` })
    .where(eq(roomSessions.id, sessionId))
}

// ─── Record participant join ───────────────────────────────────────────────────
// Upserts so re-joins (e.g. reconnect) reset leftAt and refresh joinedAt.

export async function recordParticipantJoin(sessionId: string, userId: string): Promise<void> {
  await db
    .insert(sessionParticipants)
    .values({ sessionId, userId })
    .onConflictDoUpdate({
      target: [sessionParticipants.sessionId, sessionParticipants.userId],
      set: { joinedAt: sql`now()`, leftAt: null },
    })
}

// ─── Record participant leave ─────────────────────────────────────────────────

export async function recordParticipantLeave(sessionId: string, userId: string): Promise<void> {
  await db
    .update(sessionParticipants)
    .set({ leftAt: sql`now()` })
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(sessionParticipants.userId, userId),
        isNull(sessionParticipants.leftAt),
      ),
    )
}

// ─── Record speaking start ────────────────────────────────────────────────────

export async function recordSpeakingStart(sessionId: string, userId: string): Promise<void> {
  // Close any existing open event for this user (safety)
  await db
    .update(speakingEvents)
    .set({
      endedAt: sql`now()`,
      durationSeconds: sql`EXTRACT(EPOCH FROM (now() - started_at))::int`,
    })
    .where(
      and(
        eq(speakingEvents.sessionId, sessionId),
        eq(speakingEvents.userId, userId),
        isNull(speakingEvents.endedAt),
      ),
    )

  await db
    .insert(speakingEvents)
    .values({ sessionId, userId, startedAt: new Date() })
}

// ─── Record speaking end ──────────────────────────────────────────────────────

export async function recordSpeakingEnd(sessionId: string, userId: string): Promise<void> {
  await db
    .update(speakingEvents)
    .set({
      endedAt: sql`now()`,
      durationSeconds: sql`EXTRACT(EPOCH FROM (now() - started_at))::int`,
    })
    .where(
      and(
        eq(speakingEvents.sessionId, sessionId),
        eq(speakingEvents.userId, userId),
        isNull(speakingEvents.endedAt),
      ),
    )
}

// ─── Get session history ──────────────────────────────────────────────────────

export async function getSessionHistory(roomId?: string) {
  const where = roomId ? eq(roomSessions.roomId, roomId) : undefined

  return db.query.roomSessions.findMany({
    where,
    with: {
      participants: {
        with: {
          user: { columns: { id: true, name: true, phone: true, email: true } },
        },
        orderBy: (t, { asc }) => [asc(t.joinedAt)],
      },
      speakingEvents: {
        with: {
          user: { columns: { id: true, name: true, phone: true } },
        },
        orderBy: (t, { asc }) => [asc(t.startedAt)],
      },
    },
    orderBy: (t, { desc }) => [desc(t.startedAt)],
  })
}
