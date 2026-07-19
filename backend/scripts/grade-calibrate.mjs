// Grade tier calibration — partitioned by product family to avoid
// the Cosmos SDK stack overflow on unbounded GROUP BY result sets.
import { CosmosClient } from "@azure/cosmos";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const connStr = process.env.COSMOS_CONNECTION_STRING;
if (!connStr) { console.error("COSMOS_CONNECTION_STRING missing"); process.exit(1); }

const client = new CosmosClient(connStr);
const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const container = db.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();

// Query in family-scoped chunks. Each chunk should return manageable
// aggregate rows.
const FAMILY_TOKENS = [
  { family: "bowman-chrome-draft", token: "Bowman Chrome Draft" },
  { family: "bowman-chrome", token: "Bowman Chrome" },
  { family: "bowman-sterling", token: "Bowman Sterling" },
  { family: "bowman", token: "Bowman" },
  { family: "topps-chrome-update", token: "Topps Chrome Update" },
  { family: "topps-chrome", token: "Topps Chrome" },
  { family: "topps-update", token: "Topps Update" },
  { family: "topps", token: "Topps" },
  { family: "panini-prizm", token: "Prizm" },
  { family: "panini-select", token: "Select" },
  { family: "panini-mosaic", token: "Mosaic" },
  { family: "panini-donruss", token: "Donruss" },
  { family: "panini-optic", token: "Optic" },
  { family: "upper-deck", token: "Upper Deck" },
];

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// Accumulate (family, grader) → [ratio per cardId]
const ratiosByFamilyGrader = new Map();

for (const { family, token } of FAMILY_TOKENS) {
  console.error(`\nFetching ${family} (token="${token}")...`);
  const iter = container.items.query({
    query: `SELECT c.card_id, c.grader,
                    AVG(c.price) AS avgPrice,
                    COUNT(1) AS n
             FROM c
             WHERE c.sale_date >= @cutoff
               AND c.price > 0
               AND CONTAINS(LOWER(c.card_set), LOWER(@token))
             GROUP BY c.card_id, c.grader`,
    parameters: [
      { name: "@cutoff", value: cutoff },
      { name: "@token", value: token },
    ],
  }, { maxItemCount: 200 });

  const familyResources = [];
  try {
    for await (const batch of iter.getAsyncIterator()) {
      for (const r of batch.resources) familyResources.push(r);
    }
  } catch (err) {
    console.error(`  ⚠ query failed for ${family}: ${err.message}`);
    continue;
  }
  console.error(`  got ${familyResources.length} (cardId, grader) rows`);

  // Bucket by cardId
  const byCard = new Map();
  for (const r of familyResources) {
    if (r.n < 3) continue;   // ≥3 sales per bucket
    if (!byCard.has(r.card_id)) byCard.set(r.card_id, {});
    byCard.get(r.card_id)[r.grader] = { avgPrice: r.avgPrice, n: r.n };
  }

  // Compute per-cardId ratios
  let cardsWithRatio = 0;
  for (const [, gradersByCard] of byCard) {
    const raw = gradersByCard["Raw"];
    if (!raw || raw.avgPrice <= 0) continue;
    cardsWithRatio++;
    for (const [grader, stats] of Object.entries(gradersByCard)) {
      if (grader === "Raw") continue;
      const ratio = stats.avgPrice / raw.avgPrice;
      if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 300) continue;
      const key = `${family}::${grader}`;
      if (!ratiosByFamilyGrader.has(key)) ratiosByFamilyGrader.set(key, []);
      ratiosByFamilyGrader.get(key).push(ratio);
    }
  }
  console.error(`  cards with Raw+graded pair: ${cardsWithRatio}`);
}

// Emit
const results = [];
for (const [key, arr] of ratiosByFamilyGrader) {
  if (arr.length < 5) continue;
  const [family, grader] = key.split("::");
  const med = median(arr);
  const sorted = arr.slice().sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  results.push({
    family,
    grader,
    n: arr.length,
    medianRatio: Math.round(med * 100) / 100,
    p25: Math.round(p25 * 100) / 100,
    p75: Math.round(p75 * 100) / 100,
  });
}
results.sort((a, b) => a.family.localeCompare(b.family) || a.grader.localeCompare(b.grader));

console.error("\n─── Empirical Grade Ratios (medianRatio = Graded / Raw) ───");
console.error("family                    grader        n      ratio (p25 - p75)");
for (const r of results) {
  console.error(`${r.family.padEnd(24)} ${r.grader.padEnd(12)} ${String(r.n).padStart(4)}   ${r.medianRatio.toFixed(2).padStart(6)}× (${r.p25.toFixed(2)}× - ${r.p75.toFixed(2)}×)`);
}

const grouped = results.reduce((acc, r) => {
  acc[r.family] = acc[r.family] || {};
  acc[r.family][r.grader] = { medianRatio: r.medianRatio, p25: r.p25, p75: r.p75, sampleSize: r.n };
  return acc;
}, {});

const ts = `// CF-GRADE-CALIBRATION (Drew, 2026-07-18). AUTO-GENERATED from
// backend/scripts/grade-calibrate.mjs against ch_daily_sales.
// Re-run periodically as pool grows. Ratios are graded/raw medians
// per (product-family, grader) with sample sizes ≥ 5 cardIds.
//
// Read at rung 5 of canonicalFmv.service.ts. Fallback to hardcoded
// defaults when a (family, grader) lookup misses.

export interface GradeCalibrationEntry {
  medianRatio: number;
  p25: number;
  p75: number;
  sampleSize: number;
}

export const GRADE_CALIBRATION: Record<string, Record<string, GradeCalibrationEntry>> = ${JSON.stringify(grouped, null, 2)};

/** Lookup helper. Returns null when the (family, grader) is uncovered. */
export function lookupGradeRatio(family: string, grader: string): number | null {
  const entry = GRADE_CALIBRATION[family]?.[grader];
  return entry ? entry.medianRatio : null;
}

/** Product-family classifier matching the calibration script. Any set
 *  string maps to a canonical family key or "other". */
export function classifyFamily(setName: string | null | undefined): string {
  const s = String(setName ?? "").toLowerCase();
  if (s.includes("bowman chrome draft") || s.includes("bowman draft chrome")) return "bowman-chrome-draft";
  if (s.includes("bowman chrome")) return "bowman-chrome";
  if (s.includes("bowman sterling")) return "bowman-sterling";
  if (s.includes("bowman")) return "bowman";
  if (s.includes("topps chrome update")) return "topps-chrome-update";
  if (s.includes("topps chrome")) return "topps-chrome";
  if (s.includes("topps update")) return "topps-update";
  if (s.includes("topps")) return "topps";
  if (s.includes("prizm")) return "panini-prizm";
  if (s.includes("select")) return "panini-select";
  if (s.includes("mosaic")) return "panini-mosaic";
  if (s.includes("donruss")) return "panini-donruss";
  if (s.includes("optic")) return "panini-optic";
  if (s.includes("upper deck")) return "upper-deck";
  return "other";
}
`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outPath = join(__dirname, "src/services/compiq/gradeCalibrationConfig.ts");
writeFileSync(outPath, ts, "utf-8");
console.error(`\n✓ Wrote ${outPath}`);
console.error(`  ${results.length} (family, grader) entries with n≥5`);
