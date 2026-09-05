#!/usr/bin/env node
/**
 * repair-tiffany-pool-enumeration.cjs -- the two gaps #1745 left behind.
 *
 * CF-TIFFANY-IS-A-PRODUCT (Drew, 2026-09-01), continued.
 *
 * #1745 moved 896 catalog rows and re-keyed 1,107 comps, then stopped. Two
 * populations survived it, for two different reasons, and this is the lane for
 * both. MODE is REQUIRED and selects which.
 *
 * ── GAP 1: THE POOL WAS ENUMERATED FROM THE CATALOG ─────────────────────────
 *
 * #1745's pool lane walked the CATALOG's rung groups and re-keyed the comps it
 * found under them. That is backwards: a comp does not need a catalog rung row
 * to be mis-keyed. Measured 2026-09-04 after #1745 applied, sold_comps still
 * holds 2,127 rows keyed to a Tiffany rung -- 2,097 by the `:tiffany:` slug
 * segment, 2,058 by the `parallel` field, 2,127 in the union.
 *
 * So MODE=pool enumerates THE POOL DIRECTLY -- every row whose slug carries a
 * `:tiffany:` segment OR whose `parallel` states Tiffany -- and maps each to
 * its sibling product identity on the same (sport, year, cardNumber) keeping
 * the grade and auto segments. The catalog is consulted only to answer "does
 * the sibling product exist", never to decide which comps are in scope.
 *
 * ── THE SIBLING IS RESOLVED FROM THE STAGED CHECKLISTS, NOT BY A NAMING RULE ─
 *
 * #1745 derived the sibling as `${setKey}-tiffany`. That rule is WRONG, and
 * #1748 is what proves it: the 1987-1989 Fleer coated reprints are the GLOSSY
 * TIN product and their staged checklists declare `fleer-glossy` /
 * `fleer-update-glossy`, while 1996/1997/2002 Fleer really are `fleer-tiffany`.
 * A rule that appends `-tiffany` would send the 1987-1989 rows to a product
 * that does not exist and will never exist.
 *
 * The sibling therefore comes from backend/data/checklists/scraped/*.manifest
 * .json: every staged manifest whose setKey ends `-tiffany` or `-glossy` is
 * indexed by (sport, year), and a rung's sibling is the staged product for its
 * own (sport, year) whose key is the rung's setKey plus either suffix. 21 such
 * checklists are staged today. Reading the manifests rather than hardcoding
 * means the next acquisition arms its groups without editing this script --
 * and a group whose checklist is NOT staged is reported, never guessed at.
 *
 * A staged checklist is necessary but NOT sufficient: the gate also requires
 * the product to hold rows in the CATALOG, because a staged CSV that has not
 * been ingested yet cannot receive a comp. Both conditions are reported
 * separately so "the checklist is staged but not ingested" is distinguishable
 * from "nobody has acquired it".
 *
 * THE TITLE GUARD IS UNCHANGED and still load-bearing: 93 of the rows in scope
 * carry a `:tiffany:` slug whose own title reads "1987 Topps Baseball #450
 * Base". Moving one carries a base sale INTO the Tiffany pool. Report-only
 * CONFLICT, forever.
 *
 * ── GAP 2: THE 1991 TOPPS TRADED BLOCK, AND `num-1951` ──────────────────────
 *
 * 132 catalog rows sit at `hiq:baseball:1991:topps-traded:21t:topps-traded-
 * tiffany:no-auto:num-1951`. Three things are wrong with that id at once:
 *
 *   1. the setKey is the PAPER product, `topps-traded`;
 *   2. the parallel segment NAMES THE SIBLING PRODUCT -- "Topps Traded
 *      Tiffany" is not a finish, it is the product the row belongs to. Same
 *      for the 1-row "Limited Edition Tiffany", which is marketing copy for
 *      that same product ("132 Card Limited Edition Glossy set");
 *   3. `num-1951` IS NOT A PRINT RUN. It is the year 1951, read out of the
 *      baseballcardpedia page's NAVBOX FOOTER.
 *
 * WHERE 1951 COMES FROM, traced and reproduced against the live page
 * (https://baseballcardpedia.com/index.php/1991_Topps_Traded, 66,117 bytes):
 * the page's navbox is a MediaWiki `toccolours` table beginning at byte 38,160
 * that links every Topps flagship year, opening:
 *
 *     <td><b>Topps (flagship) Classic Era:</b>
 *       <a href="/index.php/1951_Topps" title="1951 Topps">1951</a> - ...
 *
 * `1951` sits at byte 38,542. `section()`'s PAGE_CHROME terminator list
 * (catlinks / printfooter / mw-navigation / footer) does not include the
 * navbox, and the nearest of those on this page -- `printfooter` -- is at byte
 * 57,511, some 19,000 bytes PAST the navbox. So the slice for the LAST heading
 * in Parallels (`Topps_Traded_Tiffany`) swallows the navbox, and RUN_NOTE's
 * third alternative -- a bare `:\s*([\d,]+)` with no print-run keyword in
 * front of it -- matches the literal text `": 1951"` after "Classic Era".
 * The gate that follows only asks `n >= 1 && n <= 100000`, which every
 * four-digit year passes. The page's own production sentence explicitly
 * declines to give a figure: "Although production figures were never
 * disclosed, it is believed that the 1991 edition was the scarcest Topps
 * Traded Tiffany set produced." The correct print run is BLANK.
 *
 * THE STAGED FILE IS ALREADY RIGHT, WHICH BOUNDS THIS REPAIR. The current
 * staged checklist (data/checklists/scraped/1991-topps-traded-tiffany-
 * baseball.csv, scraped 2026-09-04T07:16Z) carries 132 rows under setKey
 * `topps-traded-tiffany` with a BLANK printRun, and no staged CSV anywhere
 * carries 1951. The prod rows are stale output from an EARLIER run. So this
 * lane repairs stored rows; the scraper change that ships with it is a
 * DEFENCE (a year-shaped value is never a print run) plus a pin, not a fix for
 * a defect the current page still reproduces.
 *
 * MODE=num1951 therefore RETIRES those 132 rows with the standard marker --
 * never a delete -- because the staged file already supplies the 132 correct
 * rows and re-ingesting it is how they come back, properly keyed. Retire, not
 * convert: converting would mint `topps-traded-tiffany` rows carrying the
 * bogus print run in their id.
 *
 * The rows are found BY SHAPE, never by the literal 1951: any
 * `baseballcardpedia-ladders-*` row whose printRun is year-shaped (1900-2100)
 * or whose parallel NAMES its own sibling product. The number captured is
 * whatever leads a page's navbox, so a page whose navbox opens on a different
 * era would mint a different year, and a repair keyed on "1951" would miss it.
 *
 * REPORT FIRST, in both modes. Nothing is written without BACKFILL_APPLY=true.
 * Both print the per-group rows and the reconciliation
 * `intended = written + skipped + failed`; an apply arms reportWrites, which
 * exits non-zero when that arithmetic does not close.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   MODE                      pool | num1951   REQUIRED, no default (runner: mode)
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   YEARS / SPORTS            optional filters (runner: years / sports)
 *   SCOPE                     optional setKey filter (runner: scope); the
 *                             inherited default "refractor" is ignored
 *   LIMIT / SLOT / SLOTS / CONCURRENCY / RUN_MINUTES
 * Requires dist/ (catalogRowOps, writeReconciliation).
 */
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
const MODES = ["pool", "num1951"];
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (2026-09-04).
//
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT OF
// "16", so `process.env.SLOTS ?? 1` never saw undefined and this lane sharded
// itself 16 ways on a dispatch that asked for no sharding. Run 33899174030
// (report) and 33899784003 (APPLY) both printed `slot 0/16` and
// `rows scanned 11 (+2,046 other slots)` -- reconciling honestly as
// "intended 11 = written 0 + skipped 11" while 2,046 rows sat in fifteen
// slots nobody dispatched. The same shape ran #1745's applies: `slot 0/16`,
// which is why 896 catalog rows became 20+28 and 1,107 comps became 71.
//
// A shard is now OPT-IN. Sharding happens only when the dispatch names a
// slot explicitly -- SLOT is set to a non-empty value AND SLOTS > 1 -- so an
// unset, empty, or inherited-default input means ALL ROWS, which is what a
// scope nobody chose has to mean. This is the same doctrine that already
// makes the inherited `scope=refractor` mean "no setKey filter".
const rawSlot = String(process.env.SLOT ?? "").trim();
const rawSlots = String(process.env.SLOTS ?? "").trim();
const SLOT = Number(rawSlot || 0);
const SLOTS_REQUESTED = Math.max(1, Number(rawSlots || 1));
// The dispatcher OPTED IN only if it named a slot. `slots` alone is the
// runner's own default and never shards on its own.
// BOTH inputs carry a workflow-wide DEFAULT (`slot: "0"`, `slots: "16"`), so
// the environment alone can never tell "I chose slot 0 of 16" from "I chose
// nothing and inherited both" -- they are the same bytes. The tie is broken
// the only way it honestly can be:
//
//   slot > 0      only a deliberate dispatch names a non-zero slot, and such
//                 a run is by definition one of a fan-out.
//   SHARD=true    the explicit opt-in for slot 0 of a REAL fan-out, so
//                 `slot=0 slots=16 SHARD=true` still works. It rides an env
//                 var, not a new dispatch input (GitHub caps
//                 workflow_dispatch at 25 and 24 are used).
//
// Everything else -- including the inherited `slot=0 slots=16` that ran
// #1745's and #1752's applies at 1/16th coverage -- sweeps EVERY row. An
// under-sweep that reconciles honestly is the worst failure mode available:
// run 33899784003 printed "APPLIED ... intended 11 = written 0 + skipped 11"
// and was GREEN, while 2,046 rows sat in fifteen slots nobody dispatched.
const SHARD_OPT_IN = /^(1|true|yes)$/i.test(String(process.env.SHARD ?? "").trim());
const SHARDED = SLOTS_REQUESTED > 1 && Number.isFinite(SLOT) && (SLOT > 0 || SHARD_OPT_IN);
const SLOTS = SHARDED ? SLOTS_REQUESTED : 1;
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

