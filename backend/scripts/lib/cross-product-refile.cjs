/**
 * cross-product-refile.cjs -- the PURE decisions behind the (year, from-key,
 * to-key) refile triple. No I/O, no Cosmos, no clock, so the pins drive
 * exactly the code that runs.
 *
 * ── WHY THIS EXISTS BESIDE `bowman-product-refile.cjs` ─────────────────────
 *
 * That lane repairs ONE shape: the setKey FIELD is the stale GENERIC of the id
 * STEM (`bowman` under stem `bowman-chrome`), and it re-mints from the row's
 * OWN `setName`. Both halves of its gate fail on the CPA population #1824
 * uncovered, and they fail for the same reason:
 *
 *   - the mis-keyed rows are NOT drifted. `applyChromePrefixOverride` rewrote
 *     the setKey BEFORE the id was built, so the field and the stem AGREE --
 *     both say `bowman-chrome`, both are wrong, and `isStaleGenericField`
 *     correctly reports "not-drifted" on every one of them.
 *   - `bowman-draft` is not a generic of `bowman-chrome`. Neither is a prefix
 *     of the other; this is a SIBLING move, not a specialisation.
 *
 * So the axis is different and it gets its own module rather than a flag on
 * the old one. What it does NOT get is its own copy of the guards: `playerKey`
 * and `foldNumber` are RE-EXPORTED from bowman-product-refile so this lane,
 * that lane and `cpaProductRule` cannot drift apart on who counts as one
 * person or one card number.
 *
 * ── WHAT #1824 MEASURED, AND WHAT IS LEFT STORED ───────────────────────────
 *
 * #1824 stopped the MINT: `CHROME_PREFIX_OVERRIDES`' CPA- rule now carries
 * `maxYear: 2022`, because Bowman DRAFT began numbering its chrome prospect
 * autos CPA- in 2023. Nothing new is minted into the wrong product.
 *
 * It moved NOTHING already stored. Measured read-only 2026-09-05, the damage
 * is almost entirely in the POOL, not the catalog:
 *
 *   catalog  10 rows   stem `bowman-chrome`, own setName says "Bowman Draft"
 *                      (1 in 2024, 9 in 2025 -- all `ingest-auto-seed`)
 *   sales    20,083    chrome-stem CPA sales whose player is named by a
 *                      bowman-draft checklist and by NO bowman-chrome one
 *                      (8,638 in 2024 + 11,445 in 2025; 2023 measures ZERO)
 *
 * The catalog is clean because the checklist ingests pass `authoritativeSetKey`
 * and never consulted the override. The SALES are dirty because every vendor
 * title saying only "Bowman" went through it. That asymmetry is why this lane
 * is sales-first, the reverse of the Bowman refile's ordering.
 *
 * ── THE ABSOLUTE GUARD: THE COLLISION SET IS DERIVED, NEVER TYPED ──────────
 *
 * CPA numbers are INITIALS and initials collide ACROSS PRODUCTS. Measured:
 * 23 numbers in 2024 and 22 in 2025 name two DIFFERENT players -- 2024 cpa-dj
 * is Dawel Joseph in Chrome and Dakota Jordan in Draft; 2025 cpa-jg is John
 * Gil and Jack Gurevitch.
 *
 * `bowman-product-refile` carries its nine collisions as a hardcoded literal.
 * That was defensible for one measured year; across three years and two
 * products it is a list that goes stale silently the moment a checklist lands.
 * So the caller BUILDS the collision set from the checklist claim maps and
 * passes it in, and `isCollisionNumber` below derives it from those same maps
 * so the census and the lane cannot disagree about which numbers are unsafe.
 *
 * Drew, 2026-09-05: "a sale on a collision number with no readable player
 * PARKS"; "never move a row onto a different player's address".
 */
"use strict";

const B = require("./bowman-product-refile.cjs");

/** ONE definition of who is one person, and of what folds to one number. */
const { playerKey, foldNumber, idStem, onlyProductSegmentMoves } = B;

