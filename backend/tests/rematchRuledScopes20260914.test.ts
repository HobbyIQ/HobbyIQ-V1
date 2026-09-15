/**
 * THE THREE RULED SCOPES OF 2026-09-14 (Drew, recorded).
 *
 * R31/R32/R33, in the same shape as the 2026-09-06 and 2026-09-13 trios
 * (rematchRuledScopes20260906.test.ts, rematchRuledScopes20260913.test.ts):
 * three subclasses turned IMPROVE by a ruling, each report-first, each armed
 * only by its own scope name, each pinned leg by leg so a guard nothing can
 * revert alone is a guard nothing can prove.
 *
 * ── R31 — THE TITLE FILLS THE BLANK ─────────────────────────────────────────
 *
 * "A listing title that states a parallel or a print run the stored row lacks
 * fills it in (the row's parallel is blank/Base or printRun null, the title
 * names the rung / `/99`)."
 *
 * MEASURED against the 2026-09-13/14 verification census artifacts, 28 slots
 * (all but 0/7/8/22), 51,839 sampled class lines: 2,376 estimated moves
 * against 3,871 refusals. THE REFUSAL POPULATION IS WHAT THIS FILE PINS. Its
 * two largest legs are 1,144 `identity-axis-moved:setKey` (rows that are R26's
 * population — a specialty product filed under its flagship — which R31
 * declines BY NAME rather than quietly doing R26's job on R31's scope) and
 * 1,753 rows refused on `rung-not-in-product-checklist-vocabulary`, almost all
 * of them Pokemon `holofoil` / `reverse holofoil`. Those 1,753 are the
 * measured reason the vocabulary question is asked PER CELL (this product,
 * this year) rather than against a global union: `holofoil` is a real Pokemon
 * finish that the derived product's own checklist cell does not list, and a
 * global-union test would have moved every one of them onto a rung their
 * product never printed.
 *
 * ── R32 — THE SPLIT MOVES TO THE NAMED SIDE ─────────────────────────────────
 *
 * "A split-identity row (stored cardId != hobbyiqCardId) moves to the
 * checklist-backed side when the title names that side's differing segment."
 *
 * This is #2141's report-only `split` scope having its apply refusal LIFTED,
 * and it is deliberately a THIN GATE over `classifySplitScope` rather than a
 * second implementation of it -- the report and the apply must share one
 * definition of a split move or nobody can audit which was right. What R32
 * adds on top is the ruling's own ambiguity leg (both sides backed and the
 * title names neither, or names both) and the refusal to run on
 * split-scope.cjs's SHAPE PROXY: an apply measures backing against
 * card_catalog or it does not run.
 *
 * MEASURED over 11,400 sampled split rows: 2,059 have exactly one proxy-backed
 * side (a STRUCTURAL UPPER BOUND -- the split sample lines carry no title, so
 * the ruling's central condition is unmeasurable offline), against 7,628
 * `both-sides-checklist-backed` and 1,499 `neither-side-checklist-backed`.
 * That 7,628 is the PARK list working: there is no checklist answer about
 * which side is right, and the ruling does not let a fleet guess.
 *
 * ── R33 — THE TITLE'S CARD NUMBER WINS ──────────────────────────────────────
 *
 * "A stored card number that disagrees with the literal number in the title
 * takes the title's number when that (number, product) exists on the
 * checklist."
 *
 * MEASURED: of 34,423 sampled rows whose title states a literal `#N`, 33,499
 * have a stored number that ALREADY AGREES -- R33 is never asked about them,
 * and that healthy majority is why this scope is narrow. The ~500 that remain
 * are one coherent defect: hyphen-dropped insert numbers (`kb47` stored,
 * `#KB-47` in the title). The refusal legs this file pins are the ones that
 * keep it narrow -- `1 != 1-500` (a 500-card LOT listing, refused because the
 * derived number is not the title's token) and `90ASR-CY != 90asr` (the title
 * lexer TRUNCATED a long insert code, and the partial read is refused rather
 * than written through).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");
const CLASSIFIER_SRC = readFileSync(new URL("../scripts/lib/rematch-classify.cjs", import.meta.url), "utf8");
const RUNNER_SRC = readFileSync(new URL("../scripts/rematch-sold-comps.cjs", import.meta.url), "utf8");
const FLEET_SRC = readFileSync(new URL("../scripts/wave2/wave2-fleet.sh", import.meta.url), "utf8");

const axesOf = (o: Partial<Record<"same" | "filled" | "dropped" | "changed", string[]>> = {}) => ({
  same: o.same ?? [], filled: o.filled ?? [], dropped: o.dropped ?? [], changed: o.changed ?? [],
});

// ── scope 1: R31-TITLE-FILLS-THE-BLANK ──────────────────────────────────────

/**
 * REAL ROWS from the 2026-09-13/14 verification census sample artifacts
 * (wave2verify16/collect-final/flat/census-slot-*.json) — every one a stored
 * `Base`/null with the rung or the serial spelled out in the seller's own
 * words, which is the exact shape R31 rules a fill.
 */
