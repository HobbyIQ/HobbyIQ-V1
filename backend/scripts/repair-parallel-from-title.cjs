#!/usr/bin/env node
/**
 * repair-parallel-from-title.cjs -- a pool row's parallel must be something its
 * title says. Where a vendor product tag was stamped over a silent title, the
 * title decides again.
 *
 * CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG (Drew, 2026-08-29: "Bases are tagged to
 * this gold or the gold is tagged to bases" -- holding ca7a150b, 2026 Bowman
 * Chrome CPA-MG Marconi German Gold Refractor /50). Under that gold slug, 38
 * of the 40 latest rows were CardHedge base autos at $5-12 whose titles never
 * said gold: persistVendorSalesToPool let `identity.parallel` (the vendor's
 * PRODUCT tag) override the title parse, and the long-form rule then folded
 * `:gold:` into `:gold-refractor:`. Measured pool-wide (exact): CardHedge Gold
 * 226 / Blue 161 / Blue Refractor 467 / Black 132 / Silver 551 ...; TCA-eBay
 * colour refractors 1-3% each. The "Refractor"-stamped-title-silent bucket
 * (CH 163k, TCA 38k) is a DIFFERENT question (CH's variant vs our composed
 * "Base" suffix) and is NOT in scope here.
 *
 * MODES (the runner's `mode` input; the runner ALSO exports SCOPE=refractor by
 * default for other scripts, so SCOPE is not the switch):
 *
 *   colours   (default) for each (source, colour parallel), every row whose
 *             title does not contain the colour word is re-parsed; the parsed
 *             parallel (or Base) replaces the stamped one.
 *   refractor the "Refractor"-stamped, title-silent bucket. Settled by price
 *             (2026-08-29): under 2025 Bowman Chrome CPA-EP :refractor:auto,
 *             CardHedge rows whose title never says "refractor" sell at a
 *             $60.95 median (n=695) while the ones that do say it sell at $140
 *             (n=67); the true base pool sits at $47. A silent title is the
 *             base auto.
 *   variation D22 (Drew, 2026-08-30: "image variations are typical in card
 *             sets"). Rows stamped Base whose TITLE names a variation ("Image
 *             Variation", "Photo Var", "Var", "SSP", "SP-Chrome", a named kind)
 *             are re-keyed to the variation's slug -- the base card's number,
 *             the variation finish -- through the one vocabulary
 *             (variationVocabulary.ts). A bare marker ("SP", "SSP", "IV", "Short
 *             Print") moves a row only when the product's checklist holds an
 *             image variation for that card; otherwise it is counted
 *             `variationUnmatched` and left. Measured 2026-08-30: 8,937 of
 *             443,988 base-slug rows across 15 products carry a token (2.0%).
 *   product   D22. Rows whose title names a PRODUCT QUALIFIER the slug's setKey
 *             lacks -- "1st Edition", "Sapphire", "Chrome" (paper vs chrome
 *             Bowman), "Update" -- are re-keyed to the qualified setKey's slug
 *             WHEN that catalog row exists (productQualifiers.ts); otherwise
 *             they are marked `productQualifierUnmatched` (an acquisition
 *             list) and left. bowman <-> bowman-chrome and Topps Chrome Update
 *             are REFUSED (rulings, counted, never moved). Fixture: holding
 *             3fe98abe's only pool row, "2020 Bowman Draft 1st Edition - Bobby
 *             Witt Jr #BD-152 (RC)", $4, filed under the plain Draft slug.
 *
 * Every mode: report-only by default; sharded (SLOT/SLOTS on the row id); the
 * budget marker for the runner's relaunch; reportWrites at the end; LIMIT for a
 * bounded dry run (a LIMIT stop is NOT a budget stop and does not relaunch).
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY=true to write (default report only);
 *      MODE=colours|refractor|variation|product; SOURCES=cardhedge,tca-ebay,cardsight;
 *      SLOT/SLOTS (hash shards); RUN_MINUTES=140 (budget marker); LIMIT=0.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { parseListingTitle } = require(path.join(backend, "dist", "services", "portfolioiq", "ebayTitleParser.service.js"));
const { computeHobbyIqCardId, parseHobbyIqCardId } = require(path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));
const { canonicalize, catalogSlugIfExists, variationParallelsForCard } = require(path.join(backend, "dist", "services", "catalog", "catalogMatcher.service.js"));
const { canonicalVariationName, pickVariationForMarker, readVariationFromTitle, reduceVariationStockToCatalog, variationNameFromSlug } = require(path.join(backend, "dist", "services", "catalog", "variationVocabulary.js"));
const { PRODUCT_QUALIFIERS, qualifiedSetKeyFromTitle, setKeyOfSlug, withSetKey } = require(path.join(backend, "dist", "services", "catalog", "productQualifiers.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));

const APPLY = process.env.APPLY === "true" || process.env.BACKFILL_APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const SOURCES = String(process.env.SOURCES || "cardhedge,tca-ebay,cardsight").split(",").map((s) => s.trim()).filter(Boolean);
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 1);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const LIMIT = Number(process.env.LIMIT || 0);
const MODE = String(process.env.MODE || "colours").toLowerCase();
if (!["colours", "colors", "refractor", "variation", "product"].includes(MODE)) { console.error(`FATAL: MODE=${MODE} is not colours|refractor|variation|product`); process.exit(2); }
const REFRACTOR_ONLY = ["Refractor"];
const COLOURS = ["Gold", "Gold Refractor", "Blue", "Blue Refractor", "Green", "Green Refractor", "Orange", "Orange Refractor", "Red", "Red Refractor", "Purple", "Purple Refractor", "Black", "Black Refractor", "Sapphire", "Silver", "Pink", "Pink Refractor", "Yellow", "Yellow Refractor", "Aqua", "Aqua Refractor"];
const BARE_COLOURS = new Set(["gold", "blue", "green", "orange", "red", "purple", "black", "silver", "pink", "yellow", "aqua", "sapphire"]);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** The parallel the title itself names, in the pool's spelling. Null when the
 *  parser sees no finish -- that is Base. */
