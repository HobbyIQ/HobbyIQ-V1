"use strict";
/**
 * player-evidence.cjs -- gather the evidence a fold needs to settle a
 * DIFFERENT-PLAYER collision, once, for every caller that folds twins.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * #1838 put the survivor rule in `chooseSurvivor` (CF-A-FOLD-NEVER-CHANGES-THE-
 * PLAYER) and gave it a seam -- `playerEvidence` -- with two arms:
 *
 *   rivals             the other catalog rows at this identity cell, handed to
 *                      `corroborationOf`;
 *   titlePlayerCounts  playerName -> how many refereed sold_comps titles name
 *                      that person at this card number.
 *
 * It shipped the seam WIRED NOWHERE. `playerEvidence` is optional and omitting
 * it means "I gathered nothing", so every different-player twin REFUSES. That
 * is the correct fail-safe and it is why #1838 was safe to merge -- but it is
 * not the ruling. The ruling is that corroboration DECIDES, and a rule that can
 * only ever refuse has no arms at all. Measured on the Optic football 2024 cell
 * by `probe-optic-fold-corroboration.cjs`: 30 alias wins and 30 dest wins are
 * decidable on evidence, and unwired they would have been 60 more refusals on
 * top of the genuine 147.
 *
 * ── WHY ONE MODULE AND NOT ONE PER SCRIPT ───────────────────────────────────
 *
 * The same reason `chooseSurvivor` holds the rule rather than each script:
 * fifteen copies of one catalog operation carried four defects spread between
 * them, and `catalogAuthority`'s header records that five call sites answering
 * "does this row count as evidence?" five ways flipped 51 card-number prefixes.
 * Four lanes fold twins. Four gatherings of the same evidence would be four
 * chances to bound the read differently, count a graded child as a title, or
 * quietly scan cross-partition.
 *
 * ── THE READS ARE PARTITION-BOUNDED, AND THAT IS A CORRECTNESS CLAIM ────────
 *
 * `sold_comps` partitions on /cardId, and a candidate slug IS a cardId. So the
 * titles for a contended cell are read with `WHERE c.cardId = @slug` under
 * `{ partitionKey: slug }` -- the shape `relocatePartitionKeyedSales` already
 * uses -- once per candidate slug, never a cross-partition scan.
 *
 * `probe-optic-fold-corroboration.cjs` reads the whole product in ONE
 * cross-partition query and buckets it in memory. That is right for a probe:
 * one query, read-only, over a scope a human named. It is WRONG here. This runs
 * inside a fleet lane, per contended pair, under a budget; a cross-partition
 * query per fold would be a full-container scan per fold. The probe's ARITHMETIC
 * is reproduced exactly (count titles per player at the number, majority wins);
 * its QUERY SHAPE deliberately is not.
 *
 * SAMPLE BOUND. At most `MAX_TITLES_PER_SLUG` (200) titles are read per
 * candidate slug. A majority that needs more than 200 titles to show itself is
 * not a majority worth folding a player on, and an unbounded read here is how a
 * lane with a 6,000-row scope acquires a 40x slowdown (#1667, recorded in
 * `feedback_fleet_scripts_measure_throughput_before_dispatch`).
 *
 * ── WHAT IS NOT COUNTED ─────────────────────────────────────────────────────
 *
 * A sale with no `playerName` is not a vote -- it is a row the parser did not
 * finish, and counting it as "nobody" would let parser coverage decide who is
 * on a card. Graded-tier rows under the same cardId ARE counted: a PSA 10 sale
 * of the card names the same player as a raw one, and the arm is about WHO, not
 * about tier.
 *
 * ── THE FAIL-SAFE IS PRESERVED ──────────────────────────────────────────────
 *
 * Gathering that finds nothing returns `null`, NOT an empty object. An empty
 * `{}` would still be "I gathered", and `chooseSurvivor` would run its arms
 * against zero counts and fall to the refusal anyway -- but `null` says the
 * true thing, and it keeps "no evidence -> refused" a property of this module
 * rather than an accident of how the arms happen to be written.
 */
const { corroborationOf } = require(require("path").join(__dirname, "source-corroboration.cjs"));

