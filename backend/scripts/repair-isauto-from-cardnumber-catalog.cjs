#!/usr/bin/env node
/**
 * repair-isauto-from-cardnumber-catalog.cjs -- the card-number prefix IS the
 * auto boundary, and the product's OTHER checklists say which prefixes are.
 *
 * CF-ISAUTO-IS-THE-CARD-NUMBER-PREFIX (Drew, 2026-08-29, the CPA-MWI picker:
 * checklistinsider rows "Gold Border /50" with isAuto:false on a CPA- card --
 * "that source's auto boundary is wrong (isAuto is the card-number prefix)").
 * Measured 2026-08-29, read-only: 98,382 of 4,092,438 checklistinsider-
 * 2026-08-27 rows carry isAuto=false on an auto-prefixed number -- 2025
 * bowman (basketball) 13,927, 2025 bowman-draft 9,528, 2024 bowman-draft
 * 5,513, 2025 topps-chrome-platinum 5,487, 2026 bowman-chrome 5,058 ...
 *
 * TWO SHAPES, because the slug generator already forces `:auto` for nine
 * prefixes (CPA, BCPA, BDCPA, CDA, TCPA, CRA, BSPA, BPA, BDA -- hobbyIqCardId's
 * AUTO_ONLY_CARDNUMBER_PREFIX): 41,609 CPA- rows sit at a `:auto` id with the
 * FIELD false (a HEAL -- the field conforms to its own id, nothing moves),
 * while every BDC- / PA- / RA- row sits at `:no-auto` with the field false (a
 * MOVE to `:auto` iff the evidence says that prefix is signed in that product).
 *
 * THE RULING IS PER (product, prefix) AND COMES FROM THE OTHER CHECKLISTS.
 * Doctrine (memory: "isAuto boundary is cardNumber, not text"): never the
 * parallel name, never a category word. For each (sport, year, setKey,
 * prefix) every CHECKLIST-authority source FAMILY except the ones under repair
 * votes with its own row majority (checklistcenter 400 auto vs 0 -> "auto");
 * the majority of voting families is the ruling; a tie, or no other family
 * covering that prefix, is NO ruling. Vendor and derived rows never vote
 * (catalogAuthority). A family folds the dated scrape runs
 * (beckett-scraped-2026-08-25 and -26 are ONE voter) so a source scraped
 * twice does not outvote one scraped once. The sources under repair are the
 * defendant: their own rows are reported, never counted.
 *
 * With no ruling, a row whose field disagrees with its OWN id is still healed
 * to the id -- the rule moveCatalogRow applies to every row it touches (the
 * slug's segment 6 is the boundary) -- and a row that agrees with its id is
 * left alone. A ruling that contradicts the generator's forced list (the
 * evidence says CPA- is NOT signed) is REFUSED and reported: the generator
 * mints every sale's slug, so a `:no-auto` CPA row would be an address no
 * sale can reach. That is a vocabulary decision, not a fleet's.
 *
 * A move goes through moveCatalogRow with { isAuto } as the changed field and
 * sold_comps as salesContainer: sales re-point BEFORE the old row is deleted;
 * a row already at the target slug is a fold / replace by authority; the old
 * slug's graded children are retired (regenerable).
 *
 * SHARDED BY PRODUCT (sha1(sport|year|setKey) % SLOTS), not by row: the
 * evidence is one GROUP BY per product (~7k RU on 2025 bowman-draft), and a
 * row-hash shard would make every slot recompute every product's table. The
 * biggest product (2025 bowman basketball) is 2.5% of the source, so the
 * shards balance. Resumable by predicate: a healed or moved row no longer
 * disagrees, so a relaunch finds only what is left.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY / APPLY (report only by
 *      default); SOURCES (default checklistinsider-2026-08-27); SPORTS, YEARS
 *      (comma lists); SLOT/SLOTS; RUN_MINUTES=140; CONCURRENCY=8; LIMIT=0
 *      (actionable rows); VERBOSE=true prints every (product, prefix) line.
 */
