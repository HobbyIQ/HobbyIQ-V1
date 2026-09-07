// CF-ONE-WAY-TO-MOVE-A-CATALOG-ROW (Drew, catalog rebuild D5, 2026-08-29).
//
// A census found 15 scripts that MOVE a card_catalog row -- rename a setKey,
// clean a parallel name, fix a card number, fold onto a twin, re-point the
// sales, delete the old row. One shape, copied 15 times, with four real
// defects spread across the copies:
//
//   1. six of the seven setKey rewrites carried the OLD set's searchTokens
//      through `...rest`, so the moved row kept answering searches for the
//      set it had just left;
//   2. none rebuilt searchText or displayName;
//   3. none unioned vendorIds on a fold -- a cross-reference silently lost
//      every time a twin absorbed a row;
//   4. five of seven never retired the graded children
//      (`STARTSWITH(c.id, id + ":") AND IS_DEFINED(c.gradeTier)`), which were
//      left pointing at a deleted parent; and five did no authority check at
//      all (write only `if (!existing)`), so a DERIVED incumbent beat an
//      incoming CHECKLIST row -- exactly the failure cardCatalog.service
//      documents under CF-THE-CLEANEST-ONE-WINS.
//
// Two of them also re-declared a local CHECKLIST_SOURCE regex that had drifted
// from catalogAuthority.service. This module is the one shape. Scripts keep
// their own client, sharding, budget and retry, and hand the containers in.
//
// ORDER IS THE INVARIANT. Copy before delete, sales before delete:
//
//   1. the survivor is written at newSlug          (a row exists to point at)
//   2. sold_comps rows at the old slug are re-pointed
//   3. graded children of the OLD slug are retired  (regenerable from the parent)
//   4. the old row is deleted LAST
//
// so at every instant every sale points at a row that exists. A crash between
// any two steps leaves a duplicate identity, never a dangling sale.
//
// Builders reused rather than re-spelled:
//   searchText / searchTokens  searchIndexing.service (buildSearchText, buildSearchTokens)
//   displayName                canonicalCardName (CF-ONE-NAME-FORMAT-FOR-EVERY-CARD)
//   parallelSlug / playerSlug  deriveCatalogEntry when it agrees with newSlug,
//                              else the slug's own segments + slugify
//   brand / parentSetKey       deriveBrand / deriveParentSetKey on a setKey change
//   authority                  authorityRank (catalogAuthority.service)

import type { Container, PatchOperation, SqlQuerySpec } from "@azure/cosmos";
import { deriveCatalogEntry, type CardCatalogEntry } from "../portfolioiq/cardCatalog.service.js";
import {
  deriveBrand,
  deriveParentSetKey,
  parseHobbyIqCardId,
  slugify,
  type HobbyIqCardIdComponents,
} from "../portfolioiq/hobbyIqCardId.service.js";
import { buildSearchText, buildSearchTokens } from "../portfolioiq/searchIndexing.service.js";
import { authorityRank } from "./catalogAuthority.service.js";
import { canonicalCardName } from "./canonicalCardName.js";
import { productAncestry } from "./productSetKeys.js";
import { corroborationOf, type CorroborationRow } from "./sourceCorroboration.js";

/** A catalog row as it comes back from Cosmos: the typed fields plus whatever
 *  else the writer stamped on it. Extra fields travel with the row. */
export type CatalogRowDoc = CardCatalogEntry & Record<string, unknown>;

/** Scripts keep their own retry (429/timeout backoff). Every Cosmos call this
 *  module makes goes through it; the default is no retry at all. */
export type CatalogOpsRetry = <T>(fn: () => Promise<T>) => Promise<T>;
const noRetry: CatalogOpsRetry = (fn) => fn();

export type MoveCatalogRowAction = "move" | "fold" | "replace" | "noop" | "refused";

/**
 * The evidence a caller has already gathered about WHO holds a card number,
 * handed to the survivor rule so it can settle a different-player collision
 * without doing I/O of its own (CF-DO-NOT-LOOK-TWICE).
 *
 * Two arms, and either one is enough:
 *
 *   `rivals`  the other catalog rows at this identity cell, for
 *             `corroborationOf` -- a second STRICT source that names the same
 *             player is the strongest evidence there is;
 *   `titlePlayerCounts`  the refereeing the audit already did: for the card
 *             number under dispute, how many sold_comps titles name each
 *             player. The market's majority is the second arm.
 */
export interface PlayerEvidence {
  /** Catalog rows at the same identity cell, from either side. Passed straight
   *  to `corroborationOf`. */
  rivals?: readonly CorroborationRow[] | null;
  /** playerName -> number of refereed sale titles at THIS card number. Keys are
   *  compared by `playerKeyOf`, so punctuation never splits a person. */
  titlePlayerCounts?: Readonly<Record<string, number>> | null;
}

export interface MoveCatalogRowOptions {
  /** Stamped on every re-pointed sale (`reslugedReason`) and on the moved row
   *  (`movedReason`). Required: a move with no reason is a move nobody can
   *  audit. */
  reason: string;
  /** CF-A-FOLD-NEVER-CHANGES-THE-PLAYER. What the caller knows about who holds
   *  this card number, for the different-player arbitration. Omitted means
   *  "I gathered nothing", and a different-player collision is then REFUSED --
   *  never folded on the tiebreak ladder. */
  playerEvidence?: PlayerEvidence | null;
  /** Also stamp `normalizedSetKey` on re-pointed sales with the survivor's
   *  setKey. Set on setKey renames; leave off for parallel/number moves. */
  repointNormalizedSetKey?: boolean;
  /** Read everything, write nothing, return the counts a real run would. */
  dryRun?: boolean;
  /** sold_comps. Omit only when the caller KNOWS no sale points at the old
   *  slug; the decision string says so when it was omitted. */
  salesContainer?: Container;
  /** The incumbent at newSlug when the caller already looked (including
   *  `null` for "I checked, it is not there"). Same contract as
   *  upsertCatalogEntry's `known` -- CF-DO-NOT-LOOK-TWICE. */
  known?: CatalogRowDoc | null;
  retry?: CatalogOpsRetry;
}

export interface MoveCatalogRowResult {
  /** move: nothing was at newSlug. replace: the incoming row won the
   *  collision. fold: the incumbent won and absorbed the old row. noop:
   *  newSlug is the row's own id. refused: the two rows name DIFFERENT PLAYERS
   *  and nothing corroborates either -- NOTHING WAS WRITTEN. */
  action: MoveCatalogRowAction;
  newSlug: string;
  salesRepointed: number;
  gradedChildrenRetired: number;
  /** Whose fields now sit at newSlug. `null` on a noop and on a REFUSAL. */
  survivor: "incoming" | "incumbent" | null;
  /** Why -- the "say what you chose" line, in words a script can print. */
  decision: string;
  /** Set on `action: "refused"` only: the two names the caller must settle,
   *  so a report can list the pair without re-reading either row. */
  refusal?: {
    reason: "different-player-uncorroborated";
    incomingPlayer: string | null;
    incumbentPlayer: string | null;
  };
  /** Set when a fold or replace was decided by CORROBORATION rather than by
   *  the tiebreak ladder -- the loser named a different player and lost on
   *  evidence. The losing row is retired by MARKER, never deleted, and the
   *  caller stamps it: this names which side lost and why. */
  playerArbitration?: {
    winner: "incoming" | "incumbent";
    /** How the winner was corroborated. */
    by: "second-source" | "sale-titles";
    winningPlayer: string | null;
    losingPlayer: string | null;
    detail: string;
  };
}