/** Never read more than this many titles from one candidate slug. */
const MAX_TITLES_PER_SLUG = 200;

/** A player name reduced to the letters and digits that identify it, so
 *  "T.J. Hockenson" and "TJ Hockenson" are one person. This mirrors
 *  `playerKey` in sourceCorroboration.ts and `playerKeyOf` in
 *  catalogRowOps.service.ts -- the SAME reduction all three must agree on for a
 *  tally here to mean the same thing the survivor rule reads. */
const playerKeyOf = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Read up to MAX_TITLES_PER_SLUG sale titles from ONE partition and tally them
 * by player. Partition-bounded: `c.cardId = @slug` under `partitionKey: slug`.
 *
 * @returns {Promise<Map<string, {name: string, n: number}>>} playerKey -> tally
 */
async function tallyTitlesForSlug(pool, slug, { retry, max = MAX_TITLES_PER_SLUG } = {}) {
  const tally = new Map();
  if (!pool || !slug) return tally;
  const run = retry ?? ((fn) => fn());
  const it = pool.items.query(
    {
      query: "SELECT c.playerName, c.title FROM c WHERE c.cardId = @slug",
      parameters: [{ name: "@slug", value: slug }],
    },
    { partitionKey: slug, maxItemCount: Math.min(max, 200) },
  );
  let seen = 0;
  while (it.hasMoreResults() && seen < max) {
    const { resources } = await run(() => it.fetchNext());
    for (const row of resources ?? []) {
      if (seen >= max) break;
      seen++;
      // A sale the parser could not name is not a vote. See the header.
      const name = String(row?.playerName ?? "").trim();
      if (!name) continue;
      const k = playerKeyOf(name);
      if (!k) continue;
      const cur = tally.get(k) ?? { name, n: 0 };
      cur.n++;
      tally.set(k, cur);
    }
  }
  return tally;
}

/**
 * Gather `playerEvidence` for a contended fold: the row being moved and the
 * incumbent it would fold onto.
 *
 * BOTH candidate slugs are read, because the sales for one card can sit under
 * either address while a product is mid-rekey -- that is the very condition
 * these lanes exist to repair. The two tallies are SUMMED: they are sales of
 * the same physical card number under two spellings of one product, and the
 * question the arm asks ("who does the market say is at this number?") is
 * indifferent to which spelling a sale was filed under.
 *
 * @param {object}  pool        sold_comps container (null -> arm 2 is skipped)
 * @param {object}  incoming    the catalog row being moved
 * @param {object}  incumbent   the row already at the destination (or null)
 * @param {object}  opts
 * @param {string}  opts.incomingSlug   partition to read for the moving row
 * @param {string}  opts.incumbentSlug  partition to read for the incumbent
 * @param {Array}   opts.rivals         catalog rows at this cell, for arm 1
 * @param {Function} opts.retry
 * @returns {Promise<null | {rivals?: Array, titlePlayerCounts?: Object}>}
 *          `null` when nothing at all was gathered -- the fail-safe.
 */
async function gatherPlayerEvidence(pool, incoming, incumbent, opts = {}) {
  const { incomingSlug, incumbentSlug, rivals = null, retry } = opts;

  // ── arm 2: the sale titles' majority ──────────────────────────────────────
  const counts = {};
  const slugs = [...new Set([incomingSlug, incumbentSlug].filter(Boolean))];
  let readAny = false;
  if (pool && slugs.length) {
    for (const slug of slugs) {
      const tally = await tallyTitlesForSlug(pool, slug, { retry });
      readAny = true;
      for (const { name, n } of tally.values()) {
        // Keyed by DISPLAY name; chooseSurvivor re-keys with its own
        // playerKeyOf, so two spellings of one person merge there rather than
        // splitting a majority here.
        counts[name] = (counts[name] ?? 0) + n;
      }
    }
  }

  const haveTitles = Object.keys(counts).length > 0;
  const haveRivals = Array.isArray(rivals) && rivals.length > 0;
  // Nothing gathered at all -> say so, and let the rule refuse. An empty object
  // would claim a gathering that did not happen.
  if (!haveTitles && !haveRivals) return null;

  const evidence = {};
  if (haveRivals) evidence.rivals = rivals;
  if (haveTitles) evidence.titlePlayerCounts = counts;
  // `readAny` is not carried: the seam's contract is the two arms, and a caller
  // that read a partition and found no named title gathered nothing usable.
  void readAny;
  return evidence;
}

