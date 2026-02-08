/**
 * Session Backend Bridge
 *
 * Connects the SessionBackend to the existing session flow:
 * - Mirrors session state to the backend after runs and compactions
 * - Hydrates JSONL from backend on session load
 * - Provides event-driven sync via onSessionSync listener
 *
 * All operations are fire-and-forget with error logging.
 * The JSONL fallback always works regardless of backend state.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileEntry, SessionBackend } from "./session-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getSessionBackend } from "./backend-registry.js";
import { onSessionSync } from "./session-write-events.js";

const log = createSubsystemLogger("session-store");

/** Unsub handle for the global sync listener. */
let _syncUnsub: (() => void) | null = null;

/**
 * Start listening for session sync events and mirror to the backend.
 * Called once during gateway init (after backend is set up).
 * Idempotent.
 */
export function startSessionSyncListener(): void {
  if (_syncUnsub) return;

  _syncUnsub = onSessionSync((event) => {
    // Fire-and-forget mirror
    void mirrorSessionFileToBackend(event.sessionFile, event.sessionId).catch(() => {
      // Already logged inside mirrorSessionFileToBackend
    });
  });
}

/**
 * Stop listening for session sync events.
 */
export function stopSessionSyncListener(): void {
  if (_syncUnsub) {
    _syncUnsub();
    _syncUnsub = null;
  }
}

/**
 * Mirror a single entry to the backend for a given session.
 * Fire-and-forget: logs warnings on failure, never throws.
 */
export async function mirrorEntryToBackend(
  sessionId: string,
  entry: FileEntry,
  backend?: SessionBackend | null,
): Promise<void> {
  const b = backend ?? getSessionBackend();
  if (!b) return;

  try {
    await b.append(sessionId, entry);
  } catch (err) {
    log.warn(`session-store: mirror append failed for ${sessionId}: ${String(err)}`);
  }
}

/**
 * Mirror all entries from a JSONL file to the backend.
 * Used after a full session file write (e.g., after runs or compaction).
 * Fire-and-forget: logs warnings on failure, never throws.
 */
export async function mirrorSessionFileToBackend(
  sessionFile: string,
  sessionId: string,
  backend?: SessionBackend | null,
): Promise<void> {
  const b = backend ?? getSessionBackend();
  if (!b) return;

  try {
    const raw = await fs.promises.readFile(sessionFile, "utf-8");
    const entries = parseJsonlEntries(raw);
    if (entries.length > 0) {
      await b.rewrite(sessionId, entries);
    }
  } catch (err) {
    log.warn(`session-store: mirror session file failed for ${sessionId}: ${String(err)}`);
  }
}

/**
 * Hydrate a JSONL session file from the backend if:
 * - The JSONL file is missing or empty
 * - The backend has entries for this session
 *
 * This should be called BEFORE SessionManager.open().
 *
 * Returns true if hydration occurred, false otherwise.
 */
export async function hydrateSessionFromBackend(
  sessionFile: string,
  sessionId: string,
  backend?: SessionBackend | null,
): Promise<boolean> {
  const b = backend ?? getSessionBackend();
  if (!b) return false;

  try {
    // Check if JSONL file exists and has content
    let fileExists = false;
    let fileSize = 0;
    try {
      const stat = await fs.promises.stat(sessionFile);
      fileExists = true;
      fileSize = stat.size;
    } catch {
      // File doesn't exist
    }

    // If file exists and has content, no hydration needed
    if (fileExists && fileSize > 10) {
      return false;
    }

    // Check if backend has entries
    const entries = await b.loadEntries(sessionId);
    if (entries.length === 0) {
      return false;
    }

    // Hydrate: write backend entries to JSONL file
    const dir = path.dirname(sessionFile);
    await fs.promises.mkdir(dir, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.promises.writeFile(sessionFile, content, "utf-8");
    log.info(
      `session-store: hydrated ${sessionId} from backend (${entries.length} entries → ${sessionFile})`,
    );
    return true;
  } catch (err) {
    log.warn(`session-store: hydration failed for ${sessionId}: ${String(err)}`);
    return false;
  }
}

/**
 * Mirror compaction results to the backend.
 * Called after session.compact() to replace backend contents
 * with the compacted session state.
 *
 * Reads the compacted JSONL file and rewrites the backend.
 * Fire-and-forget: logs warnings on failure, never throws.
 */
export async function mirrorCompactionToBackend(
  sessionFile: string,
  sessionId: string,
  backend?: SessionBackend | null,
): Promise<void> {
  // After compaction, the JSONL file contains the authoritative state.
  // Mirror it entirely to the backend.
  await mirrorSessionFileToBackend(sessionFile, sessionId, backend);
}

// ── Internal helpers ──────────────────────────────────────────────

function parseJsonlEntries(raw: string): FileEntry[] {
  const lines = raw.split("\n");
  const entries: FileEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FileEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}
