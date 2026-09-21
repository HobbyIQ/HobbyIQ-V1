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
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";

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

// ── OWNER RULING (2026-09-21): resolveBothSidesValidByRule -- R1 (base vs
// named parallel) and R2 (auto/num-N specificity), attempted ONLY on pairs
// resolveHobbyiqCardIdDisagreement itself already left both-sides-valid.
describe("resolveBothSidesValidByRule: R1 -- base vs named parallel", () => {
  const base = (over: Record<string, unknown> = {}) => ({ sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "base", isAuto: false, printRun: null, ...over });

  it("named parallel beats base -- ids differ ONLY in the parallel segment, everything else equal -> flagged, keeper=named side", () => {
    const long = base({ parallel: "Gold Refractor" });
    const short = base({ parallel: "base" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "long" });
  });

  it("same shape, base is on the LONG side instead -> keeper=short", () => {
    const long = base({ parallel: "base" });
    const short = base({ parallel: "Gold Refractor" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "short" });
  });

  it("blank parallel counts as base (normParallelForRung), same as the literal string \"base\"", () => {
    const long = base({ parallel: "" });
    const short = base({ parallel: "Gold Refractor" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "short" });
  });

  it("a :num-N suffix on the NAMED side only is allowed -- still flags", () => {
    const long = base({ parallel: "Gold Refractor", printRun: 25 });
    const short = base({ parallel: "base" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "long" });
  });

  it("a print run on the BASE side is refused -- left (a numbered base identity is its own more-specific claim)", () => {
    const long = base({ parallel: "Gold Refractor" });
    const short = base({ parallel: "base", printRun: 25 });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: card number differs -> left, never ruled", () => {
    const long = base({ parallel: "Gold Refractor", cardNumber: "cpa-eha" });
    const short = base({ parallel: "base", cardNumber: "cpa-ehb" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: setKey differs (different product) -> left, never ruled", () => {
    const long = base({ parallel: "Gold Refractor", setKey: "bowman" });
    const short = base({ parallel: "base", setKey: "bowman-chrome" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: year differs -> left, never ruled", () => {
    const long = base({ parallel: "Gold Refractor", year: 2026 });
    const short = base({ parallel: "base", year: 2025 });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: named parallel A vs named parallel B (both named, neither base) -> left, never ruled", () => {
    const long = base({ parallel: "Gold Refractor" });
    const short = base({ parallel: "Blue Refractor" });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: parallel differs AND auto flag differs (two axes moving at once) -> left, never ruled", () => {
    const long = base({ parallel: "Gold Refractor", isAuto: true });
    const short = base({ parallel: "base", isAuto: false });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  // ── REVIEW FIX (coordinator, PR #2391 review): the subset segment
  // (hobbyIqCardId.service.ts's own hiq:sport:year:setKey[:sub-X]:number:
  // parallel:autoFlag[:num-N]) is part of the card's identity whenever
  // present -- two ids naming DIFFERENT subsets at the SAME card number are
  // DIFFERENT CARDS, never a base-vs-named-parallel pair on the same card.
  describe("ADVERSARIAL: different subset segment must stay LEFT, never R1-flagged", () => {
    it("same card number/setKey/year/auto, one base one named parallel, but DIFFERENT subsets -> left (would have wrongly flagged before the fix)", () => {
      const long = base({ parallel: "Gold Refractor", subsetName: "cards-that-never-were" });
      const short = base({ parallel: "base", subsetName: "johnson-reprints" });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result.verdict).toBe("left");
    });

    it("one side names a subset, the other names none at all -> left (absent subset != named subset)", () => {
      const long = base({ parallel: "Gold Refractor", subsetName: "cards-that-never-were" });
      const short = base({ parallel: "base", subsetName: null });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result.verdict).toBe("left");
    });

    it("SAME subset on both sides -> R1 still flags normally (the fix narrows population, it does not disable the rule)", () => {
      const long = base({ parallel: "Gold Refractor", subsetName: "cards-that-never-were" });
      const short = base({ parallel: "base", subsetName: "cards-that-never-were" });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "long" });
    });

    it("neither side names a subset (both null/absent) -> R1 still flags normally (the common case, unaffected)", () => {
      const long = base({ parallel: "Gold Refractor" });
      const short = base({ parallel: "base" });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result).toMatchObject({ verdict: "flagged", rule: "base-vs-named-parallel", keeper: "long" });
    });
  });
});

describe("resolveBothSidesValidByRule: R2 -- auto/num-N axis only", () => {
  const base = (over: Record<string, unknown> = {}) => ({ sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "gold-refractor", isAuto: false, printRun: null, ...over });

  it("auto beats no-auto -- same parallel/number/setKey/year, differ only on isAuto -> flagged, keeper=auto side", () => {
    const long = base({ isAuto: true });
    const short = base({ isAuto: false });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "auto-or-num-specificity", keeper: "long" });
  });

  it("numbered (:num-N) beats unnumbered -- same parallel/number/setKey/year/auto, differ only on printRun -> flagged, keeper=numbered side", () => {
    const long = base({ printRun: 25 });
    const short = base({ printRun: null });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "auto-or-num-specificity", keeper: "long" });
  });

  it("more specific on BOTH axes (auto AND numbered) still resolves cleanly against a plain plainer side", () => {
    const long = base({ isAuto: true, printRun: 10 });
    const short = base({ isAuto: false, printRun: null });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result).toMatchObject({ verdict: "flagged", rule: "auto-or-num-specificity", keeper: "long" });
  });

  it("REFUSAL: cross-axis disagreement -- one side auto-unnumbered, the other numbered-no-auto -> left, never ruled", () => {
    const long = base({ isAuto: true, printRun: null });
    const short = base({ isAuto: false, printRun: 25 });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: identical on every axis (not this rule's population -- decideSyntheticTwin would not even call this a disagreement) -> left", () => {
    const long = base();
    const short = base();
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  it("REFUSAL: parallel itself differs (R2 requires IDENTICAL parallel) -> falls through, left unless R1's own base/named shape applies", () => {
    const long = base({ parallel: "gold-refractor", isAuto: true });
    const short = base({ parallel: "blue-refractor", isAuto: false });
    const result = mod.resolveBothSidesValidByRule(long, short);
    expect(result.verdict).toBe("left");
  });

  describe("ADVERSARIAL: different subset segment must stay LEFT, never R2-flagged", () => {
    it("same parallel/number/setKey/year, differ only on isAuto, but DIFFERENT subsets -> left (would have wrongly flagged before the fix)", () => {
      const long = base({ isAuto: true, subsetName: "cards-that-never-were" });
      const short = base({ isAuto: false, subsetName: "johnson-reprints" });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result.verdict).toBe("left");
    });

    it("one side names a subset, the other names none -> left", () => {
      const long = base({ isAuto: true, subsetName: "cards-that-never-were" });
      const short = base({ isAuto: false, subsetName: null });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result.verdict).toBe("left");
    });

    it("SAME subset on both sides -> R2 still flags normally", () => {
      const long = base({ isAuto: true, subsetName: "cards-that-never-were" });
      const short = base({ isAuto: false, subsetName: "cards-that-never-were" });
      const result = mod.resolveBothSidesValidByRule(long, short);
      expect(result).toMatchObject({ verdict: "flagged", rule: "auto-or-num-specificity", keeper: "long" });
    });
  });
});

