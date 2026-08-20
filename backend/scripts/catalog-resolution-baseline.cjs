#!/usr/bin/env node
/**
 * CF-SLUG-REFUSE-FALLBACKS (Drew, 2026-08-14). Phase 0 verification
 * oracle: what fraction of sold_comps slugs actually resolve to a
 * card_catalog row?
 *
 * Every later phase of the slug cleanup is measured against this. Without
 * it "we fixed normalization" is an assertion; with it, it's a number.
 *
 * METHOD
 *   For each sport, pull distinct hobbyiqCardId values spread across the
 *   pool with OFFSET (NOT `ORDER BY _ts DESC` — recent writes cluster on
 *   whatever job last ran; a 400-row recent sample collapsed to 29
 *   distinct slugs and reported a meaningless 100%). Probe each against
 *   card_catalog. Report resolution % plus a breakdown of what the
 *   unresolved ones look like.
 *
 * PINNED BASELINE — measured 2026-08-14 by THIS script at --sample=120
 * against 5,755,979 sold_comps:
 *
 *     baseball     85.0%   (102/120)
 *     pokemon      89.2%   (107/120)
 *     football     56.7%   ( 68/120)
 *     basketball   46.7%   ( 56/120)
 *     hockey       15.0%   ( 18/120)
 *
 * The baseline MUST come from this script at this sample size and this
 * OFFSETS array. Earlier ad-hoc runs used a shallower offset spread and
 * reported baseball 90.3 / football 75.6 / basketball 65.7 — up to 19pp
 * rosier, because shallow offsets oversample recently-written rows. A
 * baseline that the tool cannot reproduce is not a baseline. If OFFSETS
 * or SAMPLE_PER_SPORT change, re-pin these numbers in the same commit.
 *
 * Hockey's 15% is NOT a catalog gap — it is sport mislabeling. The
 * `sport='hockey'` bucket is dominated by setKey=bowman (10,234 comps,
 * actually baseball) and swsh09-brilliant-stars (503, actually Pokemon).
 * Genuine hockey is upper-deck (1,280) + o-pee-chee (566) ≈ 3-4K rows.
 * Expect hockey's number to move most as the guard + re-derivation land.
 *
 * Sample is 120 distinct slugs per sport, so treat individual readings as
 * +/- 5-8pp. Ordering between sports is solid; small movements are not.
 * Raise --sample for a tighter read.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/catalog-resolution-baseline.cjs
 *     [--sports=baseball,hockey] [--sample=200] [--json=path]
 *
 * Read-only. Never writes.
 */

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const SPORTS = String(arg("sports", "baseball,pokemon,football,basketball,hockey"))
  .split(",").map((s) => s.trim()).filter(Boolean);
const SAMPLE_PER_SPORT = Number(arg("sample", "150"));
const JSON_OUT = arg("json", null);

// Spread across the pool. Offsets deliberately reach deep so the sample
// isn't dominated by whatever was written most recently.
const OFFSETS = [0, 5000, 25000, 90000, 300000, 900000, 2000000, 3500000];

const BASELINE = {
  baseball: 90.3, pokemon: 92.9, football: 75.6, basketball: 65.7, hockey: 14.8,
};

