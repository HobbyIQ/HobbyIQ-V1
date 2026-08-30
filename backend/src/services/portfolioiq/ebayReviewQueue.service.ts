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
/**
 * Adopt a catalog row's identity fields onto a holding.
 *
 * EXTRACTED 2026-08-23 so the accept path has ONE definition. It was inline in
 * confirmHoldingReview, reachable only through the pending-review queue — and
 * `cardStatus: "pending-review"` is written in exactly one place, at holding
 * creation, with no route back. So every already-active holding could see a
 * proposed identity and had no way to take it. A second copy of this logic for
 * the new route is precisely the drift that produced two player-name matchers
 * (2fbd1a43) whose difference silently refused 828 sales.
 *
 * `skipFields` is what the caller has already been told by the user. The
 * confirm path passes the edit keys, so a field the user typed is never
 * overwritten by a lookup — they may be correcting the catalog.
 *
 * WHY setName AND product MOVE TOGETHER. The inline version adopted setName
 * alone, while its sibling applyEdit() sets both. That gap is load-bearing:
 * portfolioStore feeds canonicalize `product ?? setName` — product FIRST — so a
 * pick that updated setName and left a stale product meant the NEXT edit
 * re-derived identity from the stale field and could rebind away from the row
 * the user had just chosen. The pick would appear to work and then quietly undo
 * itself.
 *
 * Never throws: a hydrate failure must not cost the caller its write.
 */
export async function applyCatalogIdentityToHolding(
  holding: Record<string, unknown>,
  slug: string,
  opts: { holdingId: string; skipFields?: ReadonlySet<string>; identitySource?: string },
): Promise<{ applied: boolean; corrections: FieldCorrection[] }> {
  const corrections: FieldCorrection[] = [];
  const picked = String(slug ?? "").trim();
  if (!picked.startsWith("hiq:")) return { applied: false, corrections };

  const skip = opts.skipFields ?? new Set<string>();
  try {
    const { readCatalogIdentityBySlug } = await import("../catalog/catalogMatcher.service.js");
    const row = await readCatalogIdentityBySlug(picked);
    if (!row) {
      // A pick that names no catalog row is not an identity. Say so loudly
      // rather than storing a slug nothing resolves.
      console.warn(JSON.stringify({
        event: "holding_identity_pick_not_in_catalog",
        holdingId: opts.holdingId,
        cardId: picked,
      }));
      return { applied: false, corrections };
    }

    const adopt = (field: string, value: unknown) => {
      if (skip.has(field)) return;                 // the user typed it; leave it
      if (value === null || value === undefined) return;
      if (holding[field] === value) return;
      corrections.push({ field, before: (holding[field] ?? null) as never, after: value as never });
      holding[field] = value;
    };
    // Captured BEFORE any adopt() runs. The product gate below compares product
    // against setName, and adopting setName first would change the very value it
    // is compared to — the gate would then never match and product would never
    // move, which is the bug it exists to prevent.
    const productBefore = String(holding.product ?? "").trim();
    const setNameBefore = String(holding.setName ?? "").trim();

    adopt("playerName", row.playerName);
    adopt("cardYear", row.year);
    adopt("setName", row.setName ?? row.setKey);
    // CORRECTED 2026-08-23. This first read `row.setName ?? row.setKey`, mirroring
    // the setName line above — which is wrong for `product`. setName is
    // wire-rendered, and a catalog row's setName can be null, so the fallback
    // would put a machine key ("bowman-draft-picks-and-prospects") in front of a
    // user. setKey is a fine fallback for setName, which is already a key-ish
    // field; it is not one for product.
    //
    // Only adopt product when it is safe to: it currently agrees with setName
    // (so the pair moves together, which is the whole point — portfolioStore
    // feeds canonicalize `product ?? setName`, product FIRST), or it is empty.
    // A product the user set independently is left alone.
    if (row.setName && (!productBefore || productBefore === setNameBefore)) {
      adopt("product", row.setName);
    }
    adopt("cardNumber", row.cardNumber);
    adopt("parallel", row.parallel);
    adopt("isAuto", row.isAuto);
    adopt("sport", row.sport);
    // CF-ACCEPT-CARRIES-PRINTRUN: the slug's :num-N segment is rebuilt from the
    // holding's printRun on the next canonicalize. Adopting the identity without
    // it means the very next PATCH drops the segment and silently undoes the
    // acceptance.
    adopt("printRun", row.printRun);
    holding.identitySource = opts.identitySource ?? "user-selected-catalog";
    holding.identitySelectedAt = new Date().toISOString();
    console.log(JSON.stringify({
      event: "holding_identity_from_catalog_pick",
      holdingId: opts.holdingId,
      cardId: picked,
      identitySource: holding.identitySource,
      fieldsAdopted: corrections.length,
    }));
    return { applied: true, corrections };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "holding_identity_hydrate_failed",
      holdingId: opts.holdingId,
      error: (err as Error)?.message ?? String(err),
    }));
    return { applied: false, corrections };
  }
}

