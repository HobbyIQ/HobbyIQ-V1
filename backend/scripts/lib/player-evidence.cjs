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
 * ── THE READS ARE BOUNDED, AND A SLUG IS NOT ALWAYS A PARTITION ────────────
 *
 * `sold_comps` partitions on /cardId, and the first cut of this file assumed a
 * candidate slug IS a cardId, so it read ONLY `WHERE c.cardId = @slug` under
 * `{ partitionKey: slug }`. Measured on the Optic football 2024 cell that read
 * found nothing for 187 of 207 contended pairs, and the banner reported those
 * as `titles: not gathered` -- indistinguishable from "arm 2 never ran". Two
 * separate facts made the address wrong:
 *
 *   1. A CATALOG SLUG CARRIES A PRINT RUN; A SALE'S cardId DOES NOT.
 *      `card_catalog` ids are 8 segments -- hiq:sport:year:product:number:
 *      parallel:auto:TIER (`...:no-auto:num-24`). 91% of sale cardIds in this
 *      product are 7: the tier segment is absent. Querying the 8-segment slug
 *      asks for a partition that mostly cannot exist. Sampling 60 8-segment
 *      cells: 0 were reachable by the 8-segment cardId, 18 by the 7-segment
 *      stem.
 *
 *   2. HALF THE POOL IS NOT PARTITIONED BY CARD ADDRESS AT ALL.
 *      #1860 measured 584 of 1,044 CPA-DT rows sitting in VENDOR-ID partitions
 *      (`1746683330504x986376055087801600`) whose cardId is not an address.
 *      Those rows carry a real `hobbyiqCardId`, and CF-COUNT-WHAT-THE-ENGINE-
 *      READS says that is the field the pricing engine reads. Of the same 60
 *      cells, 59 were reachable ONLY through `hobbyiqCardId`, and 0 were
 *      genuinely empty.
 *
 * So the tally reads BOTH keys, and falls back from the full slug to its
 * 7-segment stem. The cardId arm stays partition-bounded; the hobbyiqCardId arm
 * cannot be -- a vendor partition is not derivable from a card address -- so it
 * is bounded by MAX_TITLES_PER_SLUG instead, and is an indexed equality
 * predicate rather than a scan.
 *
 * A SALE IS COUNTED ONCE. The arms overlap (a slug-partitioned row matches both
 * keys), so rows are de-duplicated by document id before they are tallied --
 * otherwise a row visible to both queries would cast two votes and a 3-2
 * majority could be manufactured out of one sale.
 *
 * AN ERROR IS NOT AN ABSENCE. A query that throws is reported as
 * `titles: error <reason>`, never as `not gathered`: the first says the read
 * failed, the second says the market is silent, and folding a player on the
 * second when the first is true is exactly the defect this file exists to end.
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

/** The 7-segment stem of a slug: hiq:sport:year:product:number:parallel:auto.
 *  A card_catalog id carries an 8th TIER segment (`num-24`, `psa-10`); a sale's
 *  cardId usually does not. Returns null when the slug is already <= 7 segments,
 *  so callers can skip a duplicate read. */
function stemOf(slug) {
  const parts = String(slug ?? "").split(":");
  return parts.length > 7 ? parts.slice(0, 7).join(":") : null;
}

/**
 * Read up to MAX_TITLES_PER_SLUG sale titles for ONE candidate slug and tally
 * them by player.
 *
 * FOUR ADDRESSES, ONE CARD. A sale of this card can be filed under the full
 * slug or its 7-segment stem, and under `cardId` (a card-address partition) or
 * `hobbyiqCardId` (a vendor-id partition). All four are asked; see the header
 * for the measurements that made each necessary. Reads stop as soon as `max`
 * distinct sales have been seen, so the extra addresses cost nothing on a cell
 * whose first read already satisfies the bound.
 *
 * De-duplicated by document id: the same row can answer more than one of the
 * four queries and must still be one vote.
 *
 * @returns {Promise<{tally: Map<string,{name:string,n:number}>, error: string|null}>}
 *          `error` non-null means a read FAILED -- the caller must not report
 *          that as an absence of titles.
 */
