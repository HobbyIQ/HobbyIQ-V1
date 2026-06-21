// CF-IMPORT-BE (2026-06-21) — per-row resolver orchestration with bounded
// concurrency (4-way, per the step-0 rate-limit probe ceiling).
//
// Round-trip rows (cardsightCardId present + matches existing) skip
// resolution entirely. Arbitrary rows go through cardsight.mapper's
// resolveCardId (which already carries the 429/5xx exponential backoff
// per fetchWithRetry).

import { resolveCardId } from "../../compiq/cardsight.mapper.js";
import type { CompIQQueryInput } from "../../compiq/cardsight.mapper.js";
import type { ParsedRow } from "./fileParser.js";
import { detectCollision, type CollisionDetection } from "./collisionDetector.js";
import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";

export type ImportLane = "update" | "new";

export type ImportBucket =
  | "resolved-clean"
  | "resolved-collision"
  | "ambiguous"
  | "unresolved"
  | "identity-edited";

export interface ImportRowEnvelope {
  /** 1-indexed row number from the sheet. */
  rowNumber: number;
  /** "update" when an existing holdingId is targeted; "new" otherwise. */
  lane: ImportLane;
  /** Resolution + collision verdict bucket. */
  bucket: ImportBucket;
  /** Resolved cardsightCardId (from sheet anchor OR resolver call). null when unresolved. */
  cardsightCardId: string | null;
  /** Existing holdingId targeted by an UPDATE-lane row. */
  existingHoldingId?: string;
  /** Collision detection result when applicable. */
  collision?: CollisionDetection;
  /** The normalized fields the commit step will use. */
  payload: NormalizedHoldingPayload;
  /** Parse-side flags from the file parser (date ambiguities, lenient flags). */
  parseFlags: Array<{ column: string; reason: string }>;
  /** Human-readable explanation surfaced in the preview. */
  message: string;
}

export interface NormalizedHoldingPayload {
  id?: string;
  cardsightCardId?: string | null;
  playerName?: string;
  cardYear?: number;
  product?: string;
  cardTitle?: string;
  cardNumber?: string;
  parallel?: string;
  variation?: string;
  serialNumber?: string;
  isAuto?: boolean;
  gradeCompany?: string;
  gradeValue?: number;
  certNumber?: string;
  certGrader?: string;
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  purchaseDate?: string;
  purchaseSource?: string;
  notes?: string;
  listingPrice?: number;
  listingUrl?: string;
}

const RESOLVE_CONCURRENCY = 4;

export interface ResolveBatchOptions {
  isRoundTrip: boolean;
  existingHoldings: Record<string, PortfolioHolding>;
  /** Test hook — inject a resolver replacement (defaults to real resolveCardId). */
  resolver?: (input: CompIQQueryInput) => Promise<{ cardId: string | null }>;
  /**
   * CF-IMPORT-ASYNC (2026-06-21): fires after each row's envelope is
   * computed (clean, collision, ambiguous, unresolved — anything). The
   * async preview path uses this to throttle progress writes to the
   * import-job doc. Never thrown; per-call errors are caught and logged.
   */
  onRowComplete?: () => Promise<void>;
}

/**
 * Resolve + dedup-classify a batch of parsed rows. Concurrency-limited
 * per the step-0 probe (sweet spot 4-way at ~2 req/s sustained).
 *
 * Returns per-row envelopes. ZERO writes — preview only.
 */
export async function resolveBatch(
  rows: ReadonlyArray<ParsedRow>,
  opts: ResolveBatchOptions,
): Promise<ImportRowEnvelope[]> {
  const resolver = opts.resolver ?? defaultResolver;
  const envelopes: ImportRowEnvelope[] = new Array(rows.length);

  // Bounded-concurrency worker pool
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const idx = next++;
      envelopes[idx] = await processRow(rows[idx]!, opts, resolver);
      // CF-IMPORT-ASYNC: per-row progress hook. Errors swallowed —
      // progress reporting must never sink the resolver.
      if (opts.onRowComplete) {
        try { await opts.onRowComplete(); } catch (err: unknown) {
          console.warn("[resolveBatch] onRowComplete threw:", err);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, () => worker()));

  return envelopes;
}

async function defaultResolver(input: CompIQQueryInput): Promise<{ cardId: string | null }> {
  try {
    const r = await resolveCardId(input);
    return { cardId: r.cardId };
  } catch {
    return { cardId: null };
  }
}

