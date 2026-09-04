#!/usr/bin/env node
/**
 * repair-tiffany-rung-to-product.cjs -- Tiffany is a PRODUCT, never a rung.
 *
 * CF-TIFFANY-IS-A-PRODUCT (Drew, 2026-09-01, restated 2026-09-04).
 *
 *   Tiffany is its own product with its own setKey -- topps-tiffany,
 *   topps-traded-tiffany, bowman-tiffany -- and a BLANK parallel. It is never
 *   a parallel of the paper product whose checklist it shares. A row filed as
 *   `parallel: "Tiffany"` on the paper product's setKey is a SPLIT POOL: the
 *   same physical card priced twice, from two partial comp pools, under two
 *   identities.
 *
 * The census (#1742, backend/docs/audits/2026-09-04-tiffany-rung-and-phantom-
 * key-census.md) measured the damage read-only. This is the write lane it
 * named. Three things it found that changed this script's shape, each
 * re-measured against prod on 2026-09-04 before a line was written:
 *
 *   1. `cardYear` IS NOT THE YEAR AXIS. The census grouped on `cardYear`, and
 *      the 132-row 1991 topps-traded block has NO `cardYear` at all -- it
 *      carries `year: 1991` and its id says `hiq:baseball:1991:topps-traded:`.
 *      Grouping on the absent field is why the census counted 42 groups /
 *      2,151 rows where the catalog actually holds 49 / 2,235. THE SLUG IS THE
 *      AXIS, for sport, year and setKey alike (CF-THE-ID-CARRIES-THE-PRODUCT).
 *
 *   2. THE POOL RUNG IS NOT ALWAYS IN THE SLUG. Measured: 2,129 pool rows say
 *      Tiffany in `parallel`, 2,178 carry a `:tiffany:` slug segment, and the
 *      UNION is 2,198 -- the two sets overlap but neither contains the other.
 *      A 1987 Topps row reads slug `hiq:baseball:1987:topps:130:base:no-auto`
 *      with `parallel: "Tiffany"`: the slug says BASE. A scan keyed only on
 *      rung-identity slugs (the census's 447) would have walked past it. Both
 *      spellings are swept.
 *
 *   3. THIS IS NOT BASEBALL-ONLY. 2,150 baseball, 48 football, 37 basketball.
 *      The sport comes off the slug too, never assumed.
 *
 * THE SIBLING GATE -- the whole safety argument. A group is touched ONLY when
 * a Tiffany sibling product already exists AT THAT EXACT (sport, year).
 * Measured 2026-09-04:
 *
 *   HAS a sibling, so it moves:
 *     baseball topps-tiffany         1984-1991  (65-858 rows/yr)
 *     baseball topps-traded-tiffany  1984-1991  (132-153 rows/yr)
 *     baseball bowman-tiffany        1989-1991
 *     football topps-tiffany         1988, 1990
 *
 *   ABSENT, so it is REPORTED AND LEFT ALONE (acquire before retire):
 *     baseball fleer-tiffany            0 rows  (1996/1997/2002: 1,215 rungs)
 *     baseball fleer-update-tiffany     0 rows
 *     baseball base-set-tiffany         0 rows
 *     basketball fleer-tiffany          0 rows  (1997)
 *     football fleer-tradition-tiffany  0 rows  (2003)
 *
 *   Retiring a Fleer rung would delete the ONLY rows those cards have. The
 *   gate is a live per-(sport,year) COUNT against the catalog, not a compiled
 *   list, so a Fleer Tiffany checklist landing tomorrow arms those groups by
 *   itself -- and until it does, no dispatch can reach them.
 *
 * WHAT IT DOES, per group that passes the gate:
 *
 *   MODE=catalog
 *     (a) the sibling product ALREADY HAS this cardNumber -> RETIRE the rung
 *         row. Retire is a MARKER, never a delete: `retired: true` +
 *         retiredReason / retiredAt / retiredIntoSetKey, written through
 *         patchCatalogRowFields. A sales-attested row is evidence that a real
 *         sale happened; deleting it destroys that evidence, and the census is
 *         explicit that these rows MOVE, never drop. The pool lane re-keys the
 *         comps regardless, so the card keeps its sales either way.
 *     (b) the sibling does NOT have it -> CONVERT the rung row into the
 *         sibling product row: setKey -> the sibling, parallel -> blank, the
 *         id's setKey and parallel segments rewritten to match, `source` kept
 *         as-is, and setKeyBefore / parallelBefore recorded. This is a MOVE,
 *         so it goes through moveCatalogRow, which copies first, re-points the
 *         sales, retires the old slug's graded children and deletes last.
 *     A CHECKLIST-BACKED row is never downgraded: when the incumbent at the
 *     target carries checklist authority, moveCatalogRow folds onto it rather
 *     than replacing it, and a rung row is never allowed to overwrite one.
 *     (c) a GRADED CHILD (`...:no-auto:psa-8`) is RETIRED with the same marker,
 *         never moved: its id is not an identity slug, so moveCatalogRow
 *         refuses it, and the row is regenerable from its parent by
 *         materialize-graded-identities. The first report-only run against
 *         prod failed exactly one row this way -- report-first is what turned
 *         that into a counter rather than a half-applied wave.
 *
 *   MODE=pool
 *     Every sold_comps row keyed to a rung identity is re-keyed -- BOTH cardId
 *     and hobbyiqCardId -- onto the sibling product identity, KEEPING its own
 *     grade and auto segments, stamped rekeyedFrom + rekeyedReason
 *     'tiffany-is-a-product'. Through relocateSoldComp, so the sale exists at
 *     the new address before it stops existing at the old one
 *     (CF-A-SALE-IS-NEVER-LOST), and contentHash is recomputed because cardId
 *     is its first component.
 *
 *     THE TITLE MUST STATE TIFFANY. Measured: of the 2,198 rows in scope,
 *     2,105 say Tiffany in their own title and 93 DO NOT -- and those 93 read
 *     `title: "1987 Topps Baseball #450 Base", parallel: "Base"` under a
 *     `:tiffany:` slug. They are base cards wearing a Tiffany identity, and
 *     moving them would carry a base sale INTO the Tiffany pool -- the same
 *     split-pool defect this lane exists to close, in the other direction.
 *     They are reported as CONFLICT and never written.
 *
 * WHAT IT DOES NOT TOUCH.
 *
 *   GREY BACKS IS A REAL CARD. The 1991 topps-traded block looks like a
 *   132 x 3 cross-join -- `Topps Traded Tiffany` 132, `Grey Backs` 132,
 *   `Limited Edition Tiffany` 1 -- and the census asked whether Grey Backs is
 *   an artefact. It is NOT. Read on the baseballcardpedia page and corroborated
 *   (forums.collectors.com, cardboardconnection): 1991 Topps Traded shipped
 *   through two channels from two plants -- wax packs printed domestically on
 *   GREY stock, factory sets printed at Topps Ireland on WHITE stock -- and
 *   the distinction covers the whole 132-card sheet, which is exactly why its
 *   row count is clean. It is a real variation of THIS set, not bleed from the
 *   1991 Topps flagship. This script matches on the word `tiffany` alone and
 *   so never sees it; a wider "retire the rungs of this cross-join" sweep
 *   would have destroyed 132 real cards.
 *
 *   `Limited Edition Tiffany` (1 row) IS caught, because it contains
 *   `tiffany` -- and it should be: "132 Card Limited Edition Glossy set" is
 *   marketing copy for the Tiffany product itself, so that row belongs on
 *   topps-traded-tiffany like the rest.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true nothing is written, and a report
 * prints the exact rows per group -- the id, the target, and the verdict --
 * because a report nobody can quote is not a report. Both modes print the
 * reconciliation `intended = written + skipped + failed`, and an apply arms
 * reportWrites, which exits non-zero when that arithmetic does not close.
 *
 * VERIFY BY READ. MODE=pool re-reads every re-keyed row at its new address and
 * checks cardId AND hobbyiqCardId both landed, through relocateSoldComp's
 * verifyFields. A write nobody read back is a write nobody has proven.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   MODE                      catalog | pool   REQUIRED, no default (runner: mode)
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   YEARS                     optional comma-separated years   (runner: years)
 *   SCOPE                     optional comma-separated setKeys (runner: scope);
 *                             the inherited default "refractor" is ignored
 *   SPORTS                    optional comma-separated sports  (runner: sports)
 *   LIMIT                     stop after N writes (runner: limit)
 *   SLOT / SLOTS              sha1(id) shards  CONCURRENCY=16  RUN_MINUTES=140
 * Requires dist/ (catalogRowOps, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
const MODES = ["catalog", "pool"];
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
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

const REASON = "tiffany-is-a-product";
const REASON_LONG = "Tiffany is a PRODUCT, never a rung (CF-TIFFANY-IS-A-PRODUCT, Drew 2026-09-01)";

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT);
// `scope` carries the runner-wide default "refractor", which is INHERITED and
// never chosen. It means nothing here, so it is dropped rather than obeyed --
// a setKey filter of "refractor" would silently match nothing and report a
// clean run over an empty population.
const SETKEYS = csv(process.env.SCOPE).filter((s) => s !== "refractor" && s !== "all");

const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const mineByShard = (key) => !SHARDED || shardOf(str(key)) === SLOT;

// ── the vocabulary ──────────────────────────────────────────────────────────

/** Does this text state Tiffany? Word-ish match, case- and padding-insensitive.
 *  Deliberately NOT a bare substring of the whole row: it is applied to one
 *  field at a time by the callers, so "Tiffany" inside a player's name cannot
 *  reach it from a title the way it could from a blob. */
