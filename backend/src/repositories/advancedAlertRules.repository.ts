// CF-ADVANCED-ALERTS (2026-06-03): Cosmos store of per-user advanced
// alert rules. Container: `compiq_advanced_alert_rules`, partition `/userId`.
//
// A rule = (scope, combinator, conditions[], cooldownMin, isActive). The
// shape mirrors `priceAlerts.repository.ts` deliberately so the scheduled
// evaluator can reuse the same Cosmos pattern + APNs notification path
// without bespoke wiring.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";
import type { TrendIQCoverage } from "../services/compiq/trendIQ.types.js";

// ─── Rule type model ────────────────────────────────────────────────────────

export type AdvancedAlertScope =
  | {
      type: "card";
      cardId: string;
      gradeCompany?: string;
      gradeValue?: number;
    }
  | {
      type: "player";
      playerName: string;
      gradeCompany?: string;
      gradeValue?: number;
    }
  | { type: "watchlist" }
  | { type: "holdings" };

export type AdvancedAlertCondition =
  | { kind: "predicted_direction"; equals: "up" | "down" }
  | { kind: "predicted_pct_move"; op: "gte" | "lte"; value: number }
  | { kind: "trendiq_composite"; op: "gte" | "lte"; value: number }
  | { kind: "trendiq_coverage_min"; value: TrendIQCoverage }
  | { kind: "confidence_min"; value: number }
  | { kind: "price_crosses"; op: "above" | "below"; value: number }
  | { kind: "predicted_price_crosses"; op: "above" | "below"; value: number };

export type AdvancedAlertCombinator = "AND" | "OR";

export interface AdvancedAlertRule {
  ruleId: string;
  userId: string;
  name: string;
  scope: AdvancedAlertScope;
  combinator: AdvancedAlertCombinator;
  conditions: AdvancedAlertCondition[];
  cooldownMin: number;
  isActive: boolean;
  createdAt: string;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
}

interface AdvancedAlertRuleDocument extends AdvancedAlertRule {
  id: string;
  docType: "advanced_alert_rule";
}

// ─── Container init (shared pattern with priceAlerts.repository) ────────────

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
        process.env.COSMOS_ADVANCED_ALERTS_CONTAINER ?? "compiq_advanced_alert_rules";

      if (!endpoint && !connStr) {
        console.warn(
          "[advancedAlertRules.repository] COSMOS not configured — repository disabled",
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
        `[advancedAlertRules.repository] Cosmos container ready: ${dbName}/${containerName}`,
      );
      return container;
    } catch (err: any) {
      console.error(
        "[advancedAlertRules.repository] init failed:",
        err?.message ?? err,
      );
      return null;
    }
  })();
  return _initPromise;
}

function toRule(doc: AdvancedAlertRuleDocument): AdvancedAlertRule {
  return {
    ruleId: doc.ruleId,
    userId: doc.userId,
    name: doc.name,
    scope: doc.scope,
    combinator: doc.combinator,
    conditions: doc.conditions,
    cooldownMin: doc.cooldownMin,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt,
    lastEvaluatedAt: doc.lastEvaluatedAt ?? null,
    lastTriggeredAt: doc.lastTriggeredAt ?? null,
    triggerCount: doc.triggerCount ?? 0,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listRulesForUser(userId: string): Promise<AdvancedAlertRule[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<AdvancedAlertRuleDocument>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'advanced_alert_rule' AND c.userId = @uid ORDER BY c.createdAt DESC",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    return resources.map(toRule);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] listRulesForUser failed:",
      err?.message ?? err,
    );
    return [];
  }
}

export async function getRuleForUser(
  userId: string,
  ruleId: string,
): Promise<AdvancedAlertRule | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container
      .item(ruleId, userId)
      .read<AdvancedAlertRuleDocument>();
    return resource ? toRule(resource) : null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error(
      "[advancedAlertRules.repository] getRuleForUser failed:",
      err?.message ?? err,
    );
    return null;
  }
}

export interface CreateAdvancedAlertRuleInput {
  userId: string;
  name: string;
  scope: AdvancedAlertScope;
  combinator: AdvancedAlertCombinator;
  conditions: AdvancedAlertCondition[];
  cooldownMin: number;
  isActive?: boolean;
}

export async function createRule(
  input: CreateAdvancedAlertRuleInput,
): Promise<AdvancedAlertRule | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date().toISOString();
  const ruleId = randomUUID();
  const doc: AdvancedAlertRuleDocument = {
    id: ruleId,
    docType: "advanced_alert_rule",
    ruleId,
    userId: input.userId,
    name: input.name,
    scope: input.scope,
    combinator: input.combinator,
    conditions: input.conditions,
    cooldownMin: input.cooldownMin,
    isActive: input.isActive !== false,
    createdAt: now,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
  };
  try {
    const { resource } = await container.items.create<AdvancedAlertRuleDocument>(doc);
    return resource ? toRule(resource) : toRule(doc);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] createRule failed:",
      err?.message ?? err,
    );
    return null;
  }
}

