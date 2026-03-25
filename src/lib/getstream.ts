import { StreamClient } from '@stream-io/node-sdk';
import { env } from '../config/env';

export const streamClient = new StreamClient(env.getstream.apiKey, env.getstream.apiSecret);

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
  console.log("Creating GetStream call with ID: ", callId);
  const call = streamClient.video.call(env.getstream.callType, callId);
  await call.getOrCreate({
    data: {
      created_by_id: adminUserId,
      custom: { name },
    },
  });
  return call;
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
 * End a GetStream call. All participants are disconnected by the SDK.
 */
export async function endGetstreamCall(callId: string) {
  const call = getGetstreamCall(callId);
  // const response = await call.queryCallParticipants({ filter_conditions: { user_id: "58d5ff12-142a-40ca-9547-8c7aa138a3d2" } });
  // console.log("response -> ", response);
  // const res = await call.queryMembers();
  // console.log("res -> ", res);
  await call.end();
}

/**
 * Get current participants in a call from GetStream.
 */
export async function getCallParticipants(callId: string) {
  const call = getGetstreamCall(callId);
  const response = await call.get();
  return response.call;
}
