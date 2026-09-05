#!/usr/bin/env node
/**
 * repair-card-number-from-title.cjs -- a sale never stays under a card it is not.
 *
 * CF-A-CARD-NUMBER-IS-NOT-A-GRADE (D28, Drew 2026-08-30). Harrison's holding
 * priced from two sales keyed to "#9" -- a Paul DeJong 1983 35th Anniversary
 * Refractor #83T-22 and an Ohtani 1983 Topps Refractor #83T-6 -- because both
 * took "9" from the words "PSA 9". `cardNumberIntegrity.judgeCardNumber` now
 * stops the next one at every emitter. This is the pass for the ones already
 * written.
 *
 * Per row, one ruling and one of three outcomes:
 *
 *   MOVED   the guard re-derives a number (the title's explicit `#X`, or the
 *           stored one confirmed) and a card_catalog row exists at the
 *           resulting identity -- checklist-authority preferred, else the
 *           numbered twin the fold rule allows (foldTwinRule, the same
 *           decision fold-unnumbered-twins makes). The row moves through
 *           scripts/lib/relocate-sold-comp.cjs: upsert the new address, read
 *           it back, then delete the old. Never the other order.
 *   PARKED  the guard refuses the stored number and the title states none, or
 *           it states one no catalog row carries. The number segment is
 *           cleared -- the slug becomes the player-precision address
 *           (`player-<slug>`, CF-PLAYER-IS-THE-NUMBER) -- and the row is
 *           stamped `cardNumberUnreadable: true`. It is out of the wrong card's
 *           pool, which is the point; the rematch owns it from there.
 *   left    the guard agrees with what is stored. Counted, untouched.
 *
 * The new slug is SURGERY on the old one -- segment 4 replaced with the number
 * segment computeHobbyIqCardId would normalise it to -- rather than a full
 * recompute, so a setKey the resolver would spell differently today cannot
 * ride along on a card-number repair. Where the two disagree it is counted
 * (`slug recompute would differ`) and reported, never applied.
 *
 * MODES (`mode` on the runner; there is NO default -- a whole-scope write
 * must be asked for by name):
 *   grade     cardNumber IN ('8','9','10')          the Harrison slice
 *   slash     cardNumber contains '/'               a print run as the number
 *   ordinal   cardNumber IN ('1','2')               "1st Bowman" / "LOT OF 2"
 *   year      a 4-character cardNumber              the set year as the number
 *   nonumber  no cardNumber, a '#' in the title     the parser never read it
 *   all       every mode above, in that order       REFUSED unless SCOPE=all
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (the runner
 *      exports BACKFILL_APPLY, not APPLY); MODE (required); SCOPE (=all to
 *      confirm MODE=all); SOURCES (comma list; empty = every source);
 *      SLOT/SLOTS (hash of the partition key /cardId); CONCURRENCY=8;
 *      RUN_MINUTES=140 (prints the budget marker the runner relaunches on);
 *      LIMIT (rows written; a LIMIT stop is NOT a budget stop).
 * Requires dist/ (cardNumberIntegrity, hobbyIqCardId, foldTwinRule,
 * catalogAuthority, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { judgeCardNumber, isTcgVertical } = require(path.join(backend, "dist/services/portfolioiq/cardNumberIntegrity.js"));
const { computeHobbyIqCardId, parseHobbyIqCardId, isUnnumberedCardNumber, unnumberedCardSegment } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { decideTwinFold } = require(path.join(backend, "dist/services/catalog/foldTwinRule.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
const SOURCES = String(process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
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
const SHARD_SCOPE = runnerShardScope({ label: "repair-card-number-from-title" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
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
const REASON = "card number re-derived from the title (D28, CF-A-CARD-NUMBER-IS-NOT-A-GRADE)";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const str = (v) => String(v ?? "").trim();

const MODE_SQL = {
  grade: "c.cardNumber IN ('8','9','10')",
  slash: "CONTAINS(c.cardNumber, '/')",
  ordinal: "c.cardNumber IN ('1','2')",
  year: "LENGTH(c.cardNumber) = 4",
  nonumber: "(NOT IS_DEFINED(c.cardNumber) OR IS_NULL(c.cardNumber) OR c.cardNumber = '') AND CONTAINS(c.title, '#')",
};
const ALL_MODES = ["grade", "slash", "ordinal", "year", "nonumber"];

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

// ── pure: the new address ───────────────────────────────────────────────────

/** The cardNumber SEGMENT computeHobbyIqCardId would write for this number in
 *  this card's namespace. Asked of the real function rather than reimplemented,
 *  so the pool's normalisation cannot drift from the slug builder's. */
