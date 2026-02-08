/**
 * Session write events for backend mirroring.
 *
 * Fires after a session run completes or when a transcript mirror write
 * occurs. The backend bridge listens to these events and syncs session
 * state to the active backend.
 */

export type SessionSyncEvent = {
  sessionFile: string;
  sessionId: string;
  /** "run" after agent run, "compact" after compaction, "mirror" for transcript mirrors. */
  reason: "run" | "compact" | "mirror";
};

type SessionSyncListener = (event: SessionSyncEvent) => void;

const SESSION_SYNC_LISTENERS = new Set<SessionSyncListener>();

export function onSessionSync(listener: SessionSyncListener): () => void {
  SESSION_SYNC_LISTENERS.add(listener);
  return () => {
    SESSION_SYNC_LISTENERS.delete(listener);
  };
}

export function emitSessionSync(event: SessionSyncEvent): void {
  for (const listener of SESSION_SYNC_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Listeners must not throw into the write path
    }
  }
}
