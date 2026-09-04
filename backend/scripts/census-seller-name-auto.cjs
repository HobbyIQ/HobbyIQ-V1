#!/usr/bin/env node
/**
 * CENSUS: SELLER-NAME-AUTO, READ ONLY.
 * CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE (2026-09-04)
 *
 * Measures, with the COMMITTED classifier, what the SELLER-NAME-AUTO subclass
 * would do to the population the defect created:
 *
 *   102,621 of 271,664 scanned sold_comps rows carry isAuto=true because the
 *   pool-side detector bounded `auto` on both sides and `autograph` on
 *   NEITHER, so an eBay seller's shop name -- "... FREE SHIP AutographDen" --
 *   read as a signature. 102,482 of them come from that one phrase, across ~40
 *   years: 1991 panini-donruss 1,869; 1983 fleer 1,804; 2024 panini-donruss
 *   1,645; 2019 bowman 1,644; 1982 fleer 1,499.
 *
 * WHAT IT WRITES: nothing. Not one row of sold_comps or card_catalog is
 * touched, and the script has no --apply. The repair is the Great Rematch's
 * job under `scope=improve`; this is the diff that comes before the write.
 *
 * THE THREE BUCKETS, by the classifier's own verdict -- never a
 * re-implementation of it, which is the point of importing `classifyRow`
 * rather than restating its legs:
 *
 *   improve   all five legs hold TODAY. `scope=improve` would write these on
 *             the next apply pass, under the existing canary gate.
 *   conflict  a leg failed and the row is a REAL candidate (S1 held: the shop
 *             name is the only autograph witness). Reported BY FAILING LEG, so
 *             the count is actionable rather than a lump -- overwhelmingly
 *             `checklist-unknown`, which closes with a checklist and no code
 *             change.
 *   stays     the row is not a candidate at all, or a leg that MUST hold
 *             refused it: the checklist says it IS an auto, or the cardNumber
 *             is an auto-subset number. These are the rows the guard exists to
 *             protect.
 *
 * AND THE POOL IMPACT, report-only: how many AUTO pools are majority
 * seller-name base sales. That is the pricing damage as it exists today -- an
 * auto pool whose sales are mostly base cards prices every real autograph in
 * it off base comps -- and it is the number the repair is judged by, because a
 * pool with only one kind of sale was never mispriced however wrong its flag.
 *
 * Usage (read-only; the connection string is piped in, never written to disk):
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
 *     --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *   node backend/scripts/census-seller-name-auto.cjs [--limit=5000] [--json=path]
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
const LIMIT = Number(arg("limit", "5000")) || 5000;
const JSON_OUT = arg("json", "");
const f = (n) => Number(n).toLocaleString("en-US");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
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

  // ── S3, cached per product, exactly as the runner caches it ──────────────
  const autoMapCache = new Map();
  const checklistAutos = async (year, setKey) => {
    const key = `${year}|${setKey}`;
    if (autoMapCache.has(key)) return autoMapCache.get(key);
    let out = new Map();
    try {
      const { resources } = await cat.items.query({
        query: `SELECT c.cardNumber, c.isAuto, c.source FROM c WHERE c.setKey = @sk AND c.cardYear = @y`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll();
      for (const r of resources ?? []) {
        if (!K.isStrictChecklistSource(r?.source)) continue;
        const num = String(r?.cardNumber ?? "").toUpperCase();
        if (!num || r?.isAuto === null || r?.isAuto === undefined || out.has(num)) continue;
        out.set(num, r.isAuto === true);
      }
    } catch { out = new Map(); }
    autoMapCache.set(key, out);
    return out;
  };
  const checklistSaysNotAutoFor = async (identity) => {
    const y = identity?.cardYear, sk = identity?.setKey, num = identity?.cardNumber;
    if (y === null || y === undefined || !sk || !num) return null;
    const m = await checklistAutos(y, sk);
    const hit = m.get(String(num).toUpperCase());
    return hit === undefined ? null : hit === false;
  };

  // ── the sample: stored auto rows whose title carries the shop name ───────
  console.log(`\nSELLER-NAME-AUTO census — READ ONLY, sample of ${f(LIMIT)}\n${"─".repeat(72)}`);
  const rows = [];
  const it = pool.items.query({
    query: `SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.title, c.isAuto, c.sport,
                   c.cardYear, c.setKey, c.setName, c.cardNumber, c.parallel, c.printRun,
                   c.gradeCompany, c.gradeValue, c.source, c.playerName, c.soldPrice
            FROM c WHERE c.isAuto = true AND CONTAINS(LOWER(c.title), 'autographden')`,
    parameters: [{ name: "@n", value: LIMIT }],
  }, { maxItemCount: 1000 });
  while (it.hasMoreResults() && rows.length < LIMIT) {
    const { resources } = await it.fetchNext();
    if (!resources || !resources.length) break;
    rows.push(...resources);
  }
  console.log(`sampled ${f(rows.length)} stored isAuto=true rows carrying the shop token`);

  const bucket = { improve: 0, conflict: 0, stays: 0 };
  const byLeg = new Map();
  const byProduct = new Map();
  const autoPools = new Map();   // auto pool -> { total, sellerBase }
  const examples = [];

  for (const row of rows) {
    const stored = storedIdentity(row, deps);
    const der = deriveIdentity(row, deps);
    const derived = der.ok ? der.identity : null;

    const candidate = stored?.isAuto === true && K.autographWitnessIsSellerNameOnly(row.title);
    const saysNotAuto = candidate ? await checklistSaysNotAutoFor(stored) : null;

    const res = K.classifyRow({
      row, stored, derived, derivationReasons: der.reasons,
      storedSlug: row.cardId,
      baseDestSlug: der.baseSlug ?? null,
      parserSaysLot: deps.isMultiCardLot ? !!deps.isMultiCardLot(row.title) : false,
      autoByCardNumber: der.autoByCardNumber === true,
      checklistSaysNotAuto: saysNotAuto,
    });

    if (res.subclass === K.SELLER_NAME_AUTO) {
      bucket.improve++;
      const p = `${stored.cardYear} ${stored.setKey}`;
      byProduct.set(p, (byProduct.get(p) ?? 0) + 1);
      if (examples.length < 12) examples.push(`${p} #${stored.cardNumber} | ${String(row.title).slice(0, 88)}`);
    } else if (candidate) {
      // A real candidate the classifier refused. NAME THE LEG -- an unnamed
      // bucket is the thing this census exists to eliminate.
      //
      // TWO SHAPES REFUSE THESE ROWS, and they are refused in different
      // places, so both have to be read:
      //
      //   1. The subclass's own legs, on the AGREE path, carried as
      //      `not-seller-name-auto:<legs>`. That is the ordinary case, and it
      //      is overwhelmingly `checklist-unknown`: the row is repairable the
      //      day a checklist for its product lands, with NO code change.
      //   2. The row never reached the AGREE path at all, because the
      //      derivation disagrees with the stored row on ANOTHER AXIS
      //      (`changed:setKey`, `changed:cardNumber`) or could not be derived
      //      (UNDERIVABLE). S5 is what refuses these, and refusing them is
      //      correct: a row whose product or number is also in dispute is not
      //      a row whose only defect is a shop name, and the isAuto repair
      //      must not ride along on a reading nobody has settled. Measured:
      //      `bowmans-best -> bowman`, `bowman-heritage -> bowman`,
      //      `topps-allen-ginter -> topps` -- all RULED distinct products --
      //      plus `setkey-unknown-unsupported` on 2005-06 Bazooka.
      const legs = (res.reasons ?? []).find((r) => String(r).startsWith("not-seller-name-auto:"));
      let named;
      if (legs) named = String(legs).slice("not-seller-name-auto:".length);
      else if (res.klass === K.UNDERIVABLE) named = "S5:underivable";
      else {
        const moved = [...(res.axes?.changed ?? []), ...(res.axes?.dropped ?? [])]
          .filter((a) => a !== "isAuto");
        named = moved.length ? `S5:identity-axis-moved:${moved.join(",")}` : `S5:${res.klass}`;
      }
      // A refusal on the two protective legs is a row that SHOULD stay.
      const protective = named.includes("checklist-says-auto") || named.includes("cardnumber-is-auto-subset");
      if (protective) bucket.stays++; else bucket.conflict++;
      for (const leg of named.split(",")) byLeg.set(leg, (byLeg.get(leg) ?? 0) + 1);
    } else {
      bucket.stays++;
    }

    // Pool impact: the AUTO pool this row sits in, and how much of it is
    // seller-name base. Keyed by the row's own address, which is what the
    // pool reader ORs on.
    const poolKey = row.cardId || row.hobbyiqCardId;
    if (poolKey && stored?.isAuto === true) {
      const e = autoPools.get(poolKey) ?? { total: 0, sellerBase: 0 };
      e.total++;
      if (candidate) e.sellerBase++;
      autoPools.set(poolKey, e);
    }
  }

  const n = rows.length || 1;
  const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
  console.log(`\nVERDICTS (the committed classifier's own)\n${"─".repeat(72)}`);
  console.log(`  IMPROVE  (auto -> base identity)  ${String(f(bucket.improve)).padStart(7)}  ${pct(bucket.improve)}`);
  console.log(`  CONFLICT (candidate, leg failed)  ${String(f(bucket.conflict)).padStart(7)}  ${pct(bucket.conflict)}`);
  console.log(`  STAYS    (protected or no case)   ${String(f(bucket.stays)).padStart(7)}  ${pct(bucket.stays)}`);

  if (byLeg.size) {
    console.log(`\nCONFLICT BY FAILING LEG\n${"─".repeat(72)}`);
    [...byLeg.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${String(f(v)).padStart(7)}  ${k}`));
  }
  if (byProduct.size) {
    console.log(`\nIMPROVE BY PRODUCT (top 15)\n${"─".repeat(72)}`);
    [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([k, v]) => console.log(`  ${String(f(v)).padStart(7)}  ${k}`));
  }

  // ── the pricing damage ───────────────────────────────────────────────────
  const polluted = [...autoPools.values()].filter((e) => e.sellerBase * 2 > e.total).length;
  const anyPollution = [...autoPools.values()].filter((e) => e.sellerBase > 0).length;
  console.log(`\nPOOL IMPACT (report only)\n${"─".repeat(72)}`);
  console.log(`  auto pools touched by the sample          ${String(f(autoPools.size)).padStart(7)}`);
  console.log(`  ...carrying ANY seller-name base sale     ${String(f(anyPollution)).padStart(7)}`);
  console.log(`  ...MAJORITY seller-name base sales        ${String(f(polluted)).padStart(7)}`);
  console.log(`\n  A majority-base auto pool prices every real autograph in it off base comps.`);

  if (examples.length) {
    console.log(`\nIMPROVE EXAMPLES (real titles)\n${"─".repeat(72)}`);
    examples.forEach((e) => console.log(`  ${e}`));
  }

  const out = {
    scope: "seller-name-auto", readOnly: true, sampled: rows.length,
    verdicts: bucket,
    conflictByLeg: Object.fromEntries([...byLeg.entries()].sort((a, b) => b[1] - a[1])),
    improveByProduct: Object.fromEntries([...byProduct.entries()].sort((a, b) => b[1] - a[1])),
    poolImpact: { autoPoolsTouched: autoPools.size, withAnySellerBase: anyPollution, majoritySellerBase: polluted },
  };
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  console.log("\nNOTHING WAS WRITTEN. This script has no --apply.\n");
}

main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
