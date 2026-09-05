#!/usr/bin/env node
/**
 * report-ch-product-label-catalog-aliases.cjs -- the CATALOG half of the
 * Figueroa Red Ink split. REPORT ONLY, always: this file has no write path.
 *
 * CF-RED-INK-IS-THE-BW-SHIMMER-SSP (Drew, 2026-08-30): "Red Ink IS the B&W
 * Shimmer SSP -- distinct card, ONE row."
 * CF-ONE-CARD-ONE-ROW-ONE-POOL: a duplicate row is a split pool is a wrong FMV.
 *
 * ── WHAT IS SPLIT ───────────────────────────────────────────────────────────
 *
 * `hiq:baseball:2026:bowman-chrome:cpa-vf` carries THREE rows for what Drew has
 * ruled is ONE card (read live 2026-09-04):
 *
 *   THE CHECKLIST ROW -- the survivor
 *     ...:black-white-shimmer-refractor:auto:num-15
 *     source checklistcenter-2026-08-29, printRun 15, parallel
 *     "Black & White Shimmer Refractor"
 *
 *   THE USER-VERIFIED STRAY -- where Drew's holding and his $270 sale sit
 *     ...:black-white-red-ink-refractor:auto
 *     source user-verified, printRun NULL, parallel "Black White Red Ink Refractor"
 *
 *   THE THIRD STRAY
 *     ...:black-white-shimmer:auto
 *     source checklist, printRun NULL, parallel "Black & White Shimmer"
 *
 * The checklist row is the only one carrying the print run. So the holding
 * prices against a row that does not know the card is /15, and the $270 sale
 * pools separately from any sale that landed on either sibling.
 *
 * ── WHY THIS IS A REPORT AND NOT A WRITE ────────────────────────────────────
 *
 * Two reasons, both blocking, and both are the finding rather than an excuse:
 *
 * 1. `supersededBy` IS WRITTEN BUT NEVER READ. It is set by
 *    dedupe-catalog-rows.cjs, and that script's own banner claims "search and
 *    matching filter on it while the row remains". Grepped across backend/src
 *    on 2026-09-04: NOTHING in the service layer reads `supersededBy` -- not
 *    catalogSearch, not catalogMatcher, not catalogVisibility. Marking these
 *    two rows superseded would therefore change NO pricing and NO search
 *    result; it would only look like it had. Shipping a write whose effect is
 *    zero, under a name that suggests otherwise, is worse than shipping
 *    nothing.
 *
 * 2. ONE of the two strays is USER-VERIFIED. `...:black-white-red-ink-
 *    refractor:auto` carries source `user-verified` -- Drew's own confirm --
 *    and a ruled or user row is REPORT-ONLY FOREVER under the GREAT REMATCH
 *    program. A fleet does not overwrite a human's ruling; it reports the
 *    collision and lets the human settle it.
 *
 * So this prints the plan and the numbers. The write, if Drew wants it, is a
 * separate authorised step -- and it needs the reader half built first, or it
 * is decoration.
 *
 * Env: COSMOS_CONNECTION_STRING required. No apply, no mode, no scope.
 */
"use strict";

const path = require("path");
const str = (v) => String(v ?? "").trim();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

const STEM = "hiq:baseball:2026:bowman-chrome:cpa-vf";
const SURVIVOR = `${STEM}:black-white-shimmer-refractor:auto:num-15`;
const ALIASES = [
  `${STEM}:black-white-red-ink-refractor:auto`,
  `${STEM}:black-white-shimmer:auto`,
];

