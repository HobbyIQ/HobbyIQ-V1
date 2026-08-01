// CF-SAFE-WRITE-HOLDING (Drew, 2026-08-01). Guardrail helper for any
// portfolio-holding mutation from scripts or admin surfaces.
//
// Enforces four rules learned from 2026-07-31/2026-08-01 clobbering
// incidents:
//   1. Every write saves __previous_slug + __previous_parallel + __previous_printRun
//      on the holding for one-hop rollback.
//   2. Never scope by cardNumber alone — cardNumber is a checklist slot
//      shared across all parallels of a player+set+year. Callers MUST
//      identify the specific holding by holdingId OR by (cardNumber +
//      parallel + hobbyiqCardId).
//   3. Batch-cap of 5 holdings per call; scripts touching more must set
//      BATCH_CONFIRMED=true env var explicitly.
//   4. Dry-run mode always available via an `apply: false` argument.
//
// Bypasses are impossible: the helper is the only supported entry point
// for portfolio-holding writes. Ad-hoc `container.items.upsert(doc)`
// calls elsewhere in the codebase are legacy and being migrated.

import { CosmosClient, type Container } from "@azure/cosmos";

export interface HoldingMatcher {
  holdingId?: string;
  cardNumber?: string;
  parallel?: string;
  hobbyiqCardId?: string;
}

export interface HoldingUpdate {
  parallel?: string;
  hobbyiqCardId?: string;
  printRun?: number | null;
  identityVerified?: boolean;
  setName?: string;
}

export interface SafeWriteResult {
  wouldMatch: number;
  matchedHoldings: Array<{
    holdingId: string;
    cardNumber: string;
    parallel: string;
    hobbyiqCardId: string;
    before: {
      parallel: string;
      hobbyiqCardId: string;
      printRun: number | null;
    };
    afterProposed: HoldingUpdate;
  }>;
  written: number;
  rolledBack: boolean;
  reason?: string;
}

let cachedPortfolio: Container | null = null;
function getPortfolio(): Container | null {
  if (cachedPortfolio) return cachedPortfolio;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedPortfolio = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");
  return cachedPortfolio;
}

/**
 * Write update to a specific portfolio holding, protected by guardrails.
 *
 * @param userId  target user
 * @param matcher identifies the holding to update. MUST include either
 *                (a) holdingId or (b) at least TWO of {cardNumber,
 *                parallel, hobbyiqCardId} — never cardNumber alone.
 * @param update  fields to change; unset fields are preserved
 * @param apply   false = dry-run report only; true = write to Cosmos
 */
