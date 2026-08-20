// CF-EBAY-REVIEW-QUEUE (2026-07-12).
//
// User-facing gate that turns auto-import from "silent commit + hope for
// the best" into "propose + confirm." Every eBay auto-created holding
// lands in cardStatus="pending-review" and waits until the user hits
// confirm — with any field corrections layered in. Corrections are logged
// so the parser + engine can improve.
//
// Flow:
//   1. importEbayPurchaseHistory → runAutoHoldingBatch → creates holdings
//      with cardStatus="pending-review", excluded from /holdings /pnl
//      /reprice.
//   2. User pulls GET /erp/holdings/pending-review, sees N cards with
//      parsed fields + Browse aspects + photos.
//   3. User taps Confirm (optionally editing any field) →
//      confirmHoldingReview promotes to cardStatus="active" and logs
//      the (autoParsed → userCorrected) deltas as a correction record.
//   4. User taps Reject → rejectHoldingReview deletes the holding and
//      unlinks from the source purchase, leaving the purchase available
//      for manual re-attribution.

import { randomUUID } from "crypto";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import {
  readUserDoc,
  writeUserDoc,
} from "./portfolioStore.service.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Fields the user can edit during confirm. Superset of the fields the
 *  parser/Browse enrich. Every field is optional; only present fields
 *  patch the holding.
 *
 *  CF-REVIEW-QUEUE-CLEAN-DATA (2026-07-12): to explicitly CLEAR a field
 *  (e.g. "this is Raw" → clear gradeCompany + gradeValue), send `null`.
 *  Omitting the field leaves the existing value alone. Sending an actual
 *  value overwrites — even if it equals the parsed value, because the
 *  user is asserting canonical truth (needed for downstream comp
 *  bucketing to trust the row). */
export interface ConfirmHoldingEdits {
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  gradeCompany?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
  gradeValue?: number | null;
  isAuto?: boolean | null;
  team?: string | null;
  sport?: string | null;
  cardId?: string | null;
  // Purchase-side corrections don't belong here — the user edits the
  // linked purchase separately. Cost basis stays untouched by confirm.
}

export type ConfirmHoldingResult =
  | { status: "confirmed"; holding: PortfolioHolding; correctionCount: number }
  | { status: "not-found" }
  | { status: "not-pending" }   // already active or in a different state
  | { status: "error"; reason: string };

export type RejectHoldingResult =
  | { status: "rejected"; unlinkedPurchaseId: string | null }
  | { status: "not-found" }
  | { status: "not-pending" }
  | { status: "error"; reason: string };

/** One user-corrected field. Fed to the corrections corpus so the parser
 *  can be improved (e.g. "Baseball Owen Carey" → "Owen Carey" seen N times
 *  → add "Baseball" to IGNORE_TOKENS). */
export interface FieldCorrection {
  field: string;
  before: unknown;
  after: unknown;
}

/** Correction record — one per confirm-with-edits. Stored on the doc
 *  under `doc.ebayCorrections[]` for now (single container, no new Cosmos
 *  container). Feeds a future ops route or offline parser retrain. */
export interface EbayCorrectionRecord {
  id: string;
  userId: string;
  holdingId: string;
  sourcePurchaseId?: string;
  ebayItemId?: string;
  ebayTitle?: string;
  autoParsed: {
    playerName?: string;
    cardYear?: number;
    setName?: string;
    parallel?: string;
    cardNumber?: string;
    gradeCompany?: string;
    gradeValue?: number;
    isAuto?: boolean;
    parseConfidence?: number;
  };
  browseAspects?: Record<string, string>;
  corrections: FieldCorrection[];
  confirmedAt: string;
}

// ─── Confirm ───────────────────────────────────────────────────────────────

/**
 * Promote a pending-review holding to active. Optional field edits are
 * applied first; deltas are logged as a correction record so the parser
 * + engine can improve from user ground truth.
 */