/**
 * Read the catalog rows at the destination cell that could corroborate, for
 * arm 1. Point-reads the incumbent's own address is NOT enough -- the arm asks
 * whether a THIRD source names the same player at the same cell -- so this
 * reads the identity rows sharing the destination's (number, parallel) across
 * the product's other sources.
 *
 * Bounded to the destination partition's own id prefix, which is a
 * STARTSWITH on the row id and therefore index-served.
 */
async function gatherRivalRows(cat, destSlug, { retry, max = 50 } = {}) {
  if (!cat || !destSlug) return [];
  const parts = String(destSlug).split(":");
  if (parts.length < 7) return [];
  // hiq:sport:year:setKey:number: -- every parallel/auto variant at this number
  const prefix = parts.slice(0, 5).join(":") + ":";
  const run = retry ?? ((fn) => fn());
  const out = [];
  const it = cat.items.query(
    {
      query:
        "SELECT c.id, c.source, c.gradeTier, c.playerName, c.sport, c.cardYear, c.year, " +
        "c.setKey, c.cardNumber, c.parallelSlug, c.isAuto FROM c WHERE STARTSWITH(c.id, @p)",
      parameters: [{ name: "@p", value: prefix }],
    },
    { maxItemCount: Math.min(max, 100) },
  );
  while (it.hasMoreResults() && out.length < max) {
    const { resources } = await run(() => it.fetchNext());
    for (const r of resources ?? []) {
      if (out.length >= max) break;
      out.push(r);
    }
  }
  return out;
}

/**
 * The banner line for ONE fold: what the two arms saw and which one decided.
 * Printed per contended pair so a reader can settle a refusal without re-running
 * the probe, and can audit a fold that DID resolve.
 */
function describePlayerEvidence(incoming, incumbent, evidence, result) {
  const nameIn = String(incoming?.playerName ?? "").trim() || "(unnamed)";
  const nameInc = String(incumbent?.playerName ?? "").trim() || "(unnamed)";
  const counts = evidence?.titlePlayerCounts ?? null;
  const rivals = evidence?.rivals ?? null;

  // arm 1, restated from the same predicate the rule used -- not a second
  // spelling of the question.
  let arm1 = "corroborationOf: not gathered";
  if (rivals) {
    const cIn = corroborationOf(incoming, rivals);
    const cInc = corroborationOf(incumbent, rivals);
    arm1 = `corroborationOf: "${nameIn}"=${cIn?.verdict ?? "?"} vs "${nameInc}"=${cInc?.verdict ?? "?"}`;
  }

  // arm 2, as counts, so the majority is auditable and not just its verdict.
  let arm2 = "titles: not gathered";
  if (counts) {
    let nIn = 0;
    let nInc = 0;
    const kIn = playerKeyOf(nameIn);
    const kInc = playerKeyOf(nameInc);
    for (const [name, n] of Object.entries(counts)) {
      const k = playerKeyOf(name);
      if (k === kIn) nIn += Number(n) || 0;
      else if (k === kInc) nInc += Number(n) || 0;
    }
    const top = Object.entries(counts).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))[0];
    const topNote = top && playerKeyOf(top[0]) !== kIn && playerKeyOf(top[0]) !== kInc
      ? `; market's top is a THIRD player "${top[0]}" x${top[1]}`
      : "";
    arm2 = `titles: "${nameIn}" x${nIn} vs "${nameInc}" x${nInc}${topNote}`;
  }

  const by = result?.playerArbitration?.by
    ?? (result?.action === "refused" ? "neither arm — REFUSED" : "the ordinary ladder");
  return `${arm1} | ${arm2} | decided by: ${by}`;
}

module.exports = {
  MAX_TITLES_PER_SLUG,
  playerKeyOf,
  tallyTitlesForSlug,
  gatherPlayerEvidence,
  gatherRivalRows,
  describePlayerEvidence,
};