function titleParallel(title) {
  const p = parseListingTitle(title);
  const par = p && p.parallel ? String(p.parallel).trim() : "";
  return par && !/^base$/i.test(par) ? par : null;
}

/** Cosmos CONTAINS is a substring test; every token the vocabulary reads is
 *  covered by one of these, and the parser decides after. */
const VARIATION_TITLE_FILTER = ["variation", " var ", " var #", "ssp", " sp ", " sp-", "sp-chrome", "short print", " iv ", " iv#", "photo var", "image var"]
  .map((w, i) => `CONTAINS(LOWER(c.title), @v${i})`).join(" OR ");
const VARIATION_TITLE_PARAMS = ["variation", " var ", " var #", "ssp", " sp ", " sp-", "sp-chrome", "short print", " iv ", " iv#", "photo var", "image var"]
  .map((w, i) => ({ name: `@v${i}`, value: w }));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const pool = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq").container("sold_comps");
  console.log(`repair-parallel-from-title  ${APPLY ? "APPLY" : "REPORT ONLY"}  mode=${MODE}  sources=${SOURCES.join(",")}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  const stats = {
    scanned: 0, otherShard: 0, repaired: 0, toBase: 0, toOther: 0, kept: 0, keptRefinement: 0, failed: 0, noSlug: 0, resolvedByMatcher: 0,
    // variation
    variationFromTitle: 0, variationFromMarker: 0, variationUnmatched: 0, variationStockReduced: 0,
    // product
    productQualifierMatched: 0, productQualifierUnmatched: 0, productQualifierRefused: 0, marked: 0,
  };
  const moves = new Map(); // "source|from>to" -> n
  const examples = [];
  const unmatchedExamples = [];
  let stopReason = null;
  let mine = 0; // rows this slot examined (LIMIT counts these)
  const variationRowsByCard = new Map();
  const targetExists = new Map();

  const patch = async (r, ops, reason) => {
    if (!APPLY) return true;
    try {
      await retry(() => pool.item(r.id, r.cardId).patch([...ops, { op: "set", path: "/reslugedAt", value: new Date().toISOString() }, { op: "set", path: "/reslugedReason", value: reason }]));
      return true;
    } catch (e) { stats.failed++; if (stats.failed <= 3) console.log("  patch failed " + r.id + ": " + String(e.message).slice(0, 80)); return false; }
  };
  const rekey = async (r, source, slug, newSlug, newParallel, reason, extra = []) => {
    const key = `${source}|${r.parallel ?? "(none)"}>${newParallel}`;
    moves.set(key, (moves.get(key) || 0) + 1);
    if (examples.length < 25) examples.push(`  ${source}  ${r.parallel ?? "(none)"} -> ${newParallel}  ${slug} -> ${newSlug}  $${r.price}  "${String(r.title ?? "").slice(0, 80)}"`);
    if (newParallel === "Base") stats.toBase++; else stats.toOther++;
    const ok = await patch(r, [
      { op: "set", path: "/parallel", value: newParallel },
      { op: "set", path: "/hobbyiqCardId", value: newSlug },
      { op: "set", path: "/reslugedFrom", value: slug },
      ...extra,
    ], reason);
    if (ok) stats.repaired++;
  };
  const budgetOrLimit = () => {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; return true; }
    if (LIMIT && mine >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)} (a dry-run bound, not a budget stop)`; return true; }
    return false;
  };
  const scan = async function* (q) {
    const it = pool.items.query(q, { maxItemCount: 500 });
    while (it.hasMoreResults()) {
      if (budgetOrLimit()) return;
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        stats.scanned++;
        if (SLOTS > 1 && shardOf(r.id) !== SLOT) { stats.otherShard++; continue; }
        mine++;
        yield r;
        if (LIMIT && mine >= LIMIT) { budgetOrLimit(); return; }
      }
    }
  };
  const variationSlugsFor = async (comp) => {
    const key = `${comp.sport}|${comp.year}|${comp.setKey}|${String(comp.cardNumber).toUpperCase()}`;
    let slugs = variationRowsByCard.get(key);
    if (!slugs) {
      try { slugs = await retry(() => variationParallelsForCard({ sport: comp.sport, year: Number(comp.year), setKey: String(comp.setKey), cardNumber: String(comp.cardNumber) })); } catch { slugs = []; }
      variationRowsByCard.set(key, slugs);
    }
    return slugs;
  };
  /** A named finish is resolved through the matcher (Colour ≡ Refractor, long
   *  form, the product's own ladder); Base needs no resolving. Not found ->
   *  the computed slug, as before. */
  const resolveSlug = async (comp, newParallel) => {
    let newSlug;
    try { newSlug = computeHobbyIqCardId({ ...comp, parallel: newParallel }); } catch { return null; }
    if (newParallel !== "Base") {
      try {
        const r = await retry(() => canonicalize({ sport: comp.sport, year: Number(comp.year), setName: String(comp.setKey), cardNumber: String(comp.cardNumber), parallel: newParallel, isAuto: Boolean(comp.isAuto), printRun: comp.printRun ?? null, player: null, source: "harness" }));
        if (r && r.found && typeof r.slug === "string" && r.slug.startsWith("hiq:")) { if (r.slug !== newSlug) stats.resolvedByMatcher++; newSlug = r.slug; }
      } catch { /* keep the computed slug */ }
    }
    return newSlug;
  };

  outer:
  for (const source of SOURCES) {
    if (MODE === "variation") {
      const q = { query: `SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price FROM c WHERE c.source = @s AND (NOT IS_DEFINED(c.parallel) OR c.parallel = 'Base' OR c.parallel = '') AND (${VARIATION_TITLE_FILTER})`, parameters: [{ name: "@s", value: source }, ...VARIATION_TITLE_PARAMS] };
      for await (const r of scan(q)) {
        const slug = String(r.hobbyiqCardId ?? "");
        const comp = slug.startsWith("hiq:") ? parseHobbyIqCardId(slug) : null;
        if (!comp) { stats.noSlug++; continue; }
        const read = readVariationFromTitle(String(r.title ?? "").toLowerCase());
        let newParallel = null, how = null;
        if (read.finish) {
          // the parser composes the finish beside it ("Image Variation Gold Speckle Refractor")
          newParallel = titleParallel(r.title) ?? read.finish;
          if (!canonicalVariationName(newParallel)) newParallel = read.finish;
          how = "title";
          if (read.stock) {
            const reduced = reduceVariationStockToCatalog(newParallel, await variationSlugsFor(comp));
            if (reduced && reduced !== newParallel) { newParallel = reduced; stats.variationStockReduced++; }
          }
        } else if (read.marker) {
          const pick = pickVariationForMarker(read.marker, await variationSlugsFor(comp));
          const name = pick ? variationNameFromSlug(pick) : null;
          if (name) { newParallel = name; how = "marker"; }
          else { stats.variationUnmatched++; if (unmatchedExamples.length < 12) unmatchedExamples.push(`  ${source}  marker=${read.marker}  ${slug}  $${r.price}  "${String(r.title ?? "").slice(0, 80)}"`); continue; }
        } else { stats.kept++; continue; }
        const newSlug = await resolveSlug(comp, newParallel);
        if (!newSlug || !newSlug.startsWith("hiq:") || newSlug === slug) { stats.kept++; continue; }
        if (how === "title") stats.variationFromTitle++; else stats.variationFromMarker++;
        await rekey(r, source, slug, newSlug, newParallel, `the title names a variation — a different card under the same number (CF-A-VARIATION-IS-A-CARD, ${how})`);
        if (stopReason) break outer;
      }
      if (stopReason) break outer;
      continue;
    }
    if (MODE === "product") {
      for (const rule of PRODUCT_QUALIFIERS) {
        const words = rule.qualifier === "1st Edition" ? ["1st edition", "first edition"] : [rule.qualifier.toLowerCase()];
        const froms = [...new Set([...Object.keys(rule.moves), ...Object.keys(rule.refuse ?? {})])];
        for (const from of froms) {
          for (const word of words) {
            const q = { query: "SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price FROM c WHERE c.source = @s AND CONTAINS(LOWER(c.title), @w) AND CONTAINS(c.hobbyiqCardId, @seg)", parameters: [{ name: "@s", value: source }, { name: "@w", value: word }, { name: "@seg", value: `:${from}:` }] };
            for await (const r of scan(q)) {
              const slug = String(r.hobbyiqCardId ?? "");
              const from0 = setKeyOfSlug(slug);
              if (!from0) { stats.noSlug++; continue; }
              const d = qualifiedSetKeyFromTitle(from0, r.title);
              if (!d.applied.length) {
                if (d.refused.length) { stats.productQualifierRefused++; if (unmatchedExamples.length < 12) unmatchedExamples.push(`  ${source}  REFUSED ${d.refused.map((x) => x.qualifier).join("+")}  ${slug}  "${String(r.title ?? "").slice(0, 70)}"`); }
                else stats.kept++;
                continue;
              }
              const target = withSetKey(slug, d.setKey);
              let exists = targetExists.get(target);
              if (exists === undefined) { try { exists = await retry(() => catalogSlugIfExists(target)); } catch { exists = null; } targetExists.set(target, exists); }
              if (!exists) {
                stats.productQualifierUnmatched++;
                if (unmatchedExamples.length < 12) unmatchedExamples.push(`  ${source}  UNMATCHED ${d.applied.join("+")}  ${slug} -> ${target} (no catalog row)  $${r.price}  "${String(r.title ?? "").slice(0, 70)}"`);
                // the acquisition list: the row is marked, never moved
                if (await patch(r, [{ op: "set", path: "/productQualifierUnmatched", value: target }], `the title names ${d.applied.join("+")} and the catalog holds no ${d.setKey} row for this card (CF-A-PRODUCT-QUALIFIER-IS-IDENTITY)`)) stats.marked += APPLY ? 1 : 0;
                continue;
              }
              stats.productQualifierMatched++;
              await rekey(r, source, slug, exists, r.parallel ?? "Base", `the title names ${d.applied.join("+")} — another product (CF-A-PRODUCT-QUALIFIER-IS-IDENTITY)`, [{ op: "set", path: "/productQualifier", value: d.applied.join("+") }]);
              if (stopReason) break outer;
            }
            if (stopReason) break outer;
          }
        }
      }
      continue;
    }
    // colours / refractor
    for (const par of (MODE === "refractor" ? REFRACTOR_ONLY : COLOURS)) {
      const word = par.split(" ")[0].toLowerCase();
      const q = { query: "SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price FROM c WHERE c.source = @s AND c.parallel = @p AND NOT CONTAINS(LOWER(c.title), @w)", parameters: [{ name: "@s", value: source }, { name: "@p", value: par }, { name: "@w", value: word }] };
      for await (const r of scan(q)) {
        const slug = String(r.hobbyiqCardId ?? "");
        const comp = slug.startsWith("hiq:") ? parseHobbyIqCardId(slug) : null;
        if (!comp) { stats.noSlug++; continue; }
        const fromTitle = titleParallel(r.title);
        // the title must actually corroborate what it names, or we would be
        // trading one uncorroborated stamp for another (a variation finish is
        // corroborated by the vocabulary's own read of the title)
        const titleWord = fromTitle ? fromTitle.split(" ")[0].toLowerCase() : null;
        if (titleWord && !String(r.title ?? "").toLowerCase().includes(titleWord) && !canonicalVariationName(fromTitle)) { stats.kept++; continue; }
        const newParallel = fromTitle ?? "Base";
        const oldLower = String(r.parallel ?? "").toLowerCase(), newLower = newParallel.toLowerCase();
        if (newLower === oldLower) { stats.kept++; continue; }
        // CF-A-REFINEMENT-IS-NOT-A-CONTRADICTION (dry run #1: 199 "Blue
        // Refractor" -> "Refractor", 196 "Gold Refractor" -> "Refractor"). A
        // title that says "Refractor /150" and a vendor tag "Blue Refractor"
        // agree -- the colour refines the family the title names; moving the
        // row to a bare refractor:num-150 would mint a rung no checklist has.
        // Only a title that names NO finish, or a DIFFERENT one, overrules.
        if (fromTitle && oldLower.endsWith(" " + newLower)) { stats.keptRefinement++; continue; }
        // the short form of the same refinement: a bare colour IS "<Colour>
        // Refractor" (project_colour_equals_refractor_ruling), so "Blue" vs a
        // title saying "Refractor" agrees too (dry run #2: 92 rows)
        if (fromTitle && newLower === "refractor" && BARE_COLOURS.has(oldLower)) { stats.keptRefinement++; continue; }
        const newSlug = await resolveSlug(comp, newParallel);
        if (!newSlug || !newSlug.startsWith("hiq:") || newSlug === slug) { stats.kept++; continue; }
        await rekey(r, source, slug, newSlug, newParallel, "title outranks the vendor parallel tag (CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG)");
        if (stopReason) break outer;
      }
      if (stopReason) break outer;
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned           ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  ${APPLY ? "REPAIRED" : "WOULD REPAIR"}           ${f(stats.repaired)}   <- to Base ${f(stats.toBase)}, to another named finish ${f(stats.toOther)}`);
  console.log(`  kept                   ${f(stats.kept)}   <- title names the same finish, or names one it does not contain`);
  console.log(`  kept, refinement       ${f(stats.keptRefinement)}   <- the title names the family the vendor colour refines (Refractor /150 vs Blue Refractor)`);
  console.log(`  resolved by matcher    ${f(stats.resolvedByMatcher)}   <- a named finish landed on the checklist spelling, not the computed slug`);
  if (MODE === "variation") {
    console.log(`  variation: from title  ${f(stats.variationFromTitle)}   <- the title names the variation ("Image Variation", "Var", "SSP", "SP-Chrome", a kind)`);
    console.log(`  variation: from marker ${f(stats.variationFromMarker)}   <- a bare SP / SSP / IV / Short Print the product's checklist corroborated`);
    console.log(`  variation: unmatched   ${f(stats.variationUnmatched)}   <- a bare marker with no image variation on the checklist for that card — left`);
    console.log(`  variation: stock reduced ${f(stats.variationStockReduced)} <- a label's chrome/paper word the checklist does not distinguish`);
  }
  if (MODE === "product") {
    console.log(`  product: re-keyed      ${f(stats.productQualifierMatched)}   <- the qualified setKey's catalog row exists`);
    console.log(`  product: UNMATCHED     ${f(stats.productQualifierUnmatched)}   <- no catalog row at the qualified setKey — ${APPLY ? "marked productQualifierUnmatched" : "would be marked"}, left (an acquisition list)`);
    console.log(`  product: REFUSED       ${f(stats.productQualifierRefused)}   <- bowman ↔ bowman-chrome / Topps Chrome Update — rulings, not bot moves`);
  }
  console.log(`  no slug                ${f(stats.noSlug)}`);
  console.log(`  failed                 ${f(stats.failed)}`);
  console.log(`  moves by source|from>to:`);
  for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`    ${String(n).padStart(7)}  ${k}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (unmatchedExamples.length) { console.log(`  unmatched / refused examples:`); for (const e of unmatchedExamples) console.log(e); }
  if (stopReason) console.log(`\n${stopReason}`);
  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW: what this run meant to write, against
  // what it wrote. Report-only declares every would-be write as skipped.
  const intended = stats.repaired + stats.failed + stats.marked;
  reportWrites({
    job: `repair-parallel-from-title[${MODE}]`,
    intended,
    written: APPLY ? stats.repaired + stats.marked : 0,
    skipped: APPLY ? 0 : intended,
    failed: stats.failed,
  });
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