export async function confirmHoldingReview(
  userId: string,
  holdingId: string,
  edits: ConfirmHoldingEdits = {},
): Promise<ConfirmHoldingResult> {
  if (!userId || !holdingId) return { status: "error", reason: "missing userId or holdingId" };
  const doc = await readUserDoc(userId);
  const holding = doc.holdings?.[holdingId] as (PortfolioHolding & Record<string, unknown>) | undefined;
  if (!holding) return { status: "not-found" };
  if ((holding as any).cardStatus !== "pending-review") {
    return { status: "not-pending" };
  }

  // Snapshot the "before" state so corrections can be logged accurately.
  const autoParsed = {
    playerName: holding.playerName,
    cardYear: holding.cardYear,
    setName: holding.setName,
    parallel: holding.parallel,
    cardNumber: holding.cardNumber,
    gradeCompany: holding.gradeCompany,
    gradeValue: holding.gradeValue,
    isAuto: holding.isAuto,
    parseConfidence: (holding as any).parseConfidence,
  };

  // CF-REVIEW-QUEUE-CLEAN-DATA (2026-07-12): three-way semantics.
  //   undefined  → field not in edits → leave alone
  //   null       → CLEAR the field (e.g. "this is Raw" clears grade)
  //   any value  → OVERWRITE, even if equal to parsed. User picked
  //                canonical catalog data; downstream comps must trust
  //                the row was affirmed clean. lastUpdated will bump.
  //
  // Corrections are only logged when the value actually changed (avoid
  // polluting the training corpus with no-op writes on same-value picks).
  const corrections: FieldCorrection[] = [];
  const applyEdit = <K extends keyof ConfirmHoldingEdits>(
    field: K,
    write: (h: PortfolioHolding & Record<string, unknown>, v: NonNullable<ConfirmHoldingEdits[K]>) => void,
    clear: (h: PortfolioHolding & Record<string, unknown>) => void,
  ) => {
    if (!(field in edits)) return;
    const v = edits[field];
    const before = (autoParsed as any)[field] ?? (holding as any)[field] ?? null;
    if (v === null) {
      clear(holding);
      if (before !== null) {
        corrections.push({ field: String(field), before, after: null });
      }
      return;
    }
    if (v === undefined) return;   // defensive; `in` check above already caught it
    write(holding, v as any);
    if (before !== v) {
      corrections.push({ field: String(field), before, after: v });
    }
  };

  applyEdit(
    "playerName",
    (h, v) => { h.playerName = v; },
    (h) => { delete h.playerName; },
  );
  applyEdit(
    "cardYear",
    (h, v) => { h.cardYear = v; },
    (h) => { delete h.cardYear; },
  );
  applyEdit(
    "setName",
    (h, v) => { h.setName = v; h.product = v; },
    (h) => { delete h.setName; delete h.product; },
  );
  applyEdit(
    "parallel",
    (h, v) => { h.parallel = v; },
    (h) => { delete h.parallel; },
  );
  applyEdit(
    "cardNumber",
    (h, v) => { h.cardNumber = v; },
    (h) => { delete h.cardNumber; },
  );
  applyEdit(
    "gradeCompany",
    (h, v) => { h.gradeCompany = v as any; (h as any).gradingCompany = v; },
    // Clearing gradeCompany is the "Raw" signal — also clear gradeValue.
    (h) => { delete h.gradeCompany; delete (h as any).gradingCompany; delete h.gradeValue; },
  );
  applyEdit(
    "gradeValue",
    (h, v) => { h.gradeValue = v; },
    (h) => { delete h.gradeValue; },
  );
  applyEdit(
    "isAuto",
    (h, v) => { h.isAuto = v; },
    (h) => { delete h.isAuto; },
  );
  applyEdit(
    "team",
    (h, v) => { (h as any).team = v; },
    (h) => { delete (h as any).team; },
  );
  applyEdit(
    "sport",
    (h, v) => { (h as any).sport = v; },
    (h) => { delete (h as any).sport; },
  );
  applyEdit(
    "cardId",
    (h, v) => { (h as any).cardId = v; },
    (h) => { delete (h as any).cardId; },
  );

  // CF-SUGGESTER-AUTO-APPLY-ON-CONFIRM (Drew, 2026-07-20).
  // Pattern 4 from suggester-quality-audit-2026-07-20.md: user confirms
  // a holding but iOS didn't include cardId in `edits`, leaving the
  // holding active-with-null-cardId while a viable suggestion sat right
  // there. Safety net — if cardId wasn't explicitly touched AND the
  // holding has a suggestedCardId with confidence >= 0.55 (medium tier
  // or better), auto-apply the suggestion. Never overrides an explicit
  // edits.cardId — including null (user explicitly rejected the SKU).
  if (!("cardId" in edits) && !(holding as any).cardId) {
    let suggested = String((holding as any).suggestedCardId ?? "").trim();
    let suggestedConfidence = Number((holding as any).suggestionConfidence ?? 0);
    // CF-CONFIRM-SYNC-SUGGEST (Drew, 2026-08-03). If no suggestion was
    // pre-cached on the holding (fire-and-forget suggester never ran,
    // or ran before the fields were populated), take one synchronous
    // shot at the suggester right now. Users approve one-at-a-time so
    // this pays only ~1 suggester call per confirmation. Prevents the
    // "approved but unverified with no FMV" state Drew hit.
    if (!suggested) {
      try {
        const { suggestCardIdForHolding } = await import("./cardIdSuggester.service.js");
        const suggestion = await suggestCardIdForHolding(holding);
        if (suggestion?.cardId) {
          suggested = String(suggestion.cardId);
          suggestedConfidence = Number(suggestion.confidence ?? 0);
          (holding as any).suggestedCardId = suggested;
          (holding as any).suggestionConfidence = suggestedConfidence;
        }
      } catch { /* soft — proceed with legacy behavior */ }
    }
    if (suggested && suggestedConfidence >= 0.55) {
      (holding as any).cardId = suggested;
      (holding as any).cardIdAutoAppliedFromSuggestion = true;
      corrections.push({
        field: "cardId",
        before: null,
        after: suggested,
      });
      console.log(JSON.stringify({
        event: "suggester_auto_apply_on_confirm",
        source: "ebayReviewQueue.service",
        userId, holdingId,
        cardId: suggested,
        confidence: suggestedConfidence,
      }));
    }
  }

  // Promote to active + clear needsReview.
  (holding as any).cardStatus = "active";
  (holding as any).needsReview = false;
  (holding as any).confirmedAt = new Date().toISOString();
  holding.lastUpdated = new Date().toISOString();
  // CF-CONFIRM-STAMPS-VERIFIED (Drew, 2026-08-03). User approval of a
  // review-queue holding IS a first-class identity verification — the
  // whole flow is "match first, before inventory." Stamp
  // identityVerified so the portfolio's Unverified filter / badge
  // clears immediately instead of waiting for the user to open the
  // Edit modal separately. The suggester's auto-applied cardId still
  // gets flagged with cardIdAutoAppliedFromSuggestion so downstream
  // can distinguish user-picked vs suggester-picked cardIds.
  // CF-CONFIRM-MATCHES-CATALOG (Drew, 2026-08-13: "I approved these and looked
  // matched but still says unverified and missing").
  //
  // Everything below — identityVerified, the catalog cross-reference, and the
  // reprice back in the route — is gated on cardId ALREADY existing. Confirm
  // never attempted a match itself. So approving a holding that was imported
  // before match-at-ingest existed flipped cardStatus to active and did nothing
  // visible: it stayed UNVERIFIED, stayed MISSING, and showed no value, which
  // reads as the approval having failed.
  //
  // Approval is the user telling us the identity fields are right, so it is
  // exactly the moment to look the card up. Same strict matcher and same >= 0.9
  // pin gate as the ingest path — approval affirms the FIELDS, it does not make
  // a weak catalog match trustworthy, and pinning the wrong card here would
  // price the holding wrongly while looking confirmed.
  if (!(holding as any).cardId) {
    try {
      const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
      const h = holding as Record<string, unknown>;
      const match = await canonicalize({
        sport: String(h.sport ?? "baseball"),
        year: typeof h.cardYear === "number" ? h.cardYear : null,
        setName: String(h.setName ?? h.product ?? ""),
        cardNumber: String(h.cardNumber ?? ""),
        parallel: String(h.parallel ?? "") || null,
        isAuto: Boolean(h.isAuto),
        playerName: String(h.playerName ?? ""),
        source: "user-verified",
      } as never);
      if (match) {
        h.catalogMatchConfidence = match.confidence;
        h.catalogMatchedBy = match.matchedBy ?? null;
        h.catalogMatchSlug = match.slug ?? null;
        if (match.found && match.slug && match.confidence >= 0.9) {
          h.cardId = match.slug;
          h.cardIdSetOnConfirm = true;
        }
      }
    } catch {
      // Never fail an approval because the matcher was unavailable — the
      // holding still activates, just without an identity link.
    }
  }

  if ((holding as any).cardId) {
    (holding as any).identityVerified = true;
    (holding as any).identityVerifiedAt = new Date().toISOString();
    // CF-CATALOG-VERIFY-OWN-POOL (Drew, 2026-08-12). Cross-reference
    // against OUR card_catalog to tag whether the parsed identity exists
    // in a real published set. Never blocks the confirm.
    //   verified=true  → our catalog vouches for the identity
    //   verified=false → we cover this player+set and the number isn't
    //                    on it (bad parse likely)
    //   verified=null  → we can't answer yet; the miss has enqueued a
    //                    checklist seed so the NEXT verify answers
    //
    // Was TCA-backed until 2026-08-12. That path metered out at 2,000
    // catalog records/day and then returned "can't verify" for the rest
    // of the day — verification quality tracked the clock instead of the
    // data. Default-on now (opt OUT via CATALOG_VERIFY_ENABLED=false)
    // since a single-partition read on our own container has no quota
    // and no vendor dependency.
    if ((holding as any).playerName && (holding as any).cardYear && (holding as any).setName && (holding as any).cardNumber && (holding as any).sport && process.env.CATALOG_VERIFY_ENABLED !== "false") {
      try {
        const { verifyCardIdentity } = await import("../catalog/catalogVerify.service.js");
        const v = await verifyCardIdentity({
          playerName: String((holding as any).playerName),
          cardYear: Number((holding as any).cardYear),
          setName: String((holding as any).setName),
          cardNumber: String((holding as any).cardNumber),
          sport: String((holding as any).sport),
        });
        (holding as any).catalogVerified = v.verified;
        (holding as any).catalogVerifiedReason = v.reason;
        (holding as any).catalogVerifiedSource = v.source;
        if (v.matchedSlug) (holding as any).catalogVerifiedSlug = v.matchedSlug;
        if (v.candidateNumbers?.length) (holding as any).catalogCandidateNumbers = v.candidateNumbers;
        if (v.seedRequested) (holding as any).catalogSeedRequested = true;
        (holding as any).catalogVerifiedAt = new Date().toISOString();
      } catch { /* soft: verification is nice-to-have */ }
    }
    // CF-USER-VERIFIED-CATALOG-FLYWHEEL (Drew, 2026-08-03). Every user
    // approval IS a first-class catalog entry — the user just told us
    // "yes this is that card." Fire-and-forget upsert into
    // card_catalog with source='user-verified' (highest-confidence
    // provenance since a human confirmed it). Deterministic id keyed
    // by the tuple so repeated confirms on the same card collapse.
    void (async () => {
      try {
        const player = String((holding as any).playerName ?? "").trim();
        const year = Number((holding as any).cardYear);
        const setName = String((holding as any).setName ?? "").trim();
        const cardNumber = String((holding as any).cardNumber ?? "").trim();
        const sport = String((holding as any).sport ?? "").toLowerCase().trim();
        const parallel = String((holding as any).parallel ?? "base").toLowerCase().trim();
        const isAuto = Boolean((holding as any).isAuto);
        const printRun = (holding as any).printRun ?? null;
        if (!player || !year || !setName || !cardNumber || !sport) return;
        const key = [sport, year, setName.toLowerCase(), cardNumber.toLowerCase(), parallel, isAuto ? "auto" : "no-auto", printRun ?? "", player.toLowerCase()].join("|");
        const { createHash } = await import("crypto");
        const id = "user-verified:" + createHash("sha256").update(key).digest("hex").slice(0, 20);
        const { CosmosClient } = await import("@azure/cosmos");
        const cs = process.env.COSMOS_CONNECTION_STRING;
        if (!cs) return;
        const cat = new CosmosClient(cs)
          .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
          .container("card_catalog");
        await cat.items.upsert({
          id,
          player, year, number: cardNumber, setKey: setName, setName, sport, parallel,
          parallels: parallel && parallel !== "base" ? [{ name: parallel }] : [],
          isAuto, printRun,
          source: "user-verified",
          verifiedByUserIds: [userId],
          confidence: 0.98,   // human-in-the-loop = highest-trust catalog tier
          verifiedAt: new Date().toISOString(),
          holdingCardId: (holding as any).cardId ?? null,
          tcaCatalogVerified: (holding as any).tcaCatalogVerified ?? null,
        });
      } catch { /* soft: catalog flywheel is nice-to-have */ }
    })();
  }

  // Log corrections if any were made. Every confirm gets a record — even
  // if empty — so we track the review rate over time.
  const correctionsList: EbayCorrectionRecord[] = ((doc as any).ebayCorrections ?? []) as EbayCorrectionRecord[];
  correctionsList.push({
    id: randomUUID(),
    userId,
    holdingId,
    sourcePurchaseId: (holding as any).sourcePurchaseId ?? undefined,
    ebayItemId: extractEbayItemIdFromHolding(doc, holdingId),
    ebayTitle: extractEbayTitleFromHolding(doc, holdingId),
    autoParsed,
    browseAspects: (holding as any).ebayItemAspects ?? undefined,
    corrections,
    confirmedAt: (holding as any).confirmedAt,
  });
  (doc as any).ebayCorrections = correctionsList;

  await writeUserDoc(userId, doc);

  // CF-SOLD-COMPS-FOUNDATION (Drew, 2026-07-14): user just attested to
  // this cardId — emit a comp record to the shared sold_comps pool.
  // Fire-and-forget: never block confirm on the comp write, and never
  // fail confirm if the write throws. Gated on having a real cardId
  // (else it's a manual entry without SKU verification — no cross-user
  // pool value).
  const confirmedCardId = String((holding as any).cardId ?? "").trim();
  if (confirmedCardId && typeof holding.playerName === "string" && holding.playerName.trim()) {
    const price = Number((holding as any).purchasePrice ?? (holding as any).totalCostBasis ?? 0);
    const soldAt = String(
      (holding as any).purchaseDate
      ?? (holding as any).addedAt
      ?? (holding as any).confirmedAt
      ?? new Date().toISOString(),
    );
    if (price > 0 && soldAt) {
      void (async () => {
        try {
          const { recordSoldComp } = await import("./soldCompsStore.service.js");
          await recordSoldComp({
            cardId: confirmedCardId,
            playerName: holding.playerName!,
            cardYear: holding.cardYear ?? null,
            setName: holding.setName ?? null,
            parallel: holding.parallel ?? null,
            cardNumber: holding.cardNumber ?? null,
            isAuto: holding.isAuto === true,
            gradeCompany: (holding as { gradeCompany?: string | null }).gradeCompany ?? null,
            gradeValue: (holding as { gradeValue?: number | null }).gradeValue ?? null,
            price,
            soldAt,
            source: "ebay-user-purchase",
            // CF-COMP-DEDUP-CANONICAL (Drew, 2026-07-18): fall back to
            // holding-scoped id so rematch/suggester/backfill re-emissions
            // upsert this same doc instead of creating duplicates.
            sourceExternalId: extractEbayItemIdFromHolding(doc, holdingId) ?? `holding::${holdingId}`,
            contributorUserId: userId,
            title: (holding as any).cardTitle ?? extractEbayTitleFromHolding(doc, holdingId) ?? null,
            imageUrl: (holding as any).ebayImageUrl ?? null,
            sellerHandle: null,
            verifiedByUser: true,
            confidence: 1.0,
          });
        } catch {
          // swallow — comp emission is auxiliary, must never fail confirm
        }
      })();
    }
  }

  // CF-SUGGESTER-FEEDBACK (Drew, 2026-07-15): capture user's confirm as
  // training signal for the suggester. Fire-and-forget — never blocks
  // or fails confirm. See suggesterFeedback.service.ts header for the
  // learning-loop rationale.
  void (async () => {
    try {
      const { recordSuggesterFeedback } = await import("./suggesterFeedback.service.js");
      await recordSuggesterFeedback({
        userId,
        holdingId,
        holdingSource: (holding as any).source ?? null,
        autoParsed: {
          playerName: autoParsed.playerName ?? null,
          cardYear: autoParsed.cardYear ?? null,
          setName: autoParsed.setName ?? null,
          parallel: autoParsed.parallel ?? null,
          cardNumber: autoParsed.cardNumber ?? null,
          isAuto: autoParsed.isAuto ?? null,
          gradeCompany: autoParsed.gradeCompany ?? null,
          gradeValue: autoParsed.gradeValue ?? null,
          parseConfidence: (autoParsed as any).parseConfidence ?? null,
        },
        userAction: "confirmed",
        pickedCardId: String((holding as any).cardId ?? "").trim() || null,
        corrections,
      });
    } catch {
      // swallow — feedback capture is auxiliary
    }
  })();

  // CF-USER-REPUTATION (Drew, 2026-07-15): bump attestation counters
  // for reputation scoring. +1 confirmation, +corrections.length for
  // the parser-noise counter. Fire-and-forget.
  void (async () => {
    try {
      const { bumpUserStats } = await import("./userReputation.service.js");
      await bumpUserStats({
        userId,
        confirmations: 1,
        totalCorrections: corrections.length,
      });
    } catch {
      // swallow — reputation update is auxiliary
    }
  })();

  return { status: "confirmed", holding, correctionCount: corrections.length };
}

