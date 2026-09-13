/**
 * THE THREE RULED SUBCLASSES OF 2026-09-13 (Drew, widget).
 *
 * R26/R27/R28, in the same shape as the 2026-09-06 trio
 * (rematchRuledScopes20260906.test.ts): three CONFLICT subclasses turned
 * IMPROVE by a ruling, each report-first, each armed only by its own scope
 * name, each pinned branch by branch so a leg nothing can revert alone is a
 * leg nothing can prove.
 *
 * ── R26 — FLAGSHIP SWALLOWED A NAMED PRODUCT ────────────────────────────────
 *
 * A sale on a specialty release (Topps Cosmic Chrome, Topps Resurgence,
 * Topps Signature Class, Topps Inception, Donruss Optic, Donruss Elite, ...)
 * filed under its bare flagship key. The title states the product in full and
 * productSetKeys.ts already declares it as a child of the stored flagship, so
 * the fix reads the table the platform already keeps rather than a new
 * hand-built ladder entry per product.
 *
 * ── R27 — POKEMON BARE SET CODE IS THE KEY ──────────────────────────────────
 *
 * CF-THE-SET-CODE-IS-THE-KEY (pokemonSetCodes.ts). Sellers write the set CODE
 * as often as the name, and a stored descriptive name / `unknown` / stale
 * default in front of a derived bare code is exactly the "unknown setKey"
 * bucket #1796 measured as overwhelmingly promo and code spellings. THE 24
 * COLLIDING EN/JA CODES (AMBIGUOUS_MARKET_CODES) ARE THE CARVE-OUT: they move
 * only when the row's own language flag resolves which market it names, and
 * the gap this file closes is that an unresolved collision reaches the pool
 * through the ORDINARY `filled:setKey` arm too (a blank stored key is not
 * `changed:setKey` at all), not only through R27's own CONFLICT-path gate —
 * see GUARD 10 in `improveRefusals`.
 *
 * ── R28 — A FINISH MINTED AS A SETKEY ───────────────────────────────────────
 *
 * Stored `<product>-<finish>`, derived `<product>` with the finish carried as
 * the parallel instead. MEASURED against the census sample artifacts,
 * 2026-09-13 (9 slot files, every sampled CONFLICT row whose stored key is
 * `<derived>-<word>`): 262 syntactic matches, 246 of which MUST be refused —
 * declared DISTINCT products (`topps-chrome-platinum`, 15 rows;
 * `bowman-university-chrome`, 1 row) and real undeclared products whose tail
 * is not finish vocabulary at all (`panini-prizm-deca`, `topps-midnight`,
 * `topps-206`, `topps-diamond-icons`, ...) — against 16 GENUINE positives
 * (`topps-chrome-logofractor`, `topps-heritage-mini`), where the tail word
 * really is a checklist-listed finish of the derived product. The guard this
 * file pins separates a 16-row genuine population from a 246-row
 * false-positive population outnumbering it 15 to 1.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");
const CLASSIFIER_SRC = readFileSync(new URL("../scripts/lib/rematch-classify.cjs", import.meta.url), "utf8");
const RUNNER_SRC = readFileSync(new URL("../scripts/rematch-sold-comps.cjs", import.meta.url), "utf8");

const baseAxes = (changed: string[] = ["setKey"]) => ({ same: [], filled: [], dropped: [], changed });

// ── scope 1: R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT ───────────────────────────

/**
 * Real rows from the 2026-09-13 census sample artifacts
 * (C:/tmp/hiq-rebaseline-prep/.scratch/census-partial/census-slot-{0,1,2,3}.json),
 * classified CONFLICT on main, `changed:setKey`, stored on the bare flagship
 * with the derivation reading the named specialty product — the exact shape
 * R26 rules IMPROVE.
 */