const REASON = "tiffany-is-a-product";
const REASON_LONG = "Tiffany is a PRODUCT, never a rung (CF-TIFFANY-IS-A-PRODUCT, Drew 2026-09-01)";
const REASON_1951 = "a navbox year is not a print run (CF-A-YEAR-IS-NOT-A-PRINT-RUN, 2026-09-04)";

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT);
const SETKEYS = csv(process.env.SCOPE).filter((s) => s !== "refractor" && s !== "all");

const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const mineByShard = (key) => !SHARDED || shardOf(str(key)) === SLOT;

// ── vocabulary ──────────────────────────────────────────────────────────────

/** Does this text state Tiffany? Word match, applied one field at a time. */
function statesTiffany(text) {
  return /\btiffany\b/i.test(String(text ?? ""));
}

/** A YEAR wearing a print run's clothes. The bcp navbox bleed captured 1951 on
 *  the 1991 page, but the number is whatever leads THAT page's navbox, so the
 *  test is the SHAPE -- a plausible card year -- never the literal value.
 *  A real print run of exactly 1987 or 2002 is possible in principle but has
 *  never been observed on this source, and the repair reports every row it
 *  touches by id, so a false positive is visible before it is written. */
function isYearShapedPrintRun(printRun) {
  const n = Number(printRun);
  return Number.isInteger(n) && n >= 1900 && n <= 2100;
}