const REASON_LONG =
  "CF-CPA-IS-AMBIGUOUS-FROM-2023 (#1824, Drew 2026-09-05): a CPA- number stopped "
  + "meaning Bowman Chrome in 2023; the checklist that names the player names the product";

/** The named skip vocabulary. CLOSED -- a consumer never parses prose. */
const SKIP = {
  NOT_ON_FROM_KEY: "row-is-not-on-the-from-key",
  ROW_HAS_NO_PLAYER: "row-states-no-player",
  PARK_COLLISION: "collision-number-no-player-parks",
  DEST_DIFFERENT_PLAYER: "destination-names-a-different-player",
  TO_KEY_DOES_NOT_CLAIM: "to-key-checklist-does-not-name-this-player",
  FROM_KEY_CLAIMS: "from-key-checklist-names-this-player",
  BOTH_CLAIM: "both-checklists-name-this-player",
  REMINT_FAILED: "remint-produced-no-slug",
  REMINT_UNCHANGED: "remint-lands-on-the-same-slug",
  AXIS: "remint-moves-more-than-the-product",
  PROTECTED: "protected-row-report-only",
  WORDS_NAME_TWO_PLAYERS: "row-words-name-a-player-from-each-product",
};

/**
 * The scope triple. `sport:year:fromKey>toKey`.
 *
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME: a scope that does not name BOTH
 * ends of the move is not a scope. The old `sport:year:setKey` pair says where
 * to read and lets the re-mint decide where rows land; that is right when the
 * destination comes from the row's own words, and wrong here, where the row's
 * words are exactly what the broken override overwrote. So the destination is
 * NAMED, and a run can be read off its own banner.
 *
 * Returns null for anything that is not the triple -- the caller refuses.
 */
const TRIPLE_RE = /^([a-z0-9-]+):(\d{4}):([a-z0-9-]+)>([a-z0-9-]+)$/;

function parseScopeTriple(spec) {
  const m = TRIPLE_RE.exec(String(spec ?? "").trim().toLowerCase());
  if (!m) return null;
  const [, sport, year, fromKey, toKey] = m;
  // A move to where you already are is not a move, and silently accepting it
  // would let a typo report a clean run over a scope nothing could ever match.
  if (fromKey === toKey) return null;
  return { sport, year: Number(year), fromKey, toKey, raw: `${sport}:${year}:${fromKey}>${toKey}` };
}

/**
 * The numbers that are UNSAFE in this (year, fromKey, toKey) window: both
 * checklists name a player at that number, and they are not the same player.
 *
 * Derived from the claim maps the caller already had to build, never typed.
 * `claims` is `Map<foldedNumber, Set<playerKey>>` per side.
 */
function deriveCollisionNumbers(fromClaims, toClaims) {
  const out = new Set();
  for (const [num, from] of fromClaims) {
    const to = toClaims.get(num);
    if (!to || !to.size || !from.size) continue;
    const differ = [...from].some((p) => !to.has(p)) || [...to].some((p) => !from.has(p));
    if (differ) out.add(num);
  }
  return out;
}

