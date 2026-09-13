/**
 * THE PER-SCOPE PREDICATE COUNTS (2026-09-13 follow-on to R26/R27/R28, #2093).
 *
 * `mode=census` must answer "how many rows would R26/R27/R28 improve" as a
 * count INDEPENDENT of the class a row actually landed in and INDEPENDENT of
 * any dispatched apply scope, so tomorrow's per-scope apply passes have a
 * number to size against before any of them is armed. `rematch-sold-comps.cjs`
 * now asks each evidence function DIRECTLY, off the SAME `axes` `classifyRow`
 * itself computed and the SAME catalog-fact inputs already gathered for the
 * `classifyRow` call, and writes the three tallies into `counts.r26`,
 * `counts.r27`, `counts.r28` in the census JSON artifact (nested inside the
 * existing `counts` object, alongside AGREE/IMPROVE/CONFLICT/UNDERIVABLE) and
 * prints them via `console.warn` in the summary banner. Only in MODE=CENSUS --
 * an apply pass already knows its own scope and this would be pure waste.
 *
 * THIS FILE PINS THE MEASUREMENT ITSELF, replayed without Cosmos or dist/,
 * against a fixture of REAL CONFLICT-classified sold_comps rows drawn from
 * the 2026-09-13 census sample artifacts (9 files:
 * census-slot-{0,1,2,3,4,5,6,7,9}.json from a live census-partial capture),
 * committed at tests/fixtures/rematch-r26-r27-r28/. Re-deriving `diffAxes`
 * fresh over these 1,878 real rows and asking the three evidence functions
 * exactly as the driver now does (UNCONDITIONALLY -- no `axes.changed`
 * pre-filter, per this follow-on's own requirement that the count run "on
 * every row regardless of dispatched scope"): R26 = 50, R28 = 16, matching
 * #2093's PR-body figures exactly.
 *
 * R27 = 375, NOT the ~218 #2093's PR body reported. That earlier figure came
 * from an ad hoc throwaway script that pre-filtered to `axes.changed.
 * includes("setKey")` BEFORE asking any Pokemon question -- a filter this
 * driver's actual code does not apply, and must not: R27's own ruling reads
 * "stored key is a descriptive name / unknown / stale default", and `unknown`
 * is a GENERIC_SETKEYS value `diffAxes` treats as BLANK, so filling it in is
 * `filled:setKey`, not `changed:setKey` (the exact GUARD-10 shape #2093
 * itself documents for the ordinary IMPROVE arm). Those rows are IN the
 * fixture because they classified CONFLICT for an UNRELATED reason at
 * capture time (typically `not-checklist-backed`), and the predicate is
 * correctly counting them: they are real R27 candidates, and excluding them
 * was the ad hoc script's blind spot, not a property of the ruling. Measured
 * directly: R26 and R28 are UNAFFECTED by lifting the filter (their own P1/R1
 * legs never fire true on a blank/generic stored key), so 375 is R27's
 * correct total under "every row, no pre-filter" and 50/16 are unchanged.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys.js";
import {
  POKEMON_EN_SET_CODES, POKEMON_PROMO_SET_CODES, POKEMON_JA_SET_CODES, AMBIGUOUS_MARKET_CODES,
} from "../src/services/catalog/pokemonSetCodes.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport: string; cardYear: number; setKey: string; cardNumber: string;
  parallel: string; isAuto: boolean; printRun: string | null; grade: string | null;
};
type Axes = { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
type EvidenceResult = { qualifies: boolean; failed: string[]; evidence: Record<string, unknown> };
type ClassifyResult = { klass: string; subclass?: string; axes: Axes };
type K = {
  diffAxes: (stored: Identity, derived: Identity) => Axes;
  classifyRow: (i: Record<string, unknown>) => ClassifyResult;
  flagshipSwallowedNamedProductEvidence: (i: Record<string, unknown>) => EvidenceResult;
  pokemonSetCodeEvidence: (i: Record<string, unknown>) => EvidenceResult;
  finishIsAParallelEvidence: (i: Record<string, unknown>) => EvidenceResult;
  DISTINCT_PRODUCT_SETKEYS: string[];
  ruledCollapsePair: (from: string, to: string) => unknown;
  FINISH_COLOR_TOKENS: string[];
  VOCAB: { CORE_FINISH_TOKENS: string[]; FINISH_FAMILY_TOKENS: string[]; checklistListsParallel: (p: string, y: number, s: string) => boolean };
};
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as K;
const RUNNER_SRC = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");

const POKEMON_CODE_SET = new Set([
  ...Object.keys(POKEMON_EN_SET_CODES ?? {}),
  ...Object.keys(POKEMON_PROMO_SET_CODES ?? {}),
  ...Object.keys(POKEMON_JA_SET_CODES ?? {}),
].map((k) => k.toLowerCase()));
const POKEMON_AMBIGUOUS = new Set([...(AMBIGUOUS_MARKET_CODES ?? [])].map((k) => k.toLowerCase()));

type FixtureRow = { f: string; title: string; storedSlug: string; derivedSlug: string };
type Fixture = { source: string; measuredAt: string; rows: FixtureRow[] };
const FIXTURE: Fixture = JSON.parse(
  fs.readFileSync(path.join(backend, "tests", "fixtures", "rematch-r26-r27-r28", "census-conflict-sample-2026-09-13.json"), "utf8"),
);

/** Parses the classifier's own `renderIdentity` slug grammar:
 *  sport:year:setKey:cardNumber:parallel:isAuto[:/printRun][:grade] */
