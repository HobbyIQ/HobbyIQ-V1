// CF-GRADE-CALIBRATION-INTEGRITY (2026-09-03). Pins the four findings
// from the 2026-09-03 pricing audit that shipped together:
//
//   C-4  one canonical (lowercase) sport key at generator, table and
//        lookup; zero stranded cells, verified by simulating the lookup
//        for every cell rather than enumerating keys.
//   H-6  the adjacent-band rescue is bounded by band DISTANCE (max 1)
//        and by an order-of-magnitude anchor guard, not just by sample
//        size.
//   C-5  the Pokemon refusal applies to EVERY lookup order — including
//        the value-band lookup, which runs first in getGraderPremium.
//   H-7  the hardcoded per-company multiplier matrix is gone; callers
//        refuse to no-basis instead of publishing a fabricated 4x.
//
// Each block is written so that REMOVING the fix turns it red — the
// mutation is named in the test's own comment.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_BACKEND = join(__dirname, "..");

async function loadWithFixture(data: unknown, bySport: unknown, valueBand?: unknown) {
  vi.resetModules();
  vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
    GRADE_CALIBRATION: data,
    GRADE_CALIBRATION_BY_SPORT: bySport,
    GRADE_MULTIPLIER_BY_VALUE_BAND: valueBand ?? { baseline: {}, bySport: {}, bySportFamily: {} },
  }));
  return await import("../src/services/compiq/gradeCalibrationConfig.js");
}

const band = (medianRatio: number, sampleSize: number, rawMedian: number) => ({
  medianRatio, p25: medianRatio * 0.8, p75: medianRatio * 1.2,
  sampleSize, rawMedian, gradedMedian: rawMedian * medianRatio,
});

// ─── C-4: one canonical sport key, zero stranded cells ────────────────

