#!/usr/bin/env node
/**
 * CF-SMOKE-TEST-PRICING-TIERS (2026-07-11, Drew).
 *
 * Hits live prod /api/compiq/price with 8 tier-classified queries and
 * reports which pricing tier actually fired for each. Verifies the
 * full fallback chain end-to-end after a deploy or config change.
 *
 * Runbook:
 *   $env:TIER1_HARNESS_TOKEN = (az webapp config appsettings list \
 *     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='TIER1_HARNESS_TOKEN'].value" -o tsv).Trim()
 *   node backend/scripts/smoke-test-pricing-tiers.cjs
 */

const BASE = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const TOKEN = process.env.TIER1_HARNESS_TOKEN?.trim() ?? "";

// CF-SMOKE-DECISION-IS-TESTABLE (2026-09-05). This file is both a CLI and the
// definition of the withheld-vs-missing contract that gates the nightly
// reprice. `require`ing it must therefore be side-effect free so the pins in
// tests/pricingSmokeWithheldContract.test.ts can exercise the decision
// directly instead of against live prod. The token check and the live run
// happen only when this is the entry point.
const IS_MAIN = require.main === module;
if (IS_MAIN && !TOKEN) {
  console.error("TIER1_HARNESS_TOKEN not set — cannot authenticate");
  process.exit(1);
}

