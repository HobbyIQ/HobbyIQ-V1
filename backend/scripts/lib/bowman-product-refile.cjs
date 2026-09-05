/**
 * bowman-product-refile.cjs -- the PURE decisions behind
 * `repair-bowman-product-refile.cjs`. No I/O, no Cosmos, no clock, so the pins
 * drive exactly the code that runs.
 *
 * CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05):
 *
 *     "bowman -- it came out of Bowman."
 *     "Chrome stock is a property of the card, not the name of the product."
 *
 * ── WHAT #1800 FIXED, AND WHAT IT LEFT BEHIND ──────────────────────────────
 *
 * #1800 stopped the MINT: four checklist ingests now pass `authoritativeSetKey`
 * and `upsertCatalogEntry` refuses a row whose setKey FIELD disagrees with its
 * id STEM. Nothing new drifts.
 *
 * It moved NOTHING already stored. The census (2026-09-05,
 * backend/docs/reports/bowman-vs-bowman-chrome-2026-09-05.md) counts what is
 * sitting there:
 *
 *   catalog  19,867  stem `bowman-chrome`         field `bowman`   (2026)
 *   catalog     208  stem `bowman-chrome-sapphire` field `bowman`  (2026)
 *   catalog  77,195  stem `bowman-paper`          field `bowman`   (all years,
 *                    BP-/BPA- only, 2014-2026 -- re-measured 2026-09-05; the
 *                    census's 16,822 was its 2026 slice)
 *   sales    10,532  stem `bowman-chrome`, 2026, CPA-/BCP-
 *
 * ── WHY THE SALES ARE THE URGENT HALF ──────────────────────────────────────
 *
 * ZERO 2026 Bowman Chrome sales exist yet. Every one of the 10,532 rows on the
 * 2026 `bowman-chrome` stem is a Bowman-product sale at a Chrome address, and
 * the price evidence is unambiguous: across 219 paired raw groups the median
 * chrome/bowman ratio is 1.00. Two different products cannot do that.
 *
 * The moment real Bowman Chrome sales arrive they land on top of these and
 * price two different players as one card, with no way to separate them
 * afterwards. That is why this lane exists now rather than after the rematch.
 *
 * ── THE ABSOLUTE GUARD: NINE INITIALS COLLISIONS ───────────────────────────
 *
 * CPA-/BCP- numbers are INITIALS and initials collide ACROSS PRODUCTS. Nine
 * 2026 numbers name two DIFFERENT players (CPA-AG Adrian Gil vs Angeibel
 * Gomez, ...). A move that lands one player's row on the other's address is
 * the exact merge `CF-AUTHORITATIVE-SETKEY` was written to prevent -- it would
 * pool two players and there is no undo once the comps mix.
 *
 * So `planCatalogRefile` refuses ANY move whose destination already holds a
 * DIFFERENT player, by name, and the refusal is reported with both names. The
 * guard is absolute: it is asked LAST, after every other assertion has passed,
 * and no other verdict can override it.
 *
 * `sameCardNumber` / `foldCardNumber` are NOT used to compare players --
 * `playerKey` is, the same normalization `cpaProductRule` uses, so this lane
 * and the product adjudicator cannot drift apart on who counts as one person.
 */
"use strict";

const REASON_LONG = "CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05)";

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/** Segment 3 of a `hiq:` slug -- the product the row is ADDRESSED at. */
function idStem(id) {
  return String(id ?? "").split(":")[3] ?? "";
}

/**
 * The player key. Case, punctuation and spacing are noise; a MISSING name is
 * not a name and is never treated as agreement with anything. A mirror of
 * `cpaProductRule.playerKey`, deliberately -- two spellings of one comparison
 * is how a guard and the rule it defends drift apart.
 */
function playerKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Hyphen- and case-insensitive card number fold, mirroring `foldCardNumber`. */
function foldNumber(n) {
  return String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The drift this lane repairs, and ONLY it: the setKey FIELD is the stale
 * GENERIC of the id STEM. `bowman` under stem `bowman-chrome`.
 *
 * The OPPOSITE direction is legitimate and must never be touched here -- a
 * field that EXTENDS its stem is a checklist naming a product the slug
 * vocabulary does not spell yet (`topps-baseball-japan-edition` over stem
 * `topps`), 1,223 rows in the 7 days before this was written. #1800's
 * invariant passes those deliberately, and so does this.
 */
function isStaleGenericField(field, stem) {
  const f = lower(field);
  const s = lower(stem);
  if (!f || !s || f === s) return false;
  return s.startsWith(`${f}-`);
}

/** The named skip vocabulary. CLOSED -- a consumer never parses prose. */
const SKIP = {
  NOT_DRIFTED: "not-drifted",
  NO_SET_NAME: "row-states-no-set-name",
  REMINT_FAILED: "remint-produced-no-slug",
  REMINT_UNCHANGED: "remint-lands-on-the-same-slug",
  DEST_DIFFERENT_PLAYER: "destination-holds-a-different-player",
  ROW_HAS_NO_PLAYER: "row-states-no-player",
  PROTECTED: "protected-row-report-only",
  AXIS: "remint-moves-more-than-the-product",
};

/**
 * Only the PRODUCT segment may move. A re-mint that also changed the card
 * number, the parallel, the auto flag or the print run is not this repair --
 * it is some other disagreement wearing this lane's clothes, and it skips.
 *
 * Segment 3 is the product; every other segment must be byte-identical.
 */
function onlyProductSegmentMoves(oldSlug, newSlug) {
  const a = String(oldSlug ?? "").split(":");
  const b = String(newSlug ?? "").split(":");
  if (a.length < 5 || b.length < 5) return { ok: false, differing: ["malformed"] };
  if (a.length !== b.length) return { ok: false, differing: ["segment-count"] };
  const differing = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing.push(i === 3 ? "setKey" : `seg${i}`);
  if (!differing.length) return { ok: false, differing: [] };
  const other = differing.filter((d) => d !== "setKey");
  if (other.length) return { ok: false, differing };
  return { ok: true, differing };
}

/**
 * THE PER-ROW CATALOG DECISION.
 *
 * The caller supplies the facts this pure module must not read for itself:
 *
 *   destSlug        the re-mint, built by the caller by running the row's own
 *                   `setName` / `backingSetName` back through the LIVE
 *                   `deriveCatalogEntry` with `authoritativeSetKey: true`.
 *                   Never a string this module assembles -- a repair that
 *                   builds its own slug is a second minting path.
 *   destPlayerName  the player on the row ALREADY at destSlug, or null when
 *                   the destination is empty. THE GUARD reads this.
 *   isProtected     user-verified / ruled rows are report-only forever.
 *
 * Returns `{ move, reason, dest, evidence }`. `move:false` ALWAYS names a
 * reason -- there is no silent skip.
 */
function planCatalogRefile({
  row, destSlug = null, destPlayerName = null, isProtected = false,
}) {
  const id = str(row?.id);
  const stem = idStem(id);
  const field = lower(row?.setKey);
  const ev = {
    id, stem, field,
    setName: str(row?.setName) || null,
    player: str(row?.playerName) || null,
    cardNumber: str(row?.cardNumber) || null,
    source: str(row?.source) || null,
    rule: REASON_LONG,
  };

  // Only the stale-generic direction. Everything else is out of scope, and
  // "out of scope" is reported, never assumed clean.
  if (!isStaleGenericField(field, stem)) {
    return { move: false, reason: SKIP.NOT_DRIFTED, dest: null, evidence: ev };
  }

  // PROTECTED IS REPORT-ONLY FOREVER, asked early so a protected row can never
  // reach the write shape however well the rest of the plan holds.
  if (isProtected) {
    return { move: false, reason: SKIP.PROTECTED, dest: null, evidence: ev };
  }

  // The re-mint reads the row's OWN words for the product. A row that states
  // no product name cannot be re-minted from anything, and guessing one from
  // the stale field is how a repair invents an identity.
  if (!ev.setName) {
    return { move: false, reason: SKIP.NO_SET_NAME, dest: null, evidence: ev };
  }
  if (!destSlug) {
    return { move: false, reason: SKIP.REMINT_FAILED, dest: null, evidence: ev };
  }
  if (destSlug === id) {
    return { move: false, reason: SKIP.REMINT_UNCHANGED, dest: destSlug, evidence: ev };
  }

  const axis = onlyProductSegmentMoves(id, destSlug);
  if (!axis.ok) {
    return {
      move: false,
      reason: `${SKIP.AXIS}:${axis.differing.join("+")}`,
      dest: destSlug,
      evidence: { ...ev, differingSegments: axis.differing },
    };
  }

  // ── THE ABSOLUTE GUARD ────────────────────────────────────────────────────
  // Asked LAST and overridable by nothing. A destination holding a DIFFERENT
  // player is one of the nine initials collisions, and merging them pools two
  // people's cards irreversibly.
  //
  // A row with no player of its own cannot be compared, so it cannot clear the
  // guard -- a null is not agreement (cpaProductRule says this in as many
  // words, and 16,831 rows in its own scope carry a null name).
  const mine = playerKey(ev.player);
  const theirs = playerKey(destPlayerName);
  if (!mine) {
    return { move: false, reason: SKIP.ROW_HAS_NO_PLAYER, dest: destSlug, evidence: ev };
  }
  if (theirs && theirs !== mine) {
    return {
      move: false,
      reason: SKIP.DEST_DIFFERENT_PLAYER,
      dest: destSlug,
      evidence: { ...ev, destPlayer: str(destPlayerName) },
    };
  }

  return { move: true, reason: null, dest: destSlug, evidence: { ...ev, destPlayer: str(destPlayerName) || null } };
}

/**
 * THE PER-SALE DECISION -- the urgent half.
 *
 * A sold_comps row on the 2026 `bowman-chrome` stem re-slugs to `bowman` when
 * BOTH halves hold:
 *
 *   - a `bowman` CHECKLIST row exists at this (cardNumber, player), and
 *   - NO Bowman Chrome checklist claims that player at that number.
 *
 * Otherwise it SKIPS BY NAME. In particular a sale on one of the nine
 * collision numbers whose player cannot be read PARKS rather than moving --
 * Drew, 2026-09-05: "never default to either side". The sale names a NUMBER,
 * and here that number is two identities.
 *
 * Caller-supplied facts (this module reads no Cosmos):
 *   bowmanClaims  { playerName } the `bowman` checklist row at this number, or null
 *   chromeClaims  { playerName } the `bowman-chrome` checklist row, or null
 *   isCollisionNumber  is this one of the nine measured collisions?
 *   destSlug      the re-slug, computed by the caller through the live deriver
 */
function planSaleRefile({
  row, destSlug = null, bowmanClaims = null, chromeClaims = null,
  isCollisionNumber = false, isProtected = false,
}) {
  const player = str(row?.playerName) || str(row?.player);
  const num = str(row?.cardNumber);
  const ev = {
    id: str(row?.id),
    stem: idStem(row?.hobbyiqCardId ?? row?.cardId),
    cardNumber: num || null,
    player: player || null,
    title: str(row?.title) || str(row?.rawTitle) || null,
    rule: REASON_LONG,
  };

  if (isProtected) return { move: false, reason: SKIP.PROTECTED, dest: null, evidence: ev };

  // CF-A-COLLISION-NUMBER-WITH-NO-PLAYER-PARKS. Asked FIRST among the identity
  // gates: on a collision number an unreadable player is undecidable, and the
  // title's product words cannot break the tie (33.1% of bowman-stem sales say
  // "Chrome", because a CPA card IS chrome stock in the Bowman product).
  if (isCollisionNumber && !playerKey(player)) {
    return {
      move: false,
      reason: "collision-number-no-player",
      dest: null,
      evidence: { ...ev, parks: true },
    };
  }
  if (!playerKey(player)) {
    return { move: false, reason: SKIP.ROW_HAS_NO_PLAYER, dest: null, evidence: ev };
  }

  // A `bowman` checklist must NAME this player at this number. Without one the
  // destination is a slug we would be minting from a sale, and a match proves
  // nothing unless checklist-backed.
  const mine = playerKey(player);
  if (!bowmanClaims || playerKey(bowmanClaims.playerName) !== mine) {
    return { move: false, reason: "no-bowman-checklist-claims-this-player", dest: null, evidence: ev };
  }

  // ── THE ABSOLUTE GUARD, sale side. If a CHROME checklist claims a DIFFERENT
  // player at this number, the number is a collision and this sale's product
  // is decided by the player -- which it just was, in Bowman's favour. But if
  // Chrome claims the SAME player we cannot tell which product the sale came
  // from, and moving it would be a guess.
  if (chromeClaims && playerKey(chromeClaims.playerName) === mine) {
    return { move: false, reason: "both-checklists-claim-this-player", dest: null, evidence: ev };
  }

  if (!destSlug) return { move: false, reason: SKIP.REMINT_FAILED, dest: null, evidence: ev };
  if (destSlug === ev.stem) return { move: false, reason: SKIP.REMINT_UNCHANGED, dest: destSlug, evidence: ev };

  return {
    move: true,
    reason: null,
    dest: destSlug,
    evidence: { ...ev, bowmanPlayer: str(bowmanClaims.playerName), chromePlayer: chromeClaims ? str(chromeClaims.playerName) : null },
  };
}

module.exports = {
  REASON_LONG, SKIP,
  idStem, playerKey, foldNumber, isStaleGenericField, onlyProductSegmentMoves,
  planCatalogRefile, planSaleRefile,
};
