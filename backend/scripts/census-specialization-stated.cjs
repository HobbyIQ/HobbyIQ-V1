#!/usr/bin/env node
/**
 * CENSUS: SPECIALIZATION-STATED, READ ONLY. (Drew's Maddux, 2026-09-04)
 *
 * Measures the population the new IMPROVE subclass can repair, the population
 * it CANNOT yet repair and exactly which leg holds each row back -- over the
 * Tiffany + Traded class #1715 named:
 *
 *   6,299 rows whose TITLE says Tiffany carry a slug that does not
 *  27,538 rows whose TITLE says Traded sit under flagship `:topps:`
 *
 * WHAT IT WRITES: nothing. Not one row of sold_comps or card_catalog is
 * touched, and the script has no --apply. The repair is the Great Rematch's
 * job under `scope=improve`; this is the diff that comes before the write.
 *
 * THE THREE BUCKETS, per (year, storedKey, derivedKey):
 *
 *   eligibleNow       all five legs hold TODAY. `scope=improve` would write
 *                     these on the next apply pass, under the canary gate.
 *   pendingChecklist  every leg holds EXCEPT L3, and the missing backing is a
 *                     `topps-traded-tiffany` checklist -- the 1984-1991 set
 *                     being staged in a parallel PR. These become eligible the
 *                     day it lands, with NO code change, which is the point of
 *                     asking the question as "is it backed?" rather than
 *                     hard-coding an answer.
 *   conflict          stays CONFLICT, reported BY FAILING LEG so the count is
 *                     actionable rather than a lump.
 *
 * AND A SIDE CENSUS, report-only: how many flagship pools carry BOTH a Tiffany
 * and a non-Tiffany sale IN THE SAME GRADE TIER. That is the pricing damage as
 * it exists today -- the Maddux pool is one of them -- and it is the number the
 * repair is judged by, because a pool with only one kind of sale in a tier was
 * never mispriced however wrong its key.
 *
 * Usage (read-only; the connection string is piped in, never written to disk):
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
 *     --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *   node backend/scripts/census-specialization-stated.cjs [--years=1984-1991] [--limit=N] [--json=path]
 */

const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "rematch-sold-comps.cjs"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const LIMIT = Number(arg("limit", "0")) || 0;
const JSON_OUT = arg("json", "");
const f = (n) => Number(n).toLocaleString("en-US");

/** The title vocabulary this census is scoped to. A whole-container census is
 *  the Great Rematch's job; this one refuses that scope by construction. */
const SAYS_TIFFANY = /\btiffany\b/i;
const SAYS_TRADED = /\btraded\b/i;

/** The ordinary IMPROVE gate's loose predicate, verbatim from the runner.
 *  L3 does NOT use it -- see `K.isStrictChecklistSource`, the allowlist of
 *  named scraped sources, and STRICT_CHECKLIST_SOURCES for the measurement
 *  that retired the subtractive version. */
