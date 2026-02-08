/**
 * JSONL file backend for session storage.
 *
 * Wraps the existing JSONL file format used by pi-coding-agent's SessionManager
 * in the SessionBackend interface. This is the "last resort" fallback that
 * preserves complete backward compatibility.
 *
 * Reads/writes directly to the session's `.jsonl` file on disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileEntry, SessionBackend, SessionSizeInfo } from "../session-store.js";

export type JsonlBackendOptions = {
  /**
   * Base directory for session files. If provided, session files are resolved
   * as `{baseDir}/{sessionId}.jsonl`. If not provided, sessionId must be an
   * absolute path to the .jsonl file.
   */
  baseDir?: string;
};

export class JsonlBackend implements SessionBackend {
  readonly name = "jsonl";

  private baseDir: string | undefined;

  constructor(opts: JsonlBackendOptions = {}) {
    this.baseDir = opts.baseDir?.trim() || undefined;
  }

  private resolveFilePath(sessionId: string): string {
    // If sessionId looks like an absolute path, use it directly
    if (path.isAbsolute(sessionId) && sessionId.endsWith(".jsonl")) {
      return sessionId;
    }
    if (this.baseDir) {
      return path.join(this.baseDir, `${sessionId}.jsonl`);
    }
    // Fallback: treat sessionId as relative
    return `${sessionId}.jsonl`;
  }

  async loadEntries(sessionId: string): Promise<FileEntry[]> {
    const filePath = this.resolveFilePath(sessionId);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return this.parseJsonlContent(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return [];
      throw err;
    }
  }

  async append(sessionId: string, entry: FileEntry): Promise<void> {
    const filePath = this.resolveFilePath(sessionId);
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.promises.appendFile(filePath, line, "utf-8");
  }

  async getRecent(sessionId: string, limit: number, maxBytes?: number): Promise<FileEntry[]> {
    const all = await this.loadEntries(sessionId);
    if (all.length === 0) return [];

    // Take the last `limit` entries
    const start = Math.max(0, all.length - limit);
    const recent = all.slice(start);

    if (maxBytes === undefined) return recent;

    // Enforce byte limit (from the end)
    const result: FileEntry[] = [];
    let totalBytes = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const json = JSON.stringify(recent[i]);
      if (totalBytes + json.length > maxBytes) break;
      totalBytes += json.length;
      result.unshift(recent[i]);
    }
    return result;
  }

  async trim(sessionId: string, keepEntries: number): Promise<void> {
    const entries = await this.loadEntries(sessionId);
    if (entries.length === 0) return;

    // Keep header + last keepEntries
    const header = entries[0];
    const isHeader = header && "type" in header && (header as { type: string }).type === "session";
    const sessionEntries = isHeader ? entries.slice(1) : entries;
    const headerPart = isHeader ? [header] : [];

    if (sessionEntries.length <= keepEntries) return;

    const kept = sessionEntries.slice(-keepEntries);
    await this.writeEntries(sessionId, [...headerPart, ...kept]);
  }

  async rewrite(sessionId: string, entries: FileEntry[]): Promise<void> {
    await this.writeEntries(sessionId, entries);
  }

  async size(sessionId: string): Promise<SessionSizeInfo> {
    const filePath = this.resolveFilePath(sessionId);
    try {
      const stat = await fs.promises.stat(filePath);
      const entries = await this.loadEntries(sessionId);
      // Count non-header entries
      const headerCount =
        entries.length > 0 &&
        "type" in entries[0] &&
        (entries[0] as { type: string }).type === "session"
          ? 1
          : 0;
      return {
        entries: entries.length - headerCount,
        bytes: stat.size,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return { entries: 0, bytes: 0 };
      throw err;
    }
  }

  async delete(sessionId: string): Promise<void> {
    const filePath = this.resolveFilePath(sessionId);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return; // already gone
      throw err;
    }
  }

  async ping(): Promise<boolean> {
    // JSONL backend is always available (filesystem)
    return true;
  }

  async close(): Promise<void> {
    // Nothing to close for filesystem backend
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private parseJsonlContent(raw: string): FileEntry[] {
    const lines = raw.split("\n");
    const entries: FileEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as FileEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  private async writeEntries(sessionId: string, entries: FileEntry[]): Promise<void> {
    const filePath = this.resolveFilePath(sessionId);
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // Atomic write via temp file + rename
    const tmp = `${filePath}.tmp.${process.pid}`;
    try {
      await fs.promises.writeFile(tmp, content, "utf-8");
      await fs.promises.rename(tmp, filePath);
    } catch {
      // Fallback: direct write if rename fails
      await fs.promises.writeFile(filePath, content, "utf-8");
    } finally {
      // Clean up temp file if it still exists
      try {
        await fs.promises.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }
}
