import { relations } from 'drizzle-orm'
import {
  users,
  rooms,
  roomMembers,
  refreshTokens,
  roomSessions,
  sessionParticipants,
  speakingEvents,
  pttRecordings,
} from './schema'

export const usersRelations = relations(users, ({ many }) => ({
  rooms: many(rooms),
  hostedRooms: many(rooms, { relationName: 'host' }),
  roomMemberships: many(roomMembers),
  refreshTokens: many(refreshTokens),
  sessionParticipations: many(sessionParticipants),
  speakingEvents: many(speakingEvents),
  pttRecordings: many(pttRecordings),
}))

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  creator: one(users, { fields: [rooms.createdBy], references: [users.id] }),
  host: one(users, { fields: [rooms.hostId], references: [users.id], relationName: 'host' }),
  members: many(roomMembers),
  sessions: many(roomSessions),
  pttRecordings: many(pttRecordings),
}))

export const roomMembersRelations = relations(roomMembers, ({ one }) => ({
  room: one(rooms, { fields: [roomMembers.roomId], references: [rooms.id] }),
  user: one(users, { fields: [roomMembers.userId], references: [users.id] }),
}))

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}))

export const roomSessionsRelations = relations(roomSessions, ({ one, many }) => ({
  room: one(rooms, { fields: [roomSessions.roomId], references: [rooms.id] }),
  participants: many(sessionParticipants),
  speakingEvents: many(speakingEvents),
  pttRecordings: many(pttRecordings),
}))

export const sessionParticipantsRelations = relations(sessionParticipants, ({ one }) => ({
  session: one(roomSessions, {
    fields: [sessionParticipants.sessionId],
    references: [roomSessions.id],
  }),
  user: one(users, { fields: [sessionParticipants.userId], references: [users.id] }),
}))

export const speakingEventsRelations = relations(speakingEvents, ({ one }) => ({
  session: one(roomSessions, {
    fields: [speakingEvents.sessionId],
    references: [roomSessions.id],
  }),
  user: one(users, { fields: [speakingEvents.userId], references: [users.id] }),
}))

export const pttRecordingsRelations = relations(pttRecordings, ({ one }) => ({
  room: one(rooms, { fields: [pttRecordings.roomId], references: [rooms.id] }),
  session: one(roomSessions, { fields: [pttRecordings.sessionId], references: [roomSessions.id] }),
  user: one(users, { fields: [pttRecordings.userId], references: [users.id] }),
}))
