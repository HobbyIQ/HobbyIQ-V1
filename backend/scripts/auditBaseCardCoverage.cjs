#!/usr/bin/env node
// CF-CATALOG-BASE-COVERAGE-AUDIT (Drew, 2026-08-12: "quantify missing cards").
//
// WHY POINT READS. card_catalog partitions on /cardId, and canonical rows are
// keyed id === cardId === slug. That makes any aggregate a fan-out across
// millions of logical partitions — a bare `SELECT VALUE COUNT(1)` ran past nine
// minutes and was killed. The same key makes a point read ~1 RU / ~40ms. So
// this audit never scans: it asks for exact base-card slugs by name.
//
// WHAT IT MEASURES. The gap found on 2026-08-12 was not "a set is missing" —
// 2023 Topps Chrome #1 (Rutschman) reads fine. It was that individual players'
// BASE rows are absent while their PARALLELS exist: 2023 Topps Chrome Acuna had
// only #39 purple-refractor and #39 X-Fractor, no base #39. 2024 Topps Chrome
// Skenes had no numeric-card row at all. A base card missing under a populated
// set is invisible to every "does this set exist" check.
//
// Usage:
//   node scripts/auditBaseCardCoverage.cjs                    # default matrix
//   node scripts/auditBaseCardCoverage.cjs --years 2023,2024 --sets topps-chrome
//   node scripts/auditBaseCardCoverage.cjs --max 400 --json out.json
//
// COSMOS_CONNECTION_STRING must be piped in from App Service settings; never
// write it to disk.

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const SPORT = argVal("--sport", "baseball");
const YEARS = argVal("--years", "2018,2019,2020,2021,2022,2023,2024,2025,2026")
  .split(",").map((s) => Number(s.trim())).filter(Boolean);
const SETS = argVal("--sets", "topps-chrome,bowman-chrome,topps,bowman")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_N = Number(argVal("--max", "400"));
const CONCURRENCY = Number(argVal("--concurrency", "24"));
const JSON_OUT = argVal("--json", "");

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) {
  console.error("COSMOS_CONNECTION_STRING is unset. Pipe it in from App Service settings.");
  process.exit(1);
}
const container = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("card_catalog");

const baseSlug = (year, setKey, n) =>
  `hiq:${SPORT}:${year}:${setKey}:${n}:base:no-auto`;

// Bounded-concurrency map. Point reads are cheap but not free, and firing 400
// at once just invites 429s on a shared container.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function readOne(id, attempt = 0) {
  try {
    const r = await container.item(id, id).read();
    return { id, hit: !!r.resource, ru: r.requestCharge || 0, row: r.resource };
  } catch (e) {
    if (e.code === 404) return { id, hit: false, ru: 1 };
    // 429 / transient: back off and retry rather than scoring it a miss. A
    // throttled read reported as "missing" would manufacture a fake gap.
    if (attempt < 4 && (e.code === 429 || e.code === 503 || e.code === "ECONNRESET")) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      return readOne(id, attempt + 1);
    }
    return { id, hit: false, ru: 0, error: e.code || e.message };
  }
}

(async () => {
  console.log(`base-card coverage — sport=${SPORT} sets=${SETS.join(",")} years=${YEARS.join(",")} n=1..${MAX_N}\n`);
  const report = [];
  let totalRu = 0;

  for (const setKey of SETS) {
    for (const year of YEARS) {
      const ids = Array.from({ length: MAX_N }, (_, i) => baseSlug(year, setKey, i + 1));
      const results = await mapLimit(ids, CONCURRENCY, (id) => readOne(id));
      totalRu += results.reduce((s, r) => s + (r.ru || 0), 0);

      const errors = results.filter((r) => r.error);
      const hitIdx = results.map((r, i) => (r.hit ? i + 1 : 0)).filter(Boolean);
      if (hitIdx.length === 0) {
        console.log(`${setKey} ${year}   ABSENT — no base card found in 1..${MAX_N}`);
        report.push({ setKey, year, present: 0, highest: 0, missing: [], status: "absent" });
        continue;
      }

      // Only count gaps BELOW the highest present card. Past that we cannot
      // tell a missing card from the end of the checklist, and guessing the
      // set size would invent gaps that do not exist.
      const highest = hitIdx[hitIdx.length - 1];
      const present = new Set(hitIdx);
      const missing = [];
      for (let n = 1; n <= highest; n++) if (!present.has(n)) missing.push(n);

      const pct = (((highest - missing.length) / highest) * 100).toFixed(1);
      const flag = missing.length === 0 ? "" : missing.length > highest * 0.05 ? "  <== GAP" : "";
      console.log(
        `${setKey} ${year}   ${String(highest - missing.length).padStart(4)}/${String(highest).padEnd(4)} = ${pct.padStart(5)}%   missing=${missing.length}` +
        (missing.length ? `  e.g. ${missing.slice(0, 12).join(",")}${missing.length > 12 ? "…" : ""}` : "") +
        (errors.length ? `  [${errors.length} read errors]` : "") + flag,
      );
      report.push({ setKey, year, present: highest - missing.length, highest, missing,
        coveragePct: Number(pct), readErrors: errors.length, status: missing.length ? "partial" : "complete" });
    }
  }

  const gaps = report.filter((r) => r.status !== "complete");
  const totalMissing = report.reduce((s, r) => s + r.missing.length, 0);
  console.log(`\n${report.length} set-years audited, ${gaps.length} with gaps, ${totalMissing} missing base cards, ${Math.round(totalRu)} RU total`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ sport: SPORT, maxN: MAX_N, report }, null, 2));
    console.log(`wrote ${JSON_OUT}`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