function statesTiffany(text) {
  return /\btiffany\b/i.test(String(text ?? ""));
}

/** The sibling PRODUCT key for a paper setKey: topps -> topps-tiffany.
 *  A key that already ends in -tiffany is its own sibling: those rows carry a
 *  redundant `parallel: "Tiffany"` on the right product, so the repair is a
 *  parallel-blanking rather than a re-key. */
function siblingSetKeyFor(setKey) {
  const k = String(setKey ?? "").trim().toLowerCase();
  if (!k) return null;
  return k.endsWith("-tiffany") ? k : `${k}-tiffany`;
}

/** hiq:sport:year:setKey:number:parallel:auto[:tier][:num-N] -> parts, else null.
 *  Segment 0..6 are the identity; anything beyond is a grade tier or print run
 *  and is carried across a move untouched. */
function slugParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return null;
  if (!parts[1] || !/^\d{4}$/.test(parts[2]) || !parts[3]) return null;
  return parts;
}

/** An IDENTITY row's slug: exactly the 7 identity segments, optionally plus a
 *  `num-N` print run. Anything else -- `...:no-auto:psa-8` -- is a GRADED
 *  CHILD, which is regenerable from its parent by
 *  materialize-graded-identities and is never moved: moveCatalogRow refuses it
 *  outright ("newSlug is not a hiq slug"), because parseHobbyIqCardId does not
 *  accept a tier segment. Found by the first report-only run against prod,
 *  which failed exactly one row -- `hiq:baseball:1990:bowman:nno:tiffany:
 *  no-auto:psa-8`. Report-first is what turned that into a counter instead of
 *  a half-applied wave. */
