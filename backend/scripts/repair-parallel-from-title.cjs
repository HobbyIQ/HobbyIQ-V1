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
 *   backfill-stamp
 *             CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG reaches historicalBackfill
 *             (Drew, 2026-08-31). historicalBackfill.service fetched every sale
 *             of ONE vendor product and stamped the HOLDING's parallel onto all
 *             of them (backfillOneCH:122, backfillOneCS:191). Live damage: 50
 *             CardHedge BASE auto sales (~$11) were relabelled "Black & White
 *             Red Ink" onto hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-
 *             red-ink-refractor:auto at 2026-08-31T14:16:48Z; the holding's FMV
 *             fell to $9.38 while its owner's real $270 self-comp was
 *             suppressed by SELF_COMP_MIN_OTHER_SAMPLES.
 *
 *             FINGERPRINT (both must hold, per the diagnosis journal):
 *               (a) sourceExternalId does NOT start with "ch-daily::" -- the
 *                   fanout's shape. historicalBackfill writes the composite
 *                   "<vendorCardId>::<date>::<cents>::<grade>" (line ~115), so
 *                   the absence of that prefix is this writer's signature.
 *               (b) the stored parallel is NOT allowed by the title under
 *                   parallelTheTitleAllows -- the same rule the fixed service
 *                   now applies at write time.
 *
 *             A poisoned row moves to the identity its title supports (Base,
 *             usually). If the SAME vendor sale is already in the pool under a
 *             "ch-daily::" row at the target identity, the poisoned row is a
 *             fanout duplicate and is DELETED instead of moved -- matched on
 *             the store's own contentHash (cardId + parallel + isAuto + grade +
 *             priceCents + soldDay), so "duplicate" is measured, never assumed.
 *             Re-key and delete both go through lib/relocate-sold-comp.cjs
 *             (CF-A-SALE-IS-NEVER-LOST: upsert, verify, then delete).
 *
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
const { parallelTheTitleAllows } = require(path.join(backend, "dist", "services", "portfolioiq", "titleOutranksVendorTag.js"));
const { relocateSoldComp, stripSystem, contentHashesForLookup } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.APPLY === "true" || process.env.BACKFILL_APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const SOURCES = String(process.env.SOURCES || "cardhedge,tca-ebay,cardsight").split(",").map((s) => s.trim()).filter(Boolean);
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "repair-parallel-from-title" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const MODE = String(process.env.MODE || "colours").toLowerCase();
if (!["colours", "colors", "refractor", "variation", "product", "backfill-stamp"].includes(MODE)) { console.error(`FATAL: MODE=${MODE} is not colours|refractor|variation|product|backfill-stamp`); process.exit(2); }
/** backfill-stamp only: restrict to one slug (the CPA-VF fixture) or one slug
 *  prefix, so the blast radius can be measured in bounded slices before any
 *  pool-wide run. Empty = the whole pool. */
const SLUG_PREFIX = String(process.env.SLUG_PREFIX || "").trim();

/** backfill-stamp: historicalBackfill's externalId is the 4-part composite
 *  "<vendorCardId>::<ISO date>::<priceCents>::<grade>" (service lines ~115 and
 *  ~184). MEASURED 2026-08-31 against prod: of the 30,431 non-Base rows that
 *  lack the fanout's "ch-daily::" prefix and whose title refuses the stored
 *  parallel, only 130 carry THIS shape. The other 30,301 are other writers --
 *  29,181 one-part cardsight ids and 659 "ch-comp::" three-part CardHedge ids
 *  -- whose title/tag disagreements are a separate question with separate
 *  causes. Repairing on the prefix alone would move ~30k rows this defect never
 *  wrote. The shape test is therefore part of the fingerprint, not a nicety. */