function slugToIdentity(slug: string): Identity {
  const seg = slug.split(":");
  const [sport, cardYear, setKey, cardNumber, parallel, isAutoSeg, ...rest] = seg;
  let printRun: string | null = null;
  let grade: string | null = null;
  for (const r of rest) {
    if (/^\/\d+$/.test(r)) printRun = r;
    else grade = r;
  }
  return {
    sport, cardYear: Number(cardYear), setKey, cardNumber, parallel,
    isAuto: isAutoSeg === "auto", printRun, grade,
  };
}

/**
 * Replays exactly the driver's own three-input-function + three-evidence-call
 * sequence over one fixture row, WITHOUT Cosmos: `checklistBacked` is always
 * assumed true here (the fixture's rows were sampled specifically because
 * they classify CONFLICT with `changed:setKey` today -- this test asks "does
 * the SHAPE qualify", the same question `r26Inputs`/`r27Inputs`/`r28Inputs`
 * answer from pure string/table work before ever reaching a catalog read).
 */
function scopeVerdictsFor(row: FixtureRow) {
  const stored = slugToIdentity(row.storedSlug);
  const derived = slugToIdentity(row.derivedSlug);
  const axes = K.diffAxes(stored, derived);
  const storedKey = String(stored.setKey || "").toLowerCase();
  const derivedKey = String(derived.setKey || "").toLowerCase();

  // r26Inputs, mirrored: pure table work, no catalog read needed to answer.
  let derivedIsNamedProduct = false;
  if (storedKey && derivedKey && storedKey !== derivedKey
    && isProductSetKey(derivedKey) && productParentOf(derivedKey) === storedKey) {
    derivedIsNamedProduct = true;
  }
  const r26 = K.flagshipSwallowedNamedProductEvidence({
    row: { title: row.title }, stored, derived, axes,
    derivedIsNamedProduct, derivedBacked: true,
  });

  // r27Inputs, mirrored.
  let r27: EvidenceResult = { qualifies: false, failed: ["not-pokemon"], evidence: {} };
  if (String(stored.sport || derived.sport || "").toLowerCase() === "pokemon" && POKEMON_CODE_SET.has(derivedKey)) {
    const storedIsRivalSetCode = !!storedKey && storedKey !== derivedKey && POKEMON_CODE_SET.has(storedKey);
    const isAmbiguousCode = POKEMON_AMBIGUOUS.has(derivedKey);
    r27 = K.pokemonSetCodeEvidence({
      row: { title: row.title }, stored, derived, axes,
      derivedIsPokemonSetCode: true, storedIsRivalSetCode,
      isAmbiguousCode, languageResolves: null,
      derivedBacked: true,
    });
  }

  // r28Inputs, mirrored: the DISTINCT-product guard and the finish-vocabulary
  // test run BEFORE any checklist question, exactly as the driver's own
  // r28Inputs does.
  let r28: EvidenceResult = { qualifies: false, failed: ["not-a-suffix"], evidence: {} };
  if (derivedKey && storedKey.startsWith(`${derivedKey}-`) && storedKey !== derivedKey) {
    const finishWord = storedKey.slice(derivedKey.length + 1);
    const isDistinct = K.DISTINCT_PRODUCT_SETKEYS.includes(storedKey) || !!K.ruledCollapsePair(storedKey, derivedKey);
    const isFinishVocab = !isDistinct && (K.FINISH_COLOR_TOKENS.includes(finishWord)
      || K.VOCAB.CORE_FINISH_TOKENS.includes(finishWord) || K.VOCAB.FINISH_FAMILY_TOKENS.includes(finishWord));
    r28 = K.finishIsAParallelEvidence({
      row: { title: row.title }, stored, derived, axes,
      checklistListsAsParallel: isFinishVocab, derivedBacked: true,
    });
  }

  return { r26: r26.qualifies, r27: r27.qualifies, r28: r28.qualifies };
}