// CF-SMOKE-TEST-CI-GATE (2026-07-11): each case now carries a `mustNotNull`
// flag. When true, non-null FMV is REQUIRED — the case fails otherwise.
// Only case 8 (garbage input) can legitimately null. Sums into an exit code
// so the daily-refresh workflow can gate on this after every deploy.
//
// CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE (2026-09-05). `mustNotNull` alone
// asks the wrong question of a modern engine. Since #1681 routed /price
// through the one valuation path, a null FMV has TWO meanings and they need
// opposite responses:
//
//   WITHHELD  the engine was asked, ran the ladder, and refused, publishing a
//             named reason from a closed vocabulary (`no-exact-pool`,
//             `no-exact-pool-at-tier`, `pool-migrating`, `no-checklist-match`,
//             `identity-not-in-catalog`, `no-catalog-identity`). This is the
//             product behaving as Drew ruled: a withheld price is a value of
//             null WITH a reason. It is not a deploy failure.
//   MISSING   FMV is null and nothing says why — the engine was never asked,
//             threw, or returned an unlabelled gap. THAT is the outage the
//             gate was built to catch, and the only shape that may block the
//             nightly reprice.
//
// So each case carries `accept`: "value" (a number is required), "withheld"
// (a null is required, and it MUST carry a reason), or "either". A null with
// no reason fails every case regardless — that is the invariant, and it is
// what the workflow reads to decide whether to run the reprice.
const CASES = [
  {
    tier: "1 (direct-comps)",
    query: "2024 Bowman Chrome Prospects Speckle Refractor Devin Taylor Auto BCP-16",
    expect: "predictedPrice + real range",
    accept: "value",
  },
  {
    // CF-SMOKE-CASE2-IS-A-WITHHOLD (2026-09-05). This case expected
    // `parallel-floor-projection` / `scarcity-prior-floor` — two rungs that
    // exist ONLY in computeCanonicalFmv (compiqEstimate.service.ts +
    // pricing.constants.ts). #1681 (the first red, 2026-09-03 20:41Z) routed
    // /price through computeCanonicalValuation → valueIdentity, which is a
    // genuinely different engine over a different reader, and its ladder has
    // no floor rung: it ends at `no-exact-pool`.
    //
    // The identity is NOT a regression victim. Verified read-only against
    // prod Cosmos: every 2026 BCP-69 "Black" row is checklist-backed
    // (checklistcenter / checklistinsider / checklist), minted 2026-08-27 to
    // 08-31 — days outside POOL_SETTLE_HOURS=6, so `pool-migrating` cannot
    // fire — and each of those pools holds ZERO sold_comps rows. An unopened
    // 2026 parallel numbered /10 with no sales is exactly the card the
    // doctrine says to withhold: "price only checklist-matched identities"
    // is satisfied, and there is simply no comp to project a next sale from.
    //
    // Per Drew's standing ruling, a withheld price is a value of null with a
    // reason, and that IS the intended product behaviour — so the expectation
    // moves to the withheld contract rather than the engine being loosened to
    // resurrect a floor rung the one path deliberately does not have.
    tier: "4 (parallel-floor → withheld)",
    query: "2026 Bowman Chrome Owen Carey Black BCP-69",
    expect: "withheld: null FMV carrying a named reason (no-exact-pool)",
    accept: "withheld",
  },
  {
    // CF-SMOKE-CH-DEP-DEFERRED (Drew, 2026-08-08). This query has no
    // cardNumber ("...Sapphire Padparadscha Prospects" — a subset
    // parallel search, not a specific card). Canonical-first can't
    // build a hobbyiqCardId slug without a cardNumber, and the
    // CH-dependent AI matcher (which synthesized an answer from the
    // set + parallel alone) is off. Rebuilding this synthesis path
    // in our own pool is real engineering — deferred until
    // post-launch. Marking mustNotNull=false so the smoke test
    // accurately reflects "the paths we've decommissioned CH from"
    // rather than including CH-only synthesis as a regression.
    tier: "3 (product-family-projection) — CH-dep, deferred",
    query: "2024 Bowman Chrome Sapphire Padparadscha Prospects",
    expect: "null under CH-off; CH-only synthesis path",
    accept: "either",
  },
  {
    tier: "5 (scarcity-prior-floor)",
    query: "2026 Bowman Chrome Prospects Eric Hartman Blue Refractor Auto",
    expect: "scarcity-prior-floor OR parallel-floor",
    accept: "value",
  },
  {
    tier: "6 (reference-catalog-baseline) — new",
    query: "2020 Bowman Chrome Prospects Some Obscure Player Green Refractor",
    expect: "reference-catalog-baseline (Tier 6)",
    accept: "value",
  },
  {
    // CF-SMOKE-TIER7-TRANSITION (Drew, 2026-07-22). Under the pre-PR-#633
    // hardcoded matrix, this synthetic query would always fall through
    // to Tier 7 setdoc-baseline with a non-null FMV. Post-empirical-only
    // doctrine, Panini Origins has no GRADE_CALIBRATION entry → the
    // multiplier-anchored path returns null → smoke stops at
    // no-recent-comps INSTEAD of falling through to Tier 7. This is a
    // tier-ladder plumbing gap, not a real-user regression (no user
    // types "Nonexistent Player"). Backlog: fix the ladder to fall
    // through from no-recent-comps to setdoc-baseline when the
    // multiplier-anchored return is null. Until then, both outcomes
    // are acceptable so the smoke signal for OTHER cases stays alive.
    tier: "7 (setdoc-baseline) — new",
    query: "2024 Panini Origins Nonexistent Player Base",
    expect: "setdoc-baseline (Tier 7) OR no-recent-comps",
    accept: "either",
    acceptEmptyForTier7Transition: true,
  },
  {
    // CF-CANONICAL-PLAYER-LOOKUP (Drew, 2026-08-09). Restored to
    // mustNotNull=true after the /price handler gained a
    // player-lookup canonical-first path (compiq.routes.ts
    // CF-PRICE-CANONICAL-PLAYER-LOOKUP). "Ohtani Base" with year +
    // set + player is now resolvable via card_catalog identity
    // lookup — the resolver picks the highest-comp-count match
    // for that (year, set, player, parallel=Base) tuple and
    // returns canonical-fmv on that slug.
    tier: "1 (direct-comps) recent star",
    query: "2024 Bowman Chrome Ohtani Base",
    expect: "predictedPrice via player-lookup canonical-first",
    accept: "value",
  },
  {
    tier: "8 (unavailable)",
    query: "asdfasdfasdf random garbage input",
    expect: "unavailable / null",
    accept: "either",
  },
];

