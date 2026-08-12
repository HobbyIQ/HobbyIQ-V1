// Reproduce the getGraderPremium ladder for Eric Hartman 2026 Bowman
// Chrome Prospect Autograph, Orange Shimmer Refractor, Raw baseline
// ~$1,713. Expected: distinct multipliers per grade tier (2 → 2.37 →
// 2.34 for PSA 8/9/10-ish; BGS 8/9/9.5/10 spread). Screenshot shows all
// PSA collapsed to $4,009 and all BGS collapsed to $5,311 — this probe
// finds which rung is returning the SAME value for all tiers.

import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";
import { lookupValueBandMultiplierWithScope, lookupGradeRatioByTier, lookupGradeRatio, classifyFamily } from "../src/services/compiq/gradeCalibrationConfig.js";

const raw = 1713;
const setName = "2026 Bowman Chrome Prospect Autographs";
const family = classifyFamily(setName);
const sport = "baseball";
const year = 2026;

console.log("family:", family, "sport:", sport, "year:", year, "raw:", raw);
console.log();

for (const grader of ["PSA", "BGS", "SGC"] as const) {
  const grades = grader === "BGS" ? ["8", "9", "9.5", "10"] : ["8", "9", "10"];
  for (const grade of grades) {
    const gv = Number(grade);
    // Isolate each rung:
    const bandLookup = lookupValueBandMultiplierWithScope(raw, grader, gv, { sport, family: family ?? null });
    const tierRatio = lookupGradeRatioByTier(family ?? null, grader, gv, sport);
    const familyScalar = lookupGradeRatio(family ?? null, grader, sport);

    const premium = getGraderPremium(grader, grade, raw, "autograph", year, setName, null, sport);
    const price = Math.round(raw * premium * 100) / 100;

    console.log(
      `${grader.padEnd(3)} ${grade.padEnd(4)} → mult=${premium.toFixed(3).padStart(6)}  price=$${String(price).padStart(9)}  ` +
      `[band=${bandLookup ? bandLookup.medianRatio.toFixed(3) + "@" + bandLookup.scope : "null"} ` +
      `tierRatio=${tierRatio ?? "null"} ` +
      `familyScalar=${familyScalar ?? "null"}]`
    );
  }
  console.log();
}
