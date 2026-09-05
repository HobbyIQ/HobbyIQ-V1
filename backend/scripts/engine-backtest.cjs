#!/usr/bin/env node
/**
 * engine-backtest.cjs — CF-ENGINE-BACKTEST (#1651, Drew 2026-09-02).
 *
 * THE PUBLISHED NUMBER: "HobbyIQ's projected price landed within X% of the
 * actual next sale, on N held-out sales." This script produces it, sliced by
 * rung / sport / price band / pool freshness, and measures the #1647
 * player-index speculation rung against the family fallback it was inserted
 * above.
 *
 * READ ONLY. There is no write path in this file at all — no patch, no upsert,
 * no delete, and no `apply` semantics to get wrong. It reads sold_comps and
 * calls the pricing engine in memory. `BACKFILL_APPLY` is accepted from the
 * runner and IGNORED, deliberately: a backtest that could write would be a
 * backtest nobody should trust with a Cosmos connection string.
 *
 * ── HOW AN EVALUATION POINT IS BUILT ────────────────────────────────────
 *
 * 1. Sample a HELD-OUT SALE: a real row in sold_comps, inside the evaluation
 *    period, of an identity that carries a canonical hiq slug.
 * 2. Set the cutoff to that sale's own soldAt. Everything at or after it is
 *    the future — including the sale itself.
 * 3. Ask the ONE valuation path to price the identity AS OF that cutoff
 *    (`valueIdentity({ id, grade, asOfMs })`).
 * 4. Score the engine's projection against what the card actually sold for.
 *
 * The grade travels with the sale, so a PSA 10 sale is scored against the PSA
 * 10 projection and not against a raw one. Getting that wrong would produce a
 * report whose errors are mostly the grade curve, attributed to the ladder.
 *
 * ── NO LOOKAHEAD IS STRUCTURAL, NOT PROCEDURAL ──────────────────────────
 *
 * This script does NOT filter its own inputs and hope. It passes `asOfMs` into
 * the engine entry, and the engine refuses future rows in the QUERY — both
 * pool reads (exactPoolReader, playerIndexRead) and all eleven fallback rungs
 * (hobbyIqFmv.queryPool) carry `c.soldAt < @asOf`, and the player-index memo
 * is keyed by the cutoff so one evaluation point cannot be served another's
 * basket. See tests/asOfLookaheadIsolation.test.ts, which splices future-dated
 * rows into a fixture and requires every rung's answer not to move.
 *
 * That placement is the whole point. A lookahead leak does not produce an
 * obviously wrong number — it produces a flattering one, and the report
 * becomes a lie that validates itself. Structural exclusion at the read is the
 * only version of this worth publishing.
 *
 * ── SAMPLING ─────────────────────────────────────────────────────────────
 *
 * The evaluation period defaults to the last 90 days, ending FRESHNESS_LAG_DAYS
 * (default 2) before now: a sale needs time to be ingested, and sampling right
 * up to the present would score the engine on a pool that is still filling in.
 *
 * Points are sampled by walking sold_comps in the period and taking every row
 * whose sha1 lands in this shard. That is a hash sample, not a "TOP N" — the
 * newest rows are not a random sample of anything, and ORDER BY soldAt DESC
 * with a LIMIT would silently select for the most liquid cards, which are the
 * ones the engine prices best. MAX_PER_CARD (default 2) caps how many points
 * one identity may contribute, so a single card with 400 sales cannot become
 * the report.
 *
 * STRATIFIED BY SPORT, and the reason is measured. A plain cross-partition walk
 * returns partitions in an order that correlates with sport, so it is NOT a
 * random sample of the period: the first live run scored 6,400 points that were
 * 100% baseball, against an eligible population that is 51.1% baseball, 16.6%
 * basketball, 16.5% pokemon and 13.4% football (measured 2026-09-02 over
 * 3,466,183 eligible sales). Every per-sport slice in that report was therefore
 * an empty claim, and the headline was a baseball number wearing a global label.
 *
 * So the walk runs ONCE PER SPORT with `c.sport = @sport` and takes a quota
 * proportional to that sport's share of the eligible population (SPORT_QUOTAS,
 * refreshed by the same GROUP BY that measured it). The sample then matches the
 * market it claims to describe, and the per-sport slice means what it says.
 *
 * ── SHARDING + BUDGET (both runner gates) ────────────────────────────────
 *
 * SLOT/SLOTS shard on sha1(sold_comps row id) — a guaranteed, uniform axis
 * measured on the pool, not on a field whose distribution is a guess. Each
 * slot writes its own JSON; combine-shards merges them.
 *
 * At RUN_MINUTES the script STOPS CLEANLY and prints "stopped at the N-minute
 * budget", which the runner greps to re-dispatch (CF-RELAUNCH-ONLY-ON-BUDGET,
 * #1361). The marker prints in every mode, because a report longer than one
 * budget must be able to finish too.
 *
 * ── MODES ────────────────────────────────────────────────────────────────
 *
 *   MODE=sample    (default) build + score evaluation points for this shard,
 *                  write <out>/engine-backtest-slot-<slot>.json
 *   MODE=combine   merge every shard JSON in <out> into one report + REPORT.md
 *
 * USAGE (runner: script=engine-backtest, apply is ignored)
 *   MODE=sample SLOT=0 SLOTS=16 SAMPLE_LIMIT=500 node scripts/engine-backtest.cjs
 *   MODE=combine node scripts/engine-backtest.cjs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");

const backend = path.resolve(__dirname, "..");

// ─── args + env ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt = "") => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit === `--${name}`) return "true";
  return hit.slice(`--${name}=`.length);
};
const env = (name, dflt = "") => {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === "" ? dflt : String(v).trim();
};

const MODE = (arg("mode", env("MODE", "sample")) || "sample").toLowerCase();
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so the env fallback below NEVER saw an absent value and this lane
// sharded itself sixteen ways on a dispatch that asked for no sharding --
// sweeping slot 0 and leaving fifteen sixteenths untouched, green and honestly
// reconciled. Sharding is now OPT-IN: an explicit --slot/--slots on the command
// line (a flag IS a choice, `--slot 0` included), a non-zero SLOT, or SHARD=true
// for slot 0 of a real fan-out. The inherited slot=0 slots=16 sweeps EVERY row.
// SLOTS binds to 1 when unsharded, so `% SLOTS` and `SLOTS > 1` guards below
// keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({
  slotArg: arg("slot", ""), slotsArg: arg("slots", ""),
  label: "engine-backtest",
});
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const OUT_DIR = arg("out", env("OUT_DIR", path.join(backend, "data", "engine-backtest")));

// The evaluation period.
const PERIOD_DAYS = Number(arg("period-days", env("PERIOD_DAYS", "90"))) || 90;
const FRESHNESS_LAG_DAYS = Number(arg("lag-days", env("FRESHNESS_LAG_DAYS", "2")));
// How many scored points this shard is aiming for. The walk stops here.
// NO NEW RUNNER INPUT: this reads the runner's existing generic `limit`
// (env LIMIT) as its fallback, the same way other scripts on this dispatcher
// bound a slice. The dispatch surface is already at 25 of GitHub's cap, so a
// new axis here would cost a slot for something an existing input can say.
const SAMPLE_LIMIT = Number(arg("sample-limit", env("SAMPLE_LIMIT", env("LIMIT", "500")))) || 500;
const MAX_PER_CARD = Number(arg("max-per-card", env("MAX_PER_CARD", "2"))) || 2;
const CONCURRENCY = Math.max(1, Number(arg("concurrency", env("BACKFILL_CONCURRENCY", "8"))) || 8);
const PAGE_SIZE = Math.max(1, Number(arg("page-size", env("PAGE_SIZE", "1000"))) || 1000);
const SPORT = arg("sport", env("SPORT") || env("SPORTS"));
// 140 minutes leaves the marker inside the runner's 150-minute step ceiling.
const RUN_MINUTES = Number(arg("run-minutes", env("RUN_MINUTES", "120"))) || 120;
/** Wall clock a single unit (one scored sample point) may still be granted after the
 *  budget expires. CHECKED BEFORE EACH UNIT, never at the loop top.
 *  See lib/runner-budget.cjs for the rule and its arithmetic. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const MIN_SALE_PRICE = Number(arg("min-price", env("MIN_PRICE", "5"))) || 5;

const num = (n) => Number(n).toLocaleString("en-US");
const DAY = 86_400_000;

/**
 * The strata. Shares of the ELIGIBLE population (priced > $5, canonical slug,
 * not anomalous / flagged) in a 90-day period, measured 2026-09-02 by
 * GROUP BY c.sport over 3,466,183 rows:
 *
 *     baseball    1,771,797   51.1%
 *     basketball    574,150   16.6%
 *     pokemon       572,019   16.5%
 *     football      464,199   13.4%
 *     soccer         29,692    0.9%
 *     hockey         17,591    0.5%
 *     (tail)                   1.0%   -- ~40 keys, none above 0.4%
 *
 * The tail is deliberately not sampled: at 0.4% and below a proportional quota
 * is a handful of points, which is below the slice floor and would only add
 * noise to the headline. The report states the covered share so the claim is
 * about the population it actually sampled.
 *
 * These are SHARES, not counts — the walk takes `share × SAMPLE_LIMIT` from
 * each. Re-measure with the GROUP BY above if the mix shifts materially.
 */
