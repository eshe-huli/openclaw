import { createWriteStream, statSync, renameSync, type WriteStream } from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("jsonl-audit");

export type AuditEntry = {
  ts: number;
  op: "enqueue" | "dequeue" | "complete" | "fail" | "retry" | "purge";
  id: string;
  channel?: string;
  to?: string;
  error?: string;
  attempts?: number;
};

export type JsonlAuditConfig = {
  path: string;
  maxSizeMb?: number;
};

export class JsonlAuditStore {
  private stream: WriteStream;
  private writeCount = 0;
  private maxSizeBytes: number;
  private filePath: string;

  constructor(config: JsonlAuditConfig) {
    this.filePath = config.path;
    this.maxSizeBytes = (config.maxSizeMb ?? 50) * 1024 * 1024;
    this.stream = createWriteStream(this.filePath, { flags: "a" });

    logger.info("Initialized JSONL audit store", {
      path: this.filePath,
      maxSizeMb: config.maxSizeMb ?? 50,
    });
  }

  write(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.stream.write(line);
      this.writeCount++;

      // Check file size every 100 writes to avoid excessive stat calls
      if (this.writeCount % 100 === 0) {
        this.checkAndRotate();
      }
    } catch (error) {
      // Fire-and-forget: log but never throw
      logger.error("Failed to write audit entry", {
        error: error instanceof Error ? error.message : String(error),
        entry,
      });
    }
  }

  private checkAndRotate(): void {
    try {
      const stats = statSync(this.filePath);
      if (stats.size >= this.maxSizeBytes) {
        logger.info("Rotating audit log", {
          currentSize: stats.size,
          maxSize: this.maxSizeBytes,
        });

        // Close current stream
        this.stream.end();

        // Rotate file with ISO timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${this.filePath}.${timestamp}.bak`;
        renameSync(this.filePath, backupPath);

        logger.info("Rotated audit log", {
          from: this.filePath,
          to: backupPath,
        });

        // Create new stream
        this.stream = createWriteStream(this.filePath, { flags: "a" });
        this.writeCount = 0;
      }
    } catch (error) {
      // Fire-and-forget: log but never throw
      logger.error("Failed to rotate audit log", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((error: Error | null | undefined) => {
        if (error) {
          logger.error("Error closing audit stream", {
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        } else {
          logger.info("Closed audit stream");
          resolve();
        }
      });
    });
  }
}