const BF_GRADE_RE = /^(raw|[A-Z]+ [0-9.]+)$/i;
function isHistoricalBackfillShape(ext) {
  const parts = String(ext ?? "").split("::");
  return parts.length === 4
    && /\d{4}-\d{2}-\d{2}/.test(parts[1])
    && /^\d+$/.test(parts[2])
    && BF_GRADE_RE.test(parts[3]);
}
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
  console.log(`  ${SHARD_SCOPE.banner()}`);
  const stats = {
    scanned: 0, otherShard: 0, repaired: 0, toBase: 0, toOther: 0, kept: 0, keptRefinement: 0, failed: 0, noSlug: 0, resolvedByMatcher: 0,
    // variation
    variationFromTitle: 0, variationFromMarker: 0, variationUnmatched: 0, variationStockReduced: 0,
    // product
    productQualifierMatched: 0, productQualifierUnmatched: 0, productQualifierRefused: 0, marked: 0,
    // backfill-stamp
    stamped: 0, duplicateOfFanout: 0, deleted: 0, duplicatesLeft: 0, dedupQueryFailed: 0, otherWriterShape: 0,
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
    if (MODE === "backfill-stamp") {
      // The fingerprint's cheap half runs in Cosmos: this writer's rows carry a
      // sourceExternalId that does NOT begin "ch-daily::". The expensive half
      // (the title rule) runs here, per row.
      const q = {
        query: `SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price, c.soldAt, c.isAuto, c.gradeCompany, c.gradeValue, c.sourceExternalId, c.source
                FROM c
                WHERE c.source = @s
                  AND IS_DEFINED(c.parallel) AND c.parallel != '' AND c.parallel != 'Base'
                  AND IS_DEFINED(c.sourceExternalId) AND NOT STARTSWITH(c.sourceExternalId, 'ch-daily::')
                  ${SLUG_PREFIX ? "AND STARTSWITH(c.hobbyiqCardId, @pfx)" : ""}`,
        parameters: [{ name: "@s", value: source }, ...(SLUG_PREFIX ? [{ name: "@pfx", value: SLUG_PREFIX }] : [])],
      };
      for await (const r of scan(q)) {
        const slug = String(r.hobbyiqCardId ?? "");
        const comp = slug.startsWith("hiq:") ? parseHobbyIqCardId(slug) : null;
        if (!comp) { stats.noSlug++; continue; }
        // Fingerprint half (a): only THIS writer's externalId shape. Measured
        // 2026-08-31: 130 of 30,431 prefix-matching rows. The rest belong to
        // other writers and are NOT this defect.
        if (!isHistoricalBackfillShape(r.sourceExternalId)) { stats.otherWriterShape++; continue; }
        // The rule, exactly as the fixed service now applies it at write time.
        const parsed = parseListingTitle(r.title);
        const decision = parallelTheTitleAllows(parsed && parsed.parallel, r.parallel, { variationMarker: (parsed && parsed.variationMarker) || null });
        // Not overruled -> the title allows what is stored. Untouched.
        if (!decision.vendorTagOverruled) { stats.kept++; continue; }
        const newParallel = decision.parallel ?? "Base";
        if (newParallel.toLowerCase() === String(r.parallel ?? "").toLowerCase()) { stats.kept++; continue; }
        stats.stamped++;
        const newSlug = await resolveSlug(comp, newParallel);
        if (!newSlug || !newSlug.startsWith("hiq:") || newSlug === slug) { stats.kept++; continue; }
        const byTarget = `${source}|${r.parallel ?? "(none)"}>${newParallel}`;
        // Is this same vendor sale ALREADY in the pool at the target identity,
        // written by the ch-daily fanout? Match on the store's own content hash
        // in the TARGET partition -- measured, not assumed.
        const moved = { ...r, cardId: newSlug, parallel: newParallel };
        let twin = null;
        try {
          const hashes = contentHashesForLookup(moved);
          const { resources } = await retry(() => pool.items.query({
            query: `SELECT c.id, c.cardId, c.sourceExternalId FROM c WHERE c.cardId = @cid AND ARRAY_CONTAINS(@h, c.contentHash) AND c.id != @self`,
            parameters: [{ name: "@cid", value: newSlug }, { name: "@h", value: hashes }, { name: "@self", value: r.id }],
          }, { maxItemCount: 10 }).fetchAll());
          twin = (resources ?? []).find((x) => String(x.sourceExternalId ?? "").startsWith("ch-daily::")) ?? (resources ?? [])[0] ?? null;
        } catch (e) { stats.dedupQueryFailed++; }

        if (twin) {
          // The fanout already holds this sale at the right identity: the
          // poisoned row is a duplicate, so it is deleted, not moved.
          stats.duplicateOfFanout++;
          moves.set(`${byTarget} [DELETE dup]`, (moves.get(`${byTarget} [DELETE dup]`) || 0) + 1);
          if (examples.length < 25) examples.push(`  ${source}  DELETE dup  ${r.parallel} -> (already at ${newParallel})  ${slug}  $${r.price}  "${String(r.title ?? "").slice(0, 70)}"`);
          if (!APPLY) { stats.repaired++; continue; }
          try {
            await retry(() => pool.item(r.id, r.cardId).delete());
            stats.deleted++; stats.repaired++;
          } catch (e) { stats.failed++; if (stats.failed <= 3) console.log("  delete failed " + r.id + ": " + String(e.message).slice(0, 80)); }
          continue;
        }

        // No twin: the sale moves to the identity its title supports. A
        // cross-partition re-key is upsert -> verify -> delete.
        moves.set(byTarget, (moves.get(byTarget) || 0) + 1);
        if (examples.length < 25) examples.push(`  ${source}  ${r.parallel} -> ${newParallel}  ${slug} -> ${newSlug}  $${r.price}  "${String(r.title ?? "").slice(0, 70)}"`);
        if (newParallel === "Base") stats.toBase++; else stats.toOther++;
        const keep = {
          ...stripSystem(r),
          cardId: newSlug,
          hobbyiqCardId: newSlug,
          parallel: newParallel,
          reslugedFrom: slug,
          reslugedAt: new Date().toISOString(),
          reslugedReason: "the holding's parallel was stamped onto a vendor product's sales; the title outranks it (CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG, historicalBackfill)",
        };
        keep.contentHash = contentHashesForLookup(keep)[0];
        const res = await relocateSoldComp(pool, {
          keep, drop: [{ id: r.id, cardId: r.cardId }], retry, verifyFields: ["parallel", "hobbyiqCardId"], dryRun: !APPLY,
        });
        if (res.ok) stats.repaired++; else { stats.failed++; if (stats.failed <= 3) console.log(`  relocate failed ${r.id} at ${res.stage}: ${String(res.error ?? "").slice(0, 80)}`); }
        if (res.duplicatesLeft && res.duplicatesLeft.length) stats.duplicatesLeft += res.duplicatesLeft.length;
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
  if (MODE === "backfill-stamp") {
    console.log(`  other writer's shape   ${f(stats.otherWriterShape)}   <- no 'ch-daily::' prefix but NOT historicalBackfill's 4-part composite — left alone`);
    console.log(`  stamp fingerprint hit  ${f(stats.stamped)}   <- historicalBackfill's shape AND the title refuses the stored parallel`);
    console.log(`  re-keyed to the title  ${f(stats.toBase + stats.toOther)}   <- to Base ${f(stats.toBase)}, to another named finish ${f(stats.toOther)}`);
    console.log(`  ${APPLY ? "DELETED, fanout dup   " : "would DELETE, fanout dup"} ${f(stats.duplicateOfFanout)}   <- the same vendor sale already at the target identity under a 'ch-daily::' row`);
    console.log(`  duplicates LEFT        ${f(stats.duplicatesLeft)}   <- a delete that failed after the new row verified — the sale is in the pool twice`);
    console.log(`  dedup query failed     ${f(stats.dedupQueryFailed)}   <- treated as "no twin" (re-key, never delete)`);
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

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
