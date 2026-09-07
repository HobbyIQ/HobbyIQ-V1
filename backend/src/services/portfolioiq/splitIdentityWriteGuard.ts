/**
 * CF-A-SPLIT-ROW-IS-NEVER-WRITTEN (#1924 follow-up, 2026-09-07).
 *
 * The write-time half of the rule the census (#1924) proved was missing.
 *
 * A `sold_comps` row carries TWO identity fields. `cardId` is the partition
 * key the row is written under; `hobbyiqCardId` is the canonical slug the
 * store derives for itself. `exactPoolReader` matches on EITHER:
 *
 *     WHERE ... AND (c.cardId = @cid OR c.hobbyiqCardId = @hiq)
 *
 * so when the two name DIFFERENT cards, that one row is read into BOTH cards'
 * pools. It prices two cards, and it is invisible to every per-pool audit
 * because each pool is internally consistent: the row is a correct member of
 * the pool it was asked for, every time it is asked. The census measured
 * 94,275 such rows on the sport segment alone, 3,398 of them written in the
 * seven days before it ran. The emitter was still live.
 *
 * `identityUnionGuard.mayUnionIdentities` already encodes the rule -- the
 * SAME rule, the same `sport:year:setKey` product comparison -- but it was
 * enforced at three READ sites only. A rule enforced only on the way out
 * cannot stop the row going in. This module is that rule at the write door,
 * and it deliberately reuses `productIdentityOf` rather than re-deriving the
 * comparison, so a future change to what "the same card" means cannot leave
 * the reader and the writer disagreeing.
 *
 * -- WHAT IT DOES NOT DO ----------------------------------------------------
 *
 * IT DOES NOT GUESS. The census settled that `hobbyiqCardId` is not
 * automatically the right side: on the sub-class where the setKey is an
 * unambiguous tell, `hobbyiqCardId` was correct on 2,330 rows and `cardId` on
 * 1,203, with 395 matching neither. A blanket "canonical wins" rewrite would
 * corrupt roughly a third of the class. "hobbyiqCardId is canonical" is true
 * as a CONVENTION and false as a FACT ABOUT THESE ROWS.
 *
 * So there are exactly two outcomes:
 *
 *   RESOLVE   one side is ATTESTED -- a vendor stated the sport (CardHedge's
 *             `group` field, threaded as `input.sport`) or the slug is backed
 *             by a catalog row the caller resolved. The attested side wins and
 *             BOTH fields take it. This is not a guess; it is a source.
 *   PARK      nothing attests either side. The row is written with
 *             `identityUnverified` and a reason, which keeps it out of EVERY
 *             pool without asserting which card it belongs to. It ends the
 *             double-count without inventing an answer, exactly as the #1924
 *             repair lane parks rather than relocates.
 *
 * Parking rather than dropping is deliberate: the SALE IS REAL. Someone sold a
 * card for that price on that date. Dropping it destroys market evidence we
 * cannot re-acquire; parking keeps the row queryable, keeps its provenance,
 * and lets a later ruling (or a checklist acquisition) unpark it by name.
 *
 * -- FAIL-OPEN IS INHERITED, AND IT IS NARROW -------------------------------
 *
 * `productIdentityOf` returns null for anything that is not an `hiq:` slug, so
 * a vendor-partitioned row -- CardHedge's Bubble id in `cardId` beside our
 * slug in `hobbyiqCardId` -- is NOT a split. Those fields disagree BY
 * CONSTRUCTION and there are 12.96M of them. The census's VENDOR-DESIGN class
 * is exempt here for the same reason it is exempt there: a foreign key beside
 * our slug is a partition, not a contradiction. Guarding them would mis-repair
 * the whole CardHedge pool, which is the #1650 mistake.
 */

import { productIdentityOf } from "../compiq/identityUnionGuard.js";
// CF-A-SLUG-SEGMENT-IS-NOT-A-VENDOR-LABEL (#1938): the SHIPPED vertical
// vocabulary, never a list re-typed here. If a sport is added to the product,
// this guard learns it in the same commit.
import { CANONICAL_SPORTS } from "./slugGuard.service.js";