export interface RetireCatalogRowOptions {
  dryRun?: boolean;
  retry?: CatalogOpsRetry;
}

export interface RetireCatalogRowResult {
  /** noop: neither the row nor any graded child existed. */
  action: "retire" | "noop";
  id: string;
  rowDeleted: boolean;
  gradedChildrenRetired: number;
  /** Carried back for the caller's log line. A delete has no fields, so
   *  nothing in Cosmos records it -- and nothing is stamped on the sales:
   *  the rematch owns unplaced sales. */
  reason: string;
}

// ── field hygiene ────────────────────────────────────────────────────────────

/** Cosmos system properties. Never copy them onto a new document. */
const SYSTEM_FIELDS = ["_rid", "_self", "_etag", "_attachments", "_ts"] as const;

/** Annotations that describe the SLUG, not the card: whether THIS id is
 *  checklist-backed. True of the old address, meaningless at the new one, and
 *  annotate-checklist-backing re-derives them. Both reference movers strip
 *  these; the helper does the same so a moved row cannot claim a backing it
 *  was never measured for. */
const SLUG_BOUND_FIELDS = ["checklistBacking", "checklistBackingAt", "checklistFamilySetKeys"] as const;

function stripSystemFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of SYSTEM_FIELDS) delete out[k];
  return out;
}

function stripSlugBoundFields(row: Record<string, unknown>): Record<string, unknown> {
  const out = stripSystemFields(row);
  for (const k of SLUG_BOUND_FIELDS) delete out[k];
  return out;
}

/** Earliest of several ISO timestamps, ignoring blanks. Lexical order IS
 *  chronological order for ISO-8601 strings in one timezone. */
function earliest(...stamps: Array<unknown>): string | undefined {
  const xs = stamps.filter((s): s is string => typeof s === "string" && s.length > 0).sort();
  return xs[0];
}

// ── the searchable fields ────────────────────────────────────────────────────

/**
 * searchText / searchTokens / displayName for a row, from the row's own
 * identity fields. The field mapping is the canonical-row shape that
 * scripts/comp-quality/searchTokenBuilders.cjs (the nightly backfill and the
 * coverage canary) reads: player, setName, setKey with hyphens as spaces,
 * cardNumber, year, the parallel unless it is Base, and the parallelSlug's
 * words. Same spelling, so a moved row is not "stale" to the canary.
 *
 * Exported so an in-place heal (a row whose slug did not change but whose
 * name text did) can rebuild the same three fields the same way.
 */
export function rebuildSearchFields(row: {
  sport?: string | null;
  year?: number | null;
  setKey?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
  parallel?: string | null;
  parallelSlug?: string | null;
  printRun?: number | null;
  subsetName?: string | null;
}): { searchText: string; searchTokens: string[]; displayName: string } {
  const setKey = String(row.setKey ?? "").trim();
  const parallel = String(row.parallel ?? "").trim();
  const parallelSlug = String(row.parallelSlug ?? "").trim();
  const searchText = buildSearchText({
    player: row.playerName ?? null,
    setName: row.setName ?? null,
    set: setKey ? setKey.replace(/-/g, " ") : null,
    number: row.cardNumber ?? null,
    year: row.year ?? null,
    variant: parallel && parallel.toLowerCase() !== "base" ? parallel : null,
    attributes: parallelSlug && parallelSlug !== parallel ? [parallelSlug.replace(/-/g, " ")] : null,
  });
  return {
    searchText,
    searchTokens: buildSearchTokens(searchText),
    displayName: canonicalCardName({
      year: row.year ?? null,
      setName: row.setName ?? null,
      setKey,
      sport: row.sport ?? null,
      cardNumber: row.cardNumber ?? null,
      playerName: row.playerName ?? null,
      parallel: parallel || null,
      printRun: typeof row.printRun === "number" ? row.printRun : null,
      subsetName: row.subsetName ?? null,
    }),
  };
}

// ── the incoming row ─────────────────────────────────────────────────────────

/**
 * The setKey segment of an hiq id -- `split(":")[3]`, the same rule
 * consolidate-catalog-duplicates' `kindOf` uses to measure id/field drift.
 * CF-THE-ID-CARRIES-THE-PRODUCT: the id is what names the product.
 */
function idSetKeySegment(id: unknown): string {
  return String(id ?? "").split(":")[3] ?? "";
}

/**
 * Is the row's setKey FIELD strictly more specific than the id STEM -- i.e. is
 * the field a named release *of* the stem's product?
 *
 * Two arms, because the catalog's products outrun the table:
 *
 *   the LADDER -- `productAncestry(field)` contains the stem, the repo's own
 *   notion of "extends" (`topps-finest-flashbacks` -> topps-finest -> topps);
 *
 *   the LEXICAL extension -- `field.startsWith(stem + "-")`, which is what
 *   catches the products PRODUCT_SET_KEYS does not spell yet and which are the
 *   bulk of the live drift: `topps-baseball-japan-edition` over stem `topps`
 *   (164 of 913 sampled), `topps-flagship` (99), `topps-chrome-logofractor-
 *   edition` over `topps-chrome` (73), `topps-transcendent-collection` (59),
 *   `topps-stadium-club-chrome` (50). The table answers `ancestry = [itself]`
 *   for every one of them.
 *
 * Deliberately NOT more specific, and each one measured live:
 *   field `bowman` over stem `bowman-chrome` -- the field is the GENERIC one,
 *     the drift this module set out to correct (138 sampled);
 *   field `donruss-optic` over stem `panini-optic` (73) -- a rival SPELLING,
 *     not a release of it; neither arm fires and the stem wins, which is what
 *     the era spelling policy wants;
 *   field `bowman-sapphire` over stem `bowman-chrome-sapphire` (26) -- a
 *     sibling, unrelated on both arms.
 */
function fieldExtendsStem(field: string, stem: string): boolean {
  if (!field || !stem || field === stem) return false;
  if (productAncestry(field).includes(stem)) return true;
  return field.startsWith(`${stem}-`);
}

