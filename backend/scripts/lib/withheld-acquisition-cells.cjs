// CF-IF-KNOWN-WE-SHOULD-BE-ABLE-TO-FIGURE-IT-OUT (Drew, 2026-09-05).
//
// "a holding withheld for no-checklist-match whose card IS identifiable must
// resolve without a human."
//
// Today three things exist and nothing joins them: #1784 prints an acquisition
// queue, the universe driver ingests a product when handed exact manifest
// setNames, and the rederive lane re-points holdings. This module is the JOIN'S
// RULE -- cell grouping, cell ranking, and manifest matching -- factored out of
// the lane script so the pins exercise the code that runs rather than a
// restatement of it (the lesson of split-identity.cjs and collision-triage.cjs:
// a classification rule in a lib is pinned; the same rule inline is not).
//
// It holds NO I/O. Cosmos reads and workflow dispatch live in the lane script;
// everything here is a pure function over rows the caller already has, which is
// what lets `withheldAcquisitionCells.test.ts` run the real matcher against the
// real 16,746-entry manifest with no connection string.
"use strict";

/** The withheld reasons this queue acts on. CLOSED, and it is the same closed
 *  vocabulary `NoBasisRefusalReason` declares in holdingValuation.ts --
 *  `pool-migrating` is deliberately NOT here: a re-key that has not settled is
 *  not a missing checklist, and acquiring one would not unblock it. */
const ACTIONABLE_REASONS = new Set(["no-checklist-match", "identity-not-in-catalog"]);

/**
 * THE SPORT SUFFIX AND THE SEASON SPAN, verbatim from the driver.
 *
 * CF-COUNT-THE-KEY-THE-CHILD-WROTE (#1738) established that a set NAME is
 * "1952 Topps Baseball" and the catalog KEY is `topps` -- the year is its own
 * column and the sport is its own column, so carrying either in the key names a
 * product that does not exist. `setKeyFor` in ingest-universe-driver.cjs is the
 * function that knows this, and this is that function.
 *
 * IT IS A COPY, AND THE PIN IS WHAT MAKES THAT SAFE. The driver's copy is a
 * module-private function inside a 2,000-line script that connects to Cosmos at
 * require time; importing it from here is not possible without running that.
 * `withheldAcquisitionCells.test.ts` therefore reads the driver's source, pulls
 * its `setKeyFor` body out, and asserts character equality against this one --
 * so the two cannot drift without a red test naming the drift.
 */
const SPORT_SUFFIX = /-(baseball|football|basketball|hockey|soccer|pokemon|wrestling|racing|golf|tcg)$/;

const slugOf = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The catalog's setKey for a manifest entry's set name. The driver's rule. */
function setKeyForEntry(entry) {
  // Pokemon matches on the SET ID, and year is not part of that identity: a
  // ja-exclusive set's name slugifies to nothing at all, so a name-derived key
  // would leave every tcgdexja entry unmatchable. The set id IS the vocabulary
  // the catalog keys pokemon on, and the sourceRef carries it.
  if (entry.lane === "tcgdexja") {
    const id = String(entry.sourceRef || "").split("/").pop();
    return id ? id.toLowerCase() : null;
  }
  let k = slugOf(entry.setName || "");
  k = k.replace(/^(?:19|20)\d{2}(?:-\d{2})?-/, "");
  // ORDER MATTERS. CLC page titles end "...Baseball Card Checklist", so the
  // sport is only trailing once the checklist words are gone.
  for (let i = 0; i < 4; i++) {
    const before = k;
    k = k.replace(/-(?:card-)?checklist$/, "");
    k = k.replace(SPORT_SUFFIX, "");
    if (k === before) break;
  }
  return k || null;
}

/**
 * A CELL is the unit a checklist is ACQUIRED in: one product, one year, one
 * sport. It is NOT the unit a card is priced in.
 *
 * Subset rides along as an OPTIONAL fourth axis and is reported, never used to
 * split the cell: an insert set is acquired with the product page that carries
 * it, so splitting on it would ask the driver for the same page twice and count
 * one acquisition as two.
 */
function cellKeyOf({ sport, year, setKey }) {
  return [
    String(sport || "?").toLowerCase(),
    String(year || "?"),
    String(setKey || "?").toLowerCase(),
  ].join("|");
}

