#!/usr/bin/env node
/**
 * rematch-canary-check.cjs -- the gate between a clean census and an apply.
 *
 * CF-THE-CANARY-IS-A-HAND-VERIFIED-POOL (GREAT REMATCH, Drew 2026-09-01).
 * The GREAT REMATCH may auto-apply its IMPROVE class, and an auto-apply needs
 * something outside itself that says the pool got better and not merely
 * different. The canaries are the holdings whose pools Drew verified by hand:
 * their FMV inputs are known-good, so a shard that moves one of them away from
 * its verified market has done damage, whatever its own banner says.
 *
 * This script does NOT price. It measures the INPUTS that decide the price,
 * because those are what a re-key can move and they can be measured without
 * the estimator's 180-day windows, calibration tables or dist/ build:
 *
 *   rows          how many sales the pool holds -- the union of the slug's own
 *                 partition (c.cardId) and the rows that merely CARRY it
 *                 (c.hobbyiqCardId). Measured 2026-09-01, the split is real:
 *                 Shaq has 2 rows under the partition and 55 carrying the
 *                 slug; Judge Gold Label has 5 under the partition and 0
 *                 carrying it. A check that read one field would see a healthy
 *                 pool vanish and call it unchanged.
 *   anchor        the leading-edge price: the median of the newest 3 sales.
 *                 FMV is the projected next sale from the pool's trend, never
 *                 a median of the pool -- but the ANCHOR the projection starts
 *                 from is a recency-weighted level, and a re-key that changes
 *                 which sales are newest moves it. That is the thing to watch.
 *   newest        the newest sale's date and price, so a pool that lost its
 *                 leading edge is visible even when the count barely moves.
 *   protected     how many rows in the pool are provenance-protected. This
 *                 must NEVER fall: a protected row that left the pool means a
 *                 write touched something no fleet may touch.
 *
 * WHAT COUNTS AS A REGRESSION -- and exits nonzero
 *
 *   1. the pool LOST rows AND the departures are UNACCOUNTED FOR. A rematch
 *      moves sales between pools; a verified pool losing sales with nothing
 *      to show for it is the split-pool defect the rematch exists to end,
 *      arriving from the other direction. (Rows GAINED are fine and expected:
 *      that is a mis-filed sale coming home.) A departure that carries the
 *      apply's own `rekeyedFrom` marker is ACCOUNTED FOR and is a note, not a
 *      regression -- see "AN IMPROVE RE-KEY IS ALSO AN ACCOUNTED-FOR
 *      DEPARTURE" in compareCanary. An unmarked disappearance still fails.
 *   2. the pool went EMPTY. Three canaries have 1-row pools; there is no
 *      "small regression" available to them.
 *   3. a PROTECTED row left the pool. Report-only forever means exactly this.
 *   4. the anchor moved more than ANCHOR_TOLERANCE_PCT (default 10%) away
 *      from its verified level. A pool whose leading edge jumps has had its
 *      composition changed, and a hand-verified pool should not change.
 *
 * A canary that GAINS rows and holds its anchor PASSES, and the banner says so
 * -- the point is to catch damage, not to freeze the pool.
 *
 * A VERDICT MUST BE ATTRIBUTED (2026-09-04, the second false halt).
 *
 * Every rule above answers "did this pool change?". None of them answered the
 * question that decides whether THIS SHARD is damage: "did this shard change
 * it?". sold_comps has many writers -- the CardHedge daily ingest, the nightly
 * dedup, the Panini and tcgdexja lanes -- and an apply takes over an hour, so
 * the pool moves under the gate no matter what the shard does.
 *
 * Two shards proved the gap. Both reconciled `intended 0 = written 0` -- their
 * candidates had already been applied by an earlier pass -- and both exited 5.
 * Slot 1 was failed on the slot-14 canary and the slot-26 canary; slot 2 on the
 * same two. The same canary reported TWO DIFFERENT after-values in the two runs
 * ($23.39 -> $4.69 at 08:04Z, $23.39 -> $2.85 at 08:15Z) because CardHedge was
 * landing new sales the whole time. Read against the pool afterwards: 4 new CH
 * rows in the 2025 bowman-draft bdc-1 pool and 7 in the 1986 fleer-stickers
 * pool, all ingested between 07:50Z and 08:26Z, zero rows rekeyed in, zero
 * evicted away, zero rekeys of any kind touching either slug. A shard that
 * wrote nothing cannot have regressed a pool.
 *
 * So the gate now reads the apply's WRITE LEDGER (pool -> ids written, emitted
 * by rematch-sold-comps into WRITE_LEDGER, same job, same runner) and splits
 * every canary in two:
 *
 *   TOUCHED   the ledger names this canary's pool. The #1711 rules apply in
 *             full and unchanged: losses must be accounted for by the eviction
 *             marker, anchor moves are notes on a parallel canary under
 *             eviction scope and strict on a base canary.
 *   UNTOUCHED the ledger does not name it. This shard did not write here, so
 *             anchor moves and row-count changes are NOTES naming the other
 *             writers -- never exit 5. What survives untouched is only what no
 *             writer may ever do: a PROTECTED row leaving, and a pool going
 *             EMPTY. Those are alarms about the pool itself, not about whose
 *             write did it, and they still stop the fleet.
 *
 * A MISSING ledger is not an excuse to pass. Without one the checker cannot
 * attribute anything, so it falls back to treating every canary as TOUCHED --
 * the old, strict behaviour. A gate degrades closed.
 *
 * WHERE THIS SITS IN THE SEQUENCE (the apply dispatcher runs it, not the
 * fleet script -- a script cannot certify itself):
 *
 *   1. dispatch rematch-sold-comps MODE=census for the shard          READ ONLY
 *   2. audit 500 rows of that shard's IMPROVE bucket from the census
 *      JSON. Not clean -> STOP, the shard goes to Drew.
 *   3. rematch-canary-check.cjs MODE=before   -> writes the baseline
 *   4. dispatch rematch-sold-comps MODE=apply-improve apply=true for
 *      THAT SHARD ONLY
 *   5. rematch-canary-check.cjs MODE=after    -> compares to the baseline,
 *      exits 5 on any regression
 *   6. exit 5 -> the shard is a regression: STOP the fleet, hand Drew the
 *      diff. Do not proceed to the next shard.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      MODE=before | after | check   (default check: measure and print only)
 *      BASELINE=/tmp/rematch-canary-baseline.json
 *      CANARIES=backend/data/rematch-canaries.json
 *      ANCHOR_TOLERANCE_PCT=10
 *      SCOPE=base-eviction | improve | both   (the apply class scope; under an
 *            eviction scope a PARALLEL canary is expected to lose base rows,
 *            and the loss must be accounted for by the eviction marker)
 * READ ONLY against Cosmos in every mode -- it never writes to the pool.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const MODE = String(process.env.MODE || "check").trim();
const BASELINE = String(process.env.BASELINE || "/tmp/rematch-canary-baseline.json");
const CANARIES = String(process.env.CANARIES || path.join(__dirname, "..", "data", "rematch-canaries.json"));
const TOL = Number(process.env.ANCHOR_TOLERANCE_PCT || 10);
// The ledger the apply emits (pool -> ids written). Same job, same runner, so
// the gate reads the file the apply just wrote. Absent -> attribute nothing
// and stay strict; see "A VERDICT MUST BE ATTRIBUTED" above.
const WRITE_LEDGER = String(process.env.WRITE_LEDGER || "/tmp/rematch-write-ledger.json").trim();

const f = (n) => Number(n ?? 0).toLocaleString();
const money = (n) => (n === null || n === undefined ? "-" : `$${Number(n).toFixed(2)}`);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** Median of a numeric list. Used ONLY for the leading-edge anchor of the
 *  newest 3 sales -- never as an FMV. FMV is the projected next sale. */