function isIdentitySlug(id) {
  const parts = slugParts(id);
  if (!parts) return false;
  if (parts.length !== 7 && parts.length !== 8) return false;
  if (parts.length === 8 && !parts[7].startsWith("num-")) return false;
  return parts[6] === "auto" || parts[6] === "no-auto";
}

/** The identity axes a row is filed under, read off the SLUG -- never off
 *  `cardYear`, which the 1991 topps-traded block does not carry at all. */
function axesOf(id) {
  const parts = slugParts(id);
  if (!parts) return null;
  return { sport: parts[1], year: Number(parts[2]), setKey: parts[3], cardNumber: parts[4], parallel: parts[5], parts };
}

/** Rewrite the setKey segment and blank the parallel segment. Segment surgery,
 *  never a recompute (D28): the number, auto flag, grade tier and print run
 *  stay exactly as the row spells them, so a parallel today's resolver would
 *  spell differently cannot ride along on a product move. */
function toSiblingSlug(id, sibling) {
  const parts = slugParts(id);
  if (!parts) return null;
  parts[3] = sibling;
  parts[5] = "base"; // the blank parallel's slug spelling
  return parts.join(":");
}

/** Is this row in the dispatched scope? All three axes are optional filters;
 *  an empty one means "every value", which is what the census-wide report
 *  wants. Read off the slug axes, not the fields. */
function inScope(axes) {
  if (!axes) return false;
  if (YEARS.length && !YEARS.includes(axes.year)) return false;
  if (SPORTS.length && !SPORTS.includes(axes.sport)) return false;
  if (SETKEYS.length && !SETKEYS.includes(axes.setKey)) return false;
  return true;
}

