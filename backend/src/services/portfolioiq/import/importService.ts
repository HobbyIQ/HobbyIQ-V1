// CF-IMPORT-BE (2026-06-21) — preview + commit service.
//
// Preview is read-only: parse → resolve → bucket per-row → return envelopes.
// Commit consumes confirmed envelopes + user actions, writes via the
// existing addHolding/updateHolding paths. Idempotency token prevents
// double-ingest on retried commits (the bulk-import scenario where a
// double-tap could create a mass-dupe event).

import {
  parseHoldingsFile,
  type FileFormat,
  type FileParseResult,
} from "./fileParser.js";
import {
  resolveBatch,
  type ImportRowEnvelope,
  type NormalizedHoldingPayload,
  type ImportBucket,
} from "./resolveBatch.js";
import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";
import { readUserDoc, writeUserDoc } from "../portfolioStore.service.js";

/** Minimal UserDoc shape we touch (the real type lives inside portfolioStore as an internal interface). */
interface UserDocShape {
  holdings: Record<string, PortfolioHolding>;
}

// CF-IMPORT-BE inlined helpers (mirrors portfolioStore conventions —
// not exported from there, but duplication is cheaper than refactoring
// the store for one consumer).
function holdingsCapFor(tier: string): number | null {
  // Free=25, collector=250, investor+=unlimited (null).
  // Matches src/config/entitlements.ts:81 / :90 + the comment at
  // src/routes/portfolioiq.routes.ts:148.
  const t = tier.toLowerCase();
  if (t === "free") return 25;
  if (t === "collector") return 250;
  return null; // investor / pro / etc. — unlimited
}

function normalizeId(id: string | undefined | null): string {
  // CF-D1 contract: stored holding keys are lowercase.
  return String(id ?? "").trim().toLowerCase();
}

export interface PreviewSummary {
  totalRows: number;
  isRoundTrip: boolean;
  bucketCounts: Record<ImportBucket, number>;
  /** Suggested commit count assuming default actions on each envelope. */
  defaultCommitCount: number;
  /** Whether projected post-import count would exceed the user's holdingsCap. */
  capacityProjection: {
    currentCount: number;
    incomingDeltaWithDefaults: number;
    projectedTotal: number;
    cap: number | null; // null for unlimited (investor+)
    wouldExceed: boolean;
  };
}

export interface PreviewResult {
  summary: PreviewSummary;
  envelopes: ImportRowEnvelope[];
  unmappedHeaders: string[];
  /** Auto-map proposal — user can override before commit. */
  proposedMapping: Record<string, string | null>;
}

export type CommitAction = "commit" | "skip" | "add-as-copy" | "update-cost";

export interface CommitRequest {
  idempotencyToken: string;
  envelopes: ReadonlyArray<ImportRowEnvelope>;
  /** Action per rowNumber. Missing rowNumbers default to "skip". */
  actions?: Record<number, CommitAction>;
}

export interface CommitOutcome {
  rowNumber: number;
  action: CommitAction;
  outcome: "added" | "updated" | "skipped" | "failed";
  holdingId?: string;
  reason?: string;
}