function numberSegmentFor(parts, cardNumber, playerName) {
  if (isUnnumberedCardNumber(cardNumber)) return unnumberedCardSegment(playerName);
  const probe = computeHobbyIqCardId({ ...parts, cardNumber, playerName });
  const seg = String(probe).split(":")[4];
  return seg || null;
}

/** Replace segment 4 of an hiq id. Surgery, not a recompute: everything else
 *  about the card -- sport, year, setKey, parallel, auto, print run -- is left
 *  exactly as the row already spells it. */
function withNumberSegment(oldSlug, segment) {
  const seg = String(oldSlug).split(":");
  if (seg.length < 7 || seg[0] !== "hiq") return null;
  seg[4] = segment;
  return seg.join(":");
}

// ── catalog: does the derived identity exist? ──────────────────────────────

const targetCache = new Map();

async function catalogRowAt(cat, slug) {
  try { const { resource } = await retry(() => cat.item(slug, slug).read()); return resource ?? null; }
  catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
}

/**
 * The catalog identity this slug resolves to, or null.
 *   { slug, authority }  authority: "checklist" | "vendor" | "derived" | "unknown" | "twin"
 * A row at the slug itself wins. Failing that, the numbered twins of the same
 * card (`…:num-N`) are put to foldTwinRule -- the same decision
 * fold-unnumbered-twins makes -- and its target is the identity when exactly
 * one print run is on offer.
 */