const SPORT_QUOTAS = [
  { sport: "baseball", share: 0.511 },
  { sport: "basketball", share: 0.166 },
  { sport: "pokemon", share: 0.165 },
  { sport: "football", share: 0.134 },
  { sport: "soccer", share: 0.009 },
  { sport: "hockey", share: 0.005 },
];
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// ─── the engine, from dist/ ──────────────────────────────────────────────
// Builders never touch the canonical tree: this requires the COMPILED engine,
// so the runner's `npm run build` step is what puts today's code under test.
function loadEngine() {
  const p = path.join(backend, "dist/services/compiq/oneValuationPath.service.js");
  if (!fs.existsSync(p)) {
    console.error(`FATAL: ${p} missing — run \`npm run build\` in backend/ first.`);
    console.error("       (The backtest runs the COMPILED engine so the report describes shipped code.)");
    process.exit(3);
  }
  // The engine's import graph reaches authService, which THROWS AT MODULE LOAD
  // without AUTH_SESSION_SECRET. The backtest signs nothing and reads no
  // session — but the import kills the process before it can say so, and the
  // resulting stack trace points at authService rather than at the missing
  // env var. Refuse up front with the fix instead.
  if (!env("AUTH_SESSION_SECRET")) {
    console.error("FATAL: AUTH_SESSION_SECRET is unset.");
    console.error("       The backtest never signs anything, but the compiled engine's import graph");
    console.error("       reaches authService, which refuses to load without it. Fetch it from the");
    console.error("       HobbyIQ3 App Service settings (the runner does this automatically).");
    process.exit(4);
  }
  return require(p);
}
function loadMetrics() {
  const p = path.join(backend, "dist/services/backtest/engineBacktestMetrics.service.js");
  if (!fs.existsSync(p)) {
    console.error(`FATAL: ${p} missing — run \`npm run build\` in backend/ first.`);
    process.exit(3);
  }
  return require(p);
}