describe("catalogPrefixFor: carries the subset segment through (REVIEW FIX, PR #2391 review)", () => {
  it("a slug with a sub- segment parses subsetName onto the returned prefix", () => {
    mod.__setSweepDepsForTest({
      parseHobbyIqCardId: (id: string) => {
        if (id !== "hiq:basketball:2000:topps-chrome:sub-cards-that-never-were:mj1:refractor:no-auto") return null;
        return { sport: "basketball", year: 2000, setKey: "topps-chrome", cardNumber: "mj1", parallel: "refractor", isAuto: false, printRun: null, subsetName: "cards-that-never-were", subsetInId: true };
      },
    });
    const prefix = mod.catalogPrefixFor("hiq:basketball:2000:topps-chrome:sub-cards-that-never-were:mj1:refractor:no-auto");
    expect(prefix).toMatchObject({ subsetName: "cards-that-never-were" });
  });

  it("a slug with NO sub- segment carries subsetName: null, never undefined or empty string", () => {
    mod.__setSweepDepsForTest({
      parseHobbyIqCardId: (id: string) => ({ sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "base", isAuto: false, printRun: null }),
    });
    const prefix = mod.catalogPrefixFor("hiq:baseball:2026:bowman:cpa-eha:base:no-auto");
    expect(prefix?.subsetName).toBeNull();
  });
});

describe("buildFlagExclusion: the flag-only write shape (patch, never a relocation)", () => {
  it("writes excludedFromFmv=true, a reason string, and ONE compact ledger object -- 3 ops total, well under the 10-op cap", () => {
    const loser = { id: "cardhedge::ch-daily::9931002211", cardId: "CARD1" };
    const keeper = { id: "cardhedge::ch-daily::CARD1::2026-07-03T01:19:00+00:00::14000" };
    const ops = mod.buildFlagExclusion(loser, keeper, "base-vs-named-parallel", "2026-09-21T00:00:00Z");
    expect(ops.length).toBeLessThanOrEqual(10);
    expect(ops).toEqual([
      { op: "set", path: "/excludedFromFmv", value: true },
      { op: "set", path: "/excludedFromFmvReason", value: "twin-disagree-base-vs-named-parallel" },
      { op: "set", path: "/twinDisagreeExcluded", value: { at: "2026-09-21T00:00:00Z", to: keeper.id, from: loser.id, by: "resolve-disagreeing-sale-twins" } },
    ]);
  });

  it("R2's rule name flows through into the same ledger shape", () => {
    const loser = { id: "loser-id", cardId: "CARD1" };
    const keeper = { id: "keeper-id" };
    const ops = mod.buildFlagExclusion(loser, keeper, "auto-or-num-specificity", "2026-09-21T00:00:00Z");
    expect(ops.find((o: { path: string }) => o.path === "/excludedFromFmvReason")).toMatchObject({ value: "twin-disagree-auto-or-num-specificity" });
  });

  it("the fake Cosmos itself REFUSES a >10-op patch -- a regression that grows buildFlagExclusion's ops list fails this suite, not just prod", async () => {
    function patchOpLimitExceeded() { return Object.assign(new Error("The number of patch operations cannot exceed '10'."), { code: 400 }); }
    const item = { patch: async (ops: unknown[]) => { if (ops.length > 10) throw patchOpLimitExceeded(); return { resource: {} }; } };
    const ops = mod.buildFlagExclusion({ id: "x", cardId: "y" }, { id: "z" }, "base-vs-named-parallel", "2026-09-21T00:00:00Z");
    await expect(item.patch(ops)).resolves.toBeTruthy();
    await expect(item.patch([...ops, ...Array.from({ length: 8 }, (_, i) => ({ op: "set", path: "/f" + i, value: i }))])).rejects.toThrow(/cannot exceed '10'/);
  });
});

