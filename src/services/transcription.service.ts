import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { sessionTranscriptions, roomSessions } from '../db/schema';
import { listCallTranscriptions } from '../lib/getstream';

interface TranscriptionJsonlEntry {
  type: string;
  speaker_id: string;
  text: string;
  start_time: string;
  stop_time: string;
}

/**
 * Fetch transcription JSONL from GetStream and persist to DB.
 * Retries up to 3 times with increasing delays since GetStream
 * may not have the transcription file ready immediately after stop.
 */
export async function fetchAndStoreTranscription(sessionId: string, getstreamCallId: string): Promise<void> {
  const maxRetries = 3;
  const retryDelays = [0, 30_000, 60_000]; // 0s, 30s, 60s

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[Transcription] Retry ${attempt}/${maxRetries - 1} for session ${sessionId}, waiting ${retryDelays[attempt] / 1000}s...`);
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));
    }

    try {
      const transcriptions = await listCallTranscriptions(getstreamCallId);
      console.log(`[Transcription] Found ${transcriptions.length} transcription(s) for call ${getstreamCallId}`);

      if (transcriptions.length === 0) {
        if (attempt < maxRetries - 1) continue; // retry
        console.log('[Transcription] No transcriptions available after all retries');
        return;
      }

      let totalRows = 0;

      for (const transcription of transcriptions) {
        const url = transcription.url;
        if (!url) {
          console.log('[Transcription] Transcription entry has no URL, skipping');
          continue;
        }

        console.log(`[Transcription] Fetching JSONL from: ${url.substring(0, 80)}...`);
        const response = await fetch(url);
        if (!response.ok) {
          console.error('[Transcription] Failed to fetch JSONL:', response.status, response.statusText);
          continue;
        }

        const text = await response.text();
        console.log(`[Transcription] JSONL size: ${text.length} bytes`);
        const lines = text.trim().split('\n').filter(Boolean);

        const rows = lines
          .map((line) => {
            try {
              return JSON.parse(line) as TranscriptionJsonlEntry;
            } catch {
              return null;
            }
          })
          .filter((entry): entry is TranscriptionJsonlEntry =>
            entry !== null && entry.type === 'speech' && !!entry.text?.trim()
          )
          .map((entry) => ({
            sessionId,
            userId: entry.speaker_id,
            text: entry.text,
            startTime: new Date(entry.start_time),
            endTime: new Date(entry.stop_time),
          }));

        if (rows.length > 0) {
          for (let i = 0; i < rows.length; i += 500) {
            await db.insert(sessionTranscriptions).values(rows.slice(i, i + 500));
          }
          totalRows += rows.length;
        }
      }

      console.log(`[Transcription] Stored ${totalRows} entries for session ${sessionId}`);
      return; // success, stop retrying

    } catch (err: any) {
      console.error(`[Transcription] Attempt ${attempt + 1} failed:`, err?.message ?? err);
      if (attempt >= maxRetries - 1) throw err;
    }
  }
}

/**
 * Get stored transcriptions for a single session, ordered by time.
 */
export async function getSessionTranscriptions(sessionId: string) {
  return db.query.sessionTranscriptions.findMany({
    where: eq(sessionTranscriptions.sessionId, sessionId),
    with: {
      user: { columns: { id: true, name: true } },
    },
    orderBy: (t, { asc }) => [asc(t.startTime)],
  });
}

/**
 * Get all sessions for a room with their transcriptions (for recorded view).
 */
export async function getRoomSessionTranscriptions(roomId: string) {
  return db.query.roomSessions.findMany({
    where: eq(roomSessions.roomId, roomId),
    with: {
      transcriptions: {
        with: { user: { columns: { id: true, name: true } } },
        orderBy: (t, { asc }) => [asc(t.startTime)],
      },
    },
    orderBy: (t, { desc }) => [desc(t.startedAt)],
  });
}
