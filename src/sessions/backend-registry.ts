/**
 * Singleton registry for the active SessionBackend instance.
 *
 * The gateway owns the backend lifecycle. Other parts of the codebase
 * access the backend through this registry without requiring parameter
 * threading through every function call.
 */

import type { SessionBackend, SessionStoreConfig } from "./session-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("session-store");

let _backend: SessionBackend | null = null;
let _initializing: Promise<SessionBackend | null> | null = null;

/**
 * Get the active session backend (if initialized).
 * Returns null if no backend has been set up yet.
 */
export function getSessionBackend(): SessionBackend | null {
  return _backend;
}

/**
 * Set the active session backend.
 * Called once during gateway initialization.
 */
export function setSessionBackend(backend: SessionBackend | null): void {
  _backend = backend;
}

/**
 * Initialize and register the session backend from config.
 * Safe to call multiple times — returns the cached instance.
 */
export async function initSessionBackend(
  config?: SessionStoreConfig,
): Promise<SessionBackend | null> {
  if (_backend) return _backend;
  if (_initializing) return _initializing;

  _initializing = (async () => {
    if (!config) {
      log.info("session-store: no sessionStore config, skipping backend init");
      return null;
    }

    try {
      const { createResilientBackend } = await import("./backend-resolver.js");
      const backend = await createResilientBackend({ config });
      _backend = backend;
      log.info(`session-store: initialized backend "${backend.name}"`);
      return backend;
    } catch (err) {
      log.warn(`session-store: failed to initialize backend: ${String(err)}`);
      return null;
    } finally {
      _initializing = null;
    }
  })();

  return _initializing;
}

/**
 * Shut down the active backend (called during gateway close).
 */
export async function closeSessionBackend(): Promise<void> {
  const backend = _backend;
  _backend = null;
  _initializing = null;
  if (backend) {
    try {
      await backend.close();
      log.info(`session-store: closed backend "${backend.name}"`);
    } catch (err) {
      log.warn(`session-store: error closing backend: ${String(err)}`);
    }
  }
}