/**
 * The old row as it should exist at newSlug: id fields from the slug, the
 * derived fields re-derived, the searchable fields rebuilt, the slug-bound
 * annotations dropped. Pure -- no I/O -- and it THROWS when the two SLUGS
 * disagree about the product, because a cross-product move is not a move:
 * bowman-chrome and bowman-chrome-sapphire are different cards and must never
 * be merged onto one address.
 *
 * CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT (D30 R2, 2026-08-31). The guard used to
 * compare newSlug's setKey against the row's setKey FIELD, and that field is
 * NOT reliably the product.
 *
 * WHERE THE DRIFT COMES FROM -- measured, not assumed. It is NOT minted:
 * deriveCatalogEntry sets `setKey: parsedSlug[3]` from the slug it has just
 * computed, so field == stem ALWAYS at mint, for every combination of
 * `authoritativeSetKey` (which keeps the caller's spelling in the SLUG, and so
 * in the field with it -- it does not split the two). The drift is written
 * LATER: field-only updates and older minters that predate the
 * one-constructor rule, and it runs in BOTH directions. A read-only probe of
 * card_catalog (60,000 of 15,997,198 hiq rows, 2026-08-31) found 913 drifted,
 * 1.52%, ~243k extrapolated:
 *
 *   field MORE specific than the stem   568   topps-baseball-japan-edition
 *                                             over stem topps (164),
 *                                             topps-flagship (99),
 *                                             topps-chrome-logofractor-edition
 *                                             over topps-chrome (73)
 *   stem MORE specific than the field   167   field bowman over stem
 *                                             bowman-chrome / bowman-paper
 *   unrelated                           178   donruss-optic vs panini-optic
 *
 * and the sources are the highest-authority rows we have (checklistcenter 467,
 * checklistinsider 357, beckett-checklist 41). So the FIRST group is the
 * majority, and it is exactly the group a "field follows the stem" rewrite
 * would destroy.
 *
 * THE GUARD asks "did the caller ASK to change the product?", because that is
 * what separates the two populations the field comparison confused:
 *
 *   a FOLD / renumber / parallel fix passes no setKey (`{ printRun: 499 }`,
 *   `{ cardNumber }`): the product must NOT change, so newSlug's stem must
 *   equal the OLD ID's stem -- whatever the drifted field says;
 *
 *   a RENAME passes the product it is moving to (`{ setKey: TO }` --
 *   rename-setkey, apply-setkey-rulings, apply-cpa-product-rule,
 *   rename-setkey-to-product all do): the stem is allowed to change, and
 *   newSlug's stem must equal the setKey the caller ASKED for, so a slug that
 *   lands on some third product is still refused.
 *
 * Either way a cross-product move stays impossible: nothing can silently carry
 * a row from bowman-chrome to bowman-chrome-sapphire, and sapphire never
 * merges. Only the field mismatch stops blocking.
 *
 * THE FIELD WRITE ONLY IMPROVES (feedback_slug_recompute_only_improve: rewrite
 * only when strictly MORE specific). On a fold, a field that EXTENDS the stem
 * is the better identity and is kept VERBATIM -- brand and parentSetKey with
 * it, and searchText is never rebuilt off an identity we just demoted. Only a
 * field that is stale-generic, equal, or unrelated to the stem is replaced by
 * the stem. A rename is a ruling and always lands on what it asked for.
 */
/**
 * Parse a slug that may be a GRADED CHILD.
 *
 * `parseHobbyIqCardId` deserializes the CARD identity, and a graded child is
 * not one: its id is `${parentSlug}:${tier}` (catalogRowOps' own contract,
 * `isGradedChildOf` above) and the tier segment is not part of the card-id
 * grammar, so the parser correctly returns null for it. That is right for the
 * parser and wrong for a MOVE, which is why all 292 Crown Zenith Galarian
 * Gallery rows failed their apply on 2026-09-07 with "newSlug is not a hiq
 * slug: hiq:pokemon:2023:swsh12-5gg:gg01:full-art:no-auto:cgc-10" -- every one
 * a graded child, every destination well-formed.
 *
 * moveCatalogRow ALREADY knows this shape: it queries for graded children by
 * `STARTSWITH(c.id, parent + ":") AND IS_DEFINED(c.gradeTier)` and retires
 * them. It could sweep a graded child up but never move one, which is not a
 * position anyone chose.
 *
 * THE SPLIT USES THE RULE ALREADY WRITTEN DOWN, verbatim from
 * `isGradedChildOf`: a tier is ONE segment and never the print-run segment --
 * `psa-10` yes, `num-50` no. So the tail is only taken when the head parses as
 * a card on its own; nothing else can be reinterpreted as a grade, and a slug
 * that is simply malformed still returns null and still throws.
 *
 * `parseHobbyIqCardId` itself is deliberately NOT loosened: 61 call sites read
 * it, including the matcher's hot path, and a 292-row cleanup does not get to
 * widen the id grammar for all of them.
 */
function parseSlugWithGrade(slug: string): { parsed: HobbyIqCardIdComponents; parentSlug: string; gradeTier: string | null } | null {
  const direct = parseHobbyIqCardId(slug);
  if (direct) return { parsed: direct, parentSlug: slug, gradeTier: null };
  const cut = slug.lastIndexOf(":");
  if (cut <= 0) return null;
  const head = slug.slice(0, cut);
  const tier = slug.slice(cut + 1);
  // A tier is one segment (guaranteed by the lastIndexOf split), is not the
  // print-run segment, and is not empty.
  if (!tier || tier.startsWith("num-")) return null;
  const parsed = parseHobbyIqCardId(head);
  if (!parsed) return null;
  return { parsed, parentSlug: head, gradeTier: tier };
}