/** Does this parallel NAME a product rather than a finish? "Topps Traded
 *  Tiffany" and "Limited Edition Tiffany" are the sibling product's own name
 *  and its marketing copy -- neither is a rung of the paper set. */
function parallelNamesProduct(parallel, siblingSetKey) {
  const p = String(parallel ?? "").trim().toLowerCase();
  if (!p) return false;
  if (/^limited edition tiffany$/.test(p)) return true;
  const sib = String(siblingSetKey ?? "").replace(/-/g, " ").toLowerCase();
  return !!sib && p === sib;
}

/** hiq:sport:year:setKey:number:parallel:auto[...] */
function slugParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return null;
  if (!parts[1] || !/^\d{4}$/.test(parts[2]) || !parts[3]) return null;
  return parts;
}

function axesOf(id) {
  const parts = slugParts(id);
  if (!parts) return null;
  return { sport: parts[1], year: Number(parts[2]), setKey: parts[3], cardNumber: parts[4], parallel: parts[5], parts };
}

/** Rewrite the setKey segment, blank the parallel segment, and DROP a
 *  year-shaped print run. Everything else -- number, auto flag, grade tier --
 *  is carried verbatim (D28: surgery, never a recompute). */
function toSiblingSlug(id, sibling) {
  const parts = slugParts(id);
  if (!parts) return null;
  const out = parts.slice();
  out[3] = sibling;
  out[5] = "base";
  const tail = out.slice(7).filter((seg) => {
    const m = /^num-(\d+)$/.exec(seg);
    return !(m && isYearShapedPrintRun(m[1]));
  });
  return out.slice(0, 7).concat(tail).join(":");
}

function inScope(axes) {
  if (!axes) return false;
  if (YEARS.length && !YEARS.includes(axes.year)) return false;
  if (SPORTS.length && !SPORTS.includes(axes.sport)) return false;
  if (SETKEYS.length && !SETKEYS.includes(axes.setKey)) return false;
  return true;
}

/** A pool row is rung-keyed under EITHER spelling. Measured after #1745:
 *  2,097 by slug, 2,058 by parallel, 2,127 in the union. */
