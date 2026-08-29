// CF-IMPORT-BE (2026-06-21) — per-row resolver orchestration with bounded
// concurrency (4-way, per the step-0 rate-limit probe ceiling).
//
// CF-IMPORT-RESOLVES-TO-CHECKLIST (D12-b, 2026-08-29). Every NEW-lane row
// goes through the internal catalog resolver (importResolver.ts). A
// round-trip cell is an identity only when it is an `hiq:` slug the catalog
// holds; anything else is a hint and the row resolves from its fields. The
// buckets — the same five iOS keys its rendering on:
//
//   resolved-clean       found at >= the identity bar, no collision  → commit
//   resolved-collision   found at >= the bar, collides               → per collision
//   ambiguous            the catalog holds several answers            → skip
//   unresolved           nothing AT the bar. A match BELOW it rides   → skip
//                        along on `resolution` as a suggestion; a
//                        committed row is added for review with the
//                        suggestion parked, never with it as identity
//   identity-edited      UPDATE lane, identity column changed         → skip
//
// Collision keys derive from the resolved slug, or the title tuple when
// there is none — an unresolved row still collides with an identical one,
// whether it already sits in the portfolio or earlier in the same sheet.

import type { ParsedRow } from "./fileParser.js";
import {
  detectCollision,
  collisionKeyOf,
  type CollisionDetection,
} from "./collisionDetector.js";
import {
  resolveImportRow,
  asHiqSlug,
  type ImportResolver,
  type ImportResolution,
} from "./importResolver.js";
import { identityPinMinConfidence } from "../identityFromFields.js";
import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";

export type ImportLane = "update" | "new";

export type ImportBucket =
  | "resolved-clean"
  | "resolved-collision"
  | "ambiguous"
  | "unresolved"
  | "identity-edited";

export const IMPORT_BUCKETS: ReadonlyArray<ImportBucket> = [
  "resolved-clean",
  "resolved-collision",
  "ambiguous",
  "unresolved",
  "identity-edited",
];

export interface ImportRowEnvelope {
  /** 1-indexed row number from the sheet. */
  rowNumber: number;
  /** "update" when an existing holdingId is targeted; "new" otherwise. */
  lane: ImportLane;
  /** Resolution + collision verdict bucket. */
  bucket: ImportBucket;
  /** The identity the commit will write: a canonical `hiq:` slug, or null.
   *  Set only when the resolution cleared the identity bar (or the row is a
   *  round-trip slug the catalog holds). A suggestion below the bar lives in
   *  `resolution` and is never written as identity. */
  cardId: string | null;
  /** What the resolver said, in full — slug, confidence, matchedBy, print
   *  run, why-not. Absent on the UPDATE lane. */
  resolution?: ImportResolution | null;
  /** Non-identity content of a cardId / hobbyiqCardId cell (a vendor id, a
   *  slug the catalog does not hold). Carried for display; never persisted. */
  identityHint?: string | null;
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
  cardId?: string | null;
  hobbyiqCardId?: string | null;
  /** Import-only: an explicit sport column. Not persisted — the slug carries it. */
  sport?: string;
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
  /** Test hook — inject a resolver replacement (defaults to resolveImportRow). */
  resolver?: ImportResolver;
  /**
   * CF-IMPORT-ASYNC (2026-06-21): fires after each row's envelope is
   * computed (clean, collision, ambiguous, unresolved — anything). The
   * async preview job uses this for throttled progress writes. Errors
   * thrown by the callback are swallowed — progress reporting must
   * never crash the resolve loop.
   */
  onRowComplete?: (envelope: ImportRowEnvelope) => Promise<void> | void;
}

/**
 * Resolve every row into an envelope. Bounded 4-way concurrency; order of
 * the returned array matches the input rows.
 */
export async function resolveBatch(
  rows: ReadonlyArray<ParsedRow>,
  opts: ResolveBatchOptions,
): Promise<ImportRowEnvelope[]> {
  const resolver = opts.resolver ?? defaultResolver;
  const envelopes: ImportRowEnvelope[] = new Array(rows.length);
  let next = 0;

  async function worker() {
    while (next < rows.length) {
      const idx = next++;
      const row = rows[idx]!;
      const env = await processRow(row, opts, resolver);
      envelopes[idx] = env;
      if (opts.onRowComplete) {
        try {
          await opts.onRowComplete(env);
        } catch {
          // Progress callbacks must never sink the resolve loop.
        }
      }
    }
  }
  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, () => worker()));

  markIntraBatchDuplicates(envelopes);
  return envelopes;
}

