// CF-VARIANT-FILTER-BACKTEST — paired tier-ladder measurement harness.
//
// Runs each holding in the admin-testing-hobbyiq cohort through
// /api/compiq/estimate TWICE:
//   - Arm A: ladder enabled (default)
//   - Arm B: ladder disabled (via x-variant-tier-ladder: disabled header,
//     authenticated as admin-testing-hobbyiq so the production gate
//     accepts the override per CF-VARIANT-FILTER-BACKTEST design lock)
//
// Reports three metrics that bind the Q7 trim decision from
// CF-VARIANT-FILTER-LOOSENING:
//
//   1. Rescue rate — % of cards live in Arm A but variant-mismatch in
//      Arm B. The tier ladder's primary effect: produce a price where
//      strict matching wouldn't.
//   2. Rescue MAPE per tier — for rescued cards, |Arm A FMV - reference
//      median| / reference, bucketed by tier (T1/T2/T3). Reference is
//      the median of recentComps returned by Arm A (internally
//      consistent — same comps the engine used to compute the FMV).
//   3. T0-stability MAPE delta — for cards that hit T0 in BOTH arms,
//      |Arm A FMV - Arm B FMV| / Arm A FMV. Should be ~0; non-zero
//      indicates the ladder bypass introduced an unexpected side effect.
//
// Run from backend/ directory:
//   $env:HBQ_COSMOS_CS = (az webapp config appsettings list -g rg-hobbyiq-dev -n HobbyIQ3 --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv)
//   npx tsx scripts/backtest_tier_ladder.ts
//
// Required env vars:
//   HBQ_COSMOS_CS — Cosmos read connection string (admin-testing-hobbyiq doc)
//   PROD_URL      — defaults to the HobbyIQ3 production URL
//
// Output:
//   - Console: aggregate three-metric summary + per-holding table
//   - JSON: docs/phase0/backtest_runs/<ts>-tier-ladder/results.json
//
// Idempotent + read-only. Production state untouched (PATCH/POST endpoints
// not called; only GET /ledger + POST /estimate which are pure).

import { CosmosClient } from "@azure/cosmos";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const cs = process.env.HBQ_COSMOS_CS;
if (!cs) {
  console.error("HBQ_COSMOS_CS not set");
  process.exit(2);
}
const dbName = process.env.HBQ_COSMOS_DB ?? "hobbyiq";
const userId = "admin-testing-hobbyiq";
const prodUrl =
  process.env.PROD_URL ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

interface PortfolioHolding {
  id: string;
  playerName?: string;
  cardYear?: number;
  year?: number;
  product?: string;
  setName?: string;
  cardTitle?: string;
  cardName?: string;
  parallel?: string;
  isAuto?: boolean;
  gradingCompany?: string;
  gradeCompany?: string;
  gradeValue?: number | string;
  [k: string]: unknown;
}

interface UserDoc {
  id: string;
  userId: string;
  holdings: Record<string, PortfolioHolding>;
}

function toNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shimmedCardYear(h: PortfolioHolding): number | undefined {
  return toNumber(h.cardYear ?? h.year, 0) || undefined;
}
function shimmedProduct(h: PortfolioHolding): string | undefined {
  return String(h.product ?? "").trim() || String(h.setName ?? "").trim() || undefined;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${prodUrl}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "HobbyIQ", password: "Baseball25" }),
  });
  if (!res.ok) throw new Error(`signin failed: ${res.status}`);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

interface EstimateResponse {
  source?: string;
  verdict?: string;
  fairMarketValue?: number | null;
  marketValue?: number | null;
  compsUsed?: number;
  compsAvailable?: number;
  confidence?: { pricingConfidence?: number };
  compQuality?: {
    variantStrictness?: string;
    tierLadderTrace?: Record<string, number>;
    reasons?: Record<string, number>;
  };
  recentComps?: Array<{ price: number; soldDate?: string | null; title?: string }>;
  build?: {
    shaShort?: string;
    shaFromCodeShort?: string | null;
  };
}