const R26_SAMPLE_ROWS = [
  {
    id: "cardhedge::ch-daily::1777695335428x739352607400438800",
    title: "2025 Donruss Elite Football #125 Base",
    stored: { sport: "football", cardYear: 2025, setKey: "panini-donruss", cardNumber: "125", parallel: "Base", isAuto: false },
    derived: { sport: "football", cardYear: 2025, setKey: "donruss-elite", cardNumber: "125", parallel: "Base", isAuto: false },
  },
  {
    id: "cardhedge::ch-daily::1775148696054x980045227400144800",
    title: "2025 Donruss Optic Football #11 Base",
    stored: { sport: "football", cardYear: 2025, setKey: "panini-donruss", cardNumber: "11", parallel: "Base", isAuto: false },
    derived: { sport: "football", cardYear: 2025, setKey: "donruss-optic", cardNumber: "11", parallel: "Base", isAuto: false },
  },
  {
    id: "cardhedge::ch-daily::1774545470922x372355753671853400",
    title: "2025 Donruss Optic Football #242 Base",
    stored: { sport: "football", cardYear: 2025, setKey: "panini-donruss", cardNumber: "242", parallel: "Base", isAuto: false },
    derived: { sport: "football", cardYear: 2025, setKey: "donruss-optic", cardNumber: "242", parallel: "Base", isAuto: false },
  },
  // Topps Cosmic Chrome, stored on the bare flagship — same census.
  {
    id: "cardhedge::ch-daily::1781793338692x628974896361570400",
    title: "2025 Topps Cosmic Chrome Football #BCV-66 Base",
    stored: { sport: "football", cardYear: 2025, setKey: "topps", cardNumber: "BCV-66", parallel: "Base", isAuto: false },
    derived: { sport: "football", cardYear: 2025, setKey: "topps-cosmic-chrome", cardNumber: "BCV-66", parallel: "Base", isAuto: false },
  },
];