async function defaultResolver(input: Parameters<ImportResolver>[0]): Promise<ImportResolution> {
  try {
    return await resolveImportRow(input);
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      event: "import_resolver_error",
      source: "resolveBatch.defaultResolver",
      error: err instanceof Error ? err.message : String(err),
    }));
    return { slug: null, found: false, confidence: 0, matchedBy: "not-found", printRun: null, sport: null, reason: "not-in-catalog" };
  }
}

async function processRow(
  row: ParsedRow,
  opts: ResolveBatchOptions,
  resolver: ImportResolver,
): Promise<ImportRowEnvelope> {
  const payload = extractPayload(row);

  // ─── UPDATE lane: holdingId on the sheet matches an existing holding ──
  if (payload.id && opts.existingHoldings[payload.id]) {
    const existing = opts.existingHoldings[payload.id]!;
    const existingIdentity =
      asHiqSlug((existing as { hobbyiqCardId?: string | null }).hobbyiqCardId)
      ?? (existing.cardId ?? null);
    // Identity is not editable through the metadata-update lane. The cells
    // must not reach mergePayload: a blank cardId cell would otherwise wipe
    // the stored identity, and a filled one would overwrite it unvalidated.
    delete payload.cardId;
    delete payload.hobbyiqCardId;
    delete payload.sport;
    // Check whether stored identity matches the row's identity. If the
    // user edited an identity column, flag for re-resolve rather than
    // silent metadata update.
    const identityEdited = identityWasEdited(payload, existing);
    if (identityEdited) {
      return {
        rowNumber: row.rowNumber,
        lane: "update",
        bucket: "identity-edited",
        cardId: existingIdentity,
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
      cardId: existingIdentity,
      existingHoldingId: payload.id,
      payload,
      parseFlags: row.flags,
      message: "Metadata-only update on existing holding.",
    };
  }

  // ─── NEW lane ───────────────────────────────────────────────────────
  // A round-trip cell is an identity only when it is an hiq: slug the
  // catalog holds; the resolver checks that. Anything else is a hint.
  const cellSlug = asHiqSlug(payload.hobbyiqCardId) ?? asHiqSlug(payload.cardId);
  const rawCell = String(payload.hobbyiqCardId ?? payload.cardId ?? "").trim() || null;

  const resolution = await resolver({
    sport: payload.sport ?? null,
    cardYear: payload.cardYear ?? null,
    product: payload.product ?? null,
    cardTitle: payload.cardTitle ?? null,
    cardNumber: payload.cardNumber ?? null,
    parallel: payload.parallel ?? null,
    variation: payload.variation ?? null,
    serialNumber: payload.serialNumber ?? null,
    isAuto: payload.isAuto ?? null,
    playerName: payload.playerName ?? null,
    roundTripSlug: cellSlug,
  });

  const minConfidence = identityPinMinConfidence();
  const identity =
    resolution.found && resolution.confidence >= minConfidence
      ? asHiqSlug(resolution.slug)
      : null;

  // The sheet's cell never becomes the identity by itself. What the commit
  // writes is `cardId` on the envelope, set from the resolution.
  payload.cardId = identity;
  payload.hobbyiqCardId = identity;
  delete payload.sport;
  const identityHint = identity && rawCell === identity ? null : rawCell;

  const collision = detectCollision(
    {
      cardId: identity,
      holdingId: payload.id ?? null,
      parallel: payload.parallel ?? null,
      gradeCompany: payload.gradeCompany ?? null,
      gradeValue: payload.gradeValue ?? null,
      serialNumber: payload.serialNumber ?? null,
      playerName: payload.playerName ?? null,
      cardYear: payload.cardYear ?? null,
      product: payload.product ?? null,
      cardNumber: payload.cardNumber ?? null,
    },
    opts.existingHoldings,
  );

  const base = {
    rowNumber: row.rowNumber,
    lane: "new" as const,
    cardId: identity,
    resolution,
    identityHint,
    payload,
    parseFlags: row.flags,
    ...(collision.collides ? { collision } : {}),
  };
  const hintNote = resolution.rejectedRoundTrip
    ? ` The sheet's ${resolution.rejectedRoundTrip} names no catalog row and was not used as identity.`
    : "";
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  if (identity) {
    if (collision.collides) {
      return { ...base, bucket: "resolved-collision", message: collision.reason + hintNote };
    }
    return {
      ...base,
      bucket: "resolved-clean",
      message: `Resolved to the HobbyIQ catalog (${resolution.matchedBy}, ${pct(resolution.confidence)}); no collision.${hintNote}`,
    };
  }

  if (resolution.ambiguous?.cardNumbers?.length) {
    return {
      ...base,
      bucket: "ambiguous",
      message: `The catalog holds ${resolution.ambiguous.cardNumbers.length} card numbers for this player in this product (${resolution.ambiguous.cardNumbers.join(", ")}); add the card number.${hintNote}`,
    };
  }
  if (resolution.ambiguous?.sports?.length) {
    return {
      ...base,
      bucket: "ambiguous",
      message: `This card exists in more than one sport (${resolution.ambiguous.sports.join(", ")}); add a Sport column.${hintNote}`,
    };
  }
  if (resolution.found && resolution.slug) {
    // Below the bar: a suggestion, never an identity. The row keeps the
    // bucket iOS renders as "fix identity"; the suggestion travels on
    // `resolution` and, if the row is committed anyway, is parked on the
    // holding for the in-app confirm (the same pending-review path the eBay
    // import uses).
    return {
      ...base,
      bucket: "unresolved",
      message: `Catalog suggests ${resolution.slug} (${resolution.matchedBy}, ${pct(resolution.confidence)}) — below the ${pct(minConfidence)} identity bar, so it is not adopted. If committed, the card is added for review with this suggestion attached; confirm it in the app.${hintNote}`,
    };
  }
  return {
    ...base,
    bucket: "unresolved",
    message: `${unresolvedReasonText(resolution)}${hintNote}`,
  };
}

function unresolvedReasonText(r: ImportResolution): string {
  switch (r.reason) {
    case "no-year": return "No card year on the row; cannot resolve.";
    case "no-set": return "No product / set on the row; cannot resolve.";
    case "no-card-number": return "No card number on the row and the catalog could not supply one from the player; cannot resolve.";
    case "sport-unknown": return "Could not tell which sport this product is; add a Sport column.";
    case "not-in-catalog":
    default:
      return r.slug
        ? `No catalog row matches this identity (would be ${r.slug}).`
        : "No catalog row matches this identity.";
  }
}

/**
 * Two identical rows in one sheet collide with each other, not just with the
 * portfolio: the second carries a collision naming the first. A resolved row
 * moves to resolved-collision (skip default); an unresolved row keeps its
 * bucket (already skip default) and gains the collision.
 */
function markIntraBatchDuplicates(envelopes: ImportRowEnvelope[]): void {
  const firstByKey = new Map<string, number>();
  const ordered = [...envelopes].sort((a, b) => a.rowNumber - b.rowNumber);
  for (const env of ordered) {
    if (env.lane !== "new") continue;
    const key = collisionKeyOf({
      cardId: env.cardId,
      holdingId: env.payload.id ?? null,
      parallel: env.payload.parallel ?? null,
      gradeCompany: env.payload.gradeCompany ?? null,
      gradeValue: env.payload.gradeValue ?? null,
      serialNumber: env.payload.serialNumber ?? null,
      playerName: env.payload.playerName ?? null,
      cardYear: env.payload.cardYear ?? null,
      product: env.payload.product ?? null,
      cardNumber: env.payload.cardNumber ?? null,
    });
    if (!key) continue;
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, env.rowNumber);
      continue;
    }
    const prior = env.collision;
    env.collision = {
      collides: true,
      existingHoldingIds: prior?.existingHoldingIds ?? [],
      duplicateOfRowNumbers: [...(prior?.duplicateOfRowNumbers ?? []), first],
      defaultAction: prior?.collides ? prior.defaultAction : "skip",
      keyedBy: env.cardId ? "slug" : "title",
      reason: `duplicate of row ${first} in this file${prior?.collides ? `; ${prior.reason}` : ""}`,
    };
    if (env.bucket === "resolved-clean") {
      env.bucket = "resolved-collision";
      env.message = env.collision.reason;
    } else {
      env.message = `${env.message} Duplicate of row ${first} in this file.`;
    }
  }
}

/** Lift the per-row parsed cells into a flat payload usable by addHolding. */
function extractPayload(row: ParsedRow): NormalizedHoldingPayload {
  const out: NormalizedHoldingPayload = {};
  const get = (k: string) => row.cells[k]?.value ?? undefined;

  out.id = get("holdingId") as string | undefined;
  out.cardId = (get("cardId") as string | undefined) ?? null;
  out.hobbyiqCardId = (get("hobbyiqCardId") as string | undefined) ?? null;
  out.sport = get("sport") as string | undefined;
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