/**
 * CF-THE-STORED-PLAYERNAME-IS-NOT-THE-EVIDENCE (#1849, Drew 2026-09-06).
 *
 * `playerKey` is EXACT equality after case/punctuation folding, and that is
 * right for deciding who is one person. It is wrong as the only way to ASK
 * whether a checklist claims a row, because the stored `playerName` on a sale
 * is scraped, not curated. Measured over the 314 CPA-DT rows of 2025:
 *
 *     "Devin Taylor"            125 rows   clean
 *     "Draft Devin Taylor"        1        product word glued to the name
 *     "Devin Taylor Oakland"      1        team glued to the name
 *     "Devin Taylor On Caes"      1        OCR mangling of a title fragment
 *     "Devin Taylor Au"           2        the auto flag glued to the name
 *     "Diego Tornes"              1        FLATLY WRONG -- the title reads
 *                                          "Devin Taylor 2025 Bowman Chrome
 *                                           Draft 1st Auto Oakland Athletics"
 *
 * Every one of those rows is a Devin Taylor sale that the exact fold reports
 * as `to-key-checklist-does-not-name-this-player`, so the lane leaves it in
 * Diego Tornes' pool -- two players' sales in one pool, which is exactly the
 * defect the lane exists to end.
 *
 * The fix is NOT to loosen `playerKey`. Substring matching on identity would
 * make "Devin Taylor" claim "Devin Taylorson", and three lanes share that
 * primitive. Instead the CLAIMED name is looked for as a whole-word RUN inside
 * the row's own words, and only under conditions that keep it a corroboration
 * rather than a guess:
 *
 *   - the claimed name must appear as CONSECUTIVE WHOLE WORDS ("devin taylor"
 *     inside "draft devin taylor"), never as a substring of a longer word, so
 *     "taylorson" never satisfies a claim for "taylor";
 *   - it must be at least two words, so a single-token checklist name can
 *     never sweep in a whole product's rows;
 *   - EXACTLY ONE of the two sides' claimed names may match. A row whose words
 *     contain both products' players is ambiguous and is refused, never moved.
 *
 * `haystack` is the row's playerName AND its title, because on the wrong-name
 * row above the title is the only place the truth appears -- and the title is
 * what a human reads to adjudicate the same row.
 */
