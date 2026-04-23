import { StreamClient } from '@stream-io/node-sdk';
import { env } from '../config/env';

export const streamClient = new StreamClient(
  env.getstream.apiKey,
  env.getstream.apiSecret,
  {
    timeout: 10000, // 10 seconds timeout for API calls
  }
);

/**
 * Generate a GetStream token for a user. Called on login and room join.
 * Validity: 1 hour (the client will re-request on room join anyway).
 */
export function generateGetstreamToken(userId: string): string {
  return streamClient.generateUserToken({ user_id: userId, validity_in_seconds: 3600 });
}

/**
 * Create a GetStream audio room call.
 * We use a deterministic call ID derived from our room UUID.
 */
export async function createGetstreamCall(callId: string, adminUserId: string, name: string) {
  // console.log("Creating GetStream call with ID: ", callId);
  const call = streamClient.video.call(env.getstream.callType, callId);
  await call.getOrCreate({
    data: {
      created_by_id: adminUserId,
      members: [{ user_id: adminUserId, role: 'host' }],
      custom: { name },
    },
  });
  return call;
}

/**
 * Ensure a user has the 'host' role on a GetStream call.
 * Used when a host (who didn't originally create the call) starts the room.
 *
 * updateCallMembers is authoritative: getOrCreate's `members` param is a
 * no-op on an already-existing call, so we must await the explicit update
 * — otherwise members see the host as a regular participant (no 'host'
 * role), which makes the Flutter client render "Connecting..." forever.
 */
export async function ensureCallHost(callId: string, hostUserId: string) {
  const call = streamClient.video.call(env.getstream.callType, callId);
  await call.getOrCreate({
    data: {
      created_by_id: hostUserId,
      members: [{ user_id: hostUserId, role: 'host' }],
    },
  });
  await call.updateCallMembers({
    update_members: [{ user_id: hostUserId, role: 'host' }],
  });
}

/**
 * Take an audio_room call out of backstage so members can join.
 */
export async function goLiveCall(callId: string) {
  const call = getGetstreamCall(callId);
  await call.goLive();
}

export function getGetstreamCall(callId: string) {
  return streamClient.video.call(env.getstream.callType, callId);
}

/**
 * Mute a user's audio in a GetStream call.
 * This enforces the mute at the media layer — the Flutter SDK will reflect it automatically.
 */
export async function muteUserInCall(callId: string, targetUserId: string, mutedByUserId: string) {
  const call = getGetstreamCall(callId);
  await call.muteUsers({
    muted_by_id: mutedByUserId,
    user_ids: [targetUserId],
    audio: true,
  });
}

/**
 * Mute all users in a call.
 */
export async function muteAllInCall(callId: string, mutedByUserId: string) {
  const call = getGetstreamCall(callId);
  await call.muteUsers({
    muted_by_id: mutedByUserId,
    mute_all_users: true,
    audio: true,
  });
}

/**
 * Remove (kick) a user from a GetStream call.
 * The GetStream Flutter SDK fires an event to the kicked user automatically.
 */
export async function kickUserFromCall(callId: string, targetUserId: string) {
  const call = getGetstreamCall(callId);
  await call.kickUser({ user_id: targetUserId });
}

/**
 * Grant send-audio permission to a user on a GetStream call.
 * Called server-side when a user joins a room so they can PTT reliably.
 * This is more reliable than granting from the host's client because it
 * uses admin credentials and doesn't depend on the host's network/timing.
 */
export async function grantUserSendAudio(callId: string, userId: string) {
  const call = getGetstreamCall(callId);
  await call.updateUserPermissions({
    user_id: userId,
    grant_permissions: ['send-audio'],
  });
}

/**
 * Stop a GetStream call session. Returns the call to backstage mode so it
 * can be started again later with goLive(). Does NOT permanently end the call.
 */
export async function endGetstreamCall(callId: string) {
  const call = getGetstreamCall(callId);
  await call.stopLive();
}

/**
 * Get current participants in a call from GetStream.
 */
export async function getCallParticipants(callId: string) {
  const call = getGetstreamCall(callId);
  const response = await call.get();
  return response.call;
}

/**
 * Start recording a call. Requires the call to be live.
 * Records audio-only since these are audio rooms.
 */
export async function startCallRecording(callId: string) {
  const call = getGetstreamCall(callId);
  await call.update({
    settings_override: {
      recording: {
        mode: 'available',
        audio_only: true,
        quality: '720p',
      },
    },
  });
  await call.startRecording({ recording_type: 'composite' });
}

/**
 * Stop recording a call.
 */
export async function stopCallRecording(callId: string) {
  const call = getGetstreamCall(callId);
  await call.stopRecording({ recording_type: 'composite' });
}

/**
 * List all recordings for a call across all sessions.
 * Returns recordings grouped by session with signed download URLs.
 */
export async function listCallRecordings(callId: string) {
  const call = getGetstreamCall(callId);
  const response = await call.listRecordings();
  return response.recordings;
}