/**
 * CF-ONE-IMPORT-ONE-IDENTITY (Drew, 2026-08-29, checklist D9). The slug the
 * catalog verification stamps on a holding.
 *
 * verifyCardIdentity answers "is this card NUMBER on this player's rows for
 * this set" and returns the id of whichever row matched -- ANY parallel of
 * that number. So a holding pinned at import to the Gold Refractor /50 was
 * stamped catalogVerifiedSlug ...:gold-refractor:auto (or any sibling), a
 * second identity beside its cardId. When the verification confirms the
 * number and the holding already carries a canonical pin, the pin IS the
 * verified slug: it names the same card, with the parallel and print run the
 * number-only lookup cannot see.
 */
export function verifiedSlugFor(
  pinnedCardId: string | null | undefined,
  v: { verified: boolean | null; matchedSlug?: string | null },
): string | null {
  const pinned = String(pinnedCardId ?? "").trim();
  if (v.verified === true && pinned.startsWith("hiq:")) return pinned;
  return v.matchedSlug ?? null;
}

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

  // CF-SELECTED-CARD-IS-THE-IDENTITY (Drew, 2026-08-23: "i want the SEARCH
  // function to find the card to match it. Not the edit card feature. That
  // search then gets selected and edits the card to the catalog match").
  //
  // When the user searches the catalog and picks a card, that pick IS the
  // identity — there is nothing left to infer. Automated matching already gets
  // three attempts before this point (import-time canonicalize at >=0.9, a
  // cached suggestion, and a synchronous suggester at >=0.55), and the cards
  // that reach a human are the ones where all three failed. Measured on the
  // three stranded in prod, they failed for the same reason: the card IS in the
  // catalog, under several parallels, and only the person holding it knows
  // which one. #CPA-MWI Max Williams is base:auto:num-15 and four others.
  //
  // Until now a pick stamped the slug and nothing else, leaving the holding's
  // own setName/parallel/cardNumber saying whatever the eBay title parse
  // produced. A row whose fields disagree with its slug is the Theo Gillen
  // defect — 8,412 catalog rows measured with exactly that split, and it prices
  // the card off a pool it does not belong to.
  //
  // So: adopt the catalog row's fields. An explicit edit in the SAME request
  // still wins — the user may be correcting the catalog, and their typing is
  // never overwritten by a lookup.
  const pickedCardId = String((edits as Record<string, unknown>).cardId ?? "").trim();
  if (pickedCardId.startsWith("hiq:")) {
    const adopted = await applyCatalogIdentityToHolding(
      holding as Record<string, unknown>,
      pickedCardId,
      { holdingId, skipFields: new Set(Object.keys(edits)) },
    );
    corrections.push(...adopted.corrections);
  }

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
      // CF-CONFIRM-USES-THE-ONE-PIN-GATE (2026-08-30, D35). This block used
      // to reimplement the >= 0.9 gate inline and write ONLY h.cardId — the
      // identifier `hobbyiqCardId` did not appear anywhere in this file. So
      // seven of Drew's holdings sat at 0.95-0.98, comfortably above the
      // gate, with NO hobbyiqCardId: no guard refused them, a second code
      // path simply never wrote the field, and every reader that keys on
      // hobbyiqCardId (conform, priceFromOurPool) found nothing. That is the
      // two-rival-gates shape, third copy. There is now ONE gate:
      // applyCatalogMatchToHolding writes both fields, applies
      // ADD_SLUG_OVERRIDE_MIN_CONFIDENCE and the checklist-authority rule,
      // and parks below either as catalogMatchSlug — the same proposal
      // fields this block already wrote.
      if (match) {
        const { applyCatalogMatchToHolding } = await import("./portfolioStore.service.js");
        const pin = await applyCatalogMatchToHolding(
          holding as never,
          {
            slug: String(match.slug ?? ""),
            found: Boolean(match.found),
            confidence: Number(match.confidence ?? 0),
            matchedBy: String(match.matchedBy ?? ""),
          },
          {
            source: "ebayReviewQueue.confirmHolding",
            userId,
            holdingId,
            cardIdRule: "fill",
          },
        );
        if (pin.pinned) h.cardIdSetOnConfirm = true;
      }
    } catch {
      // Never fail an approval because the matcher was unavailable — the
      // holding still activates, just without an identity link.
    }
  }

  if ((holding as any).cardId) {
    // CF-VERIFIED-IS-CHECKLIST-BACKED at Confirm (2026-08-30, D35). This used
    // to read `identityVerified = true` on nothing more than cardId being
    // truthy — any string at all. Holding 277b05a3 (Cal Ripken) has no
    // setName, no cardNumber and no parallel, a raw CardHedge id in cardId,
    // and reads VERIFIED; so does every holding pinned to a self-seeded
    // vendor row. The flag was therefore useless as a signal of which
    // holdings still need work. VERIFIED now means the same thing here that
    // it means to conform-holdings-to-catalog and to the add/update paths:
    // the identity names a checklist-backed catalog row. A holding that is
    // merely confirmed still activates and still keeps its cardId — it just
    // is not claimed to be verified.
    {
      const { stampChecklistBackedIdentity, readCatalogRowSource } = await import("./checklistBackedIdentity.js");
      const outcome = await stampChecklistBackedIdentity(
        holding as unknown as Record<string, unknown>,
        readCatalogRowSource,
        { via: "ebayReviewQueue.confirmHolding" },
      );
      if (outcome !== "stamped" && outcome !== "already-verified") {
        console.log(JSON.stringify({
          event: "confirm_identity_not_verified",
          source: "ebayReviewQueue.confirmHolding",
          userId, holdingId,
          cardId: String((holding as any).cardId ?? "").slice(0, 80),
          hobbyiqCardId: String((holding as any).hobbyiqCardId ?? "") || null,
          outcome,
          detail: "confirmed and active, but the identity is not a checklist-backed catalog row",
        }));
      }
    }
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
        const verifiedSlug = verifiedSlugFor(String((holding as any).cardId ?? ""), v);
        if (verifiedSlug) (holding as any).catalogVerifiedSlug = verifiedSlug;
        if (v.candidateNumbers?.length) (holding as any).catalogCandidateNumbers = v.candidateNumbers;
        if (v.seedRequested) (holding as any).catalogSeedRequested = true;
        (holding as any).catalogVerifiedAt = new Date().toISOString();
      } catch { /* soft: verification is nice-to-have */ }
    }
    // CF-ONLY-CHECKLISTS-MINT (Drew, 2026-08-29; catalog rebuild D5). The
    // CF-USER-VERIFIED-CATALOG-FLYWHEEL block (2026-08-03) that lived here
    // upserted a card_catalog row at "user-verified:<sha256>" -- a second,
    // hash-id copy of the same event the canonical seed path already handles
    // ("user-verified" is in USER_SEED_SOURCES; soldCompsStore ->
    // ensureCatalogRow -> upsertCatalogEntry, id === hiq slug). Removed.
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
    // CF-ONE-TRANSACTION-ONE-ROW (D9). This re-emit used to key the sale by
    // the eBay ITEM id at the all-in cost, while the import had keyed the same
    // purchase by the ORDER id at the subtotal -- two rows for one sale. The
    // one derivation (purchaseSaleIdentity) is shared with the import and the
    // rematch, so this lands on the row the import wrote and upgrades it to
    // user-verified.
    const { purchaseSaleIdentity, sourcePurchaseFor } = await import("./ebayAutoHolding.service.js");
    const sourcePurchase = sourcePurchaseFor(doc, holding);
    const { sourceExternalId, price } = purchaseSaleIdentity(sourcePurchase, holding as Record<string, unknown>);
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
            printRun: typeof (holding as any).printRun === "number" ? (holding as any).printRun : null,
            gradeCompany: (holding as { gradeCompany?: string | null }).gradeCompany ?? null,
            gradeValue: (holding as { gradeValue?: number | null }).gradeValue ?? null,
            price,
            soldAt,
            source: "ebay-user-purchase",
            sourceExternalId,
            contributorUserId: userId,
            // The listing title, not the rebuilt card title: the pool's title
            // is provenance, and the rebuilt one once dropped the /50.
            title: extractEbayTitleFromHolding(doc, holdingId) ?? (holding as any).cardTitle ?? null,
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