function buildIncoming(
  oldRow: CatalogRowDoc,
  newSlug: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
): CatalogRowDoc {
  const merged = { ...stripSlugBoundFields(oldRow), ...changedFields } as CatalogRowDoc;
  const split = parseSlugWithGrade(newSlug);
  if (!split) throw new Error(`moveCatalogRow: newSlug is not a hiq slug: ${newSlug}`);
  const { parsed, gradeTier } = split;
  // A GRADED CHILD MOVES WITH ITS PARENT, and stays a graded child: the row is
  // only a graded identity because `gradeTier` is defined and `parentSlug`
  // points at the card. Moving it to a new address re-points both -- the
  // parent is the destination's own head, never the one it used to have, or
  // the child would be orphaned onto the row we just vacated.
  const oldGrade = parseSlugWithGrade(String(oldRow.id));
  if (Boolean(gradeTier) !== Boolean(oldGrade?.gradeTier)) {
    throw new Error(
      `moveCatalogRow: ${gradeTier ? "a card cannot move onto a graded address" : "a graded child cannot move onto a card address"} (${String(oldRow.id)} -> ${newSlug})`,
    );
  }
  const oldIdSetKey = idSetKeySegment(oldRow.id);
  // Did the caller ASK for a product change? Only an explicit `setKey` in
  // changedFields does that; a fold passes printRun / cardNumber and means
  // "same product, new address".
  const askedSetKey = Object.prototype.hasOwnProperty.call(changedFields, "setKey")
    ? String(changedFields.setKey ?? "").trim()
    : null;
  const expected = askedSetKey === null ? oldIdSetKey : askedSetKey;
  if (parsed.setKey !== expected) {
    throw new Error(
      askedSetKey === null
        ? `moveCatalogRow: newSlug says setKey "${parsed.setKey}" but the row's id says "${oldIdSetKey}" (${String(oldRow.id)} -> ${newSlug}) and no setKey change was asked for -- a cross-product move is not a move`
        : `moveCatalogRow: newSlug says setKey "${parsed.setKey}" but the caller asked for "${askedSetKey}" (${String(oldRow.id)} -> ${newSlug}) -- a cross-product move is not a move`,
    );
  }
  // ONLY-IMPROVE. On a FOLD the caller named no product, so the row's own
  // field gets to keep the argument: when it EXTENDS the new stem
  // (topps-baseball-japan-edition over topps) it is the more specific
  // identity and survives verbatim. Otherwise -- stale-generic (field
  // "bowman", stem "bowman-chrome"), equal, or unrelated -- the stem is the
  // better answer and the field is corrected to it. A RENAME asked for a
  // product by name, and a ruling always lands where it was aimed.
  // Read the ROW's own field, not `merged.setKey` -- on a rename the merge has
  // already overwritten it with the asked-for key, so `merged` cannot tell the
  // two lanes apart.
  const rowSetKey = String(oldRow.setKey ?? "").trim();
  const keepField = askedSetKey === null && fieldExtendsStem(rowSetKey, parsed.setKey);
  const setKey = keepField ? rowSetKey : parsed.setKey;

  const playerName = merged.playerName ? String(merged.playerName).trim() || null : null;
  const cardNumber = String(merged.cardNumber ?? "").trim().toUpperCase();
  const parallel = String(merged.parallel ?? "Base");
  const printRun = typeof merged.printRun === "number" && Number.isFinite(merged.printRun)
    ? merged.printRun
    : parsed.printRun ?? null;

  // deriveCatalogEntry is the canonical constructor; use its derived fields
  // whenever the slug it computes IS newSlug. It applies the slug generator's
  // vocabulary (Colour = Refractor on chrome stock, the auto-only prefixes),
  // so it can disagree with a caller-supplied ruling -- and the caller
  // carries the ruling. When it disagrees, or the row has no player (8.4% of
  // the catalog), the slug's own segments are the derivation.
  // ...and it is derived off the STEM, which is what newSlug is actually
  // spelled with -- never off a kept extending field, which would mint a
  // different id, fail `agrees`, and throw the derivation away for exactly the
  // rows we are protecting.
  const derived = playerName
    ? deriveCatalogEntry({
        sport: String(merged.sport ?? ""),
        year: parsed.year,
        setKey: parsed.setKey,
        cardNumber,
        parallel,
        isAuto: parsed.isAuto,
        printRun,
        playerName,
        source: String(merged.source ?? ""),
        confidence: Number(merged.confidence ?? 0),
        authoritativeSetKey: true,
      })
    : null;
  const agrees = derived !== null && derived.id === newSlug;
  const parallelSlug = agrees ? derived.parallelSlug : parsed.parallel;
  const playerSlug = agrees
    ? derived.playerSlug
    : playerName ? slugify(playerName) : (typeof merged.playerSlug === "string" ? merged.playerSlug : null);
  // brand / parentSetKey are functions of the setKey we are about to WRITE.
  // Re-derive when that differs from the stem the row came from, OR when the
  // field is being corrected off a drifted one (field "bowman", stem
  // "bowman-chrome": brand/parentSetKey were computed from the old field).
  // Both clauses are load-bearing and neither implies the other:
  //   stem-only  -- a rename whose asked-for product differs from the old stem
  //                 but happens to equal the old FIELD (field "bowman-chrome",
  //                 stem "bowman", renamed to "bowman-chrome"): the field
  //                 clause is false, the product still moved;
  //   field-only -- a fold that corrects a stale-generic field, where the stem
  //                 never moved at all.
  // When we KEEP an extending field the identity did not change at all, so
  // brand / parentSetKey are left exactly as the checklist left them --
  // deriveBrand would flatten `topps-baseball-japan-edition` to `topps` and
  // throw away the very specificity this branch exists to protect.
  const setKeyChanged = !keepField
    && (setKey !== oldIdSetKey || setKey !== String(oldRow.setKey ?? "").trim());

  const doc: CatalogRowDoc = {
    ...merged,
    id: newSlug,
    cardId: newSlug,
    hobbyiqCardId: newSlug,
    setKey,
    cardNumber,
    parallel,
    parallelSlug,
    playerName,
    playerSlug,
    // CF-YEAR-CARDYEAR-DUAL-WRITE: both names, always.
    year: parsed.year,
    cardYear: parsed.year,
    // The slug's segment 6 IS the auto boundary; a row field that disagrees
    // with its own id is the stale one.
    isAuto: parsed.isAuto,
    printRun,
    ...(setKeyChanged ? { brand: deriveBrand(setKey), parentSetKey: deriveParentSetKey(setKey) } : {}),
    // The graded annotations follow the address, so the child hangs off the
    // card it actually moved to.
    ...(gradeTier ? { parentSlug: split.parentSlug, gradeTier: merged.gradeTier ?? gradeTier } : {}),
  };
  Object.assign(doc, rebuildSearchFields(doc));
  return doc;
}

/**
 * The row as it should exist in its OWN partition (a rehome: same slug,
 * foreign `cardId`). Nothing about the card changes, so nothing derived is
 * rebuilt and the slug-bound annotations stay -- they still describe this
 * slug. The old partition key was a vendor id for 17.7M rows
 * (CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW) and a CH lookup
 * resolves by it, so it is kept under the row's source in vendorIds.
 */
function rehomeIncoming(
  oldRow: CatalogRowDoc,
  oldPk: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
): CatalogRowDoc {
  const doc = { ...stripSystemFields(oldRow), ...changedFields, cardId: String(oldRow.id) } as CatalogRowDoc;
  if (!oldPk.startsWith("hiq:")) {
    const k = String(oldRow.source ?? "vendor");
    const vendorIds = { ...(doc.vendorIds ?? {}) };
    if (!vendorIds[k]) vendorIds[k] = oldPk;
    doc.vendorIds = vendorIds;
  }
  return doc;
}

// ── the collision ────────────────────────────────────────────────────────────

function salesCounter(row: CatalogRowDoc): number {
  if (typeof row.compCount === "number") return row.compCount;
  if (typeof row.observedCompCount === "number") return row.observedCompCount;
  return 0;
}

/**
 * A player name reduced to the letters and digits that identify it, so
 * "T.J. Hockenson" and "TJ Hockenson" are one person and a punctuation
 * difference is never a disagreement. The same reduction sourceCorroboration
 * uses, deliberately: two spellings of one predicate is the bug this repo has
 * already paid for twice.
 */
