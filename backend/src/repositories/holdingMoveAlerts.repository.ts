// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): Cosmos store of per-holding move
// rules + the per-user/day delivery counter that rate-limits them.
//
// Container: `compiq_holding_move_alerts`, partition `/userId` — the same
// shape as priceAlerts.repository / advancedAlertRules.repository so the
// evaluator reuses the existing Cosmos + APNs wiring with no bespoke plumbing.
// Every read degrades to empty and every write to a no-op when Cosmos is not
// configured, exactly as its two siblings do, so a local boot or a fresh
// deploy without the container never throws on the reprice path.
//
// Two document types share the container:
//   docType = "holding_move_rule"  — one per (user, holding) rule
//   docType = "holding_move_quota" — one per (user, UTC date), the daily count
//
// The quota row lives HERE rather than in memory because the rate limit has
// to hold across app-service instances and restarts: an in-process counter
// would let a two-instance deploy send twice the cap, and a restart would
// reset it to zero mid-day.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";
import type { HoldingMoveRule, MoveDirection } from "../services/advancedAlerts/holdingMoveRule.js";

interface HoldingMoveRuleDocument extends HoldingMoveRule {
  id: string;
  docType: "holding_move_rule";
}

interface HoldingMoveQuotaDocument {
  id: string;
  docType: "holding_move_quota";
  userId: string;
  /** UTC date, YYYY-MM-DD. */
  day: string;
  count: number;
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
      const containerName =
        process.env.COSMOS_HOLDING_MOVE_ALERTS_CONTAINER ?? "compiq_holding_move_alerts";

      if (!endpoint && !connStr) {
        console.warn(
          "[holdingMoveAlerts.repository] COSMOS not configured — repository disabled",
        );
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log(
        `[holdingMoveAlerts.repository] Cosmos container ready: ${dbName}/${containerName}`,
      );
      return container;
    } catch (err: any) {
      console.error("[holdingMoveAlerts.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

function toRule(doc: HoldingMoveRuleDocument): HoldingMoveRule {
  return {
    ruleId: doc.ruleId,
    userId: doc.userId,
    holdingId: doc.holdingId,
    thresholdPct: doc.thresholdPct,
    direction: doc.direction,
    windowHours: doc.windowHours,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt,
    lastFiredValue: doc.lastFiredValue ?? null,
    lastFiredRung: doc.lastFiredRung ?? null,
    lastFiredAt: doc.lastFiredAt ?? null,
    lastFiredFingerprint: doc.lastFiredFingerprint ?? null,
    triggerCount: doc.triggerCount ?? 0,
  };
}

// ─── Rule CRUD ──────────────────────────────────────────────────────────────

export async function listRulesForUser(userId: string): Promise<HoldingMoveRule[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<HoldingMoveRuleDocument>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'holding_move_rule' AND c.userId = @uid ORDER BY c.createdAt DESC",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    return resources.map(toRule);
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] listRulesForUser failed:", err?.message ?? err);
    return [];
  }
}

/**
 * Every active rule for a user, keyed by holdingId. This is the read the
 * reprice path makes — ONE query per user per reprice pass, not one per
 * holding, so a 300-holding portfolio costs a single round trip.
 */
export async function activeRulesByHolding(
  userId: string,
): Promise<Map<string, HoldingMoveRule>> {
  const out = new Map<string, HoldingMoveRule>();
  const container = await getContainer();
  if (!container) return out;
  try {
    const { resources } = await container.items
      .query<HoldingMoveRuleDocument>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'holding_move_rule' AND c.userId = @uid AND c.isActive = true",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    for (const doc of resources) out.set(doc.holdingId, toRule(doc));
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] activeRulesByHolding failed:", err?.message ?? err);
  }
  return out;
}

export async function getRuleForHolding(
  userId: string,
  holdingId: string,
): Promise<HoldingMoveRule | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resources } = await container.items
      .query<HoldingMoveRuleDocument>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'holding_move_rule' AND c.userId = @uid AND c.holdingId = @hid",
          parameters: [
            { name: "@uid", value: userId },
            { name: "@hid", value: holdingId },
          ],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    return resources.length ? toRule(resources[0]) : null;
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] getRuleForHolding failed:", err?.message ?? err);
    return null;
  }
}

export interface UpsertRuleInput {
  userId: string;
  holdingId: string;
  thresholdPct: number;
  direction: MoveDirection;
  windowHours: number;
  isActive?: boolean;
}

/**
 * One rule per (user, holding) — creating a second on the same holding
 * REPLACES the first. A holding with two competing move rules has no
 * coherent baseline (each fire would re-anchor the other), and the manage
 * surface offers one rule per card, so the storage layer enforces what the
 * UI already implies.
 */
export async function upsertRule(input: UpsertRuleInput): Promise<HoldingMoveRule | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date().toISOString();
  try {
    const existing = await getRuleForHolding(input.userId, input.holdingId);
    if (existing) {
      const { resource: raw } = await container
        .item(existing.ruleId, input.userId)
        .read<HoldingMoveRuleDocument>();
      if (raw) {
        const next: HoldingMoveRuleDocument = {
          ...raw,
          thresholdPct: input.thresholdPct,
          direction: input.direction,
          windowHours: input.windowHours,
          isActive: input.isActive !== false,
        };
        const { resource } = await container
          .item(existing.ruleId, input.userId)
          .replace<HoldingMoveRuleDocument>(next);
        return resource ? toRule(resource) : toRule(next);
      }
    }
    const ruleId = randomUUID();
    const doc: HoldingMoveRuleDocument = {
      id: ruleId,
      docType: "holding_move_rule",
      ruleId,
      userId: input.userId,
      holdingId: input.holdingId,
      thresholdPct: input.thresholdPct,
      direction: input.direction,
      windowHours: input.windowHours,
      isActive: input.isActive !== false,
      createdAt: now,
      lastFiredValue: null,
      lastFiredRung: null,
      lastFiredAt: null,
      lastFiredFingerprint: null,
      triggerCount: 0,
    };
    const { resource } = await container.items.create<HoldingMoveRuleDocument>(doc);
    return resource ? toRule(resource) : toRule(doc);
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] upsertRule failed:", err?.message ?? err);
    return null;
  }
}

