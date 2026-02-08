# Session Store Integration Guide

## Architecture Overview

The pluggable SessionStore provides a **parallel persistence layer** alongside
pi-coding-agent's SessionManager. SessionManager continues to own the JSONL file
for in-memory tree operations. The SessionStore mirrors writes to a durable
backend (Redis Streams / SQLite / JSONL).

```
User Message → SessionManager (JSONL tree)
                    ↓ (mirror write)
              SessionBackend (Redis / SQLite / JSONL)
```

## Files Created

| File                                    | Purpose                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `src/sessions/session-store.ts`         | `SessionBackend` interface + `SessionStoreConfig` type |
| `src/sessions/backends/redis-stream.ts` | Redis Streams implementation (ioredis)                 |
| `src/sessions/backends/sqlite.ts`       | SQLite implementation (better-sqlite3, optional dep)   |
| `src/sessions/backends/jsonl.ts`        | JSONL filesystem implementation (always available)     |
| `src/sessions/backend-resolver.ts`      | Auto-detect + resilient fallback wrapper               |

## Config Schema

Added `sessionStore` to `OpenClawConfig` (top-level, NOT inside `session`):

```json5
{
  sessionStore: {
    store: "auto", // "auto" | "redis-stream" | "sqlite" | "jsonl"
    redis: {
      url: "redis://127.0.0.1:6379",
      prefix: "openclaw:session",
    },
    sqlite: {
      path: "~/.openclaw/sessions.db",
    },
    maxEntries: 500,
    compactionTriggerBytes: 150000,
  },
}
```

## How to Wire In (Next Steps)

### 1. Initialize the backend at gateway start

```typescript
import { createResilientBackend } from "./sessions/backend-resolver.js";

// During gateway initialization:
const backend = await createResilientBackend({
  config: openClawConfig.sessionStore,
});
```

### 2. Mirror writes after SessionManager operations

In `src/config/sessions/transcript.ts` (after `sessionManager.appendMessage()`):

```typescript
// After sessionManager.appendMessage(...)
const entry: FileEntry = {
  type: "message",
  id: generatedId,
  parentId: currentLeafId,
  timestamp: new Date().toISOString(),
  message: { role: "assistant", content: [...] },
};
await backend.append(sessionId, entry);
```

### 3. Hydrate JSONL before SessionManager.open()

In `src/agents/pi-embedded-runner/run/attempt.ts` and `compact.ts`, before
`SessionManager.open(sessionFile)`:

```typescript
// If JSONL file is missing/empty but backend has data, hydrate it:
const entries = await backend.loadEntries(sessionId);
if (entries.length > 0) {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.promises.writeFile(sessionFile, content, "utf-8");
}
```

### 4. Use getRecent() for context building

Replace full-file reads with chunked reads:

```typescript
const recent = await backend.getRecent(sessionId, 50, 150_000);
```

### 5. Hook compaction into backend trim

After `session.compact()`, mirror the compaction to the backend:

```typescript
const remainingEntries = sessionManager.getEntries();
const header = sessionManager.getHeader();
const allEntries: FileEntry[] = header ? [header, ...remainingEntries] : [...remainingEntries];
await backend.rewrite(sessionId, allEntries);
```

### 6. Graceful degradation

The `ResilientSessionBackend` wrapper automatically falls back to JSONL if
Redis/SQLite fails mid-session. No special handling needed in calling code.

```typescript
import { ResilientSessionBackend } from "./sessions/backend-resolver.js";

// Check if degraded (for metrics/logging)
if (backend instanceof ResilientSessionBackend && backend.isDegraded()) {
  log.warn("Session store running in degraded mode");
  await backend.tryRecover(); // Attempt recovery
}
```

## Dependencies

- **ioredis** — already in `package.json` (`^5.6.1`)
- **better-sqlite3** — NOT installed (optional). Install with:
  ```sh
  pnpm add better-sqlite3 @types/better-sqlite3
  ```
  Without it, SQLite backend throws a descriptive error and auto-mode skips it.

## Key Design Decisions

1. **Parallel persistence, not replacement**: SessionManager owns the tree. We
   mirror to durable storage. This avoids modifying the external dependency.

2. **Dynamic imports**: Redis and SQLite backends use `await import(...)` so
   missing dependencies don't crash the import graph.

3. **`sessionStore` is separate from `session`**: The existing `session` config
   controls routing/scoping. `sessionStore` controls durable persistence.

4. **JSONL is always the final fallback**: Even if Redis and SQLite both fail,
   the system degrades to the original JSONL behavior.
