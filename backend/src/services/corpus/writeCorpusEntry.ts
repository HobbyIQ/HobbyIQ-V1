/**
 * Cosmos write path for the CompIQ corpus collector.
 *
 * Contract:
 *   - Fire-and-forget. The exported function returns `void` synchronously;
 *     callers MUST NOT await it. Errors during the async write are
 *     swallowed and rate-limited at one log per minute.
 *   - The disabled check is unconditional and runs FIRST, before any
 *     PRNG call or Cosmos client touch. An operator setting
 *     COMPIQ_CORPUS_DISABLED=1 takes effect on the next request.
 *   - Sample rate is read fresh on every call.
 *   - The Cosmos client is lazily initialized on first successful write
 *     attempt and cached for the process lifetime. If
 *     COSMOS_CONNECTION_STRING is unset, the writer is a permanent no-op
 *     and logs once.
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import type { CorpusEntry } from "../../models/corpusEntry.js";
import { isCorpusDisabled, getCorpusSampleRate } from "./corpusConfig.js";

const DB_NAME = "hobbyiq";
const CONTAINER_NAME = "compiq_corpus";
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
        "[corpus] COSMOS_CONNECTION_STRING not set; corpus writes are no-ops",
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
        "[corpus] failed to initialize Cosmos client:",
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
      "[corpus] write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Fire-and-forget Cosmos write for a CorpusEntry. Returns void
 * synchronously. The async write is wrapped in try/catch so a failing
 * Cosmos client cannot produce an unhandled rejection.
 */
export function writeCorpusEntry(entry: CorpusEntry): void {
  // Cheap, unconditional check FIRST. No PRNG call, no client touch.
  if (isCorpusDisabled()) return;

  const rate = getCorpusSampleRate();
  if (rate <= 0) return;
  if (rate < 1 && Math.random() >= rate) return;

  // Fire-and-forget. The void-IIFE pattern keeps the rejection inside
  // this scope; the inner try/catch ensures it's swallowed.
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
export const __writeCorpusEntryInternals = {
  reset: (): void => {
    cachedContainer = null;
    initErrorLogged = false;
    lastErrorLogMs = 0;
  },
};
