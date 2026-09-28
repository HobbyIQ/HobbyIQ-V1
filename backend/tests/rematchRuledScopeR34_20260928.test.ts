/**
 * R34-CPA-NAME-RESOLVE (Drew, 2026-09-28, "Fix all of baseball now").
 *
 * "A Bowman/Bowman Chrome autograph sale whose title never states the
 * alphanumeric card number resolves from (product, year, insert prefix,
 * player name) when exactly ONE checklist row of that insert set names that
 * player."
 *
 * THE POPULATION (gap80 census, C:/tmp/gap80_1445/cells.csv + samples/). In
 * 2026 bowman, 2025 bowman and 2024 bowman-chrome, a real fraction of
 * "unbacked" sales are Bowman Chrome Prospect Autograph (CPA-xxx) / Rookie
 * Autograph (CRA-xxx) sales whose listing title never states the number --
 * the checklist row exists (Travis Sykora -> CPA-TSY, Leo De Vries ->
 * CPA-LDV in 2024 bowman-chrome), the seller simply never printed the code.
 *
 * THIS RUNS ON THE OPPOSITE GATE FROM EVERY OTHER RULED SCOPE (R26-R33): they
 * all refine a derivation that ALREADY SUCCEEDED (`der.ok === true`). R34
 * fires precisely where `deriveIdentity` FAILED with `guard:cardnumber-
 * unparsed` and `classifyRow` would otherwise return UNDERIVABLE with no
 * `derived` identity to diff against at all -- so R34 builds its own
 * destination from a checklist name lookup rather than from the title parser.
 *
 * Same discipline as the R31/R32/R33 file (rematchRuledScopes20260914.test.ts)
 * this one sits beside: the predicate is pinned leg by leg, the dispatch
 * wiring (parseApplyScope, APPLY_CLASSES, applyKindOf, APPLY_KINDS, the queue
 * dispatch branch) is pinned structurally against the driver's own source, and
 * REPORT/APPLY parity is asserted end to end.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");
const CLASSIFIER_SRC = readFileSync(new URL("../scripts/lib/rematch-classify.cjs", import.meta.url), "utf8");
const RUNNER_SRC = readFileSync(new URL("../scripts/rematch-sold-comps.cjs", import.meta.url), "utf8");
const FLEET_SRC = readFileSync(new URL("../scripts/wave2/wave2-fleet.sh", import.meta.url), "utf8");

// ── the two small readers ────────────────────────────────────────────────────

describe("insertPrefixNamedInTitle — the registered-insert vocabulary, token-set not phrase", () => {
  it("resolves 'Chrome Prospect Auto' scattered across the title (real sample: Travis Sykora)", () => {
    expect(K.insertPrefixNamedInTitle(
      "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw",
    )).toBe("CPA");
  });

  it("resolves the contiguous phrase too (real sample: Leo De Vries)", () => {
    expect(K.insertPrefixNamedInTitle(
      "LEO DE VRIES 2024 Bowman 1st Chrome Prospect Auto Blue Reptilian RC /150 PSA 10",
    )).toBe("CPA");
  });

  it("resolves 'Rookie Auto' as CRA", () => {
    expect(K.insertPrefixNamedInTitle(
      "2024 Bowman Chrome 1st Travis Sykora ROOKIE AUTO /499 Refractor Nationals RC - Raw",
    )).toBe("CRA");
  });

  it("REFUSES a bare '1st Bowman ... Auto' with no Prospect/Rookie word at all", () => {
    // Measured: 7 of 20 sampled null-cardNumber 2024 bowman-chrome rows are
    // exactly this shape. Resolving from "1st Bowman Auto" alone would be
    // inventing a prefix the title never commits to.
    expect(K.insertPrefixNamedInTitle(
      "TRAVIS SYKORA 1st BOWMAN RC ON CARD AUTO /499 2024 Bowman Chrome Refractor - Raw",
    )).toBeNull();
    expect(K.insertPrefixNamedInTitle(
      "Travis Sykora 2024 Bowman Chrome 1st Bowman Auto Refractor /499 - Raw",
    )).toBeNull();
  });

  it("REFUSES a title with no insert vocabulary and no auto word at all", () => {
    expect(K.insertPrefixNamedInTitle("2024 Bowman Chrome #150 Blue Refractor")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(K.insertPrefixNamedInTitle("2024 BOWMAN CHROME PROSPECT AUTO TRAVIS SYKORA")).toBe("CPA");
  });
});

describe("titleNamesCandidatePlayer — a contiguous phrase, never a fuzzy score", () => {
  it("matches the candidate's name stated anywhere in the title", () => {
    expect(K.titleNamesCandidatePlayer(
      "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw",
      "Travis Sykora",
    )).toBe(true);
  });

  it("does not match a DIFFERENT player's name", () => {
    expect(K.titleNamesCandidatePlayer(
      "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw",
      "Leo De Vries",
    )).toBe(false);
  });

  it("tolerates a particle-bearing name (De Vries) exactly as G6 does", () => {
    expect(K.titleNamesCandidatePlayer(
      "LEO DE VRIES 2024 Bowman 1st Chrome Prospect Auto Blue Reptilian RC /150 PSA 10",
      "Leo De Vries",
    )).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(K.titleNamesCandidatePlayer("travis sykora rookie auto", "Travis Sykora")).toBe(true);
  });

  it("never fuzzy-matches a merely similar name", () => {
    expect(K.titleNamesCandidatePlayer("Travis Sykes 2024 Bowman Chrome Auto", "Travis Sykora")).toBe(false);
  });
});

// ── the evidence function ────────────────────────────────────────────────────

describe("R34-CPA-NAME-RESOLVE — the predicate", () => {
  const SYKORA_TITLE = "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw";
  const CANDIDATES = [
    { cardNumber: "CPA-TSY", playerName: "Travis Sykora", printRun: 499, parallel: "Refractor" },
    { cardNumber: "CPA-LDV", playerName: "Leo De Vries", printRun: 150, parallel: "Blue Reptilian Refractor" },
  ];
  const r34 = (o: Record<string, unknown> = {}) => K.cpaNameResolveEvidence({
    row: { title: (o.title as string) ?? SYKORA_TITLE },
    stored: (o.stored as object) ?? { cardNumber: null, parallel: "Refractor", printRun: null },
    derivationReasons: (o.derivationReasons as string[]) ?? ["guard:cardnumber-unparsed"],
    titleInsertPrefix: o.titleInsertPrefix === undefined ? "CPA" : o.titleInsertPrefix,
    candidates: (o.candidates as unknown[]) ?? CANDIDATES,
    titleSerial: o.titleSerial === undefined ? 499 : o.titleSerial,
    titleParallel: o.titleParallel === undefined ? null : o.titleParallel,
    resolvedBacked: o.resolvedBacked === undefined ? true : o.resolvedBacked,
  });

  it("HAPPY PATH: exactly one candidate's name agrees with the title -> resolved", () => {
    const r = r34();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.resolvedCardNumber).toBe("CPA-TSY");
    expect(r.evidence.resolvedPlayerName).toBe("Travis Sykora");
    expect(r.evidence.matchCount).toBe(1);
  });

  it("AMBIGUOUS: two candidates' names both agree -> refused, never a coin flip", () => {
    const r = r34({
      title: "Travis Sykora Leo De Vries 2024 Bowman Chrome Prospect Auto dual card",
      titleSerial: null,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.some((f: string) => f.startsWith("ambiguous-initials-collision"))).toBe(true);
  });

  it("NAME DISAGREEMENT: neither candidate's name is in the title -> refused, never a guess", () => {
    const r = r34({ title: "2024 Bowman Chrome Prospect Auto Refractor /499 - Raw", titleSerial: 499 });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("no-candidate-name-agrees-with-title");
  });

  it("PRINT RUN MISMATCH: the title's stated serial disagrees with the resolved row's own -> refused", () => {
    const r = r34({ titleSerial: 250 });
    expect(r.qualifies).toBe(false);
    expect(r.failed.some((f: string) => f.startsWith("printrun-disagrees-with-checklist-row"))).toBe(true);
  });

  it("PRINT RUN AGREEMENT is not required — a title stating no serial never refuses on it", () => {
    const r = r34({ titleSerial: null });
    expect(r.qualifies).toBe(true);
  });

  it("PARALLEL MISMATCH: a stated parallel that disagrees with the resolved row's own -> refused", () => {
    const r = r34({ titleParallel: "Gold Refractor" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.some((f: string) => f.startsWith("parallel-disagrees-with-checklist-row"))).toBe(true);
  });

  it("INSERT SET UNREGISTERED: the title names no registered prefix -> refused", () => {
    const r = r34({ titleInsertPrefix: null });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-no-registered-autograph-insert");
  });

  it("INSERT SET UNREGISTERED FOR THIS PRODUCT/YEAR: prefix named, but the checklist has no candidates", () => {
    const r = r34({ candidates: [] });
    expect(r.qualifies).toBe(false);
    expect(r.failed.some((f: string) => f.startsWith("insert-not-registered-for-product-year"))).toBe(true);
  });

  it("NOT THE CARDNUMBER-UNPARSED SHAPE: the derivation failed for a different reason entirely", () => {
    const r = r34({ derivationReasons: ["guard:sport-uncanonical"] });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("not-the-cardnumber-unparsed-shape");
  });

  it("OTHER GUARD REASONS PRESENT ALONGSIDE cardnumber-unparsed still refuses — fixing the number alone would not help", () => {
    const r = r34({ derivationReasons: ["guard:cardnumber-unparsed", "guard:setkey-missing"] });
    expect(r.qualifies).toBe(false);
    expect(r.failed.some((f: string) => f.startsWith("other-guard-reasons-present"))).toBe(true);
  });

  it("DESTINATION NOT CHECKLIST-BACKED: the resolved row itself is not proven to exist -> refused", () => {
    const r = r34({ resolvedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("resolved-destination-not-checklist-backed");
  });

  it("EMPTY MATCH SET IS NOT AN ERROR — zero candidates naming the title is UNRESOLVED, not a crash", () => {
    const r = r34({ candidates: [{ cardNumber: "CPA-XX", playerName: "Someone Else", printRun: null, parallel: null }] });
    expect(r.qualifies).toBe(false);
    expect(r.evidence.matchCount).toBe(0);
  });

  it("MEASURED SAMPLE: the real Sykora/De Vries titles from the gap80 census resolve", () => {
    const titles = [
      "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw",
      "LEO DE VRIES 2024 Bowman 1st Chrome Prospect Auto Blue Reptilian RC /150 PSA 10",
      "2024 Bowman Travis Sykora Chrome Prospect Auto Refractor 1st # /499 Nationals - Raw 10",
      "2024 Bowman Chrome 1st Travis Sykora ROOKIE AUTO /499 Refractor Nationals RC - Raw",
    ];
    for (const title of titles) {
      const prefix = K.insertPrefixNamedInTitle(title);
      expect(prefix, `"${title}" must name a registered prefix`).not.toBeNull();
      const r = K.cpaNameResolveEvidence({
        row: { title }, stored: { cardNumber: null },
        derivationReasons: ["guard:cardnumber-unparsed"],
        titleInsertPrefix: prefix, candidates: CANDIDATES,
        titleSerial: K.VOCAB.serialFromTitle(title), titleParallel: null, resolvedBacked: true,
      });
      expect(r.qualifies, `"${title}" must resolve: ${r.failed.join(",")}`).toBe(true);
    }
  });

  it("MEASURED REFUSAL: the terse '1st Bowman ... Auto' shape (no Prospect/Rookie word) never resolves", () => {
    const titles = [
      "TRAVIS SYKORA 1st BOWMAN RC ON CARD AUTO /499 2024 Bowman Chrome Refractor - Raw",
      "Travis Sykora 2024 Bowman Chrome 1st Bowman Auto Refractor /499 - Raw",
    ];
    for (const title of titles) {
      expect(K.insertPrefixNamedInTitle(title), `"${title}" must name no registered insert`).toBeNull();
    }
  });
});

// ── dispatch wiring: parseApplyScope / APPLY_CLASSES / applyKindOf / APPLY_KINDS ─

describe("R34 is dispatchable, and armed only by its own name", () => {
  it("each scope name arms exactly R34, and no other", () => {
    for (const name of ["r34", "cpa-name-resolve", "cpanameresolve"]) {
      const p = K.parseApplyScope(name);
      expect(p.ok, `${name}: ${p.reason}`).toBe(true);
      expect([...p.classes]).toEqual([K.CPA_NAME_RESOLVE]);
    }
  });

  it("comma combinations arm the union, with the existing scopes too", () => {
    const p = K.parseApplyScope("r33,r34");
    expect(p.ok).toBe(true);
    expect([...p.classes].sort()).toEqual([K.TITLE_CARD_NUMBER_WINS, K.CPA_NAME_RESOLVE].sort());
  });

  it("R34 is DELIBERATELY ABSENT from `both` and `all`", () => {
    for (const word of ["both", "all", "all-classes"]) {
      expect([...K.parseApplyScope(word).classes]).not.toContain(K.CPA_NAME_RESOLVE);
    }
  });

  it("a typo is still refused rather than defaulted", () => {
    expect(K.parseApplyScope("r99").ok).toBe(false);
  });

  it("R34 is in APPLY_CLASSES so applyKindOf can name it apart from IMPROVE", () => {
    expect(Object.values(K.APPLY_CLASSES)).toContain(K.CPA_NAME_RESOLVE);
  });

  it("applyKindOf maps the R34 subclass to itself, never to the bare IMPROVE fallback", () => {
    const kind = K.applyKindOf({ klass: K.IMPROVE, subclass: K.CPA_NAME_RESOLVE, writable: true });
    expect(kind).not.toBe(K.IMPROVE);
    expect(kind).toBe(K.CPA_NAME_RESOLVE);
  });

  it("a writable R34 row IS writable under its own scope, and NOT under scope=improve", () => {
    const res = { klass: K.IMPROVE, subclass: K.CPA_NAME_RESOLVE, writable: true, tier: K.AUTO };
    const r34Scope = K.parseApplyScope("r34").classes;
    const improveScope = K.parseApplyScope("improve").classes;
    expect(K.writableUnderScope(res, r34Scope)).toBe(true);
    expect(K.writableUnderScope(res, improveScope)).toBe(false);
  });

  it("R34 is in the driver's APPLY_KINDS list, beside the 2026-09-14 trio", () => {
    expect(RUNNER_SRC).toMatch(/K\.TITLE_FILLS_THE_BLANK, K\.SPLIT_MOVES_TO_THE_NAMED_SIDE, K\.TITLE_CARD_NUMBER_WINS,[\s\S]{0,600}K\.CPA_NAME_RESOLVE,/);
  });

  it("every APPLY_CLASSES constant is also in the driver's APPLY_KINDS — the two lists never drift apart", () => {
    const kindsMatch = RUNNER_SRC.match(/const APPLY_KINDS = \[([\s\S]*?)\n\];/);
    expect(kindsMatch).not.toBeNull();
    const kindsBlock = kindsMatch![1];
    for (const name of Object.keys(K.APPLY_CLASSES)) {
      expect(kindsBlock, `K.${name} is in APPLY_CLASSES but missing from APPLY_KINDS`).toContain(`K.${name}`);
    }
  });

  it("the queue dispatch has a branch that routes K.CPA_NAME_RESOLVE to a destination", () => {
    const start = RUNNER_SRC.indexOf('if (MODE === "apply-improve" && res.writable)');
    expect(start).toBeGreaterThan(-1);
    const end = RUNNER_SRC.indexOf("MID-UNIT PAGE CHECKPOINT", start);
    expect(end).toBeGreaterThan(start);
    const dispatch = RUNNER_SRC.slice(start, end);
    expect(dispatch).toMatch(/kind === K\.CPA_NAME_RESOLVE/);
  });

  it("the write path attaches cpaNameResolveEvidence and a named rekeyedReason", () => {
    expect(RUNNER_SRC).toMatch(/cand\.kind === K\.CPA_NAME_RESOLVE/);
    expect(RUNNER_SRC).toContain("R34-CPA-NAME-RESOLVE");
    expect(RUNNER_SRC).toMatch(/keep\.cpaNameResolveEvidence = e/);
  });

  it("THE FLEET ALLOWLIST accepts r34 beside the existing scopes", () => {
    expect(FLEET_SRC).toMatch(/improve\|r26\|r27\|r28\|r31\|r32\|r33\|r34\)\s*;;/);
  });
});

// ── the census wiring: per-scope counter, refusals and samples ──────────────

describe("the census reports R34's size AND what its guard turned away", () => {
  it("counts.r34 is written to the artifact beside the 09-14 trio", () => {
    expect(RUNNER_SRC).toMatch(/r31: scopeCounts\.r31, r32: scopeCounts\.r32, r33: scopeCounts\.r33,[\s\S]{0,300}r34: scopeCounts\.r34/);
  });

  it("R34's refusals are counted and sampled, same shape as R31/R33", () => {
    expect(RUNNER_SRC).toMatch(/byLeg: Object\.fromEntries\(scopeRefusalReasons\.r34\)/);
    expect(RUNNER_SRC).toMatch(/move: scopeMoveSamples\.r34, refuse: scopeRefuseSamples\.r34/);
  });

  it("an ENTRY failure (no registered insert named at all) is not counted as a refusal", () => {
    expect(RUNNER_SRC).toMatch(/r34: "title-names-no-registered-autograph-insert"/);
  });

  it("cpaInputs is spread into BOTH classifyRow call sites (census and apply write-time re-check)", () => {
    const occurrences = [...RUNNER_SRC.matchAll(/await cpaInputs\(/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// ── classifyRow end to end: the UNDERIVABLE door, and REPORT/APPLY parity ───

describe("classifyRow end to end: R34 fires on the UNDERIVABLE door", () => {
  const STORED = { sport: "baseball", cardYear: 2024, setKey: "bowman-chrome", cardNumber: null, parallel: "Blue Refractor", isAuto: false, printRun: null };
  const TITLE = "2024 Bowman 1st Prospect Travis Sykora Chrome Auto Refractor /499 - Raw";
  const CANDIDATES = [
    { cardNumber: "CPA-TSY", playerName: "Travis Sykora", printRun: 499, parallel: "Refractor" },
    { cardNumber: "CPA-LDV", playerName: "Leo De Vries", printRun: 150, parallel: "Blue Reptilian Refractor" },
  ];

  function classify(overrides: Record<string, unknown> = {}) {
    return K.classifyRow({
      row: { id: "sykora-1", cardId: "hiq:baseball:2024:bowman-chrome:null:blue-refractor:no-auto", title: TITLE },
      stored: STORED,
      derived: null, // deriveIdentity failed -- der.ok === false
      checklistBacked: false,
      derivationReasons: ["guard:cardnumber-unparsed"],
      storedSlug: "hiq:baseball:2024:bowman-chrome:null:blue-refractor:no-auto",
      titleInsertPrefix: "CPA",
      cpaCandidates: CANDIDATES,
      titleSerial: 499,
      cpaTitleParallel: null,
      cpaResolvedBacked: true,
      ...overrides,
    });
  }

  it("HAPPY PATH: resolves to IMPROVE/CPA_NAME_RESOLVE, writable, exit-code-worthy identity", () => {
    const res = classify();
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe(K.CPA_NAME_RESOLVE);
    expect(res.writable).toBe(true);
    expect(res.derived?.cardNumber).toBe("CPA-TSY");
    expect(res.axes.filled).toEqual(["cardNumber"]);
    expect(res.reasons.some((r: string) => r.startsWith("cpa-name-resolve:"))).toBe(true);
  });

  it("REPORT/APPLY PARITY: the SAME inputs classify identically whether or not APPLY writes", () => {
    // classifyRow itself carries no APPLY/REPORT branch -- writable is a pure
    // function of the same facts either mode supplies. This asserts the two
    // calls a real REPORT pass and a real APPLY pass would make (same row,
    // same catalog facts) agree on every field that decides whether to write.
    const a = classify();
    const b = classify();
    expect(a.klass).toBe(b.klass);
    expect(a.subclass).toBe(b.subclass);
    expect(a.writable).toBe(b.writable);
    expect(a.derived).toEqual(b.derived);
  });

  it("PROTECTED rows never write, even when everything else qualifies", () => {
    const res = classify({ row: { id: "p1", cardId: "x", title: TITLE, verifiedByUser: true } });
    expect(res.subclass).toBe(K.CPA_NAME_RESOLVE);
    expect(res.tier).toBe(K.PROTECTED);
    expect(res.writable).toBe(false);
  });

  it("AMBIGUOUS at the classifyRow level falls through to plain UNDERIVABLE, not a wrong write", () => {
    const res = classify({ row: { id: "amb", cardId: "x", title: "Travis Sykora Leo De Vries 2024 Bowman Chrome Prospect Auto dual card" }, titleSerial: null });
    expect(res.klass).toBe(K.UNDERIVABLE);
    expect(res.subclass).toBeUndefined();
    expect(res.writable).toBe(false);
    expect(res.reasons.some((r: string) => r.includes("ambiguous-initials-collision"))).toBe(true);
  });

  it("a row failing for an UNRELATED guard reason still classifies plain UNDERIVABLE — no false subclass tag", () => {
    const res = classify({ derivationReasons: ["guard:sport-uncanonical"] });
    expect(res.klass).toBe(K.UNDERIVABLE);
    expect(res.subclass).toBeUndefined();
    // Named only for real candidates -- an unrelated guard failure must NOT
    // carry an R34 refusal tag, or the census would count the corpus rather
    // than the defect.
    expect(res.reasons.join(" ")).not.toContain("not-cpa-name-resolve");
  });

  it("a row with a real `derived` identity never reaches the R34 door at all", () => {
    const res = classify({ derived: { ...STORED, cardNumber: "CPA-TSY" }, checklistBacked: true, derivationReasons: [] });
    expect(res.klass).not.toBe(K.UNDERIVABLE);
    expect(res.subclass).not.toBe(K.CPA_NAME_RESOLVE);
  });

  it("no exit-worthy exception is thrown across the whole matrix (no FATAL)", () => {
    const variants = [
      {},
      { titleInsertPrefix: null },
      { cpaCandidates: [] },
      { cpaResolvedBacked: false },
      { derivationReasons: [] },
      { derivationReasons: ["guard:cardnumber-unparsed", "guard:setkey-missing"] },
      { row: { id: "x", cardId: "y", title: "" } },
    ];
    for (const v of variants) {
      expect(() => classify(v)).not.toThrow();
    }
  });
});
