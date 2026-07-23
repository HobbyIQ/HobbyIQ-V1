// CF-PERSIST-USER-QUERY-SIGNALS (Drew, 2026-07-23, issue #722 signals).
// Cross-user aggregate market signals. We do NOT persist user identity
// (userId → salt+hash only when a userId is present; anonymous when
// not). We persist the intent shape (what card was queried, when,
// through which endpoint). Enables "trending cards", "catalog gaps"
// (queries with 0 hits), and demand-side signals.
//
// Flag: PERSIST_USER_QUERY_SIGNALS_ENABLED (default OFF).
// Container: market_signals (partition /queryDay).
//
// Privacy: userId is one-way hashed via SHA-256(userId + daily-salt).
// Same user on the same day maps to the same anonymous key (for dedup);
// across days the key rotates.

import {
  getContainer,
  contentHashOf,
  runInBackground,
  logPersistEvent,
  isDomainEnabled,
} from "./vendorPersistenceCommon.service.js";
import { createHash } from "crypto";

export interface QuerySignal {
  endpoint: string;                // "cardsight.searchPricingByTitle" | "cardhedge.searchCards" | etc.
  query: string | null;            // raw query text
  cardId?: string | null;          // resolved cardId if the endpoint returned one
  hobbyiqCardId?: string | null;   // canonical slug if computable
  hitCount?: number;               // number of results returned (0 = catalog gap!)
  latencyMs?: number;
  userId?: string | null;          // will be hashed with daily salt
}

export interface QuerySignalPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;
}

export function isPersistUserQuerySignalsEnabled(): boolean {
  return isDomainEnabled("PERSIST_USER_QUERY_SIGNALS_ENABLED");
}

/** SHA-256 hash of userId + daily salt. Same user + same day = same
 *  anonymous key. Cross-day rotation prevents long-term correlation. */
function hashUserId(userId: string | null | undefined, day: string): string | null {
  if (!userId) return null;
  const salt = process.env.QUERY_SIGNAL_DAILY_SALT ?? "hobbyiq-default-rotating-salt";
  return createHash("sha256").update(`${userId}|${day}|${salt}`).digest("hex").slice(0, 24);
}

export async function persistUserQuerySignals(
  signals: QuerySignal[],
): Promise<QuerySignalPersistResult> {
  const result: QuerySignalPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistUserQuerySignalsEnabled()) return result;
  if (!Array.isArray(signals) || signals.length === 0) return result;
  const container = await getContainer("market_signals", "/queryDay");
  if (!container) return result;

  const queryDay = new Date().toISOString().slice(0, 10);
  for (const s of signals) {
    const endpoint = String(s.endpoint ?? "").trim();
    const query = String(s.query ?? "").trim();
    if (!endpoint) { result.skipped++; continue; }
    const hashedUser = hashUserId(s.userId ?? null, queryDay);
    const contentHash = contentHashOf(
      endpoint, query, s.cardId ?? "", s.hobbyiqCardId ?? "",
      hashedUser ?? "anon", queryDay,
    );
    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.queryDay = @d AND c.contentHash = @h",
        parameters: [{ name: "@d", value: queryDay }, { name: "@h", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }
      const doc = {
        id: `signal::${queryDay}::${contentHash.slice(0, 16)}`,
        queryDay,
        contentHash,
        endpoint,
        query,
        cardId: s.cardId ?? null,
        hobbyiqCardId: s.hobbyiqCardId ?? null,
        hitCount: s.hitCount ?? null,
        latencyMs: s.latencyMs ?? null,
        anonymousUserKey: hashedUser,
        observedAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      result.inserted++;
    } catch {
      result.skipped++;
    }
  }
  logPersistEvent("query_signals", "runtime", result);
  return result;
}

export function persistUserQuerySignalsInBackground(signals: QuerySignal[]): void {
  runInBackground(() => persistUserQuerySignals(signals).then(() => {}));
}