/** Why a write was parked. Each value is a reason a human can act on. */
export type SplitIdentityReason =
  /** The two identity fields name different products and nothing attests either. */
  | "split-identity"
  /** No sport could be resolved from any source, so no slug can be addressed. */
  | "sport-unresolved"
  /** An identity field is not a well-formed address: its sport segment is
   *  empty or names no canonical vertical, so the row is unaddressable. */
  | "malformed-key";

export type SplitIdentityOutcome =
  /** The fields agree, or one is a vendor key. Write unchanged. */
  | { verdict: "ok" }
  /** One side is attested. Write, with BOTH fields set to `resolvedTo`. */
  | { verdict: "resolve"; resolvedTo: string; attestedBy: string }
  /** Nothing attests either side. Write PARKED, with this reason. */
  | { verdict: "park"; reason: SplitIdentityReason; detail: string };

export interface SplitIdentityInput {
  /** The partition key the caller named. */
  cardId: string | null | undefined;
  /** The slug the store derived. */
  hobbyiqCardId: string | null | undefined;
  /**
   * The sport a SOURCE stated, never one inferred from a title. CardHedge's
   * `group` field arrives here; `inferSportFromContext`'s answer must NOT,
   * because a text heuristic is the thing that produced the damage.
   */
  attestedSport?: string | null;
  /** What stated it, for the log and the parked row's provenance. */
  attestedBy?: string | null;
}

/** The sport segment of an hiq slug, or null when it names no product. */
export function sportOf(slug: string | null | undefined): string | null {
  const product = productIdentityOf(slug);
  if (product === null) return null;
  const sport = product.split(":")[0];
  return sport && sport.trim() ? sport.trim().toLowerCase() : null;
}

/**
 * Rewrite a slug's sport segment. Used only to carry an ATTESTED sport onto
 * the side that disagrees with it -- never to apply a guess.
 */
export function withSport(slug: string, sport: string): string {
  const seg = slug.trim().split(":");
  if (seg.length < 4) return slug;
  seg[1] = sport.trim().toLowerCase();
  return seg.join(":");
}

/**
 * THE decision, for the one write door. Pure: no I/O, no clock, so a unit test
 * drives it directly and every emitter path gets the same answer.
 */
/**
 * Why this string is not an ADDRESS, or null when it is one.
 *
 * CF-A-SLUG-SEGMENT-IS-NOT-A-VENDOR-LABEL (#1938, 2026-09-07).
 *
 * Only applied to strings that CLAIM to be ours -- anything not starting with
 * `hiq:` is a vendor key and is left alone, exactly as the fail-open below
 * leaves it. The claim is what is checked: a string wearing our prefix must be
 * an address we can read back, or the prefix is a lie.
 *
 * The three shapes measured in the live pool on 2026-09-07, 8,102 rows:
 *
 *     hiq:hedge::1773078923701x8520551…::43f7ac3c   `cardhedge::<id>` with the
 *     hiq:sight::be80caf8-…::bulk                   first four chars eaten by
 *                                                   `hiq:${slug.slice(4)}` --
 *                                                   the "vertical" is the TAIL
 *                                                   OF THE VENDOR NAME
 *     hiq:ant::hiq:football:2024:bowman:215:…       `variant::` the same way,
 *                                                   onto a whole second slug
 *     hiq:baseball-mlb:2018:topps-heritage:600:…    a vertical alias that is
 *                                                   not in CANONICAL_SPORTS
 *
 * The `slice(4)` shapes come from a real mechanism, not a typo:
 * `persistVendorSalesToPool` reassembles `hiq:${slug.slice(4)}` on the
 * documented assumption that `slug` is already an hiq slug -- true when the
 * builder computed it, FALSE after `adoptResolvedSlug` rebinds it to a matched
 * catalog row, because that function gates on confidence and never on shape. A
 * `cardhedge::` catalog id matched at >= 0.7 becomes `slug`, and the
 * reassembly then eats "card" and glues our prefix onto "hedge::<id>".
 *
 * This predicate is the same one the #1936 classification lane uses
 * (`backend/scripts/classify-split-identity-rows.cjs`, `addressDefect`), which
 * is how those rows were named PARKED rather than routed. It is stated here in
 * the shipped code so the WRITE door refuses what the repair lane refuses to
 * route -- the rule at the door, not only in the lane that cleans up after it.
 */
