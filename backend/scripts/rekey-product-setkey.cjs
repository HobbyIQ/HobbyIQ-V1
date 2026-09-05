#!/usr/bin/env node
/**
 * rekey-product-setkey.cjs -- move a whole PRODUCT from one setKey to another,
 * across all three places an identity lives: the catalog row, the pool rows,
 * and the user's holdings.
 *
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, rulings R1 + R2).
 *
 *   R1  pokemon / 1997 / `base4` is the JAPANESE Rocket Gang set, not the
 *       ENGLISH Base Set 2. `base4` is Base Set 2's code and Base Set 2 is a
 *       year-2000 product, so the 1997 rows are squatting on another product's
 *       key. They move to `japanese-rocket-gang`.
 *
 *   R2  the canonical key of a modern Japanese set is its BARE OFFICIAL CODE:
 *       japanese-sv2a -> sv2a, japanese-sv8a -> sv8a, japanese-s12a -> s12a,
 *       and `swsh12a` -- our own invented spelling -- -> `s12a`.
 *
 * WHY A NEW SCRIPT AND NOT rename-setkey.cjs. rename-setkey moves CATALOG rows
 * and lets moveCatalogRow re-point whatever sales hang off each row it moves.
 * That is the wrong shape for both of these rulings, for two measured reasons:
 *
 *   1. NO YEAR AXIS. rename-setkey scopes on (sport, setKey) only. R1 must not
 *      touch pokemon/2000/base4 -- the English Base Set 2 pool, which is a
 *      different product sharing the key. A rename with no year axis would
 *      sweep it up. Here SPORT, SETKEY and (for R1) YEAR are all enforced, and
 *      the year is enforced on the SLUG SEGMENT, not on a `year` field that a
 *      row may spell differently from its own id.
 *
 *   2. THE POOL ROWS HAVE NO CATALOG ROW TO RIDE ON. Measured read-only
 *      2026-09-01: 43,724 pool rows at `hiq:pokemon:1997:base4:` and 25,886 at
 *      `swsh12a`, but the catalog holds ZERO identity rows at either key --
 *      the 303 rows whose setKey FIELD says `1997-pokemon-japanese-rocket-gang`
 *      are all GRADED CHILDREN still stemmed `base4`, with no parents. So
 *      moveCatalogRow would move a handful of rows and leave ~69,000 sales
 *      exactly where they are. The pool is the substance of these rulings and
 *      it is swept directly, by slug prefix.
 *
 * THE THREE LANES (MODE, the polymorphic per-script selector -- #1620):
 *
 *   MODE=catalog   catalog rows whose ID STEM is FROM move to TO, through
 *                  catalogRowOps.moveCatalogRow: copy, re-point that row's
 *                  sales, retire the old slug's graded children, delete the
 *                  old row -- in that order, so no sale is ever dangling.
 *                  Resolution is BY ID STEM, never the setKey field
 *                  (CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT, D30 R2): the field
 *                  drifts, the id is the product. A twin already at the target
 *                  is decided by AUTHORITY (checklist > vendor > derived), so a
 *                  fold can never let a derived stub overwrite a checklist row.
 *
 *   MODE=pool      sold_comps rows under `hiq:SPORT:YEAR:FROM:` get segment 3
 *                  rewritten to TO. Segment surgery, never a recompute (D28):
 *                  the number, parallel, auto flag and print run stay exactly
 *                  as the row spells them, so a parallel today's resolver would
 *                  spell differently cannot ride along on a product move. What
 *                  a full recompute WOULD have said is counted and reported.
 *
 *   MODE=holdings  every holding whose id names the old product is re-pointed.
 *                  Slot 0 only -- the holdings table is small and a fleet would
 *                  just contend. `holdings` is a MAP, so it is walked with
 *                  Object.entries and the count is printed; a lane that
 *                  iterates nothing must say so rather than report success.
 *
 * CONTENTHASH IS RECOMPUTED, AND THAT IS LOAD-BEARING. sold_comps is
 * partitioned on /cardId and contentHash is `sha1(cardId | parallel | isAuto |
 * grade | priceCents | soldDay)` -- the cardId is its FIRST component
 * (soldCompsStore.hashParts). A row that changes cardId therefore changes its
 * correct hash, and a moved row that kept the old one would be invisible to the
 * store's pre-write dedup, which looks up "same contentHash in this partition".
 * Every future re-emit of that sale would then be written again as a new row.
 * So the hash is recomputed at the new address, by the same mirror the other
 * D19 mover uses (lib/relocate-sold-comp.cjs contentHashOf).
 *
 * DEDUP PREFLIGHT IMPLICATION. Because the hash changes with the address, two
 * sales that were distinct under FROM cannot silently collide under TO -- they
 * keep distinct hashes unless they are genuinely the same sale (same price,
 * same day, same grade, same parallel), in which case they SHOULD collide.
 * What the move CAN do is land a row on an address that already holds a row
 * with the same id: relocateSoldComp reports that as `existedBefore` and it is
 * counted as `collapsed onto an existing row`, not as a create. The pool's row
 * count for the scoped prefix is printed BEFORE and AFTER and reconciled --
 * after == before - deleted + created -- so a collapse is visible as a real
 * drop in the count rather than a silent loss (CF-A-SALE-IS-NEVER-LOST).
 *
 * SCOPE IS REQUIRED (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME). SPORT, FROM and
 * TO have no defaults, and MODE=pool additionally requires YEAR. An empty one
 * is FATAL before any Cosmos client is built. A whole-scope write has to be
 * asked for by name.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true nothing is written and the run
 * prints the same banner an apply does, plus the reconciliation line
 * "reconciled: intended N = written X + skipped Y".
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SPORT                     required, e.g. pokemon            (runner: sports)
 *   SETKEY / SET_KEY          required, the FROM key            (runner: setkey_like)
 *   TO_SETKEY / BCP_TITLES    required, the TO key              (runner: titles)
 *   YEAR / YEARS              required for MODE=pool            (runner: years)
 *   MODE                      catalog | pool | holdings         (runner: mode)
 *   BACKFILL_APPLY=true       actually write (the runner exports BACKFILL_APPLY,
 *                             not APPLY). Default: REPORT ONLY.
 *   SLOT / SLOTS              sha1 shards   CONCURRENCY=16
 *   RUN_MINUTES=140           budget marker  LIMIT=0
 * Requires dist/ (catalogRowOps, hobbyIqCardId, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const SPORT = String(process.env.SPORT || "").trim().toLowerCase();
const FROM = String(process.env.SETKEY || process.env.SET_KEY || "").trim().toLowerCase();
// The runner has no spare input (24 of GitHub's 25 are used), so the TO key
// travels in `titles` -> BCP_TITLES. TO_SETKEY wins when set directly.
const TO = String(process.env.TO_SETKEY || process.env.BCP_TITLES || "").trim().toLowerCase();
const YEARS = String(process.env.YEAR || process.env.YEARS || "")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const MODE = String(process.env.MODE || "").trim().toLowerCase();
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "rekey-product-setkey" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const mineByShard = (key) => SLOTS === 1 || shardOf(str(key)) === SLOT;
const MODES = ["catalog", "pool", "holdings"];

/** hiq:sport:year:setKey:number:parallel:auto[:num-N] -> parts, else null.
 *  A graded child carries a tier segment and is not an identity row. */
function identityParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || (parts.length !== 7 && parts.length !== 8)) return null;
  if (parts.length === 8 && !parts[7].startsWith("num-")) return null;
  if (parts[6] !== "auto" && parts[6] !== "no-auto") return null;
  return parts;
}

/** Replace ONLY segment 3 (the setKey). Surgery, not a recompute. */
function withSetKeySegment(oldSlug, setKey) {
  const parts = identityParts(oldSlug);
  if (!parts) return null;
  parts[3] = setKey;
  return parts.join(":");
}

/** The setKey segment of an id -- the product, per CF-THE-ID-CARRIES-THE-PRODUCT. */
const idSetKeySegment = (id) => String(id ?? "").split(":")[3] ?? "";

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 200) {
  let token;
  do {
    const page = await retry(() => container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ---- refusals, BEFORE any require of dist/ or any Cosmos client ----------
  // CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME: a scope with a default is a scope
  // nobody chose.
  if (!MODES.includes(MODE)) {
    console.error(`FATAL: MODE is required and has no default -- one of ${MODES.join(" | ")}.`);
    process.exit(1);
  }
  if (!SPORT) { console.error("FATAL: SPORT is required and has no default (e.g. SPORT=pokemon)."); process.exit(1); }
  if (!FROM) { console.error("FATAL: SETKEY (the FROM key) is required and has no default."); process.exit(1); }
  if (!TO) { console.error("FATAL: TO_SETKEY (the TO key; the runner carries it in `titles`) is required and has no default."); process.exit(1); }
  if (FROM === TO) { console.error(`FATAL: FROM === TO (${FROM}) -- that is not a move.`); process.exit(1); }
  // R1's whole point: the 1997 rows move and the 2000 rows do not. A pool sweep
  // without a year would take both, so the year is REQUIRED for the pool lane.
  if (MODE === "pool" && !YEARS.length) {
    console.error("FATAL: MODE=pool requires YEAR -- a pool sweep with no year axis cannot promise it left another year's product alone.");
    console.error("       (R1: pokemon/1997/base4 moves; pokemon/2000/base4 is the ENGLISH Base Set 2 and must not be touched.)");
    process.exit(1);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const { moveCatalogRow, retireCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  const REASON = `ruled setKey re-key ${FROM} -> ${TO} (CF-THE-JAPANESE-CODE-IS-THE-KEY, Drew 2026-09-01)`;
  console.log(`rekey-product-setkey  MODE=${MODE}  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing written"}`);
  console.log(`  ruling   ${FROM} -> ${TO}`);
  console.log(`  scope    sport=${SPORT}${YEARS.length ? `  years=${YEARS.join(",")}` : "  years=(all)"}`);
  console.log(`  slot ${SLOT}/${SLOTS}  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  if (MODE === "pool" && YEARS.length) {
    console.log(`  the year is enforced on the SLUG SEGMENT: only hiq:${SPORT}:{${YEARS.join(",")}}:${FROM}: is read.`);
  }
  console.log("");

  if (MODE === "catalog") return rekeyCatalog();
  if (MODE === "pool") return rekeyPool();
  return rekeyHoldings();

  // ── MODE=catalog ──────────────────────────────────────────────────────────
  /**
   * Rows are selected by the setKey FIELD (that is what Cosmos can index) but
   * ADOPTED by the ID STEM: a row whose id does not stem FROM is left alone and
   * counted. CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT -- the field drifts, the id is
   * the product. Rows whose FIELD is stale but whose STEM is already FROM are
   * picked up by the second query.
   */
  async function rekeyCatalog() {
    const s = {
      scanned: 0, otherSlot: 0, moved: 0, folded: 0, replaced: 0, noop: 0,
      stemMismatch: 0, yearMismatch: 0, malformed: 0, salesRepointed: 0,
      // Two DISJOINT counters, deliberately. `gradedRetiredDirect` is a row
      // this scan itself adopted and retired -- it was scanned, so it is
      // intended. `gradedRetiredCascade` is a child swept up by a parent's
      // move; it was never scanned as a candidate, so counting it as `written`
      // would claim more writes than were intended and reportWrites would flag
      // the arithmetic (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW).
      gradedRetiredDirect: 0, gradedRetiredCascade: 0, failed: 0, notReached: 0,
    };
    const examples = [];
    let stopReason = null;

    // Both spellings of "this row belongs to FROM": the field says so, or the
    // id stem says so. A row can have either without the other (D30 drift).
    const specs = [
      { name: "setKey field", query: "SELECT * FROM c WHERE c.sport = @sp AND c.setKey = @k", parameters: [{ name: "@sp", value: SPORT }, { name: "@k", value: FROM }] },
      { name: "id stem", query: "SELECT * FROM c WHERE STARTSWITH(c.id, @p)", parameters: [{ name: "@p", value: `hiq:${SPORT}:` }] },
    ];
    const seen = new Set();

    for (const spec of specs) {
      if (stopReason) break;
      console.log(`-- scanning by ${spec.name}`);
      await forEachPage(cat, spec, async (rows) => {
        // The id-stem pass reads the whole sport; keep only real FROM stems.
        const candidates = rows.filter((d) => idSetKeySegment(d.id) === FROM || str(d.setKey).toLowerCase() === FROM);
        for (let i = 0; i < candidates.length; i += CONCURRENCY) {
          await Promise.all(candidates.slice(i, i + CONCURRENCY).map(async (d) => {
            const id = String(d.id);
            if (seen.has(id)) return;
            seen.add(id);
            if (!mineByShard(id)) { s.otherSlot++; return; }
            s.scanned++;
            try {
              const parts = String(id).split(":");
              if (parts.length < 7) { s.malformed++; return; }
              // THE ID DECIDES. A row selected by a drifted field whose id
              // stems elsewhere is NOT this product and never moves.
              if (parts[3] !== FROM) {
                s.stemMismatch++;
                if (examples.length < 8) examples.push(`  LEFT (id stems "${parts[3]}", field says "${str(d.setKey)}")  ${id.slice(0, 88)}`);
                return;
              }
              // The year axis, when given, is enforced on the SLUG too.
              if (YEARS.length && !YEARS.includes(Number(parts[2]))) { s.yearMismatch++; return; }

              // A GRADED CHILD IS RETIRED, NOT MOVED. Its id is the parent's
              // plus a tier segment, so it is not a hiq identity slug and
              // moveCatalogRow refuses it outright ("newSlug is not a hiq
              // slug"). Graded rows are REGENERABLE from the parent by
              // materialize-graded-identities, which is exactly why
              // moveCatalogRow retires a moved row's children rather than
              // carrying them across. Measured on R1: all 303 catalog rows at
              // pokemon/1997/base4 are graded children of parents that do not
              // exist -- an orphaned ladder left by ingest-auto-seed-graded --
              // so the whole R1 catalog lane is a retire, and the pool lane is
              // what carries the ruling.
              if (!identityParts(id)) {
                if (str(d.gradeTier)) {
                  const rr = await retireCatalogRow(cat, id, d.cardId, `${REASON} (graded child of a moved/absent parent; regenerable)`, { dryRun: !APPLY, retry });
                  if (rr.action === "retire") { s.gradedRetiredDirect += 1; s.gradedRetiredCascade += rr.gradedChildrenRetired; }
                  else s.noop++;
                  if (examples.length < 8) examples.push(`  RETIRE   ${id.slice(0, 82)}  <- graded child, regenerable from its parent`);
                } else {
                  s.malformed++;
                  if (examples.length < 8) examples.push(`  LEFT (not an identity slug, no gradeTier)  ${id.slice(0, 76)}`);
                }
                return;
              }

              parts[3] = TO;
              const newSlug = parts.join(":");
              const r = await moveCatalogRow(cat, d, newSlug, { setKey: TO }, {
                reason: REASON, repointNormalizedSetKey: true, dryRun: !APPLY,
                salesContainer: pool, retry,
              });
              s.salesRepointed += r.salesRepointed;
              s.gradedRetiredCascade += r.gradedChildrenRetired;
              if (r.action === "move") s.moved++;
              else if (r.action === "fold") s.folded++;
              else if (r.action === "replace") s.replaced++;
              else s.noop++;
              if (examples.length < 8) examples.push(`  ${r.action.toUpperCase().padEnd(8)} ${id.slice(0, 66)}\n        -> ${newSlug.slice(0, 66)}\n           ${r.decision}`);
            } catch (e) {
              s.failed++;
              if (s.failed <= 5) console.log(`  FAILED ${id.slice(0, 70)}: ${String(e?.message ?? e).slice(0, 110)}`);
            }
          }));
          if (LIMIT && (s.moved + s.folded + s.replaced + s.gradedRetiredDirect) >= LIMIT) { stopReason = "limit"; break; }
          if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
        }
        return !stopReason;
      });
    }

    for (const l of examples) console.log(l);
    banner(stopReason);
    console.log(`  rows scanned (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  MOVED to ${TO.padEnd(26)} ${f(s.moved)}`);
    console.log(`  FOLDED (twin already there)${f(s.folded).padStart(8)}   <- the incumbent won on authority`);
    console.log(`  REPLACED a lower twin      ${f(s.replaced)}`);
    console.log(`  sales re-pointed           ${f(s.salesRepointed)}`);
    console.log(`  graded rows retired        ${f(s.gradedRetiredDirect)}   <- adopted by this scan; regenerable, never moved`);
    console.log(`  graded children cascaded   ${f(s.gradedRetiredCascade)}   <- swept up by a parent's move, not scanned as candidates`);
    console.log(`  LEFT: id stems elsewhere   ${f(s.stemMismatch)}   <- the field drifted; the id is the product`);
    console.log(`  LEFT: year out of scope    ${f(s.yearMismatch)}`);
    console.log(`  malformed id (left)        ${f(s.malformed)}`);
    console.log(`  failed                     ${f(s.failed)}`);
    // A retired graded row is a WRITE: the ruling removed it deliberately.
    const written = s.moved + s.folded + s.replaced + s.gradedRetiredDirect;
    const skipped = s.stemMismatch + s.yearMismatch + s.malformed + s.noop + s.notReached;
    reconcile("rekey-product-setkey:catalog", s.scanned, written, skipped, s.failed);
  }

  // ── MODE=pool ─────────────────────────────────────────────────────────────
  async function rekeyPool() {
    const s = {
      scanned: 0, otherSlot: 0, moved: 0, created: 0, deleted: 0,
      collapsedOntoExisting: 0, notIdentityRow: 0, slugDrift: 0,
      duplicatesLeft: 0, failed: 0, notReached: 0,
    };
    const examples = [];
    let stopReason = null;

    const prefixes = YEARS.map((y) => `hiq:${SPORT}:${y}:${FROM}:`);

    // THE IDENTITY IS hobbyiqCardId, NOT THE PARTITION KEY. Measured read-only
    // 2026-09-01 on hiq:pokemon:1997:base4: -- 43,724 rows carry that
    // hobbyiqCardId but only 738 are PARTITIONED under it; the other 42,986
    // (98.3%) still sit under a legacy vendor cardId like
    // "1710986731929x138777545757230450". A STARTSWITH on c.cardId -- the shape
    // fold-umbrella-to-series uses, where every row was already hiq-keyed --
    // would therefore have found 1.7% of this ruling's rows and reported a
    // clean run over the remainder. The scan is on hobbyiqCardId; the row's own
    // cardId is carried into the relocate as the partition key it must be
    // deleted from.
    const before = {};
    for (const p of prefixes) {
      before[p] = (await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }).fetchAll())).resources[0] ?? 0;
      const pked = (await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p) AND STARTSWITH(c.cardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }).fetchAll())).resources[0] ?? 0;
      console.log(`  BEFORE ${p}  ${f(before[p])} rows  (${f(pked)} partitioned under the slug, ${f(before[p] - pked)} under a legacy vendor cardId)`);
    }
    // The guard rail, stated as a number: the year we are NOT touching.
    const guardPrefix = `hiq:${SPORT}:`;
    console.log("");

    async function handle(row) {
      // The IDENTITY is hobbyiqCardId. `cardId` is the partition key and for
      // 98.3% of this population it is still a legacy vendor id.
      const oldSlug = str(row.hobbyiqCardId);
      const parts = identityParts(oldSlug);
      if (!parts) { s.notIdentityRow++; return; }
      if (parts[3] !== FROM) { s.notIdentityRow++; return; }
      if (YEARS.length && !YEARS.includes(Number(parts[2]))) { s.notIdentityRow++; return; }

      const target = withSetKeySegment(oldSlug, TO);
      if (!target || target === oldSlug) { s.notIdentityRow++; return; }

      // Reported, never applied: what a FULL recompute would have said. The
      // move itself replaces only segment 3 (D28's rule).
      try {
        const round = computeHobbyIqCardId({
          sport: SPORT, year: Number(parts[2]), setKey: TO,
          cardNumber: str(row.cardNumber), parallel: row.parallel ?? null,
          isAuto: row.isAuto === true, printRun: row.printRun ?? null,
          playerName: row.playerName ?? null, authoritativeSetKey: true,
        });
        if (round && round !== target) s.slugDrift++;
      } catch { /* a recompute that throws is not a reason to refuse a surgery */ }

      const keep = stripSystem(row);
      // The re-key also RE-HOMES the row onto its own slug partition when it
      // was still under a legacy vendor cardId. That vendor id is kept under
      // `vendorCardIdWas` because a CH/eBay lookup still resolves by it
      // (CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW).
      const oldPk = str(row.cardId);
      if (oldPk && oldPk !== oldSlug && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
      keep.cardId = target;
      keep.hobbyiqCardId = target;
      keep.setKey = TO;
      keep.normalizedSetKey = TO;
      keep.rekeyedSetKeyWas = parts[3];
      keep.rekeyedAt = new Date().toISOString();
      keep.rekeyedReason = REASON;
      // THE HASH FOLLOWS THE ADDRESS. cardId is contentHash's first component,
      // so a moved row that kept the old hash would be invisible to the store's
      // partition-scoped pre-write dedup and every re-emit would duplicate it.
      keep.contentHash = contentHashOf(keep);

      if (examples.length < 10) {
        examples.push(`  REKEY ${oldSlug.slice(0, 70)}\n     -> ${target.slice(0, 70)}\n        ${str(row.title).slice(0, 96)}`);
      }

      const res = await relocateSoldComp(pool, {
        keep,
        drop: [{ id: row.id, cardId: row.cardId }],
        retry,
        verifyFields: ["hobbyiqCardId", "setKey", "contentHash", "rekeyedAt"],
        dryRun: !APPLY,
      });
      if (!res.ok && res.stage !== "done") {
        s.failed++;
        console.log(`  FAILED at ${res.stage}: ${row.id} @ ${row.cardId} -> ${target}: ${String(res.error).slice(0, 120)}`);
        return;
      }
      if (res.duplicatesLeft.length) {
        s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
        for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 90)}`);
        return;
      }
      if (!APPLY) { s.created += 1; s.deleted += 1; }
      else {
        s.created += res.existedBefore ? 0 : 1;
        s.deleted += res.deleted.length;
        if (res.existedBefore) s.collapsedOntoExisting++;
      }
      s.moved++;
    }

    for (const p of prefixes) {
      if (stopReason) break;
      console.log(`-- scanning ${p}`);
      await forEachPage(pool, {
        // SELECT * and not a projection: the row read here is the document
        // UPSERT-ed at the new address, so a projection would silently drop
        // every field it left out. A re-key must carry the whole row.
        query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }, async (rows) => {
        // Shard on the row's own id: the partition key is a legacy vendor id
        // for most of this population and thousands of rows share one, so
        // sharding on it would pile them all into a single slot.
        const mine = rows.filter((r) => { if (mineByShard(r.id)) return true; s.otherSlot++; return false; });
        for (let i = 0; i < mine.length; i += CONCURRENCY) {
          const batch = mine.slice(i, i + CONCURRENCY);
          s.scanned += batch.length;
          await Promise.all(batch.map(handle));
          if (LIMIT && s.moved >= LIMIT) { stopReason = "limit"; s.notReached += mine.length - (i + batch.length); break; }
          if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; s.notReached += mine.length - (i + batch.length); break; }
        }
        return !stopReason;
      }, 400);
    }

    for (const l of examples) console.log(l);
    banner(stopReason);
    console.log(`  rows scanned (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  REKEYED ${FROM} -> ${TO}    ${f(s.moved)}`);
    console.log(`  new rows created           ${f(s.created)}`);
    console.log(`  old rows deleted           ${f(s.deleted)}`);
    console.log(`  collapsed onto an existing ${f(s.collapsedOntoExisting)}   <- the target address already held this sale`);
    console.log(`  not an identity row / out of scope ${f(s.notIdentityRow)}`);
    console.log(`  slug recompute would differ ${f(s.slugDrift)}   <- reported, never applied (D28)`);
    console.log(`  duplicates LEFT in the pool ${f(s.duplicatesLeft)}   <- a delete that failed; never a lost sale`);
    console.log(`  failed                     ${f(s.failed)}`);

    // AFTER counts + the arithmetic. A report-only run predicts; an apply proves.
    console.log("");
    for (const p of prefixes) {
      const after = (await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }).fetchAll())).resources[0] ?? 0;
      const expect = APPLY ? before[p] - s.deleted : before[p];
      console.log(`  AFTER  ${p}  ${f(after)} rows (before ${f(before[p])}${APPLY ? `, expected ${f(expect)}` : ", report-only: unchanged expected"})`);
      if (after !== expect) console.log(`    NOTE count differs from the expectation by ${f(after - expect)} -- other slots or a concurrent writer.`);
    }
    // THE GUARD RAIL, PROVEN RATHER THAN ASSERTED. R1's whole risk is the
    // OTHER year sharing this key: pokemon/2000/base4 is the ENGLISH Base Set
    // 2 and must come out of this run with exactly the count it went in with.
    // Printed per out-of-scope year, by name.
    const { resources: byYear } = await retry(() => pool.items.query({
      query: "SELECT c.y AS y, COUNT(1) AS n FROM (SELECT VALUE { y: SUBSTRING(c.hobbyiqCardId, @off, 4) } FROM c WHERE STARTSWITH(c.hobbyiqCardId, @g) AND CONTAINS(c.hobbyiqCardId, @seg)) AS c GROUP BY c.y",
      parameters: [
        { name: "@off", value: guardPrefix.length },
        { name: "@g", value: guardPrefix },
        { name: "@seg", value: `:${FROM}:` },
      ],
    }).fetchAll());
    const inScope = new Set(YEARS.map(String));
    console.log(`  GUARD  rows still at :${FROM}: in ${SPORT}, by year:`);
    for (const r of (byYear ?? []).sort((a, b) => String(a.y).localeCompare(String(b.y)))) {
      const tag = inScope.has(String(r.y)) ? "in scope — moves" : "OUT OF SCOPE — must not change";
      console.log(`           ${r.y}  ${String(f(r.n)).padStart(9)}   <- ${tag}`);
    }

    reconcile("rekey-product-setkey:pool", s.scanned, s.moved, s.notIdentityRow + s.notReached, s.failed);
  }

  // ── MODE=holdings ─────────────────────────────────────────────────────────
  async function rekeyHoldings() {
    if (SLOT !== 0) { console.log("MODE=holdings runs on slot 0 only; nothing to do on this slot"); return; }
    const s = { users: 0, holdings: 0, noId: 0, notThisProduct: 0, repointed: 0, failed: 0 };
    const lines = [];
    await forEachPage(portfolio, { query: "SELECT c.id, c.userId, c.holdings FROM c", parameters: [] }, async (docs) => {
      for (const doc of docs) {
        s.users++;
        // `holdings` is a MAP, not an array -- walk it with Object.entries.
        for (const [hid, h] of Object.entries(doc.holdings ?? {})) {
          s.holdings++;
          const id = str(h?.hobbyiqCardId || h?.cardId);
          if (!id.startsWith("hiq:")) { s.noId++; continue; }
          const parts = String(id).split(":");
          const stem = parts[3] ?? "";
          const yearOk = !YEARS.length || YEARS.includes(Number(parts[1] === SPORT ? parts[2] : NaN));
          if (parts[1] !== SPORT || stem !== FROM || !yearOk) { s.notThisProduct++; continue; }
          parts[3] = TO;
          const newId = parts.join(":");
          lines.push(`  ${APPLY ? "re-pointed" : "would re-point"} ${hid.slice(0, 8)} ${str(h.playerName)} #${str(h.cardNumber)}: ${id} -> ${newId}`);
          try {
            if (APPLY) {
              await retry(() => portfolio.item(doc.id, doc.userId).patch([
                { op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId },
                { op: "set", path: `/holdings/${hid}/cardId`, value: newId },
                { op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "rekey-product-setkey" },
                { op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() },
                { op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: id },
              ]));
            }
            s.repointed++;
          } catch (e) {
            s.failed++;
            lines.push(`  failed ${hid.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 140)}`);
          }
        }
      }
      return true;
    });
    for (const l of lines) console.log(l);
    banner(null);
    // CF-HOLDINGS-IS-A-MAP: print the count, and say so when it is zero rather
    // than reporting a clean run over nothing.
    console.log(`  users / holdings walked    ${f(s.users)} / ${f(s.holdings)}`);
    if (s.holdings === 0) console.log("  NOTE walked 0 holdings -- nothing was iterated. That is a finding, not a success.");
    console.log(`  RE-POINTED                 ${f(s.repointed)}`);
    console.log(`  not this product           ${f(s.notThisProduct)}`);
    console.log(`  no hiq id                  ${f(s.noId)}`);
    console.log(`  failed                     ${f(s.failed)}`);
    reconcile("rekey-product-setkey:holdings", s.repointed, s.repointed, s.notThisProduct + s.noId, s.failed);
  }

  // ── shared reporting ──────────────────────────────────────────────────────
  function banner(stopReason) {
    if (stopReason === "budget") {
      // The marker the runner's relaunch step greps for. Must be spelled
      // exactly this way (CF-RELAUNCH-ONLY-ON-BUDGET).
      console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
    } else if (stopReason === "limit") {
      console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
    }
    console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  }

  /** The reconciliation line, in both modes. reportWrites sets a non-zero exit
   *  code when the arithmetic does not close (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW),
   *  so it is only armed on an apply; a report still PRINTS the same line. */
  function reconcile(job, intended, written, skipped, failed) {
    console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)}${failed ? ` + failed ${f(failed)}` : ""}`);
    if (APPLY) reportWrites({ job, intended, written, skipped, failed });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