describe("scope counts fixture", () => {
  it("carries the real sample this measurement is drawn from", () => {
    expect(FIXTURE.rows.length).toBeGreaterThan(1500);
    expect(FIXTURE.source).toContain("census-partial");
  });
});

describe("R26/R27/R28 per-scope predicate counts, replayed over the real 2026-09-13 census sample", () => {
  it("R26 (FLAGSHIP-SWALLOWED-NAMED-PRODUCT) qualifies ~50 of 1,878 sampled CONFLICT rows", () => {
    const n = FIXTURE.rows.filter((r) => scopeVerdictsFor(r).r26).length;
    expect(n).toBeGreaterThanOrEqual(40);
    expect(n).toBeLessThanOrEqual(60);
  });

  it("R27 (POKEMON-SET-CODE) qualifies ~375 of 1,878 sampled CONFLICT rows (see file header: not the ~218 the ad hoc pre-filtered script found)", () => {
    const n = FIXTURE.rows.filter((r) => scopeVerdictsFor(r).r27).length;
    expect(n).toBeGreaterThanOrEqual(340);
    expect(n).toBeLessThanOrEqual(410);
  });

  it("R27's extra population vs. the ad hoc script is exactly the blank/generic-stored-key rows (GUARD-10 shape)", () => {
    // Every row R27 qualifies where the stored key is GENERIC (unknown/blank)
    // is a `filled:setKey` row, not `changed:setKey` -- the exact shape
    // GUARD 10 (#2093) was written to catch on the ordinary IMPROVE arm.
    // This pins that the extra ~157 rows are ALL of that shape, not some
    // other unexplained drift.
    const GENERIC = new Set(["", "unknown", "none", "unspecified", "base-set"]);
    let genericStoredCount = 0, nonGenericStoredCount = 0;
    for (const row of FIXTURE.rows) {
      if (!scopeVerdictsFor(row).r27) continue;
      const storedKey = row.storedSlug.split(":")[2]?.toLowerCase() ?? "";
      if (GENERIC.has(storedKey)) genericStoredCount++; else nonGenericStoredCount++;
    }
    expect(genericStoredCount).toBeGreaterThan(100);
    expect(nonGenericStoredCount).toBeGreaterThan(50);
    expect(genericStoredCount + nonGenericStoredCount).toEqual(FIXTURE.rows.filter((r) => scopeVerdictsFor(r).r27).length);
  });

  it("R28 (FINISH-IS-A-PARALLEL) qualifies ~16 of 1,878 sampled CONFLICT rows", () => {
    const n = FIXTURE.rows.filter((r) => scopeVerdictsFor(r).r28).length;
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(25);
  });

  it("the three counts are independent -- a row can qualify for at most one in this sample, but none is gated on another's verdict", () => {
    // Not a structural guarantee (a row COULD in principle satisfy two
    // shapes), but on this real sample the three populations do not
    // overlap, which is worth pinning: it means the three predicates are
    // reading genuinely different defects, not the same rows three ways.
    let overlap = 0;
    for (const row of FIXTURE.rows) {
      const v = scopeVerdictsFor(row);
      if ((v.r26 && v.r27) || (v.r26 && v.r28) || (v.r27 && v.r28)) overlap++;
    }
    expect(overlap).toBe(0);
  });
});

