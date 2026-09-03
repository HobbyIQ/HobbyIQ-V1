#!/usr/bin/env node
/**
 * CF-BUYERIQ-GRADE-AWARE-MATCH (2026-09-03) — READ-ONLY sample probe.
 *
 * Reproduces the adversarial verifier's finding at scale, and measures
 * whether the grade-aware matcher moved the number WITHOUT simply
 * refusing everything.
 *
 * METHOD. The defect is in the MATCHER: a listing was compared against a
 * projection belonging to a different grade tier. So each sampled row is
 * a real marketplace title from sold_comps, whose stored grade fields
 * are the GROUND TRUTH for what tier that card was actually in. Each row
 * is then evaluated against TWO targets:
 *
 *   - its OWN tier      -> a correct match. Admitting it is a TRUE
 *                          POSITIVE; refusing it is a miss.
 *   - a DIFFERENT tier  -> the verifier's false positive. Admitting it
 *                          is a FALSE POSITIVE.
 *
 * Both pairings matter. Measuring only the mismatched pairing would
 * score a gate that refuses everything as perfect, which is why the
 * true-positive column is reported alongside.
 *
 * BEFORE = the shipped matcher (parallel/identity gate only).
 * AFTER  = parallel gate AND grade gate.
 *
 * Rows carrying flaggedWrong / excludedFromFmv are excluded — main's
 * pricing readers now filter them, so they are not part of the pool the
 * scanner would see.
 *
 * READ-ONLY: SELECT only. No writes, no vendor calls, no quota spend.
 *
 * Run under a loader that maps the repo's ".js" TS imports, e.g. tsx:
 *   COSMOS_CONNECTION_STRING=... npx tsx backend/scripts/probe-buyeriq-grade-blind-sample.cjs
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const SAMPLE_N = Number(process.env.SAMPLE_N ?? "40");
const PER_BUCKET = Number(process.env.PER_BUCKET ?? "120");

async function loadMatcher() {
  const url = (p) => "file:///" + path.resolve(__dirname, "..", p).replace(/\\/g, "/");
  const grade = await import(url("src/services/buyeriq/listingGradeMatch.ts"));
  const parallel = await import(url("src/services/compiq/titleParallelMatch.ts"));
  return { ...grade, ...parallel };
}

const norm = (s) => String(s ?? "").trim().toUpperCase();

/** The row's stored grade — ground truth for the tier the card was in. */
function truthTier(row) {
  const c = norm(row.gradeCompany);
  const v = row.gradeValue;
  if (!c || v === null || v === undefined || v === "") return { company: null, value: null };
  const n = Number(v);
  return { company: c, value: Number.isFinite(n) ? n : null };
}

const tierLabel = (t) => (t.company ? `${t.company} ${t.value ?? "?"}` : "Raw");

/** A tier that is deliberately NOT the row's own. */
function otherTier(truth) {
  if (!truth.company) return { gradeCompany: "PSA", gradeValue: 10 };
  if (truth.company === "PSA" && truth.value === 10) return { gradeCompany: "PSA", gradeValue: 9 };
  if (truth.company === "PSA") return { gradeCompany: "PSA", gradeValue: 10 };
  return { gradeCompany: "PSA", gradeValue: 10 };
}

