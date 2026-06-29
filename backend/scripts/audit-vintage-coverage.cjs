// Audit the committed vintage-multipliers-latest.json to surface
// (era, company, grade, tier) bins with sample size n < 3 (which
// fell to fallback in the calibration). The output drives CF-VINTAGE-
// CALIBRATION-PASS-2: add SEARCHES that would surface more cards in
// the weakest segments, then re-scan.

const fs = require("fs");
const path = require("path");

const JSON_PATH = "C:/temp/hobbyiq-cardsight-clean/backend/data/vintage-multipliers-latest.json";

const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));

// Walk diagnostics: ratios[era][company][grade][tier] = {n, ratio} or
// {n, trimmedMedian, ...}. Identify bins with n < 3 (no table entry
// emitted) and bins with n in [3, 5] (low-confidence, eligible for
// reinforcement).
const weak = []; // { era, company, grade, tier, n }
const lowConf = []; // n in [3, 5]
const strong = []; // n >= 20

for (const era of Object.keys(data.diagnostics)) {
  for (const company of Object.keys(data.diagnostics[era])) {
    for (const grade of Object.keys(data.diagnostics[era][company])) {
      for (const tier of Object.keys(data.diagnostics[era][company][grade])) {
        const diag = data.diagnostics[era][company][grade][tier];
        const n = diag?.n ?? 0;
        const entry = { era, company, grade, tier, n };
        if (n < 3) weak.push(entry);
        else if (n <= 5) lowConf.push(entry);
        else if (n >= 20) strong.push(entry);
      }
    }
  }
}

// Aggregate by (era, company, grade) — show how many tiers in each
// row are weak. A row with most tiers weak is a high-priority target
// for adding more searches.
const rowQuality = {};
for (const w of [...weak, ...lowConf]) {
  const key = `${w.era}|${w.company}|${w.grade}`;
  rowQuality[key] = rowQuality[key] || { weak: 0, lowConf: 0, era: w.era, company: w.company, grade: w.grade };
  if (w.n < 3) rowQuality[key].weak += 1;
  else rowQuality[key].lowConf += 1;
}

console.log(`\n=== VINTAGE TABLE COVERAGE AUDIT ===`);
console.log(`Sample: ${data.sampleSize.totalObservations} obs, ${data.sampleSize.uniqueCards} cards`);
console.log(`Calibrated: ${data.calibratedAt}`);
console.log(`\nTotal bins: weak (n<3, no entry): ${weak.length}, low-conf (n 3-5): ${lowConf.length}, strong (n>=20): ${strong.length}`);

// Top-10 high-grade weak bins by era (PSA 8/9/10 is what matters most for valuation)
const HIGH_GRADES = new Set(["8", "8.5", "9", "9.5", "10"]);
console.log(`\n--- WEAK BINS IN HIGH GRADES (PSA/BGS/SGC 8-10) ---`);
const weakHigh = weak.filter((w) => HIGH_GRADES.has(w.grade));
for (const w of weakHigh.slice(0, 30)) {
  console.log(`  ${w.era}  ${w.company} ${w.grade}  tier=${w.tier}  n=${w.n}`);
}

// Era × tier coverage summary
console.log(`\n--- HIGH-GRADE TIER COVERAGE BY ERA (PSA 8/9/10 only) ---`);
for (const era of ["1948-1969", "1970-1989"]) {
  console.log(`\n${era}:`);
  for (const grade of ["8", "9", "10"]) {
    const psaRow = data.diagnostics[era]?.PSA?.[grade];
    if (!psaRow) { console.log(`  PSA ${grade}: row missing`); continue; }
    const tierStats = Object.entries(psaRow).map(([t, d]) => `${t}=n${d.n}`).join(" | ");
    console.log(`  PSA ${grade}: ${tierStats}`);
  }
}

// Pass-2 SEARCHES proposal
console.log(`\n--- PASS-2 SEARCHES PROPOSAL ---`);
console.log(`Focus: weak high-grade bins by era × tier`);

const proposals = new Set();
// Map era + tier to suggested searches that would surface more cards
for (const w of weakHigh) {
  // For 1948-1969 weak bins, common HOF prospects we haven't searched
  if (w.era === "1948-1969") {
    proposals.add(`"1954 Topps Baseball Banks"`);
    proposals.add(`"1955 Topps Baseball Killebrew"`);
    proposals.add(`"1956 Topps Baseball Ford"`);
    proposals.add(`"1957 Topps Baseball Drysdale"`);
    proposals.add(`"1958 Topps Baseball Robinson"`);
    proposals.add(`"1960 Topps Baseball Yastrzemski"`);
    proposals.add(`"1961 Topps Baseball Carew"`);
    proposals.add(`"1963 Topps Baseball Stargell"`);
    proposals.add(`"1964 Topps Baseball Niekro"`);
    proposals.add(`"1965 Topps Baseball Carlton"`);
    proposals.add(`"1966 Topps Baseball Palmer"`);
    proposals.add(`"1968 Topps Baseball Bench RC"`);
    proposals.add(`"1969 Topps Baseball Mantle Last Card"`);
  }
  if (w.era === "1970-1989") {
    proposals.add(`"1972 Topps Baseball Carlton"`);
    proposals.add(`"1974 Topps Baseball Schmidt RC"`);
    proposals.add(`"1976 Topps Baseball Dennis Eckersley RC"`);
    proposals.add(`"1980 Topps Baseball Henderson RC"`);
    proposals.add(`"1982 Topps Traded Cal Ripken RC"`);
    proposals.add(`"1983 Topps Tony Gwynn RC"`);
    proposals.add(`"1984 Donruss Don Mattingly RC"`);
    proposals.add(`"1984 Fleer Update Roger Clemens"`);
    proposals.add(`"1985 Topps Mark McGwire RC"`);
    proposals.add(`"1986 Donruss Jose Canseco RC"`);
    proposals.add(`"1986 Fleer Update Bonds"`);
    proposals.add(`"1987 Topps Bo Jackson RC"`);
    proposals.add(`"1988 Score Glavine RC"`);
    proposals.add(`"1989 Bowman Ken Griffey Jr RC"`);
    proposals.add(`"1989 Upper Deck Griffey RC"`);
    proposals.add(`"1989 Donruss Randy Johnson RC"`);
  }
}

console.log(`\nAdd these ${proposals.size} searches to SEARCHES[] in calibrate-vintage-multipliers.cjs:`);
for (const p of Array.from(proposals).sort()) {
  console.log(`  ${p},`);
}

// Also surface low-tier (sub-$50 raw) coverage which is large in count
// but volume-low compared to high-end cards
console.log(`\n--- WEAKEST TIER PER ROW (high-grade) ---`);
const tierOrder = ["<50", "50-100", "100-500", "500-1000", "1000-5000", "5000+"];
for (const era of ["1948-1969", "1970-1989"]) {
  for (const grade of ["8", "9", "10"]) {
    const psaRow = data.diagnostics[era]?.PSA?.[grade];
    if (!psaRow) continue;
    const missing = tierOrder.filter((t) => (psaRow[t]?.n ?? 0) < 3);
    if (missing.length) {
      console.log(`  ${era}  PSA ${grade}: MISSING TIERS [${missing.join(", ")}]`);
    }
  }
}