/**
 * Group withheld holdings into cells.
 *
 * `holdings` are already-walked holding objects (CF-HOLDINGS-IS-A-MAP: the
 * caller walks the map; a JOIN over it iterates nothing and reports a confident
 * zero). Each carries the fields the withheld write left on it.
 *
 * A holding whose (sport, year, setKey) cannot be read is NOT dropped silently:
 * it lands in `unaddressable`, because "we could not tell what card this is" is
 * a different finding from "we know the card and have no source", and Drew's
 * discovery program needs the second list, not a merge of both.
 */
function groupIntoCells(holdings, { salesByCell = new Map() } = {}) {
  const cells = new Map();
  const unaddressable = [];

  for (const h of holdings) {
    if (!ACTIONABLE_REASONS.has(String(h.withheldReason || ""))) continue;
    const sport = h.sport || null;
    const year = h.cardYear ?? h.year ?? null;
    const setKey = h.setKey || null;

    if (!sport || !year || !setKey) {
      unaddressable.push({
        holdingId: h.hid || h.id || null,
        user: h.user || null,
        reason: h.withheldReason,
        // What we DID read, so the gap is nameable rather than just absent.
        have: { sport, year, setKey, slug: h.hobbyiqCardId || null },
      });
      continue;
    }

    const key = cellKeyOf({ sport, year, setKey });
    let c = cells.get(key);
    if (!c) {
      c = {
        cell: key,
        sport: String(sport).toLowerCase(),
        year: Number(year),
        setKey: String(setKey).toLowerCase(),
        subsets: new Set(),
        holdings: 0,
        holdingIds: [],
        users: new Set(),
        slugs: new Set(),
        reasons: {},
      };
      cells.set(key, c);
    }
    c.holdings += 1;
    if (h.hid || h.id) c.holdingIds.push(String(h.hid || h.id));
    if (h.user) c.users.add(h.user);
    if (h.hobbyiqCardId) c.slugs.add(h.hobbyiqCardId);
    if (h.subset) c.subsets.add(String(h.subset).toLowerCase());
    c.reasons[h.withheldReason] = (c.reasons[h.withheldReason] || 0) + 1;
  }

  for (const c of cells.values()) {
    c.subsets = [...c.subsets].sort();
    c.users = [...c.users].sort();
    c.slugs = [...c.slugs].sort();
    c.salesVolume = Number(salesByCell.get(c.cell) || 0);
  }
  return { cells: [...cells.values()], unaddressable };
}

/**
 * THE RANKING. Holdings count first, sales volume second, cell name third.
 *
 * Holdings FIRST is the ruling and not a preference: this queue exists because
 * a person's card shows no number, and the cell that darkens the most cards is
 * the one whose acquisition lights the most back up. Sales volume breaks ties
 * -- between two cells holding one card each, the one the market trades more is
 * the one whose checklist earns its fetch -- and the cell key breaks the
 * remainder so the ordering is TOTAL and a nightly cap takes the same top N
 * twice in a row rather than an arbitrary rotation.
 */
function rankCells(cells) {
  return [...cells].sort(
    (a, b) =>
      b.holdings - a.holdings ||
      b.salesVolume - a.salesVolume ||
      a.cell.localeCompare(b.cell),
  );
}

/**
 * CF-A-MISSING-CHECKLIST-IS-USUALLY-A-WRONG-KEY (Drew) -- the spellings a cell's
 * setKey may legitimately wear in a manifest entry's derived key.
 *
 * The driver already proved both halves of this. #1738: `finest` and
 * `topps-finest` are the same product on either side of the alias table, and
 * counting only one of them read 0 rows against 39,480 real ones. #1741: the
 * ingest child honours a manifest's STATED setKey verbatim and normalizes only
 * a derived one, so a product can land under EITHER spelling and a matcher that
 * knows one spelling misses the entry that would have served it.
 *
 * So a cell is matched against the UNION of its spellings, exactly as the
 * driver's verification counts the union. `canonicalSetKey` is passed in by the
 * caller (it needs `dist/`), and falls back to identity when dist is absent --
 * which degrades this to raw-key matching rather than crashing a nightly run.
 */
function spellingsOf(setKey, canonicalSetKey) {
  const raw = String(setKey || "").toLowerCase();
  if (!raw) return [];
  const out = new Set([raw]);
  try {
    const c = canonicalSetKey ? canonicalSetKey(raw) : null;
    if (c) out.add(String(c).toLowerCase());
  } catch {
    /* a normalizer that throws is a missing dist, not a match failure */
  }
  return [...out];
}