async function resolveTarget(cat, slug) {
  if (targetCache.has(slug)) return targetCache.get(slug);
  let out = null;
  const direct = await catalogRowAt(cat, slug);
  if (direct) {
    out = { slug, authority: catalogAuthorityOf(direct.source), source: str(direct.source) || "(none)" };
  } else {
    const { resources } = await retry(() => cat.items.query({
      query: "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p)",
      parameters: [{ name: "@p", value: `${slug}:num-` }],
    }, { maxItemCount: 100 }).fetchAll());
    const numbered = (resources ?? [])
      .map((r) => ({ id: String(r.id), printRun: Number(String(r.id).split(":num-")[1]), source: str(r.source) }))
      .filter((r) => Number.isFinite(r.printRun) && r.printRun > 0);
    if (numbered.length) {
      const d = decideTwinFold({ baseId: slug, twinSource: "pool", twinIsChecklist: false, numbered, mode: "vendor" });
      if (d.fold) out = { slug: d.target.id, authority: "twin", source: str(d.target.source) || "(none)" };
    }
  }
  targetCache.set(slug, out);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // A whole-scope write must be asked for by name. MODE has NO default: an
  // empty MODE once meant "the script's favourite population" and reported
  // 13.14M rows nobody had asked about (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME).
  if (!MODE) {
    console.error(`FATAL: MODE is required and has no default. One of: ${ALL_MODES.join(" | ")} | all`);
    process.exit(1);
  }
  if (MODE === "all" && SCOPE !== "all") {
    console.error("FATAL: MODE=all is every mis-keyed shape in the pool. Confirm it with SCOPE=all.");
    process.exit(1);
  }
  const modes = MODE === "all" ? ALL_MODES : [MODE];
  for (const m of modes) {
    if (!MODE_SQL[m]) { console.error(`FATAL: unknown MODE "${m}". One of: ${ALL_MODES.join(" | ")} | all`); process.exit(1); }
  }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`repair-card-number-from-title  MODE=${MODE}  slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY (moves + parks sold_comps rows)" : "REPORT ONLY -- nothing written"}  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m  sources=${SOURCES.join(",") || "all"}${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`the ruling: an explicit #X in the title wins; a number the title shows to be a grade / print run / year / ordinal / lot is refused.\n`);

  const s = {
    scanned: 0, otherSlot: 0, unchanged: 0,
    movedChecklist: 0, movedTwin: 0, movedOther: 0, parked: 0, parkedUnplaced: 0,
    noSlug: 0, noPlayer: 0, slugDrift: 0, collapsedOntoExisting: 0,
    failed: 0, duplicatesLeft: 0, notReached: 0,
  };
  const rejectHist = new Map(), sourceHist = new Map(), examples = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  let stopReason = null;

  /** One row. Returns nothing; every path lands on exactly one counter. */
  async function handle(row) {
    const oldSlug = str(row.hobbyiqCardId) || str(row.cardId);
    const title = str(row.title);
    const tcg = isTcgVertical(row.sport);
    const stored = str(row.cardNumber);
    const verdict = judgeCardNumber(stored || null, title, { isTcg: tcg });
    const derived = verdict.cardNumber;

    // The guard agrees with what is stored: nothing to repair.
    if ((derived ?? "") === stored.toUpperCase() || (!derived && !stored)) { s.unchanged++; return; }
    if (verdict.rejected) bump(rejectHist, verdict.rejected);
    else if (verdict.vendorDisagrees) bump(rejectHist, "vendor-disagrees");
    else bump(rejectHist, "number-read-from-title");
    bump(sourceHist, str(row.source) || "(none)");

    const parts = parseHobbyIqCardId(oldSlug);
    if (!parts) { s.noSlug++; return; }

    // Where would it go? The derived number first; the parked address when the
    // derived number has no catalog row or there is no number at all.
    let target = null, kind = null;
    if (derived) {
      const seg = numberSegmentFor(parts, derived, row.playerName);
      const candidate = seg ? withNumberSegment(oldSlug, seg) : null;
      if (candidate && candidate !== oldSlug) {
        const roundTrip = computeHobbyIqCardId({ ...parts, cardNumber: derived, playerName: row.playerName });
        if (roundTrip !== candidate) s.slugDrift++;   // reported, never applied
        const t = await resolveTarget(cat, candidate);
        if (t) { target = t.slug; kind = t.authority === "checklist" ? "checklist" : t.authority === "twin" ? "twin" : "other"; }
      }
    }
    if (!target) {
      // PARK. The number segment is cleared, which in this slug scheme means
      // the player identifies the card (CF-PLAYER-IS-THE-NUMBER). With no
      // player there is no address to park at and the row is left where it is,
      // counted -- it is not moved to a card it is not, and it is not silently
      // dropped either.
      const seg = unnumberedCardSegment(row.playerName);
      if (!seg) { s.noPlayer++; return; }
      const parkSlug = withNumberSegment(oldSlug, seg);
      if (!parkSlug || parkSlug === oldSlug) { s.unchanged++; return; }
      target = parkSlug;
      // Two reasons to park, and they are different facts. "The title states
      // no number I can trust" is a parse problem. "The title states #SMLB10
      // and the catalog holds no such card" is an ACQUISITION problem -- the
      // number is good, the checklist is missing -- so the number travels with
      // the row on `cardNumberFromTitle` rather than being thrown away.
      kind = derived ? "park-unplaced" : "park";
    }

    const keep = stripSystem(row);
    keep.cardId = target;
    keep.hobbyiqCardId = target;
    keep.cardNumberWas = stored || null;
    keep.cardNumberRepairedAt = new Date().toISOString();
    keep.cardNumberRepairedReason = REASON;
    if (kind === "park" || kind === "park-unplaced") {
      keep.cardNumber = null;
      keep.cardNumberUnreadable = true;
      if (kind === "park-unplaced") keep.cardNumberFromTitle = derived;
    } else {
      keep.cardNumber = derived;
      if (keep.cardNumberUnreadable) delete keep.cardNumberUnreadable;
    }
    keep.contentHash = contentHashOf(keep);

    if (examples.length < 12) {
      examples.push(`  ${kind.toUpperCase().padEnd(9)} "${stored || "(none)"}" -> "${derived ?? "(cleared)"}"  ${oldSlug}  ->  ${target}\n              ${title.slice(0, 110)}`);
    }

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: row.id, cardId: row.cardId }],
      retry,
      verifyFields: ["cardNumberRepairedAt", "hobbyiqCardId"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") { s.failed++; console.log(`  FAILED at ${res.stage}: ${row.id} @ ${row.cardId} -> ${target}: ${String(res.error).slice(0, 120)}`); return; }
    if (res.duplicatesLeft.length) { s.failed++; s.duplicatesLeft += res.duplicatesLeft.length; for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 90)}`); return; }
    if (APPLY && res.existedBefore) s.collapsedOntoExisting++;
    if (kind === "park") s.parked++;
    else if (kind === "park-unplaced") s.parkedUnplaced++;
    else if (kind === "checklist") s.movedChecklist++;
    else if (kind === "twin") s.movedTwin++;
    else s.movedOther++;
  }

  const written = () => s.movedChecklist + s.movedTwin + s.movedOther + s.parked + s.parkedUnplaced;

  for (const m of modes) {
    if (stopReason) break;
    const srcSql = SOURCES.length ? ` AND c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})` : "";
    // SELECT * and not a projection. The row read here becomes the document
    // UPSERT-ed at the new address, so any field the projection left out would
    // be silently dropped from the sale -- url, sellerHandle, verifiedByUser,
    // normalizedSetKey, every earlier repair's stamp. A re-key must carry the
    // whole row or it is a partial rewrite wearing a move's clothes.
    const query = {
      query: `SELECT * FROM c WHERE ${MODE_SQL[m]} AND IS_DEFINED(c.title)${srcSql}`,
      parameters: SOURCES.map((v, i) => ({ name: `@s${i}`, value: v })),
    };
    console.log(`\n-- MODE=${m}: ${MODE_SQL[m]}`);
    let token, seenThisMode = 0;
    do {
      const page = await retry(() => pool.items.query(query, { maxItemCount: 500, continuationToken: token, maxDegreeOfParallelism: 4 }).fetchNext());
      token = page.continuationToken;
      const mine = (page.resources ?? []).filter((r) => { if (shardOf(str(r.cardId)) === SLOT) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (row) => {
          s.scanned++; seenThisMode++;
          try { await handle(row); }
          catch (e) { s.failed++; if (s.failed <= 8) console.log(`  FAILED ${row.id}: ${String(e?.message ?? e).slice(0, 120)}`); }
        }));
        if (LIMIT && written() >= LIMIT) { stopReason = "limit"; s.notReached += mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; s.notReached += mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
      }
      if (!stopReason && seenThisMode && seenThisMode % 5000 < CONCURRENCY) process.stderr.write(`\r  ${m}: scanned=${f(s.scanned)} moved=${f(s.movedChecklist + s.movedTwin + s.movedOther)} parked=${f(s.parked + s.parkedUnplaced)}   `);
    } while (token && !stopReason);
    process.stderr.write("\n");
    console.log(`   scanned in this mode: ${f(seenThisMode)}`);
  }

  if (examples.length) { console.log(`\nexamples:`); for (const e of examples) console.log(e); }

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} belonging to other slots)`);
  console.log(`  REPAIRED                   ${f(written())}   <- the sub-totals below, which sum to it`);
  console.log(`    moved onto a checklist row  ${f(s.movedChecklist)}`);
  console.log(`    moved onto a numbered twin  ${f(s.movedTwin)}   <- foldTwinRule`);
  console.log(`    moved onto a vendor/derived row ${f(s.movedOther)}`);
  console.log(`    PARKED (no number readable) ${f(s.parked)}   <- cardNumberUnreadable, out of the wrong pool`);
  console.log(`    PARKED (number, no catalog row) ${f(s.parkedUnplaced)}   <- the number rides on cardNumberFromTitle: an ACQUISITION list, not a parse failure`);
  console.log(`  left alone (guard agrees)  ${f(s.unchanged)}`);
  console.log(`  no parsable slug           ${f(s.noSlug)}`);
  console.log(`  no player to park under    ${f(s.noPlayer)}   <- left in place; there is no address for them`);
  console.log(`  failed                     ${f(s.failed)}   (${f(s.duplicatesLeft)} duplicates left in the pool)`);
  console.log(`  not reached                ${f(s.notReached)}`);
  console.log(`  collapsed onto an existing row at the target  ${f(s.collapsedOntoExisting)}   <- same sale id, already there`);
  console.log(`  slug recompute would differ ${f(s.slugDrift)}   <- reported only; the number segment is replaced, the rest is left as written`);
  console.log(`\n  why the number changed:`);
  for (const [k, n] of [...rejectHist.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(26)} ${f(n).padStart(10)}`);
  console.log(`\n  by source:`);
  for (const [k, n] of [...sourceHist.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(26)} ${f(n).padStart(10)}`);

  if (APPLY) {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER. `notReached` rows were never
    // scanned -- the budget stopped the loop before their batch ran -- so they
    // are NOT in `scanned`. Folding them into `skipped` while intending only
    // `scanned` claims more than was intended and trips the over-accounting
    // alarm on every budget stop. The rows this run took responsibility for
    // are the ones it scanned PLUS the ones it was holding and did not reach.
    reportWrites({
      job: "repair-card-number-from-title",
      intended: s.scanned + s.notReached,
      written: written(),
      skipped: s.unchanged + s.noSlug + s.noPlayer + s.notReached,
      failed: s.failed,
    });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