const R31_SAMPLE_ROWS = [
  {
    id: "tca-ebay::158154075471",
    title: "2025 Topps Resurgence Aaron Rodgers #C-25 Conductors Yellow 13/225",
    stored: { setKey: "topps-resurgence", cardYear: 2025, cardNumber: "c-25", parallel: "Base", printRun: null },
    derived: { setKey: "topps-resurgence", cardYear: 2025, cardNumber: "c-25", parallel: "Yellow Surge Refractor", printRun: 225 },
    filled: ["parallel", "printRun"],
  },
  {
    id: "tca-ebay::398097266933",
    title: "2025 Panini Revolution - Malik Nabers #86 Fractal 97/99",
    stored: { setKey: "panini-revolution", cardYear: 2025, cardNumber: "86", parallel: "Base", printRun: 99 },
    derived: { setKey: "panini-revolution", cardYear: 2025, cardNumber: "86", parallel: "Fractal", printRun: 99 },
    filled: ["parallel"],
  },
  {
    id: "cardsight::de05fc3b170f04bc40ac71dc",
    title: "2025 Panini Donruss Elite - Rookies Oronde Gadsden II #159 Green Disco (RC)",
    stored: { setKey: "donruss-elite", cardYear: 2025, cardNumber: "159", parallel: "Base", printRun: null },
    derived: { setKey: "donruss-elite", cardYear: 2025, cardNumber: "159", parallel: "Green Disco", printRun: null },
    filled: ["parallel"],
  },
];

