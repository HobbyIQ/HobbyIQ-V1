/**
 * Phase A.2 / A.3 live sweep runner.
 *
 * Walks the (year × brand) matrix against Beckett's S3, staging per-tuple
 * JSON + SUMMARY + REPORT under `backend/data/beckett-sweep/`.
 *
 * Usage:
 *   npx tsx scripts/run-beckett-sweep.ts                       # default A.2 matrix
 *   npx tsx scripts/run-beckett-sweep.ts --years=2022,2023     # narrowed
 *   npx tsx scripts/run-beckett-sweep.ts --brands="Bowman,Bowman Chrome"
 *   npx tsx scripts/run-beckett-sweep.ts --concurrency=2 --force
 *
 *   # Phase A.3 — non-Bowman families, registry-driven year bounds
 *   npx tsx scripts/run-beckett-sweep.ts --family=non-bowman --concurrency=2 --force
 *
 *   # Phase A.3 — single family
 *   npx tsx scripts/run-beckett-sweep.ts --family=Topps --concurrency=2
 *
 * NO Cosmos writes. NO production mutations. Pure staging.
 */
import {
  runBeckettSweep,
  DEFAULT_YEARS,
  DEFAULT_BRANDS,
} from "../src/agents/beckett/sweepOrchestrator.js";
import {
  getNonBowmanBrands,
  getBrandsByFamily,
  type BrandFamily,
} from "../src/agents/beckett/brandRegistry.js";

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const yearsRaw = parseArg("years");
  const brandsRaw = parseArg("brands");
  const familyRaw = parseArg("family");
  const sourceRaw = parseArg("source") as "beckett" | "cardboard-connection" | undefined;
  const concurrencyRaw = parseArg("concurrency");
  const maxProbesRaw = parseArg("maxProbes");
  const outDirRaw = parseArg("outDir");

  const years = yearsRaw
    ? yearsRaw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : DEFAULT_YEARS;

  // Brand resolution precedence: --brands (literal) > --family > DEFAULT_BRANDS.
  let brands: readonly string[];
  let a3Mode = false;
  if (brandsRaw) {
    brands = brandsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (familyRaw) {
    a3Mode = true;
    if (familyRaw.toLowerCase() === "non-bowman") {
      brands = getNonBowmanBrands().map((e) => e.brandName);
    } else {
      const familyEntries = getBrandsByFamily(familyRaw as BrandFamily);
      if (familyEntries.length === 0) {
        throw new Error(
          `--family="${familyRaw}" matched 0 brands. Valid families: Bowman, Topps, Panini, Leaf, Onyx, Other; or "non-bowman".`,
        );
      }
      brands = familyEntries.map((e) => e.brandName);
    }
  } else {
    brands = DEFAULT_BRANDS;
  }

  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : 2;
  const maxProbes = maxProbesRaw ? Number(maxProbesRaw) : undefined;
  const force = hasFlag("force");

  console.log(
    `[runner] source=${sourceRaw ?? "beckett"} years=${years.length} brands=${brands.length} ` +
      `tuples<=${years.length * brands.length} concurrency=${concurrency} ` +
      `force=${force} a3=${a3Mode} maxProbes=${maxProbes ?? "default"}`,
  );

  const summary = await runBeckettSweep({
    source: sourceRaw ?? "beckett",
    years,
    brands,
    concurrency,
    force,
    outDir: outDirRaw,
    a3Mode,
    maxProbes,
  });

  console.log("[runner] DONE", {
    attempted: summary.tuplesAttempted,
    ok: summary.tuplesOk,
    missing: summary.tuplesMissing,
    errors: summary.tuplesError,
    durationMs: summary.durationMs,
    totalCards: summary.totalDedupedCards,
    totalParallels: summary.totalParallels,
    totalUnmatched: summary.totalUnmatchedParallels,
  });
}

main().catch((err) => {
  console.error("[runner] FATAL", err);
  process.exit(1);
});