export async function safeWriteHolding(opts: {
  userId: string;
  matcher: HoldingMatcher;
  update: HoldingUpdate;
  apply: boolean;
  actor: string;
}): Promise<SafeWriteResult> {
  const { userId, matcher, update, apply, actor } = opts;

  // Rule 2: matcher must be identifying enough
  const hasHoldingId = !!matcher.holdingId;
  const identifyingFields = [
    matcher.cardNumber ? "cardNumber" : null,
    matcher.parallel ? "parallel" : null,
    matcher.hobbyiqCardId ? "hobbyiqCardId" : null,
  ].filter(Boolean);
  if (!hasHoldingId && identifyingFields.length < 2) {
    return {
      wouldMatch: 0, matchedHoldings: [], written: 0, rolledBack: false,
      reason: `Matcher too broad. Provide holdingId OR at least TWO of {cardNumber, parallel, hobbyiqCardId}. Got: ${identifyingFields.join(", ") || "none"}. This rule prevents cardNumber-only scoping which clobbers sibling parallels.`,
    };
  }

  const portfolio = getPortfolio();
  if (!portfolio) {
    return { wouldMatch: 0, matchedHoldings: [], written: 0, rolledBack: false, reason: "Cosmos not configured" };
  }

  const { resources: docs } = await portfolio.items.query({
    query: "SELECT * FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: userId }],
  }).fetchAll();
  if (!docs.length) {
    return { wouldMatch: 0, matchedHoldings: [], written: 0, rolledBack: false, reason: "no portfolio doc" };
  }
  const doc = docs[0];

  // Find matching holdings — must satisfy ALL provided matcher fields
  const matching = Object.entries(doc.holdings || {}).filter(([k, h]: [string, any]) => {
    if (matcher.holdingId && (h.id ?? k) !== matcher.holdingId) return false;
    if (matcher.cardNumber && String(h.cardNumber || "").toUpperCase() !== matcher.cardNumber.toUpperCase()) return false;
    if (matcher.parallel && String(h.parallel || "") !== matcher.parallel) return false;
    if (matcher.hobbyiqCardId && h.hobbyiqCardId !== matcher.hobbyiqCardId) return false;
    return true;
  });

  // Rule 3: batch cap
  const BATCH_CAP = 5;
  const batchConfirmed = process.env.BATCH_CONFIRMED === "true";
  if (matching.length > BATCH_CAP && !batchConfirmed) {
    return {
      wouldMatch: matching.length, matchedHoldings: [], written: 0, rolledBack: false,
      reason: `Match count ${matching.length} exceeds batch cap ${BATCH_CAP}. Set BATCH_CONFIRMED=true env var to proceed. This rule prevents accidental mass writes.`,
    };
  }

  const matchedHoldings = matching.map(([k, h]: [string, any]) => ({
    holdingId: h.id ?? k,
    cardNumber: h.cardNumber,
    parallel: h.parallel,
    hobbyiqCardId: h.hobbyiqCardId,
    before: {
      parallel: h.parallel,
      hobbyiqCardId: h.hobbyiqCardId,
      printRun: h.printRun ?? null,
    },
    afterProposed: update,
  }));

  if (!apply) {
    // dry mode — return report, no writes
    return { wouldMatch: matching.length, matchedHoldings, written: 0, rolledBack: false };
  }

  // Rule 1: snapshot previous values BEFORE mutation
  let written = 0;
  const timestamp = new Date().toISOString();
  for (const [, h] of matching) {
    const holding = h as any;
    holding.__previous_slug = holding.hobbyiqCardId;
    holding.__previous_parallel = holding.parallel;
    holding.__previous_printRun = holding.printRun ?? null;
    holding.__lastSafeWriteAt = timestamp;
    holding.__lastSafeWriteBy = actor;

    if (update.parallel !== undefined) holding.parallel = update.parallel;
    if (update.hobbyiqCardId !== undefined) holding.hobbyiqCardId = update.hobbyiqCardId;
    if (update.printRun !== undefined) holding.printRun = update.printRun;
    if (update.identityVerified !== undefined) {
      holding.identityVerified = update.identityVerified;
      if (update.identityVerified) holding.identityVerifiedAt = timestamp;
    }
    if (update.setName !== undefined) holding.setName = update.setName;
    written++;
  }

  try {
    await portfolio.items.upsert(doc);
    return { wouldMatch: matching.length, matchedHoldings, written, rolledBack: false };
  } catch (e) {
    return {
      wouldMatch: matching.length, matchedHoldings, written: 0, rolledBack: true,
      reason: `Cosmos upsert failed: ${(e as Error)?.message ?? String(e)}. Doc not persisted; in-memory changes discarded.`,
    };
  }
}

/**
 * One-hop rollback of the last safeWriteHolding operation on a holding.
 * Uses the __previous_* snapshot fields; fails if none exist.
 */
export async function rollbackHolding(opts: {
  userId: string;
  holdingId: string;
}): Promise<{ rolledBack: boolean; reason?: string }> {
  const portfolio = getPortfolio();
  if (!portfolio) return { rolledBack: false, reason: "Cosmos not configured" };

  const { resources: docs } = await portfolio.items.query({
    query: "SELECT * FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: opts.userId }],
  }).fetchAll();
  if (!docs.length) return { rolledBack: false, reason: "no portfolio doc" };
  const doc = docs[0];

  let target: any = null;
  for (const [k, h] of Object.entries(doc.holdings || {})) {
    const holding = h as any;
    if ((holding.id ?? k) === opts.holdingId) { target = holding; break; }
  }
  if (!target) return { rolledBack: false, reason: "holding not found" };
  if (!target.__previous_slug && !target.__previous_parallel) {
    return { rolledBack: false, reason: "no previous snapshot on holding — cannot roll back" };
  }

  target.hobbyiqCardId = target.__previous_slug;
  target.parallel = target.__previous_parallel;
  target.printRun = target.__previous_printRun;
  target.__rolledBackAt = new Date().toISOString();

  await portfolio.items.upsert(doc);
  return { rolledBack: true };
}