describe("R31-TITLE-FILLS-THE-BLANK — the predicate", () => {
  const r31 = (o: Record<string, unknown> = {}) => K.titleFillsTheBlankEvidence({
    row: { title: (o.title as string) ?? "2025 Panini Revolution - Malik Nabers #86 Fractal 97/99" },
    stored: (o.stored as object) ?? { parallel: "Base", printRun: null },
    derived: (o.derived as object) ?? { parallel: "Fractal", printRun: 99 },
    axes: (o.axes as object) ?? axesOf({ filled: ["parallel"] }),
    titleParallel: o.titleParallel === undefined ? "Fractal" : o.titleParallel,
    checklistListsTitleParallel: o.checklistListsTitleParallel === undefined ? true : o.checklistListsTitleParallel,
    titleSerial: o.titleSerial === undefined ? 99 : o.titleSerial,
    derivedBacked: o.derivedBacked === undefined ? true : o.derivedBacked,
  });

  it("HAPPY PATH: a stored Base with the rung named in the title qualifies", () => {
    const r = r31();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.fillsParallel).toBe(true);
    expect(r.evidence.destParallel).toBe("fractal");
  });

  it("HAPPY PATH: a null printRun filled from the title's own serial qualifies", () => {
    const r = r31({
      stored: { parallel: "Gold", printRun: null },
      derived: { parallel: "Gold", printRun: 225 },
      axes: axesOf({ filled: ["printRun"] }),
      titleSerial: 225,
      title: "2025 Topps Resurgence #C-25 Gold 13/225",
    });
    expect(r.qualifies).toBe(true);
    expect(r.evidence.fillsPrintRun).toBe(true);
  });

  it("REFUSED: the title's rung is not in THIS product's checklist vocabulary (the ruling's own guard)", () => {
    const r = r31({ checklistListsTitleParallel: false, titleParallel: "Holofoil", derived: { parallel: "Holofoil", printRun: null }, titleSerial: null, axes: axesOf({ filled: ["parallel"] }) });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("rung-not-in-product-checklist-vocabulary:holofoil");
  });

  it("REFUSED: NEVER INVENT A PRINT RUN — the title states no serial", () => {
    const r = r31({
      stored: { parallel: "Gold", printRun: null },
      derived: { parallel: "Gold", printRun: 199 },
      axes: axesOf({ filled: ["printRun"] }),
      titleSerial: null,
      title: "2025 Topps Chrome #12 Gold",
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("printrun-not-stated-in-title");
  });

  it("REFUSED: the derived print run disagrees with the serial the title states", () => {
    const r = r31({
      stored: { parallel: "Gold", printRun: null },
      derived: { parallel: "Gold", printRun: 199 },
      axes: axesOf({ filled: ["printRun"] }),
      titleSerial: 99,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("printrun-disagrees-with-title-serial");
  });

  it("REFUSED: NEVER WRITE `Base` INTO A BLANK — the destination parallel is itself base", () => {
    const r = r31({ titleParallel: "Base", derived: { parallel: "Base", printRun: 99 } });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-parallel-is-blank-or-base");
  });

  it("REFUSED: the stored parallel is a REAL rung, not a blank — that is a rival reading", () => {
    const r = r31({ stored: { parallel: "Gold Refractor", printRun: null } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("stored-parallel-is-not-blank:gold refractor");
  });

  it("REFUSED: a changed axis rides along — R26's population, declined by name", () => {
    const r = r31({ axes: axesOf({ filled: ["parallel"], changed: ["setKey"] }) });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("identity-axis-moved:setKey");
  });

  it("REFUSED: the destination is not checklist-backed", () => {
    const r = r31({ derivedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-not-checklist-backed");
  });

  it("NOT A CANDIDATE: nothing is being filled — the entry test, never a refusal", () => {
    const r = r31({ axes: axesOf({ same: ["parallel"] }) });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("no-blank-axis-filled");
  });

  it("BLANK MEANS UNKNOWN: every GENERIC_PARALLELS spelling counts as fillable", () => {
    for (const blank of ["", "base", "[base]", "none", "unknown"]) {
      const r = r31({ stored: { parallel: blank, printRun: null } });
      expect(r.qualifies, `stored parallel ${JSON.stringify(blank)} must be fillable`).toBe(true);
    }
  });

  it("MEASURED ROWS: every census sample row qualifies", () => {
    for (const row of R31_SAMPLE_ROWS) {
      const r = K.titleFillsTheBlankEvidence({
        row: { title: row.title }, stored: row.stored, derived: row.derived,
        axes: axesOf({ filled: row.filled }),
        titleParallel: row.derived.parallel,
        checklistListsTitleParallel: true,
        titleSerial: K.VOCAB.serialFromTitle(row.title),
        derivedBacked: true,
      });
      expect(r.qualifies, `${row.id} — ${r.failed.join(",")}`).toBe(true);
    }
  });
});

// ── scope 2: R32-SPLIT-MOVES-TO-THE-NAMED-SIDE ──────────────────────────────

describe("R32-SPLIT-MOVES-TO-THE-NAMED-SIDE — the predicate", () => {
  // A setKey split: one side a specific product, the other the bare fallback.
  const A = "hiq:football:2025:panini-phoenix:1:base:no-auto";
  const B = "hiq:football:2025:panini:1:base:no-auto";
  const r32 = (o: Record<string, unknown> = {}) => K.splitMovesToTheNamedSideEvidence({
    row: {
      cardId: (o.cardId as string) ?? A,
      hobbyiqCardId: (o.hobbyiqCardId as string) ?? B,
      title: (o.title as string) ?? "2025 Panini Phoenix Football #1 Base",
    },
    splitClass: o.splitClass === undefined ? K.SPLIT_CLASSES.HIQ_SPLIT : o.splitClass,
    splitSegments: (o.splitSegments as string[]) ?? ["setKey"],
    backedSides: o.backedSides === undefined ? { cardId: true, hobbyiqCardId: false } : o.backedSides,
  });

  it("HAPPY PATH: one backed side, and the title names that side's product", () => {
    const r = r32();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.destination).toBe("cardId");
  });

  it("REFUSED: checklist backing was NOT MEASURED — an apply never runs on the shape proxy", () => {
    const r = r32({ backedSides: null });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("checklist-backing-not-measured");
  });

  it("REFUSED: both sides backed and the title names NEITHER (the ruling's own leg)", () => {
    const r = r32({
      backedSides: { cardId: true, hobbyiqCardId: true },
      cardId: "hiq:football:2025:panini-phoenix:1:base:no-auto",
      hobbyiqCardId: "hiq:football:2025:panini-select:1:base:no-auto",
      title: "2025 Football Card #1",
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("both-sides-backed-and-title-names-neither");
  });

  it("REFUSED: both sides backed and the title names BOTH (evidence for neither)", () => {
    const r = r32({
      backedSides: { cardId: true, hobbyiqCardId: true },
      cardId: "hiq:football:2025:panini-phoenix:1:base:no-auto",
      hobbyiqCardId: "hiq:football:2025:panini-select:1:base:no-auto",
      title: "2025 Panini Phoenix Select Football #1",
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("both-sides-backed-and-title-names-both");
  });

  it("REFUSED: the title does not name the backed side's differing segment", () => {
    const r = r32({ title: "2025 Football Card #1 Base" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("split-scope-parks:title-does-not-name-destination");
  });

  it("REFUSED: not a HIQ-SPLIT row — a vendor-design split is a different defect", () => {
    const r = r32({ splitClass: K.SPLIT_CLASSES.VENDOR_DESIGN });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("not-a-hiq-split");
  });

  it("REFUSED: neither side backed — there is nowhere to move to", () => {
    const r = r32({ backedSides: { cardId: false, hobbyiqCardId: false } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("split-scope-parks:neither-side-checklist-backed");
  });

  it("IS A THIN GATE OVER classifySplitScope, not a second implementation", () => {
    expect(CLASSIFIER_SRC).toMatch(/splitMovesToTheNamedSideEvidence[\s\S]{0,4000}SPLIT_SCOPE\.classifySplitScope\(/);
  });
});

// ── scope 3: R33-TITLE-CARD-NUMBER-WINS ─────────────────────────────────────

/** REAL ROWS from the census artifacts: the hyphen-dropped insert numbers that
 *  are essentially the whole of R33's measured population. */
const R33_SAMPLE_ROWS = [
  {
    id: "tca-ebay::198617357961",
    title: "2008-09 Upper Deck MVP #KB-47 Kobe Bryant BASKETBALL Los Angeles Lakers",
    stored: { cardNumber: "kb47" }, derived: { cardNumber: "KB-47" },
  },
  {
    id: "tca-ebay::800605242172",
    title: "2008-09 Upper Deck - Kobe Bryant Basketball Heroes Kobe Bryant #KB-10",
    stored: { cardNumber: "kb10" }, derived: { cardNumber: "KB-10" },
  },
  {
    id: "tca-ebay::117404750859",
    title: "2008 Upper Deck MVP Black Boarder Kobe Bryant #KB-74 Lakers HOF GOAT INSERT",
    stored: { cardNumber: "kb74" }, derived: { cardNumber: "KB-74" },
  },
];

describe("R33-TITLE-CARD-NUMBER-WINS — the predicate", () => {
  const r33 = (o: Record<string, unknown> = {}) => K.titleCardNumberWinsEvidence({
    row: { title: (o.title as string) ?? "2008-09 Upper Deck MVP #KB-47 Kobe Bryant" },
    stored: (o.stored as object) ?? { cardNumber: "kb47" },
    derived: (o.derived as object) ?? { cardNumber: "KB-47" },
    axes: (o.axes as object) ?? axesOf({ changed: ["cardNumber"] }),
    titleNumberIsChecklistRow: o.titleNumberIsChecklistRow === undefined ? true : o.titleNumberIsChecklistRow,
    derivedBacked: o.derivedBacked === undefined ? true : o.derivedBacked,
  });

  it("HAPPY PATH: a hyphen-dropped stored number takes the title's literal number", () => {
    const r = r33();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.titleNumber).toBe("kb-47");
    expect(r.evidence.storedCardNumber).toBe("kb47");
  });

  it("REFUSED: the (number, product) is not a checklist row — the ruling's own condition", () => {
    const r = r33({ titleNumberIsChecklistRow: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("title-number-not-a-checklist-row");
  });

  it("REFUSED: A LOT LISTING — the title says #1-500 and the deriver read 1", () => {
    const r = r33({
      title: "1990 Topps Baseball Complete Set #1-500",
      stored: { cardNumber: "1-500" }, derived: { cardNumber: "1" },
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("derived-number-is-not-the-title-number");
  });

  it("REFUSED: the derivation did not independently reach the title's number", () => {
    const r = r33({ derived: { cardNumber: "KB-99" } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("derived-number-is-not-the-title-number");
  });

  it("REFUSED: a changed axis rides along — a card-number repair never carries a setKey move", () => {
    const r = r33({ axes: axesOf({ changed: ["cardNumber", "setKey"] }) });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("identity-axis-moved:setKey");
  });

  it("REFUSED: the destination is not checklist-backed", () => {
    const r = r33({ derivedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-not-checklist-backed");
  });

  it("NOT A CANDIDATE: a blank stored number is a FILL (R31's axis), never R33's", () => {
    const r = r33({ stored: { cardNumber: "" } });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("stored-card-number-is-blank-not-a-disagreement");
  });

  it("NOT A CANDIDATE: the stored number already agrees with the title", () => {
    const r = r33({ stored: { cardNumber: "KB-47" } });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("stored-card-number-already-agrees-with-title");
  });

  it("THE LITERAL NUMBER ONLY: a serial is a print run, a long run is a cert", () => {
    expect(K.cardNumberFromTitle("2025 Topps Chrome #RV-12 Blue")).toBe("rv-12");
    expect(K.cardNumberFromTitle("2025 Topps Chrome #788/1000 Blue")).toBeNull();
    expect(K.cardNumberFromTitle("PSA cert #12345678")).toBeNull();
    expect(K.cardNumberFromTitle("2025 Topps Chrome Blue")).toBeNull();
  });

  it("cardNumbersAgree folds case and leading zeros, NEVER hyphens", () => {
    expect(K.cardNumbersAgree("rv-012", "RV-12")).toBe(true);
    expect(K.cardNumbersAgree("kb47", "KB-47")).toBe(false);  // the defect itself
    expect(K.cardNumbersAgree("12", "21")).toBe(false);
  });

  it("MEASURED ROWS: every census sample row qualifies", () => {
    for (const row of R33_SAMPLE_ROWS) {
      const r = K.titleCardNumberWinsEvidence({
        row: { title: row.title }, stored: row.stored, derived: row.derived,
        axes: axesOf({ changed: ["cardNumber"] }),
        titleNumberIsChecklistRow: true, derivedBacked: true,
      });
      expect(r.qualifies, `${row.id} — ${r.failed.join(",")}`).toBe(true);
    }
  });
});

// ── the dispatch surface: scope names and the allowlist ─────────────────────

describe("the 2026-09-14 scopes are dispatchable, and armed only by name", () => {
  it("each scope name arms exactly its own class", () => {
    for (const [name, klass] of [
      ["r31", K.TITLE_FILLS_THE_BLANK],
      ["r32", K.SPLIT_MOVES_TO_THE_NAMED_SIDE],
      ["r33", K.TITLE_CARD_NUMBER_WINS],
      ["title-fills-the-blank", K.TITLE_FILLS_THE_BLANK],
      ["split-moves-to-the-named-side", K.SPLIT_MOVES_TO_THE_NAMED_SIDE],
      ["title-card-number-wins", K.TITLE_CARD_NUMBER_WINS],
    ] as const) {
      const p = K.parseApplyScope(name);
      expect(p.ok, `${name}: ${p.reason}`).toBe(true);
      expect([...p.classes]).toEqual([klass]);
    }
  });

  it("`split` IS FOLDED INTO R32 — #2141's refusal is lifted, not kept beside it", () => {
    const p = K.parseApplyScope("split");
    expect(p.ok).toBe(true);
    expect([...p.classes]).toEqual([K.SPLIT_MOVES_TO_THE_NAMED_SIDE]);
  });

  it("comma combinations arm the union, with the existing scopes too", () => {
    const p = K.parseApplyScope("r31,r33");
    expect(p.ok).toBe(true);
    expect([...p.classes].sort()).toEqual([K.TITLE_FILLS_THE_BLANK, K.TITLE_CARD_NUMBER_WINS].sort());

    const q = K.parseApplyScope("improve,r32");
    expect(q.ok).toBe(true);
    expect([...q.classes].sort()).toEqual([K.IMPROVE, K.SPLIT_MOVES_TO_THE_NAMED_SIDE].sort());
  });

  it("the new scopes are DELIBERATELY ABSENT from `both` and `all`", () => {
    for (const word of ["both", "all", "all-classes"]) {
      const classes = [...K.parseApplyScope(word).classes];
      expect(classes).not.toContain(K.TITLE_FILLS_THE_BLANK);
      expect(classes).not.toContain(K.SPLIT_MOVES_TO_THE_NAMED_SIDE);
      expect(classes).not.toContain(K.TITLE_CARD_NUMBER_WINS);
    }
  });

  it("a typo is still refused rather than defaulted", () => {
    expect(K.parseApplyScope("r34").ok).toBe(false);
    expect(K.parseApplyScope("refractor").ok).toBe(false);
  });

  it("each new class is in APPLY_CLASSES so applyKindOf can name it apart from IMPROVE", () => {
    const values = Object.values(K.APPLY_CLASSES);
    expect(values).toContain(K.TITLE_FILLS_THE_BLANK);
    expect(values).toContain(K.SPLIT_MOVES_TO_THE_NAMED_SIDE);
    expect(values).toContain(K.TITLE_CARD_NUMBER_WINS);
  });

  it("THE FLEET ALLOWLIST accepts the three scopes and maps `split` to r32", () => {
    expect(FLEET_SRC).toMatch(/improve\|r26\|r27\|r28\|r31\|r32\|r33\)\s*;;/);
    expect(FLEET_SRC).toMatch(/split\)\s*SCOPE=r32\s*;;/);
    // The count key is read generically -- no per-scope case was needed.
    expect(FLEET_SRC).toMatch(/\*\)\s+SCOPE_COUNT_KEY="\$SCOPE"\s*;;/);
  });

  it("THE FLEET no longer carries #2141's permanent `split` refusal", () => {
    expect(FLEET_SRC).not.toMatch(/split\)\s*die "WAVE2_APPLY_SCOPE='split' has no apply path/);
  });

  it("parseApplyScope no longer refuses `split` before the alias table", () => {
    expect(CLASSIFIER_SRC).not.toMatch(/if \(parts\.includes\("split"\)\) \{/);
  });
});

// ── the census wiring: per-scope counters, refusals and samples ─────────────

describe("the census reports each scope's size AND what its guard turned away", () => {
  it("counts.r31 / r32 / r33 are written to the artifact beside the 09-13 trio", () => {
    expect(RUNNER_SRC).toMatch(/r31: scopeCounts\.r31, r32: scopeCounts\.r32, r33: scopeCounts\.r33/);
  });

  it("REFUSALS ARE COUNTED AND SAMPLED — the ruling asks for it by name", () => {
    expect(RUNNER_SRC).toMatch(/scopeRefusals: \{/);
    expect(RUNNER_SRC).toMatch(/byLeg: Object\.fromEntries\(scopeRefusalReasons\.r31\)/);
    expect(RUNNER_SRC).toMatch(/scopeSamples: \{/);
    expect(RUNNER_SRC).toMatch(/move: scopeMoveSamples\.r31, refuse: scopeRefuseSamples\.r31/);
  });

  it("an ENTRY failure is not counted as a refusal — that would count the corpus", () => {
    expect(RUNNER_SRC).toMatch(/SCOPE_ENTRY_FAILURES/);
    expect(RUNNER_SRC).toMatch(/if \(entry && ev\.failed\.includes\(entry\)\) return;/);
  });

  it("the per-scope aggregates RESUME — scopeCounts is registered in AGGREGATE_FIELDS", () => {
    // Before this change `scopeCounts` was absent from the registry, so a
    // resumed census silently restarted every ruled scope count at zero while
    // `counts` itself resumed correctly.
    expect(RUNNER_SRC).toMatch(/scopeCounts: "object", scopeRefusals: "object",/);
    expect(RUNNER_SRC).toMatch(/scopeCounts, scopeRefusals,/);
  });

  it("R32's backing is MEASURED against the catalog, never the shape proxy", () => {
    expect(RUNNER_SRC).toMatch(/checklistBacked\(row\?\.cardId\)/);
    expect(RUNNER_SRC).toMatch(/checklistBacked\(row\?\.hobbyiqCardId\)/);
  });
});

// ── the reconcile covers R31/R32/R33 too (follow-up to #2149) ───────────────
//
// `K.APPLY_CLASSES` (tested above, "armed only by name") is what lets
// `applyKindOf` NAME a row's subclass apart from the ordinary IMPROVE it
// nests inside. `APPLY_KINDS` in rematch-sold-comps.cjs is a DIFFERENT list
// -- the one the pre-flight ARMED/DISARMED banner, the per-class reconcile
// and `everyWriteJobReconciles`'s own scope-failure guard (a DISARMED class
// that is ever written exits 6) all walk. R31/R32/R33 were exported and
// classified correctly from day one, but never added to THIS list, so a
// scope=r31 (or r32, r33) apply printed no ARMED/DISARMED line for its own
// class and -- the real gap -- a write bug in exactly that class could not
// have tripped the per-class scope-failure guard; it would only ever have
// shown up in the coarser whole-run reconcile, unattributed. No write
// behaviour changes: this is visibility and a safety net, not a new path.
describe("APPLY_KINDS carries R31/R32/R33 too (banner, reconcile, scope guard)", () => {
  it("the list itself names all three, same line as the 09-13 trio", () => {
    expect(RUNNER_SRC).toMatch(
      /K\.FLAGSHIP_SWALLOWED_NAMED_PRODUCT, K\.POKEMON_SET_CODE, K\.FINISH_IS_A_PARALLEL,[\s\S]{0,1200}?K\.TITLE_FILLS_THE_BLANK, K\.SPLIT_MOVES_TO_THE_NAMED_SIDE, K\.TITLE_CARD_NUMBER_WINS,/,
    );
  });

  it("every constant APPLY_CLASSES names is also in APPLY_KINDS — the two lists never drift apart", () => {
    // `K.APPLY_CLASSES` names every subclass `applyKindOf` must tell apart
    // from the ordinary IMPROVE it nests inside; `APPLY_KINDS` is the
    // separate list the banner/reconcile/guard walk. They are declared in
    // two different files for two different readers, so nothing enforces
    // they stay in sync except a test that reads both. Matched on the bare
    // `K.<NAME>` identifier text in the APPLY_KINDS source block, not on the
    // exported string VALUES (APPLY_CLASSES holds those, e.g. "R31-..."),
    // since APPLY_KINDS is written as identifiers, not strings.
    const kindsMatch = RUNNER_SRC.match(/const APPLY_KINDS = \[([\s\S]*?)\];/);
    expect(kindsMatch).not.toBeNull();
    const kindsBlock = kindsMatch![1];
    for (const name of Object.keys(K.APPLY_CLASSES)) {
      expect(kindsBlock, `K.${name} is in APPLY_CLASSES but missing from APPLY_KINDS`).toContain(`K.${name}`);
    }
  });

  it("R31/R32/R33 get a real ARMED/DISARMED line under a scoped apply, not silence", () => {
    // The banner loop (`if (MODE === "apply-improve") { ... for (const kind of
    // APPLY_KINDS) ... }`) and the PER CLASS reconcile loop both walk
    // APPLY_KINDS directly -- there is no separate allowlist to also update,
    // so membership in the list IS the fix. Pinned here as the two loop
    // sites, so a future refactor that reintroduces a second, narrower list
    // fails loudly instead of silently dropping the three again.
    expect(RUNNER_SRC.split("for (const kind of APPLY_KINDS)").length - 1).toBeGreaterThanOrEqual(3);
  });
});