/**
 * THE CONTESTED PAIRS -- a match that must NEVER be made across.
 *
 * project_bowman_setkey_taxonomy: bowman, bowman-chrome and bowman-sapphire are
 * DIFFERENT CARDS with different price curves, and #1715 is the standing proof
 * that a flagship key swallowing its specializations puts Tiffany sales in a
 * base pool and publishes $148 against a $1,500 market.
 *
 * Alias widening is exactly the mechanism that would do it here: normalize both
 * sides far enough and `bowman-chrome` and `bowman` meet. So the union above is
 * intersected with this refusal. It is a DENY LIST over the matched pair, not a
 * cleverer normalizer, because the failure it prevents is silent and the
 * refusal it produces is loud -- a cell that hits this is reported "needs a
 * source", which sends a human to the manifest instead of a scraper to the
 * wrong product.
 */
const CONTESTED = [
  ["bowman", "bowman-chrome"],
  ["bowman", "bowman-sapphire"],
  ["bowman", "bowman-draft"],
  ["bowman-chrome", "bowman-sapphire"],
  ["topps", "topps-chrome"],
  ["topps", "topps-traded"],
  ["topps", "topps-tiffany"],
  ["topps", "topps-traded-tiffany"],
  ["topps", "topps-finest"],
  ["topps", "topps-heritage"],
  ["topps-traded", "topps-traded-tiffany"],
  ["topps-chrome", "topps-chrome-sapphire"],
  ["donruss", "donruss-optic"],
  ["panini-prizm", "panini-prizm-draft-picks"],
];

/** True when a and b are a ruled-distinct pair and must not match each other. */
function contested(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (x === y) return false;
  return CONTESTED.some(([p, q]) => (x === p && y === q) || (x === q && y === p));
}

/** Lane preference. GO sources first (reference_checklist_source_health,
 *  2026-08-25/2026-09-04: sportscardchecklist is GO for vintage cells;
 *  Beckett has been 403ing since 2026-09-04 and sits last rather than being
 *  removed -- a 403 is a today fact, not a retirement). */
const LANE_RANK = {
  sportscardchecklist: 0,
  bcp: 1,
  clc: 2,
  hobbymonitor: 3,
  checklistinsider: 4,
  tcgdexja: 5,
  beckett: 6,
};

/**
 * Match one cell to a manifest entry.
 *
 * The rule, in order:
 *   1. sport and year must agree EXACTLY. A checklist is a product-year page;
 *      a neighbouring year is a different set of cards.
 *   2. the entry's derived setKey (the driver's own `setKeyFor`, plus the
 *      manifest's STATED setKey when it has one) must meet one of the cell's
 *      spellings.
 *   3. the pair must not be CONTESTED.
 *
 * Multiple entries can serve one cell; they are returned ranked, and the caller
 * dispatches the head. `corroborated` is true when more than one lane offers the
 * cell -- the task's "preferring GO sources and corroborated ones" -- and it is
 * reported rather than used to reorder, because a second lane agreeing does not
 * make a worse source better at serving the page.
 */