const CHECKLIST_SOURCE_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);
  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    isMultiCardLot: pti.isMultiCardLot,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
  };

  // ── the two catalog facts, cached exactly as the runner caches them ───────
  const catRowCache = new Map();
  const catRow = async (slug) => {
    if (!slug) return null;
    if (catRowCache.has(slug)) return catRowCache.get(slug);
    let out = null;
    try { out = (await cat.item(slug, slug).read()).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    catRowCache.set(slug, out);
    return out;
  };
  const sourceText = (r) => `${String(r?.source ?? r?.sourceSystem ?? "")},${Array.isArray(r?.sources) ? r.sources.join(",") : ""}`;
  const backed = async (slug) => {
    const r = await catRow(slug);
    if (!r) return false;
    const src = sourceText(r);
    return CHECKLIST_SOURCE_RE.test(src) || r.checklistBacked === true;
  };
  const backedStrict = async (slug) => {
    const r = await catRow(slug);
    if (!r) return false;
    const named = [r.source, r.sourceSystem, ...(Array.isArray(r.sources) ? r.sources : [])];
    return named.some((s) => K.isStrictChecklistSource(s));
  };
  const flagNumsCache = new Map();
  const flagshipNumbers = async (year, setKey) => {
    const key = `${year}|${setKey}`;
    if (flagNumsCache.has(key)) return flagNumsCache.get(key);
    let out = null;
    try {
      const { resources } = await cat.items.query({
        query: `SELECT c.cardNumber, c.source FROM c WHERE c.setKey = @sk AND c.cardYear = @y`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll();
      const real = (resources ?? []).filter((r) => K.isStrictChecklistSource(r?.source));
      out = real.length ? new Set(real.map((r) => String(r.cardNumber ?? "").toUpperCase())) : null;
    } catch { out = null; }
    flagNumsCache.set(key, out);
    return out;
  };
  const flagshipLists = async (stored) => {
    const nums = await flagshipNumbers(stored?.cardYear, String(stored?.setKey ?? "").toLowerCase());
    if (!nums) return null;
    return nums.has(String(stored?.cardNumber ?? "").toUpperCase());
  };

  // ── the scoped read ───────────────────────────────────────────────────────
  // Scoped by TITLE VOCABULARY, not by year: #1715's two measured populations
  // are defined that way and a year filter would report a different number
  // than the one this PR is judged against.
  console.log("census-specialization-stated  READ ONLY -- nothing is written\n");
  console.log("  scope: sold_comps rows whose TITLE says tiffany or traded");

  const query = {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.cardYear, c.setKey, c.setName,
                   c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport, c.playerName,
                   c.gradeCompany, c.gradeValue, c.price, c.source, c.soldDate
            FROM c WHERE CONTAINS(LOWER(c.title ?? ''), 'tiffany') OR CONTAINS(LOWER(c.title ?? ''), 'traded')`,
  };

  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const buckets = new Map();      // "year|stored|derived" -> {eligibleNow, pending, conflict:Map(leg->n)}
  const legTotals = new Map();
  const samples = { eligibleNow: [], pending: [], conflict: [] };
  const poolTiers = new Map();    // storedSlug|gradeTier -> {tiffany, plain, tiffanyPrices, plainPrices}
  let seen = 0, ladderRows = 0, eligibleNow = 0, pending = 0, conflict = 0, notLadder = 0;

  const it = pool.items.query(query, { maxItemCount: 500 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const row of resources ?? []) {
      if (LIMIT && seen >= LIMIT) { console.log(`  (stopped at the LIMIT of ${f(LIMIT)} rows)`); break; }
      seen++;
      const title = String(row.title ?? "");
      const stored = storedIdentity(row, deps);
      const der = deriveIdentity(row, deps);

      // ── the side census, computed for EVERY row and independent of class ──
      // A pool's damage is a fact about the pool, not about whether the
      // classifier can repair the row. Keyed on the STORED slug and the
      // STORED grade tier, because that is the pool a reader actually prices
      // from today.
      const tier = K.gradeToken(stored);
      const slug = String(row.cardId ?? "");
      if (slug) {
        const pk = `${slug}||${tier}`;
        if (!poolTiers.has(pk)) poolTiers.set(pk, { tiffany: 0, plain: 0, tPrice: [], pPrice: [] });
        const e = poolTiers.get(pk);
        const price = Number(row.price);
        if (SAYS_TIFFANY.test(title)) { e.tiffany++; if (Number.isFinite(price)) e.tPrice.push(price); }
        else { e.plain++; if (Number.isFinite(price)) e.pPrice.push(price); }
      }

      if (!der.ok) continue;
      if (!K.isSpecializationOf(der.identity.setKey, stored.setKey)) { notLadder++; continue; }
      ladderRows++;

      const spec = {
        derivedBackedStrict: await backedStrict(der.slug),
        storedFlagshipListsCardNumber: await flagshipLists(stored),
      };
      const res = K.classifyRow({
        row, stored, derived: der.identity,
        checklistBacked: await backed(der.slug),
        derivationReasons: der.reasons,
        storedSlug: row.cardId, baseDestSlug: der.baseSlug ?? null, baseDestBacked: false,
        parserSaysLot: (() => { try { return !!deps.isMultiCardLot(title); } catch { return false; } })(),
        autoByCardNumber: der.autoByCardNumber === true,
        ...spec,
      });

      const bk = `${stored.cardYear}|${stored.setKey}|${der.identity.setKey}`;
      if (!buckets.has(bk)) buckets.set(bk, { eligibleNow: 0, pending: 0, conflict: new Map() });
      const b = buckets.get(bk);
      const line = `${row.id}  "${title.slice(0, 64)}"  ${K.renderIdentity(stored)} -> ${K.renderIdentity(der.identity)}`;

      if (res.klass === K.IMPROVE && res.subclass === K.SPECIALIZATION_STATED && res.writable) {
        b.eligibleNow++; eligibleNow++;
        if (samples.eligibleNow.length < 25) samples.eligibleNow.push(line);
        continue;
      }
      // The evidence is recomputed rather than read off `res`, because a
      // qualifying-but-refused row (a G1-G6 refusal, or PROTECTED) is NOT
      // pending-a-checklist -- it is a conflict for a different reason, and
      // conflating the two would report the staged checklist as closing rows
      // it cannot close.
      const ev = K.specializationStatedEvidence({
        row, stored, derived: der.identity, axes: res.axes,
        derivedBacked: spec.derivedBackedStrict,
        storedFlagshipListsCardNumber: spec.storedFlagshipListsCardNumber,
      });
      const legs = ev.qualifies
        ? (res.improveRefusals?.length ? res.improveRefusals : [`tier:${res.tier}`])
        : ev.failed;
      // PENDING CHECKLIST: the ONLY failing leg is L3, and the destination is
      // a Topps Traded Tiffany row -- the set the parallel PR is staging.
      // Every other L3 failure is a different missing checklist and is
      // reported as a conflict, because a checklist nobody is staging closes
      // nothing.
      const onlyL3 = ev.failed.length === 1 && ev.failed[0] === "derived-not-checklist-backed";
      if (onlyL3 && der.identity.setKey === "topps-traded-tiffany") {
        b.pending++; pending++;
        if (samples.pending.length < 25) samples.pending.push(line);
        continue;
      }
      conflict++;
      for (const leg of legs) {
        const short = String(leg).split(":").slice(0, 2).join(":");
        bump(b.conflict, short);
        bump(legTotals, short);
      }
      if (samples.conflict.length < 25) samples.conflict.push(`${line}   [${legs.join(",")}]`);
    }
    if (LIMIT && seen >= LIMIT) break;
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`\n  rows read              ${f(seen)}`);
  console.log(`  on the ladder          ${f(ladderRows)}   (stored key is an ancestor of the derived key)`);
  console.log(`  not on the ladder      ${f(notLadder)}   (a title word is not a product move -- never this subclass)`);
  console.log(`\nSPECIALIZATION-STATED`);
  console.log(`  eligible now           ${f(eligibleNow)}   scope=improve would write these under the canary gate`);
  console.log(`  pending checklist      ${f(pending)}   every leg but L3; eligible the day the Traded Tiffany checklist lands`);
  console.log(`  stays CONFLICT         ${f(conflict)}`);

  console.log(`\nPER (year, storedKey -> derivedKey)`);
  const rows = [...buckets.entries()].sort((a, b) => (b[1].eligibleNow + b[1].pending) - (a[1].eligibleNow + a[1].pending));
  console.log(`  ${"year".padEnd(6)}${"stored -> derived".padEnd(46)}${"now".padStart(9)}${"pending".padStart(10)}${"conflict".padStart(10)}`);
  for (const [k, v] of rows) {
    const [year, s, dk] = k.split("|");
    const c = [...v.conflict.values()].reduce((a, n) => a + n, 0);
    if (!v.eligibleNow && !v.pending && !c) continue;
    console.log(`  ${String(year).padEnd(6)}${`${s} -> ${dk}`.padEnd(46)}${f(v.eligibleNow).padStart(9)}${f(v.pending).padStart(10)}${f(c).padStart(10)}`);
  }

  console.log(`\nSTAYS CONFLICT, BY FAILING LEG`);
  for (const [leg, n] of [...legTotals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(9)}  ${leg}`);
  }

  // ── the side census: pools whose grade tier holds both kinds of sale ──────
  const collided = [...poolTiers.entries()].filter(([, e]) => e.tiffany > 0 && e.plain > 0);
  const psa10 = collided.filter(([k]) => k.endsWith("||PSA|10"));
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`\nSIDE CENSUS (report only): pools carrying BOTH kinds of sale in ONE grade tier`);
  console.log(`  that is the pricing damage as it stands today -- a tier with only one kind`);
  console.log(`  of sale was never mispriced, however wrong its key.`);
  console.log(`  colliding (pool, tier) pairs   ${f(collided.length)}`);
  console.log(`  of which PSA 10                ${f(psa10.length)}`);
  console.log(`  distinct pools affected        ${f(new Set(collided.map(([k]) => k.split("||")[0])).size)}`);
  const worst = collided
    .map(([k, e]) => ({ k, e, mt: med(e.tPrice), mp: med(e.pPrice) }))
    .filter((x) => x.mt !== null && x.mp !== null && x.mp > 0)
    .sort((a, b) => (b.mt / b.mp) - (a.mt / a.mp))
    .slice(0, 15);
  console.log(`\n  worst 15 by median ratio (tiffany median / plain median):`);
  for (const w of worst) {
    const [slug, tier] = w.k.split("||");
    console.log(`    ${(w.mt / w.mp).toFixed(1).padStart(7)}x  ${String(tier).padEnd(8)} n=${String(w.e.tiffany).padStart(4)}/${String(w.e.plain).padStart(5)}  $${w.mt} vs $${w.mp}   ${slug}`);
  }

  for (const [name, arr] of Object.entries(samples)) {
    if (!arr.length) continue;
    console.log(`\nSAMPLE -- ${name} (${arr.length})`);
    for (const l of arr) console.log(`  ${l}`);
  }

  if (JSON_OUT) {
    const out = {
      generatedAt: new Date().toISOString(),
      mode: "READ ONLY",
      scope: "sold_comps rows whose title says tiffany or traded",
      seen, ladderRows, notLadder, eligibleNow, pending, conflict,
      byBucket: [...buckets.entries()].map(([k, v]) => {
        const [year, storedKey, derivedKey] = k.split("|");
        return { year: Number(year), storedKey, derivedKey, eligibleNow: v.eligibleNow, pendingChecklist: v.pending, conflict: Object.fromEntries(v.conflict) };
      }),
      conflictByLeg: Object.fromEntries(legTotals),
      collidingPools: { pairs: collided.length, psa10: psa10.length, distinctPools: new Set(collided.map(([k]) => k.split("||")[0])).size },
      samples,
    };
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log(`\n  census JSON -> ${JSON_OUT}`);
  }
  console.log(`\n  NOTHING WAS WRITTEN. The repair rides scope=improve on the Great Rematch.`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