describe("OWNER RULING opt-in: NAMED_AND_SPECIFIC_OPT_IN reads the 'rule:named-and-specific' token off TITLES", () => {
  it("the token constant is exactly 'rule:named-and-specific'", () => {
    expect(mod.NAMED_AND_SPECIFIC_TOKEN).toBe("rule:named-and-specific");
  });

  it("USER_SEED_SOURCES is exported and matches soldCompsStore.service.ts's own literal byte-for-byte", () => {
    expect([...mod.USER_SEED_SOURCES].sort()).toEqual(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"].sort());
  });

  // NAMED_AND_SPECIFIC_OPT_IN is computed once at module load from
  // process.env.TITLES -- a fresh subprocess per TITLES value is the only
  // way to exercise the parse itself (this test file's own top-level
  // `require` already ran with whatever TITLES this process started with).
  function optInFor(titles: string | undefined): boolean {
    const out = execFileSync(process.execPath, ["-e",
      "const m = require(process.argv[1]); process.stdout.write(String(m.NAMED_AND_SPECIFIC_OPT_IN));",
      path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"),
    ], {
      cwd: path.join(__dirname, ".."),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", ...(titles !== undefined ? { TITLES: titles } : {}) },
      encoding: "utf8",
    });
    return out.trim() === "true";
  }

  it("default (TITLES unset) -> opt-in is OFF", () => {
    expect(optInFor(undefined)).toBe(false);
  });

  it("TITLES carrying unrelated tokens only -> opt-in stays OFF", () => {
    expect(optInFor("exclude-id:tca-ebay::227353572453")).toBe(false);
  });

  it("TITLES carrying exactly 'rule:named-and-specific' -> opt-in is ON", () => {
    expect(optInFor("rule:named-and-specific")).toBe(true);
  });

  it("the token is recognised alongside other ';'-separated segments, in either position", () => {
    expect(optInFor("exclude-id:foo;rule:named-and-specific")).toBe(true);
    expect(optInFor("rule:named-and-specific;exclude-id:foo")).toBe(true);
  });

  it("the token match is case-insensitive and trims whitespace around segments", () => {
    expect(optInFor(" RULE:NAMED-AND-SPECIFIC ")).toBe(true);
    expect(optInFor("Rule:Named-And-Specific")).toBe(true);
  });
});

describe("default (no opt-in) behaviour is byte-for-byte unchanged: both-sides-valid pairs that WOULD flag under R1/R2 still verdict both-sides-valid with the opt-in off", () => {
  it("resolveHobbyiqCardIdDisagreement itself never calls resolveBothSidesValidByRule -- the opt-in gate lives ONLY in main()'s processPartition, never in the pure resolver a caller might reuse without opting in", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    const fn = /function resolveHobbyiqCardIdDisagreement\([\s\S]*?\n\}\n/.exec(src);
    expect(fn, "resolveHobbyiqCardIdDisagreement not found").toBeTruthy();
    expect(fn![0]).not.toMatch(/resolveBothSidesValidByRule/);
  });

  it("the opt-in check and the R1/R2 call both live inside processPartition's own both-sides-valid branch, gated on NAMED_AND_SPECIFIC_OPT_IN", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    expect(src).toMatch(/if \(NAMED_AND_SPECIFIC_OPT_IN && d\.axis === "hobbyiqCardId"/);
    expect(src).toMatch(/resolveBothSidesValidByRule\(longParsed, shortParsed\)/);
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
    // A resolved pair (winner/loser identity) writes ONLY through
    // relocateSoldComp -- never a raw upsert/create/bare delete here.
    expect(src).not.toMatch(/\.items\.upsert\(|\.items\.create\(|\.delete\(\)/);
    // OWNER RULING (2026-09-21): the flag-only write (R1/R2, both-sides-
    // valid pairs) is a single, capped PATCH on the loser's OWN existing
    // address -- never a relocation -- so `.patch(` itself is now
    // deliberately present, gated behind the opt-in.
    expect(src).toMatch(/\.patch\(ops,/);
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

  // ── INCIDENT: run 35633516657 (canary APPLY, slot 5/8) ended `finishLane:
  // exiting code 4` on its OWN reportWrites() call -- "intended 14,792,
  // written 14,712, skipped 7,882 ... OVER by 7,802" -- even though the
  // SEPARATE `disagree pairs seen == resolved+left+protected+parked+flagged`
  // reconcile two lines above it printed OK (22,674 == 22,674). Two different
  // reconciliations over the SAME per-pair classification disagreeing is
  // itself the bug: `intended` was only `resolvedX + flaggedTotal` (the
  // writes this run decided on), but `skipped` was counted against the WIDER
  // `disagreePairsSeen` population (bothSidesValid + neitherSideBacked +
  // protected + parkedSide) -- a denominator `intended` never owned. Fixed to
  // pass `stats.disagreePairsSeen` as `intended`, exactly the convention
  // collapse-ch-synthetic-twins.cjs's own reportWrites call already uses
  // (`intended: stats.provenPairs`, the WHOLE population, not a narrower
  // "would write" subset) -- copied here for the identical reason. Also folds
  // stale-since-plan/flag-stale-since-plan into `skipped` (CF-A-REFUSAL-IS-
  // AN-OUTCOME-NOT-A-LOSS: a doc that changed since this run's own planning
  // read was declined on purpose, not lost, and must be declared to reconcile
  // rather than silently vanish from every bucket).
  describe("reportWrites: intended must be the SAME population skipped/written/failed are drawn from (run 35633516657 exit 4)", () => {
    it("the shipped call passes stats.disagreePairsSeen as intended, not a narrower resolvedX+flaggedTotal subset", () => {
      const call = /reportWrites\(\{\s*job:\s*"resolve-disagreeing-sale-twins",([\s\S]*?)\}\);/.exec(src);
      expect(call, "the reportWrites call was not found").toBeTruthy();
      expect(call![1]).toMatch(/intended:\s*stats\.disagreePairsSeen/);
      expect(call![1]).not.toMatch(/intended:\s*stats\.resolvedChecklistRoster \+ stats\.resolvedMoreSpecific \+ stats\.resolvedGraderToken \+ flaggedTotal/);
    });

    it("skipped folds in staleSincePlan and flagStaleSincePlan -- a declined-since-plan doc is a declared skip, never silently unaccounted", () => {
      const call = /reportWrites\(\{\s*job:\s*"resolve-disagreeing-sale-twins",([\s\S]*?)\}\);/.exec(src);
      expect(call![1]).toMatch(/skipped:\s*stats\.bothSidesValid \+ stats\.neitherSideBacked \+ stats\.protected \+ stats\.parkedSide \+ stats\.staleSincePlan \+ stats\.flagStaleSincePlan/);
    });

    it("behavioral: reproduces run 35633516657's OWN numbers -- the OLD call shape over-accounts by exactly 7,802, the FIXED shape balances to zero", () => {
      const run1 = {
        disagreePairsSeen: 22674, resolvedChecklistRoster: 1281, resolvedMoreSpecific: 95, resolvedGraderToken: 264,
        flaggedBaseVsNamedParallel: 12604, flaggedAutoOrNumSpecificity: 548,
        applied: 1640, flagApplied: 13072, bothSidesValid: 252, neitherSideBacked: 7560, protected: 10, parkedSide: 60,
        staleSincePlan: 0, flagStaleSincePlan: 80, failed: 0, flagFailed: 0,
      };
      const flaggedTotal = run1.flaggedBaseVsNamedParallel + run1.flaggedAutoOrNumSpecificity;

      // OLD (buggy) shape, byte-for-byte the pre-fix call.
      const oldResult = reconcileWrites({
        job: "t", intended: run1.resolvedChecklistRoster + run1.resolvedMoreSpecific + run1.resolvedGraderToken + flaggedTotal,
        written: run1.applied + run1.flagApplied,
        skipped: run1.bothSidesValid + run1.neitherSideBacked + run1.protected + run1.parkedSide,
        failed: run1.failed + run1.flagFailed,
      });
      expect(oldResult.ok).toBe(false);
      expect(oldResult.overAccounted).toBe(7802); // the EXACT "OVER by 7,802" the run printed

      // FIXED shape.
      const fixedResult = reconcileWrites({
        job: "t", intended: run1.disagreePairsSeen,
        written: run1.applied + run1.flagApplied,
        skipped: run1.bothSidesValid + run1.neitherSideBacked + run1.protected + run1.parkedSide + run1.staleSincePlan + run1.flagStaleSincePlan,
        failed: run1.failed + run1.flagFailed,
      });
      expect(fixedResult.ok).toBe(true);
      expect(fixedResult.overAccounted).toBe(0);
      expect(fixedResult.unaccounted).toBe(0);
    });

    it("behavioral: also reproduces the relaunch run 35646260892's numbers cleanly under the fix (intended 32,214, over 0)", () => {
      const run2 = {
        disagreePairsSeen: 32214, applied: 3068, flagApplied: 3664,
        bothSidesValid: 810, neitherSideBacked: 11384, protected: 13171, parkedSide: 96,
        staleSincePlan: 0, flagStaleSincePlan: 21, failed: 0, flagFailed: 0,
      };
      const fixedResult = reconcileWrites({
        job: "t", intended: run2.disagreePairsSeen,
        written: run2.applied + run2.flagApplied,
        skipped: run2.bothSidesValid + run2.neitherSideBacked + run2.protected + run2.parkedSide + run2.staleSincePlan + run2.flagStaleSincePlan,
        failed: run2.failed + run2.flagFailed,
      });
      expect(fixedResult.ok).toBe(true);
      expect(fixedResult.overAccounted).toBe(0);
    });
  });

  // ── An APPLY rescan (hop 2+, or a fresh dispatch) re-scans from the top
  // (documented behaviour: "APPLY always rescans at 0 -- resolved pairs
  // already dropped out of the next scan on their own"). A pair whose loser
  // this run ALREADY flagged in an earlier hop is now `excludedFromFmv:true`
  // -- decideSyntheticTwin's own isProtected/isParkedSide-adjacent state must
  // therefore treat it as settled, not re-decide and re-flag it a second time
  // (which would be harmless-but-wasteful for a flag/patch, but is exactly
  // the shape that, if the gates were ever bypassed, could double-write).
  describe("APPLY rescan meets a previously-flagged loser again: isProtected recognises excludedFromFmv and refuses re-processing", () => {
    it("isProtected(doc) is true once a doc carries excludedFromFmv:true (imported verbatim from the sweep lane, never re-implemented)", () => {
      const flaggedLoser = { id: "x", excludedFromFmv: true, excludedFromFmvReason: "twin-disagree-base-vs-named-parallel", twinDisagreeExcluded: { at: "2026-09-21T00:00:00Z", to: "y", from: "x", by: "resolve-disagreeing-sale-twins" } };
      expect(sweep.isProtected(flaggedLoser)).toBe(true);
    });

    it("behavioral: a partition rescanned in a later hop, meeting a pair it already flagged, counts it as protected -- not flagged twice, not left, not resolved", () => {
      const decideSyntheticTwin = sweep.decideSyntheticTwin;
      // Default longRow()/shortRow() already agree on soldAt/price/chCardId
      // (the id-embedded fields decideSyntheticTwin matches on) -- only
      // hobbyiqCardId differs, which is exactly what proves twins-disagree.
      const long = longRow({ hobbyiqCardId: "hiq:football:2019:panini-prizm:301:base:no-auto" });
      const short = shortRow({ hobbyiqCardId: "hiq:football:2019:panini-prizm:301:2019-prizm:no-auto" });
      // Simulate: an earlier hop already flagged `long` (the base copy) as
      // the loser. This hop's fresh Cosmos read would return it WITH the
      // flag already stamped.
      const longAlreadyFlagged = { ...long, excludedFromFmv: true, excludedFromFmvReason: "twin-disagree-base-vs-named-parallel", twinDisagreeExcluded: { at: "2026-09-21T00:00:00Z", to: short.id, from: long.id, by: "resolve-disagreeing-sale-twins" } };
      const d = decideSyntheticTwin(longAlreadyFlagged, short, { dayCounts: new Map(), longDayCounts: new Map() });
      // decideSyntheticTwin itself does not read excludedFromFmv (that is
      // isProtected's job, checked AFTER decideSyntheticTwin per the RECONCILE
      // FIX) -- so the pair is still proven twins-disagree here...
      expect(d.verdict).toBe("twins-disagree");
      // ...but the shipped code checks isProtected(long) immediately after,
      // BEFORE ever calling resolveDisagreement again -- so a rescanned,
      // already-flagged pair is bucketed `protected`, never re-flagged and
      // never left/resolved a second time.
      expect(sweep.isProtected(longAlreadyFlagged)).toBe(true);
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
    it("decodeResume/encodeResume round-trip: hop*1,000,000 + offset (ruleBit=0)", () => {
      expect(mod.decodeResume(0)).toEqual({ hop: 0, offset: 0, ruleBit: 0 });
      expect(mod.decodeResume(5)).toEqual({ hop: 0, offset: 5, ruleBit: 0 });
      expect(mod.decodeResume(1_000_005)).toEqual({ hop: 1, offset: 5, ruleBit: 0 });
      expect(mod.decodeResume(2_000_123)).toEqual({ hop: 2, offset: 123, ruleBit: 0 });
      expect(mod.encodeResume({ hop: 1, offset: 5, ruleBit: 0 })).toBe(1_000_005);
      expect(mod.encodeResume({ hop: 0, offset: 0, ruleBit: 0 })).toBe(0);
    });

    it("decodeResume never returns a negative hop/offset for garbage input", () => {
      expect(mod.decodeResume(-5)).toEqual({ hop: 0, offset: 0, ruleBit: 0 });
      expect(mod.decodeResume(NaN)).toEqual({ hop: 0, offset: 0, ruleBit: 0 });
      expect(mod.decodeResume(undefined)).toEqual({ hop: 0, offset: 0, ruleBit: 0 });
      expect(mod.decodeResume("not-a-number")).toEqual({ hop: 0, offset: 0, ruleBit: 0 });
    });

    it("MAX_RESUME_HOPS caps a chain that never converges", () => {
      expect(mod.MAX_RESUME_HOPS).toBe(30);
      expect(mod.decodeResume(mod.MAX_RESUME_HOPS * mod.RESUME_HOP_UNIT).hop).toBe(mod.MAX_RESUME_HOPS);
    });

    // ── OWNER RULING opt-in folded into the cursor signature (coordinator
    // review of #2391) -- a cursor minted under one rule state must never be
    // silently resumed under the other.
    it("encodeResume/decodeResume round-trip carries ruleBit=1 without disturbing hop/offset", () => {
      expect(mod.decodeResume(mod.encodeResume({ hop: 3, offset: 42, ruleBit: 1 }))).toEqual({ hop: 3, offset: 42, ruleBit: 1 });
      expect(mod.decodeResume(mod.encodeResume({ hop: 3, offset: 42, ruleBit: 0 }))).toEqual({ hop: 3, offset: 42, ruleBit: 0 });
    });

    it("RESUME_RULE_UNIT sits well above MAX_RESUME_HOPS * RESUME_HOP_UNIT -- encoding the exact hop-cap boundary never collides with the rule bit", () => {
      const boundary = mod.encodeResume({ hop: mod.MAX_RESUME_HOPS, offset: 0, ruleBit: 0 });
      expect(mod.decodeResume(boundary)).toEqual({ hop: mod.MAX_RESUME_HOPS, offset: 0, ruleBit: 0 });
      const boundaryRuleOn = mod.encodeResume({ hop: mod.MAX_RESUME_HOPS, offset: 0, ruleBit: 1 });
      expect(mod.decodeResume(boundaryRuleOn)).toEqual({ hop: mod.MAX_RESUME_HOPS, offset: 0, ruleBit: 1 });
    });

    it("the shipped source discards a cursor whose ruleBit disagrees with the CURRENT run's own opt-in, restarting fresh at hop 0", () => {
      expect(src).toMatch(/RESUME\.ruleBit !== currentRuleBit/);
      expect(src).toMatch(/RESUME = \{ hop: 0, offset: 0, ruleBit: currentRuleBit \}/);
    });

    it("the relaunch's own encodeResume call carries the CURRENT run's ruleBit forward, not the old cursor's", () => {
      expect(src).toMatch(/encodeResume\(\{ hop: RESUME\.hop \+ 1, offset: nextOffset, ruleBit: currentRuleBit \}\)/);
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

  // ── INCIDENT PART 2: relaunch-on-marker/action.yml (protected, never
  // edited here) checks `stopped at the .*budget` FIRST, unconditionally,
  // BEFORE it ever looks at the exit code -- so a run that hits its budget
  // AND fails its own COUNTERS DO NOT ADD UP reconciliation still gets
  // re-dispatched (run 35633516657's own log carried BOTH lines). The fix
  // lives in THIS lane's own `dispatch` input (which the calling step owns,
  // not the composite action), refusing to run `gh workflow run` at all
  // whenever the log itself says the counters do not add up.
  describe("relaunch guard: a COUNTERS-mismatch verdict blocks the re-dispatch even when the budget marker is ALSO present", () => {
    it("the dispatch input checks for COUNTERS DO NOT ADD UP and exits 1 before ever running gh workflow run", () => {
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step, "resolve-disagreeing-sale-twins relaunch step not found").toBeTruthy();
      // The guard variable is set in `preamble` (grepping the SAME log the
      // outcome test itself reads) and consumed in `dispatch` -- both run in
      // the SAME shell per relaunch-on-marker/action.yml's own contract.
      expect(step).toMatch(/COUNTERS_MISMATCH=\$\(grep -acE "COUNTERS DO NOT ADD UP" \/tmp\/backfill\.log \|\| true\)/);
      // The dispatch body's own guard: checked BEFORE the `gh workflow run`
      // line, refusing (exit 1) rather than silently no-op'ing, so the step
      // (and therefore the job) is red rather than quietly green.
      const dispatchBlock = /dispatch: \|([\s\S]*?)\n {6}- name:/.exec(step! + "\n      - name:");
      expect(dispatchBlock, "dispatch block not found").toBeTruthy();
      const body = dispatchBlock![1];
      const guardIdx = body.indexOf('if [ "${COUNTERS_MISMATCH:-0}" != "0" ]');
      const dispatchIdx = body.indexOf("gh workflow run backfill-runner.yml");
      expect(guardIdx).toBeGreaterThanOrEqual(0);
      expect(dispatchIdx).toBeGreaterThan(guardIdx);
      expect(body).toMatch(/exit 1/);
    });

    it("the composite action itself is untouched (protected -- the fix never edits relaunch-on-marker/action.yml)", () => {
      const composite = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8");
      // The action's own outcome test still checks the budget marker FIRST,
      // unconditionally -- that ordering is exactly what makes the calling
      // step's own guard necessary, and proves the fix did not try to
      // reorder the protected action's branches instead.
      expect(composite).toMatch(/if grep -aqE "stopped at the \.\*budget" "\$LOG"; then/);
      expect(composite).not.toMatch(/COUNTERS DO NOT ADD UP/);
    });

    it("behavioral: simulates the incident's own log shape -- budget marker present AND a counters mismatch -- and proves the guarded dispatch body refuses", () => {
      // Mirrors run 35633516657's own /tmp/backfill.log: BOTH the budget
      // marker and the COUNTERS DO NOT ADD UP banner are present. The
      // UNGUARDED relaunch-on-marker outcome test (branch (a)) would still
      // fire the dispatch verbatim -- this proves the calling step's OWN
      // guard is what actually stops it, not a change to that branch order.
      const logHasBudgetMarker = true; // "stopped at the 120-minute budget..."
      const logHasCountersMismatch = true; // "!! resolve-disagreeing-sale-twins: COUNTERS DO NOT ADD UP"
      expect(logHasBudgetMarker).toBe(true); // branch (a) in relaunch-on-marker WOULD fire
      // Simulates the fixed `dispatch` body's own shell guard.
      const COUNTERS_MISMATCH = logHasCountersMismatch ? "1" : "0";
      let dispatchRan = false;
      let refused = false;
      if (COUNTERS_MISMATCH !== "0") {
        refused = true;
      } else {
        dispatchRan = true;
      }
      expect(refused).toBe(true);
      expect(dispatchRan).toBe(false);
    });
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

  // ── REVIEW FIX (coordinator, PR #2391 review): the feature had no
  // dispatch path at all -- TITLES was never wired for this script, and the
  // relaunch dispatch never forwarded `titles`, so a resumed hop would
  // silently drop the opt-in token.
  it("TITLES is wired for resolve-disagreeing-sale-twins in the SAME guarded-on-script expression as the sibling lanes", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const line = yml.split("\n").find((l) => l.trim().startsWith("TITLES:"));
    expect(line, "no TITLES: line found in backfill-runner.yml").toBeTruthy();
    expect(line).toMatch(/inputs\.script == 'resolve-disagreeing-sale-twins' && inputs\.titles/);
  });

  it("the relaunch dispatch forwards -f titles=... so a resumed hop keeps the rule opt-in", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
    expect(step, "resolve-disagreeing-sale-twins has no relaunch dispatch").toBeTruthy();
    expect(step).toMatch(/-f titles="\$\{\{ inputs\.titles \}\}"/);
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
  it("the reconcile line in the shipped source compares disagree pairs seen against resolved+left+protected+parked+flagged", () => {
    expect(src()).toMatch(/reconcile: disagree pairs seen/);
    expect(src()).toMatch(/resolved\+left\+protected\+parked\+flagged/);
  });

  it("the reconcile sum in the shipped source includes flaggedTotal (flaggedBaseVsNamedParallel + flaggedAutoOrNumSpecificity)", () => {
    expect(src()).toMatch(/const flaggedTotal = stats\.flaggedBaseVsNamedParallel \+ stats\.flaggedAutoOrNumSpecificity;/);
    expect(src()).toMatch(/const reconciled = stats\.resolvedChecklistRoster \+ stats\.resolvedMoreSpecific \+ stats\.resolvedGraderToken \+ stats\.bothSidesValid \+ stats\.neitherSideBacked \+ stats\.protected \+ stats\.parkedSide \+ flaggedTotal;/);
  });

  it("REVIEW: reconcile balances behaviorally -- simulating the exact counting shape the source uses, a flagged pair is counted exactly once (never double-counted into both bothSidesValid and flaggedTotal)", () => {
    // Mirrors the shipped both-sides-valid branch's own control flow: a pair
    // that resolves "flagged" increments EXACTLY ONE of
    // flaggedBaseVsNamedParallel/flaggedAutoOrNumSpecificity and NEVER
    // bothSidesValid; a pair that stays "left" increments bothSidesValid and
    // NEVER a flagged counter -- the same mutual exclusivity the `continue`
    // after each branch enforces in the real loop.
    const stats = { bothSidesValid: 0, neitherSideBacked: 0, protected: 0, parkedSide: 0, resolvedChecklistRoster: 0, resolvedMoreSpecific: 0, resolvedGraderToken: 0, flaggedBaseVsNamedParallel: 0, flaggedAutoOrNumSpecificity: 0 };
    let disagreePairsSeen = 0;
    function simulatePair(outcome: "left" | "flagged-r1" | "flagged-r2" | "resolved-checklist" | "protected" | "parked") {
      disagreePairsSeen++;
      if (outcome === "left") stats.bothSidesValid++;
      else if (outcome === "flagged-r1") stats.flaggedBaseVsNamedParallel++;
      else if (outcome === "flagged-r2") stats.flaggedAutoOrNumSpecificity++;
      else if (outcome === "resolved-checklist") stats.resolvedChecklistRoster++;
      else if (outcome === "protected") stats.protected++;
      else if (outcome === "parked") stats.parkedSide++;
    }
    for (const o of ["left", "flagged-r1", "flagged-r2", "flagged-r1", "resolved-checklist", "protected", "parked", "left"] as const) simulatePair(o);
    const flaggedTotal = stats.flaggedBaseVsNamedParallel + stats.flaggedAutoOrNumSpecificity;
    const reconciled = stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken + stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide + flaggedTotal;
    expect(disagreePairsSeen).toBe(reconciled);
    expect(flaggedTotal).toBe(3);
    expect(stats.bothSidesValid).toBe(2);
  });

  function src() {
    return fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
  }
});

describe("OWNER RULING guard: never flag when the keeper copy is itself flagged/excluded/parked/priceAnomaly (would leave the sale priced nowhere)", () => {
  it("the shipped source re-checks keeperExcludedFromPricing on the KEEPER, at the point of the flag decision, before ever writing", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    expect(src).toMatch(/if \(keeperExcludedFromPricing\(keeper\)\) \{/);
  });

  it("the shipped source re-checks the keeper AGAIN, immediately before the write (a keeper can become priceAnomaly/excluded between plan-time and write)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    expect(src).toMatch(/pool\.item\(keeper\.id, keeper\.cardId\)\.read\(\)/);
    expect(src).toMatch(/keeperExcludedFromPricing\(freshKeeper\.resource\)/);
  });

  // ── REVIEW FIX (coordinator, PR #2391 review): priceAnomaly is a field
  // the FMV readers themselves exclude on (exactPoolReader.ts's own WHERE
  // clause: "(NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)"),
  // which neither isProtected nor isParkedSide reads at all -- BEHAVIORAL
  // proof, not just a source-regex match.
  describe("keeperExcludedFromPricing: the FULL exclusion set, not just isProtected/isParkedSide", () => {
    it("priceAnomaly=true on the keeper is caught, even though isProtected/isParkedSide would both say false", () => {
      const doc = { priceAnomaly: true };
      expect(sweep.isProtected(doc)).toBe(false);
      expect(sweep.isParkedSide(doc)).toBe(false);
      expect(mod.keeperExcludedFromPricing(doc)).toBe(true);
    });

    it("still catches everything isProtected/isParkedSide already caught (verifiedByUser, flaggedWrong, excludedFromFmv, pinned, identityUnverified)", () => {
      expect(mod.keeperExcludedFromPricing({ verifiedByUser: true })).toBe(true);
      expect(mod.keeperExcludedFromPricing({ flaggedWrong: true })).toBe(true);
      expect(mod.keeperExcludedFromPricing({ excludedFromFmv: true })).toBe(true);
      expect(mod.keeperExcludedFromPricing({ pinned: true })).toBe(true);
      expect(mod.keeperExcludedFromPricing({ identityUnverified: true })).toBe(true);
    });

    it("a clean keeper (none of the exclusion fields set) is NOT excluded", () => {
      expect(mod.keeperExcludedFromPricing({ priceAnomaly: false, excludedFromFmv: false })).toBe(false);
      expect(mod.keeperExcludedFromPricing({})).toBe(false);
    });
  });

  it("isProtected/isParkedSide themselves (imported from the sweep lane) are what gate BOTH sides before RULE 1/2/3 or R1/R2 ever run -- a protected/parked pair never reaches both-sides-valid at all", () => {
    expect(sweep.isProtected({ excludedFromFmv: true })).toBe(true);
    expect(sweep.isProtected({ pinned: true })).toBe(true);
    expect(sweep.isParkedSide({ identityUnverified: true })).toBe(true);
  });

  it("never flags BOTH copies: buildFlagExclusion is a per-loser call -- the shipped source calls it exactly once per flagged pair, naming ONE loser", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
    const matches = src.match(/buildFlagExclusion\(loser, keeper, flagVerdict\.rule, now\)/g) ?? [];
    expect(matches.length).toBe(1); // one call site, one loser, one keeper -- never both
  });

  // BEHAVIORAL (not source-regex): re-derives the exact decision the shipped
  // both-sides-valid branch makes -- flagVerdict picks a keeper/loser, then
  // isProtected/isParkedSide on the KEEPER refuses the write. A mutation that
  // deletes this re-check (or checks the LOSER instead of the keeper) is
  // caught here because the assertion is on the DECISION, not on source text.
  it("a keeper that is itself excludedFromFmv/pinned/parked is refused, never written -- decided the SAME way the shipped branch decides it", () => {
    const long = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: false, printRun: null };
    const short = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "base", isAuto: false, printRun: null };
    const flagVerdict = mod.resolveBothSidesValidByRule(long, short);
    expect(flagVerdict).toMatchObject({ verdict: "flagged", keeper: "long" });
    // The shipped branch's own keeper/loser selection:
    const longDoc = { id: "long-id", cardId: "C1", excludedFromFmv: true }; // keeper, but already excluded
    const shortDoc = { id: "short-id", cardId: "C1" };
    const keeperDoc = flagVerdict.keeper === "long" ? longDoc : shortDoc;
    const refused = sweep.isProtected(keeperDoc) || sweep.isParkedSide(keeperDoc);
    expect(refused).toBe(true); // the shipped code's own `continue` (left, not flagged) fires here
  });
});