export interface UpdateAdvancedAlertRulePatch {
  name?: string;
  scope?: AdvancedAlertScope;
  combinator?: AdvancedAlertCombinator;
  conditions?: AdvancedAlertCondition[];
  cooldownMin?: number;
  isActive?: boolean;
}

export async function updateRule(
  userId: string,
  ruleId: string,
  patch: UpdateAdvancedAlertRulePatch,
): Promise<AdvancedAlertRule | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource: existing } = await container
      .item(ruleId, userId)
      .read<AdvancedAlertRuleDocument>();
    if (!existing) return null;
    const next: AdvancedAlertRuleDocument = {
      ...existing,
      name: patch.name ?? existing.name,
      scope: patch.scope ?? existing.scope,
      combinator: patch.combinator ?? existing.combinator,
      conditions: patch.conditions ?? existing.conditions,
      cooldownMin: patch.cooldownMin ?? existing.cooldownMin,
      isActive: patch.isActive ?? existing.isActive,
    };
    const { resource } = await container
      .item(ruleId, userId)
      .replace<AdvancedAlertRuleDocument>(next);
    return resource ? toRule(resource) : toRule(next);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] updateRule failed:",
      err?.message ?? err,
    );
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
    console.error(
      "[advancedAlertRules.repository] deleteRule failed:",
      err?.message ?? err,
    );
    return false;
  }
}

/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge all advanced rules for a user.
 */
export async function deleteAllRulesForUser(userId: string): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  let deleted = 0;
  try {
    const rules = await listRulesForUser(userId);
    for (const r of rules) {
      try {
        await container.item(r.ruleId, userId).delete();
        deleted += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[advancedAlertRules.repository] deleteAllRulesForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[advancedAlertRules.repository] deleteAllRulesForUser failed:", err?.message ?? err);
  }
  return deleted;
}

/**
 * Record an evaluator pass. Always bumps `lastEvaluatedAt`; bumps
 * `lastTriggeredAt` + `triggerCount` only when `triggered=true`.
 *
 * The cooldown gate lives at the evaluator layer (see ruleEvaluator.ts), NOT
 * here — this writer is intentionally dumb so the caller is the source of
 * truth for "did we actually fire". `isActive` is preserved unless the
 * caller explicitly sets it elsewhere.
 */
export interface RuleEvaluationPatch {
  triggered: boolean;
  triggeredAt?: string | null;
}

export async function recordRuleEvaluation(
  userId: string,
  ruleId: string,
  patch: RuleEvaluationPatch,
): Promise<AdvancedAlertRule | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource: existing } = await container
      .item(ruleId, userId)
      .read<AdvancedAlertRuleDocument>();
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: AdvancedAlertRuleDocument = {
      ...existing,
      lastEvaluatedAt: now,
      lastTriggeredAt: patch.triggered
        ? patch.triggeredAt ?? now
        : existing.lastTriggeredAt ?? null,
      triggerCount: patch.triggered
        ? (existing.triggerCount ?? 0) + 1
        : existing.triggerCount ?? 0,
    };
    const { resource } = await container
      .item(ruleId, userId)
      .replace<AdvancedAlertRuleDocument>(next);
    return resource ? toRule(resource) : toRule(next);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] recordRuleEvaluation failed:",
      err?.message ?? err,
    );
    return null;
  }
}

/**
 * Cross-partition scan for every active advanced rule. Used by the
 * scheduled evaluator pass.
 */
export async function listAllActiveRules(): Promise<AdvancedAlertRule[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<AdvancedAlertRuleDocument>({
        query:
          "SELECT * FROM c WHERE c.docType = 'advanced_alert_rule' AND c.isActive = true",
      })
      .fetchAll();
    return resources.map(toRule);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] listAllActiveRules failed:",
      err?.message ?? err,
    );
    return [];
  }
}

/** Active-rule count per user — feeds the shared `priceAlerts` capacity. */
export async function countActiveRulesForUser(userId: string): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  try {
    const { resources } = await container.items
      .query<{ n: number }>(
        {
          query:
            "SELECT VALUE COUNT(1) FROM c WHERE c.docType = 'advanced_alert_rule' AND c.userId = @uid AND c.isActive = true",
          parameters: [{ name: "@uid", value: userId }],
        },
        { partitionKey: userId },
      )
      .fetchAll();
    return Number(resources?.[0] ?? 0);
  } catch (err: any) {
    console.error(
      "[advancedAlertRules.repository] countActiveRulesForUser failed:",
      err?.message ?? err,
    );
    return 0;
  }
}