function nameAppearsInWords(claimedName, haystack) {
  const words = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const need = words(claimedName);
  const hay = words(haystack);
  if (need.length < 2 || hay.length < need.length) return false;
  for (let i = 0; i + need.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) if (hay[i + j] !== need[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/**
 * Which of a side's claimed names the row's OWN WORDS name, as playerKeys.
 * `claimNames` is the raw checklist spelling; the caller passes both sides so
 * a row that names BOTH players can be refused rather than moved.
 */
function claimsNamedInRow(claimNames, haystack) {
  const out = new Set();
  for (const n of claimNames instanceof Set ? claimNames : []) {
    if (nameAppearsInWords(n, haystack)) out.add(playerKey(n));
  }
  return out;
}

/**
 * THE PER-SALE DECISION.
 *
 * A sale sitting on `fromKey` moves to `toKey` when, and only when:
 *
 *   - its player can be READ (a null is not agreement), and
 *   - a `toKey` CHECKLIST row names that player at that number, and
 *   - NO `fromKey` checklist names that same player at that number.
 *
 * Anything else is named and left alone. In particular:
 *
 *   - a sale on a COLLISION number whose player cannot be read PARKS. The
 *     title's product words cannot break the tie: a CPA card is chrome stock
 *     in both products, so "Chrome" in a title says nothing about which one.
 *   - a destination naming a DIFFERENT player is REFUSED BY NAME, and the
 *     refusal carries both names into the report. This is asked LAST and no
 *     other verdict overrides it.
 *
 * Caller-supplied facts (this module reads no Cosmos):
 *   fromClaimPlayers  Set(playerKey) the fromKey checklists name at this number
 *   toClaimPlayers    Set(playerKey) the toKey checklists name at this number
 *   destSlug          the re-slug, computed by the caller through the LIVE
 *                     deriver -- never a string this module assembles.
 *   destPlayerName    the player already at destSlug, or null when it is empty.
 */
function planCrossProductSale({
  row,
  fromKey,
  toKey,
  destSlug = null,
  destPlayerName = null,
  fromClaimPlayers = null,
  toClaimPlayers = null,
  isCollisionNumber = false,
  isProtected = false,
  // The two sides' RAW checklist spellings, for CF-THE-STORED-PLAYERNAME-IS-
  // NOT-THE-EVIDENCE. Absent, the plan behaves exactly as it did before.
  fromClaimNames = null,
  toClaimNames = null,
}) {
  const id = String(row?.hobbyiqCardId ?? row?.cardId ?? "");
  const stem = idStem(id);
  const player = String(row?.playerName ?? row?.player ?? "").trim();
  const ev = {
    id: String(row?.id ?? ""),
    stem,
    fromKey,
    toKey,
    cardNumber: String(row?.cardNumber ?? "").trim() || null,
    player: player || null,
    title: String(row?.title ?? row?.rawTitle ?? "").trim() || null,
    rule: REASON_LONG,
  };

  const from = fromClaimPlayers instanceof Set ? fromClaimPlayers : new Set();
  const to = toClaimPlayers instanceof Set ? toClaimPlayers : new Set();

  // PROTECTED IS REPORT-ONLY FOREVER, asked early so a protected row can never
  // reach the write shape however well the rest of the plan holds.
  if (isProtected) return { move: false, reason: SKIP.PROTECTED, dest: null, evidence: ev };

  // The row must actually be on the key this run named. A scope that reads a
  // stem is not proof the row is on it -- the caller may widen a query later.
  if (stem && stem !== fromKey) {
    return { move: false, reason: SKIP.NOT_ON_FROM_KEY, dest: null, evidence: ev };
  }

  let mine = playerKey(player);

  // CF-THE-STORED-PLAYERNAME-IS-NOT-THE-EVIDENCE. The exact fold is asked
  // FIRST and still decides whenever it can. Only when it cannot -- the field
  // is dirty, or empty, or names the wrong person -- do the row's own WORDS
  // (its playerName AND its title) get to corroborate a checklist claim.
  //
  // This never invents an identity: the candidate names are the two
  // checklists' own spellings, and a row that names one player from EACH side
  // is refused as undecidable rather than moved.
  const readable = to.has(mine) || from.has(mine);
  if (!readable && (fromClaimNames || toClaimNames)) {
    const hay = `${player} ${String(row?.title ?? row?.rawTitle ?? "")}`;
    const namedTo = claimsNamedInRow(toClaimNames, hay);
    const namedFrom = claimsNamedInRow(fromClaimNames, hay);
    if (namedTo.size + namedFrom.size === 1) {
      const resolved = [...namedTo, ...namedFrom][0];
      ev.playerResolvedFromWords = true;
      ev.playerAsStored = player || null;
      mine = resolved;
    } else if (namedTo.size + namedFrom.size > 1) {
      return {
        move: false,
        reason: SKIP.WORDS_NAME_TWO_PLAYERS,
        dest: null,
        evidence: { ...ev, namedPlayers: [...namedTo, ...namedFrom] },
      };
    }
  }

  // CF-A-COLLISION-NUMBER-WITH-NO-PLAYER-PARKS. Asked FIRST among the identity
  // gates: on a collision number an unreadable player is undecidable, and no
  // later gate can rescue it.
  if (isCollisionNumber && !mine) {
    return { move: false, reason: SKIP.PARK_COLLISION, dest: null, evidence: { ...ev, parks: true } };
  }
  if (!mine) return { move: false, reason: SKIP.ROW_HAS_NO_PLAYER, dest: null, evidence: ev };

  // The destination checklist must NAME this player at this number. Without one
  // the destination is a slug we would be minting FROM A SALE, and a match
  // proves nothing unless it is checklist-backed.
  if (!to.has(mine)) {
    return { move: false, reason: SKIP.TO_KEY_DOES_NOT_CLAIM, dest: null, evidence: ev };
  }
  // If the key it is ALREADY on also names this player, we cannot tell which
  // product the sale came from and moving it would be a guess.
  if (from.has(mine)) {
    return { move: false, reason: SKIP.BOTH_CLAIM, dest: null, evidence: ev };
  }

  if (!destSlug) return { move: false, reason: SKIP.REMINT_FAILED, dest: null, evidence: ev };
  if (destSlug === id) return { move: false, reason: SKIP.REMINT_UNCHANGED, dest: destSlug, evidence: ev };

  // Only the PRODUCT segment may move. A re-slug that also changed the card
  // number, the parallel or the auto flag is some other disagreement wearing
  // this lane's clothes.
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
  // Asked LAST and overridable by nothing. Landing one player's sale on
  // another player's address pools two people irreversibly.
  const theirs = playerKey(destPlayerName);
  if (theirs && theirs !== mine) {
    return {
      move: false,
      reason: SKIP.DEST_DIFFERENT_PLAYER,
      dest: destSlug,
      evidence: { ...ev, destPlayer: String(destPlayerName ?? "").trim() },
    };
  }

  return {
    move: true,
    reason: null,
    dest: destSlug,
    evidence: { ...ev, destPlayer: String(destPlayerName ?? "").trim() || null },
  };
}

/**
 * THE PER-CATALOG-ROW DECISION.
 *
 * Ten rows in the measured scope, all `ingest-auto-seed`, all carrying a
 * `setName` that says "Bowman Draft Chrome" over a `bowman-chrome` stem. The
 * row's OWN words name the product, so the re-mint reads them -- the same
 * discipline `planCatalogRefile` uses, and for the same reason: a repair that
 * builds its own slug is a second minting path.
 *
 * A row whose words do NOT name the destination product is left alone. This
 * lane never re-files a catalog row on the strength of a sale.
 */
function planCrossProductCatalogRow({
  row,
  fromKey,
  toKey,
  destSlug = null,
  destPlayerName = null,
  isProtected = false,
}) {
  const id = String(row?.id ?? "");
  const stem = idStem(id);
  const ev = {
    id,
    stem,
    fromKey,
    toKey,
    setName: String(row?.setName ?? "").trim() || null,
    backingSetName: String(row?.backingSetName ?? "").trim() || null,
    player: String(row?.playerName ?? "").trim() || null,
    cardNumber: String(row?.cardNumber ?? "").trim() || null,
    source: String(row?.source ?? "").trim() || null,
    rule: REASON_LONG,
  };

  if (isProtected) return { move: false, reason: SKIP.PROTECTED, dest: null, evidence: ev };
  if (stem !== fromKey) return { move: false, reason: SKIP.NOT_ON_FROM_KEY, dest: null, evidence: ev };

  // The row must SAY the destination product in its own words. Guessing one
  // from the stem is how a repair invents an identity.
  const words = `${ev.setName ?? ""} ${ev.backingSetName ?? ""}`.toLowerCase();
  if (!/\bdraft\b/.test(words)) {
    return { move: false, reason: SKIP.TO_KEY_DOES_NOT_CLAIM, dest: null, evidence: ev };
  }

  if (!destSlug) return { move: false, reason: SKIP.REMINT_FAILED, dest: null, evidence: ev };
  if (destSlug === id) return { move: false, reason: SKIP.REMINT_UNCHANGED, dest: destSlug, evidence: ev };

  const axis = onlyProductSegmentMoves(id, destSlug);
  if (!axis.ok) {
    return {
      move: false,
      reason: `${SKIP.AXIS}:${axis.differing.join("+")}`,
      dest: destSlug,
      evidence: { ...ev, differingSegments: axis.differing },
    };
  }

  const mine = playerKey(ev.player);
  if (!mine) return { move: false, reason: SKIP.ROW_HAS_NO_PLAYER, dest: destSlug, evidence: ev };

  const theirs = playerKey(destPlayerName);
  if (theirs && theirs !== mine) {
    return {
      move: false,
      reason: SKIP.DEST_DIFFERENT_PLAYER,
      dest: destSlug,
      evidence: { ...ev, destPlayer: String(destPlayerName ?? "").trim() },
    };
  }

  return {
    move: true,
    reason: null,
    dest: destSlug,
    evidence: { ...ev, destPlayer: String(destPlayerName ?? "").trim() || null },
  };
}

module.exports = {
  REASON_LONG,
  SKIP,
  playerKey,
  foldNumber,
  idStem,
  parseScopeTriple,
  deriveCollisionNumbers,
  nameAppearsInWords,
  claimsNamedInRow,
  planCrossProductSale,
  planCrossProductCatalogRow,
};
