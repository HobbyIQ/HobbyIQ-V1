#!/usr/bin/env node
/**
 * CF-GRADED-IDENTITY-FROM-EVIDENCE (Drew, 2026-08-26).
 *
 * A graded card needs to be an IDENTITY, not just a grade field on a sale, so
 * it can sit in someone's inventory and be browsed and held. This builds those
 * identities -- and builds them only where a real sale proves the pairing
 * exists.
 *
 * WHY NOT EXPLODE. The previous approach multiplied every identity by every
 * tier: 18,172,721 x 11 = 199,899,931 rows, for card/grade pairings that have
 * never once traded. Measured against the pool, the pairings that HAVE traded
 * number 1,608,698 -- 0.80% of that. The other 99.2% was templates, which is
 * the thing `no-synthetic-parallels` exists to forbid.
 *
 *   graded sales                                 3,785,044
 *   distinct base cards with a graded sale         543,684
 *   distinct (card, company, value) identities   1,608,698
 *   average graded sales per identity                  2.4
 *
 * WHAT THIS DOES NOT DO. It does not move sales. Sales keep the BASE slug and
 * carry their grade in gradeCompany/gradeValue, because the pricing ladder
 * needs every grade of a card in ONE pool: rung 1 filters that pool by grade,
 * the raw-anchor fallback reads across it, and matched-cohort calibration
 * compares tiers within it. Fragmenting the pool into 1.6M pools averaging 2.4
 * sales apiece would make each of those a cross-partition join, and would
 * hard-wire raw-anchoring at the moment the market is moving away from it.
 *
 * GRADE VOCABULARY. Only graders `gradeLadder.service` recognises get an
 * identity, and only at grades that grader actually issues -- so PSA 9.5 cannot
 * come back, and "The Final Authority" (2 sales) does not become a catalog
 * entity. Everything skipped is counted and reported rather than dropped
 * silently. PSA qualifiers (OF/OC/MC/ST/MK/PD) are part of the key: a PSA 8 OC
 * is a different card from a PSA 8.
 *
 * A PARENT IS REQUIRED. An identity is its parent plus a grade, so a pairing
 * whose base card is not in the catalog is an ORPHAN, reported for phase 06,
 * never invented here.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS              shard across workers by tier (biggest-first)
 *   CONCURRENCY=64
 *   RUN_MINUTES=140           stop before the 150-min step ceiling
 *   LIMIT=0                   stop after N writes (0 = no limit)
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { buildGradedRow } = require(path.join(backend, "scripts/explodeCatalogGrades.cjs"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const {
  canonicalGradeCompany,
  isIssuedGrade,
} = require(path.join(backend, "dist/services/catalog/gradeLadder.service.js"));
// CF-ONE-WAY-TO-BUILD-A-CATALOG-ROW. Writer #62 is exactly what the write
// contract guard exists to stop, and it caught this script hand-rolling
// `container.upsert`. Route through the one write path instead: it unions
// vendorIds rather than dropping them, and refuses to let a lower-confidence
// row overwrite a higher-confidence one.
const { upsertCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 64));
const LIMIT = Number(process.env.LIMIT || 0);
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
const SHARD_SCOPE = runnerShardScope({ label: "materialize-graded-identities" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;


// CF-RETIRE-EXITS-BEFORE-THE-CEILING taught this the hard way: the workflow
// kills the step at 150 minutes and the relaunch reads a summary line that a
// killed process never prints. Stop on our own clock and print it.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();

const GRADED =
  "IS_STRING(c.hobbyiqCardId) AND IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null";

const f = (n) => Number(n).toLocaleString();

/** Slug fragment for a tier: PSA 9.5 -> psa-9-5, PSA 8 OC -> psa-8-oc. */
function tierSlug(company, value, qualifier) {
  const base = `${String(company).toLowerCase()}-${String(value).replace(/\./g, "-")}`;
  return qualifier ? `${base}-${String(qualifier).toLowerCase()}` : base;
}