function isPoolRung(row) {
  if (statesTiffany(row?.parallel)) return true;
  const axes = axesOf(row?.hobbyiqCardId);
  return !!axes && statesTiffany(axes.parallel);
}

/**
 * THE SIBLING TABLE, READ FROM THE STAGED CHECKLISTS.
 *
 * Every staged manifest whose setKey ends `-tiffany` or `-glossy`, indexed by
 * `sport:year:setKey`. #1748 is why this is not a naming rule: 1987-1989 Fleer
 * is `fleer-glossy` (the Glossy Tin), 1996/1997/2002 Fleer is `fleer-tiffany`.
 */
function loadStagedSiblings(dir) {
  const byKey = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".manifest.json")); }
  catch { return byKey; }
  for (const name of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    const setKey = str(d.setKey).toLowerCase();
    if (!setKey.endsWith("-tiffany") && !setKey.endsWith("-glossy")) continue;
    const sport = str(d.sport).toLowerCase();
    const year = Number(d.year);
    if (!sport || !Number.isFinite(year)) continue;
    byKey.set(`${sport}:${year}:${setKey}`, { setKey, sport, year, rowCount: Number(d.rowCount) || 0, file: name });
  }
  return byKey;
}

/**
 * The sibling product for a rung. A key already ending -tiffany/-glossy is its
 * own sibling. Otherwise the candidate is the rung's key plus `-tiffany` or
 * `-glossy`, and it counts as REAL when EITHER source vouches for it:
 *
 *   staged   a manifest for that exact (sport, year) is in the repo, or
 *   ingested the product already holds catalog rows at that (sport, year).
 *
 * BOTH are needed, and the first report proved why. Only 1987 `topps-tiffany`
 * has a staged manifest, but the CATALOG holds 2,423 topps-tiffany rows across
 * 1984-1991 -- minted by earlier lanes, not by a staged CSV. A staged-only
 * gate reported 808 comps as "acquire before retire" whose product was sitting
 * right there, ingested. A ingested-only gate would in turn miss a product
 * whose CSV is staged but not yet ingested. `has` is the caller's live catalog
 * probe; it is consulted only when nothing is staged, so the common path stays
 * a cheap map lookup.
 */
function siblingCandidates(setKey) {
  const k = String(setKey ?? "").toLowerCase();
  if (!k) return [];
  if (k.endsWith("-tiffany") || k.endsWith("-glossy")) return [k];
  return [`${k}-tiffany`, `${k}-glossy`];
}

/** Staged-only resolution. Kept as its own function because it is the half
 *  that needs no Cosmos read, and the pins exercise it directly. */
function siblingFor(staged, sport, year, setKey) {
  const cands = siblingCandidates(setKey);
  if (cands.length === 1) return cands[0];
  for (const c of cands) if (staged.has(`${sport}:${year}:${c}`)) return c;
  return null;
}

/** Staged OR ingested. `countRows(sibling)` must return the catalog row count
 *  for that (sport, year, sibling). Returns { sibling, via } or null. */
