import { and, eq, desc, gte, lte, sql, count } from 'drizzle-orm';
import { db } from '../db/client';
import { pttRecordings, rooms, users } from '../db/schema';
import { uploadRecording, getPresignedUrl } from '../lib/s3';

// ─── Save PTT recording ─────────────────────────────────────────────────────

export async function savePttRecording(params: {
  roomId: string;
  sessionId: string;
  userId: string;
  file: File;
  durationMs: number;
}) {
  const { roomId, sessionId, userId, file, durationMs } = params;

  const timestamp = Date.now();
  const s3Key = `recordings/${roomId}/${userId}/${timestamp}.m4a`;
  const contentType = file.type || 'audio/mp4';

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadRecording(s3Key, buffer, contentType);

  const [record] = await db
    .insert(pttRecordings)
    .values({
      roomId,
      sessionId,
      userId,
      s3Key,
      durationMs,
      fileSizeBytes: file.size,
      mimeType: contentType,
    })
    .returning();

  return record;
}

// ─── List PTT recordings (paginated, filterable) ────────────────────────────

export async function listPttRecordings(params: {
  roomId?: string;
  userId?: string;
  page: number;
  limit: number;
}) {
  const { roomId, userId, page, limit } = params;

  const conditions = [];
  if (roomId) conditions.push(eq(pttRecordings.roomId, roomId));
  if (userId) conditions.push(eq(pttRecordings.userId, userId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        id: pttRecordings.id,
        roomId: pttRecordings.roomId,
        roomName: rooms.name,
        sessionId: pttRecordings.sessionId,
        userId: pttRecordings.userId,
        userName: users.name,
        durationMs: pttRecordings.durationMs,
        fileSizeBytes: pttRecordings.fileSizeBytes,
        createdAt: pttRecordings.createdAt,
      })
      .from(pttRecordings)
      .innerJoin(rooms, eq(pttRecordings.roomId, rooms.id))
      .innerJoin(users, eq(pttRecordings.userId, users.id))
      .where(where)
      .orderBy(desc(pttRecordings.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),

    db
      .select({ total: count() })
      .from(pttRecordings)
      .where(where),
  ]);

  return { data, total, page, limit };
}

// ─── Get presigned URL for a recording ──────────────────────────────────────

export async function getPttRecordingUrl(recordingId: string) {
  const record = await db.query.pttRecordings.findFirst({
    where: eq(pttRecordings.id, recordingId),
    columns: { s3Key: true },
  });

  if (!record) {
    throw Object.assign(new Error('Recording not found'), { status: 404 });
  }

  const url = await getPresignedUrl(record.s3Key);
  return { url };
}

// ─── List recordings for the calling user (paginated, filterable by date) ────

export async function getMyRecordings(params: {
  userId: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}) {
  const { userId, from, to, page, limit } = params;

  const conditions = [eq(pttRecordings.userId, userId)];
  if (from) conditions.push(gte(pttRecordings.createdAt, from));
  if (to) conditions.push(lte(pttRecordings.createdAt, to));
  const where = and(...conditions);

  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        id: pttRecordings.id,
        roomId: pttRecordings.roomId,
        roomName: rooms.name,
        sessionId: pttRecordings.sessionId,
        durationMs: pttRecordings.durationMs,
        fileSizeBytes: pttRecordings.fileSizeBytes,
        createdAt: pttRecordings.createdAt,
      })
      .from(pttRecordings)
      .innerJoin(rooms, eq(pttRecordings.roomId, rooms.id))
      .where(where)
      .orderBy(desc(pttRecordings.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),

    db.select({ total: count() }).from(pttRecordings).where(where),
  ]);

  return { recordings: data, total, page, limit };
}

// ─── Get presigned URL for the calling user's own recording ─────────────────

export async function getMyRecordingUrl(recordingId: string, userId: string) {
  const record = await db.query.pttRecordings.findFirst({
    where: and(eq(pttRecordings.id, recordingId), eq(pttRecordings.userId, userId)),
    columns: { s3Key: true },
  });

  if (!record) {
    throw Object.assign(new Error('Recording not found'), { status: 404 });
  }

  const url = await getPresignedUrl(record.s3Key);
  return { url };
}