function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * The FMV inputs of one canary pool. Pure given the rows, so a test can drive
 * it without Cosmos.
 */
function poolInputs(rows) {
  const sorted = rows.slice().sort((a, b) => Date.parse(String(b.soldAt ?? 0)) - Date.parse(String(a.soldAt ?? 0)));
  const newest = sorted[0] ?? null;
  const anchor = median(sorted.slice(0, 3).map((r) => Number(r.price)));
  const protectedRows = rows.filter((r) => K.provenanceTier(r).tier === K.PROTECTED);
  return {
    rows: rows.length,
    byPartition: rows.filter((r) => r.__viaPartition).length,
    byField: rows.filter((r) => !r.__viaPartition).length,
    anchor,
    newestAt: newest?.soldAt ?? null,
    newestPrice: newest === null ? null : Number(newest.price),
    protectedRows: protectedRows.length,
    protectedIds: protectedRows.map((r) => `${r.id}@${r.cardId}`).sort(),
  };
}

/**
 * Compare one canary's before/after inputs. Returns { ok, regressions[],
 * notes[] } -- `regressions` non-empty is a shard failure.
 */
function compareCanary(canary, before, after, tolPct = TOL, touch) {
  const regressions = [], notes = [];
  // ATTRIBUTION. `touch` is this canary's row in the apply's write ledger:
  //   null      no ledger at all -> attribute nothing, stay strict (degrade closed)
  //   {...}     the shard wrote in this pool  -> TOUCHED, the full rules apply
  //   undefined the ledger exists and does NOT name this pool -> UNTOUCHED
  //
  // `undefined` and `null` mean OPPOSITE things here, so this argument must
  // NOT carry a default: `touch = null` would silently turn "the ledger does
  // not name this pool" (the common, relaxing case) into "there is no ledger"
  // (the strict one), and the attribution would never fire. A caller that
  // omits the argument entirely is a caller with no ledger, which is the
  // strict reading -- so absence is normalised to null explicitly below.
  const noLedger = arguments.length < 5 || touch === null;
  const attributed = !noLedger;
  const touched = noLedger || touch !== undefined;
  const moved = touched && touch ? (Number(touch.fromCount ?? 0) + Number(touch.toCount ?? 0)) : 0;
  if (attributed && !touched) notes.push(`this shard wrote NO rows in this pool -- changes below belong to other writers`);
  else if (attributed && touched) notes.push(`this shard moved ${moved} row(s) in this pool (out ${Number(touch.fromCount ?? 0)}, in ${Number(touch.toCount ?? 0)})`);
  // A PARALLEL-POOL CANARY IS SUPPOSED TO LOSE BASE ROWS (2026-09-04).
  //
  // "rows went down" was written for the IMPROVE class, where a verified pool
  // has no reason to shrink. Under scope=base-eviction the whole POINT is that
  // base-titled sales mis-filed on a parallel slug leave for the base pool, so
  // on a parallel canary a loss is the intended effect and the old rule fails
  // the shard for doing its job. On a BASE canary (slug parallel is base) no
  // eviction can ever remove a row, so there the rule still holds exactly.
  //
  // What must be asserted instead is that every row that left is ACCOUNTED
  // FOR: it carries the eviction marker, it is base-titled, and it landed on
  // the base identity. The checker cannot see the destination rows, so it
  // asserts what it can -- that the departures are attributable to this
  // apply -- and `unexplainedLoss` (rows that vanished with no eviction
  // marker) stays a regression in every scope. An anchor move is a NOTE under
  // eviction scope rather than a failure, because removing mis-filed sales is
  // expected to move the leading edge.
  // SCOPE is the variable the backfill runner already passes to the fleet
  // script as its APPLY CLASS SCOPE, so the gate and the apply read the SAME
  // value and cannot disagree about which class ran. APPLY_SCOPE is accepted
  // as an alias for a hand-run check.
  const evictionScope = String(process.env.SCOPE || process.env.APPLY_SCOPE || "").toLowerCase().includes("eviction");
  const canaryIsParallel = !/:(base|no-parallel)?:(auto|no-auto)$/.test(String(canary.slug || "")) &&
    !/:base:(auto|no-auto)$/.test(String(canary.slug || ""));
  const lossIsExpected = evictionScope && canaryIsParallel;
  // AN IMPROVE RE-KEY IS ALSO AN ACCOUNTED-FOR DEPARTURE (2026-09-05, wave 2).
  //
  // Slots 5 and 6 both exited 5 on the Gonzalez CPA-JG /499 canary, and the
  // three rows they were blamed for are the lane working exactly as specified.
  // Read from the rows themselves:
  //
  //   tca-ebay::407113176192  $100.00   "2026 Bowman Redemption Justin Gonzalez Refractor Auto /499"
  //   tca-ebay::198573811927  $148.00   "REDEMPTION : Justin Gonzales [Refractor /499] #CPA-JG 2026 Bowman Chrome Auto"
  //   tca-ebay::287538862055  $224.99   "2026 Bowman Chrome Justin Gonzales 1st Auto Refractor /499 #CPA-JG"
  //
  // Every one carries `setName: "Bowman Chrome"` in its OWN fields, so
  // `storedIdentity` (which reads setName, not the slug) already derived
  // setKey `bowman-chrome`. The setKey axis was SAME, not changed; the only
  // axis that moved was printRun, absent on the row and 499 on the checklist.
  // The class was IMPROVE/filled:printRun onto a checklist-backed destination
  // (`checklistcenter-2026-08-29`, verified, printRun 499) and the write made
  // the row's ADDRESS agree with the identity the row already stated.
  //
  // The pool did not lose three sales; three sales that were never Bowman
  // paper stopped being counted as Bowman paper. Drew's own protected row
  // (`ebay-user-purchase::147349440137-...`, setName "2026 Bowman") did NOT
  // move and is still on the holding's slug -- the boundary held precisely.
  //
  // WHY THIS IS A SEPARATE CLAUSE AND NOT A RELAXED `lost` RULE. The eviction
  // scope already had a way to say "this departure was mine and it was
  // intended"; IMPROVE had none, so ANY attributed departure read as damage
  // and the lane could never move a row out of a canary pool without halting
  // the fleet. What is asserted is the same thing the eviction clause asserts
  // -- that every row that left is ACCOUNTED FOR by the marker the apply wrote
  // -- so an unmarked disappearance is still a regression in every scope.
  const lost = before.rows - after.rows;
  const improveExplained = Number(after.improveRekeyedAway ?? 0);
  // THE MARKER IS THE BOUND, NOT THE LEDGER'S `fromCount`.
  //
  // The obvious extra guard -- "a shard may not excuse more rows than its own
  // ledger says it moved" -- is WRONG here, and slot 6 is the proof. It
  // measured 3 departures (13 -> 10) while its ledger named 2, because slot 5
  // had already moved the third before slot 6's baseline was taken. Bounding
  // by `fromCount` failed that shard while simultaneously reporting
  // "0 unexplained", which is a self-contradicting verdict.
  //
  // The honest control is the one the eviction clause already uses: every row
  // that LEFT must carry the apply's `rekeyedFrom` marker, counted from the
  // rows themselves rather than from any one shard's bookkeeping. The marker
  // is written per row by the apply, and `measure()` only counts a marked row
  // when it is genuinely no longer in the pool -- so an unmarked
  // disappearance, which is the damage this gate exists to catch, can never be
  // laundered through it. `touched` still requires this shard to have written
  // here at all, and `lost > 0` keeps it from excusing an anchor move with no
  // departure behind it.
  //
  // AND IT REQUIRES A LEDGER. `touched` is true on the degrade-closed path too
  // (no ledger at all), and there the gate cannot tell WHOSE re-key that marker
  // records -- the marker is written by every apply, not just this one. A
  // checker that cannot attribute must not hand out passes it did not earn, so
  // `attributed` is required exactly as the module header promises.
  const improveLossFullyAccounted = attributed && touched && lost > 0
    && !lossIsExpected
    && improveExplained >= lost;
  if (after.rows < before.rows) {
    const explained = Number(after.evictedAway ?? 0);
    // A pool this shard never wrote in cannot have been drained by it. The
    // nightly dedup retiring a duplicate id, or any other lane, is a NOTE.
    if (!touched) notes.push(`pool changed by other writers: ${lost} fewer row(s) (${before.rows} -> ${after.rows}) -- this shard wrote nothing here`);
    else if (lossIsExpected && explained >= lost) notes.push(`pool lost ${lost} row(s) to base eviction, all ${explained} accounted for by the eviction marker -- the intended effect`);
    else if (lossIsExpected) regressions.push(`pool LOST ${lost} row(s): ${before.rows} -> ${after.rows}, but only ${explained} carry the eviction marker -- ${lost - explained} unexplained`);
    // The IMPROVE re-key clause. A departure is discounted only when the
    // apply's own `rekeyedFrom` marker accounts for it, and only in a pool
    // this shard actually wrote in. See the note on the flag above for why
    // the ledger's `fromCount` is deliberately NOT an additional bound.
    else if (improveLossFullyAccounted) {
      notes.push(`pool lost ${lost} row(s) to an IMPROVE re-key, all ${improveExplained} accounted for by the rekeyedFrom marker -- a sale moving to the identity its own fields already state`);
      if ((after.improveRekeyedIds ?? []).length) notes.push(`  re-keyed away: ${after.improveRekeyedIds.join(", ")}`);
    }
    else if (improveExplained > 0) regressions.push(`pool LOST ${lost} row(s): ${before.rows} -> ${after.rows}, but only ${improveExplained} carry the re-key marker -- ${lost - improveExplained} unexplained`);
    else regressions.push(`pool LOST ${lost} row(s): ${before.rows} -> ${after.rows}`);
  }
  else if (after.rows > before.rows) {
    const gained = after.rows - before.rows;
    if (!touched) notes.push(`pool changed by other writers: +${gained} row(s) (${before.rows} -> ${after.rows}) -- this shard wrote nothing here`);
    else notes.push(`pool gained ${gained} row(s) -- a mis-filed sale coming home`);
  }
  if (after.rows === 0) regressions.push("pool is EMPTY");
  if (after.protectedRows < before.protectedRows) {
    const gone = before.protectedIds.filter((x) => !after.protectedIds.includes(x));
    regressions.push(`a PROTECTED row left the pool (${before.protectedRows} -> ${after.protectedRows})${gone.length ? `: ${gone.join(", ")}` : ""}`);
  }
  if (before.anchor !== null && after.anchor !== null && before.anchor > 0) {
    const movePct = Math.abs((after.anchor - before.anchor) / before.anchor) * 100;
    // THE ANCHOR MOVES ON ITS OWN. It is the median of the newest 3 sales, so
    // a single new sale from the CardHedge daily ingest redefines it -- which
    // is exactly what failed two zero-write shards on 2026-09-04. An anchor
    // move in a pool this shard never wrote in is news about the market, not
    // damage by the shard.
    if (movePct > tolPct && !touched) notes.push(`pool changed by other writers: anchor moved ${movePct.toFixed(1)}%: ${money(before.anchor)} -> ${money(after.anchor)} -- this shard wrote nothing here, the leading edge moved under new sales`);
    else if (movePct > tolPct && lossIsExpected) notes.push(`anchor moved ${movePct.toFixed(1)}%: ${money(before.anchor)} -> ${money(after.anchor)} -- expected under base eviction, the leading edge is recomputed once mis-filed sales leave`);
    // Same reasoning as the loss clause above: once a departure is ACCOUNTED
    // FOR by the re-key marker, the leading edge is SUPPOSED to be recomputed
    // without those sales -- that is the point of moving them. The Gonzalez
    // canary lost its $100 and $148 rows, so an anchor that did not move would
    // be the surprising outcome. Gated on the same accounting as the loss, so
    // an unexplained departure still fails on both counts.
    else if (movePct > tolPct && improveLossFullyAccounted) notes.push(`anchor moved ${movePct.toFixed(1)}%: ${money(before.anchor)} -> ${money(after.anchor)} -- expected: every departure carries the IMPROVE re-key marker, so the leading edge is recomputed without them`);
    else if (movePct > tolPct) regressions.push(`anchor moved ${movePct.toFixed(1)}% (tolerance ${tolPct}%): ${money(before.anchor)} -> ${money(after.anchor)}`);
    else if (movePct > 0) notes.push(`anchor moved ${movePct.toFixed(1)}% within tolerance`);
  } else if (before.anchor !== null && after.anchor === null) {
    // An anchor that vanished means the pool has no priced sale left. That is
    // a statement about the pool, not about who emptied it -- it stands in
    // every scope, touched or not, like PROTECTED and EMPTY.
    regressions.push(`anchor is gone: ${money(before.anchor)} -> none`);
  }
  return { name: canary.name, slug: canary.slug, ok: regressions.length === 0, touched, attributed, moved, regressions, notes };
}