async function resolveSibling(staged, sport, year, setKey, countRows) {
  const cands = siblingCandidates(setKey);
  if (cands.length === 1) return { sibling: cands[0], via: "self" };
  for (const c of cands) if (staged.has(`${sport}:${year}:${c}`)) return { sibling: c, via: "staged" };
  for (const c of cands) {
    const n = await countRows(c);
    if (n > 0) return { sibling: c, via: "ingested" };
  }
  return null;
}

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

  /** The post-loop AFTER count, under a hard cap.
   *
   *  CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This is an unbounded
   *  cross-partition aggregate: on run 33960686247 the same shape ran 887
   *  seconds and was still running when the runner killed the step at its
   *  150-minute ceiling -- AFTER the reconciliation had printed and balanced.
   *  The data was fine; the job was red. So it now either answers within
   *  VERIFY_MS or says it could not, and an unread count is printed as
   *  UNCONFIRMED rather than as a zero (a missing number must never read as
   *  an empty result).
   *
   *  The BEFORE count is deliberately NOT capped: it runs before any work, so
   *  a slow one costs the loop budget the reserve already accounts for, and
   *  it can never strand a reconciliation that has already printed. */
  async function cappedCount(spec) {
    let timer = null;
    try {
      const { resources } = await Promise.race([
        retry(() => pool.items.query(spec).fetchAll()),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("verify-cap")), VERIFY_MS);
          if (timer.unref) timer.unref();
        }),
      ]);
      return Number(resources[0] ?? 0);
    } catch (e) {
      console.log(`  VERIFY BY READ: could not confirm within the cap (${String(e && e.message)})`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** An unread count prints as UNCONFIRMED (verify cap), never as 0. */
  const shownCount = (n) => (n === null ? "UNCONFIRMED (verify cap)" : `${f(n)} rows`);
  if (!MODES.includes(MODE)) {
    console.error(`FATAL: MODE is required and has no default -- one of ${MODES.join(" | ")}.`);
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const { patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const staged = loadStagedSiblings(path.join(backend, "data", "checklists", "scraped"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`repair-tiffany-pool-enumeration  MODE=${MODE}  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing written"}`);
  console.log(`  ruling   ${MODE === "num1951" ? REASON_1951 : REASON_LONG}`);
  console.log(`  scope    years=${YEARS.length ? YEARS.join(",") : "(all)"}  sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}  setKeys=${SETKEYS.length ? SETKEYS.join(",") : "(all)"}`);
  console.log(`  sharding ${SHARDED ? `ON -- slot ${SLOT}/${SLOTS}. THIS RUN COVERS 1/${SLOTS} OF THE POPULATION; dispatch every slot 0..${SLOTS - 1} or the sweep is partial.` : `OFF -- this run sweeps EVERY row${SLOTS_REQUESTED > 1 ? ` (slots=${rawSlots} is the runner's inherited default, not a chosen shard; pass SHARD=true with slot=0 to fan out)` : ""}`}`);
  console.log(`  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  staged Tiffany/Glossy checklists: ${f(staged.size)}  (the sibling table -- a naming rule would send 1987-1989 Fleer to a product that will never exist)`);
  console.log("");

  const catalogRowsCache = new Map();
  async function catalogRows(sport, year, sibling) {
    const key = `${sport}:${year}:${sibling}`;
    if (catalogRowsCache.has(key)) return catalogRowsCache.get(key);
    const n = (await retry(() => cat.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p)",
      parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${sibling}:` }],
    }).fetchAll())).resources[0] ?? 0;
    catalogRowsCache.set(key, n);
    return n;
  }

  const groups = new Map();
  function group(key, extra = {}) {
    let g = groups.get(key);
    if (!g) { g = { key, counts: {}, rows: [], ...extra }; groups.set(key, g); }
    return g;
  }
  const bump = (g, k) => { g.counts[k] = (g.counts[k] ?? 0) + 1; };

  if (MODE === "pool") return repairPool();
  return repairNum1951();

  // ── MODE=pool ─────────────────────────────────────────────────────────────
  async function repairPool() {
    const s = {
      scanned: 0, otherSlot: 0, rekeyed: 0, created: 0, deleted: 0, collapsed: 0,
      conflict: 0, noStaged: 0, notIngested: 0, outOfScope: 0, notRung: 0,
      malformed: 0, duplicatesLeft: 0, failed: 0,
    };
    let stopReason = null;
    const noSibling = new Map();

    const PRED = "CONTAINS(c.hobbyiqCardId, ':tiffany:') OR CONTAINS(LOWER(c.parallel), 'tiffany')";
    const before = (await retry(() => pool.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${PRED}`, parameters: [],
    }).fetchAll())).resources[0] ?? 0;
    console.log(`  BEFORE  ${f(before)} pool rows keyed to a Tiffany rung (slug segment OR parallel field)`);
    console.log(`  ENUMERATED FROM THE POOL, not from the catalog -- a comp does not need a rung row to be mis-keyed.`);
    console.log("");

    async function handle(row) {
      const id = String(row.id);
      if (!isPoolRung(row)) { s.notRung++; return; }
      const oldSlug = str(row.hobbyiqCardId);
      const axes = axesOf(oldSlug);
      if (!axes) { s.malformed++; return; }
      if (!inScope(axes)) { s.outOfScope++; return; }

      // GATE 1: does the sibling product EXIST -- staged, or already ingested?
      const resolved = await resolveSibling(staged, axes.sport, axes.year, axes.setKey,
        (cand) => catalogRows(axes.sport, axes.year, cand));
      const sibling = resolved?.sibling ?? null;
      const gkey = `${axes.sport} ${axes.year} ${axes.setKey} -> ${sibling ?? "(no Tiffany product)"}`;
      const g = group(gkey, { sport: axes.sport, year: axes.year, setKey: axes.setKey, sibling, via: resolved?.via });

      if (!sibling) {
        s.noStaged++;
        bump(g, "LEFT: no Tiffany product (not staged, not ingested)");
        const nk = `${axes.sport} ${axes.year} ${axes.setKey}`;
        noSibling.set(nk, (noSibling.get(nk) ?? 0) + 1);
        if (g.rows.length < 10) g.rows.push(`    LEFT (no ${axes.setKey}-tiffany/-glossy for ${axes.sport} ${axes.year})  ${id.slice(0, 62)}`);
        return;
      }
      // GATE 2: a comp can only land on a product the CATALOG already holds.
      const rows = await catalogRows(axes.sport, axes.year, sibling);
      g.siblingRows = rows;
      if (rows === 0) {
        s.notIngested++;
        bump(g, "LEFT: staged but NOT ingested");
        const nk = `${axes.sport} ${axes.year} ${axes.setKey} (staged as ${sibling}, not ingested)`;
        noSibling.set(nk, (noSibling.get(nk) ?? 0) + 1);
        if (g.rows.length < 10) g.rows.push(`    LEFT (${sibling} staged, 0 catalog rows)  ${id.slice(0, 60)}`);
        return;
      }

      // THE TITLE GUARD. Unchanged from #1745 and still load-bearing.
      if (!statesTiffany(row.title)) {
        s.conflict++;
        bump(g, "CONFLICT: title does not state Tiffany");
        if (g.rows.length < 10) g.rows.push(`    CONFLICT  ${id.slice(0, 62)}\n              title: ${str(row.title).slice(0, 80)}  parallel: ${str(row.parallel)}`);
        return;
      }

      const target = toSiblingSlug(oldSlug, sibling);
      if (!target || target === oldSlug) { s.notRung++; return; }

      const keep = stripSystem(row);
      const oldPk = str(row.cardId);
      if (oldPk && oldPk !== oldSlug && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
      keep.cardId = target;
      keep.hobbyiqCardId = target;
      keep.setKey = sibling;
      keep.normalizedSetKey = sibling;
      keep.parallel = "";
      keep.parallelBefore = str(row.parallel);
      keep.setKeyBefore = axes.setKey;
      keep.rekeyedFrom = oldSlug;
      keep.rekeyedAt = new Date().toISOString();
      keep.rekeyedReason = REASON;
      keep.contentHash = contentHashOf(keep);

      if (g.rows.length < 10) {
        g.rows.push(`    REKEY  ${oldSlug.slice(0, 66)}\n           -> ${target.slice(0, 66)}\n              ${str(row.title).slice(0, 80)}`);
      }

      const res = await relocateSoldComp(pool, {
        keep,
        drop: [{ id: row.id, cardId: row.cardId }],
        retry,
        verifyFields: ["cardId", "hobbyiqCardId", "setKey", "parallel", "contentHash", "rekeyedFrom"],
        dryRun: !APPLY,
      });
      if (!res.ok && res.stage !== "done") {
        s.failed++;
        console.log(`  FAILED at ${res.stage}: ${row.id} -> ${target}: ${String(res.error).slice(0, 110)}`);
        return;
      }
      if (res.duplicatesLeft.length) {
        s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
        for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 80)}`);
        return;
      }
      if (!APPLY) { s.created += 1; s.deleted += 1; }
      else {
        s.created += res.existedBefore ? 0 : 1;
        s.deleted += res.deleted.length;
        if (res.existedBefore) s.collapsed++;
      }
      s.rekeyed++;
      bump(g, "REKEYED onto the product");
    }

    await forEachPage(pool, {
      query: `SELECT * FROM c WHERE ${PRED}`, parameters: [],
    }, async (rows) => {
      const mine = rows.filter((r) => { if (mineByShard(r.id)) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map((r) => handle(r).catch((e) => {
          s.failed++;
          if (s.failed <= 5) console.log(`  FAILED ${String(r.id).slice(0, 64)}: ${String(e?.message ?? e).slice(0, 110)}`);
        })));
        // Rows past the break were never added to s.scanned, so counting them
        // as `skipped` would overshoot: `intended` is what this slot classified.
        if (LIMIT && s.rekeyed >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
      }
      return !stopReason;
    }, 400);

    printGroups();
    banner(stopReason);
    console.log(`  rows scanned (this slot)     ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  REKEYED onto the product     ${f(s.rekeyed)}   <- cardId AND hobbyiqCardId, verified by read`);
    console.log(`  new rows created             ${f(s.created)}`);
    console.log(`  old rows deleted             ${f(s.deleted)}`);
    console.log(`  collapsed onto an existing   ${f(s.collapsed)}`);
    console.log(`  CONFLICT: title silent on Tiffany ${f(s.conflict)}   <- report-only, never written`);
    console.log(`  LEFT: no Tiffany product     ${f(s.noStaged)}   <- not staged AND not ingested; acquire before retire`);
    console.log(`  LEFT: staged but NOT ingested ${f(s.notIngested)}   <- ingest the staged CSV, then re-run`);
    console.log(`  LEFT: out of dispatched scope ${f(s.outOfScope)}`);
    console.log(`  not a rung row / malformed   ${f(s.notRung + s.malformed)}`);
    console.log(`  duplicates LEFT in the pool  ${f(s.duplicatesLeft)}`);
    console.log(`  failed                       ${f(s.failed)}`);

    if (noSibling.size) {
      console.log("");
      console.log("  SIBLINGS STILL ABSENT (the acquisition list, by row count):");
      for (const [k, n] of [...noSibling].sort((a, b) => b[1] - a[1])) console.log(`    ${String(f(n)).padStart(6)}  ${k}`);
    }

    const after = await cappedCount({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${PRED}`, parameters: [],
    });
    const expect = APPLY ? before - s.deleted : before;
    console.log("");
    console.log(`  AFTER   ${shownCount(after)} (before ${f(before)}${APPLY ? `, expected ${f(expect)}` : ", report-only: unchanged expected"})`);
    if (after === null) {
      console.log(`    the verify count is UNREAD, not zero -- the writes above reconciled and are durable.`);
    } else if (after !== expect) {
      console.log(`    NOTE differs by ${f(after - expect)} -- other slots, the CONFLICT rows that stay, or a concurrent writer.`);
    }

    reconcile("repair-tiffany-pool-enumeration:pool", s.scanned, s.rekeyed,
      s.conflict + s.noStaged + s.notIngested + s.outOfScope + s.notRung + s.malformed, s.failed);
  }

  // ── MODE=num1951 ──────────────────────────────────────────────────────────
  async function repairNum1951() {
    const s = {
      scanned: 0, otherSlot: 0, retired: 0, outOfScope: 0, notThisShape: 0,
      noop: 0, failed: 0,
    };
    let stopReason = null;

    console.log(`  Rows are found BY SHAPE, never by the literal 1951: the captured number is`);
    console.log(`  whatever leads that page's navbox, so another page would mint another year.`);
    console.log(`  RETIRE, not convert: the staged 1991 checklist already carries the 132 correct`);
    console.log(`  rows under topps-traded-tiffany with a BLANK print run.`);
    console.log("");

    // THE SCOPE GOES INTO THE QUERY, not into a JS filter. A first report run
    // scanned 947,038 rows to find 132 because the year was applied after the
    // read: every bcp-ladders row in the corpus carries a print run. The slug
    // prefix is the index-served axis (CF-THE-ID-CARRIES-THE-PRODUCT), so when
    // a sport+year scope is given the scan is bounded to it.
    const prefixes = [];
    if (SPORTS.length && YEARS.length) {
      for (const sp of SPORTS) for (const y of YEARS) prefixes.push(`hiq:${sp}:${y}:`);
    }
    const specs = prefixes.length
      ? prefixes.map((p) => ({
          query: "SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND STARTSWITH(c.source, 'baseballcardpedia-ladders') AND IS_DEFINED(c.printRun) AND c.printRun != null",
          parameters: [{ name: "@p", value: p }],
        }))
      : [{
          query: "SELECT * FROM c WHERE STARTSWITH(c.source, 'baseballcardpedia-ladders') AND IS_DEFINED(c.printRun) AND c.printRun != null",
          parameters: [],
        }];
    if (prefixes.length) console.log(`  scan bounded to ${prefixes.join(", ")}`);
    else console.log(`  UNBOUNDED scan: every bcp-ladders row with a print run. Pass sports+years to bound it.`);
    console.log("");

    for (const spec of specs) {
    if (stopReason) break;
    await forEachPage(cat, spec, async (rows) => {
      const mine = rows.filter((r) => { if (mineByShard(r.id)) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map(async (d) => {
          const id = String(d.id);
          try {
            const axes = axesOf(id);
            if (!axes) { s.notThisShape++; return; }
            if (!inScope(axes)) { s.outOfScope++; return; }

            const yearShaped = isYearShapedPrintRun(d.printRun);
            const sibling = (await resolveSibling(staged, axes.sport, axes.year, axes.setKey,
              (cand) => catalogRows(axes.sport, axes.year, cand)))?.sibling ?? null;
            const namesProduct = parallelNamesProduct(d.parallel, sibling);
            // BOTH defects are the same row's, and either one condemns it: an
            // id carrying a navbox year, or a parallel that names the product.
            if (!yearShaped && !namesProduct) { s.notThisShape++; return; }

            const g = group(`${axes.sport} ${axes.year} ${axes.setKey} -> ${sibling ?? "(no staged checklist)"}`,
              { sport: axes.sport, year: axes.year, setKey: axes.setKey, sibling });

            const why = [
              yearShaped ? `printRun ${d.printRun} is year-shaped (a navbox link, not a print run)` : null,
              namesProduct ? `parallel "${str(d.parallel)}" NAMES the product, not a finish` : null,
            ].filter(Boolean).join("; ");

            const r = await patchCatalogRowFields(cat, id, d.cardId, {
              retired: true,
              retiredReason: REASON_1951,
              retiredAt: new Date().toISOString(),
              retiredIntoSetKey: sibling ?? null,
              retiredBecause: why,
              printRunBefore: d.printRun ?? null,
              parallelBefore: str(d.parallel),
              setKeyBefore: axes.setKey,
            }, { dryRun: !APPLY, retry, noShadow: true });

            if (r.action === "patch") {
              s.retired++;
              bump(g, yearShaped && namesProduct ? "RETIRED (year-shaped run + product-named parallel)"
                : yearShaped ? "RETIRED (year-shaped print run)" : "RETIRED (product-named parallel)");
              if (g.rows.length < 12) g.rows.push(`    RETIRE  ${id}\n            ${why}`);
            } else s.noop++;
          } catch (e) {
            s.failed++;
            if (s.failed <= 5) console.log(`  FAILED ${id.slice(0, 70)}: ${String(e?.message ?? e).slice(0, 110)}`);
          }
        }));
        // The rows past the break were never added to s.scanned, so counting
        // them as `skipped` would overshoot the reconciliation. `intended` is
        // what this slot actually classified.
        if (LIMIT && s.retired >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
      }
      return !stopReason;
    });
    }

    printGroups();
    banner(stopReason);
    console.log(`  rows scanned (this slot)     ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  RETIRED (marker, never a delete) ${f(s.retired)}   <- the staged checklist supplies the correct rows`);
    console.log(`  not this shape (left)        ${f(s.notThisShape)}   <- a real print run, or a real finish`);
    console.log(`  LEFT: out of dispatched scope ${f(s.outOfScope)}`);
    console.log(`  noop / already retired       ${f(s.noop)}`);
    console.log(`  failed                       ${f(s.failed)}`);
    reconcile("repair-tiffany-pool-enumeration:num1951", s.scanned, s.retired,
      s.notThisShape + s.outOfScope + s.noop, s.failed);
  }

  // ── shared reporting ──────────────────────────────────────────────────────
  function printGroups() {
    const all = [...groups.values()].sort((a, b) => {
      const an = Object.values(a.counts).reduce((x, y) => x + y, 0);
      const bn = Object.values(b.counts).reduce((x, y) => x + y, 0);
      return bn - an;
    });
    console.log("");
    console.log(`── ${f(all.length)} group(s) seen by this slot ──────────────────────────────────`);
    for (const g of all) {
      const total = Object.values(g.counts).reduce((x, y) => x + y, 0);
      const gate = g.sibling
        ? (g.siblingRows === undefined ? `sibling ${g.sibling}${g.via ? ` (${g.via})` : ""}` : g.siblingRows > 0 ? `sibling ${g.sibling} has ${f(g.siblingRows)} rows (${g.via})` : `sibling ${g.sibling} STAGED but not ingested`)
        : "no Tiffany product -- acquire before retire";
      console.log(`\n  ${g.key}   ${f(total)} row(s)   [${gate}]`);
      for (const [k, n] of Object.entries(g.counts).sort((a, b) => b[1] - a[1])) console.log(`      ${String(f(n)).padStart(6)}  ${k}`);
      for (const line of g.rows) console.log(line);
    }
    console.log("");
  }

  function banner(stopReason) {
    if (stopReason === "budget") {
      console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
    } else if (stopReason === "limit") {
      console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
    }
    console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  }

  function reconcile(job, intended, written, skipped, failed) {
    console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)}${failed ? ` + failed ${f(failed)}` : ""}`);
    if (APPLY) reportWrites({ job, intended, written, skipped, failed });
  }
}

module.exports = {
  statesTiffany, isYearShapedPrintRun, parallelNamesProduct, slugParts, axesOf,
  toSiblingSlug, inScope, isPoolRung, loadStagedSiblings, siblingFor,
  siblingCandidates, resolveSibling, REASON, REASON_1951,
  // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: exported so the pins can
  // assert the opt-in directly under the runner's own env.
  SHARDED, SLOT, SLOTS, SHARD_OPT_IN,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
