/**
 * Cosmos write path for the CompIQ comp_logs collector.
 *
 * Contract:
 *   - Fire-and-forget. The exported function returns `void` synchronously;
 *     callers MUST NOT await it. Errors during the async write are
 *     swallowed and rate-limited at one log per minute.
 *   - The disabled check is unconditional and runs FIRST, before any
 *     PRNG call or Cosmos client touch.
 *   - Sample rate is read fresh on every call.
 *   - The Cosmos client is lazily initialized on first successful write
 *     attempt and cached for the process lifetime. If
 *     COSMOS_CONNECTION_STRING is unset, the writer is a permanent no-op
 *     and logs once.
 *
 * Mirrors services/corpus/writeCorpusEntry.ts in shape and behaviour;
 * the two writers are independent (separate containers, separate
 * sample-rate env vars, separate disabled kill switches) but share the
 * same gate-before-build-before-write pattern.
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import type { CompLogEntry } from "../../models/compLogEntry.js";
import { isCompLogsDisabled, getCompLogsSampleRate } from "./compLogsConfig.js";

const DB_NAME = "hobbyiq";
const CONTAINER_NAME = "comp_logs";
const ERROR_LOG_THROTTLE_MS = 60_000;

let cachedContainer: Container | null = null;
let initErrorLogged = false;
let lastErrorLogMs = 0;

function getContainer(): Container | null {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    if (!initErrorLogged) {
      initErrorLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[comp_logs] COSMOS_CONNECTION_STRING not set; comp_logs writes are no-ops",
      );
    }
    return null;
  }
  try {
    const client = new CosmosClient(conn);
    cachedContainer = client.database(DB_NAME).container(CONTAINER_NAME);
    return cachedContainer;
  } catch (e) {
    if (!initErrorLogged) {
      initErrorLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[comp_logs] failed to initialize Cosmos client:",
        e instanceof Error ? e.message : String(e),
      );
    }
    return null;
  }
}

function logErrorThrottled(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogMs >= ERROR_LOG_THROTTLE_MS) {
    lastErrorLogMs = now;
    // eslint-disable-next-line no-console
    console.warn(
      "[comp_logs] write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Fire-and-forget Cosmos write for a CompLogEntry. Returns void
 * synchronously. The async write is wrapped in try/catch so a failing
 * Cosmos client cannot produce an unhandled rejection.
 */
export function writeCompLog(entry: CompLogEntry): void {
  if (isCompLogsDisabled()) return;

  const rate = getCompLogsSampleRate();
  if (rate <= 0) return;
  if (rate < 1 && Math.random() >= rate) return;

  void (async () => {
    try {
      const container = getContainer();
      if (!container) return;
      await container.items.create(entry);
    } catch (e) {
      logErrorThrottled(e);
    }
  })();
}

/**
 * Test-only hook for resetting module state between tests.
 */
export const __writeCompLogInternals = {
  reset: (): void => {
    cachedContainer = null;
    initErrorLogged = false;
    lastErrorLogMs = 0;
  },
};