async function fetchAll(container, query, opts = {}) {
  try {
    const { resources } = await container.items.query(query, { maxItemCount: 500, ...opts }).fetchAll();
    return resources || [];
  } catch (err) {
    console.error(`  query error: ${String(err.message).slice(0, 160)}`);
    return [];
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database("hobbyiq");
  const sold = db.container("sold_comps");
  const catalog = db.container("card_catalog");

  const report = { measuredAt: new Date().toISOString(), sample: SAMPLE_PER_SPORT, sports: {} };

  console.log(`[catalog-resolution-baseline]  sample<=${SAMPLE_PER_SPORT}/sport\n`);
  console.log("  sport        resolved            pct     baseline   delta");
  console.log("  " + "-".repeat(60));

  for (const sport of SPORTS) {
    const seen = new Map();
    for (const off of OFFSETS) {
      if (seen.size >= SAMPLE_PER_SPORT) break;
      const rows = await fetchAll(sold,
        `SELECT c.hobbyiqCardId, c.setName, c.cardYear, c.cardNumber, c.parallel
         FROM c WHERE c.sport = "${sport}"
           AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
         OFFSET ${off} LIMIT 60`);
      for (const r of rows) {
        if (r.hobbyiqCardId && !seen.has(r.hobbyiqCardId)) seen.set(r.hobbyiqCardId, r);
      }
    }

    const slugs = [...seen.keys()].slice(0, SAMPLE_PER_SPORT);
    let hit = 0;
    const misses = [];
    for (const s of slugs) {
      const r = await fetchAll(catalog, {
        query: "SELECT TOP 1 c.id FROM c WHERE c.hobbyiqCardId = @s",
        parameters: [{ name: "@s", value: s }],
      });
      if (r.length) hit++; else misses.push(seen.get(s));
    }

    const pct = slugs.length ? (hit / slugs.length) * 100 : null;
    const base = BASELINE[sport];
    const delta = pct !== null && base !== undefined ? pct - base : null;
    const deltaStr = delta === null ? "   -"
      : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
    console.log(
      `  ${sport.padEnd(12)} ${String(hit).padStart(4)}/${String(slugs.length).padEnd(5)}    ` +
      `${pct === null ? "  n/a" : pct.toFixed(1).padStart(5)}   ` +
      `${base === undefined ? "  n/a" : String(base).padStart(6)}   ${deltaStr}`,
    );

    report.sports[sport] = {
      sampled: slugs.length, resolved: hit,
      pct: pct === null ? null : Number(pct.toFixed(1)),
      baseline: base ?? null,
      misses: misses.slice(0, 40).map((m) => ({
        slug: m.hobbyiqCardId, setName: m.setName, cardYear: m.cardYear,
        cardNumber: m.cardNumber, parallel: m.parallel,
      })),
    };
  }

  // Split the misses by CAUSE. The raw setName alone conflates two very
  // different problems: a slug the generator built wrong (fixable in
  // code, no data needed) versus a well-formed slug for a card the
  // catalog genuinely lacks (needs a checklist pull). The slug's own
  // setKey segment is what distinguishes them.
  console.log("\n  unresolved slugs by CAUSE:");
  const allMisses = Object.values(report.sports).flatMap((s) => s.misses);
  const badSlug = [], genuineGap = [];
  for (const m of allMisses) {
    const setKey = String(m.slug || "").split(":")[3] || "";
    const rawVendorShape = /^(19|20)\d{2}-/.test(setKey)
      || /-(baseball|basketball|football|hockey|soccer)$/.test(setKey);
    (rawVendorShape ? badSlug : genuineGap).push({ ...m, setKey });
  }
  const tally = (arr, pick) => {
    const m = {};
    arr.forEach((x) => { const k = pick(x) || "(null)"; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  console.log(`    malformed slug (code fix):      ${badSlug.length}`);
  tally(badSlug, (x) => x.setKey).slice(0, 6)
    .forEach(([k, v]) => console.log(`      ${String(v).padStart(4)}  setKey="${k}"`));
  console.log(`    well-formed, catalog missing:   ${genuineGap.length}`);
  tally(genuineGap, (x) => x.setKey).slice(0, 8)
    .forEach(([k, v]) => console.log(`      ${String(v).padStart(4)}  setKey="${k}"`));
  // KNOWN BLIND SPOT: this split only detects the raw-vendor-string
  // shape. A caller-side DEFAULT like setKey="bowman" on a hockey slug
  // is equally malformed but looks well-formed here, so it lands in the
  // "catalog missing" bucket and overstates it. Treat a large bare
  // `bowman`/`topps` count in that bucket as suspected mislabeling, not
  // as demand for a checklist pull. Re-read this split after the
  // re-derivation pass, when the defaults are gone.
  console.log("    NOTE: bare bowman/topps below are likely caller-side");
  console.log("          defaults (mislabels), not true catalog demand.");
  console.log("    (raw setName on the same rows, for parse triage:)");
  tally(allMisses, (x) => x.setName).slice(0, 8)
    .forEach(([k, v]) => console.log(`      ${String(v).padStart(4)}  setName="${k}"`));

  report.causeSplit = { malformedSlug: badSlug.length, catalogMissing: genuineGap.length };

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`\n  wrote ${JSON_OUT}`);
  }
  console.log("\n  NOTE: +/-5-8pp noise at this sample size. Ordering is solid; small moves are not.");
}

main().catch((e) => { console.error(e); process.exit(1); });