export function addressDefect(slug: string | null | undefined): string | null {
  const s = String(slug ?? "").trim();
  if (!s.startsWith("hiq:")) return null;   // a vendor key claims nothing
  if (s.includes("::")) {
    return "contains an empty slug segment (a vendor key wearing an hiq: prefix)";
  }
  const parts = s.split(":");
  if (parts.length < 7) {
    return `has only ${parts.length} segments; an hiq address has at least 7`;
  }
  const sport = parts[1];
  if (!sport) return "has an EMPTY sport segment";
  if (!CANONICAL_SPORTS.has(sport)) {
    return `names "${sport}", which is not a canonical vertical`;
  }
  return null;
}

export function decideSplitIdentity(input: SplitIdentityInput): SplitIdentityOutcome {
  // ── MALFORMED BEFORE SPLIT ────────────────────────────────────────────────
  // Checked FIRST, and deliberately ahead of the vendor-key fail-open below.
  // A malformed key is not a disagreement between two cards to be adjudicated;
  // it is an address nothing can read back, and the split branches would
  // otherwise compare it as though it named a product. `hiq:hedge::…` splits
  // into >= 4 segments, so `productIdentityOf` answers "hedge::" and the guard
  // would have gone on to reason about "hedge" as a sport. Park it by name.
  {
    const cardDefect = addressDefect(input.cardId);
    const hiqDefect = addressDefect(input.hobbyiqCardId);
    if (cardDefect || hiqDefect) {
      const which = cardDefect && hiqDefect
        ? `both addresses are malformed (cardId ${cardDefect}; hobbyiqCardId ${hiqDefect})`
        : cardDefect
          ? `the cardId address ${cardDefect}`
          : `the hobbyiqCardId address ${hiqDefect}`;
      return {
        verdict: "park",
        reason: "malformed-key",
        detail: `${which} -- an unaddressable key is parked, never written as though it named a card`,
      };
    }
  }

  const cardProduct = productIdentityOf(input.cardId);
  const hiqProduct = productIdentityOf(input.hobbyiqCardId);

  // Fail-open, narrowly: a vendor key names no product and is never compared.
  // This is the 12.96M-row VENDOR-DESIGN class and it is not damage.
  if (cardProduct === null || hiqProduct === null) return { verdict: "ok" };
  if (cardProduct === hiqProduct) return { verdict: "ok" };

  const cardSport = sportOf(input.cardId);
  const hiqSport = sportOf(input.hobbyiqCardId);
  const attested = String(input.attestedSport ?? "").trim().toLowerCase();

  // The sport agrees; the products differ on year or setKey. That is the
  // 483,671-row class the census deliberately left for the product-family
  // vocabulary ruling. Not this guard's call to make -- and NOT ok either, so
  // it parks rather than silently writing a row that prices two cards.
  if (cardSport && hiqSport && cardSport === hiqSport) {
    return {
      verdict: "park",
      reason: "split-identity",
      detail: `same sport, different product: ${cardProduct} != ${hiqProduct} -- parked, not filed under a guess`,
    };
  }

  // A SOURCE stated the sport. That is evidence, not a convention, so the
  // side it names wins and both fields take it.
  if (attested && (attested === cardSport || attested === hiqSport)) {
    const winner = attested === hiqSport ? String(input.hobbyiqCardId) : String(input.cardId);
    return {
      verdict: "resolve",
      resolvedTo: winner,
      attestedBy: String(input.attestedBy ?? "attested-sport"),
    };
  }

  // Nothing attests either side. The census proved a convention picks wrong
  // about a third of the time here, so the row is parked with its reason
  // rather than filed under whichever half happened to be written first.
  return {
    verdict: "park",
    reason: "split-identity",
    detail: `sport disagrees and no source attests it: cardId=${cardSport ?? "?"} vs hobbyiqCardId=${hiqSport ?? "?"} -- parked, not filed under a guess`,
  };
}