/** The tier label a sold_comps row describes, in the engine's vocabulary. */
function gradeOf(row) {
  const company = row.gradeCompany ? String(row.gradeCompany).trim().toUpperCase() : "";
  if (!company) return null;                       // raw
  const value = row.gradeValue === null || row.gradeValue === undefined
    ? null : Number(row.gradeValue);
  return { company, value: Number.isFinite(value) ? value : null };
}

// ─── MODE=sample ─────────────────────────────────────────────────────────
async function runSample() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (!Number.isFinite(SLOTS) || SLOTS < 1 || !Number.isFinite(SLOT) || SLOT < 0 || SLOT >= SLOTS) {
    console.error(`FATAL: bad shard: slot=${SLOT} slots=${SLOTS}. Need 0 <= slot < slots.`);
    process.exit(2);
  }

  const { valueIdentity } = loadEngine();

  const nowMs = Date.now();
  const periodEnd = new Date(nowMs - FRESHNESS_LAG_DAYS * DAY).toISOString();
  const periodStart = new Date(nowMs - (FRESHNESS_LAG_DAYS + PERIOD_DAYS) * DAY).toISOString();

  console.log(`[engine-backtest] mode=SAMPLE  (READ ONLY — this script has no write path)`);
  console.log(`  period: ${periodStart.slice(0, 10)} .. ${periodEnd.slice(0, 10)}  (${PERIOD_DAYS}d, lag ${FRESHNESS_LAG_DAYS}d)`);
  console.log(`  shard:  slot ${SLOT} of ${SLOTS}   target=${num(SAMPLE_LIMIT)} points  maxPerCard=${MAX_PER_CARD}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget: ${RUN_MINUTES} min   concurrency=${CONCURRENCY}${SPORT ? `   sport=${SPORT}` : ""}\n`);

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const comps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps");

  // The candidate held-out sales. Only rows that carry a canonical slug can be
  // priced through the one valuation path at all.
  const startedAt = Date.now();
  const budgetMs = RUN_MINUTES * 60_000;
  let stopped = null;

  const perCard = new Map();
  const points = [];
  const excluded = {
    "shard-miss": 0,
    "per-card-cap": 0,
    "no-projection": 0,
    "engine-error": 0,
  };
  let scanned = 0;

  // The strata this run will walk. `sport=` on the dispatch narrows to one
  // (and then takes the whole target); otherwise every quota sport, each
  // capped at its share of the eligible population.
  const strata = SPORT
    ? [{ sport: SPORT, quota: SAMPLE_LIMIT }]
    : SPORT_QUOTAS.map((q) => ({ sport: q.sport, quota: Math.max(1, Math.round(q.share * SAMPLE_LIMIT)) }));
  const coveredShare = SPORT ? 1 : SPORT_QUOTAS.reduce((s, q) => s + q.share, 0);

  console.log(`  strata: ${strata.map((s) => `${s.sport}=${num(s.quota)}`).join("  ")}`);
  console.log(`          (${(coveredShare * 100).toFixed(1)}% of the eligible population by sport)\n`);

  const scoreRow = async (row) => {
    const asOfMs = Date.parse(row.soldAt);
    if (!Number.isFinite(asOfMs)) { excluded["no-projection"]++; return; }
    let v;
    try {
      // THE CALL. asOfMs is the whole no-lookahead guarantee: the engine
      // reads nothing at or after this instant, in the query.
      v = await valueIdentity({
        id: row.hobbyiqCardId,
        grade: gradeOf(row),
        asOfMs,
      });
    } catch (err) {
      excluded["engine-error"]++;
      return;
    }
    if (!v || v.fairMarketValue === null || !(v.fairMarketValue > 0)) {
      excluded["no-projection"]++;
      return;
    }
    // The newest sale the engine could see, at the cutoff — the freshness
    // axis. v.sales is newest-first and already as-of bounded.
    let poolAgeDays = null;
    const newest = Array.isArray(v.sales) && v.sales.length > 0 ? Date.parse(v.sales[0].soldAt) : NaN;
    if (Number.isFinite(newest)) poolAgeDays = Math.max(0, (asOfMs - newest) / DAY);

    points.push({
      cardId: row.hobbyiqCardId,
      asOf: new Date(asOfMs).toISOString(),
      predicted: v.fairMarketValue,
      actual: Number(row.price),
      actualSoldAt: row.soldAt,
      daysAhead: 0,
      rung: v.rungLabel,
      sport: row.sport ?? v.identity?.sport ?? null,
      compsUsed: v.compsUsed,
      poolAgeDays,
      confidence: v.confidence ?? null,
    });
  };

  const perSport = {};

  // ONE PASS PER STRATUM. The `c.sport = @sport` predicate is what makes the
  // sample proportional — see the header: without it the partition walk order
  // decides the mix, and it decided "all baseball".
  for (const stratum of strata) {
    if (stopped) break;
    const before = points.length;
    const params = [
      { name: "@from", value: periodStart },
      { name: "@to", value: periodEnd },
      { name: "@minPrice", value: MIN_SALE_PRICE },
      { name: "@sport", value: stratum.sport },
    ];
    const query = {
      query: `SELECT c.id, c.hobbyiqCardId, c.price, c.soldAt, c.gradeCompany, c.gradeValue,
                     c.sport, c.playerName
              FROM c
              WHERE c.soldAt >= @from AND c.soldAt < @to
                AND c.price > @minPrice
                AND c.sport = @sport
                AND IS_DEFINED(c.hobbyiqCardId) AND STARTSWITH(c.hobbyiqCardId, "hiq:")
                AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
      parameters: params,
    };
    const iter = comps.items.query(query, { maxItemCount: PAGE_SIZE });

    // A page at a time: select this shard's candidates, then price them
    // concurrently. Pricing dominates the clock (each point is a full engine
    // call), so the walk is cheap and the pool is where the budget goes.
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      if (!resources || resources.length === 0) break;
      scanned += resources.length;

      const batch = [];
      for (const r of resources) {
        if (SLOTS > 1 && shardOf(r.id) !== SLOT) { excluded["shard-miss"]++; continue; }
        const slug = String(r.hobbyiqCardId || "");
        const seen = perCard.get(slug) || 0;
        if (seen >= MAX_PER_CARD) { excluded["per-card-cap"]++; continue; }
        perCard.set(slug, seen + 1);
        batch.push(r);
        if ((points.length - before) + batch.length >= stratum.quota) break;
      }

      await pool(batch, CONCURRENCY, async (row) => {
        if (Date.now() - startedAt > budgetMs - RESERVE_MS) return;
        await scoreRow(row);
      });

      if (points.length - before >= stratum.quota) break;
      if (Date.now() - startedAt > budgetMs - RESERVE_MS) { stopped = "budget"; break; }
    }
    perSport[stratum.sport] = points.length - before;
    console.log(`  [${stratum.sport}] scored ${num(points.length - before)} of ${num(stratum.quota)}   (${Math.round((Date.now() - startedAt) / 60_000)}m, scanned ${num(scanned)})`);
  }

  if (!stopped && points.length >= SAMPLE_LIMIT) stopped = "limit";

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `engine-backtest-slot-${SLOT}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    slot: SLOT, slots: SLOTS,
    periodStart, periodEnd,
    scanned, excluded, points, perSport, coveredShare,
    generatedAt: new Date().toISOString(),
  }, null, 2));

  const { buildEngineBacktestReport } = loadMetrics();
  const report = buildEngineBacktestReport(points, excluded);

  console.log(`\n[slot ${SLOT}/${SLOTS}] scanned ${num(scanned)}  scored ${num(points.length)}`);
  console.log(`  excluded: ${JSON.stringify(excluded)}`);
  if (report.overall.n > 0) {
    console.log(`  median |err| ${(report.overall.medianAbsPctError * 100).toFixed(1)}%   within25 ${(report.overall.within25Pct * 100).toFixed(1)}%`);
  }
  console.log(`  wrote ${outPath}`);

  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The marker, in every mode.
  if (stopped === "budget") {
    console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — slot ${SLOT}/${SLOTS} scored ${num(points.length)} of ${num(SAMPLE_LIMIT)}; re-dispatch to continue.`);
  } else if (stopped === "limit") {
    console.log(`\n[done] slot ${SLOT}/${SLOTS} reached its ${num(SAMPLE_LIMIT)}-point target.`);
  } else {
    console.log(`\n[done] slot ${SLOT}/${SLOTS} swept the period to completion.`);
  }
}

// ─── MODE=combine ────────────────────────────────────────────────────────
async function runCombine() {
  const { buildEngineBacktestReport } = loadMetrics();
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`FATAL: ${OUT_DIR} does not exist — run MODE=sample first.`);
    process.exit(2);
  }
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^engine-backtest-slot-\d+\.json$/.test(f));
  if (files.length === 0) {
    console.error(`FATAL: no shard files in ${OUT_DIR} — nothing to combine.`);
    process.exit(2);
  }

  const all = [];
  const excluded = {};
  let scanned = 0;
  let periodStart = null;
  let periodEnd = null;
  let coveredShare = null;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    all.push(...(d.points || []));
    scanned += d.scanned || 0;
    for (const [k, v] of Object.entries(d.excluded || {})) excluded[k] = (excluded[k] || 0) + v;
    if (!periodStart || d.periodStart < periodStart) periodStart = d.periodStart;
    if (!periodEnd || d.periodEnd > periodEnd) periodEnd = d.periodEnd;
    if (typeof d.coveredShare === "number") coveredShare = d.coveredShare;
  }

  const report = buildEngineBacktestReport(all, excluded);
  report.periodStart = periodStart;
  report.periodEnd = periodEnd;
  report.shardsCombined = files.length;
  report.rowsScanned = scanned;
  report.coveredShare = coveredShare;

  const jsonPath = path.join(OUT_DIR, "engine-backtest-report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const mdPath = path.join(OUT_DIR, "REPORT.md");
  fs.writeFileSync(mdPath, renderMarkdown(report));

  console.log(`[engine-backtest] mode=COMBINE  shards=${files.length}  points=${num(report.totalPoints)}`);
  if (report.overall.n > 0) {
    console.log(`  median |err| ${(report.overall.medianAbsPctError * 100).toFixed(1)}%`);
    console.log(`  within 10/25/50: ${(report.overall.within10Pct * 100).toFixed(1)}% / ${(report.overall.within25Pct * 100).toFixed(1)}% / ${(report.overall.within50Pct * 100).toFixed(1)}%`);
  }
  console.log(`  wrote ${jsonPath}`);
  console.log(`  wrote ${mdPath}`);
}

const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);

function distRow(label, d) {
  return `| ${label} | ${num(d.n)} | ${pct(d.medianAbsPctError)} | ${pct(d.medianSignedPctError)} | ${pct(d.within10Pct)} | ${pct(d.within25Pct)} | ${pct(d.within50Pct)} | ${pct(d.p90AbsPctError)} |`;
}
const HEAD = `| slice | n | median \\|err\\| | bias | ≤10% | ≤25% | ≤50% | p90 \\|err\\| |\n|---|---:|---:|---:|---:|---:|---:|---:|`;

function renderMarkdown(r) {
  const o = r.overall;
  const L = [];
  L.push(`# HobbyIQ engine backtest`);
  L.push("");
  L.push(`Generated ${r.generatedAt}. Evaluation period ${String(r.periodStart).slice(0, 10)} .. ${String(r.periodEnd).slice(0, 10)}; ${num(r.shardsCombined || 0)} shards, ${num(r.rowsScanned || 0)} candidate rows scanned.`);
  L.push("");
  L.push(`Sampled STRATIFIED BY SPORT, in proportion to each sport's share of the eligible population${r.coveredShare ? ` (${(r.coveredShare * 100).toFixed(1)}% of it covered by the sampled strata)` : ""}. An unstratified cross-partition walk is not a random sample of the period — the partition order correlates with sport, and the first run of this script scored 6,400 points that were 100% baseball against a population that is 51% baseball.`);
  L.push("");
  L.push(`## The number`);
  L.push("");
  if (o.n === 0) {
    L.push("No scorable evaluation points.");
    return L.join("\n");
  }
  L.push(`**On ${num(o.n)} held-out sales, HobbyIQ's projected price landed within 25% of the actual next sale ${pct(o.within25Pct)} of the time**, with a median absolute error of **${pct(o.medianAbsPctError)}**.`);
  L.push("");
  L.push(`- within 10%: **${pct(o.within10Pct)}**`);
  L.push(`- within 25%: **${pct(o.within25Pct)}**`);
  L.push(`- within 50%: **${pct(o.within50Pct)}**`);
  L.push(`- bias (median signed error): **${pct(o.medianSignedPctError)}** ${o.medianSignedPctError > 0 ? "(reads high)" : o.medianSignedPctError < 0 ? "(reads low)" : ""}`);
  L.push(`- p90 absolute error: ${pct(o.p90AbsPctError)}`);
  L.push("");
  L.push(`Error is measured against the ACTUAL sale: \`(predicted − actual) / actual\`.`);
  L.push("");
  L.push(`## No lookahead`);
  L.push("");
  L.push(`Each point prices its identity as of the held-out sale's own timestamp. The cutoff is passed into the engine entry (\`valueIdentity({ asOfMs })\`) and enforced IN THE QUERY at every read — the exact pool, the player index basket, and all eleven fallback rungs carry \`c.soldAt < @asOf\` — with the player-index memo keyed by cutoff so no evaluation point can be served another's basket. Pinned by \`tests/asOfLookaheadIsolation.test.ts\`, which splices future-dated rows into the fixture and requires every rung's answer to be unchanged.`);
  L.push("");
  L.push(`## By rung`);
  L.push("");
  L.push(HEAD);
  for (const s of r.byRung) L.push(distRow(`\`${s.key}\``, s));
  L.push("");
  L.push(`## By sport`);
  L.push("");
  L.push(HEAD);
  for (const s of r.bySport) L.push(distRow(s.key, s));
  L.push("");
  L.push(`## By price band (of the actual sale)`);
  L.push("");
  L.push(HEAD);
  for (const s of r.byPriceBand) L.push(distRow(s.key, s));
  L.push("");
  L.push(`## By pool freshness (age of the newest visible sale, at the cutoff)`);
  L.push("");
  L.push(HEAD);
  for (const s of r.byPoolFreshness) L.push(distRow(s.key, s));
  L.push("");
  if (r.speculationVsFallback) {
    const c = r.speculationVsFallback;
    L.push(`## #1647: the speculation rung vs the fallback it replaces`);
    L.push("");
    L.push(HEAD);
    L.push(distRow("`player-index-projection`", c.speculation));
    L.push(distRow("family / sibling fallback", c.familyFallback));
    L.push("");
    L.push(`**Verdict: ${c.verdict}.** Median |error| delta: ${c.medianAbsPctErrorDelta === null ? "—" : `${(c.medianAbsPctErrorDelta * 100).toFixed(1)} pp`} (positive = the speculation rung is closer); within-25% delta: ${c.within25PctDelta === null ? "—" : `${(c.within25PctDelta * 100).toFixed(1)} pp`}.`);
    L.push("");
    L.push(`> ${c.note}`);
    L.push("");
  }
  L.push(`## Excluded`);
  L.push("");
  for (const [k, v] of Object.entries(r.excluded || {})) L.push(`- \`${k}\`: ${num(v)}`);
  L.push("");
  return L.join("\n");
}

(async () => {
  if (MODE === "sample") await runSample();
  else if (MODE === "combine") await runCombine();
  else {
    console.error(`FATAL: unknown MODE=${JSON.stringify(MODE)}. Use 'sample' or 'combine'.`);
    process.exit(2);
  }
})().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
