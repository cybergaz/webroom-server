import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
  index,
  unique,
  boolean,
  integer,
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['user', 'host', 'admin', 'super_admin']);
export const userStatusEnum = pgEnum('user_status', ['pending_approval', 'approved', 'rejected']);
export const roomStatusEnum = pgEnum('room_status', ['active', 'inactive', 'live', 'ended']);

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: varchar('request_id', { length: 8 }).unique(),
    name: varchar('name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    email: varchar('email', { length: 255 }).unique(),
    passwordHash: varchar('password_hash', { length: 255 }),
    role: userRoleEnum('role').default('user').notNull(),
    status: userStatusEnum('status').default('pending_approval').notNull(),
    createdByUserId: uuid('created_by_user_id').references((): any => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lockedDeviceId: varchar('locked_device_id', { length: 255 }),
    lockedDeviceName: varchar('locked_device_name', { length: 255 }),
    allowDeviceChange: boolean('allow_device_change').default(false).notNull(),
  },
  (t) => [
    index('idx_users_phone').on(t.phone),
    index('idx_users_status').on(t.status),
    index('idx_users_request_id').on(t.requestId),
  ],
);

// ─── Admin User Adoptions ─────────────────────────────────────────────────────

export const adminUserAdoptions = pgTable(
  'admin_user_adoptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_admin_user_adoptions').on(t.adminId, t.userId),
    index('idx_admin_user_adoptions_admin').on(t.adminId),
    index('idx_admin_user_adoptions_user').on(t.userId),
  ],
);

export type AdminUserAdoption = typeof adminUserAdoptions.$inferSelect;

// ─── Rooms ────────────────────────────────────────────────────────────────────

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: roomStatusEnum('status').default('active').notNull(),
    getstreamCallId: varchar('getstream_call_id', { length: 255 }).notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    hostId: uuid('host_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rooms_created_by').on(t.createdBy),
    index('idx_rooms_status').on(t.status),
    index('idx_rooms_host').on(t.hostId),
  ],
);

// ─── Room Members (accepted + in room) ────────────────────────────────────────

export const roomMembers = pgTable(
  'room_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_room_members').on(t.roomId, t.userId),
    index('idx_room_members_user').on(t.userId),
    index('idx_room_members_room').on(t.roomId),
  ],
);

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    device_name: varchar('device_name', { length: 255 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_refresh_tokens_user').on(t.userId)],
);

// ─── Room Sessions ────────────────────────────────────────────────────────────

export const roomSessions = pgTable(
  'room_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_room_sessions_room').on(t.roomId),
  ],
);

// ─── Session Participants ─────────────────────────────────────────────────────
// Records every user who actually connected to a live session, with timestamps.

export const sessionParticipants = pgTable(
  'session_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => roomSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    unique('uq_session_participants').on(t.sessionId, t.userId),
    index('idx_session_participants_session').on(t.sessionId),
    index('idx_session_participants_user').on(t.userId),
  ],
);

// ─── Speaking Events ──────────────────────────────────────────────────────────

export const speakingEvents = pgTable(
  'speaking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => roomSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
  },
  (t) => [
    index('idx_speaking_events_session').on(t.sessionId),
    index('idx_speaking_events_user').on(t.userId),
  ],
);

// ─── PTT Recordings ──────────────────────────────────────────────────────────

export const pttRecordings = pgTable(
  'ptt_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => roomSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    s3Key: varchar('s3_key', { length: 512 }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    mimeType: varchar('mime_type', { length: 64 }).notNull().default('audio/mp4'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_ptt_recordings_room').on(t.roomId),
    index('idx_ptt_recordings_session').on(t.sessionId),
    index('idx_ptt_recordings_user').on(t.userId),
    index('idx_ptt_recordings_created_at').on(t.createdAt),
  ],
);

// ─── Session Transcriptions ──────────────────────────────────────────────────

export const sessionTranscriptions = pgTable(
  'session_transcriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => roomSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_session_transcriptions_session').on(t.sessionId),
    index('idx_session_transcriptions_user').on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type RoomSession = typeof roomSessions.$inferSelect;
export type SessionParticipant = typeof sessionParticipants.$inferSelect;
export type SpeakingEvent = typeof speakingEvents.$inferSelect;
export type PttRecording = typeof pttRecordings.$inferSelect;
export type SessionTranscription = typeof sessionTranscriptions.$inferSelect;