export interface CommitResult {
  idempotencyToken: string;
  cached: boolean;
  outcomes: CommitOutcome[];
  totals: {
    added: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}

/**
 * Preview: read-only orchestration. NO writes.
 */
export async function buildPreview(
  userId: string,
  fileBuffer: Buffer | string,
  format: FileFormat,
  userTier: string,
): Promise<PreviewResult> {
  const parsed: FileParseResult = parseHoldingsFile(fileBuffer, format);

  const doc = await readUserDoc(userId);
  const envelopes = await resolveBatch(parsed.rows, {
    isRoundTrip: parsed.isRoundTrip,
    existingHoldings: doc.holdings ?? {},
  });

  // Bucket counts
  const bucketCounts: Record<ImportBucket, number> = {
    "resolved-clean": 0,
    "resolved-collision": 0,
    "ambiguous": 0,
    "unresolved": 0,
    "identity-edited": 0,
  };
  let defaultCommitCount = 0;
  for (const env of envelopes) {
    bucketCounts[env.bucket] = (bucketCounts[env.bucket] ?? 0) + 1;
    // Default-commit logic: clean rows commit; collision/edited/unresolved/ambiguous default to skip
    if (env.bucket === "resolved-clean") defaultCommitCount += 1;
  }

  // Capacity projection
  const currentCount = Object.keys(doc.holdings ?? {}).length;
  const cap = holdingsCapFor(userTier);
  const incomingDelta = defaultCommitCount;
  const projectedTotal = currentCount + incomingDelta;
  const wouldExceed = cap !== null && projectedTotal > cap;

  return {
    summary: {
      totalRows: parsed.totalRows,
      isRoundTrip: parsed.isRoundTrip,
      bucketCounts,
      defaultCommitCount,
      capacityProjection: {
        currentCount,
        incomingDeltaWithDefaults: incomingDelta,
        projectedTotal,
        cap,
        wouldExceed,
      },
    },
    envelopes,
    unmappedHeaders: parsed.autoMap.unmapped,
    proposedMapping: parsed.autoMap.mapping,
  };
}

/**
 * Commit: writes confirmed envelopes. Idempotency-token-gated so a
 * retried commit doesn't double-ingest a bulk import.
 */
export async function commitImport(
  userId: string,
  request: CommitRequest,
): Promise<CommitResult> {
  const doc = await readUserDoc(userId);

  // Idempotency check: if we've seen this token in the user's recent
  // import-commit log, return the cached result rather than re-applying.
  const recentTokens = (doc as unknown as { importCommits?: Array<{ token: string; result: CommitResult }> }).importCommits ?? [];
  const prior = recentTokens.find((t) => t.token === request.idempotencyToken);
  if (prior) {
    return { ...prior.result, cached: true };
  }

  const actions = request.actions ?? {};
  const outcomes: CommitOutcome[] = [];

  for (const env of request.envelopes) {
    const action = actions[env.rowNumber] ?? defaultActionFor(env);
    const result = await applyAction(doc, env, action);
    outcomes.push(result);
  }

  // Persist with idempotency log
  const totals = {
    added: outcomes.filter((o) => o.outcome === "added").length,
    updated: outcomes.filter((o) => o.outcome === "updated").length,
    skipped: outcomes.filter((o) => o.outcome === "skipped").length,
    failed: outcomes.filter((o) => o.outcome === "failed").length,
  };
  const result: CommitResult = {
    idempotencyToken: request.idempotencyToken,
    cached: false,
    outcomes,
    totals,
  };

  // Append to import-commit log (keep last 50)
  const updatedLog = [
    ...recentTokens,
    { token: request.idempotencyToken, result },
  ].slice(-50);
  (doc as unknown as { importCommits?: typeof updatedLog }).importCommits = updatedLog;

  await writeUserDoc(userId, doc);

  return result;
}

function defaultActionFor(env: ImportRowEnvelope): CommitAction {
  switch (env.bucket) {
    case "resolved-clean":
      return "commit";
    case "resolved-collision":
      return env.collision?.defaultAction ?? "skip";
    case "ambiguous":
    case "unresolved":
    case "identity-edited":
      return "skip";
  }
}

async function applyAction(
  doc: UserDocShape,
  env: ImportRowEnvelope,
  action: CommitAction,
): Promise<CommitOutcome> {
  try {
    if (action === "skip") {
      return { rowNumber: env.rowNumber, action, outcome: "skipped" };
    }
    if (env.lane === "update" && action === "commit") {
      // Metadata-only update on existing holdingId
      const hid = env.existingHoldingId!;
      const existing = doc.holdings[hid];
      if (!existing) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "existing holding not found" };
      }
      doc.holdings[hid] = mergePayload(existing, env.payload);
      return { rowNumber: env.rowNumber, action, outcome: "updated", holdingId: hid };
    }
    if (action === "update-cost") {
      // Update only acquisition columns on the colliding existing holding(s)
      const targetHid = env.collision?.existingHoldingIds[0] ?? env.existingHoldingId;
      if (!targetHid) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "no target holding for update-cost" };
      }
      const existing = doc.holdings[targetHid];
      if (!existing) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "target holding missing" };
      }
      doc.holdings[targetHid] = {
        ...existing,
        purchasePrice: env.payload.purchasePrice ?? existing.purchasePrice,
        totalCostBasis: env.payload.totalCostBasis ?? existing.totalCostBasis,
        purchaseDate: env.payload.purchaseDate ?? existing.purchaseDate,
        purchaseSource: env.payload.purchaseSource ?? existing.purchaseSource,
        notes: env.payload.notes ?? existing.notes,
      };
      return { rowNumber: env.rowNumber, action, outcome: "updated", holdingId: targetHid };
    }
    // commit (NEW lane) or add-as-copy
    const newId = env.payload.id ? normalizeId(env.payload.id) : normalizeId(generateId());
    const newHolding = mergePayload({ id: newId } as PortfolioHolding, env.payload);
    newHolding.id = newId;
    newHolding.cardsightCardId = env.cardsightCardId ?? null;
    doc.holdings[newId] = newHolding;
    return { rowNumber: env.rowNumber, action, outcome: "added", holdingId: newId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rowNumber: env.rowNumber, action, outcome: "failed", reason: msg };
  }
}

function mergePayload(existing: PortfolioHolding, payload: NormalizedHoldingPayload): PortfolioHolding {
  const out: PortfolioHolding = { ...existing };
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

function generateId(): string {
  // Simple UUID-v4-ish; lowercase for the CF-D1 case-fold contract.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(2, "0");
  const part = (n: number) => Array.from({ length: n }, () => hex(256)).join("");
  return `${part(4)}-${part(2)}-${part(2)}-${part(2)}-${part(6)}`;
}

// Re-export type used elsewhere
export type { ImportRowEnvelope } from "./resolveBatch.js";