async function page(container, query, parameters, n) {
  try {
    const p = await container.items.query({ query, parameters }, { maxItemCount: n }).fetchNext();
    return { rows: p.resources ?? [], ru: p.requestCharge ?? 0 };
  } catch (e) {
    console.error(`[probe] query failed: ${e.message}`);
    return { rows: [], ru: 0 };
  }
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  const M = await loadMatcher();
  const container = new CosmosClient(cs)
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container("sold_comps");

  const FIELDS = `c.id, c.title, c.gradeCompany, c.gradeValue, c.parallel,
                  c.cardNumber, c.player, c.sport, c.price`;
  const CLEAN = `IS_DEFINED(c.title) AND NOT IS_NULL(c.title)
                 AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
                 AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv = false)`;

  // Two buckets so the sample carries BOTH graded and raw listings —
  // a raw-only sample cannot show a true positive being preserved.
  const graded = await page(container,
    `SELECT TOP @n ${FIELDS} FROM c WHERE ${CLEAN}
       AND IS_DEFINED(c.gradeCompany) AND NOT IS_NULL(c.gradeCompany)`,
    [{ name: "@n", value: PER_BUCKET }], PER_BUCKET);
  const raw = await page(container,
    `SELECT TOP @n ${FIELDS} FROM c WHERE ${CLEAN}
       AND (NOT IS_DEFINED(c.gradeCompany) OR IS_NULL(c.gradeCompany))`,
    [{ name: "@n", value: PER_BUCKET }], PER_BUCKET);
  console.error(`[probe] graded=${graded.rows.length} raw=${raw.rows.length} ru=${Math.round(graded.ru + raw.ru)}`);

  // Interleave so the sample is half graded, half raw, and dedupe by
  // title so one hot card cannot dominate the rate.
  const seen = new Set();
  const pool = [];
  const maxLen = Math.max(graded.rows.length, raw.rows.length);
  for (let i = 0; i < maxLen && pool.length < SAMPLE_N; i++) {
    for (const src of [graded.rows, raw.rows]) {
      const r = src[i];
      if (!r || pool.length >= SAMPLE_N) continue;
      const key = String(r.title).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(r);
    }
  }
  if (!pool.length) { console.error("no rows sampled"); process.exit(3); }

  const rows = [];
  for (const r of pool) {
    const truth = truthTier(r);
    const title = String(r.title);
    // The shipped matcher: identity/parallel gate only. Grade-blind, so
    // its verdict is identical for both targets — that IS the defect.
    const before = M.titleMatchesParallel(
      title, r.parallel ?? null, r.cardNumber ?? null, r.player ?? null);

    for (const [pairing, target] of [
      ["same-tier", { gradeCompany: truth.company, gradeValue: truth.value }],
      ["cross-tier", otherTier(truth)],
    ]) {
      const v = M.listingMatchesGrade(title, target);
      const tCompany = target.gradeCompany ? norm(target.gradeCompany) : null;
      const inTargetTier =
        tCompany === truth.company &&
        (tCompany === null || Number(target.gradeValue) === truth.value);
      rows.push({
        sport: r.sport ?? "?",
        title,
        truth: tierLabel(truth),
        target: tierLabel({ company: tCompany, value: target.gradeValue }),
        pairing,
        reading: v.reading.kind === "graded"
          ? `${v.reading.company} ${v.reading.value}` : v.reading.kind,
        before,
        after: before && v.ok,
        inTargetTier,
        reason: v.ok ? "" : v.reason,
      });
    }
  }

  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const verdict = (admitted, inTier) =>
    admitted ? (inTier ? "score" : "FALSE+") : (inTier ? "miss" : "skip");

  console.log(`\n=== SAMPLE: ${pool.length} listings x 2 target pairings ===\n`);
  console.log(pad("actual tier", 12) + pad("target", 11) + pad("pairing", 11) +
              pad("read as", 11) + pad("before", 8) + pad("after", 8) + "title");
  console.log("-".repeat(150));
  for (const r of rows) {
    console.log(pad(r.truth, 12) + pad(r.target, 11) + pad(r.pairing, 11) +
      pad(r.reading, 11) + pad(verdict(r.before, r.inTargetTier), 8) +
      pad(verdict(r.after, r.inTargetTier), 8) + r.title.slice(0, 58));
  }

  const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
  const admittedBefore = rows.filter((r) => r.before);
  const admittedAfter = rows.filter((r) => r.after);
  const fpBefore = admittedBefore.filter((r) => !r.inTargetTier);
  const fpAfter = admittedAfter.filter((r) => !r.inTargetTier);
  const tpBefore = admittedBefore.filter((r) => r.inTargetTier);
  const tpAfter = admittedAfter.filter((r) => r.inTargetTier);
  const sameTier = rows.filter((r) => r.pairing === "same-tier");

  console.log("\n=== FALSE POSITIVE RATE (share of ADMITTED comparisons in the wrong tier) ===");
  console.log(`listings sampled          : ${pool.length}`);
  console.log(`comparisons (x2 pairings) : ${rows.length}`);
  console.log(`admitted BEFORE           : ${admittedBefore.length}`);
  console.log(`  wrong tier (FALSE +)    : ${fpBefore.length}  -> ${pct(fpBefore.length, admittedBefore.length)}%`);
  console.log(`admitted AFTER            : ${admittedAfter.length}`);
  console.log(`  wrong tier (FALSE +)    : ${fpAfter.length}  -> ${pct(fpAfter.length, admittedAfter.length)}%`);
  console.log(`\n=== TRUE POSITIVES (a gate that refuses everything scores 0 here) ===`);
  console.log(`same-tier comparisons     : ${sameTier.length}`);
  console.log(`  admitted BEFORE         : ${tpBefore.length}`);
  console.log(`  admitted AFTER          : ${tpAfter.length}  (retained ${pct(tpAfter.length, tpBefore.length)}%)`);
  const unknown = rows.filter((r) => r.reason === "grade-unknown").length;
  console.log(`refused as grade-unknown  : ${unknown} of ${rows.length} comparisons`);

  console.log(JSON.stringify({
    event: "buyeriq_grade_blind_sample",
    listings: pool.length,
    comparisons: rows.length,
    admittedBefore: admittedBefore.length,
    falsePositivesBefore: fpBefore.length,
    fpRateBefore: pct(fpBefore.length, admittedBefore.length),
    admittedAfter: admittedAfter.length,
    falsePositivesAfter: fpAfter.length,
    fpRateAfter: pct(fpAfter.length, admittedAfter.length),
    truePositivesBefore: tpBefore.length,
    truePositivesAfter: tpAfter.length,
    gradeUnknownRefusals: unknown,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