function playerKeyOf(name: unknown): string {
  return String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * CF-A-FOLD-NEVER-CHANGES-THE-PLAYER (Drew, 2026-09-05 — the donruss-optic
 * arbitration).
 *
 * THE DEFECT. `chooseSurvivor` ranks source authority, then vendorIds, then
 * sales, then confidence, then "the incumbent keeps its address". It never
 * compares `playerName`. So when two transcriptions of one printed checklist
 * put DIFFERENT PLAYERS at the same (number, parallel), the ladder settles it
 * on a criterion that has nothing to do with who is on the card — and the
 * loser's row is ABSORBED, silently, with no marker and no report.
 *
 * MEASURED, not hypothesised. football/2024 donruss-optic, read-only
 * 2026-09-05: of 186 alias->destination twin pairs, 181 (97.3%) name a
 * different player at a BYTE-IDENTICAL parallel. Both sides classify CHECKLIST
 * rank 3 (`hobbymonitor` sits in that regex beside `checklistinsider`), so
 * authority ties, vendorIds tie, sales tie, confidence ties, and all 186 fold
 * to the incumbent. The incumbent is `hobbymonitor`, and refereed against real
 * sold_comps titles it is the side the market CONTRADICTS: alias 24 numbers,
 * dest 5. #1795 found the same source wrong-player-prone in panini-score, with
 * the polarity flipped — there hobbymonitor was the incoming row.
 *
 * That the polarity flips is the whole point. A rule that said "hobbymonitor
 * loses" would be a rule about one source's position in one dispatch, and it
 * would have been RIGHT in #1795 and WRONG here. The durable rule is about
 * EVIDENCE.
 *
 * THE RULE. A different-player collision is not a tiebreak. It is a
 * CONTRADICTION, and contradictions are settled by corroboration or not at all:
 *
 *   1. a SECOND STRICT SOURCE at the identity cell that names one side's
 *      player — this is `corroborationOf` verbatim, the predicate
 *      sourceCorroboration.ts already owns, and NOT a second rule spelling the
 *      same question differently (that mistake cost 51 card-number prefixes and
 *      baseballcardpedia's 918,828 rows, both recorded in catalogAuthority's
 *      header);
 *   2. failing that, the SALE TITLES' majority at that card number — the
 *      refereeing the audit already did, handed in rather than re-derived.
 *
 * A row whose player a second source CONTRADICTS loses, whichever side of the
 * move it is on. `corroborationOf` returns `player-disagrees` for exactly that,
 * and `checklistBacked: false` with it.
 *
 * WHEN NEITHER SIDE IS CORROBORATED, REFUSE BY NAME. Not "keep the incumbent",
 * which is the defect; not "prefer the newer scrape", which is a coin toss
 * wearing a reason. The pair is reported with both names and NOTHING IS
 * WRITTEN — no upsert, no sale re-pointed, no graded child retired, no delete.
 * CF-ABSENT-BEATS-WRONG: an unmoved row is a row a human can still adjudicate;
 * a folded one has already lost its rival's fields.
 *
 * A CONTRADICTION DISQUALIFIES THE ROW, NOT THE CARD (Drew). The losing copy is
 * retired by MARKER and never deleted — `moveCatalogRow`'s existing order does
 * that already for the fold case (the loser's sales are re-pointed to the
 * survivor before its row goes), and `playerArbitration` on the result names
 * the loser so the caller can stamp it and a reader can find it later.
 *
 * WHY THIS LIVES IN chooseSurvivor AND NOT IN THE SCRIPT. `RETIRE_UNTWINNED`
 * guards the MOVE branch in rekey-product-setkey and NOTHING guards FOLD, in
 * that script or any other caller of this module. Putting the guard in the one
 * shape every catalog move goes through is the same reasoning that produced
 * this module: fifteen copies of one operation had four defects spread between
 * them, and a guard in one copy is a guard in one copy.
 *
 * ONE SIDE MISSING A NAME IS NOT A DISAGREEMENT. bccp carries `playerName:
 * null` on most rows; requiring a name match against a row that has none would
 * manufacture a contradiction out of a blank field. Both sides must name
 * someone for the arm to fire at all — the same "both carry one" clause
 * sourceCorroboration's header states.
 *
 * AN AUTHORITY GAP IS ALREADY AN ANSWER, and it is checked BEFORE this runs.
 * The conflict this rule exists for is two rows of the SAME class contradicting
 * each other — two transcriptions of one printed line, which is why nothing on
 * the ladder could separate them. When the classes differ, catalogAuthority has
 * already ruled that "a derived row must never outvote a checklist", and a
 * derived row's guess at a player name is not evidence against a checklist's:
 * `ingest-auto-seed` naming "Aaron Judge (seed)" against a Beckett row's "Aaron
 * Judge" is a seed artefact, not a rival numbering, and refusing it would strand
 * every such pair for a human to read one at a time. So the caller checks rank
 * first and only asks this question inside one authority class.
 */
function arbitratePlayer(
  incoming: CatalogRowDoc,
  incumbent: CatalogRowDoc,
  evidence: PlayerEvidence | null | undefined,
):
  | { kind: "not-a-conflict" }
  | { kind: "decided"; survivor: "incoming" | "incumbent"; decision: string; arbitration: NonNullable<MoveCatalogRowResult["playerArbitration"]> }
  | { kind: "refuse"; decision: string; refusal: NonNullable<MoveCatalogRowResult["refusal"]> } {
  const nameIn = incoming.playerName ? String(incoming.playerName).trim() : "";
  const nameInc = incumbent.playerName ? String(incumbent.playerName).trim() : "";
  const keyIn = playerKeyOf(nameIn);
  const keyInc = playerKeyOf(nameInc);
  // Both sides must name someone, and they must differ, for this to be the
  // conflict the rule is about. Everything else is the ordinary ladder.
  if (!keyIn || !keyInc || keyIn === keyInc) return { kind: "not-a-conflict" };

  const rivals = evidence?.rivals ?? null;

  // ARM 1 -- a second strict source at the identity cell. `corroborationOf` is
  // asked about each side in turn, and its `player-disagrees` verdict is a
  // contradiction that DISQUALIFIES that copy.
  const corrIn = corroborationOf(incoming as CorroborationRow, rivals);
  const corrInc = corroborationOf(incumbent as CorroborationRow, rivals);
  const inCorroborated = corrIn.verdict === "corroborated";
  const incCorroborated = corrInc.verdict === "corroborated";
  const inContradicted = corrIn.verdict === "player-disagrees";
  const incContradicted = corrInc.verdict === "player-disagrees";

  if (inCorroborated !== incCorroborated || inContradicted !== incContradicted) {
    // A side wins arm 1 when it is corroborated and the other is not, or when
    // the other is CONTRADICTED and it is not. Both readings point the same way
    // and are checked together so a corroborated-vs-contradicted pair is not
    // decided twice.
    const inWins = (inCorroborated && !incCorroborated) || (incContradicted && !inContradicted);
    const incWins = (incCorroborated && !inCorroborated) || (inContradicted && !incContradicted);
    if (inWins !== incWins) {
      const survivor = inWins ? "incoming" : "incumbent";
      const winName = inWins ? nameIn : nameInc;
      const loseName = inWins ? nameInc : nameIn;
      const winCorr = inWins ? corrIn : corrInc;
      const loseCorr = inWins ? corrInc : corrIn;
      const detail = winCorr.verdict === "corroborated"
        ? `a second strict source (${winCorr.corroboratedBy ?? "?"}) names "${winName}" at this cell`
        : `the rival copy is CONTRADICTED at this cell by ${loseCorr.contradictedBy ?? "a second strict source"}`;
      return {
        kind: "decided",
        survivor,
        decision: `different players at one address: ${detail}; "${loseName}" loses -- CF-A-FOLD-NEVER-CHANGES-THE-PLAYER`,
        arbitration: { winner: survivor, by: "second-source", winningPlayer: winName, losingPlayer: loseName, detail },
      };
    }
  }

  // ARM 2 -- the sale titles' majority at this card number. The audit already
  // counted them; this reads its tally rather than re-deriving one.
  const counts = evidence?.titlePlayerCounts ?? null;
  if (counts) {
    let nIn = 0;
    let nInc = 0;
    for (const [name, n] of Object.entries(counts)) {
      const k = playerKeyOf(name);
      const v = Number(n) || 0;
      if (k === keyIn) nIn += v;
      else if (k === keyInc) nInc += v;
    }
    if (nIn !== nInc && (nIn > 0 || nInc > 0)) {
      const inWins = nIn > nInc;
      const survivor = inWins ? "incoming" : "incumbent";
      const winName = inWins ? nameIn : nameInc;
      const loseName = inWins ? nameInc : nameIn;
      const winN = inWins ? nIn : nInc;
      const loseN = inWins ? nInc : nIn;
      const detail = `the market names "${winName}" at this number in ${winN} refereed sale titles vs ${loseN} for "${loseName}"`;
      return {
        kind: "decided",
        survivor,
        decision: `different players at one address: ${detail} -- CF-A-FOLD-NEVER-CHANGES-THE-PLAYER`,
        arbitration: { winner: survivor, by: "sale-titles", winningPlayer: winName, losingPlayer: loseName, detail },
      };
    }
  }

  // NEITHER SIDE IS CORROBORATED. Refuse, by name.
  return {
    kind: "refuse",
    decision:
      `REFUSED: "${nameIn}" (incoming) and "${nameInc}" (incumbent) are different players at one address and ` +
      `neither is corroborated by a second strict source or by the sale titles -- nothing written ` +
      `(CF-A-FOLD-NEVER-CHANGES-THE-PLAYER)`,
    refusal: { reason: "different-player-uncorroborated", incomingPlayer: nameIn || null, incumbentPlayer: nameInc || null },
  };
}

/**
 * Who keeps the address when a row already sits at newSlug.
 *
 * AUTHORITY FIRST, and it is decisive: the incoming row NEVER loses to a
 * lower-authority incumbent, and never beats a higher one. catalogAuthority
 * says a derived row "must never outvote a checklist"; the `if (!existing)`
 * scripts let it, every time.
 *
 * THEN THE PLAYER, and it is not a tiebreak: two rows OF THE SAME CLASS naming
 * different people at one address are contradicting each other about what card
 * this is, and `arbitratePlayer` settles that by corroboration or refuses it
 * outright. That is the fix — see its header. Only once the two rows agree
 * about WHO is on the card do the remaining rungs mean anything.
 *
 * Then, within a class and once the player is settled: more vendorIds, then
 * more observed sales, then confidence, then the incumbent keeps its address --
 * it is already at the canonical slug and rewriting it gains nothing.
 */
function chooseSurvivor(
  incoming: CatalogRowDoc,
  incumbent: CatalogRowDoc,
  evidence?: PlayerEvidence | null,
):
  | { survivor: "incoming" | "incumbent"; decision: string; arbitration?: NonNullable<MoveCatalogRowResult["playerArbitration"]> }
  | { survivor: null; decision: string; refusal: NonNullable<MoveCatalogRowResult["refusal"]> } {
  const rankIn = authorityRank(incoming.source);
  const rankInc = authorityRank(incumbent.source);
  const tag = (row: CatalogRowDoc, rank: number) => `${String(row.source ?? "?")} (rank ${rank})`;
  if (rankIn !== rankInc) {
    return rankIn > rankInc
      ? { survivor: "incoming", decision: `authority: incoming ${tag(incoming, rankIn)} outranks incumbent ${tag(incumbent, rankInc)}` }
      : { survivor: "incumbent", decision: `authority: incumbent ${tag(incumbent, rankInc)} outranks incoming ${tag(incoming, rankIn)}` };
  }
  // SAME CLASS. Now a different player is a contradiction, not a tiebreak.
  const player = arbitratePlayer(incoming, incumbent, evidence);
  if (player.kind === "refuse") return { survivor: null, decision: player.decision, refusal: player.refusal };
  if (player.kind === "decided") {
    return { survivor: player.survivor, decision: player.decision, arbitration: player.arbitration };
  }
  const vIn = Object.keys(incoming.vendorIds ?? {}).length;
  const vInc = Object.keys(incumbent.vendorIds ?? {}).length;
  if (vIn !== vInc) {
    return vIn > vInc
      ? { survivor: "incoming", decision: `equal authority (${tag(incoming, rankIn)}): incoming carries ${vIn} vendorIds vs ${vInc}` }
      : { survivor: "incumbent", decision: `equal authority (${tag(incoming, rankIn)}): incumbent carries ${vInc} vendorIds vs ${vIn}` };
  }
  const sIn = salesCounter(incoming);
  const sInc = salesCounter(incumbent);
  if (sIn !== sInc) {
    return sIn > sInc
      ? { survivor: "incoming", decision: `equal authority and vendorIds: incoming has ${sIn} observed sales vs ${sInc}` }
      : { survivor: "incumbent", decision: `equal authority and vendorIds: incumbent has ${sInc} observed sales vs ${sIn}` };
  }
  const cIn = Number(incoming.confidence ?? 0);
  const cInc = Number(incumbent.confidence ?? 0);
  if (cIn !== cInc) {
    return cIn > cInc
      ? { survivor: "incoming", decision: `equal authority, vendorIds and sales: incoming confidence ${cIn} vs ${cInc}` }
      : { survivor: "incumbent", decision: `equal authority, vendorIds and sales: incumbent confidence ${cInc} vs ${cIn}` };
  }
  return { survivor: "incumbent", decision: "equal authority, vendorIds, sales and confidence: the incumbent keeps its address" };
}

// ── Cosmos plumbing ──────────────────────────────────────────────────────────

async function forEachPage<T>(
  container: Container,
  spec: SqlQuerySpec,
  retry: CatalogOpsRetry,
  fn: (rows: T[]) => Promise<void>,
): Promise<void> {
  let token: string | undefined;
  do {
    const page = await retry(() =>
      container.items.query<T>(spec, { maxItemCount: 200, continuationToken: token }).fetchNext(),
    );
    token = page.continuationToken || undefined;
    await fn(page.resources ?? []);
  } while (token);
}

/** Delete; a 404 is "already gone", which is the state we wanted. */
async function deleteTolerant(container: Container, id: string, pk: string, retry: CatalogOpsRetry): Promise<boolean> {
  try {
    await retry(() => container.item(id, pk).delete());
    return true;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return false;
    throw err;
  }
}

/** Point read at (slug, slug) -- ~1 RU, and correct for every row written
 *  through deriveCatalogEntry. Rows still under a foreign partition key are
 *  invisible to it; a caller that has looked harder passes `known`. */
async function readIncumbent(container: Container, slug: string, retry: CatalogOpsRetry): Promise<CatalogRowDoc | null> {
  try {
    const { resource } = await retry(() => container.item(slug, slug).read<CatalogRowDoc>());
    return resource ?? null;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return null;
    throw err;
  }
}

/**
 * Is this row a graded child of exactly this parent?
 *
 * Graded ids are `${parentSlug}:${tier}` and the census query is
 * `STARTSWITH(c.id, parent + ":") AND IS_DEFINED(c.gradeTier)`. That prefix
 * also matches the NUMBERED sibling's children: retiring
 * `hiq:…:gold:no-auto` would sweep up `hiq:…:gold:no-auto:num-50:psa-10`,
 * whose parent is a different card that is not going anywhere. parentSlug
 * settles it when present; otherwise the remainder after the prefix must be a
 * single segment -- a tier is `psa-10`, never `num-50:psa-10`.
 */
export function isGradedChildOf(row: { id: string; parentSlug?: string | null }, parentId: string): boolean {
  const id = String(row.id ?? "");
  const prefix = parentId + ":";
  if (!id.startsWith(prefix)) return false;
  if (typeof row.parentSlug === "string" && row.parentSlug) return row.parentSlug === parentId;
  // A tier is one segment and never the print-run segment: "psa-10" yes,
  // "num-50" (the numbered sibling itself) and "num-50:psa-10" (its child) no.
  const rest = id.slice(prefix.length);
  return rest.length > 0 && !rest.includes(":") && !rest.startsWith("num-");
}

const GRADED_CHILDREN_QUERY = "SELECT c.id, c.cardId, c.parentSlug FROM c WHERE STARTSWITH(c.id, @p) AND IS_DEFINED(c.gradeTier)";

async function retireGradedChildren(
  container: Container,
  parentId: string,
  retry: CatalogOpsRetry,
  dryRun: boolean,
): Promise<number> {
  let n = 0;
  await forEachPage<{ id: string; cardId?: string; parentSlug?: string | null }>(
    container,
    { query: GRADED_CHILDREN_QUERY, parameters: [{ name: "@p", value: parentId + ":" }] },
    retry,
    async (rows) => {
      for (const g of rows) {
        if (!isGradedChildOf(g, parentId)) continue;
        if (!dryRun) await deleteTolerant(container, g.id, g.cardId ?? g.id, retry);
        n++;
      }
    },
  );
  return n;
}

// ── the two operations ───────────────────────────────────────────────────────

/**
 * Move a catalog row to a new slug: copy, re-point its sales, retire its
 * graded children, delete the old row -- in that order. See the header for
 * why the order is the invariant.
 *
 * `changedFields` are the identity fields the caller changed (setKey,
 * parallel, cardNumber, printRun, parallelNote, ...). Everything derived from
 * them -- parallelSlug, playerSlug, year/cardYear, isAuto, brand,
 * parentSetKey, searchText, searchTokens, displayName -- is rebuilt here, so a
 * caller cannot forget one.
 *
 * `newSlug === oldRow.id` with a foreign `cardId` is a REHOME: the slug is
 * right, the partition key is not (a vendor id, or a parent's slug from the
 * exploded ladder), so the (slug, slug) point read cannot see the row. The
 * card does not change: no sale is re-pointed (they already name this slug)
 * and no graded child is retired (they are still this row's children). Copy
 * to (slug, slug), decide a twin by the same authority rule, delete the
 * foreign copy last.
 */
export async function moveCatalogRow(
  container: Container,
  oldRow: CatalogRowDoc,
  newSlug: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
  opts: MoveCatalogRowOptions,
): Promise<MoveCatalogRowResult> {
  const reason = String(opts.reason ?? "").trim();
  if (!reason) throw new Error("moveCatalogRow: reason is required");
  const retry = opts.retry ?? noRetry;
  const dryRun = opts.dryRun === true;
  const now = new Date().toISOString();
  const oldId = String(oldRow.id);
  const oldPk = String(oldRow.cardId ?? oldId);
  const rehome = newSlug === oldId && oldPk !== oldId;
  if (newSlug === oldId && !rehome) {
    return { action: "noop", newSlug, salesRepointed: 0, gradedChildrenRetired: 0, survivor: null, decision: "newSlug equals the row's id; nothing to move" };
  }

  const incoming = rehome ? rehomeIncoming(oldRow, oldPk, changedFields) : buildIncoming(oldRow, newSlug, changedFields);
  const incumbent = "known" in opts ? (opts.known ?? null) : await readIncumbent(container, newSlug, retry);

  let action: MoveCatalogRowAction;
  let survivor: "incoming" | "incumbent";
  let decision: string;
  let doc: CatalogRowDoc;
  let playerArbitration: MoveCatalogRowResult["playerArbitration"];
  const stamp = rehome
    ? { rehomedFrom: oldPk, rehomedReason: reason, rehomedAt: now }
    : { movedFrom: oldId, movedReason: reason, movedAt: now };
  if (!incumbent) {
    action = "move";
    survivor = "incoming";
    decision = `no row at ${newSlug}`;
    doc = { ...incoming, ...stamp, observedAt: earliest(oldRow.observedAt) ?? now, lastSeenAt: now };
  } else {
    const choice = chooseSurvivor(incoming, incumbent, opts.playerEvidence);
    // CF-A-FOLD-NEVER-CHANGES-THE-PLAYER. A refusal returns BEFORE the first
    // write. Nothing is upserted, no sale is re-pointed, no graded child is
    // retired and the old row is not deleted: both copies stay exactly where
    // they are, and the pair is reported by name for a human to settle.
    if (choice.survivor === null) {
      return {
        action: "refused",
        newSlug,
        salesRepointed: 0,
        gradedChildrenRetired: 0,
        survivor: null,
        decision: `${choice.decision}  [${oldId} vs ${newSlug}]`,
        refusal: choice.refusal,
      };
    }
    survivor = choice.survivor;
    decision = choice.decision;
    playerArbitration = choice.arbitration;
    // observedAt / firstSeenAt: the card was first seen when EITHER row first
    // saw it. vendorIds: a union, the survivor's value winning a key clash.
    const observedAt = earliest(oldRow.observedAt, incumbent.observedAt) ?? now;
    const firstSeenAt = earliest(oldRow.firstSeenAt, incumbent.firstSeenAt);
    if (survivor === "incoming") {
      action = "replace";
      doc = {
        ...incoming,
        ...stamp,
        vendorIds: { ...(incumbent.vendorIds ?? {}), ...(incoming.vendorIds ?? {}) },
        observedAt,
        ...(firstSeenAt ? { firstSeenAt } : {}),
        lastSeenAt: now,
        replacedSource: incumbent.source,
      };
    } else {
      action = "fold";
      doc = {
        ...(stripSystemFields(incumbent) as CatalogRowDoc),
        vendorIds: { ...(incoming.vendorIds ?? {}), ...(incumbent.vendorIds ?? {}) },
        observedAt,
        ...(firstSeenAt ? { firstSeenAt } : {}),
        lastSeenAt: now,
      };
    }
    // CF-A-CONTRADICTION-DISQUALIFIES-THE-ROW-NOT-THE-CARD. When the two copies
    // named different players, the loser is not merely absorbed: the survivor
    // records WHO it beat and on what evidence, so a reader who later doubts
    // the call can find the discarded name without a diff of a deleted row.
    // A MARKER, never a delete of the card: the surviving row is the card.
    if (playerArbitration) {
      doc = {
        ...doc,
        playerArbitratedAt: now,
        playerArbitratedBy: playerArbitration.by,
        playerArbitrationDetail: playerArbitration.detail,
        supersededPlayerName: playerArbitration.losingPlayer,
        supersededReason: `different-player collision at ${newSlug}: ${reason}`,
      };
    }
  }
  if (rehome) decision = `rehome from partition ${oldPk}: ${decision}`;

  // 1. Copy first. The survivor exists at newSlug before any sale points there.
  if (!dryRun) {
    await retry(() => container.items.upsert(doc));
    // A replaced incumbent that still sat under a foreign partition key was
    // not overwritten by the upsert at (newSlug, newSlug); remove that copy
    // or the id exists twice.
    if (action === "replace" && incumbent && typeof incumbent.cardId === "string" && incumbent.cardId !== newSlug) {
      await deleteTolerant(container, newSlug, incumbent.cardId, retry);
    }
  }

  // 2. Sales follow the card. On a rehome the card did not move.
  let salesRepointed = 0;
  if (rehome) {
    decision += "; sales and graded children stay (the slug did not change)";
  } else if (opts.salesContainer) {
    const sales = opts.salesContainer;
    const ops: PatchOperation[] = [
      { op: "set", path: "/hobbyiqCardId", value: newSlug },
      { op: "set", path: "/reslugedFrom", value: oldId },
      { op: "set", path: "/reslugedReason", value: reason },
      { op: "set", path: "/reslugedAt", value: now },
      ...(opts.repointNormalizedSetKey ? [{ op: "set", path: "/normalizedSetKey", value: incoming.setKey } as PatchOperation] : []),
    ];
    await forEachPage<{ id: string; cardId: string }>(
      sales,
      { query: "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s", parameters: [{ name: "@s", value: oldId }] },
      retry,
      async (rows) => {
        for (const x of rows) {
          if (!dryRun) await retry(() => sales.item(x.id, x.cardId).patch(ops));
          salesRepointed++;
        }
      },
    );
  } else {
    decision += "; sales not re-pointed (no salesContainer)";
  }

  // 3. Graded children of the old slug. Regenerable from the survivor by
  //    materialize-graded-identities; they do not move. A rehomed row keeps
  //    its own ladder.
  const gradedChildrenRetired = rehome ? 0 : await retireGradedChildren(container, oldId, retry, dryRun);

  // 4. The old row, last -- on a rehome, the copy in the foreign partition.
  if (!dryRun) await deleteTolerant(container, oldId, oldPk, retry);

  return { action, newSlug, salesRepointed, gradedChildrenRetired, survivor, decision, ...(playerArbitration ? { playerArbitration } : {}) };
}

/**
 * Retire a catalog row: its graded children, then the row. The delete-only
 * half of a move, for the `retire-*` scripts. Nothing is stamped on the sales
 * that pointed here -- they are unplaced now, and the rematch owns unplaced
 * sales.
 */
export async function retireCatalogRow(
  container: Container,
  id: string,
  cardId: string | null | undefined,
  reason: string,
  opts: RetireCatalogRowOptions = {},
): Promise<RetireCatalogRowResult> {
  const why = String(reason ?? "").trim();
  if (!why) throw new Error("retireCatalogRow: reason is required");
  const retry = opts.retry ?? noRetry;
  const dryRun = opts.dryRun === true;
  const pk = cardId ? String(cardId) : id;

  const gradedChildrenRetired = await retireGradedChildren(container, id, retry, dryRun);
  let rowDeleted: boolean;
  if (dryRun) {
    // Report what a real run would delete, at the cost of one point read.
    try {
      const { resource } = await retry(() => container.item(id, pk).read<CatalogRowDoc>());
      rowDeleted = resource !== undefined && resource !== null;
    } catch (err) {
      if ((err as { code?: number })?.code !== 404) throw err;
      rowDeleted = false;
    }
  } else {
    rowDeleted = await deleteTolerant(container, id, pk, retry);
  }
  return {
    action: rowDeleted || gradedChildrenRetired > 0 ? "retire" : "noop",
    id,
    rowDeleted,
    gradedChildrenRetired,
    reason: why,
  };
}

/**
 * CF-A-FIELD-REPAIR-IS-A-ROW-OP (Drew, 2026-09-01).
 *
 * A repair that corrects FIELDS on a row it does not move or retire had no
 * compliant path: catalogRowOps offered only moveCatalogRow and
 * retireCatalogRow, so every such script hand-rolled `container.item().patch()`
 * and landed on the mutator debt list — a list whose contract is that it "may
 * shrink and must never grow".
 *
 * This is that missing third operation. It patches named fields on ONE row,
 * keeps the previous value of each under `<field>Before` so the repair is
 * reversible, and refuses to touch the addressing contract: id, cardId and
 * hobbyiqCardId are never patchable here, because changing where a row LIVES
 * is moveCatalogRow's job and doing it by patch is what produced half-moved
 * twins (CF-GUARD-THE-CATALOG-WRITE-CONTRACT).
 *
 * Returns "noop" when every requested value already matches, so a re-run is
 * free and idempotent.
 */
export interface PatchCatalogRowFieldsOptions {
  retry?: CatalogOpsRetry;
  dryRun?: boolean;
  /** Skip the `<field>Before` shadow — for a cosmetic field where the previous
   *  value carries no information worth keeping. Off by default. */
  noShadow?: boolean;
}

export interface PatchCatalogRowFieldsResult {
  action: "patch" | "noop";
  id: string;
  fieldsChanged: string[];
}

/** Fields that address the row. Patching these is a MOVE, not a field repair. */
const UNPATCHABLE = new Set(["id", "cardId", "hobbyiqCardId"]);

export async function patchCatalogRowFields(
  container: Container,
  id: string,
  cardId: string | null | undefined,
  fields: Record<string, unknown>,
  opts: PatchCatalogRowFieldsOptions = {},
): Promise<PatchCatalogRowFieldsResult> {
  const names = Object.keys(fields ?? {});
  if (!names.length) throw new Error("patchCatalogRowFields: no fields given");
  const illegal = names.filter((n) => UNPATCHABLE.has(n));
  if (illegal.length) {
    throw new Error(
      `patchCatalogRowFields: ${illegal.join(", ")} address the row — use moveCatalogRow, not a field patch`,
    );
  }
  const retry = opts.retry ?? noRetry;
  const pk = cardId ? String(cardId) : id;

  const { resource: row } = await retry(() => container.item(id, pk).read<CatalogRowDoc>());
  if (!row) return { action: "noop", id, fieldsChanged: [] };

  const current = row as unknown as Record<string, unknown>;
  const changed = names.filter((n) => current[n] !== fields[n]);
  if (!changed.length) return { action: "noop", id, fieldsChanged: [] };
  if (opts.dryRun === true) return { action: "patch", id, fieldsChanged: changed };

  const ops: Array<{ op: "add" | "set"; path: string; value: unknown }> = [];
  for (const n of changed) {
    ops.push({ op: current[n] === undefined ? "add" : "set", path: `/${n}`, value: fields[n] });
    if (opts.noShadow !== true) {
      const shadow = `${n}Before`;
      ops.push({
        op: current[shadow] === undefined ? "add" : "set",
        path: `/${shadow}`,
        value: current[n] ?? null,
      });
    }
  }
  await retry(() => container.item(id, pk).patch(ops));
  return { action: "patch", id, fieldsChanged: changed };
}