async function measure(pool, slug) {
  const all = async (q, p) => { const it = pool.items.query({ query: q, parameters: p }, { maxItemCount: 1000 }); const o = []; while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); o.push(...(resources ?? [])); } return o; };
  // The union, deliberately: a pool split across the partition and the field is
  // exactly the state the rematch is fixing, and a check that read one field
  // would call a vanished pool unchanged.
  const byPartition = await all("SELECT * FROM c WHERE c.cardId = @s", [{ name: "@s", value: slug }]);
  const byField = await all("SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.cardId != @s", [{ name: "@s", value: slug }]);
  for (const r of byPartition) r.__viaPartition = true;
  // THE UNION IS DE-DUPLICATED BY id (2026-09-04 incident).
  //
  // A sale can appear twice in this union -- the same id under two cardIds
  // (a cross-source CH/CS pair), or a row whose cardId and hobbiqCardId both
  // point here. Counting the raw concatenation makes the pool look larger
  // than it is, and then the NIGHTLY DEDUP job (04:45 UTC, cross_source=true)
  // collapsing that pair reads as "the pool LOST a row" to a check whose
  // baseline was taken before it ran. That is exactly what failed the wave of
  // 2026-09-04: four canaries reported losses of 1-3 rows, and every one of
  // them was a duplicate id being retired by a concurrent job -- zero rows had
  // left any canary pool to a base eviction.
  //
  // A pool is a set of SALES, so the count that gates a fleet must be a count
  // of distinct sales.
  // Rows that LEFT this slug by a base eviction, counted from the marker the
  // apply writes onto the relocated row (rekeyedFrom[0].cardId is the pool it
  // came from). This is what makes a loss EXPLAINABLE instead of merely
  // observed: an eviction that moved a sale to its base pool is attributable,
  // and anything else that removed a row is not.
  const evicted = await all(
    "SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.baseEvictionEvidence) AND ARRAY_LENGTH(c.rekeyedFrom) > 0 AND c.rekeyedFrom[0].cardId = @s",
    [{ name: "@s", value: slug }]
  );
  // Rows that LEFT this slug by an IMPROVE re-key, counted from the SAME
  // marker (2026-09-05, the wave-2 halt). See "AN IMPROVE RE-KEY IS ALSO AN
  // ACCOUNTED-FOR DEPARTURE" in compareCanary: the eviction path had a way to
  // say "this loss was mine and it was intended" and the IMPROVE path did not,
  // so a lane doing exactly its job read as damage.
  //
  // The `baseEvictionEvidence` field is what separates the two populations --
  // the eviction branch writes it, the IMPROVE branch does not -- so the two
  // counts partition the departures rather than double-counting them.
  const improveRekeyed = await all(
    "SELECT c.id, c.cardId, c.rekeyedReason FROM c WHERE NOT IS_DEFINED(c.baseEvictionEvidence) AND ARRAY_LENGTH(c.rekeyedFrom) > 0 AND c.rekeyedFrom[0].cardId = @s",
    [{ name: "@s", value: slug }]
  );
  const byId = new Map();
  for (const r of [...byPartition, ...byField]) if (!byId.has(r.id)) byId.set(r.id, r);
  // A departure only counts as accounted-for if the row is no longer IN the
  // pool: a re-key whose destination still carries this slug never left, and
  // counting it would license a real loss elsewhere.
  const improveAway = improveRekeyed.filter((r) => !byId.has(r.id));
  return {
    ...poolInputs([...byId.values()]),
    evictedAway: Number(evicted[0] ?? 0),
    improveRekeyedAway: improveAway.length,
    improveRekeyedIds: improveAway.map((r) => `${r.id}@${r.cardId}`).sort(),
  };
}