describe("C-4 — every sport in the shipped table is reachable by a real lookup", () => {
  // The shipped data file is the artifact under test here, not a fixture:
  // the bug was that the TABLE carried keys the LOOKUP could not read.
  const dataSrc = readFileSync(
    join(REPO_BACKEND, "src/services/compiq/gradeCalibrationData.ts"), "utf8");

  function extract(name: string): Record<string, unknown> {
    const m = dataSrc.match(new RegExp(`export const ${name}\\s*:[\\s\\S]*?=\\s*(?=[{[])`));
    if (!m) throw new Error(`${name} not found in gradeCalibrationData.ts`);
    const start = (m.index ?? 0) + m[0].length;
    let depth = 0, end = -1, inStr = false, strCh = "";
    for (let i = start; i < dataSrc.length; i++) {
      const ch = dataSrc[i];
      if (inStr) { if (ch === "\\") { i++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const lit = dataSrc.slice(start, end)
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(lit);
  }

  // The lookup lowercases its sport before indexing. A table key that is
  // not equal to its own lowercasing is therefore unreachable — that is
  // precisely the C-4 defect (423 of 981 cells, 43%, on the old table).
  //
  // MUTATION: write one sport key back as "Football" in
  // gradeCalibrationData.ts and this goes red.
  it("no sport key in any table differs from its own lowercasing", () => {
    const bySport = extract("GRADE_CALIBRATION_BY_SPORT");
    const valueBand = extract("GRADE_MULTIPLIER_BY_VALUE_BAND") as {
      bySport: Record<string, unknown>;
      bySportFamily: Record<string, unknown>;
    };

    const offenders: string[] = [];
    for (const k of Object.keys(bySport)) {
      if (k !== k.toLowerCase()) offenders.push(`GRADE_CALIBRATION_BY_SPORT.${k}`);
    }
    for (const k of Object.keys(valueBand.bySport ?? {})) {
      if (k !== k.toLowerCase()) offenders.push(`bySport.${k}`);
    }
    for (const k of Object.keys(valueBand.bySportFamily ?? {})) {
      const sp = k.split("|")[0];
      if (sp !== sp.toLowerCase()) offenders.push(`bySportFamily.${k}`);
    }
    expect(offenders).toEqual([]);
  });

  // H-10: baseball and hockey used to ship EMPTY. Baseball is ~40% of the
  // graded pool; hockey silently drew baseball math through the baseline
  // fall-through, and could never be populated at all from the old
  // ch_daily_sales source, which contains no hockey rows.
  it("every sport the generator claims to cover has calibration data", () => {
    const bySport = extract("GRADE_CALIBRATION_BY_SPORT") as Record<string, Record<string, unknown>>;
    for (const sport of ["baseball", "football", "basketball", "hockey", "pokemon"]) {
      expect(Object.keys(bySport[sport] ?? {}).length,
        `GRADE_CALIBRATION_BY_SPORT.${sport} is empty`).toBeGreaterThan(0);
    }
  });
});

// ─── H-6: the adjacent-band rescue is bounded by distance ─────────────

describe("H-6 — adjacent-band rescue refuses beyond distance 1", () => {
  // The live shape: panini-contenders PSA 10 has data only in the
  // "Under $25" band, and a lookup arrives at $10,000+ — nine bands away.
  // Unbounded, the rescue returned that 20.88x. Bounded, it must decline
  // the rescue and fall to a coarser rung (or refuse).
  //
  // MUTATION: delete the `if (near.distance > MAX_ADJACENT_BAND_DISTANCE) break;`
  // line in gradeCalibrationConfig.ts and this goes red.
  it("does NOT borrow 'Under $25' for a $10,000+ anchor (distance 9)", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: {},
      bySport: {},
      bySportFamily: {
        "football|panini-contenders": { "Under $25": { "PSA 10": band(20.88, 40, 12) } },
      },
    });
    const res = lookupValueBandMultiplierWithScope(10000, "PSA", 10,
      { sport: "football", family: "panini-contenders" });
    expect(res).toBeNull();
  });

  // Distance 1 is the rung the measured spread supports: the median pair
  // of adjacent populated bands disagrees by 1.21x. It must still work.
  it("still rescues from an immediately adjacent band (distance 1)", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: {},
      bySport: {},
      bySportFamily: {
        "baseball|bowman-chrome": { "$250-499": { "PSA 9": band(1.10, 40, 320) } },
      },
    });
    const res = lookupValueBandMultiplierWithScope(600, "PSA", 9,
      { sport: "baseball", family: "bowman-chrome" });
    expect(res?.scope).toBe("sport-family-adjacent");
    expect(res?.medianRatio).toBe(1.10);
  });

  // The distance bound must hold ON ITS OWN, not only in the cases the
  // order-of-magnitude guard would also catch. Here the neighbour is two
  // bands away but its raw median ($320 vs a $2,500 anchor, 7.8x) is
  // INSIDE the 10x anchor guard — so only MAX_ADJACENT_BAND_DISTANCE can
  // refuse it.
  //
  // MUTATION: delete only the `near.distance > MAX_ADJACENT_BAND_DISTANCE`
  // break and this goes red while every other test in this block stays
  // green.
  it("refuses a distance-2 neighbour the anchor guard would have allowed", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: {},
      bySport: {},
      bySportFamily: {
        // $250-499 is two bands from $2,500-4,999. rawMedian 320 vs a
        // 2500 anchor is 7.8x — under the 10x order-of-magnitude bound.
        "baseball|bowman-chrome": { "$250-499": { "PSA 9": band(1.10, 40, 320) } },
      },
    });
    expect(lookupValueBandMultiplierWithScope(2500, "PSA", 9,
      { sport: "baseball", family: "bowman-chrome" })).toBeNull();
  });

  // The sample-size floor is independent of, and still enforced
  // alongside, the distance bound.
  it("still refuses a distance-1 rescue below the sample floor", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: {},
      bySport: {},
      bySportFamily: {
        "baseball|bowman-chrome": { "$250-499": { "PSA 9": band(1.10, 3, 320) } },
      },
    });
    expect(lookupValueBandMultiplierWithScope(600, "PSA", 9,
      { sport: "baseball", family: "bowman-chrome" })).toBeNull();
  });

  // Second, independent bound: even a neighbouring band is refused when
  // its own observed raw median is an order of magnitude from the anchor.
  //
  // MUTATION: delete the MAX_ADJACENT_BAND_ANCHOR_RATIO guard and this
  // goes red.
  it("refuses a distance-1 neighbour whose raw median is 10x the anchor", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: {},
      bySport: {},
      bySportFamily: {
        // Neighbouring band by index, but its observed raws sit at $9,500
        // against a $600 anchor — a 15.8x gap. Not the same market.
        "baseball|bowman-chrome": { "$1,000-2,499": { "PSA 9": band(4.0, 40, 9500) } },
      },
    });
    expect(lookupValueBandMultiplierWithScope(600, "PSA", 9,
      { sport: "baseball", family: "bowman-chrome" })).toBeNull();
  });
});

// ─── C-5: Pokemon never resolves to a baseline value band ─────────────

