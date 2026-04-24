/**
 * Shared recorders for mocked Stream + WS calls.
 *
 * Tests import these arrays to assert what the service layer would have
 * pushed to Stream / over the WS pub-sub channel.
 */

export type StreamCall = { fn: string; args: unknown[]; at: number };
export type WsEvent = { fn: 'sendToUser' | 'sendToRoomMembers'; target: string; event: string; payload: unknown; at: number };

export const streamRecorder: StreamCall[] = [];
export const wsRecorder: WsEvent[] = [];

export function clearRecorders() {
  streamRecorder.length = 0;
  wsRecorder.length = 0;
}

export function streamCallsOf(fn: string): StreamCall[] {
  return streamRecorder.filter((c) => c.fn === fn);
}

export function wsEventsOf(event: string): WsEvent[] {
  return wsRecorder.filter((e) => e.event === event);
}
