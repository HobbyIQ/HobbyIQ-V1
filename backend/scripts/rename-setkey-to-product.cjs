#!/usr/bin/env node
/**
 * rename-setkey-to-product.cjs -- the id carries the product (D23).
 *
 * CF-THE-ID-CARRIES-THE-PRODUCT (Drew, 2026-08-30 19:50Z): "the id's setKey
 * is the product as the checklist names it." The slug generator collapsed the
 * product into its family -- topps-series-1 minted `topps`, topps-update-series
 * `topps-update`, topps-chrome-update-series `topps-chrome`, bowman-draft-1st-
 * edition `bowman-draft`, upper-deck-series-1 `upper-deck`, topps-heritage-
 * high-number `topps-heritage`, every Leaf product `leaf` -- while the row's
 * setKey FIELD kept the product. Measured 2026-08-30 (read-only, un-graded):
 * 1,231,457 rows whose id disagrees with their own field across the ruled
 * keys, plus the spellings the ruling folds (baseballcardpedia's `topps-update`
 * 630k, `topps-chrome-update` 17k) and 27k `topps-chrome` rows whose setName
 * says "Topps Chrome Update". The generator stopped collapsing in D23 1/3
 * (productSetKeys.ts); this fleet brings the stored rows to it.
 *
 * MODE=product (default). For every un-graded row of a ruled product whose
 * id's setKey segment, card-number spelling, or setKey FIELD differs from
 * what the new generator produces from the row's own fields:
 *   - the product is resolved from the row's setName FIRST (the checklist's
 *     own words: "2008 Topps Updates & Highlights" under a `topps-update`
 *     field is Updates & Highlights), then from the setKey field; a name that
 *     resolves to a ruled product wins over the field (counted);
 *   - the card-number segment is slugify(cardNumber field) -- the checklist's
 *     hyphen kept (ruling d);
 *   - MOVE: moveCatalogRow(cat, row, newId, { setKey, cardNumber }, ...) --
 *     the survivor written first, the sales re-pointed (hobbyiqCardId +
 *     normalizedSetKey), the old slug's graded children retired, the old row
 *     deleted last; a row already at the target is a FOLD or a REPLACE by
 *     authority (the checklist row wins; vendorIds union);
 *   - HEAL: the id is already right and only the field is wrong (Donruss under
 *     the era rule: a 2025 `donruss` field beside a panini-donruss id) -- the
 *     field, brand, parentSetKey and the searchable fields are patched in
 *     place through catalogRowOps' rebuildSearchFields.
 * The population is per product, self-shrinking (a renamed row no longer
 * matches), sharded by sha1(id) % SLOTS.
 *
 * MODE=hyphen. SOURCES is REQUIRED (a whole-scope write names its scope): for
 * every un-graded row of those sources whose cardNumber is letters-then-digits
 * with no hyphen (bccp "BD152"), the checklist's spelling (BD-152) is probed
 * by point read; when that row exists AND is checklist-authority
 * (canAdjudicate) this one is folded onto it through moveCatalogRow; when
 * it does not exist, or is a derived / vendor row, the row is refused and
 * counted -- the checklist's spelling is unknown and this script never
 * invents one.
 *
 * MODE=holdings. Slot 0 only. Every portfolio holding whose hobbyiqCardId /
 * cardId is an hiq slug that no longer names a catalog row is re-pointed: the
 * survivor's `movedFrom` stamp first, then a target derived the way the
 * catalog rows were (the holding's setName, the id's spelling through the
 * table, the hyphenated twin), each confirmed by point read; a graded id is
 * re-pointed to its parent's new id + tier and counted `graded-child-pending`
 * (materialize-graded-identities regenerates the child). Nothing is written
 * for a holding whose target cannot be confirmed; it is reported.
 *
 * MODE=estimate. Read-only always: the full-population count per product.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY / APPLY (report only by
 *      default); MODE; SLOT/SLOTS (sha1(id) shards); RUN_MINUTES=140;
 *      CONCURRENCY=8; LIMIT=0 (actionable rows); SPORTS, YEARS (comma lists);
 *      SCOPE (comma list of ruled product keys; empty or the runner's default
 *      "refractor" = every ruled product; anything else unknown is FATAL);
 *      SOURCES (MODE=hyphen, required).
 */
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const MODE = String(process.env.MODE || "product").trim().toLowerCase() || "product";
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
const SHARD_SCOPE = runnerShardScope({ label: "rename-setkey-to-product" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SCOPE_RAW = String(process.env.SCOPE || "").trim().toLowerCase();
const SOURCES = String(process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const backend = path.resolve(__dirname, "..");
const REASON = "the id carries the product as the checklist names it (CF-THE-ID-CARRIES-THE-PRODUCT, D23)";
const HYPHEN_REASON = "the card number keeps the checklist's hyphen; bd152 is bd-152 (CF-THE-ID-CARRIES-THE-PRODUCT, D23 ruling d)";

// -- pure -------------------------------------------------------------------

/** The ruled products: every `spelled` entry of the table plus the Donruss
 *  pair (spelled by era, not by name). Each with the field spellings its rows
 *  may carry. */
function ruledProducts(table) {
  const out = [];
  for (const p of table.PRODUCT_SET_KEYS) {
    if (p.spelled) out.push({ setKey: p.setKey, spellings: [p.setKey, ...(p.names ?? [])], era: false });
  }
  out.push({ setKey: "donruss", spellings: ["donruss", "panini-donruss"], era: true });
  return out;
}

/** hiq:sport:year:setKey:number:parallel:auto[:num-N] -> parts, or null for
 *  anything that is not an identity row (a graded child has a tier segment). */
function identityParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || parts.length < 7 || parts.length > 8) return null;
  if (parts.length === 8 && !parts[7].startsWith("num-")) return null;
  return parts;
}

/**
 * What a row needs under the ruling. `deps` are the slug generator's own
 * functions (resolveSetKeyForSlug, slugify, isRuled) so the decision is the
 * generator's, not a copy of it.
 *   move          { newId, setKey, cardNumber }  the id's setKey or number segment is wrong
 *   heal          { setKey }                     the id is right, the field is not
 *   canonical                                    both halves agree
 *   refuse        { why }                        not an identity row / no ruled product / …
 */
function decideProductRow(row, deps) {
  const parts = identityParts(row.id);
  if (!parts) return { action: "refuse", why: "not-an-identity-row" };
  const sport = String(row.sport || parts[1]).toLowerCase();
  const year = Number(row.year ?? parts[2]);
  if (!Number.isFinite(year) || year <= 0) return { action: "refuse", why: "no-year" };
  const nameKey = row.setName ? deps.resolveSetKeyForSlug(sport, String(row.setName), year) : null;
  const fieldKey = row.setKey ? deps.resolveSetKeyForSlug(sport, String(row.setKey), year) : null;
  const nameRuled = nameKey && deps.isRuled(nameKey);
  const fieldRuled = fieldKey && deps.isRuled(fieldKey);
  const want = nameRuled ? nameKey : fieldRuled ? fieldKey : null;
  if (!want) return { action: "refuse", why: "no-ruled-product" };
  const nameOverField = Boolean(nameRuled && fieldRuled && nameKey !== fieldKey);
  const fieldNumber = String(row.cardNumber ?? "").trim();
  const newNum = fieldNumber ? deps.slugify(fieldNumber) || parts[4] : parts[4];
  if (parts[3] === want && parts[4] === newNum) {
    return String(row.setKey ?? "") === want ? { action: "canonical" } : { action: "heal", setKey: want, nameOverField };
  }
  const next = [...parts];
  next[3] = want;
  next[4] = newNum;
  return { action: "move", newId: next.join(":"), setKey: want, cardNumber: fieldNumber || null, nameOverField };
}

/** The checklist's hyphenated spelling of a letters-then-digits number, or
 *  null when the number already has one (or is not that shape). */
function hyphenatedTwin(cardNumber) {
  const s = String(cardNumber ?? "").trim().toUpperCase();
  const m = /^([A-Z]+)(\d+)$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** MODE=hyphen: the id this row would fold onto, if the checklist's spelling
 *  exists there. The caller confirms existence by point read. */
function decideHyphenRow(row, deps) {
  const parts = identityParts(row.id);
  if (!parts) return { action: "refuse", why: "not-an-identity-row" };
  const twin = hyphenatedTwin(row.cardNumber);
  if (!twin) return { action: "refuse", why: "not-letters-then-digits" };
  const next = [...parts];
  next[4] = deps.slugify(twin);
  if (next[4] === parts[4]) return { action: "canonical" };
  return { action: "probe", twinId: next.join(":"), cardNumber: twin };
}

/**
 * MODE=holdings: the candidate ids a holding could have moved to, derived
 * the way the catalog rows were -- the holding's own setName through the
 * generator, else the id's setKey spelling through the table -- crossed with
 * the number as written and its hyphenated twin. Returned in preference
 * order; the caller confirms by point read. A graded id (a tier after the
 * identity) yields candidates for its PARENT plus the tier to re-append.
 */
function holdingTargetCandidates(holding, deps) {
  const id = String(holding.hobbyiqCardId || holding.cardId || "");
  const parts = id.split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return { candidates: [], tier: null };
  let tier = null;
  let base = parts;
  if (parts.length === 8 && !parts[7].startsWith("num-")) { tier = parts[7]; base = parts.slice(0, 7); }
  else if (parts.length === 9) { tier = parts[8]; base = parts.slice(0, 8); }
  else if (parts.length > 9) return { candidates: [], tier: null };
  const sport = String(holding.sport || base[1]).toLowerCase();
  const year = Number(holding.year ?? base[2]);
  const keys = [];
  const nameKey = holding.setName && Number.isFinite(year) ? deps.resolveSetKeyForSlug(sport, String(holding.setName), year) : null;
  if (nameKey && deps.isRuled(nameKey)) keys.push(nameKey);
  const spelled = deps.productSetKeyForName(base[3]);
  if (spelled && !keys.includes(spelled)) keys.push(spelled);
  const era = deps.spellForEra(base[3], Number.isFinite(year) ? year : null);
  if (era !== base[3] && !keys.includes(era)) keys.push(era);
  if (!keys.includes(base[3])) keys.push(base[3]);
  const nums = [base[4]];
  const fieldNum = holding.cardNumber ? deps.slugify(String(holding.cardNumber)) : "";
  if (fieldNum && !nums.includes(fieldNum)) nums.push(fieldNum);
  const twin = hyphenatedTwin(base[4]);
  if (twin) { const t = deps.slugify(twin); if (!nums.includes(t)) nums.push(t); }
  const candidates = [];
  for (const k of keys) for (const n of nums) {
    const next = [...base]; next[3] = k; next[4] = n;
    const cand = next.join(":");
    if (cand !== base.join(":") && !candidates.includes(cand)) candidates.push(cand);
  }
  return { candidates, tier };
}

// -- Cosmos -----------------------------------------------------------------

function scopeFilters() {
  const clauses = [];
  const params = [];
  if (SPORTS.length) { clauses.push(`c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})`); SPORTS.forEach((s, i) => params.push({ name: `@sp${i}`, value: s })); }
  if (YEARS.length) { clauses.push(`c.year IN (${YEARS.map((_, i) => `@yr${i}`).join(",")})`); YEARS.forEach((y, i) => params.push({ name: `@yr${i}`, value: y })); }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
}

/** The population clause for one ruled product: rows whose FIELD is a
 *  non-canonical spelling, or whose id segment is not the canonical key.
 *  For Donruss the canonical key is the era's; for topps-chrome-update-series
 *  the `topps-chrome` rows whose setName says Update are in too. */
function productPopulation(p, table) {
  const params = [];
  const ors = [];
  // The id's OWN text decides whether its segment is the canonical key --
  // never CONCAT over the row's sport / year fields, which goes undefined for
  // a row missing either and silently drops it from the population (8
  // leaf-limited rows, measured 2026-08-30). ":key:" cannot match another
  // segment: a card number or a parallel is never spelled like a product key.
  if (p.era) {
    ors.push(`(c.setKey = "donruss" AND (c.year >= ${table.PANINI_DONRUSS_FROM_YEAR} OR NOT CONTAINS(c.id, ":donruss:")))`);
    ors.push(`(c.setKey = "panini-donruss" AND (c.year < ${table.PANINI_DONRUSS_FROM_YEAR} OR NOT CONTAINS(c.id, ":panini-donruss:")))`);
  } else {
    const aliases = p.spellings.filter((s) => s !== p.setKey);
    if (aliases.length) {
      ors.push(`c.setKey IN (${aliases.map((_, i) => `@al${i}`).join(",")})`);
      aliases.forEach((a, i) => params.push({ name: `@al${i}`, value: a }));
    }
    ors.push(`(c.setKey = @canon AND NOT CONTAINS(c.id, CONCAT(":", @canon, ":")))`);
    params.push({ name: "@canon", value: p.setKey });
    if (p.setKey === "topps-chrome-update-series") ors.push(`(c.setKey = "topps-chrome" AND (CONTAINS(c.setName, "Update") OR CONTAINS(c.setName, "update")))`);
  }
  return { sql: `(${ors.join(" OR ")})`, params };
}

async function forEachPage(container, spec, fn) {
  let token;
  do {
    const page = await retry(() => container.items.query(spec, { maxItemCount: 500, continuationToken: token }).fetchNext());
    token = page.continuationToken || undefined;
    if (await fn(page.resources ?? []) === false) return false;
  } while (token);
  return true;
}

async function pointRead(container, id, pk) {
  try { return (await retry(() => container.item(id, pk ?? id).read())).resource ?? null; }
  catch (e) { if (e?.code === 404) return null; throw e; }
}

// -- main -------------------------------------------------------------------

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { CosmosClient } = require("@azure/cosmos");
  const table = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const gen = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { moveCatalogRow, rebuildSearchFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { canAdjudicate } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps"), portfolio = db.container("portfolio");

  const all = ruledProducts(table);
  const ruledKeys = new Set(all.flatMap((p) => (p.era ? ["donruss", "panini-donruss"] : [p.setKey])));
  const deps = {
    resolveSetKeyForSlug: gen.resolveSetKeyForSlug,
    slugify: gen.slugify,
    isRuled: (k) => ruledKeys.has(k),
    productSetKeyForName: table.productSetKeyForName,
    spellForEra: table.spellForEra,
  };
  // SCOPE: the runner's default for this input is "refractor" (another
  // script's vocabulary); empty or that means every ruled product. A token
  // that names no ruled product is a typo, and a typo must not widen a run.
  const scopeTokens = SCOPE_RAW && SCOPE_RAW !== "refractor" && SCOPE_RAW !== "all" ? SCOPE_RAW.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const unknown = scopeTokens.filter((t) => !all.some((p) => p.setKey === t || (p.era && (t === "donruss" || t === "panini-donruss"))));
  if (unknown.length) { console.error(`FATAL: SCOPE names no ruled product: ${unknown.join(", ")}`); process.exit(1); }
  const products = scopeTokens.length ? all.filter((p) => scopeTokens.includes(p.setKey) || (p.era && (scopeTokens.includes("donruss") || scopeTokens.includes("panini-donruss")))) : all;
  const filters = scopeFilters();
  console.log(`rename-setkey-to-product  MODE=${MODE}  ${APPLY && MODE !== "estimate" ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  products=${products.length}${scopeTokens.length ? ` (scope: ${scopeTokens.join(",")})` : " (all ruled)"}${SPORTS.length ? `  sports=${SPORTS.join(",")}` : ""}${YEARS.length ? `  years=${YEARS.join(",")}` : ""}  limit=${LIMIT || "none"}  donruss=${table.DONRUSS_SPELLING_POLICY}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  if (MODE === "estimate") return estimate(cat, products, table, filters);
  if (MODE === "product") return renameProducts(cat, pool, products, table, deps, filters, { moveCatalogRow, rebuildSearchFields, reportWrites, deriveParentSetKey: gen.deriveParentSetKey, deriveBrand: gen.deriveBrand });
  if (MODE === "hyphen") return foldHyphens(cat, pool, deps, filters, { moveCatalogRow, reportWrites, canAdjudicate });
  if (MODE === "holdings") return repointHoldings(cat, portfolio, deps, { reportWrites });
  console.error(`FATAL: unknown MODE=${MODE} (product | hyphen | holdings | estimate)`);
  process.exit(1);
}

async function estimate(cat, products, table, filters) {
  console.log(`\nfull-population estimate (read-only): rows whose id or field disagrees with the product\n`);
  let total = 0;
  for (const p of products) {
    const pop = productPopulation(p, table);
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND ${pop.sql}${filters.sql}`,
      parameters: [...pop.params, ...filters.params],
    }).fetchAll());
    const n = Number(resources?.[0] ?? 0);
    total += n;
    console.log(`  ${(p.era ? "donruss / panini-donruss (era)" : p.setKey).padEnd(48)} ${f(n).padStart(10)}`);
  }
  console.log(`  ${"TOTAL".padEnd(48)} ${f(total).padStart(10)}`);
}