const retry = async (fn, tries = 6) => {
  let wait = 400;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 8000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  console.log("");
  console.log("=".repeat(78));
  console.log("  CATALOG ALIAS PLAN: one card, three rows (CPA-VF Red Ink / B&W Shimmer)");
  console.log("  REPORT ONLY -- this script has no write path.");
  console.log("=".repeat(78));

  const { CosmosClient } = require("@azure/cosmos");
  const db = new CosmosClient(conn).database("hobbyiq");
  const catalog = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const readRow = async (id) => {
    try { return (await retry(() => catalog.item(id, id).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  };

  // Pool rows are counted on BOTH keys, because exactPoolReader ORs them and a
  // count on one key is not the pool.
  const poolCount = async (slug) => {
    const q = {
      query: "SELECT VALUE COUNT(1) FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
      parameters: [{ name: "@d", value: slug }],
    };
    return (await retry(() => pool.items.query(q).fetchAll())).resources[0] ?? 0;
  };
  const poolPrices = async (slug) => {
    const q = {
      query: "SELECT c.price, c.source, c.title FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
      parameters: [{ name: "@d", value: slug }],
    };
    return (await retry(() => pool.items.query(q, { maxItemCount: -1 }).fetchAll())).resources ?? [];
  };

  const show = async (id, role) => {
    const r = await readRow(id);
    const n = await poolCount(id);
    console.log("");
    console.log(`  ${role}`);
    console.log(`    id          ${id}`);
    if (!r) { console.log("    (NO CATALOG ROW)"); return { id, row: null, poolRows: n }; }
    console.log(`    source      ${str(r.source) || "(none)"}`);
    console.log(`    parallel    ${JSON.stringify(r.parallel ?? null)}`);
    console.log(`    printRun    ${r.printRun ?? "null"}`);
    console.log(`    supersededBy ${r.supersededBy ?? "(unset)"}`);
    console.log(`    pool rows   ${f(n)}   (counted on BOTH cardId and hobbyiqCardId)`);
    return { id, row: r, poolRows: n };
  };

  const survivor = await show(SURVIVOR, "SURVIVOR -- the checklist row, the only one carrying the print run");
  const strays = [];
  strays.push(await show(ALIASES[0], "STRAY 1 -- user-verified; Drew's holding and his $270 sale live here"));
  strays.push(await show(ALIASES[1], "STRAY 2 -- source `checklist`, print run absent"));

  // The pricing damage, stated as prices rather than as a claim.
  console.log("");
  console.log("  THE POOLS AS THEY STAND");
  for (const id of [SURVIVOR, ...ALIASES]) {
    const rows = await poolPrices(id);
    const prices = rows.map((r) => Number(r.price)).filter(Number.isFinite).sort((a, b) => a - b);
    const med = prices.length ? (prices.length % 2 ? prices[prices.length >> 1]
      : Math.round(((prices[(prices.length >> 1) - 1] + prices[prices.length >> 1]) / 2) * 100) / 100) : null;
    const bySource = {};
    for (const r of rows) bySource[str(r.source) || "?"] = (bySource[str(r.source) || "?"] ?? 0) + 1;
    console.log(`    ${id}`);
    console.log(`      ${f(rows.length)} rows, median $${med ?? "-"}, range $${prices[0] ?? "-"}..$${prices[prices.length - 1] ?? "-"}`);
    console.log(`      by source: ${JSON.stringify(bySource)}`);
  }

  console.log("");
  console.log("-".repeat(78));
  console.log("  THE PLAN (nothing below has been written)");
  console.log("");
  console.log(`  Survivor:  ${SURVIVOR}`);
  console.log("             checklistcenter-2026-08-29, printRun 15 -- the identity to price against.");
  console.log("");
  console.log("  Alias:     each stray gets  supersededBy = <survivor>  via patchCatalogRowFields");
  console.log("             (NEVER a raw patch -- CF-DERIVE-BUILDS-ITS-OWN-SEARCH-FIELDS, #1614),");
  console.log("             and NEITHER ROW IS DELETED.");
  console.log("");
  console.log("  BLOCKER 1  `supersededBy` is written by dedupe-catalog-rows.cjs and read by");
  console.log("             NOTHING in backend/src -- not catalogSearch, not catalogMatcher, not");
  console.log("             catalogVisibility (grepped 2026-09-04). Writing it today changes no");
  console.log("             price and no search result. The READER half has to ship first, or the");
  console.log("             alias is decoration wearing the name of a fix.");
  console.log("");
  console.log("  BLOCKER 2  the Red Ink row is `user-verified` -- Drew's own confirm. A ruled or");
  console.log("             user row is REPORT-ONLY FOREVER under the GREAT REMATCH program. This");
  console.log("             one goes to Drew by name, never to a fleet.");
  console.log("");
  console.log("  THE HOLDING, AFTER");
  console.log(`    from  ${ALIASES[0]}   (printRun null)`);
  console.log(`    to    ${SURVIVOR}   (printRun 15)`);
  console.log("    The lane that moves it is recheck-holding-identity.ts with APPLY=true --");
  console.log("    the existing re-derive path, not a new one. It is NOT dispatched here.");
  console.log("");
  console.log(`  Pool rows that would follow the holding: ${f(strays[0].poolRows)} on the Red Ink slug,`);
  console.log(`  ${f(strays[1].poolRows)} on the bare-shimmer slug, joining ${f(survivor.poolRows)} already on the checklist row.`);
  console.log("");
}

main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