"use strict";
const crypto = require("node:crypto");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
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
const SHARD_SCOPE = runnerShardScope({ label: "repair-isauto-from-cardnumber-catalog" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const VERBOSE = process.env.VERBOSE === "true";
const SOURCES = String(process.env.SOURCES || "checklistinsider-2026-08-27").split(",").map((s) => s.trim()).filter(Boolean);
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// FORCE_AUTO_PREFIXES: prefixes that are autographs BY DEFINITION, ruled auto
// whatever the other sources say (Drew, 2026-08-30: "CPA is what?" -> Chrome
// Prospect Autograph; the one source saying no-auto for CPA rows is wrong).
// The runner has no dedicated input for this; its `scope` input (SCOPE env, default "refractor") doubles as the list.
const FORCE_AUTO_PREFIXES = new Set(String(process.env.FORCE_AUTO_PREFIXES || (process.env.SCOPE && process.env.SCOPE !== "refractor" ? process.env.SCOPE : "") || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const f = (n) => Number(n).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ─────────────────────────────────────────────────────────────────────

/** A source FAMILY: the dated scrape runs and the -graded twin fold into one
 *  voter. beckett-scraped-2026-08-25 -> beckett; checklistcenter-2026-08-29 ->
 *  checklistcenter; baseballcardpedia-ladders-2026-08-30 -> baseballcardpedia. */
const familyOf = (source) => String(source ?? "").toLowerCase().trim()
  .replace(/-graded$/, "")
  .replace(/-(?:scraped-|ladders-)?\d{4}-\d{2}-\d{2}$/, "");

/** "CPA-MWI" -> "CPA"; "150" -> null. The Cosmos side is
 *  LEFT(c.cardNumber, INDEX_OF(c.cardNumber, "-")) on the same rows. */
const prefixOf = (cardNumber) => { const s = String(cardNumber ?? "").toUpperCase(); const i = s.indexOf("-"); return i > 0 ? s.slice(0, i) : null; };

/** Slug layout hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N] --
 *  segment 6 is the boundary. */
const idSaysAuto = (id) => String(id).split(":")[6] === "auto";
const withAutoSegment = (id, isAuto) => { const p = String(id).split(":"); p[6] = isAuto ? "auto" : "no-auto"; return p.join(":"); };

/**
 * The per-prefix ruling for ONE product.
 *
 * groups: [{ source, isAuto, prefix, n }] -- the GROUP BY over every source's
 * un-graded rows of the product. opts.repairFamilies: the families under
 * repair (never vote). opts.isChecklist(source): catalogAuthority's verdict.
 *
 * Returns Map<prefix, { prefix, ruling: true|false|null, reason, voters:
 * [{ family, auto, noAuto, verdict }], target: { auto, noAuto, unset } }>.
 */
function rulePrefixes(groups, opts) {
  const byPrefix = new Map();
  for (const g of groups) {
    const prefix = String(g.prefix ?? "").toUpperCase();
    if (!prefix || !/[A-Z]/.test(prefix)) continue; // "1-A": a numeric prefix is not an auto boundary
    const n = Number(g.n) || 0;
    if (!n) continue;
    let e = byPrefix.get(prefix);
    if (!e) { e = { target: { auto: 0, noAuto: 0, unset: 0 }, families: new Map() }; byPrefix.set(prefix, e); }
    const family = familyOf(g.source);
    const flag = g.isAuto === true ? "auto" : g.isAuto === false ? "noAuto" : "unset";
    if (opts.repairFamilies.has(family)) { e.target[flag] += n; continue; }
    if (flag === "unset" || !opts.isChecklist(g.source)) continue;
    let v = e.families.get(family);
    if (!v) { v = { family, auto: 0, noAuto: 0 }; e.families.set(family, v); }
    v[flag] += n;
  }
  const out = new Map();
  for (const [prefix, e] of byPrefix) {
    if ((opts.forceAuto ?? FORCE_AUTO_PREFIXES).has(prefix)) {
      out.set(prefix, { prefix, ruling: true, reason: "auto by definition (FORCE_AUTO_PREFIXES)", voters: [], target: e.target });
      continue;
    }
    const voters = [...e.families.values()]
      .map((v) => ({ ...v, verdict: v.auto > v.noAuto ? true : v.noAuto > v.auto ? false : null }))
      .sort((a, b) => (b.auto + b.noAuto) - (a.auto + a.noAuto));
    const yes = voters.filter((v) => v.verdict === true).length;
    const no = voters.filter((v) => v.verdict === false).length;
    let ruling = null;
    let reason;
    if (!voters.length) reason = "no other checklist family covers this prefix";
    else if (yes === no) reason = `tie ${yes}-${no} among ${voters.length} checklist families`;
    else { ruling = yes > no; reason = `${ruling ? "auto" : "no-auto"} by ${Math.max(yes, no)}-${Math.min(yes, no)} of ${voters.length} checklist families`; }
    out.set(prefix, { prefix, ruling, reason, voters, target: e.target });
  }
  return out;
}

/**
 * What one row needs, given its product's ruling for its prefix and whether
 * the slug generator forces `:auto` for that prefix.
 *   agree            field and id both already say the ruling
 *   heal             the id is right, the field is stale -> patch the field
 *   move             the id is wrong -> moveCatalogRow to the flipped slug
 *   skip-no-ruling   no evidence and the field agrees with its id
 *   refuse-generator the evidence says no-auto for a prefix the generator
 *                    forces to :auto -- a vocabulary decision, not a move
 */
function decideRow(row, ruling, generatorForced) {
  const idAuto = idSaysAuto(row.id);
  const field = row.isAuto === true;
  if (ruling === null) return field === idAuto ? { action: "skip-no-ruling" } : { action: "heal", target: idAuto };
  if (generatorForced && ruling === false) return { action: "refuse-generator" };
  if (idAuto === ruling) return field === ruling ? { action: "agree" } : { action: "heal", target: ruling };
  return { action: "move", target: ruling, newSlug: withAutoSegment(row.id, ruling) };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow } = require("../dist/services/catalog/catalogRowOps.service.js");
  const { catalogAuthorityOf } = require("../dist/services/catalog/catalogAuthority.service.js");
  const { computeHobbyIqCardId } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");
  const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
  const isChecklist = (s) => catalogAuthorityOf(String(s ?? "")) === "checklist";
  const repairFamilies = new Set(SOURCES.map(familyOf));
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  const fetchAll = async (spec) => (await retry(() => cat.items.query(spec, { maxItemCount: 1000 }).fetchAll())).resources ?? [];
  console.log(`repair-isauto-from-cardnumber-catalog  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  sources=${SOURCES.join(",")} (families ${[...repairFamilies].join(",")})${SPORTS.length ? `  sports=${SPORTS.join(",")}` : ""}${YEARS.length ? `  years=${YEARS.join(",")}` : ""}  limit=${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  /** Does hobbyIqCardId force `:auto` for this prefix? Asked of the generator
   *  itself, so the list is never re-spelled here. */
  const generatorForces = (product, prefix) => {
    try {
      const slug = computeHobbyIqCardId({ sport: product.sport, year: product.year, setKey: product.setKey, cardNumber: `${prefix}-X`, parallel: "Base", isAuto: false, printRun: null, authoritativeSetKey: true });
      return typeof slug === "string" && slug.split(":")[6] === "auto";
    } catch { return false; }
  };

  // Pass 1: the products the sources under repair cover, biggest first.
  const srcSql = `c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})`;
  const srcParams = SOURCES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const scopeSql = (SPORTS.length ? ` AND c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})` : "")
    + (YEARS.length ? ` AND c.year IN (${YEARS.map((_, i) => `@y${i}`).join(",")})` : "");
  const scopeParams = [...SPORTS.map((s, i) => ({ name: `@sp${i}`, value: s })), ...YEARS.map((y, i) => ({ name: `@y${i}`, value: y }))];
  const products = (await fetchAll({
    query: `SELECT c.sport, c.year, c.setKey, COUNT(1) AS n FROM c WHERE ${srcSql}${scopeSql} AND NOT IS_DEFINED(c.gradeTier) GROUP BY c.sport, c.year, c.setKey`,
    parameters: [...srcParams, ...scopeParams],
  })).filter((p) => p.sport && p.year && p.setKey).sort((a, b) => b.n - a.n);
  const productKey = (p) => `${p.sport}|${p.year}|${p.setKey}`;
  const mine = SLOTS > 1 ? products.filter((p) => shardOf(productKey(p)) === SLOT) : products;
  console.log(`  ${f(products.length)} products in scope (${f(products.reduce((a, p) => a + p.n, 0))} un-graded rows); ${f(mine.length)} in this slot`);

  const stats = { products: 0, prefixes: 0, ruled: 0, noRuling: 0, refusedPrefixes: 0, refusedRows: 0, actionable: 0, healed: 0, moved: 0, folded: 0, replaced: 0, gone: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const table = [];
  const disagreements = [];
  const examples = [];
  let stopReason = null;
  const reasonFor = (r) => `isAuto follows the card-number prefix: ${r.prefix}- is ${r.ruling ? "auto" : "no-auto"} (${r.reason}) -- CF-ISAUTO-IS-THE-CARD-NUMBER-PREFIX`;

  outer:
  for (const product of mine) {
    if (budgetLeft() < 90000) { stopReason = "budget"; break; }
    if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; break; }
    stats.products++;
    const pparams = [{ name: "@sp", value: product.sport }, { name: "@y", value: product.year }, { name: "@k", value: product.setKey }];
    const groups = await fetchAll({
      query: `SELECT c.source, c.isAuto, LEFT(c.cardNumber, INDEX_OF(c.cardNumber, "-")) AS prefix, COUNT(1) AS n FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND IS_STRING(c.cardNumber) AND CONTAINS(c.cardNumber, "-") AND NOT IS_DEFINED(c.gradeTier) GROUP BY c.source, c.isAuto, LEFT(c.cardNumber, INDEX_OF(c.cardNumber, "-"))`,
      parameters: pparams,
    });
    const rulings = rulePrefixes(groups, { repairFamilies, isChecklist });
    const label = `${product.year} ${product.setKey}/${product.sport}`;

    for (const r of rulings.values()) {
      if (budgetLeft() < 90000) { stopReason = "budget"; break outer; }
      if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; break outer; }
      const own = r.target.auto + r.target.noAuto + r.target.unset;
      if (!own) continue; // the sources under repair have no rows with this prefix
      stats.prefixes++;
      const forced = generatorForces(product, r.prefix);
      const line = `  ${label}  ${r.prefix.padEnd(6)} ruling=${(r.ruling === null ? "none" : r.ruling ? "auto" : "no-auto").padEnd(7)} target auto ${r.target.auto} / no-auto ${r.target.noAuto}${r.target.unset ? ` / unset ${r.target.unset}` : ""}${forced ? "  [generator forces :auto]" : ""}  (${r.reason}${r.voters.length ? ": " + r.voters.map((v) => `${v.family} ${v.auto}/${v.noAuto}`).join(", ") : ""})`;
      if (r.ruling === null) stats.noRuling++; else stats.ruled++;
      if (r.ruling === false && forced) {
        stats.refusedPrefixes++; stats.refusedRows += own;
        disagreements.push(line);
        continue;
      }
      // Only the rows that disagree with the ruling (or, with no ruling, with
      // their own id) come back; a healed or moved row drops out on relaunch.
      const disagree = r.ruling === true
        ? `(NOT IS_DEFINED(c.isAuto) OR c.isAuto != true OR CONTAINS(c.id, ":no-auto"))`
        : r.ruling === false
          ? `(NOT IS_DEFINED(c.isAuto) OR c.isAuto != false OR CONTAINS(c.id, ":auto"))`
          : `((c.isAuto = false AND CONTAINS(c.id, ":auto")) OR (c.isAuto = true AND CONTAINS(c.id, ":no-auto")))`;
      const rows = (await fetchAll({
        query: `SELECT c.id, c.cardId, c.isAuto, c.cardNumber FROM c WHERE ${srcSql} AND c.sport = @sp AND c.year = @y AND c.setKey = @k AND STARTSWITH(c.cardNumber, @pfx, true) AND NOT IS_DEFINED(c.gradeTier) AND ${disagree}`,
        parameters: [...srcParams, ...pparams, { name: "@pfx", value: `${r.prefix}-` }],
      })).filter((row) => prefixOf(row.cardNumber) === r.prefix && String(row.id).startsWith("hiq:"));
      if (rows.length || VERBOSE) table.push(`${line}  -> ${f(rows.length)} rows to fix`);
      if (!rows.length) continue;

      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        if (budgetLeft() < 90000) { stopReason = "budget"; stats.notReached += rows.length - i; break outer; }
        if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; stats.notReached += rows.length - i; break outer; }
        await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
          const d = decideRow(row, r.ruling, forced);
          if (d.action !== "heal" && d.action !== "move") return; // the predicate already excluded these
          stats.actionable++;
          try {
            if (d.action === "heal") {
              if (APPLY) await retry(() => cat.item(row.id, row.cardId ?? row.id).patch([
                { op: "set", path: "/isAuto", value: d.target },
                { op: "set", path: "/isAutoRepairedReason", value: r.ruling === null ? "field conformed to its own id (no cross-source ruling)" : reasonFor(r) },
                { op: "set", path: "/isAutoRepairedAt", value: new Date().toISOString() },
              ]));
              stats.healed++;
              if (examples.length < 20) examples.push(`  heal  ${row.id}  isAuto ${row.isAuto} -> ${d.target}`);
              return;
            }
            let full = null;
            try { full = (await retry(() => cat.item(row.id, row.cardId ?? row.id).read())).resource ?? null; } catch (e) { if (e?.code !== 404) throw e; }
            if (!full) { stats.gone++; return; }
            const res = await moveCatalogRow(cat, full, d.newSlug, { isAuto: d.target }, { reason: reasonFor(r), dryRun: !APPLY, salesContainer: pool, retry });
            if (res.action === "move") stats.moved++;
            else if (res.action === "fold") stats.folded++;
            else if (res.action === "replace") stats.replaced++;
            else stats.gone++;
            stats.salesRepointed += res.salesRepointed ?? 0;
            stats.gradedRetired += res.gradedChildrenRetired ?? 0;
            if (examples.length < 20) examples.push(`  ${res.action.padEnd(7)} ${row.id} -> ${d.newSlug}  (${res.decision})`);
          } catch (e) {
            stats.failed++;
            if (stats.failed <= 5) console.log(`  failed ${row.id}: ${String(e?.message ?? e).slice(0, 120)}`);
          }
        }));
      }
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  products (this slot)     ${f(stats.products)} of ${f(mine.length)}`);
  console.log(`  (product, prefix) pairs  ${f(stats.prefixes)}   <- ruled ${f(stats.ruled)}, no ruling ${f(stats.noRuling)}, refused ${f(stats.refusedPrefixes)} (generator disagrees; ${f(stats.refusedRows)} rows)`);
  console.log(`  actionable rows          ${f(stats.actionable)}`);
  console.log(`  REPAIRED                 ${f(stats.healed + stats.moved + stats.folded + stats.replaced)}   <- healed ${f(stats.healed)} (field -> id), moved ${f(stats.moved)}, folded ${f(stats.folded)}, replaced ${f(stats.replaced)}; sales re-pointed ${f(stats.salesRepointed)}, graded children retired ${f(stats.gradedRetired)}`);
  console.log(`  gone before the move     ${f(stats.gone)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (table.length) {
    const cap = VERBOSE ? table.length : 300;
    console.log(`\n  per-product prefix table (${f(table.length)} lines${table.length > cap ? `, first ${cap}` : ""}; VERBOSE=true for every pair):`);
    for (const t of table.slice(0, cap)) console.log(t);
  }
  if (disagreements.length) {
    console.log(`\n  REFUSED -- the evidence says no-auto for a prefix the slug generator forces to :auto (needs a vocabulary ruling, not a move):`);
    for (const d of disagreements) console.log(d);
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "repair-isauto-from-cardnumber-catalog", intended: stats.actionable, written: stats.healed + stats.moved + stats.folded + stats.replaced, skipped: stats.gone, failed: stats.failed });
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

module.exports = { rulePrefixes, decideRow, familyOf, prefixOf, idSaysAuto, withAutoSegment };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