async function renameProducts(cat, pool, products, table, deps, filters, lib) {
  const stats = { scanned: 0, otherShard: 0, actionable: 0, moved: 0, folded: 0, replaced: 0, healed: 0, canonical: 0, refused: 0, nameOverField: 0, gone: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const refusals = new Map();
  const perProduct = new Map();
  const examples = [];
  let stopReason = null;
  for (const p of products) {
    if (stopReason) break;
    const label = p.era ? "donruss (era)" : p.setKey;
    const pp = { scanned: 0, moved: 0, folded: 0, replaced: 0, healed: 0, canonical: 0, refused: 0 };
    perProduct.set(label, pp);
    const pop = productPopulation(p, table);
    const spec = {
      query: `SELECT c.id, c.cardId, c.sport, c.year, c.setKey, c.setName, c.cardNumber, c.source FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND ${pop.sql}${filters.sql}`,
      parameters: [...pop.params, ...filters.params],
    };
    let pages = 0;
    await forEachPage(cat, spec, async (rows) => {
      const mine = SLOTS > 1 ? rows.filter((r) => shardOf(r.id) === SLOT) : rows;
      stats.otherShard += rows.length - mine.length;
      pages++;
      // A fleet script says where it is: one line per page, so a slow page
      // or a slow row is visible in the runner log while it happens.
      process.stderr.write(`  ${label.slice(0, 32).padEnd(32)} page ${pages} rows=${rows.length} mine=${mine.length} scanned=${f(stats.scanned)} actionable=${f(stats.actionable)} renamed=${f(stats.moved + stats.folded + stats.replaced + stats.healed)} t=${Math.round((Date.now() - started) / 1000)}s\n`);
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; stats.notReached += mine.length - i; return false; }
        if (budgetLeft() < 90000) { stopReason = "budget"; stats.notReached += mine.length - i; return false; }
        await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
          stats.scanned++; pp.scanned++;
          const d = decideProductRow(row, deps);
          if (d.action === "refuse") { stats.refused++; pp.refused++; refusals.set(d.why, (refusals.get(d.why) ?? 0) + 1); return; }
          if (d.action === "canonical") { stats.canonical++; pp.canonical++; return; }
          stats.actionable++;
          if (d.nameOverField) stats.nameOverField++;
          try {
            const full = await pointRead(cat, row.id, row.cardId ?? row.id);
            if (!full) { stats.gone++; return; }
            if (d.action === "heal") {
              const s = lib.rebuildSearchFields({ ...full, setKey: d.setKey });
              if (APPLY) await retry(() => cat.item(row.id, row.cardId ?? row.id).patch([
                { op: "set", path: "/setKey", value: d.setKey },
                { op: "set", path: "/brand", value: lib.deriveBrand(d.setKey) },
                { op: "set", path: "/parentSetKey", value: lib.deriveParentSetKey(d.setKey) },
                { op: "set", path: "/searchText", value: s.searchText },
                { op: "set", path: "/searchTokens", value: s.searchTokens },
                { op: "set", path: "/displayName", value: s.displayName },
                { op: "set", path: "/setKeyHealedFrom", value: full.setKey ?? null },
                { op: "set", path: "/setKeyHealedReason", value: REASON },
              ]));
              stats.healed++; pp.healed++;
              if (examples.length < 24) examples.push(`  heal    ${row.id}  field ${JSON.stringify(full.setKey ?? null)} -> ${d.setKey}  [${row.source}]`);
              return;
            }
            const changed = { setKey: d.setKey };
            if (d.cardNumber) changed.cardNumber = d.cardNumber;
            const res = await lib.moveCatalogRow(cat, full, d.newId, changed, { reason: REASON, repointNormalizedSetKey: true, dryRun: !APPLY, salesContainer: pool, retry });
            if (res.action === "move") { stats.moved++; pp.moved++; }
            else if (res.action === "fold") { stats.folded++; pp.folded++; }
            else if (res.action === "replace") { stats.replaced++; pp.replaced++; }
            else { stats.gone++; return; }
            stats.salesRepointed += res.salesRepointed ?? 0;
            stats.gradedRetired += res.gradedChildrenRetired ?? 0;
            if (examples.length < 24) examples.push(`  ${res.action.padEnd(7)} ${row.id} -> ${d.newId}  [${row.source}]  (${res.decision})`);
          } catch (e) {
            stats.failed++;
            if (stats.failed <= 5) console.log(`  failed ${row.id}: ${String(e?.message ?? e).slice(0, 140)}`);
          }
        }));
      }
      return true;
    });
    process.stderr.write(`  ${label.padEnd(44)} scanned=${f(pp.scanned)} moved=${f(pp.moved)} folded=${f(pp.folded)} replaced=${f(pp.replaced)} healed=${f(pp.healed)} canonical=${f(pp.canonical)} refused=${f(pp.refused)}\n`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  candidates (this slot)   ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  actionable rows          ${f(stats.actionable)}`);
  console.log(`  RENAMED                  ${f(stats.moved + stats.folded + stats.replaced + stats.healed)}   <- moved ${f(stats.moved)}, folded into an existing row ${f(stats.folded)}, replaced an existing row ${f(stats.replaced)}, field healed ${f(stats.healed)}`);
  console.log(`  sales re-pointed         ${f(stats.salesRepointed)}`);
  console.log(`  graded children retired  ${f(stats.gradedRetired)}   <- regenerable by materialize-graded-identities`);
  console.log(`  already canonical        ${f(stats.canonical)}`);
  console.log(`  name won over field      ${f(stats.nameOverField)}   <- the checklist's setName resolved to a different ruled product than the field`);
  console.log(`  refused                  ${f(stats.refused)}${refusals.size ? "   <- " + [...refusals].map(([k, n]) => `${k} ${f(n)}`).join(", ") : ""}`);
  console.log(`  gone before the move     ${f(stats.gone)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  console.log(`  by product:`);
  for (const [k, v] of perProduct) if (v.scanned) console.log(`    ${k.padEnd(44)} scanned ${f(v.scanned).padStart(8)}  moved ${f(v.moved).padStart(7)}  folded ${f(v.folded).padStart(6)}  replaced ${f(v.replaced).padStart(6)}  healed ${f(v.healed).padStart(7)}  canonical ${f(v.canonical).padStart(6)}  refused ${f(v.refused).padStart(6)}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) lib.reportWrites({ job: "rename-setkey-to-product", intended: stats.actionable, written: stats.moved + stats.folded + stats.replaced + stats.healed, skipped: stats.gone, failed: stats.failed });
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

async function foldHyphens(cat, pool, deps, filters, lib) {
  if (!SOURCES.length) { console.error("FATAL: MODE=hyphen needs SOURCES (comma list) -- a whole-scope write names its scope"); process.exit(1); }
  const stats = { scanned: 0, otherShard: 0, actionable: 0, folded: 0, replaced: 0, moved: 0, canonical: 0, noTwin: 0, twinNotChecklist: 0, refused: 0, gone: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const examples = [];
  let stopReason = null;
  const spec = {
    query: `SELECT c.id, c.cardId, c.cardNumber, c.source FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND c.source IN (${SOURCES.map((_, i) => `@src${i}`).join(",")}) AND RegexMatch(c.cardNumber, "^[A-Za-z]+[0-9]+$")${filters.sql}`,
    parameters: [...SOURCES.map((s, i) => ({ name: `@src${i}`, value: s })), ...filters.params],
  };
  await forEachPage(cat, spec, async (rows) => {
    const mine = SLOTS > 1 ? rows.filter((r) => shardOf(r.id) === SLOT) : rows;
    stats.otherShard += rows.length - mine.length;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; stats.notReached += mine.length - i; return false; }
      if (budgetLeft() < 90000) { stopReason = "budget"; stats.notReached += mine.length - i; return false; }
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
        stats.scanned++;
        const d = decideHyphenRow(row, deps);
        if (d.action === "refuse") { stats.refused++; return; }
        if (d.action === "canonical") { stats.canonical++; return; }
        try {
          const twin = await pointRead(cat, d.twinId, d.twinId);
          if (!twin) { stats.noTwin++; return; }
          // Ruling (d) says the CHECKLIST's hyphen. A twin that is itself a
          // derived or vendor row (a stub, an exploded ladder) proves nothing
          // about the spelling; the first dry run showed a bccp row REPLACING
          // such a twin by authority. Only a checklist-authority twin decides.
          if (!lib.canAdjudicate(twin.source)) { stats.twinNotChecklist++; return; }
          stats.actionable++;
          const full = await pointRead(cat, row.id, row.cardId ?? row.id);
          if (!full) { stats.gone++; return; }
          const res = await lib.moveCatalogRow(cat, full, d.twinId, { cardNumber: d.cardNumber }, { reason: HYPHEN_REASON, dryRun: !APPLY, salesContainer: pool, known: twin, retry });
          if (res.action === "fold") stats.folded++;
          else if (res.action === "replace") stats.replaced++;
          else if (res.action === "move") stats.moved++;
          else { stats.gone++; return; }
          stats.salesRepointed += res.salesRepointed ?? 0;
          stats.gradedRetired += res.gradedChildrenRetired ?? 0;
          if (examples.length < 24) examples.push(`  ${res.action.padEnd(7)} ${row.id} -> ${d.twinId}  [${row.source}]  (${res.decision})`);
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 5) console.log(`  failed ${row.id}: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }));
    }
    return true;
  });
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}  sources=${SOURCES.join(",")}`);
  console.log(`  candidates (this slot)   ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  actionable rows          ${f(stats.actionable)}   <- a checklist row exists at the hyphenated spelling`);
  console.log(`  RENAMED                  ${f(stats.folded + stats.replaced + stats.moved)}   <- folded into the checklist row ${f(stats.folded)}, replaced it ${f(stats.replaced)}, moved ${f(stats.moved)}`);
  console.log(`  sales re-pointed         ${f(stats.salesRepointed)}`);
  console.log(`  graded children retired  ${f(stats.gradedRetired)}`);
  console.log(`  no hyphenated twin       ${f(stats.noTwin)}   <- the checklist's spelling is unknown; refused, never invented`);
  console.log(`  twin is not a checklist  ${f(stats.twinNotChecklist)}   <- a derived / vendor row at the hyphenated id proves nothing about the spelling; refused`);
  console.log(`  already hyphenated       ${f(stats.canonical)}`);
  console.log(`  refused                  ${f(stats.refused)}   <- not an identity row / not letters-then-digits`);
  console.log(`  gone before the move     ${f(stats.gone)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) lib.reportWrites({ job: "rename-setkey-to-product", intended: stats.actionable, written: stats.folded + stats.replaced + stats.moved, skipped: stats.gone, failed: stats.failed });
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

async function repointHoldings(cat, portfolio, deps, lib) {
  if (SLOT !== 0) { console.log("MODE=holdings runs on slot 0 only (91 holdings need no fleet); nothing to do on this slot"); return; }
  const stats = { users: 0, holdings: 0, noId: 0, notHiq: 0, canonical: 0, repointed: 0, viaMovedFrom: 0, viaDerived: 0, gradedPending: 0, unresolved: 0, failed: 0 };
  const lines = [];
  let intended = 0;
  await forEachPage(portfolio, { query: "SELECT c.id, c.userId, c.holdings FROM c", parameters: [] }, async (docs) => {
    for (const doc of docs) {
      stats.users++;
      for (const [hid, h] of Object.entries(doc.holdings ?? {})) {
        stats.holdings++;
        const id = String(h.hobbyiqCardId || h.cardId || "");
        if (!id) { stats.noId++; continue; }
        if (!id.startsWith("hiq:")) { stats.notHiq++; continue; }
        try {
          if (await pointRead(cat, id, id)) { stats.canonical++; continue; }
          const { candidates, tier } = holdingTargetCandidates({ ...h, hobbyiqCardId: id }, deps);
          const parentId = tier ? id.split(":").slice(0, -1).join(":") : id;
          let target = null, via = null;
          const { resources: moved } = await retry(() => cat.items.query({ query: "SELECT TOP 1 c.id FROM c WHERE c.movedFrom = @old", parameters: [{ name: "@old", value: parentId }] }).fetchAll());
          if (moved?.[0]?.id) { target = String(moved[0].id); via = "moved-from"; }
          if (!target) {
            for (const cand of candidates) {
              const candParent = tier ? cand.split(":").slice(0, -1).join(":") : cand;
              if (await pointRead(cat, candParent, candParent)) { target = candParent; via = "derived"; break; }
            }
          }
          if (!target) { stats.unresolved++; lines.push(`  unresolved ${hid.slice(0, 8)} ${h.playerName ?? ""} #${h.cardNumber ?? ""} "${h.setName ?? ""}"  ${id}`); continue; }
          let newId = target;
          if (tier) { newId = `${target}:${tier}`; if (!(await pointRead(cat, newId, newId))) stats.gradedPending++; }
          intended++;
          lines.push(`  ${APPLY ? "re-pointed" : "would re-point"} ${hid.slice(0, 8)} ${h.playerName ?? ""} #${h.cardNumber ?? ""}: ${id} -> ${newId}  (${via}${tier ? ", graded child pending" : ""})`);
          if (APPLY) {
            await retry(() => portfolio.item(doc.id, doc.userId).patch([
              { op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId },
              { op: "set", path: `/holdings/${hid}/cardId`, value: newId },
              { op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "rename-setkey-to-product" },
              { op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() },
              { op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: id },
            ]));
          }
          stats.repointed++;
          if (via === "moved-from") stats.viaMovedFrom++; else stats.viaDerived++;
        } catch (e) {
          stats.failed++;
          lines.push(`  failed ${hid.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }
    }
    return true;
  });
  for (const l of lines) console.log(l);
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users / holdings         ${f(stats.users)} / ${f(stats.holdings)}`);
  console.log(`  no id / vendor id        ${f(stats.noId)} / ${f(stats.notHiq)}`);
  console.log(`  already canonical        ${f(stats.canonical)}   <- the id names a catalog row`);
  console.log(`  RE-POINTED               ${f(stats.repointed)}   <- via the survivor's movedFrom ${f(stats.viaMovedFrom)}, derived and confirmed ${f(stats.viaDerived)}; graded child pending ${f(stats.gradedPending)}`);
  console.log(`  unresolved               ${f(stats.unresolved)}   <- no target could be confirmed; reported, never guessed`);
  console.log(`  failed                   ${f(stats.failed)}`);
  if (APPLY) lib.reportWrites({ job: "rename-setkey-to-product", intended, written: stats.repointed, failed: stats.failed });
}

module.exports = { ruledProducts, identityParts, decideProductRow, decideHyphenRow, hyphenatedTwin, holdingTargetCandidates, productPopulation };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