function tierFor(company, value, qualifier) {
  const canon = canonicalGradeCompany(company);
  if (!canon) return null;                              // grader we do not model
  if (!isIssuedGrade(canon, value)) return null;        // grade that grader never issues
  const slug = tierSlug(canon, value, qualifier);
  return { tier: slug, slug, gradeCompany: canon, gradeValue: value, gradeQualifier: qualifier ?? null };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sc = db.container("sold_comps");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const throttled = /request rate is too large|429/i.test(String(e?.message));
        if (!throttled || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // ── 1. which (company, value, qualifier) tiers actually traded ────────────
  console.log("discovering tiers from observed sales...");
  const { resources: raw } = await retry(() => sc.items.query(
    `SELECT c.gradeCompany AS co, c.gradeValue AS v, c.gradeQualifier AS q, COUNT(1) AS n
     FROM c WHERE ${GRADED} GROUP BY c.gradeCompany, c.gradeValue, c.gradeQualifier`).fetchAll());

  const tiers = [];
  let unrecognised = 0, unrecognisedSales = 0;
  const unrecognisedNames = new Map();
  for (const r of raw) {
    const t = tierFor(r.co, r.v, r.q);
    if (!t) {
      unrecognised++; unrecognisedSales += r.n;
      const k = `${r.co} ${r.v}${r.q ? " " + r.q : ""}`;
      unrecognisedNames.set(k, (unrecognisedNames.get(k) ?? 0) + r.n);
      continue;
    }
    tiers.push({ ...t, n: r.n });
  }
  tiers.sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug));

  console.log(`  ${f(tiers.length)} tiers are real and issued`);
  console.log(`  ${f(unrecognised)} rejected (${f(unrecognisedSales)} sales) — unmodelled grader or a grade it does not issue`);
  for (const [k, n] of [...unrecognisedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`      ${k}: ${f(n)}`);
  }

  // Deal biggest-first so slots balance, per CF-RETIRE-SHARDS-BY-GRADE-TIER.
  const mine = SLOTS > 1 ? tiers.filter((_, i) => i % SLOTS === SLOT) : tiers;
  if (mine.length === 0) { console.log(`slot ${SLOT}/${SLOTS} owns no tier — nothing to do`); return; }
  if (SLOTS > 1) {
    console.log(`\nslot ${SLOT}/${SLOTS}  ${mine.length} tiers, ${f(mine.reduce((s, t) => s + t.n, 0))} sales`);
    console.log(`  ${SHARD_SCOPE.banner()}`);
  }

  let pairs = 0, written = 0, existed = 0, orphaned = 0, failed = 0, skipped = 0;
  // Two different reasons to stop early, and they must not print as each
  // other: a LIMIT stop is a deliberate bounded run, a budget stop means real
  // work is left and the relaunch has to pick it up.
  let stopReason = null;
  const orphanSample = [];

  // ── 2. per tier: every distinct base card that traded at that grade ───────
  for (const tier of mine) {
    if (stopReason) break;
    const cards = new Set();
    let token;
    do {
      const page = await retry(() => sc.items.query(
        // The parentheses are load-bearing: `A AND B OR C` binds as
        // `(A AND B) OR C`, which would pull in every null-qualifier sale of
        // every other tier and mint identities at the wrong grade.
        { query: `SELECT c.hobbyiqCardId AS s FROM c WHERE ${GRADED}
                  AND c.gradeCompany = @co AND c.gradeValue = @v
                  AND ${tier.gradeQualifier === null ? "(NOT IS_DEFINED(c.gradeQualifier) OR c.gradeQualifier = null)" : "c.gradeQualifier = @q"}`,
          parameters: [
            { name: "@co", value: tier.gradeCompany },
            { name: "@v", value: tier.gradeValue },
            ...(tier.gradeQualifier === null ? [] : [{ name: "@q", value: tier.gradeQualifier }]),
          ] },
        { maxItemCount: 2000, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      for (const r of page.resources) if (r.s) cards.add(r.s);
    } while (token);

    const list = [...cards];
    console.log(`  ${tier.slug.padEnd(14)} ${String(f(list.length)).padStart(9)} identities`);

    for (let i = 0; i < list.length; i += CONCURRENCY) {
      await Promise.all(list.slice(i, i + CONCURRENCY).map(async (parentSlug) => {
        pairs++;
        const slug = `${parentSlug}:${tier.slug}`;
        try {
          // Already an identity? Leave it; this job creates, never overwrites.
          const hit = await cat.item(slug, slug).read().catch((e) => {
            if (e.code === 404) return { resource: undefined };
            throw e;
          });
          if (hit.resource) { existed++; return; }

          const { resource: parent } = await cat.item(parentSlug, parentSlug).read().catch((e) => {
            if (e.code === 404) return { resource: undefined };
            throw e;
          });
          if (!parent) {
            orphaned++;
            if (orphanSample.length < 10) orphanSample.push(`${parentSlug} @ ${tier.slug}`);
            return;
          }

          const row = buildGradedRow(parent, tier);
          if (!row) { skipped++; return; }
          row.catalogBatch = "graded-identity-evidence-2026-08-26";
          row.gradedIdentitySource = "sold_comps";   // provenance: a sale proved this pairing

          if (!APPLY) { written++; return; }
          await retry(() => upsertCatalogEntry(row));
          written++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${slug.slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      if (LIMIT && written >= LIMIT) { stopReason = "limit"; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
    }
  }

  if (stopReason === "budget") {
    console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  } else if (stopReason === "limit") {
    console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run, not the whole tier`);
  }
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  pairings considered       ${f(pairs)}`);
  console.log(`  written                   ${f(written)}`);
  console.log(`  already existed           ${f(existed)}`);
  console.log(`  orphaned (no base card)   ${f(orphaned)}`);
  console.log(`  skipped (unbuildable)     ${f(skipped)}`);
  console.log(`  failed                    ${f(failed)}`);
  if (orphanSample.length) {
    console.log(`\n  orphan sample — these are phase 06 acquisitions, not bugs:`);
    for (const o of orphanSample) console.log(`    ${o}`);
  }
  if (APPLY) {
    reportWrites({
      job: "materialize-graded-identities",
      intended: pairs,
      written,
      skipped: existed + orphaned + skipped,
      failed,
    });
  }
}

module.exports = { tierFor, tierSlug };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
}
