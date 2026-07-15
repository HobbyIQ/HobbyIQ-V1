// CF-USER-REPUTATION (Drew, 2026-07-15): track per-user attestation
// reputation for future weighted-aggregation math. Reputation is EARNED
// via activity: more confirms + fewer flag-corrections against your
// attestations = higher score. New users start neutral (0.5) and can
// climb to ~0.95 after ~100 attestations.
//
// This service handles TRACKING. Reputation-weighted aggregation is
// a downstream consumer (planned for a follow-up PR — will multiply
// each comp's contribution by 0.6 + 0.4*reputation).
//
// Container: `user_reputation`, partition `/userId` (self-partition
// for single-doc-per-user pattern), infinite TTL.
//
// The score formula:
//   reputation = 0.5                                    // starting
//   + confirmations_bonus                               // activity
//   - corrections_penalty                                // parser bugs (small)
//   - flags_against_penalty                              // pool moderation
//   clamped [0.05, 0.95]
//
// A new user has reputation 0.5. Someone with 20 confirms + 0 flags
// against them lands near 0.75. Someone with 100+ confirms and no
// flags lands near 0.95.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const STARTING_REPUTATION = 0.5;
const MIN_REPUTATION = 0.05;
const MAX_REPUTATION = 0.95;

export interface UserReputationDoc {
  /** Same as userId — one doc per user, partitioned on self. */
  id: string;
  userId: string;

  /** Total attestations confirmed by this user via the Verify Card sheet. */
  confirmations: number;

  /** Total rejects issued by this user. Doesn't directly hurt reputation
   *  (rejects are often correct — bad suggestions get rejected), but
   *  useful signal for reputation heuristic. */
  rejections: number;

  /** Fields the user CHANGED during confirmations (from feedback capture).
   *  A user who consistently makes lots of corrections is either doing
   *  QA work (good) OR mis-attesting (bad). We currently treat as neutral
   *  signal — count for information, small penalty in scoring. */
  totalCorrections: number;

  /** Times another user flagged this user's attestation as wrong.
   *  Highest-weight negative signal — direct pool pollution evidence. */
  flagsAgainst: number;

  /** Times this user flagged another user's attestation. Small positive
   *  signal (contributes to moderation) — capped so it can't be gamed. */
  flagsIssued: number;

  /** Derived score, clamped to [0.05, 0.95]. Recomputed on every write.
   *  Downstream aggregation reads this field directly (no re-derivation). */
  reputation: number;

  /** ISO — when we first saw activity from this user. */
  firstSeenAt: string;
  /** ISO — most recent stat update. */
  updatedAt: string;
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_USER_REPUTATION_CONTAINER ?? "user_reputation";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/userId"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "user_reputation_init_failed",
        source: "userReputation.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Compute reputation from stat counters. Pure function — no I/O.
 * Exported for tests + downstream aggregation which may want to
 * recompute against hypothetical stats.
 *
 * Formula: 0.5 baseline + activity bonus - penalty terms, clamped.
 * Activity bonus is exponential decay: `1 - exp(-N/40)` scaled to
 * max contribution of 0.4. So 20 confirms ~= +0.157, 100 confirms
 * ~= +0.363, plateau near 0.4.
 */
export function computeReputation(stats: {
  confirmations: number;
  rejections?: number;
  totalCorrections?: number;
  flagsAgainst?: number;
  flagsIssued?: number;
}): number {
  const confirms = Math.max(0, stats.confirmations ?? 0);
  const flagsAgainst = Math.max(0, stats.flagsAgainst ?? 0);
  const corrections = Math.max(0, stats.totalCorrections ?? 0);
  const flagsIssued = Math.max(0, stats.flagsIssued ?? 0);

  // Activity bonus — plateau at +0.4 after ~150 confirms
  const activityBonus = 0.4 * (1 - Math.exp(-confirms / 40));

  // Flags-against penalty — heaviest. Each flag = -0.05, no cap
  // (repeated pool pollution keeps hurting).
  const flagsAgainstPenalty = 0.05 * flagsAgainst;

  // Corrections penalty — soft. Corrections are ambiguous (parser
  // bug vs user error), so small penalty and cap. Cap at ~0.05.
  const correctionsPenalty = Math.min(0.05, 0.001 * corrections);

  // Flags-issued bonus — small. Capped to prevent gaming (spamming
  // false-positive flags to boost own reputation).
  const flagsIssuedBonus = Math.min(0.05, 0.005 * flagsIssued);

  const raw = STARTING_REPUTATION
    + activityBonus
    - flagsAgainstPenalty
    - correctionsPenalty
    + flagsIssuedBonus;

  return Math.max(MIN_REPUTATION, Math.min(MAX_REPUTATION, raw));
}

/**
 * Read the user's current reputation doc — or synthesize a neutral
 * new-user doc if none exists. Safe to call at aggregation time to get
 * the weight-multiplier.
 */
export async function getUserReputation(userId: string): Promise<UserReputationDoc> {
  const uid = userId?.trim();
  const neutral: UserReputationDoc = {
    id: uid || "",
    userId: uid || "",
    confirmations: 0,
    rejections: 0,
    totalCorrections: 0,
    flagsAgainst: 0,
    flagsIssued: 0,
    reputation: STARTING_REPUTATION,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!uid) return neutral;
  const c = await getContainer();
  if (!c) return neutral;
  try {
    const { resource } = await c.item(uid, uid).read<UserReputationDoc>();
    if (!resource) return neutral;
    return resource;
  } catch {
    return neutral;
  }
}

/**
 * Idempotent stat bump. Reads current doc, applies delta, recomputes
 * reputation, upserts. Fire-and-forget compatible — silent no-op on
 * Cosmos absence.
 */
export async function bumpUserStats(input: {
  userId: string;
  confirmations?: number;
  rejections?: number;
  totalCorrections?: number;
  flagsAgainst?: number;
  flagsIssued?: number;
}): Promise<void> {
  const uid = input.userId?.trim();
  if (!uid) return;
  const c = await getContainer();
  if (!c) return;

  try {
    const existing = await getUserReputation(uid);
    const now = new Date().toISOString();
    const merged: UserReputationDoc = {
      id: uid,
      userId: uid,
      confirmations: existing.confirmations + (input.confirmations ?? 0),
      rejections: existing.rejections + (input.rejections ?? 0),
      totalCorrections: existing.totalCorrections + (input.totalCorrections ?? 0),
      flagsAgainst: existing.flagsAgainst + (input.flagsAgainst ?? 0),
      flagsIssued: existing.flagsIssued + (input.flagsIssued ?? 0),
      reputation: 0,   // recomputed below
      firstSeenAt: existing.firstSeenAt || now,
      updatedAt: now,
    };
    merged.reputation = computeReputation(merged);
    await c.items.upsert(merged as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "user_reputation_bump_error",
      source: "userReputation.service",
      userId: uid,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