/**
 * Read the apply's write ledger. Returns null when there is no ledger to read
 * -- which makes every canary TOUCHED and the gate strict, because a checker
 * that cannot attribute must not hand out passes it did not earn.
 */
function loadLedger(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const pools = doc.pools && typeof doc.pools === "object" ? doc.pools : {};
    return { doc, pools };
  } catch (e) {
    console.error(`!! write ledger at ${file} is unreadable (${String(e?.message ?? e)}) -- falling back to STRICT, every canary treated as touched.`);
    return null;
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!["before", "after", "check"].includes(MODE)) { console.error(`FATAL: MODE must be before | after | check; got ${JSON.stringify(MODE)}`); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(CANARIES, "utf8"));
  const canaries = doc.canaries ?? [];
  if (!canaries.length) { console.error(`FATAL: ${CANARIES} lists no canaries.`); process.exit(2); }

  // THE SHARD BEING APPLIED MUST HAVE A CANARY (audit gate, 2026-09-03).
  //
  // The gate is per-shard by construction -- before, apply ONE shard, after --
  // so a shard with no canary in it passes by construction: the pools measured
  // are pools that shard's apply cannot touch. 25 of 32 shards were in that
  // state, slot 29 among them, and slot 29 was the 30/30-wrong one.
  //
  // SLOT is read from the same env the runner passes to the fleet script, so
  // the before/after pair and the apply are certainly talking about the same
  // shard. A refusal here is a refusal to certify, which is the correct
  // failure: better no verdict than a green one that measured nothing.
  const SLOT = process.env.SLOT === undefined || process.env.SLOT === "" ? null : Number(process.env.SLOT);
  if (SLOT !== null && Number.isFinite(SLOT)) {
    const inShard = canaries.filter((c) => Number(c.shardSlot) === SLOT);
    if (!inShard.length) {
      console.error(`FATAL: SLOT=${SLOT} has NO canary in ${CANARIES}. A shard with no canary passes this gate by construction --`);
      console.error(`       the pools it measures are pools that shard's apply cannot move. That is not a pass, it is an absence of measurement.`);
      console.error(`       Run backend/scripts/derive-rematch-canaries.cjs to give every shard a canary before applying this one.`);
      process.exit(2);
    }
    console.log(`  slot ${SLOT}: ${inShard.length} canary/canaries live in THIS shard -- ${inShard.map((c) => c.slug).join(", ")}`);
  }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");

  console.log(`rematch-canary-check  MODE=${MODE}  ${canaries.length} canaries  anchor tolerance ${TOL}%  READ ONLY`);
  console.log(`  the anchor is the leading edge (median of the newest 3), never the pool's FMV -- FMV is the projected next sale.`);

  const now = {};
  for (const c of canaries) {
    now[c.slug] = await measure(pool, c.slug);
    const m = now[c.slug];
    console.log(`\n  ${c.name}`);
    console.log(`    ${c.slug}`);
    console.log(`    rows ${f(m.rows)} (partition ${f(m.byPartition)} + field ${f(m.byField)})   expected floor ${f(c.poolRows)}   protected ${f(m.protectedRows)}`);
    console.log(`    anchor ${money(m.anchor)}   newest ${money(m.newestPrice)} @ ${m.newestAt ?? "-"}   direction ${c.verifiedMarketDirection}`);
    if (m.rows < Number(c.poolRows ?? 0)) console.log(`    !! below the captured floor of ${f(c.poolRows)} -- the pool has lost rows since 2026-09-01`);
  }

  if (MODE === "before") {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ capturedAt: new Date().toISOString(), tolerancePct: TOL, inputs: now }, null, 1));
    console.log(`\nbaseline written -> ${BASELINE}`);
    console.log(`Now dispatch rematch-sold-comps MODE=apply-improve for the SHARD, then re-run this with MODE=after.`);
    return;
  }
  if (MODE === "check") { console.log(`\ncheck only -- no baseline compared. Run MODE=before, apply the shard, then MODE=after.`); return; }

  if (!fs.existsSync(BASELINE)) { console.error(`FATAL: MODE=after but no baseline at ${BASELINE}. The gate cannot pass a shard it has no before for.`); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

  // -- THE SHARD'S OWN WRITE LEDGER --------------------------------------
  // Printed before the verdict so a halt NAMES THE ROWS: the reader sees what
  // this shard actually moved before reading what it is being blamed for.
  const ledger = loadLedger(WRITE_LEDGER);
  console.log(`\nTHIS SHARD'S WRITE LEDGER  ${WRITE_LEDGER}`);
  if (!ledger) {
    console.log(`  NONE FOUND -- attribution unavailable, every canary is treated as TOUCHED and the strict rules apply.`);
  } else {
    const d = ledger.doc ?? {};
    const names = Object.keys(ledger.pools);
    console.log(`  slot ${d.slot ?? "?"}/${d.slots ?? "?"}  scope ${JSON.stringify(d.scope ?? "")}  runId ${d.runId ?? "-"}  written ${f(d.written ?? 0)}  pools touched ${f(names.length)}`);
    if (!names.length) {
      console.log(`  this shard wrote in NO pool. Nothing below can be damage it did --`);
      console.log(`  any canary that moved was moved by another writer (ingest, dedup, a concurrent lane).`);
    }
    for (const slug of names.slice(0, 25)) {
      const e = ledger.pools[slug];
      const ids = [...(e.from ?? []), ...(e.to ?? [])].slice(0, 4);
      console.log(`    ${slug}   out ${f(e.fromCount ?? 0)}  in ${f(e.toCount ?? 0)}${ids.length ? `   e.g. ${ids.join(", ")}` : ""}`);
    }
    if (names.length > 25) console.log(`    ... and ${f(names.length - 25)} more pool(s)`);
  }

  const results = [];
  for (const c of canaries) {
    const b = base.inputs?.[c.slug];
    if (!b) { results.push({ name: c.name, slug: c.slug, ok: false, regressions: ["no baseline entry for this canary"], notes: [] }); continue; }
    // null = no ledger (strict); undefined = ledger exists, pool not named.
    const touch = ledger === null ? null : ledger.pools[c.slug];
    results.push(compareCanary(c, b, now[c.slug], base.tolerancePct ?? TOL, touch));
  }

  console.log(`\nCANARY VERDICT  (baseline ${base.capturedAt})`);
  for (const r of results) {
    // No tag on the "no baseline entry" rows (they never reached compareCanary)
    // and none when there was no ledger to attribute with -- an unlabelled
    // verdict is the honest rendering of an unattributed one.
    const tag = !r.attributed ? "" : r.touched ? "  [TOUCHED]" : "  [untouched]";
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${tag}`);
    for (const x of r.regressions) console.log(`        REGRESSION: ${x}`);
    for (const n of r.notes) console.log(`        ${n}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n!! ${failed.length} of ${results.length} canaries REGRESSED. This shard is damage, not an improvement.`);
    for (const r of failed) console.error(`   ${r.touched === false ? "UNTOUCHED-POOL ALARM" : "attributed to this shard"}: ${r.name} -- ${r.regressions.join("; ")}`);
    console.error(`   STOP the fleet. Do not apply the next shard. The diff goes to Drew.`);
    process.exit(5);
  }
  const otherWriters = results.filter((r) => r.notes.some((n) => n.startsWith("pool changed by other writers")));
  console.log(`\nall ${results.length} canaries hold -- the shard may stand, and the next shard may be censused.`);
  if (otherWriters.length) console.log(`  ${otherWriters.length} pool(s) moved under OTHER writers during this apply -- noted above, not this shard's doing.`);
}

module.exports = { median, poolInputs, compareCanary, loadLedger };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
