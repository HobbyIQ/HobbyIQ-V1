// Full graded-holdings sweep with before/after FMV + sample-quality
// capture. Built for CF-CARDSIGHT-TRANSLATER-GRADE-WIRING verification;
// retained as the canonical audit harness for CF-CARDSIGHT-GRADE-
// WIRING-AUDIT and future grade-path changes.
//
// For EVERY graded holding in the target user's portfolio:
//   - Read stored fields directly from Cosmos (no test-input guessing)
//   - Capture BEFORE FMV/source/priceSource fields
//   - Trigger /api/portfolio/holdings/:id/refresh (real autoPriceHolding)
//   - Capture AFTER FMV/source/priceSource fields
//   - Also probe /api/compiq/estimate (separate read-only path) for
//     full recentComps + parallelMatchFilteredCount/UnifiedCount
//     for sample-quality inspection
//
// Sample-quality fields:
//   - graded sample size (compsUsed)
//   - graded sample price range (min/max from recentComps)
//   - parallel title spot-check: do graded records' titles actually
//     contain the holding's parallel token? (catches bucket pollution
//     where title-match × grade-filter interaction lets non-parallel
//     records through — first surfaced by the Maddux Tiffany sweep)
//
// Required env:
//   AUTH_SESSION_SECRET            (mints session for the target user)
//   COSMOS_CONNECTION_STRING       (reads portfolio container)
// Optional:
//   SITE_URL                       (defaults to prod)
//   SWEEP_USER_ID                  (defaults to admin-testing-hobbyiq)

const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");

const USER_ID = process.env.SWEEP_USER_ID || "admin-testing-hobbyiq";
const SITE = process.env.SITE_URL || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const SESSION_TTL_MS = 60 * 60 * 1000;