async function tallyTitlesForSlug(pool, slug, { retry, max = MAX_TITLES_PER_SLUG } = {}) {
  const tally = new Map();
  if (!pool || !slug) return { tally, error: null };
  const run = retry ?? ((fn) => fn());
  const seenIds = new Set();
  let error = null;

  const stem = stemOf(slug);
  // `partitionKey` is set ONLY for the cardId reads: those addresses are the
  // container's partition key. The hobbyiqCardId reads cannot name a partition
  // -- the row lives under a vendor id -- so they run as bounded equality
  // queries on an indexed field.
  const plans = [
    { field: "cardId", value: slug, partitionKey: slug },
    { field: "hobbyiqCardId", value: slug, partitionKey: null },
    ...(stem
      ? [
          { field: "cardId", value: stem, partitionKey: stem },
          { field: "hobbyiqCardId", value: stem, partitionKey: null },
        ]
      : []),
  ];

  for (const plan of plans) {
    if (seenIds.size >= max) break;
    try {
      const opts = { maxItemCount: Math.min(max, 200) };
      if (plan.partitionKey !== null) opts.partitionKey = plan.partitionKey;
      const it = pool.items.query(
        {
          query: `SELECT c.id, c.playerName, c.title FROM c WHERE c.${plan.field} = @v`,
          parameters: [{ name: "@v", value: plan.value }],
        },
        opts,
      );
      while (it.hasMoreResults() && seenIds.size < max) {
        const { resources } = await run(() => it.fetchNext());
        for (const row of resources ?? []) {
          if (seenIds.size >= max) break;
          // One sale is one vote no matter how many addresses reach it.
          const rid = String(row?.id ?? "");
          if (rid && seenIds.has(rid)) continue;
          if (rid) seenIds.add(rid);
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
    } catch (e) {
      // Remember the FIRST failure and keep asking the other addresses: a
      // throttled partition read should not erase titles another address can
      // still supply. The caller surfaces `error` when the tally is empty.
      error = error ?? `${plan.field}: ${String(e?.message ?? e).slice(0, 120)}`;
    }
  }
  return { tally, error };
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
 * @returns {Promise<null | {rivals?: Array, titlePlayerCounts?: Object, titlesError?: string}>}
 *          `null` when nothing at all was gathered AND nothing failed -- the
 *          fail-safe. `titlesError` means a read threw; it is never a vote.
 */
async function gatherPlayerEvidence(pool, incoming, incumbent, opts = {}) {
  const { incomingSlug, incumbentSlug, rivals = null, retry } = opts;

  // ── arm 2: the sale titles' majority ──────────────────────────────────────
  const counts = {};
  const slugs = [...new Set([incomingSlug, incumbentSlug].filter(Boolean))];
  let titlesError = null;
  if (pool && slugs.length) {
    for (const slug of slugs) {
      const { tally, error } = await tallyTitlesForSlug(pool, slug, { retry });
      if (error) titlesError = titlesError ?? error;
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
  // would claim a gathering that did not happen. A read that FAILED is not
  // nothing, though: it is carried so the banner can say `error` rather than
  // `not gathered`, which are different findings for a human to act on.
  if (!haveTitles && !haveRivals && !titlesError) return null;

  const evidence = {};
  if (haveRivals) evidence.rivals = rivals;
  if (haveTitles) evidence.titlePlayerCounts = counts;
  // Never consulted by `chooseSurvivor` -- the rule's arms are unchanged, and a
  // failed read must not become a vote. It exists so the banner can distinguish
  // a silent market from a broken query.
  if (titlesError) evidence.titlesError = titlesError;
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
  // A FAILED read is named as an error: "not gathered" would say the market is
  // silent, and a human settling this pair would draw the wrong conclusion.
  let arm2 = evidence?.titlesError ? `titles: error ${evidence.titlesError}` : "titles: not gathered";
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
    const errNote = evidence?.titlesError ? `; PARTIAL -- a read failed: ${evidence.titlesError}` : "";
    arm2 = `titles: "${nameIn}" x${nIn} vs "${nameInc}" x${nInc}${topNote}${errNote}`;
  }

  const by = result?.playerArbitration?.by
    ?? (result?.action === "refused" ? "neither arm — REFUSED" : "the ordinary ladder");
  return `${arm1} | ${arm2} | decided by: ${by}`;
}

module.exports = {
  MAX_TITLES_PER_SLUG,
  playerKeyOf,
  stemOf,
  tallyTitlesForSlug,
  gatherPlayerEvidence,
  gatherRivalRows,
  describePlayerEvidence,
};