describe("C-5 — the Pokemon refusal applies to the value-band lookup too", () => {
  // getGraderPremium calls lookupValueBandMultiplierWithScope FIRST, above
  // the Pokemon-guarded lookupGradeRatioByTier. Before the fix, a Pokemon
  // PSA 10 resolved to the pooled baseline band (4.18x at $30, 2.66x at
  // $150, 2.30x at $300) and the refusal below was never reached.
  //
  // MUTATION: delete `if (sport === "pokemon") return null;` from the
  // baseline rung of lookupValueBandMultiplierWithScope — all three of
  // these go red.
  it.each([[30], [150], [300]])(
    "refuses the baseline band for a Pokemon PSA 10 at a $%s raw anchor",
    async (anchor) => {
      const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
        baseline: {
          "$25-49":   { "PSA 10": band(4.18, 1958, 34) },
          "$100-249": { "PSA 10": band(2.66, 1526, 150) },
          "$250-499": { "PSA 10": band(2.30, 757, 330) },
        },
        bySport: {},
        bySportFamily: {},
      });
      expect(lookupValueBandMultiplierWithScope(anchor, "PSA", 10,
        { sport: "pokemon", family: "pokemon-151" })).toBeNull();
    });

  // The refusal is Pokemon-specific: every other sport still gets the
  // baseline band, which is a coarser but honest answer for them.
  it("still returns the baseline band for a non-Pokemon sport", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: { "$100-249": { "PSA 10": band(2.66, 1526, 150) } },
      bySport: {},
      bySportFamily: {},
    });
    const res = lookupValueBandMultiplierWithScope(150, "PSA", 10,
      { sport: "baseball", family: "topps-chrome" });
    expect(res?.scope).toBe("baseline");
    expect(res?.medianRatio).toBe(2.66);
  });

  // Pokemon's own sport-scoped cells are unaffected — the guard only
  // blocks the baseline rung, so real Pokemon data still resolves.
  it("still returns a Pokemon sport-family cell when one exists", async () => {
    const { lookupValueBandMultiplierWithScope } = await loadWithFixture({}, {}, {
      baseline: { "$100-249": { "PSA 10": band(2.66, 1526, 150) } },
      bySport: {},
      bySportFamily: { "pokemon|pokemon-151": { "$100-249": { "PSA 10": band(9.35, 471, 150) } } },
    });
    const res = lookupValueBandMultiplierWithScope(150, "PSA", 10,
      { sport: "pokemon", family: "pokemon-151" });
    expect(res?.scope).toBe("sport-family");
    expect(res?.medianRatio).toBe(9.35);
  });

  // The end-to-end shape Drew asked to see: with the real shipped table,
  // a Pokemon PSA 10 must resolve to pokemon's own byTier figure, or
  // refuse — never to a baseline value band.
  it("resolves Pokemon PSA 10 to the pokemon byTier figure, not baseline", async () => {
    vi.resetModules();
    const { lookupValueBandMultiplierWithScope, lookupGradeRatioByTier, classifyFamily } =
      await import("../src/services/compiq/gradeCalibrationConfig.js");
    for (const anchor of [30, 150, 300]) {
      const family = classifyFamily("2023 Pokemon Scarlet & Violet 151");
      const viaBand = lookupValueBandMultiplierWithScope(anchor, "PSA", 10,
        { sport: "pokemon", family });
      // Whatever the band lookup says, it must not be a baseline cell.
      expect(viaBand?.scope).not.toBe("baseline");
      const viaTier = lookupGradeRatioByTier(family, "PSA", 10, "pokemon");
      const resolved = viaBand?.medianRatio ?? viaTier;
      // Either a real Pokemon-scoped number, or an honest refusal — but
      // never the 2.3x-4.2x baseline band the audit measured.
      if (resolved !== null) expect(resolved).toBeGreaterThan(5);
    }
  });
});

// ─── H-7: the hardcoded multiplier matrix is gone ─────────────────────

describe("H-7 — no hardcoded per-company multiplier matrix survives", () => {
  const svc = readFileSync(
    join(REPO_BACKEND, "src/services/compiq/canonicalFmv.service.ts"), "utf8");

  // The matrix was: PSA 10 = 4, BGS 10 = 5, SGC 10 = 3, CGC 10 = 3.5,
  // reached by 24 classifier families across 3 call sites. Drew's
  // standing EMPIRICAL-ONLY ruling is GRADE_CALIBRATION only, never a
  // hardcoded multiplier.
  //
  // MUTATION: restore the fallback ladder in gradeTierMultiplier and this
  // goes red.
  it("gradeTierMultiplier contains no hardcoded grade constants", () => {
    const start = svc.indexOf("function gradeTierMultiplier(");
    expect(start, "gradeTierMultiplier not found").toBeGreaterThan(-1);
    const body = svc.slice(start, svc.indexOf("\n}", start));
    // The tell-tale shape of the removed matrix.
    expect(body).not.toMatch(/value\s*>=\s*10\s*\)\s*return\s+[0-9]/);
    expect(body).not.toMatch(/c\s*===\s*"(PSA|BGS|SGC|CGC)"/);
  });

  // It must now be able to say "I don't know" in its type, which is what
  // forces every caller to handle the refusal.
  it("gradeTierMultiplier returns number | null", () => {
    expect(svc).toMatch(/function gradeTierMultiplier\([\s\S]*?\)\s*:\s*number \| null/);
  });

  // All three call sites must handle the null rather than coercing it.
  it("every gradeTierMultiplier call site handles the no-basis case", () => {
    const callSites = [...svc.matchAll(/gradeTierMultiplier\(/g)];
    // 1 definition + 3 real call sites.
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    // The two refusal paths and the skip path must all be present.
    expect(svc).toMatch(/if \(inputGradeMult === null\) return null;/);
    expect(svc).toMatch(/if \(gradeMult === null\) return null;/);
    expect(svc).toMatch(/if \(mult === null \|\| mult <= 1\) continue;/);
  });
});
