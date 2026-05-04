/**
 * Variant Price Analysis Script
 *
 * For a given numbered parallel (e.g. Gold /50), this script queries the live
 * CompIQ API for the solid color, wave, shimmer, and mojo variants and prints
 * the actual price ratios observed in sold-listing data.
 *
 * Goal: validate / calibrate the variantMultiplier values in compiqSearchService.ts
 *
 * Usage:
 *   node scripts/variant-price-analysis.js
 *
 * Optional env: API_BASE (defaults to production URL)
 */

const API_BASE =
  process.env.API_BASE ||
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

// ─── Test matrix ─────────────────────────────────────────────────────────────
// Each group is one player + numbered tier tested across all variant types.
// Use cards with enough volume so we get real samples (popular players/sets).
const GROUPS = [
  {
    label: "Topps Chrome Gold /50",
    base: "Topps Chrome Gold",
    printRun: "/50",
    player: "Jackson Chourio",
    year: "2024",
    set: "Topps Chrome",
  },
  {
    label: "Bowman Chrome Blue /150",
    base: "Bowman Chrome Blue",
    printRun: "/150",
    player: "Paul Skenes",
    year: "2024",
    set: "Bowman Chrome",
  },
  {
    label: "Prizm Gold /10",
    base: "Prizm Gold",
    printRun: "/10",
    player: "Victor Wembanyama",
    year: "2023",
    set: "Prizm",
  },
];

// Variants to test for each group
const VARIANTS = [
  { label: "Solid (true color)", suffix: "" },           // e.g. "Topps Chrome Gold /50"
  { label: "Wave", suffix: " Wave" },                     // e.g. "Topps Chrome Gold Wave /50"
  { label: "Shimmer", suffix: " Shimmer" },               // e.g. "Topps Chrome Gold Shimmer /50"
  { label: "Mojo", suffix: " Mojo" },                     // e.g. "Prizm Gold Mojo /10"
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function searchCard(query) {
  const res = await fetch(`${API_BASE}/api/compiq/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for: ${query}`);
  return res.json();
}

function fmtPrice(n) {
  if (n == null || n === 0) return "   n/a  ";
  return `$${n.toFixed(2).padStart(7)}`;
}

function fmtRatio(base, variant) {
  if (!base || !variant) return "  —  ";
  const r = variant / base;
  const pct = ((r - 1) * 100).toFixed(1);
  const sign = r >= 1 ? "+" : "";
  return `${sign}${pct}%`.padStart(7);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const group of GROUPS) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`  ${group.label}  —  ${group.year} ${group.player}`);
    console.log(`${"═".repeat(72)}`);
    console.log(
      `  ${"Variant".padEnd(22)} ${"Value".padStart(10)}  ${"Confidence".padStart(12)}  ${"vs Solid".padStart(9)}  Comps`,
    );
    console.log(`  ${"-".repeat(68)}`);

    const results = [];

    for (const variant of VARIANTS) {
      const query = `${group.year} ${group.base}${variant.suffix} ${group.printRun} ${group.player}`;
      let data = null;
      try {
        data = await searchCard(query);
      } catch (e) {
        console.log(`  ${variant.label.padEnd(22)}  ERROR: ${e.message}`);
        results.push({ variant: variant.label, value: null, confidence: 0, comps: 0 });
        await delay(2000);
        continue;
      }

      const value = data?.marketTier?.value ?? null;
      const confidence = data?.confidence ?? 0;
      const comps = data?.recentComps?.length ?? 0;
      const trend = data?.trendAnalysis?.market_direction ?? "?";
      results.push({ variant: variant.label, value, confidence, comps, trend });

      // Respect Apify rate limits
      await delay(3500);
    }

    // Print rows with ratio vs solid
    const solidResult = results.find((r) => r.variant === "Solid (true color)");
    const solidValue = solidResult?.value ?? null;

    for (const r of results) {
      const ratio = fmtRatio(solidValue, r.value);
      console.log(
        `  ${r.variant.padEnd(22)} ${fmtPrice(r.value)}  ${String(Math.round(r.confidence * 100) + "%").padStart(10)}  ${ratio}  ${r.comps} sales`,
      );
    }

    // ── Calibration summary ────────────────────────────────────────────────
    console.log(`\n  Calibration notes for compiqSearchService.ts:`);
    if (solidValue) {
      for (const r of results.filter((r) => r.variant !== "Solid (true color)")) {
        if (r.value && solidValue) {
          const measured = r.value / solidValue;
          const label = r.variant.toLowerCase().includes("wave")
            ? "wave"
            : r.variant.toLowerCase().includes("shimmer")
            ? "shimmer"
            : r.variant.toLowerCase().includes("mojo")
            ? "mojo"
            : "unknown";

          const CURRENT_MULTIPLIERS = { wave: 0.80, mojo: 0.76, shimmer: 0.68, unknown: 0.82 };
          const current = CURRENT_MULTIPLIERS[label];
          const diff = Math.abs(measured - current);
          const note =
            diff > 0.08
              ? `⚠  UPDATE → variantMultiplier("${label}") = ${measured.toFixed(2)} (currently ${current})`
              : `✓  variantMultiplier("${label}") = ${current} (actual ≈ ${measured.toFixed(2)})`;
          console.log(`    ${note}`);
        }
      }
    } else {
      console.log("    (no solid baseline — cannot compute ratios)");
    }
  }

  console.log(`\n${"═".repeat(72)}\n`);
})();