function matchCellToManifest(cell, entries, { canonicalSetKey } = {}) {
  const want = new Set(spellingsOf(cell.setKey, canonicalSetKey));
  if (want.size === 0) return { matches: [], corroborated: false };

  const matches = [];
  for (const e of entries) {
    if (String(e.sport || "").toLowerCase() !== cell.sport) continue;
    if (Number(e.year) !== Number(cell.year)) continue;

    // The entry's key under BOTH the spellings it can land under: what the
    // manifest STATES (honoured verbatim by the ingest child) and what the
    // driver DERIVES from the display name (normalized). #1741 is the case
    // where those differ and only one of them is the key rows land on.
    const derived = setKeyForEntry(e);
    const stated = e.setKey ? String(e.setKey).toLowerCase() : null;
    const offered = new Set();
    for (const k of [derived, stated]) {
      if (!k) continue;
      offered.add(String(k).toLowerCase());
      for (const s of spellingsOf(k, canonicalSetKey)) offered.add(s);
    }
    if (offered.size === 0) continue;

    // A ruled-distinct pair anywhere across the two sets refuses the whole
    // entry. Checking only the pair that happened to match would let
    // `bowman-chrome` in through an alias that also produced `bowman`.
    let ruledOut = false;
    for (const w of want) {
      for (const o of offered) if (contested(w, o)) { ruledOut = true; break; }
      if (ruledOut) break;
    }
    if (ruledOut) continue;

    // CF-NORMALIZATION-MAY-NOT-PROMOTE-A-SUBSET (measured 2026-09-05).
    //
    // The alias table is not symmetrical, and the union above is only safe in
    // the direction it was proved for. On the real manifest:
    //
    //   normalizeSetKey("finest")                          -> topps-finest
    //   normalizeSetKey("finest-jackie-robinson-u-s-mint") -> topps-finest
    //
    // The first is #1738's alias and is exactly what the union exists to catch.
    // The SECOND is project_normalizesetkey_collapses_products: a distinct
    // subset product ("1997 Finest Jackie Robinson U.S. Mint") normalizing onto
    // its flagship. Both entries therefore offered `topps-finest` and both
    // matched the cell -- so the ranked list handed the Jackie Robinson page to
    // a plain 1997 Finest card as an equal candidate.
    //
    // The rule: an entry may match through normalization only when its RAW
    // derived key is not strictly MORE SPECIFIC than what the cell asked for.
    // A raw key that extends one of the cell's spellings with more words is a
    // narrower product, and acquiring it for the broader cell is the same
    // mistake #1715 made in the other direction. It is refused here rather than
    // handled by CONTESTED, because the pairs are generated by the source's own
    // naming and cannot be enumerated in advance.
    // The comparison is between the entry's RAW key and the cell's RAW key --
    // not the normalized ones. Normalizing first is what hides the problem: it
    // is the alias that renames `finest-jackie-robinson-u-s-mint`'s stem to
    // `topps-finest`, so after normalization the two look identical and there
    // is nothing left to compare. Before it, the entry's key visibly carries
    // words the cell's does not.
    // THE TEST: does the entry's RAW key carry words that none of the cell's
    // own spellings do? An alias RENAMES a key (`finest` -> `topps-finest`); it
    // never ADDS product words. So an entry whose raw key is one of the cell's
    // spellings PLUS extra trailing words is a narrower product, whichever head
    // spelling it happens to wear.
    const rawOffered = [derived, stated].filter(Boolean).map((k) => String(k).toLowerCase());
    const cellSpellings = [...want];
    const narrowerThanEvery = rawOffered.length > 0 && rawOffered.every((r) => {
      // An exact hit on any spelling is the product itself, never a subset.
      if (cellSpellings.includes(r)) return false;
      // Does r extend one of the cell's spellings, allowing for the alias
      // rewriting the head? Compare the WORD TAILS: drop each side's leading
      // brand words while they agree, and also try the raw-vs-raw comparison.
      return cellSpellings.every((w) => {
        if (r === w) return false;
        const rw = r.split("-");
        const ww = w.split("-");
        // Case 1: r literally extends w  (finest-jackie... vs finest).
        if (r.startsWith(`${w}-`)) return true;
        // Case 2: the heads were aliased apart. Find w's LAST word in r and
        // require r to continue past it (topps-finest vs finest-jackie...).
        const anchor = ww[ww.length - 1];
        const at = rw.indexOf(anchor);
        if (at >= 0 && at < rw.length - 1) return true;
        return false;
      });
    });
    if (narrowerThanEvery) continue;

    let hit = null;
    for (const w of want) if (offered.has(w)) { hit = w; break; }
    if (!hit) continue;

    matches.push({
      lane: e.lane,
      setName: e.setName,
      sourceRef: e.sourceRef || null,
      entryId: e.id,
      matchedOn: hit,
      derivedSetKey: derived,
      statedSetKey: stated,
      seededStatus: e.seededStatus || null,
      laneRank: LANE_RANK[e.lane] ?? 99,
    });
  }

  matches.sort(
    (a, b) =>
      a.laneRank - b.laneRank ||
      String(a.setName || "").length - String(b.setName || "").length ||
      String(a.entryId).localeCompare(String(b.entryId)),
  );
  return {
    matches,
    corroborated: new Set(matches.map((m) => m.lane)).size > 1,
  };
}

module.exports = {
  ACTIONABLE_REASONS,
  CONTESTED,
  LANE_RANK,
  SPORT_SUFFIX,
  slugOf,
  setKeyForEntry,
  cellKeyOf,
  groupIntoCells,
  rankCells,
  spellingsOf,
  contested,
  matchCellToManifest,
};