function mintSession(userId, secret) {
  const payload = Buffer.from(JSON.stringify({
    userId, expiresAt: Date.now() + SESSION_TTL_MS, nonce: crypto.randomUUID(),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function postRefresh(holdingId, sessionId) {
  const r = await fetch(`${SITE}/api/portfolio/holdings/${encodeURIComponent(holdingId)}/refresh`, {
    method: "POST",
    headers: { "x-session-id": sessionId, "content-type": "application/json" },
    signal: AbortSignal.timeout(90_000),
  });
  return { status: r.status, body: await r.json() };
}

async function probeEstimate(h) {
  const body = {
    playerName: h.playerName,
    cardYear: Number(h.year) || h.year,
    product: h.product,
    parallel: h.parallel,
    gradeCompany: h.gradeCompany,
    gradeValue: h.gradeValue,
  };
  const r = await fetch(`${SITE}/api/compiq/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return await r.json();
}

function summarizeComps(comps, parallelToken) {
  if (!Array.isArray(comps) || comps.length === 0) return { count: 0 };
  const prices = comps.map((c) => Number(c.price)).filter((p) => Number.isFinite(p));
  const sorted = [...prices].sort((a, b) => a - b);
  let parallelTitleHits = null;
  let parallelTitleMisses = null;
  let missTitles = [];
  if (parallelToken) {
    const rx = new RegExp(parallelToken, "i");
    parallelTitleHits = 0;
    parallelTitleMisses = 0;
    for (const c of comps) {
      if (rx.test(c.title ?? "")) parallelTitleHits++;
      else {
        parallelTitleMisses++;
        if (missTitles.length < 3) missTitles.push((c.title ?? "").slice(0, 80));
      }
    }
  }
  return {
    count: comps.length,
    minPrice: sorted[0],
    maxPrice: sorted[sorted.length - 1],
    medianPrice: sorted[Math.floor(sorted.length / 2)],
    parallelToken,
    parallelTitleHits,
    parallelTitleMisses,
    sampleMissTitles: missTitles,
  };
}

async function main() {
  const secret = process.env.AUTH_SESSION_SECRET;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!secret || !cs) { console.error("env missing"); process.exit(2); }

  const sessionId = mintSession(USER_ID, secret);
  const cosmos = new CosmosClient(cs).database("hobbyiq").container("portfolio");

  // Pull all holdings
  const { resource: doc } = await cosmos.item(USER_ID, USER_ID).read();
  const holdings = doc?.holdings ?? {};
  console.log(JSON.stringify({ event: "scan_start", totalHoldings: Object.keys(holdings).length }));

  // Filter to GRADED holdings (gradeCompany present + gradeValue present)
  const gradedHoldings = Object.entries(holdings).filter(([id, h]) =>
    h.gradeCompany && h.gradeValue != null && String(h.gradeValue).toLowerCase() !== "raw"
  );
  console.log(JSON.stringify({ event: "graded_holdings_found", count: gradedHoldings.length }));

  for (const [hid, before] of gradedHoldings) {
    console.log("");
    console.log("======================================================================");
    console.log(JSON.stringify({
      event: "holding",
      holdingId: hid,
      playerName: before.playerName,
      year: before.year,
      product: before.product,
      parallel: before.parallel,
      gradeCompany: before.gradeCompany,
      gradeValue: before.gradeValue,
    }));

    // BEFORE state
    console.log(JSON.stringify({
      event: "before",
      fmv: before.fairMarketValue,
      currentValue: before.currentValue,
      quickSale: before.quickSaleValue,
      premium: before.premiumValue,
      compsUsed: before.compsUsed,
      confidence: before.confidence,
      lastUpdated: before.lastUpdated,
    }));

    // Estimate probe (separate read-only — captures full priceSource/sample info)
    let est;
    try {
      est = await probeEstimate(before);
    } catch (e) {
      console.log(JSON.stringify({ event: "probe_error", error: e.message }));
      continue;
    }

    const parallelToken = before.parallel ? before.parallel.toLowerCase() : null;
    const compSummary = summarizeComps(est.recentComps, parallelToken);
    console.log(JSON.stringify({
      event: "estimate_probe",
      cardId: est.cardIdentity?.card_id,
      source: est.source,
      fmv: est.fairMarketValue,
      quickSale: est.quickSaleValue,
      premium: est.premiumValue,
      priceSource: est.priceSource,
      priceSourceInternal: est.priceSourceInternal,
      parallelMatchFilteredCount: est.parallelMatchFilteredCount,
      parallelMatchUnifiedCount: est.parallelMatchUnifiedCount,
      compsUsed: est.compsUsed,
      verdict: est.verdict ? String(est.verdict).slice(0, 120) : null,
    }));
    console.log(JSON.stringify({ event: "sample_quality", ...compSummary }));

    // Show top 5 comp titles for spot-check
    if (Array.isArray(est.recentComps) && est.recentComps.length > 0) {
      console.log("recentComps (top 5):");
      for (const c of est.recentComps.slice(0, 5)) {
        console.log("  $" + c.price + " | " + (c.title ?? "").slice(0, 100));
      }
    }

    // Refresh holding via real autoPriceHolding path
    try {
      const ref = await postRefresh(hid, sessionId);
      // Read AFTER
      const { resource: docAfter } = await cosmos.item(USER_ID, USER_ID).read();
      const after = docAfter?.holdings?.[hid];
      console.log(JSON.stringify({
        event: "after",
        refreshHttp: ref.status,
        fmv: after?.fairMarketValue,
        currentValue: after?.currentValue,
        quickSale: after?.quickSaleValue,
        premium: after?.premiumValue,
        compsUsed: after?.compsUsed,
        lastUpdated: after?.lastUpdated,
      }));

      // Flag suspected regressions / improvements
      const fmvBefore = Number(before.fairMarketValue) || 0;
      const fmvAfter = Number(after?.fairMarketValue) || 0;
      const changePct = fmvBefore > 0 ? Math.round(((fmvAfter - fmvBefore) / fmvBefore) * 100) : null;
      console.log(JSON.stringify({
        event: "delta",
        fmvBefore,
        fmvAfter,
        absoluteDelta: fmvAfter - fmvBefore,
        changePct,
      }));
    } catch (e) {
      console.log(JSON.stringify({ event: "refresh_error", error: e.message }));
    }
  }

  console.log("");
  console.log(JSON.stringify({ event: "scan_done" }));
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