describe("R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT — the predicate", () => {
  const r26 = (o: Record<string, unknown> = {}) => K.flagshipSwallowedNamedProductEvidence({
    row: { title: (o.title as string) ?? "2025 Topps Cosmic Chrome Football #122 Base" },
    stored: { setKey: (o.storedKey as string) ?? "topps" },
    derived: { setKey: (o.derivedKey as string) ?? "topps-cosmic-chrome" },
    axes: (o.axes as object) ?? baseAxes(),
    derivedIsNamedProduct: o.derivedIsNamedProduct === undefined ? true : o.derivedIsNamedProduct,
    derivedBacked: o.derivedBacked === undefined ? true : o.derivedBacked,
  });

  it("HAPPY PATH: a Topps Cosmic Chrome sale stored on the bare flagship qualifies", () => {
    const r = r26();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.storedSetKey).toBe("topps");
    expect(r.evidence.derivedSetKey).toBe("topps-cosmic-chrome");
    expect(r.evidence.distinguishingWords).toEqual(["cosmic", "chrome"]);
  });

  it("REFUSED: the derived key is not a declared flagship child", () => {
    const r = r26({ derivedIsNamedProduct: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("derived-not-a-declared-flagship-child");
  });

  it("REFUSED: the title does not state the product's distinguishing words", () => {
    const r = r26({ title: "2025 Topps Football #122 Base" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("title-does-not-state:cosmic+chrome");
  });

  it("REFUSED: the destination is not checklist-backed — never mint from a sale", () => {
    const r = r26({ derivedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("derived-not-checklist-backed");
  });

  it("REFUSED: only setKey may move", () => {
    const r = r26({ axes: baseAxes(["setKey", "cardNumber"]) });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:cardNumber");
  });

  it.each(R26_SAMPLE_ROWS)("real census sample: $title", ({ title, stored, derived }) => {
    const r = K.flagshipSwallowedNamedProductEvidence({
      row: { title },
      stored, derived,
      axes: K.diffAxes(stored, derived),
      derivedIsNamedProduct: true,
      derivedBacked: true,
    });
    expect(r.qualifies).toBe(true);
  });
});

describe("R26 — a RULED-DISTINCT collapse pair stays CONFLICT, untouched by R26 (negative case)", () => {
  it("donruss-elite -> panini-donruss is the REVERSE direction of R26 and is a ruled collapse (2026-09-03)", () => {
    // R26 moves flagship -> named child. The opposite direction — a row
    // ALREADY on the named child whose derivation collapses it to the bare
    // flagship — is exactly what Drew ruled DISTINCT on 2026-09-03
    // (RULED_COLLAPSE_PAIRS: donruss-elite -> panini-donruss, 168,392 rows).
    // The two rulings point opposite directions on the same pair and R26 must
    // never reach this shape at all.
    const stored = { sport: "football", cardYear: 2025, setKey: "donruss-elite", cardNumber: "43", parallel: "Base", isAuto: false };
    const derived = { sport: "football", cardYear: 2025, setKey: "panini-donruss", cardNumber: "43", parallel: "Base", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const res = K.classifyRow({
      row: { title: "2025 Donruss Elite Football #43 Base" },
      stored, derived, axes, checklistBacked: true,
      derivedIsNamedProduct: false, derivedBackedR26: true,
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(",")).toContain("setkey-collapses-distinct-product:donruss-elite->panini-donruss");
  });
});

// ── scope 2: R27-POKEMON-SET-CODE ───────────────────────────────────────────

const R27_SAMPLE_ROWS = [
  {
    id: "cardhedge::ch-daily::1752334992636x617840876051677600",
    title: "2025 Pokemon Scarlet & Violet Destined Rivals #34 Base",
    stored: { sport: "pokemon", cardYear: 2025, setKey: "unknown", cardNumber: "34", parallel: "Base", isAuto: false },
    derived: { sport: "pokemon", cardYear: 2025, setKey: "sv10", cardNumber: "34", parallel: "Base", isAuto: false },
  },
  {
    id: "tca-ebay::267750305033",
    title: "2025 Pokemon Umbreon ex 060/131 Prismatic Evolutions Double Rare Tera NM",
    stored: { sport: "pokemon", cardYear: 2025, setKey: "unknown", cardNumber: "060/131", parallel: "Base", isAuto: false },
    derived: { sport: "pokemon", cardYear: 2025, setKey: "sv08-5", cardNumber: "060/131", parallel: "Base", isAuto: false },
  },
  {
    id: "cardhedge::ch-daily::1762727237963x842170715675721500",
    title: "2025 Pokemon Mega Evolution Phantasmal Flames #13 Base",
    stored: { sport: "pokemon", cardYear: 2025, setKey: "unknown", cardNumber: "13", parallel: "Base", isAuto: false },
    derived: { sport: "pokemon", cardYear: 2025, setKey: "me02", cardNumber: "13", parallel: "Base", isAuto: false },
  },
];

describe("R27-POKEMON-SET-CODE — the predicate", () => {
  const r27 = (o: Record<string, unknown> = {}) => K.pokemonSetCodeEvidence({
    row: { title: (o.title as string) ?? "2025 Pokemon Scarlet & Violet Destined Rivals #34 Base" },
    stored: { setKey: (o.storedKey as string) ?? "unknown" },
    derived: { setKey: (o.derivedKey as string) ?? "sv10" },
    axes: (o.axes as object) ?? baseAxes(),
    derivedIsPokemonSetCode: o.derivedIsPokemonSetCode === undefined ? true : o.derivedIsPokemonSetCode,
    storedIsRivalSetCode: o.storedIsRivalSetCode === undefined ? false : o.storedIsRivalSetCode,
    isAmbiguousCode: o.isAmbiguousCode === undefined ? false : o.isAmbiguousCode,
    languageResolves: o.languageResolves === undefined ? null : o.languageResolves,
    derivedBacked: o.derivedBacked === undefined ? true : o.derivedBacked,
  });

  it("HAPPY PATH: a descriptive stored name resolves to the bare code", () => {
    const r = r27({ storedKey: "scarlet-violet-destined-rivals" });
    expect(r.qualifies).toBe(true);
    expect(r.evidence.pair).toBe("scarlet-violet-destined-rivals->sv10");
  });

  it("HAPPY PATH: stored `unknown` resolves to the bare code", () => {
    const r = r27();
    expect(r.qualifies).toBe(true);
  });

  it("REFUSED: the derived key is not a Pokemon set code", () => {
    const r = r27({ derivedIsPokemonSetCode: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("derived-not-a-pokemon-set-code");
  });

  it("REFUSED: the stored key is ITSELF a rival set code — a rival reading, not staleness", () => {
    const r = r27({ storedKey: "sv09", storedIsRivalSetCode: true });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("stored-is-a-rival-set-code:sv09");
  });

  it("REFUSED: an unbacked destination — never mint from a sale", () => {
    const r = r27({ derivedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-not-checklist-backed");
  });

  it("REFUSED: only setKey may move", () => {
    const r = r27({ axes: baseAxes(["setKey", "cardNumber"]) });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:cardNumber");
  });

  it.each(R27_SAMPLE_ROWS)("real census sample: $title", ({ title, stored, derived }) => {
    const r = K.pokemonSetCodeEvidence({
      row: { title },
      stored, derived,
      axes: K.diffAxes(stored, derived),
      derivedIsPokemonSetCode: true, storedIsRivalSetCode: false,
      isAmbiguousCode: false, languageResolves: null,
      derivedBacked: true,
    });
    expect(r.qualifies).toBe(true);
  });
});

describe("R27 — THE 24-CODE COLLISION CARVE-OUT (negative cases)", () => {
  it("an ambiguous code with NO language flag stays CONFLICT under a NAMED reason (changed:setKey path)", () => {
    // NOTE: avoids the word "Genesis" in the title — it collides with
    // FINISH_FAMILY_TOKENS (a Topps Chrome finish name) and would trip an
    // unrelated finish-witness guard, not the one under test here.
    const stored = { sport: "pokemon", cardYear: 1999, setKey: "some-neo-set", cardNumber: "1", parallel: "Base", isAuto: false };
    const derived = { sport: "pokemon", cardYear: 1999, setKey: "neo1", cardNumber: "1", parallel: "Base", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const res = K.classifyRow({
      row: { title: "1999 Pokemon Neo Set #1 Base" }, stored, derived, axes, checklistBacked: true,
      derivedIsPokemonSetCode: true, pokemonCodeIsAmbiguous: true, pokemonLanguageResolves: null, derivedBackedR27: true,
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons).toContain(K.POKEMON_SET_CODE_LANGUAGE_UNRESOLVED);
  });

  it("an ambiguous code whose language RESOLVES it moves under R27", () => {
    const stored = { sport: "pokemon", cardYear: 1999, setKey: "some-neo-set", cardNumber: "1", parallel: "Base", isAuto: false };
    const derived = { sport: "pokemon", cardYear: 1999, setKey: "neo1", cardNumber: "1", parallel: "Base", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const res = K.classifyRow({
      row: { title: "1999 Pokemon Neo (EN) #1 Base" }, stored, derived, axes, checklistBacked: true,
      derivedIsPokemonSetCode: true, pokemonCodeIsAmbiguous: true, pokemonLanguageResolves: true, derivedBackedR27: true,
    });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe(K.POKEMON_SET_CODE);
    expect(res.writable).toBe(true);
  });

  it("GUARD 10: an unresolved ambiguous code reaches the pool through the ORDINARY filled:setKey arm too — this is the gap the guard closes", () => {
    // `unknown` is GENERIC_SETKEYS, so diffAxes treats it as BLANK: filling it
    // is `filled:setKey`, the ordinary improve arm, NOT `changed:setKey` —
    // R27's own CONFLICT-path evidence function is never consulted here.
    const stored = { sport: "pokemon", cardYear: 1999, setKey: "unknown", cardNumber: "1", parallel: "Base", isAuto: false };
    const derived = { sport: "pokemon", cardYear: 1999, setKey: "neo1", cardNumber: "1", parallel: "Base", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    expect(axes.filled).toContain("setKey");
    expect(axes.changed).not.toContain("setKey");
    const res = K.classifyRow({
      row: { title: "1999 Pokemon Neo #1 Base" }, stored, derived, axes, checklistBacked: true,
      derivedIsPokemonSetCode: true, pokemonCodeIsAmbiguous: true, pokemonLanguageResolves: null, derivedBackedR27: true,
    });
    // Still classifies IMPROVE (a match proves nothing about the CLASS), but
    // GUARD 10 refuses the WRITE.
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(",")).toContain("improve-pokemon-ambiguous-code-unresolved:neo1");
  });

  it("a NON-ambiguous code via the ordinary filled:setKey arm is unaffected by GUARD 10", () => {
    const stored = { sport: "pokemon", cardYear: 2025, setKey: "unknown", cardNumber: "34", parallel: "Base", isAuto: false };
    const derived = { sport: "pokemon", cardYear: 2025, setKey: "sv10", cardNumber: "34", parallel: "Base", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const res = K.classifyRow({
      row: { title: "x" }, stored, derived, axes, checklistBacked: true,
      derivedIsPokemonSetCode: true, pokemonCodeIsAmbiguous: false, derivedBackedR27: true,
    });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(true);
  });
});

// ── scope 3: R28-FINISH-IS-A-PARALLEL ───────────────────────────────────────

describe("R28-FINISH-IS-A-PARALLEL — the predicate", () => {
  const r28 = (o: Record<string, unknown> = {}) => K.finishIsAParallelEvidence({
    row: { title: (o.title as string) ?? "2025 Topps Chrome Football #50 Logofractor" },
    stored: { setKey: (o.storedKey as string) ?? "topps-chrome-logofractor" },
    derived: { setKey: (o.derivedKey as string) ?? "topps-chrome" },
    axes: (o.axes as object) ?? { same: [], filled: ["parallel"], dropped: [], changed: ["setKey"] },
    checklistListsAsParallel: o.checklistListsAsParallel === undefined ? true : o.checklistListsAsParallel,
    derivedBacked: o.derivedBacked === undefined ? true : o.derivedBacked,
  });

  it("HAPPY PATH: a finish word minted as a setKey (topps-chrome-logofractor)", () => {
    const r = r28();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.finishWord).toBe("logofractor");
    expect(r.evidence.pair).toBe("topps-chrome-logofractor->topps-chrome:logofractor");
  });

  /**
   * REAL rows from the 2026-09-13 census sample artifacts
   * (census-slot-{0..9}.json): `topps-chrome-logofractor`, stored on cardhedge
   * ingests, classified CONFLICT on main with `changed:setKey`. "Logofractor"
   * is a CORE_FINISH_TOKENS word and the derived (topps-chrome, Logofractor)
   * pair is checklist-backed -- exactly the shape R28 rules IMPROVE, and one
   * of the 16 genuine positives the 2026-09-13 measurement found.
   */
  it("real census sample: 2024 Topps Chrome Logofractor Baseball #RCA-SF Blue", () => {
    const stored = { sport: "baseball", cardYear: 2024, setKey: "topps-chrome-logofractor", cardNumber: "RCA-SF", parallel: "Blue", isAuto: false };
    const derived = { sport: "baseball", cardYear: 2024, setKey: "topps-chrome", cardNumber: "RCA-SF", parallel: "Logofractor", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const r = K.finishIsAParallelEvidence({
      row: { title: "2024 Topps Chrome Logofractor Baseball #RCA-SF Blue" },
      stored, derived, axes,
      checklistListsAsParallel: true, derivedBacked: true,
    });
    expect(r.qualifies).toBe(true);
    expect(r.evidence.finishWord).toBe("logofractor");
  });

  it("REFUSED: not a suffix of the derived key at all", () => {
    const r = r28({ storedKey: "panini-prizm", derivedKey: "topps-chrome" });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("not-a-suffix-of-the-derived-key");
  });

  it("REFUSED: the suffix is not a known finish word", () => {
    const r = r28({ storedKey: "panini-prizm-deca", derivedKey: "panini-prizm" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("suffix-not-a-known-finish:deca");
  });

  it("REFUSED: the checklist does not list the word as a parallel of the derived product", () => {
    const r = r28({ checklistListsAsParallel: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("checklist-does-not-list-parallel:logofractor");
  });

  it("REFUSED: an unbacked destination", () => {
    const r = r28({ derivedBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-not-checklist-backed");
  });

  it("REFUSED: an axis other than setKey/parallel moved", () => {
    const r = r28({ axes: { same: [], filled: ["parallel"], dropped: [], changed: ["setKey", "cardNumber"] } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:cardNumber");
  });

  // ── THE MEASURED TRAP: topps-chrome-platinum ──────────────────────────────

  it("REFUSED: topps-chrome-platinum is a DECLARED DISTINCT PRODUCT, not a finish (the measured trap)", () => {
    // 15 of the 262 syntactic R28-shaped matches in the 2026-09-13 census
    // sample are this exact key. "platinum" is coincidentally a
    // FINISH_COLOR_TOKENS word AND the tail of a product ruled distinct from
    // topps-chrome on 2026-09-03. Without this guard, every one of those rows
    // (and the ~229,345-row population RULED_COLLAPSE_PAIRS measures for this
    // exact pair) would have been a false positive.
    expect(K.DISTINCT_PRODUCT_SETKEYS).toContain("topps-chrome-platinum");
    const r = r28({ storedKey: "topps-chrome-platinum", derivedKey: "topps-chrome", title: "2023 Topps Chrome Platinum Baseball #176 Refractor" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("stored-is-a-declared-distinct-product:topps-chrome-platinum");
    expect(r.failed.join(",")).toContain("ruled-collapse-pair:topps-chrome-platinum->topps-chrome");
  });

  it("REFUSED end to end: the real census row classifies CONFLICT, not IMPROVE", () => {
    const stored = { sport: "baseball", cardYear: 2023, setKey: "topps-chrome-platinum", cardNumber: "176", parallel: "Refractor", isAuto: false };
    const derived = { sport: "baseball", cardYear: 2023, setKey: "topps-chrome", cardNumber: "176", parallel: "Refractor", isAuto: false };
    const axes = K.diffAxes(stored, derived);
    const res = K.classifyRow({
      row: { title: "2023 Topps Chrome Platinum Baseball #176 Refractor" }, stored, derived, axes, checklistBacked: true,
      checklistListsFinishAsParallel: true, derivedBackedR28: true,
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.subclass).not.toBe(K.FINISH_IS_A_PARALLEL);
  });

  it("REFUSED: bowman-best-university is ALSO a declared distinct product (same trap, different word)", () => {
    expect(K.DISTINCT_PRODUCT_SETKEYS).toContain("bowman-best-university");
    const r = r28({ storedKey: "bowman-best-university", derivedKey: "bowman", title: "2025 Bowman Best University Football #BOA-TTA Base" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("stored-is-a-declared-distinct-product:bowman-best-university");
  });

  it("REFUSED: panini-prizm-deca is a real undeclared product whose tail is not finish vocabulary", () => {
    // Measured in the same census sample: "Deca" names Panini Prizm Deca, a
    // real 2024 football product — not a finish word at all.
    const r = r28({ storedKey: "panini-prizm-deca", derivedKey: "panini-prizm", title: "2024 Panini Prizm Deca Football #24 Blue" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("suffix-not-a-known-finish:deca");
  });

  it("REFUSED: topps-midnight is the same trap — 'midnight' is not finish vocabulary either", () => {
    const r = r28({ storedKey: "topps-midnight", derivedKey: "topps", title: "2024 Topps Midnight - /35 Spencer Rattler #67" });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("suffix-not-a-known-finish:midnight");
  });
});

// ── the scope machinery ─────────────────────────────────────────────────────

describe("the three R26/R27/R28 scopes are armed only BY NAME", () => {
  it.each([
    ["flagship-swallowed-named-product", "FLAGSHIP_SWALLOWED_NAMED_PRODUCT"],
    ["r26", "FLAGSHIP_SWALLOWED_NAMED_PRODUCT"],
    ["pokemon-set-code", "POKEMON_SET_CODE"],
    ["r27", "POKEMON_SET_CODE"],
    ["finish-is-a-parallel", "FINISH_IS_A_PARALLEL"],
    ["r28", "FINISH_IS_A_PARALLEL"],
  ])("scope %j arms exactly %s", (scope, key) => {
    const parsed = K.parseApplyScope(scope);
    expect(parsed.ok).toBe(true);
    expect([...parsed.classes]).toEqual([K[key]]);
  });

  it("an unrecognised scope still refuses, and NAMES the new options", () => {
    const parsed = K.parseApplyScope("refractor");
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("flagship-swallowed-named-product");
    expect(parsed.reason).toContain("pokemon-set-code");
    expect(parsed.reason).toContain("finish-is-a-parallel");
  });

  it("applyKindOf reads the SUBCLASS first, so scope=improve never arms the new scopes", () => {
    for (const [sub, scopeName] of [
      [K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT, "flagship-swallowed-named-product"],
      [K.POKEMON_SET_CODE, "pokemon-set-code"],
      [K.FINISH_IS_A_PARALLEL, "finish-is-a-parallel"],
    ]) {
      const res = { klass: K.IMPROVE, subclass: sub, writable: true };
      expect(K.applyKindOf(res)).toBe(sub);
      expect(K.writableUnderScope(res, K.parseApplyScope("improve").classes)).toBe(false);
      expect(K.writableUnderScope(res, K.parseApplyScope("both").classes)).toBe(false);
      expect(K.writableUnderScope(res, K.parseApplyScope(scopeName as string).classes)).toBe(true);
    }
  });

  it("an ordinary IMPROVE row is still armed by scope=improve — nothing regressed", () => {
    const res = { klass: K.IMPROVE, writable: true };
    expect(K.applyKindOf(res)).toBe(K.IMPROVE);
    expect(K.writableUnderScope(res, K.parseApplyScope("improve").classes)).toBe(true);
  });

  it("NO NEW WORKFLOW INPUT: the scopes ride the existing `scope` input", () => {
    const wf = readFileSync(new URL("../../.github/workflows/backfill-runner.yml", import.meta.url), "utf8");
    const inputs = wf.slice(wf.indexOf("workflow_dispatch:"), wf.indexOf("jobs:"));
    expect(inputs).not.toContain("r26_flagship");
    expect(inputs).not.toContain("ruled_scope_20260913");
    expect(inputs).toContain("scope:");
  });
});

describe("the reconcile covers every apply kind (R26/R27/R28 included)", () => {
  it("APPLY_KINDS carries all three new kinds", () => {
    expect(RUNNER_SRC).toContain("K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT, K.POKEMON_SET_CODE, K.FINISH_IS_A_PARALLEL,");
  });

  it("every ruled subclass reports its shape in the banner, not just a count", () => {
    for (const s of ["R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT", "R27-POKEMON-SET-CODE", "R28-FINISH-IS-A-PARALLEL"]) {
      expect(RUNNER_SRC).toContain(s);
    }
  });

  it("the classifier documents the measured false-positive trap this ruling closes", () => {
    expect(CLASSIFIER_SRC).toContain("topps-chrome-platinum");
    expect(CLASSIFIER_SRC).toMatch(/246 of which MUST be refused|246-row false-positive/);
  });
});

// ── negative case: SPORT-FROM-PRODUCT's own multi-sport refusal is untouched ─

describe("R26/R27/R28 do not disturb the 2026-09-06 trio's own gates", () => {
  it("SPORT-FROM-PRODUCT still refuses Topps Now by name — R26 shares no code path with it", () => {
    const r = K.sportFromProductEvidence({
      row: { title: "Victor Wembanyama 2024-25 Topps Now #7 50 Point Game" },
      stored: { sport: "basketball", setKey: "topps-now" },
      derived: { sport: "baseball", setKey: "topps-now" },
      axes: baseAxes(["sport"]),
      productSport: "baseball", destBacked: true,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("multi-sport-product:topps-now");
  });
});