async function processRow(
  row: ParsedRow,
  opts: ResolveBatchOptions,
  resolver: (input: CompIQQueryInput) => Promise<{ cardId: string | null }>,
): Promise<ImportRowEnvelope> {
  const payload = extractPayload(row);

  // ─── UPDATE lane: holdingId on the sheet matches an existing holding ──
  if (payload.id && opts.existingHoldings[payload.id]) {
    const existing = opts.existingHoldings[payload.id]!;
    // Check whether stored identity matches the row's identity. If the
    // user edited an identity column, flag for re-resolve rather than
    // silent metadata update.
    const identityEdited = identityWasEdited(payload, existing);
    if (identityEdited) {
      return {
        rowNumber: row.rowNumber,
        lane: "update",
        bucket: "identity-edited",
        cardsightCardId: existing.cardsightCardId ?? null,
        existingHoldingId: payload.id,
        payload,
        parseFlags: row.flags,
        message: "Identity column edited on a holdingId-matched row. Re-resolution needed; review before commit.",
      };
    }
    return {
      rowNumber: row.rowNumber,
      lane: "update",
      bucket: "resolved-clean",
      cardsightCardId: existing.cardsightCardId ?? null,
      existingHoldingId: payload.id,
      payload,
      parseFlags: row.flags,
      message: "Metadata-only update on existing holding.",
    };
  }

  // ─── NEW lane ───────────────────────────────────────────────────────
  // If cardsightCardId already on the sheet (round-trip), skip resolver.
  let resolvedCardId: string | null = payload.cardsightCardId ?? null;

  if (!resolvedCardId) {
    // Arbitrary path: call resolver.
    const result = await resolver({
      playerName: payload.playerName ?? "",
      cardYear: payload.cardYear,
      product: payload.product,
      parallel: payload.parallel,
      cardNumber: payload.cardNumber,
      isAuto: payload.isAuto,
    } as CompIQQueryInput);
    resolvedCardId = result.cardId;
  }

  if (!resolvedCardId) {
    return {
      rowNumber: row.rowNumber,
      lane: "new",
      bucket: "unresolved",
      cardsightCardId: null,
      payload,
      parseFlags: row.flags,
      message: "Resolver could not match this row to a Cardsight catalog entry.",
    };
  }

  // Collision check
  const collision = detectCollision(
    {
      cardsightCardId: resolvedCardId,
      holdingId: payload.id ?? null,
      parallel: payload.parallel ?? null,
      gradeCompany: payload.gradeCompany ?? null,
      gradeValue: payload.gradeValue ?? null,
      serialNumber: payload.serialNumber ?? null,
    },
    opts.existingHoldings,
  );

  payload.cardsightCardId = resolvedCardId;

  if (collision.collides) {
    return {
      rowNumber: row.rowNumber,
      lane: "new",
      bucket: "resolved-collision",
      cardsightCardId: resolvedCardId,
      collision,
      payload,
      parseFlags: row.flags,
      message: collision.reason,
    };
  }

  return {
    rowNumber: row.rowNumber,
    lane: "new",
    bucket: "resolved-clean",
    cardsightCardId: resolvedCardId,
    payload,
    parseFlags: row.flags,
    message: "Resolved to Cardsight catalog; no collision.",
  };
}

/** Lift the per-row parsed cells into a flat payload usable by addHolding. */
function extractPayload(row: ParsedRow): NormalizedHoldingPayload {
  const out: NormalizedHoldingPayload = {};
  const get = (k: string) => row.cells[k]?.value ?? undefined;

  out.id = get("holdingId") as string | undefined;
  out.cardsightCardId = (get("cardsightCardId") as string | undefined) ?? null;
  out.playerName = get("playerName") as string | undefined;
  out.cardYear = get("cardYear") as number | undefined;
  out.product = get("product") as string | undefined;
  out.cardTitle = get("cardTitle") as string | undefined;
  out.cardNumber = get("cardNumber") as string | undefined;
  out.parallel = get("parallel") as string | undefined;
  out.variation = get("variation") as string | undefined;
  out.serialNumber = get("serialNumber") as string | undefined;
  out.isAuto = get("isAuto") as boolean | undefined;
  out.gradeCompany = get("gradeCompany") as string | undefined;
  out.gradeValue = get("gradeValue") as number | undefined;
  out.certNumber = get("certNumber") as string | undefined;
  out.certGrader = get("certGrader") as string | undefined;
  out.quantity = get("quantity") as number | undefined;
  out.purchasePrice = get("purchasePrice") as number | undefined;
  out.totalCostBasis = get("totalCostBasis") as number | undefined;
  out.purchaseDate = get("purchaseDate") as string | undefined;
  out.purchaseSource = get("purchaseSource") as string | undefined;
  out.notes = get("notes") as string | undefined;
  out.listingPrice = get("listingPrice") as number | undefined;
  out.listingUrl = get("listingUrl") as string | undefined;

  return out;
}

/** Identity columns: editing any of these on a holdingId-matched row triggers re-resolution. */
const IDENTITY_COLUMNS: ReadonlyArray<keyof NormalizedHoldingPayload> = [
  "playerName",
  "cardYear",
  "product",
  "cardNumber",
  "parallel",
];

function identityWasEdited(payload: NormalizedHoldingPayload, existing: PortfolioHolding): boolean {
  for (const col of IDENTITY_COLUMNS) {
    const fromSheet = payload[col];
    if (fromSheet === undefined || fromSheet === null) continue;
    const fromStore = existing[col as keyof PortfolioHolding];
    if (String(fromSheet).trim().toLowerCase() !== String(fromStore ?? "").trim().toLowerCase()) {
      return true;
    }
  }
  return false;
}