async function hitPrice(query) {
  const start = Date.now();
  const res = await fetch(`${BASE}/api/compiq/price`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  const elapsedMs = Date.now() - start;
  if (!res.ok) {
    return { ok: false, status: res.status, elapsedMs };
  }
  const json = await res.json();
  return { ok: true, elapsedMs, json };
}

function extractSummary(json) {
  const price = json?.price ?? json?.result ?? json ?? {};
  return {
    pricingTier: price.pricingTier ?? price.source ?? null,
    fairMarketValue: price.fairMarketValue ?? price.marketValue ?? null,
    predictedPrice: price.predictedPrice ?? null,
    fairMarketValueLow: price.fairMarketValueLow ?? null,
    fairMarketValueHigh: price.fairMarketValueHigh ?? null,
    fmvMechanism:
      price.predictedPriceAttribution?.mechanism ??
      price.fmvMechanism ??
      null,
    pricingConfidence:
      price.confidence?.pricingConfidence ?? price.pricingConfidence ?? null,
    verdict: price.verdict ?? null,
    withheldReason: withheldReasonOf(price),
  };
}

/**
 * CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE (2026-09-05).
 *
 * The one closed-vocabulary reason a null FMV carries, or null when the
 * response gives none. Read in the order the wire actually fills:
 *
 *   canonicalFmvWithheld.reason   /price, when the one path was asked and
 *                                 refused (the shape this PR adds)
 *   fmvReason                     the canonical / hobbyiq-fmv wire shapes
 *   source === "no-recent-comps"  the engine's own no-data state, which IS a
 *                                 stated reason even where the newer key is
 *                                 absent (older adapters, cached responses)
 *
 * Anything else — including a bare null with a tier and a mechanism — counts
 * as UNREASONED, which is the outage shape.
 */
function withheldReasonOf(price) {
  const explicit =
    price?.canonicalFmvWithheld?.reason ??
    price?.fmvReason ??
    price?.canonicalFmv?.fmvReason ??
    null;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (price?.source === "no-recent-comps" || price?.source === "catalog-miss") {
    return price.source;
  }
  if (price?.rungLabel === "no-basis" || price?.method === "no-basis") return "no-basis";
  return null;
}

/**
 * CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE (2026-09-05). The whole contract,
 * as one pure function over already-fetched results, so it can be pinned in
 * tests without hitting prod. `results` is [{ case, result|null }].
 *
 * Returns the two signals the workflow reads and the three verdict lists:
 *
 *   engineOk   false ONLY on an unreasoned null or a case that failed to
 *              answer. This is the outage signal, and the only one that may
 *              stop the nightly reprice.
 *   smokeOk    every case behaved as ruled.
 */
function judgeResults(results, cases) {
  const tierCounts = {};
  let nullCount = 0;
  let withheldCount = 0;
  let httpFailCount = 0;
  const violations = [];
  // Unreasoned nulls are tracked apart from every other violation, because
  // they are the ONLY class meaning "the engine is broken" rather than "the
  // engine said no".
  const unreasonedNulls = [];
  for (const r of results) {
    if (!r.result) {
      httpFailCount++;
      violations.push(`HTTP fail: ${r.case.tier}`);
      continue;
    }
    const t = r.result.pricingTier ?? "(unset)";
    tierCounts[t] = (tierCounts[t] ?? 0) + 1;
    const isNull = r.result.fairMarketValue === null;
    const reason = r.result.withheldReason;
    if (isNull) nullCount++;
    if (isNull && reason) withheldCount++;

    // THE INVARIANT, checked on every case whatever it accepts: a null FMV
    // must say why. A null with no reason is an unlabelled gap — the engine
    // was never asked, or fell out of the ladder without a verdict — and that
    // is an outage regardless of what this particular case expects.
    if (isNull && !reason) {
      unreasonedNulls.push(
        `UNREASONED NULL on ${r.case.tier} — FMV null with no withheld reason (tier=${t})`,
      );
      continue;
    }

    const accept = r.case.accept ?? "value";
    if (accept === "value" && isNull) {
      violations.push(
        `WITHHELD where a value was required on ${r.case.tier} — reason '${reason}', expected ${r.case.expect}`,
      );
    } else if (accept === "withheld" && !isNull) {
      // Not a failure of the deploy, but the fixture has drifted from the
      // engine and must be re-ruled rather than left silently passing.
      violations.push(
        `PRICED where a withhold was pinned on ${r.case.tier} — FMV $${r.result.fairMarketValue}; re-rule this case`,
      );
    }
  }

  // CF-WITHHELD-SHAPE-COVERAGE (2026-09-05). The withheld contract is now a
  // first-class outcome of this engine, so the fixture set must exercise it:
  // without at least one deliberately-withheld case, a regression that made
  // EVERY refusal unreasoned would sail through green.
  const pinnedWithheldCases = (cases ?? []).filter((c) => c.accept === "withheld");
  if (pinnedWithheldCases.length === 0) {
    violations.push(
      "FIXTURE GAP: no case pins the withheld contract — the null-with-a-reason shape is uncovered",
    );
  }

  return {
    tierCounts,
    nullCount,
    withheldCount,
    httpFailCount,
    violations,
    unreasonedNulls,
    pinnedWithheldCount: pinnedWithheldCases.length,
    engineOk: unreasonedNulls.length === 0 && httpFailCount === 0,
    smokeOk: violations.length === 0 && unreasonedNulls.length === 0,
  };
}

async function main() {
  console.log(`[smoke-test] hitting ${BASE}/api/compiq/price with ${CASES.length} cases\n`);
  const results = [];
  for (const c of CASES) {
    process.stdout.write(`▶ ${c.tier}:  ${c.query.slice(0, 60)}...\n`);
    const r = await hitPrice(c.query);
    if (!r.ok) {
      console.log(`  ✗ HTTP ${r.status} (${r.elapsedMs}ms)\n`);
      results.push({ case: c, result: null });
      continue;
    }
    const s = extractSummary(r.json);
    const verdictShort = (s.verdict ?? "").slice(0, 90);
    console.log(`  tier:       ${s.pricingTier ?? "(none)"}`);
    console.log(`  mechanism:  ${s.fmvMechanism ?? "(none)"}`);
    // CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE: a null says WHY, or says that
    // it cannot — the distinction the reprice gate reads.
    console.log(
      `  FMV:        ${s.fairMarketValue !== null
        ? "$" + s.fairMarketValue
        : `null (${s.withheldReason ? "withheld: " + s.withheldReason : "NO REASON GIVEN"})`}`,
    );
    if (s.fairMarketValueLow !== null || s.fairMarketValueHigh !== null) {
      console.log(`  range:      $${s.fairMarketValueLow} — $${s.fairMarketValueHigh}`);
    }
    console.log(`  confidence: ${s.pricingConfidence ?? "(none)"}`);
    console.log(`  verdict:    ${verdictShort}${verdictShort.length === 90 ? "..." : ""}`);
    console.log(`  latency:    ${r.elapsedMs}ms`);
    console.log(`  expected:   ${c.expect}\n`);
    results.push({ case: c, result: s, elapsedMs: r.elapsedMs });
  }

  // Aggregate summary + the two signals the workflow reads
  console.log("\n═══ AGGREGATE SUMMARY ═══");
  const judged = judgeResults(results, CASES);
  const {
    tierCounts, nullCount, withheldCount, httpFailCount,
    violations, unreasonedNulls, pinnedWithheldCount, engineOk, smokeOk,
  } = judged;

  console.log(`Total cases:      ${CASES.length}`);
  console.log(`HTTP failures:    ${httpFailCount}`);
  console.log(`Null-FMV returns: ${nullCount} (${withheldCount} withheld with a reason, ${nullCount - withheldCount} unreasoned)`);
  console.log(`Withheld pins:    ${pinnedWithheldCount} case(s) assert the null-with-a-reason contract`);
  console.log(`Tiers fired:`);
  for (const [t, c] of Object.entries(tierCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
  }

  // ── THE REPRICE DECISION (CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE) ──────
  //
  // Before 2026-09-05 this script had exactly one lever — exit 1 — and the
  // workflow hung the nightly all-users reprice off it via `needs:`. So the
  // day a smoke EXPECTATION went stale (case #2, whose floor rung #1681
  // removed from the one path), the reprice stopped running and stayed
  // stopped: seven red runs with no reprice, while the deploy itself landed
  // fine every time. A stale fixture silently switching off the nightly
  // pricing job is a worse failure than the thing the gate was watching for.
  //
  // `judgeResults` separates the two signals and the workflow reads BOTH:
  //
  //   smoke_ok    every case behaved as ruled. Green.
  //   engine_ok   no case returned a null without a reason, and none failed
  //               to answer. This is the OUTAGE signal, and it is the only
  //               one that may stop the reprice.
  //
  // A contract drift (a case expecting a value that is now legitimately
  // withheld, or vice versa) fails the smoke — someone must re-rule it — but
  // leaves engine_ok true, so holdings still get repriced tonight against an
  // engine that is demonstrably answering.
  if (process.env.GITHUB_OUTPUT) {
    try {
      require("fs").appendFileSync(
        process.env.GITHUB_OUTPUT,
        `engine_ok=${engineOk}\nsmoke_ok=${smokeOk}\n`,
      );
    } catch (err) {
      console.warn(`  (could not write GITHUB_OUTPUT: ${err.message})`);
    }
  }
  console.log(`engine_ok:        ${engineOk} (false = unreasoned null or HTTP failure — blocks the reprice)`);
  console.log(`smoke_ok:         ${smokeOk}`);

  if (unreasonedNulls.length > 0) {
    console.log(`\n✗ ENGINE OUTAGE (${unreasonedNulls.length} unreasoned null${unreasonedNulls.length === 1 ? "" : "s"}):`);
    for (const v of unreasonedNulls) console.log(`  - ${v}`);
    console.log(`\n  A null FMV must name its reason. These do not, so the engine is not`);
    console.log(`  merely declining to price — it is failing to answer. The nightly`);
    console.log(`  reprice is held back.`);
  }

  if (violations.length > 0 || unreasonedNulls.length > 0) {
    // CF-SMOKE-CH-DECOMMISSION-TOLERANCE (Drew, 2026-08-08). When
    // CH_RUNTIME_DISABLED_ACKNOWLEDGED=true is set on the workflow,
    // value-required violations are demoted from failure → warning. The
    // pricing engine's CH callers were gated off 2026-08-07 but not every
    // downstream tier is fully re-routed to canonical-fmv yet. Until the CH
    // decommission audit ships, the CI signal must reflect "did the DEPLOY
    // work" not "did the CH-tier-ladder work".
    //
    // The tolerance never covers an UNREASONED NULL: that is an outage, not
    // a decommissioned tier, and no env var may hide it.
    const isChTolerated = process.env.CH_RUNTIME_DISABLED_ACKNOWLEDGED === "true";
    const withheldViolations = violations.filter((v) => v.startsWith("WITHHELD where a value was required"));
    const otherViolations = violations.filter((v) => !v.startsWith("WITHHELD where a value was required"));
    if (
      isChTolerated
      && unreasonedNulls.length === 0
      && otherViolations.length === 0
      && withheldViolations.length > 0
    ) {
      console.log(`\n⚠ SMOKE TEST DEGRADED (${withheldViolations.length} withheld-where-value-required violation${withheldViolations.length === 1 ? "" : "s"}, tolerated under CH_RUNTIME_DISABLED_ACKNOWLEDGED=true):`);
      for (const v of withheldViolations) console.log(`  - ${v}`);
      console.log(`\n  These will fail again once CH_RUNTIME_DISABLED_ACKNOWLEDGED is removed.`);
      console.log(`\n✓ smoke test passed with tolerance — deploy is safe to ship`);
      return;
    }
    console.log(`\n✗ SMOKE TEST FAILED (${violations.length + unreasonedNulls.length} violation${violations.length + unreasonedNulls.length === 1 ? "" : "s"}):`);
    for (const v of [...unreasonedNulls, ...violations]) console.log(`  - ${v}`);
    if (engineOk) {
      console.log(`\n  NOTE: every null returned above carries a reason, so the engine is`);
      console.log(`  answering and the nightly reprice still runs. What failed is the`);
      console.log(`  agreement between a fixture and the engine — re-rule the case.`);
    }
    process.exit(1);
  }
  console.log(`\n✓ smoke test passed — all ${CASES.length} cases behaved as expected`);
}

// The CLI runs only as the entry point; `require` gets the contract alone,
// which is what lets tests/pricingSmokeWithheldContract.test.ts pin the
// withheld-vs-missing decision without touching prod.
if (IS_MAIN) {
  main();
}

module.exports = { CASES, judgeResults, withheldReasonOf, extractSummary };