// ─── Reject ────────────────────────────────────────────────────────────────

/**
 * Delete a pending-review holding and unlink it from its source purchase.
 * The purchase itself is preserved (it's a real financial event); only
 * the auto-created holding is removed. User can manually attribute the
 * purchase later.
 */
export async function rejectHoldingReview(
  userId: string,
  holdingId: string,
): Promise<RejectHoldingResult> {
  if (!userId || !holdingId) return { status: "error", reason: "missing userId or holdingId" };
  const doc = await readUserDoc(userId);
  const holding = doc.holdings?.[holdingId] as (PortfolioHolding & Record<string, unknown>) | undefined;
  if (!holding) return { status: "not-found" };
  if ((holding as any).cardStatus !== "pending-review") {
    return { status: "not-pending" };
  }

  const sourcePurchaseId = ((holding as any).sourcePurchaseId as string | undefined) ?? null;

  delete doc.holdings[holdingId];

  if (sourcePurchaseId && Array.isArray((doc as any).purchases)) {
    for (const p of (doc as any).purchases as Array<{ id: string; holdingIds: string[] }>) {
      if (p.id === sourcePurchaseId) {
        p.holdingIds = p.holdingIds.filter((h) => h !== holdingId);
      }
    }
  }

  await writeUserDoc(userId, doc);

  // CF-SUGGESTER-FEEDBACK (Drew, 2026-07-15): capture user's reject as
  // negative training signal. High-tier rejections are the highest-
  // priority parser bugs. Fire-and-forget.
  void (async () => {
    try {
      const { recordSuggesterFeedback } = await import("./suggesterFeedback.service.js");
      await recordSuggesterFeedback({
        userId,
        holdingId,
        holdingSource: (holding as any).source ?? null,
        autoParsed: {
          playerName: holding.playerName ?? null,
          cardYear: holding.cardYear ?? null,
          setName: holding.setName ?? null,
          parallel: holding.parallel ?? null,
          cardNumber: holding.cardNumber ?? null,
          isAuto: holding.isAuto ?? null,
          gradeCompany: holding.gradeCompany ?? null,
          gradeValue: holding.gradeValue ?? null,
          parseConfidence: (holding as any).parseConfidence ?? null,
        },
        userAction: "rejected",
        pickedCardId: null,
        corrections: [],
      });
    } catch {
      // swallow — feedback capture is auxiliary
    }
  })();

  // CF-USER-REPUTATION: bump rejection counter (informational — doesn't
  // hurt reputation but tracked for future heuristics).
  void (async () => {
    try {
      const { bumpUserStats } = await import("./userReputation.service.js");
      await bumpUserStats({ userId, rejections: 1 });
    } catch {
      // swallow
    }
  })();

  return { status: "rejected", unlinkedPurchaseId: sourcePurchaseId };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractEbayItemIdFromHolding(doc: any, holdingId: string): string | undefined {
  const holding = doc.holdings?.[holdingId];
  const sourcePurchaseId = holding?.sourcePurchaseId;
  if (!sourcePurchaseId) return undefined;
  const purchase = (doc.purchases ?? []).find((p: any) => p.id === sourcePurchaseId);
  return purchase?.ebayItemId ?? undefined;
}

function extractEbayTitleFromHolding(doc: any, holdingId: string): string | undefined {
  const holding = doc.holdings?.[holdingId];
  const sourcePurchaseId = holding?.sourcePurchaseId;
  if (!sourcePurchaseId) return undefined;
  const purchase = (doc.purchases ?? []).find((p: any) => p.id === sourcePurchaseId);
  return purchase?.notes ?? undefined;
}