export async function deleteRule(userId: string, ruleId: string): Promise<boolean> {
  const container = await getContainer();
  if (!container) return false;
  try {
    await container.item(ruleId, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return false;
    console.error("[holdingMoveAlerts.repository] deleteRule failed:", err?.message ?? err);
    return false;
  }
}

/** CF-ACCOUNT-DELETION parity: purge every move rule + quota row for a user. */
export async function deleteAllForUser(userId: string): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  let deleted = 0;
  try {
    const { resources } = await container.items
      .query<{ id: string }>(
        {
          query: "SELECT c.id FROM c WHERE c.userId = @uid",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    for (const r of resources) {
      try {
        await container.item(r.id, userId).delete();
        deleted += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[holdingMoveAlerts.repository] deleteAllForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] deleteAllForUser failed:", err?.message ?? err);
  }
  return deleted;
}

/**
 * Persist a fire: the quoted value becomes the next baseline, the
 * fingerprint becomes the duplicate guard. Called ONLY after the alert has
 * actually been recorded/sent, so a failed delivery does not silently move
 * the baseline past a move the user was never told about.
 */
export async function recordFire(
  userId: string,
  ruleId: string,
  patch: { firedValue: number; firedRung: string | null; fingerprint: string; firedAt?: string },
): Promise<HoldingMoveRule | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource: existing } = await container
      .item(ruleId, userId)
      .read<HoldingMoveRuleDocument>();
    if (!existing) return null;
    const next: HoldingMoveRuleDocument = {
      ...existing,
      lastFiredValue: patch.firedValue,
      lastFiredRung: patch.firedRung,
      lastFiredAt: patch.firedAt ?? new Date().toISOString(),
      lastFiredFingerprint: patch.fingerprint,
      triggerCount: (existing.triggerCount ?? 0) + 1,
    };
    const { resource } = await container
      .item(ruleId, userId)
      .replace<HoldingMoveRuleDocument>(next);
    return resource ? toRule(resource) : toRule(next);
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] recordFire failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Re-baseline WITHOUT firing. Used when the window gate finds the baseline
 * stale: the old anchor is no longer evidence of a recent move, so it is
 * replaced by the current observation and the clock starts again. No
 * triggerCount bump, no fingerprint — nothing was delivered.
 */
export async function rebaseline(
  userId: string,
  ruleId: string,
  value: number,
  rung: string | null,
  at?: string,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  try {
    const { resource: existing } = await container
      .item(ruleId, userId)
      .read<HoldingMoveRuleDocument>();
    if (!existing) return;
    const next: HoldingMoveRuleDocument = {
      ...existing,
      lastFiredValue: value,
      lastFiredRung: rung,
      lastFiredAt: at ?? new Date().toISOString(),
    };
    await container.item(ruleId, userId).replace<HoldingMoveRuleDocument>(next);
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] rebaseline failed:", err?.message ?? err);
  }
}

// ─── Daily quota ────────────────────────────────────────────────────────────

export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function quotaId(userId: string, day: string): string {
  return `quota::${userId}::${day}`;
}

/** How many move alerts this user has been sent today (UTC). */
export async function getDailyCount(userId: string, day: string = utcDay()): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  try {
    const { resource } = await container
      .item(quotaId(userId, day), userId)
      .read<HoldingMoveQuotaDocument>();
    return Number(resource?.count ?? 0);
  } catch (err: any) {
    if (err?.code === 404) return 0;
    console.error("[holdingMoveAlerts.repository] getDailyCount failed:", err?.message ?? err);
    return 0;
  }
}

/**
 * Increment today's counter and return the new value.
 *
 * Read-modify-write: two instances firing in the same instant can both read
 * N and write N+1, so the cap is best-effort under exact concurrency. That
 * is the right trade here — the alternative (a stored procedure or an ETag
 * retry loop on the reprice hot path) costs RU and latency on every fire to
 * defend a soft courtesy limit whose failure mode is one extra push. The
 * counter is authoritative enough to stop a runaway, which is its job.
 */
export async function incrementDailyCount(
  userId: string,
  day: string = utcDay(),
): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  const id = quotaId(userId, day);
  const now = new Date().toISOString();
  try {
    const { resource: existing } = await container
      .item(id, userId)
      .read<HoldingMoveQuotaDocument>()
      .catch(() => ({ resource: undefined }) as { resource: HoldingMoveQuotaDocument | undefined });
    const count = Number(existing?.count ?? 0) + 1;
    const doc: HoldingMoveQuotaDocument = {
      id,
      docType: "holding_move_quota",
      userId,
      day,
      count,
      updatedAt: now,
    };
    await container.items.upsert<HoldingMoveQuotaDocument>(doc);
    return count;
  } catch (err: any) {
    console.error("[holdingMoveAlerts.repository] incrementDailyCount failed:", err?.message ?? err);
    return 0;
  }
}
