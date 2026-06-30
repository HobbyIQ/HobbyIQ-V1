// chDeltaPoll.job.ts — CardHedge price-updates delta poll (CF-CH-DELTA-POLL-FOUNDATION 2026-06-30).
//
// Periodically calls /cards/price-updates with a `since` checkpoint to fetch
// only the price activity that's changed since the last poll. Updates that
// arrive get logged + emitted as telemetry; downstream wiring (trigger
// reprice for affected holdings, push notifications, etc.) is a follow-up.
//
// Today this is OBSERVATION-ONLY. Once the foundation is proven in prod
// (Drew registers CARD_HEDGE_CLIENT_ID and we accumulate logs), the next
// CF wires:
//   1. holding subscription enrollment (subscribe-price-updates on
//      portfolio add)
//   2. reverse-map updates → holdings via external_id
//   3. trigger reprice for affected holdings instead of the periodic full
//      6h refresh
//
// DEFAULTS
//   - Disabled unless CARD_HEDGE_CLIENT_ID is set (subscription set is
//     enrolled on CH's side) AND CH_DELTA_POLL_ENABLED=true
//   - Polls every 15 minutes (override via CH_DELTA_POLL_INTERVAL_MIN)
//   - First poll 60s after server startup
//   - On first poll with no checkpoint, defaults `since` to "1 hour ago"
//     to avoid pulling the full backlog on initial deploy
//
// CHECKPOINT
// Stored as a single ISO timestamp string in backend/.data/ch-delta-poll-checkpoint.json
// (atomic write — same disk-fallback pattern as dailyiq watchlists). On
// each successful poll we record the LATEST update_timestamp observed,
// not now() — guards against losing updates between polls if a sale
// arrives during the call.

import fs from "fs";
import path from "path";
import { getPriceUpdates, type CardHedgePriceUpdate } from "../services/compiq/cardhedge.client.js";
// CF-CH-DELTA-POLL-REVERSE-MAP (2026-06-30): consume updates by mapping
// (card_id, grade) → holdings → targeted reprice. Lazy-imported via
// dynamic import inside the cycle to avoid bloating the job's startup
// cost and to keep test mocks tractable.
import {
  findHoldingsByCardAndGrade,
  repriceHoldingByDelta,
} from "../services/portfolioiq/portfolioStore.service.js";

const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_FIRST_DELAY_MS = 60 * 1000;
const FALLBACK_SINCE_LOOKBACK_MS = 60 * 60 * 1000;  // 1h on first run with no checkpoint

const CHECKPOINT_DIR = path.join(process.cwd(), ".data");
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, "ch-delta-poll-checkpoint.json");

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;
let _running = false;

interface DeltaPollSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  since: string;
  updatesReceived: number;
  newCheckpoint: string;
  pollSucceeded: boolean;
  error?: string;
}

/** Read the persisted `since` checkpoint, or null if missing/corrupt. */
function readCheckpoint(): string | null {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    const raw = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    const data = JSON.parse(raw);
    const ts = data?.lastSeenUpdateTimestamp;
    return typeof ts === "string" && ts.length > 0 ? ts : null;
  } catch (err) {
    console.warn(`[ch-delta-poll] checkpoint read failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** Persist a new `since` checkpoint atomically. */
function writeCheckpoint(timestamp: string): void {
  try {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
    const tmp = `${CHECKPOINT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastSeenUpdateTimestamp: timestamp }, null, 2), "utf8");
    fs.renameSync(tmp, CHECKPOINT_FILE);
  } catch (err) {
    console.warn(`[ch-delta-poll] checkpoint write failed: ${(err as Error)?.message ?? err}`);
  }
}

/** Pick the latest update_timestamp from a batch — used as the next
 *  checkpoint. Sorted lexicographically because CH ships ISO timestamps. */
function latestTimestamp(updates: CardHedgePriceUpdate[]): string | null {
  if (updates.length === 0) return null;
  let max = updates[0]!.update_timestamp;
  for (const u of updates) {
    if (u.update_timestamp > max) max = u.update_timestamp;
  }
  return max;
}

/**
 * Run one delta poll cycle.
 *   - Read checkpoint (default 1h ago on first run)
 *   - Call /cards/price-updates
 *   - On success: emit telemetry, advance checkpoint to latest seen
 *   - On failure: keep checkpoint where it was (idempotent retry next cycle)
 */