/** A catalog row is a Tiffany RUNG when its `parallel` FIELD states Tiffany.
 *  The setKey may already be the Tiffany product (the redundant-parallel
 *  groups) or the paper product (the split-pool groups); both are rungs. */
function isCatalogRung(row) {
  return statesTiffany(row?.parallel);
}

/** A pool row is keyed to a rung identity when EITHER spelling says so: the
 *  `parallel` field, or the slug's parallel segment. Measured 2026-09-04:
 *  2,129 by field, 2,178 by slug, 2,198 in the union -- neither contains the
 *  other, so a scan on one alone walks past real rows. */
function isPoolRung(row) {
  if (statesTiffany(row?.parallel)) return true;
  const axes = axesOf(row?.hobbyiqCardId);
  return !!axes && statesTiffany(axes.parallel);
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
  // Refusals BEFORE any require of dist/ or any Cosmos client, so a missing
  // build cannot masquerade as a refusal.
  if (!MODES.includes(MODE)) {
    console.error(`FATAL: MODE is required and has no default -- one of ${MODES.join(" | ")}.`);
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const { moveCatalogRow, patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`repair-tiffany-rung-to-product  MODE=${MODE}  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing written"}`);
  console.log(`  ruling   ${REASON_LONG}`);
  console.log(`  scope    years=${YEARS.length ? YEARS.join(",") : "(all)"}  sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}  setKeys=${SETKEYS.length ? SETKEYS.join(",") : "(all)"}`);
  console.log(`  sharding ${SHARDED ? `ON -- slot ${SLOT}/${SLOTS}. THIS RUN COVERS 1/${SLOTS} OF THE POPULATION; dispatch every slot 0..${SLOTS - 1} or the sweep is partial.` : `OFF -- this run sweeps EVERY row${SLOTS_REQUESTED > 1 ? ` (slots=${rawSlots} is the runner's inherited default, not a chosen shard; pass SHARD=true with slot=0 to fan out)` : ""}`}`);
  console.log(`  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  the year, sport and setKey come off the SLUG, never cardYear (the 1991 topps-traded block has none).`);
  console.log("");

  // ── the sibling gate ──────────────────────────────────────────────────────
  //
  // A live count, cached per (sport, year, sibling). The gate is the reason
  // this lane is safe to run wide: a group whose Tiffany product does not
  // exist yet is reported and LEFT, so a Fleer rung -- the only row those
  // cards have -- can never be retired into nothing. Because it is a live
  // read and not a compiled list, acquiring a Fleer Tiffany checklist arms
  // those groups without touching this script.
  const siblingCache = new Map();
  async function siblingRows(sport, year, sibling) {
    const key = `${sport}:${year}:${sibling}`;
    if (siblingCache.has(key)) return siblingCache.get(key);
    const n = (await retry(() => cat.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p)",
      parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${sibling}:` }],
    }).fetchAll())).resources[0] ?? 0;
    siblingCache.set(key, n);
    return n;
  }

  /** Does the sibling product already hold THIS cardNumber? Decides retire
   *  (it does) vs convert (it does not). */
  const holdsCache = new Map();
  async function siblingHasCardNumber(sport, year, sibling, cardNumber) {
    const num = str(cardNumber).toLowerCase();
    if (!num) return false;
    const key = `${sport}:${year}:${sibling}:${num}`;
    if (holdsCache.has(key)) return holdsCache.get(key);
    const n = (await retry(() => cat.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p)",
      parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${sibling}:${num}:` }],
    }).fetchAll())).resources[0] ?? 0;
    holdsCache.set(key, n > 0);
    return n > 0;
  }

  const groups = new Map(); // per-group report lines
  function group(axes, sibling) {
    const key = `${axes.sport} ${axes.year} ${axes.setKey} -> ${sibling}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, sibling, sport: axes.sport, year: axes.year, setKey: axes.setKey, siblingRows: 0, rows: [], counts: {} };
      groups.set(key, g);
    }
    return g;
  }
  const bump = (g, k) => { g.counts[k] = (g.counts[k] ?? 0) + 1; };

  if (MODE === "catalog") return repairCatalog();
  return repairPool();

  // ── MODE=catalog ──────────────────────────────────────────────────────────
  async function repairCatalog() {
    const s = {
      scanned: 0, otherSlot: 0, retired: 0, converted: 0, folded: 0, gradedRetired: 0,
      noSibling: 0, outOfScope: 0, malformed: 0, noop: 0, failed: 0, notReached: 0,
    };
    let stopReason = null;

    await forEachPage(cat, {
      // The `parallel` FIELD is what makes a catalog row a rung. Selected in
      // the query so the scan reads only candidates.
      query: "SELECT * FROM c WHERE CONTAINS(LOWER(c.parallel), 'tiffany')",
      parameters: [],
    }, async (rows) => {
      const mine = rows.filter((r) => { if (mineByShard(r.id)) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map(async (d) => {
          const id = String(d.id);
          try {
            if (!isCatalogRung(d)) { s.noop++; return; }
            const axes = axesOf(id);
            if (!axes) { s.malformed++; return; }
            if (!inScope(axes)) { s.outOfScope++; return; }

            const sibling = siblingSetKeyFor(axes.setKey);
            if (!sibling) { s.malformed++; return; }
            const g = group(axes, sibling);

            // THE GATE. No sibling product at this (sport, year) -> report and
            // LEAVE. Acquire before retire: these rungs are the only rows the
            // cards have.
            const sibRows = await siblingRows(axes.sport, axes.year, sibling);
            g.siblingRows = sibRows;
            if (sibRows === 0) {
              s.noSibling++;
              bump(g, "LEFT: no sibling product");
              if (g.rows.length < 12) g.rows.push(`    LEFT (no ${sibling} at ${axes.year})  ${id}`);
              return;
            }

            const target = toSiblingSlug(id, sibling);
            if (!target || target === id) {
              // Already on the Tiffany product AND already blank-parallel in
              // the slug: only the redundant `parallel` FIELD is left.
              if (statesTiffany(d.parallel)) {
                const r = await patchCatalogRowFields(cat, id, d.cardId, {
                  parallel: "",
                  parallelBefore: str(d.parallel),
                  setKeyBefore: axes.setKey,
                  tiffanyRepairedAt: new Date().toISOString(),
                  tiffanyRepairedReason: REASON,
                }, { dryRun: !APPLY, retry, noShadow: true });
                if (r.action === "patch") { s.converted++; bump(g, "BLANKED redundant parallel"); if (g.rows.length < 12) g.rows.push(`    BLANK-PARALLEL  ${id}`); }
                else s.noop++;
              } else s.noop++;
              return;
            }

            // A GRADED CHILD IS RETIRED, NEVER MOVED. Its id carries a tier
            // segment, so it is not an identity slug and moveCatalogRow
            // refuses it. Graded rows are REGENERABLE from their parent by
            // materialize-graded-identities -- which is exactly why a move
            // retires a row's children rather than carrying them across. The
            // retire is the same MARKER as everywhere else here: never a
            // delete.
            const has = await siblingHasCardNumber(axes.sport, axes.year, sibling, axes.cardNumber);
            if (!isIdentitySlug(id)) {
              const r = await patchCatalogRowFields(cat, id, d.cardId, {
                retired: true,
                retiredReason: REASON,
                retiredAt: new Date().toISOString(),
                retiredIntoSetKey: sibling,
                setKeyBefore: axes.setKey,
                parallelBefore: str(d.parallel),
                retiredBecause: "graded child; regenerable from its parent",
              }, { dryRun: !APPLY, retry, noShadow: true });
              if (r.action === "patch") {
                s.gradedRetired++;
                bump(g, "RETIRED graded child (regenerable)");
                if (g.rows.length < 12) g.rows.push(`    RETIRE-GRADED  ${id}\n                   regenerable from its parent on ${sibling}`);
              } else s.noop++;
              return;
            }

            if (has) {
              // (a) RETIRE -- a MARKER, never a delete. The sibling already
              // holds this card, so the rung row is a duplicate identity; but
              // a sales-attested row is evidence a real sale happened, and the
              // census is explicit that these rows move rather than drop. The
              // pool lane re-keys the comps onto the sibling either way.
              const r = await patchCatalogRowFields(cat, id, d.cardId, {
                retired: true,
                retiredReason: REASON,
                retiredAt: new Date().toISOString(),
                retiredIntoSetKey: sibling,
                setKeyBefore: axes.setKey,
                parallelBefore: str(d.parallel),
              }, { dryRun: !APPLY, retry, noShadow: true });
              if (r.action === "patch") {
                s.retired++;
                bump(g, "RETIRED (sibling already has it)");
                if (g.rows.length < 12) g.rows.push(`    RETIRE  ${id}\n            -> already at ${target}`);
              } else s.noop++;
              return;
            }

            // (b) CONVERT -- the rung row BECOMES the sibling product row.
            // A move, so it goes through moveCatalogRow: copy first, re-point
            // this row's sales, retire the old slug's graded children, delete
            // last. `source` is deliberately NOT in changedFields -- the row
            // keeps its own provenance. A checklist-backed incumbent at the
            // target wins on authority and the rung folds onto it instead,
            // which is how "checklist-backed rows are never downgraded" is
            // enforced rather than asserted.
            const r = await moveCatalogRow(cat, d, target, {
              setKey: sibling,
              parallel: "",
              setKeyBefore: axes.setKey,
              parallelBefore: str(d.parallel),
              tiffanyRepairedAt: new Date().toISOString(),
              tiffanyRepairedReason: REASON,
            }, { reason: REASON_LONG, repointNormalizedSetKey: true, dryRun: !APPLY, salesContainer: pool, retry });

            if (r.action === "fold") { s.folded++; bump(g, "FOLDED onto the checklist row"); }
            else if (r.action === "noop") { s.noop++; }
            else { s.converted++; bump(g, "CONVERTED to the product row"); }
            if (g.rows.length < 12) g.rows.push(`    ${r.action.toUpperCase().padEnd(8)} ${id}\n            -> ${target}\n               ${r.decision}`);
          } catch (e) {
            s.failed++;
            if (s.failed <= 5) console.log(`  FAILED ${id.slice(0, 76)}: ${String(e?.message ?? e).slice(0, 120)}`);
          }
        }));
        const done = Math.min(i + CONCURRENCY, mine.length);
        if (LIMIT && (s.retired + s.converted + s.folded + s.gradedRetired) >= LIMIT) { stopReason = "limit"; s.notReached += mine.length - done; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; s.notReached += mine.length - done; break; }
      }
      return !stopReason;
    });

    printGroups();
    banner(stopReason);
    console.log(`  rows scanned (this slot)     ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  RETIRED (marker, never a delete) ${f(s.retired)}   <- the sibling already holds the card`);
    console.log(`  CONVERTED to the product     ${f(s.converted)}   <- setKey -> sibling, parallel -> blank`);
    console.log(`  FOLDED onto a checklist row  ${f(s.folded)}   <- the incumbent won on authority`);
    console.log(`  RETIRED graded children      ${f(s.gradedRetired)}   <- regenerable from the parent, never moved`);
    console.log(`  LEFT: no sibling product     ${f(s.noSibling)}   <- acquire before retire`);
    console.log(`  LEFT: out of dispatched scope ${f(s.outOfScope)}`);
    console.log(`  malformed slug (left)        ${f(s.malformed)}`);
    console.log(`  noop / already correct       ${f(s.noop)}`);
    console.log(`  failed                       ${f(s.failed)}`);
    reconcile("repair-tiffany-rung-to-product:catalog", s.scanned,
      s.retired + s.converted + s.folded + s.gradedRetired,
      s.noSibling + s.outOfScope + s.malformed + s.noop + s.notReached, s.failed);
  }

  // ── MODE=pool ─────────────────────────────────────────────────────────────
  async function repairPool() {
    const s = {
      scanned: 0, otherSlot: 0, rekeyed: 0, created: 0, deleted: 0, collapsed: 0,
      conflict: 0, noSibling: 0, outOfScope: 0, malformed: 0, notRung: 0,
      duplicatesLeft: 0, failed: 0, notReached: 0,
    };
    let stopReason = null;

    // BEFORE, so the arithmetic can be proven rather than asserted.
    const before = (await retry(() => pool.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(LOWER(c.parallel), 'tiffany') OR CONTAINS(c.hobbyiqCardId, ':tiffany:')",
      parameters: [],
    }).fetchAll())).resources[0] ?? 0;
    console.log(`  BEFORE  ${f(before)} pool rows keyed to a Tiffany rung (parallel field OR slug segment)`);
    console.log("");

    async function handle(row) {
      const id = String(row.id);
      if (!isPoolRung(row)) { s.notRung++; return; }
      const oldSlug = str(row.hobbyiqCardId);
      const axes = axesOf(oldSlug);
      if (!axes) { s.malformed++; return; }
      if (!inScope(axes)) { s.outOfScope++; return; }

      const sibling = siblingSetKeyFor(axes.setKey);
      if (!sibling) { s.malformed++; return; }
      const g = group(axes, sibling);

      const sibRows = await siblingRows(axes.sport, axes.year, sibling);
      g.siblingRows = sibRows;
      if (sibRows === 0) {
        s.noSibling++;
        bump(g, "LEFT: no sibling product");
        if (g.rows.length < 12) g.rows.push(`    LEFT (no ${sibling} at ${axes.year})  ${id.slice(0, 80)}`);
        return;
      }

      // THE TITLE GUARD. The row's OWN title has to say Tiffany. Measured
      // 2026-09-04: 93 of the 2,198 rows in scope carry a `:tiffany:` slug
      // with `title: "... #450 Base"` and `parallel: "Base"` -- base cards
      // wearing a Tiffany identity. Moving one carries a BASE sale into the
      // Tiffany pool: the same split-pool defect this lane closes, pointed
      // the other way. Report it; never write it.
      if (!statesTiffany(row.title)) {
        s.conflict++;
        bump(g, "CONFLICT: title does not state Tiffany");
        if (g.rows.length < 12) g.rows.push(`    CONFLICT  ${id.slice(0, 70)}\n              title: ${str(row.title).slice(0, 88)}\n              parallel: ${str(row.parallel)} -- reported, never written`);
        return;
      }

      const target = toSiblingSlug(oldSlug, sibling);
      if (!target || target === oldSlug) { s.notRung++; return; }

      const keep = stripSystem(row);
      // A vendor partition key is kept so a CH/eBay lookup still resolves by
      // it (CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW).
      const oldPk = str(row.cardId);
      if (oldPk && oldPk !== oldSlug && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
      // BOTH fields move. The pool reader ORs cardId and hobbyiqCardId, so a
      // row that moved only one of them prices two cards at once
      // (CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS).
      keep.cardId = target;
      keep.hobbyiqCardId = target;
      keep.setKey = sibling;
      keep.normalizedSetKey = sibling;
      keep.parallel = "";           // Tiffany is the PRODUCT; the parallel is blank.
      keep.parallelBefore = str(row.parallel);
      keep.setKeyBefore = axes.setKey;
      keep.rekeyedFrom = oldSlug;
      keep.rekeyedAt = new Date().toISOString();
      keep.rekeyedReason = REASON;
      // THE HASH FOLLOWS THE ADDRESS: cardId is contentHash's first component,
      // so a moved row keeping the old hash is invisible to the store's
      // partition-scoped pre-write dedup and every re-emit duplicates it.
      keep.contentHash = contentHashOf(keep);

      if (g.rows.length < 12) {
        g.rows.push(`    REKEY  ${oldSlug.slice(0, 74)}\n           -> ${target.slice(0, 74)}\n              ${str(row.title).slice(0, 88)}`);
      }

      const res = await relocateSoldComp(pool, {
        keep,
        drop: [{ id: row.id, cardId: row.cardId }],
        retry,
        // VERIFY BY READ, on BOTH identity fields -- the write is not believed
        // until the row is read back at its new address carrying both.
        verifyFields: ["cardId", "hobbyiqCardId", "setKey", "parallel", "contentHash", "rekeyedFrom"],
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
        if (res.existedBefore) s.collapsed++;
      }
      s.rekeyed++;
      bump(g, "REKEYED onto the product");
    }

    await forEachPage(pool, {
      // SELECT * and not a projection: this document is UPSERT-ed at the new
      // address, so a projection would silently drop every field it omitted.
      // BOTH spellings of "keyed to a rung" -- neither set contains the other.
      query: "SELECT * FROM c WHERE CONTAINS(LOWER(c.parallel), 'tiffany') OR CONTAINS(c.hobbyiqCardId, ':tiffany:')",
      parameters: [],
    }, async (rows) => {
      // Shard on the row's own id: the partition key is a legacy vendor id for
      // much of this population and thousands of rows share one, so sharding
      // on it would pile them into a single slot.
      const mine = rows.filter((r) => { if (mineByShard(r.id)) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map((r) => handle(r).catch((e) => {
          s.failed++;
          if (s.failed <= 5) console.log(`  FAILED ${String(r.id).slice(0, 70)}: ${String(e?.message ?? e).slice(0, 120)}`);
        })));
        const done = Math.min(i + CONCURRENCY, mine.length);
        if (LIMIT && s.rekeyed >= LIMIT) { stopReason = "limit"; s.notReached += mine.length - done; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; s.notReached += mine.length - done; break; }
      }
      return !stopReason;
    }, 400);

    printGroups();
    banner(stopReason);
    console.log(`  rows scanned (this slot)     ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
    console.log(`  REKEYED onto the product     ${f(s.rekeyed)}   <- cardId AND hobbyiqCardId, verified by read`);
    console.log(`  new rows created             ${f(s.created)}`);
    console.log(`  old rows deleted             ${f(s.deleted)}`);
    console.log(`  collapsed onto an existing   ${f(s.collapsed)}   <- the target address already held this sale`);
    console.log(`  CONFLICT: title silent on Tiffany ${f(s.conflict)}   <- report-only, never written`);
    console.log(`  LEFT: no sibling product     ${f(s.noSibling)}   <- acquire before retire`);
    console.log(`  LEFT: out of dispatched scope ${f(s.outOfScope)}`);
    console.log(`  not a rung row / malformed   ${f(s.notRung + s.malformed)}`);
    console.log(`  duplicates LEFT in the pool  ${f(s.duplicatesLeft)}   <- a delete that failed; never a lost sale`);
    console.log(`  failed                       ${f(s.failed)}`);

    // AFTER + the arithmetic. A report predicts; an apply proves.
    const after = (await retry(() => pool.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(LOWER(c.parallel), 'tiffany') OR CONTAINS(c.hobbyiqCardId, ':tiffany:')",
      parameters: [],
    }).fetchAll())).resources[0] ?? 0;
    const expect = APPLY ? before - s.deleted : before;
    console.log("");
    console.log(`  AFTER   ${f(after)} rows (before ${f(before)}${APPLY ? `, expected ${f(expect)}` : ", report-only: unchanged expected"})`);
    if (after !== expect) console.log(`    NOTE differs from the expectation by ${f(after - expect)} -- other slots, the CONFLICT rows that stay, or a concurrent writer.`);

    reconcile("repair-tiffany-rung-to-product:pool", s.scanned, s.rekeyed,
      s.conflict + s.noSibling + s.outOfScope + s.notRung + s.malformed + s.notReached, s.failed);
  }

  // ── shared reporting ──────────────────────────────────────────────────────

  /** THE REPORT IS THE POINT. Per group: the sibling and whether it exists,
   *  the verdict counts, and the exact rows -- a report nobody can quote is
   *  not a report. */
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
      const gate = g.siblingRows > 0 ? `sibling ${g.sibling} has ${f(g.siblingRows)} rows` : `sibling ${g.sibling} ABSENT -- acquire before retire`;
      console.log(`\n  ${g.key}   ${f(total)} row(s)   [${gate}]`);
      for (const [k, n] of Object.entries(g.counts).sort((a, b) => b[1] - a[1])) console.log(`      ${String(f(n)).padStart(6)}  ${k}`);
      for (const line of g.rows) console.log(line);
    }
    console.log("");
  }

  function banner(stopReason) {
    if (stopReason === "budget") {
      // The exact marker the runner's relaunch step greps for
      // (CF-RELAUNCH-ONLY-ON-BUDGET). A report relaunches as a report.
      console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
    } else if (stopReason === "limit") {
      console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
    }
    console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  }

  /** reportWrites sets a non-zero exit code when the arithmetic does not close
   *  (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW), so it is armed only on an apply; a
   *  report still PRINTS the same line. */
  function reconcile(job, intended, written, skipped, failed) {
    console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)}${failed ? ` + failed ${f(failed)}` : ""}`);
    if (APPLY) reportWrites({ job, intended, written, skipped, failed });
  }
}

module.exports = {
  statesTiffany, siblingSetKeyFor, slugParts, isIdentitySlug, axesOf, toSiblingSlug,
  inScope, isCatalogRung, isPoolRung, REASON,
  // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: exported so the pins can
  // assert the opt-in directly under the runner's own env.
  SHARDED, SLOT, SLOTS, SHARD_OPT_IN,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