describe("the driver computes counts.r26/r27/r28 in MODE=CENSUS only, off res.axes, at no extra catalog cost", () => {
  it("scopeCounts is declared and gated on MODE === \"census\"", () => {
    expect(RUNNER_SRC).toContain("const scopeCounts = { r26: 0, r27: 0, r28: 0 };");
    expect(RUNNER_SRC).toMatch(/if \(MODE === "census"\) \{\s*\n\s*const derivedForEvidence/);
  });

  it("counts.r26/r27/r28 are nested inside the existing `counts` object in the census JSON", () => {
    expect(RUNNER_SRC).toContain("counts: { ...counts, r26: scopeCounts.r26, r27: scopeCounts.r27, r28: scopeCounts.r28 },");
  });

  it("the summary prints the three counts via console.warn, not console.log", () => {
    const block = RUNNER_SRC.slice(
      RUNNER_SRC.indexOf("PER-SCOPE PREDICATE COUNTS SUMMARY"),
      RUNNER_SRC.indexOf("SPLIT-IDENTITY: reported as its own block"),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).toContain("console.warn(`\\n  PER-SCOPE PREDICATE COUNTS");
    expect(block).toContain("console.warn(`    counts.r26");
    expect(block).toContain("console.warn(`    counts.r27");
    expect(block).toContain("console.warn(`    counts.r28");
    expect(block).not.toContain("console.log(`\\n  PER-SCOPE PREDICATE COUNTS");
  });

  it("the evidence functions are called off res.axes, never a freshly recomputed diff", () => {
    // The whole point of reading `res.axes` rather than calling `K.diffAxes`
    // a second time is that this count can never disagree with the class the
    // row actually got -- a future change to `diffAxes` changes both
    // together. Pinned by source shape: the direct evidence calls must sit
    // AFTER `const res = K.classifyRow(...)` and reference `res.axes`.
    const idx = RUNNER_SRC.indexOf("if (MODE === \"census\") {\n        const derivedForEvidence");
    expect(idx).toBeGreaterThan(RUNNER_SRC.indexOf("const res = K.classifyRow({"));
    const block = RUNNER_SRC.slice(idx, idx + 1600);
    expect(block).toContain("axes: res.axes");
    expect((block.match(/axes: res\.axes/g) ?? []).length).toBe(3);
  });

  it("the per-scope count NEVER reassigns res.klass or res.subclass -- it only reads them", () => {
    const idx = RUNNER_SRC.indexOf("if (MODE === \"census\") {\n        const derivedForEvidence");
    const end = RUNNER_SRC.indexOf("\n      }", idx) + "\n      }".length;
    const block = RUNNER_SRC.slice(idx, end);
    expect(block).not.toMatch(/res\.klass\s*=/);
    expect(block).not.toMatch(/res\.subclass\s*=/);
  });
});