async function postEstimate(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<EstimateResponse> {
  const res = await fetch(`${prodUrl}/api/compiq/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as EstimateResponse;
}

function median(xs: number[]): number | null {
  const filtered = xs.filter((v) => Number.isFinite(v) && v > 0);
  if (filtered.length === 0) return null;
  const sorted = [...filtered].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface PerHoldingResult {
  id: string;
  idShort: string;
  playerName: string;
  shimmed: { cardYear?: number; product?: string; parallel?: string; isAuto: boolean };
  armA: {
    source: string | null;
    tier: string | null;
    tierLadderTrace: Record<string, number> | null;
    fairMarketValue: number | null;
    marketValue: number | null;
    pricingConfidence: number | null;
    compsUsed: number | null;
    referenceCompMedian: number | null; // median of recentComps for sanity-check
  };
  armB: {
    source: string | null;
    tier: string | null;
    tierLadderTrace: Record<string, number> | null;
    fairMarketValue: number | null;
    marketValue: number | null;
    pricingConfidence: number | null;
    compsUsed: number | null;
  };
  isRescue: boolean; // Arm A produced FMV, Arm B did not
  isT0BothArms: boolean; // T0 in both arms (T0-stability candidate)
  rescueErrorPct: number | null; // for rescues: |armA.fmv - referenceMedian| / referenceMedian
  t0StabilityErrorPct: number | null; // for T0-both: |armA.fmv - armB.fmv| / armA.fmv
}

async function main() {
  const startTs = new Date().toISOString();
  console.log("CF-VARIANT-FILTER-BACKTEST — paired tier-ladder measurement");
  console.log("=".repeat(78));
  console.log(`prod URL:    ${prodUrl}`);
  console.log(`cohort user: ${userId}`);
  console.log(`started:     ${startTs}`);
  console.log("");

  // Read cohort from Cosmos.
  const client = new CosmosClient(cs as string);
  const container = client.database(dbName).container("portfolio");
  const { resource: doc } = await container.item(userId, userId).read<UserDoc>();
  if (!doc) {
    console.error(`No portfolio doc for userId=${userId}`);
    process.exit(1);
  }
  const holdings = doc.holdings ?? {};
  const ids = Object.keys(holdings);
  console.log(`cohort size: ${ids.length} holdings`);
  console.log("");

  // Sign in to get a session — needed for Arm B's header override
  // (production gate requires admin-testing-hobbyiq session).
  console.log("Signing in as HobbyIQ to obtain session for header override...");
  const sessionId = await signIn();
  console.log(`session obtained (${sessionId.slice(0, 8)}...)`);
  console.log("");

  // Health check — confirm production has the new VARIANT_TIER_LADDER_ENABLED
  // env + header handling code. shaFromCodeShort must be defined; if it's
  // null the deployed dist predates CF-DEPLOY-SCRIPT-RESTART-FIX and we
  // should HALT.
  const healthRes = await fetch(`${prodUrl}/api/health`);
  const health = (await healthRes.json()) as EstimateResponse;
  const deployedSha = health.build?.shaFromCodeShort;
  console.log(`production shaFromCodeShort: ${deployedSha ?? "(missing — old dist)"}`);
  if (!deployedSha) {
    console.error("ABORT: production /api/health does not expose shaFromCodeShort. The deployed dist predates CF-DEPLOY-SCRIPT-RESTART-FIX. Deploy a newer SHA before running this harness.");
    process.exit(1);
  }
  console.log("");

  const rows: PerHoldingResult[] = [];

  for (const id of ids) {
    const h = holdings[id];
    const playerName = String(h.playerName ?? "").trim();
    const body = {
      playerName,
      cardYear: shimmedCardYear(h),
      product: shimmedProduct(h),
      parallel: h.parallel ?? undefined,
      isAuto: Boolean(h.isAuto),
      gradeCompany: h.gradingCompany ?? h.gradeCompany ?? undefined,
      gradeValue: h.gradeValue ?? undefined,
    };
    const idShort = id.slice(0, 8);
    process.stdout.write(`[${ids.indexOf(id) + 1}/${ids.length}] ${idShort}... ${playerName.slice(0, 40)} ... `);

    let armA: EstimateResponse;
    let armB: EstimateResponse;
    try {
      armA = await postEstimate(body);
    } catch (e) {
      console.log(`ERR (armA): ${(e as Error).message}`);
      continue;
    }
    try {
      armB = await postEstimate(body, {
        "x-variant-tier-ladder": "disabled",
        "x-session-id": sessionId,
      });
    } catch (e) {
      console.log(`ERR (armB): ${(e as Error).message}`);
      continue;
    }

    const aSource = armA.source ?? null;
    const bSource = armB.source ?? null;
    const aTier = armA.compQuality?.variantStrictness ?? null;
    const bTier = armB.compQuality?.variantStrictness ?? null;
    const aFmv = typeof armA.fairMarketValue === "number" ? armA.fairMarketValue : null;
    const bFmv = typeof armB.fairMarketValue === "number" ? armB.fairMarketValue : null;
    const aMarket = typeof armA.marketValue === "number" ? armA.marketValue : null;
    const bMarket = typeof armB.marketValue === "number" ? armB.marketValue : null;
    const aConf = armA.confidence?.pricingConfidence ?? null;
    const bConf = armB.confidence?.pricingConfidence ?? null;

    const armARefMedian = median((armA.recentComps ?? []).map((c) => c.price));
    const isRescue = aSource === "live" && bSource !== "live";
    const isT0BothArms = aSource === "live" && bSource === "live" && aTier === "T0" && bTier === "T0";

    let rescueErrorPct: number | null = null;
    if (isRescue && aFmv != null && armARefMedian != null && armARefMedian > 0) {
      rescueErrorPct = Math.abs(aFmv - armARefMedian) / armARefMedian * 100;
    }
    let t0StabilityErrorPct: number | null = null;
    if (isT0BothArms && aFmv != null && bFmv != null && aFmv > 0) {
      t0StabilityErrorPct = Math.abs(aFmv - bFmv) / aFmv * 100;
    }

    const tag = isRescue ? `RESCUE ${aTier}` : isT0BothArms ? "T0-BOTH" : `${aSource}/${bSource}`;
    console.log(`${tag} | A: ${aTier ?? "—"} fmv=${aFmv ?? "null"} | B: ${bTier ?? "—"} fmv=${bFmv ?? "null"}`);

    rows.push({
      id,
      idShort,
      playerName,
      shimmed: { cardYear: body.cardYear, product: body.product, parallel: body.parallel, isAuto: body.isAuto },
      armA: {
        source: aSource,
        tier: aTier,
        tierLadderTrace: armA.compQuality?.tierLadderTrace ?? null,
        fairMarketValue: aFmv,
        marketValue: aMarket,
        pricingConfidence: aConf,
        compsUsed: armA.compsUsed ?? null,
        referenceCompMedian: armARefMedian,
      },
      armB: {
        source: bSource,
        tier: bTier,
        tierLadderTrace: armB.compQuality?.tierLadderTrace ?? null,
        fairMarketValue: bFmv,
        marketValue: bMarket,
        pricingConfidence: bConf,
        compsUsed: armB.compsUsed ?? null,
      },
      isRescue,
      isT0BothArms,
      rescueErrorPct,
      t0StabilityErrorPct,
    });
  }

  // ── Three-metric aggregate ───────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(78));
  console.log("THREE-METRIC AGGREGATE");
  console.log("=".repeat(78));

  const totalCohort = rows.length;
  const rescues = rows.filter((r) => r.isRescue);
  const rescueRatePct = totalCohort > 0 ? (rescues.length / totalCohort) * 100 : 0;

  console.log(`\n1. RESCUE RATE`);
  console.log(`   ${rescues.length} of ${totalCohort} cards rescued by tier ladder (${rescueRatePct.toFixed(1)}%)`);
  if (rescues.length > 0) {
    const byTier = rescues.reduce<Record<string, number>>((acc, r) => {
      const t = r.armA.tier ?? "?";
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`   Rescue distribution by tier: ${JSON.stringify(byTier)}`);
  }

  console.log(`\n2. RESCUE MAPE PER TIER (Arm A FMV vs reference comp median)`);
  const byTier: Record<string, number[]> = {};
  for (const r of rescues) {
    if (r.rescueErrorPct == null || r.armA.tier == null) continue;
    (byTier[r.armA.tier] ??= []).push(r.rescueErrorPct);
  }
  for (const tier of ["T0", "T1", "T2", "T3"]) {
    const errs = byTier[tier];
    if (!errs || errs.length === 0) {
      console.log(`   ${tier}: n=0 (no rescues at this tier)`);
      continue;
    }
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const max = Math.max(...errs);
    console.log(`   ${tier}: n=${errs.length} MAPE=${mean.toFixed(1)}% max=${max.toFixed(1)}%`);
  }

  const t0BothArms = rows.filter((r) => r.isT0BothArms);
  const t0Errors = t0BothArms.map((r) => r.t0StabilityErrorPct).filter((v): v is number => v != null);
  console.log(`\n3. T0-STABILITY MAPE DELTA`);
  console.log(`   ${t0BothArms.length} cards hit T0 in both arms`);
  if (t0Errors.length === 0) {
    console.log(`   No T0-both-arms FMV pairs to compare`);
  } else {
    const mean = t0Errors.reduce((a, b) => a + b, 0) / t0Errors.length;
    const max = Math.max(...t0Errors);
    const nonZero = t0Errors.filter((v) => v > 0.01).length;
    console.log(`   T0-stability MAPE: mean=${mean.toFixed(2)}% max=${max.toFixed(2)}% non-zero count=${nonZero}/${t0Errors.length}`);
    console.log(`   (expected ~0; non-zero indicates ladder bypass produced different downstream pricing on T0 path)`);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("PER-HOLDING DETAIL");
  console.log("=".repeat(78));
  for (const r of rows) {
    const tag = r.isRescue ? "RESCUE" : r.isT0BothArms ? "T0-BOTH" : "—";
    console.log(`${r.idShort}  ${r.playerName.slice(0, 28).padEnd(28)} ${tag.padEnd(8)} A:${(r.armA.tier ?? "—").padEnd(3)} ${String(r.armA.fairMarketValue ?? "null").padStart(8)} | B:${(r.armB.tier ?? "—").padEnd(3)} ${String(r.armB.fairMarketValue ?? "null").padStart(8)}  refMed=${r.armA.referenceCompMedian ?? "—"}`);
  }

  // ── JSON dump ────────────────────────────────────────────────────────────
  const tsTag = startTs.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(__dirname, "..", "..", "docs", "phase0", "backtest_runs", `${tsTag}-tier-ladder`);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "results.json");
  await fs.writeFile(
    outFile,
    JSON.stringify(
      {
        runId: tsTag,
        startedAt: startTs,
        prodUrl,
        deployedSha,
        cohortUserId: userId,
        cohortSize: totalCohort,
        rescues: {
          count: rescues.length,
          ratePct: rescueRatePct,
        },
        rescueMapeByTier: Object.fromEntries(
          Object.entries(byTier).map(([tier, errs]) => [
            tier,
            {
              n: errs.length,
              mean: errs.reduce((a, b) => a + b, 0) / errs.length,
              max: Math.max(...errs),
              all: errs,
            },
          ]),
        ),
        t0Stability: {
          n: t0Errors.length,
          mean: t0Errors.length > 0 ? t0Errors.reduce((a, b) => a + b, 0) / t0Errors.length : null,
          max: t0Errors.length > 0 ? Math.max(...t0Errors) : null,
          nonZeroCount: t0Errors.filter((v) => v > 0.01).length,
        },
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("");
  console.log(`JSON dump: ${outFile}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