export async function runDeltaPollCycle(now: Date = new Date()): Promise<DeltaPollSummary> {
  const startedAt = now.toISOString();
  const startMs = now.getTime();
  const persistedSince = readCheckpoint();
  const since = persistedSince ?? new Date(startMs - FALLBACK_SINCE_LOOKBACK_MS).toISOString();

  const summary: DeltaPollSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    since,
    updatesReceived: 0,
    newCheckpoint: since,
    pollSucceeded: false,
  };

  try {
    const result = await getPriceUpdates(since);
    if (result === null) {
      summary.pollSucceeded = false;
      summary.error = "getPriceUpdates returned null";
    } else {
      summary.pollSucceeded = true;
      summary.updatesReceived = result.updates.length;
      const latest = latestTimestamp(result.updates);
      if (latest) {
        summary.newCheckpoint = latest;
        writeCheckpoint(latest);
      }

      // CF-CH-DELTA-POLL-REVERSE-MAP (2026-06-30): for each unique
      // (card_id, grade) in the update batch, find matching holdings
      // and trigger a targeted reprice. Dedupe first — the same
      // (card_id, grade) often appears multiple times in one batch
      // (consecutive sales of the same card), but we only need ONE
      // reprice per card per cycle.
      let holdingsAffected = 0;
      let holdingsRepriced = 0;
      try {
        const uniquePairs = new Map<string, { cardId: string; grade: string }>();
        for (const u of result.updates) {
          const key = `${u.card_id}|${u.grade}`;
          if (!uniquePairs.has(key)) uniquePairs.set(key, { cardId: u.card_id, grade: u.grade });
        }
        for (const { cardId, grade } of uniquePairs.values()) {
          const matches = await findHoldingsByCardAndGrade(cardId, grade);
          holdingsAffected += matches.length;
          for (const m of matches) {
            const r = await repriceHoldingByDelta(m.userId, m.holdingId);
            if (r.repriced) holdingsRepriced++;
          }
        }
      } catch (err) {
        // Reverse-map failure must not poison the poll cycle. We've
        // already advanced the checkpoint above; the missed reprices
        // will surface on the next periodic full refresh (6h).
        console.warn(
          `[ch-delta-poll] reverse-map / reprice failed (non-fatal): ${(err as Error)?.message ?? err}`,
        );
      }

      // CF-CH-DELTA-POLL-TELEMETRY: structured event so KQL can chart
      // poll frequency, update counts, holdings affected, and detect
      // stalls. Emit even on zero-update cycles (those are the
      // healthy baseline).
      console.log(JSON.stringify({
        event: "ch_delta_poll_cycle",
        since,
        updatesReceived: result.updates.length,
        uniquePairs: new Set(result.updates.map((u) => `${u.card_id}|${u.grade}`)).size,
        holdingsAffected,
        holdingsRepriced,
        newCheckpoint: summary.newCheckpoint,
        checkpointAdvanced: summary.newCheckpoint !== since,
        timestamp: startedAt,
      }));
    }
  } catch (err: any) {
    summary.error = err?.message ?? String(err);
    summary.pollSucceeded = false;
    console.warn(`[ch-delta-poll] cycle threw: ${summary.error}`);
  }

  const endedAt = Date.now();
  summary.finishedAt = new Date(endedAt).toISOString();
  summary.durationMs = endedAt - startMs;
  return summary;
}

function readIntervalMs(): number {
  const env = process.env.CH_DELTA_POLL_INTERVAL_MIN;
  const min = env ? Number(env) : DEFAULT_INTERVAL_MIN;
  if (!Number.isFinite(min) || min <= 0) return DEFAULT_INTERVAL_MIN * 60 * 1000;
  return Math.floor(min) * 60 * 1000;
}

function isEnabled(): boolean {
  const clientId = process.env.CARD_HEDGE_CLIENT_ID;
  const flag = String(process.env.CH_DELTA_POLL_ENABLED ?? "").toLowerCase();
  return Boolean(clientId) && (flag === "true" || flag === "1" || flag === "yes");
}

/**
 * Start the periodic delta poll. Idempotent — re-calling is a no-op when
 * already running. Returns without scheduling anything when the env gate
 * is off (the common case in dev or until Drew registers a client_id).
 */
export function startChDeltaPollJob(): void {
  if (_running) return;
  if (!isEnabled()) {
    console.log("[ch-delta-poll] not started — CH_DELTA_POLL_ENABLED + CARD_HEDGE_CLIENT_ID required");
    return;
  }
  _running = true;
  const intervalMs = readIntervalMs();
  console.log(`[ch-delta-poll] starting — interval ${intervalMs / 60000}min, first run in ${DEFAULT_FIRST_DELAY_MS / 1000}s`);
  _firstRunTimer = setTimeout(async () => {
    try { await runDeltaPollCycle(); } catch (e: any) {
      console.warn(`[ch-delta-poll] first cycle failed: ${e?.message ?? e}`);
    }
    _intervalTimer = setInterval(async () => {
      try { await runDeltaPollCycle(); } catch (e: any) {
        console.warn(`[ch-delta-poll] cycle failed: ${e?.message ?? e}`);
      }
    }, intervalMs);
  }, DEFAULT_FIRST_DELAY_MS);
}

/** Stop the periodic delta poll. Used by tests + clean shutdown. */
export function stopChDeltaPollJob(): void {
  if (_firstRunTimer) { clearTimeout(_firstRunTimer); _firstRunTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
  _running = false;
}

/** Test-only: clear in-memory state so suites can re-init. */
export function _resetChDeltaPollForTests(): void {
  stopChDeltaPollJob();
}
