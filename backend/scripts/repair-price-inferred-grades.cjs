#!/usr/bin/env node
/**
 * CF-GRADE-IS-STATED-NEVER-INFERRED (Drew, 2026-08-31: "there is an issue
 * TCA-ebay. I am seeing no grades and listed as raw when they are graded").
 *
 * The parser fix (persistVendorSalesToPool) stops NEW rows being stamped with
 * a grade their title never stated. This re-tags the rows already in the pool.
 *
 * WHAT WENT WRONG. Until 2026-08-31 the ingest path ran a fallback,
 * resolveGradeTierByPrice: when the title stated no grade, it queried the
 * card's historical sales, bucketed them by grade tier, and stamped the row
 * with whichever tier's median sat closest to THIS sale's price. That reasons
 * backwards — it reads the number FMV is supposed to predict and uses it to
 * choose the identity that determines which pool does the predicting. A raw
 * card that sold high became a "PSA 10", landed in the PSA 10 pool, and pulled
 * that tier's FMV down while leaving the raw pool short a real sale.
 *
 * MEASURED over 119,475 graded tca-ebay rows (soldAt 2026-08-20..08-31):
 *
 *     118,769  (99.41%)  title STATES the grade — parseGradeLabel agrees
 *         706  ( 0.59%)  title states NO grade — price-inferred only
 *           ~36 ( 0.03%)  title and stored grade DISAGREE — all attributable to the OLD multi-grader parser bug this branch fixes
 *
 * The 706 are the damage. Their titles name no grader at all:
 *
 *     "1950 Bowman - Bob Feller #6"                        stored SGC 3
 *     "1996-97 Topps Kobe Bryant Rookie RC #138 Lakers"     stored BGS 8.5
 *     "2021 Topps Chrome - Shohei Ohtani #159 Refractor"    stored PSA 9
 *
 * THE REPAIR IS A DEMOTION, NOT A RELOCATION. The task this came from assumed
 * the opposite defect (graded titles stored raw) and called for re-keying rows
 * onto a graded child slug. The measurement refutes that: only 47 rows in 2.27M
 * over 8 months are stored-raw-with-a-graded-title, and every one is an
 * isAuthentic edge case, not a numeric grade. Extraction is not broken. So this
 * script moves rows the OTHER way — a row whose title states no grade is
 * returned to RAW, which is where the sale actually belongs.
 *
 * No slug is rewritten. sold_comps carries grade in FIELDS, never in the slug
 * (see cardIdentityKey.service.ts — segment 8 of a comps slug is a print run,
 * and grade-by-slug-position is explicitly a trap). Both the FMV engine
 * (unifiedPricing groups by gradeLabel(gradeCompany, gradeValue)) and the grade
 * curve (soldCompsGradeReader filters on those fields) pool by the fields, so
 * clearing them is exactly what moves a row back into the raw pool.
 *
 * SAFETY, in the order the guards fire:
 *   - REPORT-FIRST. Dry-run is the default; --apply is required to write.
 *   - WHITELISTED. Only sources named in SOURCES may be touched, and only rows
 *     whose stored grade the SHIPPED parser declines to confirm from the title.
 *     A row whose title states a grade is never modified, in either direction.
 *   - SCOPED. A whole-source run refuses without an explicit SOURCES value —
 *     no implicit "repair everything".
 *   - CONSERVATIVE. Ambiguity favours leaving the row alone: an unreadable
 *     title, a parser throw, or a stored grade the title CONFIRMS all decline.
 *   - REVERSIBLE. The prior tuple is written to gradeDemotedFrom alongside
 *     gradeDemotedAt, so an operator can reconstruct or undo any write.
 *   - RECONCILED. reportWrites partitions the population with disjoint counters.
 *   - RESUMABLE. Stops at the budget marker and reports notReached; the
 *     relaunch forwards its args verbatim and continues from there.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-price-inferred-grades.cjs \
 *     --sources=tca-ebay [--since=2026-05-01] [--apply] [--concurrency=16]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
// REFUSALS BEFORE REQUIRES. @azure/cosmos, writeReconciliation and
// gradeParser are all loaded inside main() AFTER the scope refusal, so an
// invocation that names no scope refuses with rc=2 — the honest answer —
// rather than dying rc=1 on "Cannot find module" when node_modules or dist
// happen to be absent. A missing build must never look like a refusal, and a
// refusal must never be masked by a missing build.

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit && process.env[name.toUpperCase().replace(/-/g, "_")]) return String(process.env[name.toUpperCase().replace(/-/g, "_")]);
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`) || (n === "apply" && process.env.BACKFILL_APPLY === "true");

const APPLY = has("apply");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
const LIMIT = Number(arg("limit", "0")) || 0;
const RUN_MINUTES = Math.max(1, Number(arg("minutes", "45")));
const RUN_MS = RUN_MINUTES * 60_000;
const SINCE = arg("since", "");
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
/** Wall clock one batch may still be granted after the budget expires.
 *  CHECKED BEFORE EACH BATCH, never at the loop top. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 120 * 1000);

// SCOPE REFUSAL. A whole-container sweep must name its scope explicitly.
const SOURCES = String(arg("sources", ""))
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); return 1;
  }
  if (SOURCES.length === 0 || SOURCES.includes("all")) {
    console.error("FATAL: --sources= is required and may not be 'all'.");
    console.error("       This script rewrites grade fields on sold_comps rows; a");
    console.error("       whole-container sweep must be asked for by name.");
    console.error("       e.g. --sources=tca-ebay");
    return 2;
  }

  // Every dependency loads here — past both refusals, never before them.
  const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { parseGradeLabel } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[price-inferred-grade-repair] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  sources=${SOURCES.join(",")}  since=${SINCE || "(all)"}  concurrency=${CONCURRENCY}  budget=${RUN_MINUTES}m  limit=${LIMIT || "none"}`);
  if (!APPLY) console.log(`  (dry-run — no writes; re-run with --apply to persist)`);

  // Source-narrowed and optionally date-narrowed. Never an unbounded scan:
  // c.source is the selective predicate, and only rows that ALREADY carry a
  // grade are candidates — a raw row has nothing to demote.
  const params = SOURCES.map((v, i) => ({ name: `@s${i}`, value: v }));
  let where = `c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})`
    + ` AND IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND c.gradeCompany != ''`;
  if (SINCE) { where += ` AND c.soldAt >= @since`; params.push({ name: "@since", value: SINCE }); }

  // THE DENOMINATOR, measured before the walk. A run that stops on its budget
  // or its --limit must be able to say how many candidates it never looked at;
  // without this count "reconciled" would be a claim about the rows it reached
  // and silence about the rest — a false all-clear on exactly the resumable
  // path the relaunch ladder depends on.
  let candidateTotal = null;
  try {
    const { resources: cnt } = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
      parameters: params,
    }).fetchAll();
    candidateTotal = Number(cnt[0] ?? 0);
    console.log(`  candidates in scope               ${candidateTotal}`);
  } catch (e) {
    // Never block the repair on the count; notReached simply reports unknown.
    console.warn(`  (candidate COUNT unavailable: ${e.code ?? e.message})`);
  }

  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.gradeCompany, c.gradeValue,
                   c.gradeQualifier, c.isAuthentic, c.price, c.soldAt, c.hobbyiqCardId
            FROM c WHERE ${where}`,
    parameters: params,
  }, { maxItemCount: 500 });

  // DISJOINT counters — every candidate lands in exactly one terminal bucket.
  const tot = {
    scanned: 0,          // rows read
    titleConfirms: 0,    // title states this grade -> left alone (the 99.4%)
    noTitle: 0,          // unusable title -> left alone
    parserThrew: 0,      // parser error -> left alone
    demotable: 0,        // title states NO grade -> demote to raw
    written: 0,
    failed: 0,
    notReached: 0,       // budget/limit stopped the walk
  };
  const byTier = {};
  const samples = [];
  const inflight = new Set();
  let stopReason = "end-of-feed";

  // Every early exit records what it did NOT scan. candidateTotal is the
  // in-scope population; tot.scanned is what the walk actually read.
  const markNotReached = () => {
    tot.notReached = candidateTotal === null
      ? 0                                            // unknown; reported as such below
      : Math.max(0, candidateTotal - tot.scanned);
  };

  outer:
  while (iter.hasMoreResults()) {
    if (budgetLeft() < RESERVE_MS) { stopReason = "budget"; markNotReached(); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      if (budgetLeft() < RESERVE_MS) { stopReason = "budget"; markNotReached(); break outer; }
      if (LIMIT && tot.demotable >= LIMIT) { stopReason = "limit"; markNotReached(); break outer; }
      tot.scanned++;

      const title = String(row.title ?? "").trim();
      if (!title) { tot.noTitle++; continue; }

      let parsed;
      try { parsed = parseGradeLabel(title); }
      catch { tot.parserThrew++; continue; }

      // THE WHOLE RULE. The title is the only evidence that may support a
      // stored grade. If the shipped parser reads ANY grade out of it, the row
      // is title-backed and is left exactly as it is — including the case where
      // the parser's tier differs from the stored one, which is a separate
      // question this script deliberately does not adjudicate.
      if (parsed) { tot.titleConfirms++; continue; }

      tot.demotable++;
      const tier = `${row.gradeCompany} ${row.gradeValue ?? "-"}`;
      byTier[tier] = (byTier[tier] || 0) + 1;
      if (samples.length < 12) {
        samples.push(`${tier.padEnd(10)} -> raw   $${String(row.price).padEnd(10)}${title.slice(0, 62)}`);
      }
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // sold_comps is partitioned by /cardId, NOT by doc id.
      const p = sold.item(row.id, row.cardId).patch([
        { op: "set", path: "/gradeCompany", value: null },
        { op: "set", path: "/gradeValue", value: null },
        { op: "set", path: "/gradeQualifier", value: null },
        { op: "set", path: "/isAuthentic", value: null },
        // Reversible: keep what was there and why it went.
        { op: "add", path: "/gradeDemotedFrom", value: tier },
        { op: "add", path: "/gradeDemotedAt", value: new Date().toISOString() },
        { op: "add", path: "/gradeDemotedReason", value: "price-inferred; title states no grade" },
      ])
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} demotable=${tot.demotable} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  const pct = (n) => tot.scanned ? (n / tot.scanned * 100).toFixed(2) : "0.00";
  console.log(`\n  scanned (source-scoped, graded)   ${tot.scanned}`);
  console.log(`  title CONFIRMS the grade          ${tot.titleConfirms}  (${pct(tot.titleConfirms)}%)   left alone`);
  console.log(`  title states NO grade             ${tot.demotable}  (${pct(tot.demotable)}%)   -> raw`);
  console.log(`  unusable title                    ${tot.noTitle}`);
  console.log(`  parser threw                      ${tot.parserThrew}`);
  console.log(`  written                           ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  if (stopReason !== "end-of-feed") {
    console.log(`  not reached                       ${candidateTotal === null ? "UNKNOWN (count query failed)" : tot.notReached}`);
  }

  console.log(`\n  demotions by stored tier:`);
  for (const [k, v] of Object.entries(byTier).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log(`\n  sample demotions:`);
  for (const s of samples) console.log(`    ${s}`);

  if (stopReason === "budget") {
    console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  } else if (stopReason === "limit") {
    console.log(`\nstopped at --limit=${LIMIT}`);
  }

  // Reconcile: intended partitions EXACTLY into written + skipped + failed.
  //
  // Units matter here. tot.demotable counts rows the walk actually decided to
  // demote. tot.notReached counts in-scope CANDIDATES the walk never read —
  // an unknown fraction of which would have been demotable. Both belong in
  // "intended" (the job's true obligation is the whole scoped population's
  // worth of decisions), and the unreached remainder is reported as skipped,
  // which is what it is: work this run declined to do and the relaunch owes.
  //
  // A budget-stopped run therefore reconciles as
  //   intended = decided + undecided,  written + skipped + failed = intended
  // instead of claiming a clean sweep over rows it never opened.
  if (APPLY) {
    if (stopReason !== "end-of-feed") {
      console.log(`  RELAUNCH OWED: stopped on ${stopReason}; `
        + `${candidateTotal === null ? "UNKNOWN" : tot.notReached} in-scope candidates never read.`);
    }
    reportWrites({
      job: "repair-price-inferred-grades",
      intended: tot.demotable + tot.notReached,
      written: tot.written,
      skipped: (tot.demotable - tot.written - tot.failed) + tot.notReached,
      failed: tot.failed,
    });
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
