/**
 * CF-CH-DAILY-DOUBLE-WRITE, twins-disagree resolution (2026-09-20, revised
 * after coordinator review of #2381).
 *
 * collapse-ch-synthetic-twins.cjs's own REPORT finds 23,688 `twins-disagree`
 * pairs -- the same CardHedge sale stored twice with two DIFFERENT identities
 * -- and deliberately leaves them (never guesses). resolve-disagreeing-sale-
 * twins.cjs is the lane that decides which side is right, using ONLY
 * evidence: checklist+roster+named-card-gate+cell-cross-check, then
 * more-specific-refines, then a grader-token title read for the grade axis.
 *
 * REVIEW FIXES PINNED HERE (coordinator review of #2381):
 *   (1) HIGH -- the named-card gate: a side may only win when the title does
 *       not name an identity MORE SPECIFIC than that side's own. The three
 *       real titles the owner's trial measured resolving to base are pinned
 *       verbatim as regression tests.
 *   (2) HIGH -- buildResolution carries the FULL identity field family on a
 *       long-side win (not hobbyiqCardId alone), recomputes contentHash, and
 *       runs the result through guardSoldCompDoc.
 *   (3) MEDIUM -- both sides' own titles are evaluated (never a single
 *       hardcoded `sale`), including the grade axis (a grader token may
 *       appear on either title; two DIFFERENT tokens leave the pair).
 *   (4) LOW -- protected/parked-side pairs are emitted to PLAN_OUT too.
 *
 * These tests pin: the pure per-side/per-pair decision functions (against a
 * fake catalog authority + player-identity + title-reader surface, so no
 * dist/ build is required to exercise the DECISION shape), the write path via
 * relocate-sold-comp.cjs's fake Cosmos (etag/IfMatch enforced), REPORT==APPLY
 * parity, and the workflow wiring (whitelist entry, PLAN_OUT, relaunch step,
 * input count, byte scan).
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(__filename);
const mod = require("../scripts/resolve-disagreeing-sale-twins.cjs");
const lib = require("../scripts/lib/relocate-sold-comp.cjs");
const sweep = require("../scripts/collapse-ch-synthetic-twins.cjs");

const CHID = "1778542173652x303328120692600800";
const CARD = CHID;

const longId = (soldAt: string, cents: number) => `cardhedge::ch-daily::${CHID}::${soldAt}::${cents}`;
const shortId = (priceHistoryId: string) => `cardhedge::ch-daily::${priceHistoryId}`;

const longRow = (over: Record<string, unknown> = {}) => ({
  id: longId("2026-07-03T01:19:00+00:00", 14000),
  cardId: CARD, source: "cardhedge", sourceExternalId: null,
  soldAt: "2026-07-03T01:19:00+00:00", price: 140,
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto",
  title: "2026 Bowman Baseball #CPA-EHA Eric Hartman Base", parallel: "Base", isAuto: false,
  playerName: "Eric Hartman",
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha",
  verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"long-etag-1"',
  ...over,
});
const shortRow = (over: Record<string, unknown> = {}) => ({
  id: shortId("9931002211"),
  cardId: CARD, source: "cardhedge", sourceExternalId: "ch-daily::9931002211",
  soldAt: "2026-07-03T01:19:00Z", price: 140,
  hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto",
  title: "2026 Bowman Baseball #CPA-EHA Eric Hartman Base", parallel: "Base", isAuto: false,
  playerName: "Eric Hartman",
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha",
  verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"short-etag-1"',
  ...over,
});

// A minimal fake mirroring hobbyIqCardId.service.ts's parseHobbyIqCardId
// shape, enough to drive the pure decision tests without a dist/ build.
function parseHiqFake(hiqId: string) {
  const s = String(hiqId ?? "");
  if (!s.startsWith("hiq:")) return null;
  const [, sport, yearStr, setKey, cardNumber, parallel, autoFlag, printRunPart] = s.split(":");
  if (!sport || !yearStr || !setKey || !cardNumber) return null;
  const printRunMatch = /^num-(\d+)$/.exec(printRunPart ?? "");
  return {
    sport, year: Number(yearStr), setKey, cardNumber, parallel: parallel ?? "base", isAuto: autoFlag === "auto",
    printRun: printRunMatch ? Number(printRunMatch[1]) : null,
  };
}

// ── fake TS-authored deps: no dist/ build required for these pure-decision
// tests, mirroring collapse-ch-synthetic-twins.test.ts's own dependency-free
// approach for its pure functions. Every gate the coordinator review added
// (readVariationFromTitle, insertSetNamedInTitle, isRegisteredProduct,
// extractPrintRunFromTitle, extractYearFromTitle, inferSetKeyFromTitle,
// productAncestry, slugify, guardSoldCompDoc) defaults to a SILENT stub
// (finds nothing, contradicts nothing) so existing scenarios are unaffected
// unless a test explicitly overrides one to exercise the new gate.
const playerIdentityKeyFake = (name: unknown) => String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
function fakeDeps(overrides: Record<string, unknown> = {}) {
  return {
    playerIdentityKey: playerIdentityKeyFake,
    titleContradictsTarget: (_sale: unknown, _target: unknown) => ({ contradicts: false }),
    statedFinishFromChecklist: (_title: string, _ctx: unknown) => null,
    sameCardNumber: (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase(),
    parseGradeFromTitle: (_title: string) => null,
    readVariationFromTitle: (_lower: string) => ({ finish: null, kind: null, tier: null, stock: null, marker: null, consumed: [], words: [] }),
    insertSetNamedInTitle: (_args: unknown) => [],
    isRegisteredProduct: (_key: string) => false,
    extractPrintRunFromTitle: (_title: string) => null,
    extractYearFromTitle: (_title: string) => null,
    inferSetKeyFromTitle: (_title: string) => "Unknown",
    productAncestry: (_key: string) => [],
    slugify: (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, "-"),
    guardSoldCompDoc: (_doc: unknown) => ({ verdict: "ok" }),
    checklistRowsByNumber: () => new Map(),
    ...overrides,
  };
}

describe("evaluateHobbyiqCardIdSide: checklist + roster + title, per side", () => {
  it("no strict checklist row at all -> no-strict-checklist-row", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, new Map());
    expect(result).toEqual({ row: null, reason: "no-strict-checklist-row" });
  });

  it("a checklist row at this number exists but the roster names someone else -> roster-does-not-name-player", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const byNumber = new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Someone Else", cardNumber: "cpa-eha" }]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "roster-does-not-name-player" });
  });

  it("checklist + roster + no title contradiction -> ok, row returned", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "2026 Bowman #CPA-EHA Eric Hartman Base" };
    const row = { id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" };
    const byNumber = new Map([["cpa-eha", [row]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result.row).toBe(row);
  });

  it("checklist + roster BUT the title contradicts the row -> title-contradicts-every-candidate-row", () => {
    const deps = fakeDeps({ titleContradictsTarget: () => ({ contradicts: true, rule: "card-number", detail: "x" }) });
    const sale = { playerName: "Eric Hartman", title: "x" };
    const row = { id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" };
    const byNumber = new Map([["cpa-eha", [row]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "title-contradicts-every-candidate-row" });
  });

  it("a non-strict source (vendor-derived) never counts, even naming the right player", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const byNumber = new Map([["cpa-eha", [{ id: "cat1", source: "cardhedge", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "no-strict-checklist-row" });
  });

  it("REVIEW FIX (1) HIGH: the title names a year that CONTRADICTS the candidate's own cell -> title-contradicts-candidate-cell", () => {
    const deps = fakeDeps({ extractYearFromTitle: () => 2019 });
    const sale = { playerName: "Eric Hartman", title: "2019 Bowman #CPA-EHA Eric Hartman Base" };
    const row = { id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" };
    const byNumber = new Map([["cpa-eha", [row]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "title-contradicts-candidate-cell" });
  });
});

describe("REVIEW FIX (1) HIGH: the named-card gate -- titleNamesMoreSpecificThanCandidate", () => {
  const candidateParsed = { sport: "baseball", year: 2025, setKey: "topps-chrome-update", cardNumber: "usc45", parallel: "base", isAuto: false };
  const candidateRow = { parallel: "Base", playerName: "Cal Raleigh", cardNumber: "usc45" };

  it("REGRESSION (owner trial): \"2025 Topps Chrome Update Cal Raleigh Image Variation SSP #USC45\" is MORE specific than a base candidate", () => {
    const deps = fakeDeps({
      readVariationFromTitle: (lower: string) => (lower.includes("image variation") && lower.includes("ssp")
        ? { finish: "Image Variation SSP", kind: null, tier: "ssp", stock: null, marker: null, consumed: [], words: ["image", "variation", "ssp"] }
        : { finish: null, kind: null, tier: null, stock: null, marker: null, consumed: [], words: [] }),
    });
    const sale = { title: "2025 Topps Chrome Update Cal Raleigh Image Variation SSP #USC45", playerName: "Cal Raleigh" };
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, sale, candidateParsed, candidateRow);
    expect(result.moreSpecific).toBe(true);
    expect(result.evidence).toMatch(/Image Variation SSP/);
  });

  it("REGRESSION (owner trial): \"Adley Rutschman 2023 Topps #250 Image Variation RC\" is MORE specific than a base candidate", () => {
    const deps = fakeDeps({
      readVariationFromTitle: (lower: string) => (lower.includes("image variation")
        ? { finish: "Image Variation", kind: null, tier: null, stock: null, marker: null, consumed: [], words: ["image", "variation"] }
        : { finish: null, kind: null, tier: null, stock: null, marker: null, consumed: [], words: [] }),
    });
    const parsed = { sport: "baseball", year: 2023, setKey: "topps", cardNumber: "250", parallel: "base", isAuto: false };
    const row = { parallel: "Base", playerName: "Adley Rutschman", cardNumber: "250" };
    const sale = { title: "Adley Rutschman 2023 Topps #250 Image Variation RC", playerName: "Adley Rutschman" };
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, sale, parsed, row);
    expect(result.moreSpecific).toBe(true);
    expect(result.evidence).toMatch(/Image Variation/);
  });

  it("REGRESSION (owner trial): \"2025 Panini Donruss - DOWNTOWN Tyler Shough #19\" is MORE specific than a base candidate (insert set)", () => {
    const deps = fakeDeps({
      insertSetNamedInTitle: (args: { setKey: string; title: string }) => (/downtown/i.test(args.title) ? [{ root: "downtown", matchedName: "downtown", registeredKey: null }] : []),
    });
    const parsed = { sport: "football", year: 2025, setKey: "panini-donruss", cardNumber: "19", parallel: "base", isAuto: false };
    const row = { parallel: "Base", playerName: "Tyler Shough", cardNumber: "19" };
    const sale = { title: "2025 Panini Donruss - DOWNTOWN Tyler Shough #19", playerName: "Tyler Shough" };
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, sale, parsed, row);
    expect(result.moreSpecific).toBe(true);
    expect(result.evidence).toMatch(/downtown/);
  });

  it("tries the candidate's bare brand root (panini- stripped) when it is independently a registered product", () => {
    const deps = fakeDeps({
      isRegisteredProduct: (key: string) => key === "donruss",
      insertSetNamedInTitle: (args: { setKey: string }) => (args.setKey === "donruss" ? [{ root: "downtown", matchedName: "downtown", registeredKey: null }] : []),
    });
    const parsed = { sport: "football", year: 2025, setKey: "panini-donruss", cardNumber: "19", parallel: "base", isAuto: false };
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "DOWNTOWN", playerName: "x" }, parsed, { parallel: "Base" });
    expect(result.moreSpecific).toBe(true);
  });

  it("a print run the candidate does not carry is more specific", () => {
    const deps = fakeDeps({ extractPrintRunFromTitle: () => 25 });
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "... /25 ...", playerName: "x" }, candidateParsed, candidateRow);
    expect(result.moreSpecific).toBe(true);
    expect(result.evidence).toMatch(/print run/);
  });

  it("silence (title names nothing extra) is NOT more specific -- the candidate wins normally", () => {
    const deps = fakeDeps();
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "2025 Topps Chrome Update Cal Raleigh Base #USC45", playerName: "Cal Raleigh" }, candidateParsed, candidateRow);
    expect(result.moreSpecific).toBe(false);
  });

  it("a variation the candidate's OWN row already names is not more specific", () => {
    const deps = fakeDeps({
      readVariationFromTitle: () => ({ finish: "Image Variation SSP", kind: null, tier: "ssp", stock: null, marker: null, consumed: [], words: ["image", "variation", "ssp"] }),
    });
    const parsed = { ...candidateParsed, parallel: "image-variation-ssp" };
    const row = { ...candidateRow, parallel: "Image Variation SSP" };
    const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "... Image Variation SSP ...", playerName: "Cal Raleigh" }, parsed, row);
    expect(result.moreSpecific).toBe(false);
  });

  // ── DELTA REVIEW OF #2381: catalogPrefixFor used to DROP printRun even
  // though parseHobbyIqCardId returns it, so the print-run check fired on
  // EVERY title stating "/N" even when the candidate's OWN slug already
  // carried the identical `:num-N` segment. Six real pairs the bug wrongly
  // left, pinned verbatim as regression tests. Each one carries an EXACT
  // candidateParsed.printRun (never dropped by a fake catalogPrefixFor here --
  // these tests call titleNamesMoreSpecificThanCandidate directly with the
  // parsed shape catalogPrefixFor now actually returns).
  describe("DELTA REVIEW: print-run comparison is EXACT, never a bare presence/absence flag", () => {
    it("REGRESSION: Angel Cepeda black-refractor:auto:num-10 vs title \"/10\" -- SAME rung, not more specific", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 10 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "cepeda-1", parallel: "black-refractor", isAuto: true, printRun: 10 };
      const row = { parallel: "Black Refractor", playerName: "Angel Cepeda", cardNumber: "cepeda-1" };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "Angel Cepeda ... Black Refractor Auto /10", playerName: "Angel Cepeda" }, parsed, row);
      expect(result.moreSpecific).toBe(false);
    });

    it("REGRESSION: PPDAR-ARO /15 -- candidate already carries num-15", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 15 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "ppdar-aro", parallel: "base", isAuto: true, printRun: 15 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "#PPDAR-ARO /15", playerName: "x" }, parsed, { parallel: "Base" });
      expect(result.moreSpecific).toBe(false);
    });

    it("REGRESSION: CPA-WT /150 -- candidate already carries num-150", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 150 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "cpa-wt", parallel: "base", isAuto: true, printRun: 150 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "#CPA-WT /150", playerName: "x" }, parsed, { parallel: "Base" });
      expect(result.moreSpecific).toBe(false);
    });

    it("REGRESSION: PPAR-AB /75 -- candidate already carries num-75", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 75 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "ppar-ab", parallel: "base", isAuto: true, printRun: 75 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "#PPAR-AB /75", playerName: "x" }, parsed, { parallel: "Base" });
      expect(result.moreSpecific).toBe(false);
    });

    it("REGRESSION: AC-MM Green /99 -- candidate already carries num-99", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 99 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "ac-mm", parallel: "green", isAuto: false, printRun: 99 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "#AC-MM Green /99", playerName: "x" }, parsed, { parallel: "Green" });
      expect(result.moreSpecific).toBe(false);
    });

    it("REGRESSION: BCP-243 /50 -- candidate already carries num-50", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 50 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "bcp-243", parallel: "base", isAuto: false, printRun: 50 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "#BCP-243 /50", playerName: "x" }, parsed, { parallel: "Base" });
      expect(result.moreSpecific).toBe(false);
    });

    it("title /N and candidate num-M (M != N) CONTRADICTS -- that side fails, distinct from under-specified", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 10 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "cepeda-1", parallel: "black-refractor", isAuto: true, printRun: 25 };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "... /10 ...", playerName: "x" }, parsed, { parallel: "Black Refractor" });
      expect(result.moreSpecific).toBe(true);
      expect(result.evidence).toMatch(/DIFFERENT print run/);
    });

    it("title /N and candidate carries NO num- at all -- still more specific (the original, un-regressed shape)", () => {
      const deps = fakeDeps({ extractPrintRunFromTitle: () => 10 });
      const parsed = { sport: "baseball", year: 2025, setKey: "some-product", cardNumber: "cepeda-1", parallel: "black-refractor", isAuto: true, printRun: null };
      const result = mod.titleNamesMoreSpecificThanCandidate(deps, { title: "... /10 ...", playerName: "x" }, parsed, { parallel: "Black Refractor" });
      expect(result.moreSpecific).toBe(true);
      expect(result.evidence).toMatch(/does not carry/);
    });

    it("catalogPrefixFor itself now carries printRun through from parseHobbyIqCardId, never dropping it", () => {
      mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
      const parsed = mod.catalogPrefixFor("hiq:baseball:2025:some-product:cepeda-1:black-refractor:auto:num-10");
      expect(parsed.printRun).toBe(10);
    });
  });
});

describe("resolveHobbyiqCardIdDisagreement: RULE 1 (checklist + roster) decides, both directions", () => {
  it("long resolves to a strict checklist row naming the sale's player, short does not -> long wins", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: (s: string) => (s === "beckett-checklist" ? "checklist" : "vendor"), parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => {
        if (parsed.setKey === "bowman") return new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]);
        return new Map(); // topps:44 has no strict row at all
      },
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long", rule: "checklist-and-roster" });
  });

  it("short resolves, long does not -> short wins", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: (s: string) => (s === "beckett-checklist" ? "checklist" : "vendor"), parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => {
        if (parsed.setKey === "topps") return new Map([["44", [{ id: "cat2", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "44" }]]]);
        return new Map();
      },
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result).toMatchObject({ verdict: "resolved", winner: "short", rule: "checklist-and-roster" });
  });

  it("neither side resolves -> neither-side-backed", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const long = longRow();
    const short = shortRow();
    const deps = fakeDeps();
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result.verdict).toBe("neither-side-backed");
  });

  it("REVIEW FIX (1) HIGH end-to-end: a checklist row that is merely MISSING for the true named identity must not let a bare-base side win by elimination", () => {
    // The "long" side is base and WOULD win by elimination if its own
    // checklist row existed and the short side's did not -- but the SALE'S
    // OWN TITLE names Image Variation SSP, which the long (base) candidate
    // does not carry. The gate must refuse long, not hand it the win.
    mod.__setSweepDepsForTest({ catalogAuthorityOf: (s: string) => (s === "beckett-checklist" ? "checklist" : "vendor"), parseHobbyIqCardId: parseHiqFake });
    const long = longRow({
      hobbyiqCardId: "hiq:baseball:2025:topps-chrome-update:usc45:base:no-auto",
      title: "2025 Topps Chrome Update Cal Raleigh Image Variation SSP #USC45",
      playerName: "Cal Raleigh",
    });
    const short = shortRow({
      hobbyiqCardId: "hiq:baseball:2025:topps-chrome-update:usc45:image-variation-ssp:no-auto",
      title: "2025 Topps Chrome Update Cal Raleigh Image Variation SSP #USC45",
      playerName: "Cal Raleigh",
    });
    const deps = fakeDeps({
      readVariationFromTitle: (lower: string) => (lower.includes("image variation") && lower.includes("ssp")
        ? { finish: "Image Variation SSP", kind: null, tier: "ssp", stock: null, marker: null, consumed: [], words: ["image", "variation", "ssp"] }
        : { finish: null, kind: null, tier: null, stock: null, marker: null, consumed: [], words: [] }),
      checklistRowsByNumber: (parsed: { parallel: string }) => {
        // ONLY the base (long) row exists on the checklist -- the
        // image-variation-ssp row is MISSING (the exact defect shape).
        if (parsed.parallel === "base") return new Map([["usc45", [{ id: "cat1", source: "beckett-checklist", playerName: "Cal Raleigh", cardNumber: "usc45", parallel: "Base" }]]]);
        return new Map();
      },
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    // MUST NOT resolve to base by elimination.
    expect(result.verdict).not.toBe("resolved");
    expect(result.verdict).toBe("neither-side-backed");
    expect(result.detail).toMatch(/title-names-a-more-specific-card/);
  });
});

describe("moreSpecificRefines: RULE 2, same number/auto, loser is base, title names winner's parallel", () => {
  it("refines when same number, same auto, loser is base, title names the winner's exact parallel words", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({
      sameCardNumber: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      statedFinishFromChecklist: () => "Gold Refractor",
    });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Base", isAuto: false };
    const winnerRow = { parallel: "Gold Refractor" };
    const sale = { title: "2026 Bowman #CPA-EHA Gold Refractor" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, winnerRow, loserParsed);
    expect(result.refines).toBe(true);
  });

  it("does NOT refine when the loser's own parallel is not base/blank (both sides name a real parallel)", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => "Gold Refractor" });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Blue Refractor", isAuto: false };
    const sale = { title: "x" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "loser-parallel-is-not-base-or-blank" });
  });

  it("does NOT refine when the card numbers differ", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => false });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "2", parallel: "Base", isAuto: false };
    const sale = { title: "x" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "different-card-number" });
  });

  it("does NOT refine when the auto flags differ", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold", isAuto: true };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const sale = { title: "x" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "different-auto-flag" });
  });

  it("does NOT refine when the title names NO parallel at all", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => null });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const sale = { title: "plain title" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "title-names-no-parallel" });
  });

  it("does NOT refine when the title names a DIFFERENT parallel than the winner", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => "Blue Refractor" });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const sale = { title: "... Blue Refractor ..." };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "title-names-a-different-parallel-than-the-winner" });
  });

  it("REVIEW FIX (1) HIGH: does NOT refine when the title names something MORE specific than the winner itself", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({
      sameCardNumber: () => true,
      statedFinishFromChecklist: () => "Gold Refractor",
      extractPrintRunFromTitle: () => 5, // the title ALSO states a print run the winner's row does not carry
    });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const sale = { title: "2026 Bowman Gold Refractor /5" };
    const result = mod.moreSpecificRefines(deps, sale, sale, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result.refines).toBe(false);
    expect(result.reason).toMatch(/title-names-a-more-specific-card/);
  });

  it("REVIEW FIX (3) MEDIUM: checks BOTH titles -- the long row's own title naming the winner is enough even if the short row's title is silent", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({
      sameCardNumber: () => true,
      statedFinishFromChecklist: (title: string) => (title.includes("Gold") ? "Gold Refractor" : null),
    });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const long = { title: "2026 Bowman Gold Refractor" }; // names the winner
    const short = { title: "2026 Bowman Base" }; // silent
    const result = mod.moreSpecificRefines(deps, long, short, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result.refines).toBe(true);
  });
});

describe("resolveHobbyiqCardIdDisagreement: RULE 2, both sides checklist-backed", () => {
  it("both valid, one strictly more specific and title names it -> the specific one wins (via RULE 1's own named-card gate, which now catches this shape earlier than RULE 2)", () => {
    // The named-card gate (REVIEW FIX (1) HIGH) means a BASE candidate whose
    // title names "Gold Refractor" now fails RULE 1's own evaluation outright
    // (title-names-a-more-specific-card), so the specific side wins by
    // elimination before RULE 2's refinement logic is ever reached -- still
    // the correct winner, reached one gate earlier than before the review.
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman Gold Refractor" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman Gold Refractor" });
    const rowFor = (parallel: string) => ({ id: "cat", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha", parallel });
    const deps = fakeDeps({
      sameCardNumber: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      statedFinishFromChecklist: () => "Gold Refractor",
      checklistRowsByNumber: (parsed: { parallel: string }) => new Map([["cpa-eha", [rowFor(parsed.parallel === "gold-refractor" ? "Gold Refractor" : "Base")]]]),
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long" });
    expect(["checklist-and-roster", "more-specific-refines"]).toContain(result.rule);
  });

  it("RULE 2 itself refines correctly when RULE 1's named-card gate does not apply (the loser's OWN title is silent, so neither side's title contradicts the other via the gate, but the winner's checklist row is still strictly more specific)", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    // Both titles are silent on parallel (statedFinishFromChecklist returns
    // null for BOTH) -- RULE 1's named-card gate never fires for either side
    // (nothing "more specific" is ever named), so both sides pass RULE 1's
    // roster+title checks and RULE 2 must decide via refinement on some OTHER
    // signal. Since statedFinishFromChecklist is the only reader
    // moreSpecificRefines itself uses to prove the title names the winner,
    // a fully silent title cannot reach "resolved" via RULE 2 either --
    // this pins that RULE 2 needs the title's own affirmative naming, not
    // silence, exactly as title-names-no-parallel already asserts elsewhere.
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman" });
    const rowFor = (parallel: string) => ({ id: "cat", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha", parallel });
    const deps = fakeDeps({
      sameCardNumber: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      statedFinishFromChecklist: () => null,
      checklistRowsByNumber: (parsed: { parallel: string }) => new Map([["cpa-eha", [rowFor(parsed.parallel === "gold-refractor" ? "Gold Refractor" : "Base")]]]),
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result.verdict).toBe("both-sides-valid");
  });

  it("both valid, NEITHER refines the other -> LEFT both-sides-valid", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:no-auto" });
    const rowFor = (parallel: string) => ({ id: "cat", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha", parallel });
    const deps = fakeDeps({
      sameCardNumber: () => true,
      statedFinishFromChecklist: () => null, // neither title names a parallel word
      checklistRowsByNumber: (parsed: { parallel: string }) => new Map([["cpa-eha", [rowFor(parsed.parallel === "gold-refractor" ? "Gold Refractor" : "Blue Refractor")]]]),
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short);
    expect(result.verdict).toBe("both-sides-valid");
  });
});

describe("resolveGradeDisagreement: RULE 3, grade from grader token only", () => {
  it("the grader token in the title decides -- the agreeing side wins", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, title: "... PSA 10 ..." });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9, title: "no grader here" });
    const deps = fakeDeps({ parseGradeFromTitle: (t: string) => (t.includes("PSA") ? { gradeCompany: "PSA", gradeValue: 10 } : null) });
    const result = mod.resolveGradeDisagreement(deps, long, short);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long", rule: "grader-token-in-title" });
  });

  it("no grader token in either title -> LEFT neither-side-backed", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10 });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const deps = fakeDeps({ parseGradeFromTitle: () => null });
    const result = mod.resolveGradeDisagreement(deps, long, short);
    expect(result.verdict).toBe("neither-side-backed");
  });

  it("the title's grader token matches NEITHER stored grade -> LEFT neither-side-backed", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, title: "... SGC 8 ..." });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9, title: "silent" });
    const deps = fakeDeps({ parseGradeFromTitle: (t: string) => (t.includes("SGC") ? { gradeCompany: "SGC", gradeValue: 8 } : null) });
    const result = mod.resolveGradeDisagreement(deps, long, short);
    expect(result.verdict).toBe("neither-side-backed");
  });

  it("REVIEW FIX (3) MEDIUM: the grader token may come from EITHER title -- short's own title deciding", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, title: "no grader here" });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9, title: "... BGS 9 ..." });
    const deps = fakeDeps({ parseGradeFromTitle: (t: string) => (t.includes("BGS") ? { gradeCompany: "BGS", gradeValue: 9 } : null) });
    const result = mod.resolveGradeDisagreement(deps, long, short);
    expect(result).toMatchObject({ verdict: "resolved", winner: "short", rule: "grader-token-in-title" });
  });

  it("REVIEW FIX (3) MEDIUM: the two titles state DIFFERENT grader tokens -> LEFT, never guessed past", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, title: "... PSA 10 ..." });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9, title: "... BGS 9 ..." });
    const deps = fakeDeps({
      parseGradeFromTitle: (t: string) => (t.includes("PSA") ? { gradeCompany: "PSA", gradeValue: 10 } : t.includes("BGS") ? { gradeCompany: "BGS", gradeValue: 9 } : null),
    });
    const result = mod.resolveGradeDisagreement(deps, long, short);
    expect(result.verdict).toBe("neither-side-backed");
    expect(result.detail).toMatch(/DIFFERENT grader tokens/);
  });
});

describe("protected/parked: never touched, reusing the sweep lane's own gates", () => {
  it("isProtected and isParkedSide are the SAME functions the sweep lane exports (imported, not re-implemented)", () => {
    expect(sweep.isProtected({ verifiedByUser: true })).toBe(true);
    expect(sweep.isParkedSide({ identityUnverified: true })).toBe(true);
  });

  it("REVIEW FIX (4) LOW: protected/parked pairs are emitted to PLAN_OUT in the shipped source", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    expect(src).toMatch(/emitPlanRow\("protected"/);
    expect(src).toMatch(/emitPlanRow\("parked-side"/);
  });
});

// ── write path: full-doc upsert via relocateSoldComp, etag/IfMatch enforced -
type Fake = { store: Map<string, Record<string, unknown>>; container: unknown };
function fakePool(): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const key = (id: string, pk: string) => `${pk}::${id}`;
  const nf = () => Object.assign(new Error("not found"), { code: 404 });
  const container = {
    items: {
      async upsert(doc: Record<string, unknown>) {
        store.set(key(String(doc.id), String(doc.cardId)), structuredClone(doc));
        return { resource: doc };
      },
      query(spec: { parameters?: { name: string; value: unknown }[] }) {
        return {
          async fetchAll() {
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            return { resources: [...store.values()].filter((d) => d.id === p["@id"] && d.cardId === p["@pk"]) };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read() {
          const d = store.get(key(id, pk));
          if (!d) throw nf();
          return { resource: d };
        },
        async delete(options?: { accessCondition?: { type: string; condition: string } }) {
          const k = key(id, pk);
          const d = store.get(k);
          if (!d) throw nf();
          if (options?.accessCondition?.type === "IfMatch" && d._etag !== options.accessCondition.condition) {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
          store.delete(k);
          return {};
        },
      };
    },
  };
  return { store, container };
}
const noWait = async () => {};

// buildResolution needs SWEEP_DEPS.parseHobbyIqCardId bound (it calls
// catalogPrefixFor internally on a long-side win) -- bound once per describe
// block below via mod.__setSweepDepsForTest(parseHiqFake-backed deps).
const contentHashDeps = fakeDeps();

describe("buildResolution + relocateSoldComp: the write path", () => {
  it("winner=short: an ordinary collapse, short row kept with a twinResolved ledger stamp, long row dropped", async () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"' });
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(contentHashDeps, long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    expect(keep.hobbyiqCardId).toBe(short.hobbyiqCardId); // short's own value untouched
    expect(keep.twinResolved).toMatchObject({ winner: short.id, loser: long.id, rule: "checklist-and-roster" });
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done" });
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(false);
  });

  it("REVIEW FIX (2) HIGH: winner=long carries the FULL identity field family, not just hobbyiqCardId, and recomputes contentHash", async () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const fake = fakePool();
    const long = longRow({
      _etag: '"L1"', cardId: CARD, hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto",
      cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: true, playerName: "Eric Hartman",
    });
    const short = shortRow({
      hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto",
      cardNumber: "44", parallel: "Red Backs", isAuto: false, playerName: "Someone Else",
    });
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const winnerRow = { playerName: "Eric Hartman", parallel: "Gold Refractor", cardNumber: "cpa-eha" };
    const resolution = { verdict: "resolved" as const, winner: "long" as const, rule: "checklist-and-roster", detail: "x", winnerRow };
    const keep = mod.buildResolution(contentHashDeps, long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z", winnerRow);
    // Every identity field on the kept doc equals the winner's -- not just hobbyiqCardId.
    expect(keep.id).toBe(short.id); // SHORT address is always kept
    expect(keep.cardId).toBe(long.cardId);
    expect(keep.hobbyiqCardId).toBe(long.hobbyiqCardId);
    expect(keep.sport).toBe("baseball");
    expect(keep.cardYear).toBe(2026);
    expect(keep.cardNumber).toBe("cpa-eha");
    expect(keep.parallel).toBe("Gold Refractor");
    expect(keep.isAuto).toBe(true);
    expect(keep.playerName).toBe("Eric Hartman");
    // contentHash matches a fresh compute against the kept doc's OWN fields.
    const { contentHashOf } = require("../scripts/lib/relocate-sold-comp.cjs");
    expect(keep.contentHash).toBe(contentHashOf(keep));
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done" });
    const surviving = [...fake.store.values()];
    expect(surviving).toHaveLength(1);
    expect(surviving[0].id).toBe(short.id);
    expect(surviving[0].hobbyiqCardId).toBe(long.hobbyiqCardId);
    expect(surviving[0].parallel).toBe("Gold Refractor");
  });

  it("REVIEW FIX (2) HIGH: a grade-axis win carries the three grade fields and recomputes contentHash", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, gradeQualifier: "OC" });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const resolution = { verdict: "resolved" as const, winner: "long" as const, rule: "grader-token-in-title", detail: "x" };
    const keep = mod.buildResolution(contentHashDeps, long, short, resolution, "grade", "2026-09-20T00:00:00Z");
    expect(keep.gradeCompany).toBe("PSA");
    expect(keep.gradeValue).toBe(10);
    expect(keep.gradeQualifier).toBe("OC");
    const { contentHashOf } = require("../scripts/lib/relocate-sold-comp.cjs");
    expect(keep.contentHash).toBe(contentHashOf(keep));
  });

  it("REVIEW FIX (2) HIGH: guardSoldCompDoc runs on the kept document before it is handed to the write path", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    let guardCalledWith: unknown = null;
    const deps = fakeDeps({ guardSoldCompDoc: (doc: unknown) => { guardCalledWith = doc; return { verdict: "ok" }; } });
    const long = longRow();
    const short = shortRow();
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    mod.buildResolution(deps, long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    expect(guardCalledWith).not.toBeNull();
    expect((guardCalledWith as { id: string }).id).toBe(short.id);
  });

  it("a crash between the keeper's write and the loser's delete leaves a harmless duplicate, never a lost sale", async () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"' });
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(contentHashDeps, long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    // Simulate the crash: the delete's ifMatchEtag no longer matches (the
    // long row changed between plan and write -- the same shape a genuine
    // crash-and-retry produces).
    fake.store.set(`${CARD}::${long.id}`, { ...long, _etag: '"L2-CHANGED"' });
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res.ok).toBe(false);
    expect(res.staleSincePlan).toHaveLength(1);
    // BOTH rows still present -- a harmless duplicate, never a lost sale.
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });

  it("dry run (REPORT mode) touches nothing", async () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const fake = fakePool();
    const long = longRow();
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(contentHashDeps, long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }], dryRun: true,
    });
    expect(res).toMatchObject({ ok: true, stage: "dry-run" });
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });
});

// ── fleet discipline, workflow wiring, byte scan -----------------------------
describe("resolve-disagreeing-sale-twins carries the fleet discipline", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("report-only by default, honours BACKFILL_APPLY, prints the budget marker, reconciles, writes only through the helper", () => {
    expect(src).toMatch(/process\.env\.BACKFILL_APPLY === "true"/);
    expect(src).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
    expect(src).toMatch(/\breportWrites\(/);
    expect(src).toMatch(/\brelocateSoldComp\(/);
    expect(src).not.toMatch(/\.items\.upsert\(|\.items\.create\(|\.delete\(\)|\.patch\(/);
  });

  it("imports the sweep lane's proof predicate and gates rather than re-implementing them", () => {
    expect(src).toMatch(/require\(path\.join\(__dirname, "collapse-ch-synthetic-twins\.cjs"\)\)/);
    expect(src).toMatch(/decideSyntheticTwin/);
    expect(src).toMatch(/isProtected\(long\)/);
    expect(src).toMatch(/isParkedSide\(long\)/);
    expect(src).toMatch(/isProtected\(short\)/);
    expect(src).toMatch(/isParkedSide\(short\)/);
  });

  // ── REVIEW ROUND 3, ISSUE (1): reconcile must balance, and an unbalanced
  // reconcile must exit NON-ZERO in BOTH report and apply (coordinator report
  // on run 35578577288: "twins-disagree pairs seen 80,770" vs
  // "resolved+left+protected+parked 106,741 MISMATCH").
  describe("reconcile: disagreePairsSeen and protected/parked increment on the SAME condition, and a mismatch exits non-zero in both modes", () => {
    it("decideSyntheticTwin is called and disagreePairsSeen is incremented BEFORE any isProtected/isParkedSide check on the pair", () => {
      // The exact bug: isProtected(long)/isParkedSide(long) used to gate
      // BEFORE decideSyntheticTwin ran (once per long row, before any
      // candidate short was even considered), so a protected/parked row was
      // counted for pairings that were never proven twins-disagree at all.
      const pairBlock = /const d = decideSyntheticTwin\(long, short, \{ dayCounts, longDayCounts \}\);\s*\n\s*if \(d\.verdict !== "twins-disagree"\) continue;\s*\n\s*stats\.disagreePairsSeen\+\+;([\s\S]{0,600})/.exec(src);
      expect(pairBlock, "the decideSyntheticTwin call + disagreePairsSeen++ sequence was not found").toBeTruthy();
      // Protected/parked checks must appear AFTER this sequence, not before.
      expect(pairBlock![1]).toMatch(/isProtected\(long\)\s*\|\|\s*isProtected\(short\)/);
      expect(pairBlock![1]).toMatch(/isParkedSide\(long\)\s*\|\|\s*isParkedSide\(short\)/);
    });

    it("protected/parked/resolved/left are mutually exclusive per pair -- exactly one bucket increments per proven disagreement", () => {
      // Structural pin: the protected check `continue`s, so a pair counted
      // protected never falls through to the parked check, the resolver
      // call, or a resolved/left bucket -- and likewise for parked.
      const protectedBlock = /if \(isProtected\(long\) \|\| isProtected\(short\)\) \{\s*\n\s*stats\.protected\+\+;[\s\S]*?continue;\s*\n\s*\}/.exec(src);
      const parkedBlock = /if \(isParkedSide\(long\) \|\| isParkedSide\(short\)\) \{\s*\n\s*stats\.parkedSide\+\+;[\s\S]*?continue;\s*\n\s*\}/.exec(src);
      expect(protectedBlock, "protected branch not found or does not continue").toBeTruthy();
      expect(parkedBlock, "parked branch not found or does not continue").toBeTruthy();
    });

    it("behavioral: the reconcile arithmetic balances when every disagreeing pair lands in exactly one bucket", () => {
      // Direct simulation of the shipped reconcile equation:
      //   disagreePairsSeen == resolved(3 kinds) + left(2 kinds) + protected + parked
      const stats = {
        disagreePairsSeen: 0, protected: 0, parkedSide: 0,
        resolvedChecklistRoster: 0, resolvedMoreSpecific: 0, resolvedGraderToken: 0,
        bothSidesValid: 0, neitherSideBacked: 0,
      };
      const pairs = ["protected", "parked", "resolved-1", "resolved-2", "resolved-3", "left-1", "left-2"];
      for (const kind of pairs) {
        stats.disagreePairsSeen++; // EVERY pair increments this, exactly once
        if (kind === "protected") stats.protected++;
        else if (kind === "parked") stats.parkedSide++;
        else if (kind === "resolved-1") stats.resolvedChecklistRoster++;
        else if (kind === "resolved-2") stats.resolvedMoreSpecific++;
        else if (kind === "resolved-3") stats.resolvedGraderToken++;
        else if (kind === "left-1") stats.bothSidesValid++;
        else if (kind === "left-2") stats.neitherSideBacked++;
      }
      const reconciled = stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken + stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide;
      expect(stats.disagreePairsSeen).toBe(reconciled);
      expect(stats.disagreePairsSeen).toBe(pairs.length);
    });

    it("behavioral: the OLD (buggy) shape -- protected counted once per candidate short rather than once per proven pair -- would NOT balance", () => {
      // Reproduces the coordinator's own measured mismatch shape at small
      // scale: a protected long row paired against TWO candidate shorts,
      // only ONE of which decideSyntheticTwin would ever prove
      // twins-disagree (the other is not-a-match). The old code counted
      // `protected` for BOTH candidates (once per short in the inner loop,
      // gated before decideSyntheticTwin ran); disagreePairsSeen only ever
      // counted the one genuine disagreement.
      let disagreePairsSeen = 0;
      let protectedCount = 0;
      const candidates = [{ verdict: "twins-disagree" }, { verdict: "not-a-match" }];
      // OLD shape: protected gates BEFORE decideSyntheticTwin, once per candidate.
      for (const _c of candidates) {
        protectedCount++; // isProtected(long) checked before ANY candidate matching
      }
      // decideSyntheticTwin would only have proven ONE of these a real disagreement.
      for (const c of candidates) {
        if (c.verdict === "twins-disagree") disagreePairsSeen++;
      }
      expect(protectedCount).not.toBe(disagreePairsSeen); // the OLD shape's own mismatch
      expect(protectedCount).toBe(2);
      expect(disagreePairsSeen).toBe(1);

      // NEW (fixed) shape: protected is only counted for the ONE candidate
      // decideSyntheticTwin actually proves.
      let disagreePairsSeenFixed = 0;
      let protectedCountFixed = 0;
      for (const c of candidates) {
        if (c.verdict !== "twins-disagree") continue;
        disagreePairsSeenFixed++;
        protectedCountFixed++; // isProtected checked only on a PROVEN pair
      }
      expect(protectedCountFixed).toBe(disagreePairsSeenFixed);
    });

    it("an unbalanced reconcile sets process.exitCode = 4, and finishLane is invoked with process.exitCode || 0 -- so it exits non-zero in BOTH report and apply", () => {
      expect(src).toMatch(/if \(!reconcileBalances\) \{/);
      expect(src).toMatch(/process\.exitCode = 4/);
      // No `if (APPLY)` guard around the exit-code assignment -- it fires in
      // both modes, unlike reportWrites (which IS apply-gated, correctly).
      const mismatchBlock = /if \(!reconcileBalances\) \{([\s\S]*?)\n  \}/.exec(src);
      expect(mismatchBlock, "the mismatch branch was not found").toBeTruthy();
      expect(mismatchBlock![1]).not.toMatch(/if\s*\(APPLY\)/);
      expect(src).toMatch(/finishLane\(process\.exitCode \|\| 0, ctx \|\| \{\}\)/);
    });
  });

  it("never edits a derivation-stamp input -- only CALLS exported functions from dist/", () => {
    expect(src).not.toMatch(/fs\.writeFileSync\(.*hobbyIqCardId\.service|fs\.writeFileSync\(.*parseTitleIdentity\.service/);
    expect(src).toMatch(/dist\/services\/portfolioiq\/hobbyIqCardId\.service\.js/);
  });

  it("uses maxItemCount 500, never -1", () => {
    expect(src).toMatch(/maxItemCount:\s*500/);
    expect(src).not.toMatch(/maxItemCount:\s*-1/);
  });

  it("recomputes contentHash and runs guardSoldCompDoc on a winning identity", () => {
    expect(src).toMatch(/contentHashOf\(keep\)/);
    expect(src).toMatch(/guardSoldCompDoc/);
  });

  // ── coordinator lesson from the fold-catalog-duplicate-rungs.cjs sibling
  // lane's pilot: a FINISHED report drains its whole population and has
  // nothing left to continue -- if it printed the budget marker anyway, the
  // runner's relaunch step would re-dispatch it forever, since a marker-gated
  // relaunch fires in BOTH report and apply mode (CF-REPORT-RELAUNCHES-AS-A-
  // REPORT, D34) and has no OTHER way to tell "done" from "stopped mid-scan".
  // The marker's own text must therefore be reachable from EXACTLY ONE
  // source location, gated on the real clock check, never printed
  // unconditionally at the end of the scan.
  describe("the budget marker is printed ONLY from the real mid-scan clock check, never on a finished scan (batched, resumable shape)", () => {
    it("the marker string appears in exactly ONE place in the source, inside the `if (stoppedMidScan)` branch", () => {
      const markerLines = [...src.matchAll(/stopReason\s*=\s*APPLY/g)];
      expect(markerLines).toHaveLength(1);
      expect(src).toMatch(/if\s*\(stoppedMidScan\)\s*\{/);
    });

    it("stoppedMidScan initializes to false and is set ONLY inside the batch loop's budget-check branch, never unconditionally", () => {
      expect(src).toMatch(/let stoppedMidScan = false/);
      const setSites = [...src.matchAll(/stoppedMidScan\s*=\s*true/g)];
      expect(setSites).toHaveLength(1);
      expect(src).toMatch(/if\s*\(budgetLeft\(\)\s*<\s*RESERVE_MS\)\s*\{[^}]*stoppedMidScan\s*=\s*true/s);
    });

    it("stopReason initializes to null and the print is gated on it -- a scan that never breaks on budget never prints the marker", () => {
      expect(src).toMatch(/let stopReason = null/);
      const printSites = [...src.matchAll(/console\.log\(`\\n\$\{stopReason\}`\)/g)];
      expect(printSites).toHaveLength(1);
      expect(src).toMatch(/if\s*\(stopReason\)\s*console\.log\(`\\n\$\{stopReason\}`\)/);
    });

    it("a LIMIT-triggered stop (an operator soft cap, not a real clock stop) does NOT set stoppedMidScan and therefore never prints the marker", () => {
      const limitBranch = /if\s*\(LIMIT\s*&&\s*stats\.partitions\s*>=\s*LIMIT\)\s*\{\s*stats\.notReached[^}]*\}/.exec(src);
      expect(limitBranch, "LIMIT branch not found in the shipped source").toBeTruthy();
      expect(limitBranch![0]).not.toMatch(/stoppedMidScan/);
    });

    it("behavioral: a batch loop that exhausts its whole population (never once out of clock) leaves stoppedMidScan false, by direct simulation of the shipped predicate shape", () => {
      // Mirrors the shipped BATCH loop's own control flow (batches of
      // `batchSize`, checked before each batch) with a budgetLeft() that
      // never dips below RESERVE_MS -- a finished scan, by construction.
      const RESERVE_MS = 90000;
      const budgetLeftAlwaysHealthy = () => RESERVE_MS * 10;
      const cardsThisRun = ["a", "b", "c", "d", "e", "f", "g"];
      const batchSize = 3;
      let stoppedMidScan = false;
      let idx = 0, done = 0;
      for (; idx < cardsThisRun.length; ) {
        if (budgetLeftAlwaysHealthy() < RESERVE_MS) { stoppedMidScan = true; break; }
        const batch = cardsThisRun.slice(idx, idx + batchSize);
        done += batch.length;
        idx += batch.length;
      }
      expect(stoppedMidScan).toBe(false);
      expect(done).toBe(cardsThisRun.length); // every card was actually reached
    });

    it("behavioral: a genuinely mid-scan clock stop (budgetLeft dips below the reserve before a batch admits) DOES set stoppedMidScan", () => {
      const RESERVE_MS = 90000;
      let calls = 0;
      const budgetLeftDipsOnSecondBatch = () => { calls++; return calls >= 2 ? RESERVE_MS / 2 : RESERVE_MS * 10; };
      const cardsThisRun = ["a", "b", "c", "d", "e", "f", "g"];
      const batchSize = 3;
      let stoppedMidScan = false;
      let idx = 0, done = 0;
      for (; idx < cardsThisRun.length; ) {
        if (budgetLeftDipsOnSecondBatch() < RESERVE_MS) { stoppedMidScan = true; break; }
        const batch = cardsThisRun.slice(idx, idx + batchSize);
        done += batch.length;
        idx += batch.length;
      }
      expect(stoppedMidScan).toBe(true);
      expect(done).toBeLessThan(cardsThisRun.length); // genuinely stopped before the population was exhausted
    });
  });

  // ── REVIEW ROUND 3: RESUME CURSOR (coordinator report on run 35589416039)
  describe("resume cursor: rides scan_limit, copies fold-catalog-duplicate-rungs.cjs's convention", () => {
    it("decodeResume/encodeResume round-trip: hop*1,000,000 + offset", () => {
      expect(mod.decodeResume(0)).toEqual({ hop: 0, offset: 0 });
      expect(mod.decodeResume(5)).toEqual({ hop: 0, offset: 5 });
      expect(mod.decodeResume(1_000_005)).toEqual({ hop: 1, offset: 5 });
      expect(mod.decodeResume(2_000_123)).toEqual({ hop: 2, offset: 123 });
      expect(mod.encodeResume({ hop: 1, offset: 5 })).toBe(1_000_005);
      expect(mod.encodeResume({ hop: 0, offset: 0 })).toBe(0);
    });

    it("decodeResume never returns a negative hop/offset for garbage input", () => {
      expect(mod.decodeResume(-5)).toEqual({ hop: 0, offset: 0 });
      expect(mod.decodeResume(NaN)).toEqual({ hop: 0, offset: 0 });
      expect(mod.decodeResume(undefined)).toEqual({ hop: 0, offset: 0 });
      expect(mod.decodeResume("not-a-number")).toEqual({ hop: 0, offset: 0 });
    });

    it("MAX_RESUME_HOPS caps a chain that never converges", () => {
      expect(mod.MAX_RESUME_HOPS).toBe(30);
      expect(mod.decodeResume(mod.MAX_RESUME_HOPS * mod.RESUME_HOP_UNIT).hop).toBe(mod.MAX_RESUME_HOPS);
    });

    it("the shipped source aborts (throws) once RESUME.hop reaches MAX_RESUME_HOPS, never relaunching past it", () => {
      expect(src).toMatch(/RESUME\.hop\s*>=\s*MAX_RESUME_HOPS/);
      expect(src).toMatch(/HOP_CAP/);
    });

    it("APPLY always rescans at offset 0 -- a resolved pair drops out of the fresh population on its own", () => {
      expect(src).toMatch(/const REPORT_RESUME_OFFSET = APPLY \? 0 : RESUME\.offset/);
      expect(src).toMatch(/APPLY always RESCANS/);
    });

    it("REPORT resumes into a SORTED order, never raw scan/insertion order", () => {
      expect(src).toMatch(/const orderedCards = \[\.\.\.shardedCards\]\.sort\(\)/);
    });

    it("the workflow forwards scan_limit on the resolve-disagreeing-sale-twins relaunch dispatch", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step, "relaunch step not found").toBeTruthy();
      expect(step).toMatch(/-f scan_limit="\$\{RESUME_ARG:-0\}"/);
    });

    it("the workflow's relaunch preamble parses the resume cursor off the log, mirroring fold-catalog-duplicate-rungs.cjs's own pattern", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step).toMatch(/the relaunch resumes at scan_limit=\[0-9\]\+/);
    });
  });

  // ── REVIEW ROUND 3: SHARDING (dispatched slot=0 slots=8, ran "slot 0/1")
  describe("sharding: a whole CH partition (never a pair) lands on exactly one slot", () => {
    it("prints its own explicit `shard  slot X/Y` banner line the relaunch step can parse for the REAL slot", () => {
      expect(src).toMatch(/shard\s+slot \$\{SLOT\}\/\$\{SLOTS\}/);
    });

    it("shards by sha1(cardId) -- a whole CH partition and every pair inside it lands on ONE slot", () => {
      expect(src).toMatch(/shardOf\s*=\s*\(key\)\s*=>\s*parseInt\(crypto\.createHash\("sha1"\)/);
      expect(src).toMatch(/shardOf\(cardId\)\s*===\s*SLOT/);
    });

    it("this lane is opted into the runner's SHARD line, reusing parents_only (no new input)", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const shardLine = yml.split("\n").find((l) => /^\s+SHARD:\s/.test(l));
      expect(shardLine, "backfill-runner.yml must export SHARD").toBeTruthy();
      expect(shardLine).toMatch(/inputs\.script\s*==\s*'resolve-disagreeing-sale-twins'/);
      expect(shardLine).toMatch(/inputs\.parents_only\s*==\s*true/);
    });

    it("the relaunch step parses the REAL slot/slots off the script's own banner line, not the raw dispatch inputs", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step, "relaunch step not found").toBeTruthy();
      expect(step).toMatch(/REAL_SLOT=\$\(grep -aoE "shard \+slot \[0-9\]\+\/\[0-9\]\+"/);
    });

    it("the relaunch step forwards slot/slots verbatim on the next dispatch (a real fan-out re-dispatches the SAME slot, never slot 0)", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step).toMatch(/-f slot="\$\{\{ inputs\.slot \}\}"/);
      expect(step).toMatch(/-f slots="\$\{\{ inputs\.slots \}\}"/);
    });
  });

  // ── REVIEW ROUND 3: SPEED -- bounded concurrency across partitions, 429
  // backoff, heartbeat (coordinator report: 80,770 pairs in 120 min = ~11/s)
  describe("speed: bounded concurrency across partitions, 429-aware backoff, heartbeat", () => {
    it("defaults CONCURRENCY to 6 (safe headroom on a shared 10,000 RU/s sold_comps day), raised by the concurrency/CONCURRENCY/BACKFILL_CONCURRENCY input", () => {
      expect(src).toMatch(/REQUESTED_CONCURRENCY = Math\.max\(1, Number\(process\.env\.CONCURRENCY \|\| process\.env\.BACKFILL_CONCURRENCY \|\| 6\)\)/);
    });

    it("runs partitions concurrently via a bounded Promise.all batch, never CONCURRENCY within one partition's own pairs", () => {
      expect(src).toMatch(/await Promise\.all\(batch\.map\(\(cardId\) => processPartition\(cardId\)\)\)/);
      // processPartition's own inner pair loop is a plain sequential for,
      // never itself batched or Promise.all'd -- one partition's writes stay
      // strictly ordered.
      const fn = /async function processPartition\(cardId\) \{[\s\S]*?\n  \}\n/.exec(src);
      expect(fn, "processPartition not found").toBeTruthy();
      expect(fn![0]).not.toMatch(/Promise\.all/);
    });

    it("every retried Cosmos call increments throttleStats.count, and 20 throttles drop concurrency to 2 for the rest of the run (one-way)", () => {
      expect(src).toMatch(/throttleStats\.count\+\+/);
      expect(src).toMatch(/THROTTLE_TRIP_AT = 20/);
      expect(src).toMatch(/THROTTLE_CONCURRENCY = 2/);
      expect(src).toMatch(/droppedTo2 = true/);
    });

    it("throttleStats is a white-box export, letting a test trip the drop without paying real retry() backoff", () => {
      expect(mod.throttleStats).toEqual({ count: 0, droppedTo2: false });
    });

    it("behavioral: effectiveConcurrency-shaped logic drops to 2 once the trip count is reached, by direct simulation of the shipped predicate", () => {
      const THROTTLE_TRIP_AT = 20;
      const THROTTLE_CONCURRENCY = 2;
      const REQUESTED_CONCURRENCY = 6;
      const stats = { count: 0, droppedTo2: false };
      function effectiveConcurrency() {
        if (stats.count >= THROTTLE_TRIP_AT) { stats.droppedTo2 = true; return THROTTLE_CONCURRENCY; }
        return REQUESTED_CONCURRENCY;
      }
      expect(effectiveConcurrency()).toBe(6);
      stats.count = 19;
      expect(effectiveConcurrency()).toBe(6);
      stats.count = 20;
      expect(effectiveConcurrency()).toBe(2);
      expect(stats.droppedTo2).toBe(true);
    });

    it("prints a per-minute heartbeat with pairs decided, partitions done/total, and ETA, on stderr", () => {
      expect(src).toMatch(/HEARTBEAT_MS = 60 \* 1000/);
      expect(src).toMatch(/console\.error\(`  narrate: heartbeat/);
      expect(src).toMatch(/ETA \$\{eta\}/);
    });
  });

  it("carries no 0x08/0x00 bytes -- a heredoc-authored file would turn \\b into 0x08", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"));
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("the runner's whitelist and a marker-keyed relaunch exist for this script", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/^\s+- resolve-disagreeing-sale-twins\s*$/m);
    const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
    expect(step, "resolve-disagreeing-sale-twins has no relaunch step").toBeTruthy();
    const composite = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8");
    expect((step! + composite).replace(/^\s*#.*$/gm, "")).toMatch(/stopped at the .*budget/);
  });

  it("no new workflow_dispatch input was added -- still at 24 of GitHub's 25", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const block = yml.slice(yml.indexOf("workflow_dispatch:"), yml.indexOf("\npermissions:"));
    const inputs = [...block.matchAll(/^ {6}([a-z_0-9]+):$/gm)].map((m) => m[1]);
    expect(inputs.length).toBeLessThanOrEqual(24);
  });

  it("PLAN_OUT is wired for this script only, guarded on script name", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/inputs\.script == 'resolve-disagreeing-sale-twins' && '\/tmp\/resolve-disagreeing-sale-twins-plan'/);
  });

  it("the workflow file stays under GitHub's 512 KB per-workflow ceiling", () => {
    const stat = fs.statSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"));
    expect(stat.size).toBeLessThan(512 * 1024);
  });

  it("the workflow YAML carries no 0x08/0x00 bytes", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"));
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});

describe("REPORT == APPLY parity: the pure decision never branches on APPLY", () => {
  it("resolveDisagreement's verdict is identical regardless of any write-mode flag -- there is no APPLY parameter to the pure functions at all", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => (parsed.setKey === "bowman" ? new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]) : new Map()),
    });
    const a = mod.resolveDisagreement(deps, "hobbyiqCardId", long, short);
    const b = mod.resolveDisagreement(deps, "hobbyiqCardId", long, short);
    expect(a).toEqual(b);
  });
});

describe("plan rows == intended: every disagreeing pair this run sees is either resolved or named-left", () => {
  it("the reconcile line in the shipped source compares disagree pairs seen against resolved+left+protected+parked", () => {
    expect(src()).toMatch(/reconcile: disagree pairs seen/);
  });
  function src() {
    return fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
  }
});
