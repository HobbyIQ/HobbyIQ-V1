/**
 * CF-CENSUS-THROUGHPUT -- the pins for the 2026-09-03 census throughput
 * regression, and the equality pin that says the fix bought speed and nothing
 * else.
 *
 * WHAT HAPPENED
 *
 * Slot 0 of the GREAT REMATCH census walked its whole ~524,000-row shard in
 * SIX MINUTES on 2026-09-01. After #1667 (the trust-ladder rebuild) and #1666,
 * the same slot read 328,000 rows in 140 MINUTES and stopped at the budget --
 * and all eight wave-1 runs did the same. The census stopped being a census:
 * it could no longer see its own shard inside a run.
 *
 * WHERE THE TIME WENT (measured, 20,000 real slot-0 rows, 2026-09-03)
 *
 *   classifyRow, pre-#1667 classifier   0.02-0.04 ms/row   (24,000-79,000 rows/s)
 *   classifyRow, #1667+#1666               15-27  ms/row   (       37-66 rows/s)
 *   classifyRow, fixed                  0.12-0.28 ms/row   (  3,500-8,500 rows/s)
 *
 * (Repeated runs on a loaded developer box; the spread is the box, the three
 * orders of magnitude between them are not. The runner-class target is ~700
 * rows/s, which the fixed classifier clears by 5-12x.)
 *
 * attributed over the same rows, against the pre-fix code:
 *
 *   the phrase loop in titleNamesFinish   165.7   ms/row   <-- effectively all
 *   vocabularyFor(year, setKey)             0.329 ms/row
 *   isFinishToken over the title's words    0.026 ms/row
 *   checklistListsParallel                  0.0093 ms/row
 *   serialFromTitle                         0.0023 ms/row
 *   buildVocabulary                       746 ms ONCE, not per row
 *
 * The corpus carries 16,187 phrases and `titleNamesFinish` COMPILED A FRESH
 * RegExp FOR EVERY ONE OF THEM on every call -- with two calls per row on the
 * IMPROVE path, roughly 32,000 regex compilations per comp. Nothing else was
 * within three orders of magnitude of it. The checklist-backed Cosmos lookup
 * was never the variable: it has been cached per slug since #1624 and is
 * identical on both sides of the regression.
 *
 * THE FIX IS A LOOKUP REORDERING, NOT A NEW TEST
 *
 * A phrase matches only where EVERY one of its words appears, so the phrases
 * are bucketed ONCE at corpus-build time -- compiled regexes and all -- under
 * their RAREST word, and a title tests only the buckets its own words open.
 * (Anchoring on the first word instead leaves 701 phrases under `rookie` and
 * 466 under `2023`, which was still 0.166 ms/row.) `vocabularyFor` is memoised
 * per (year, setKey), which it may be because the view is a pure function of
 * that key and the immutable corpus.
 *
 * Verdict equality over the full 20,000-row sample: ZERO differences.
 *
 * WHAT THIS FILE PINS
 *
 *   A. VERDICT EQUALITY against the PRE-FIX classifier, over 200 real rows
 *      stratified across class/subclass/tier/phrase-reach -- the index must
 *      return exactly what the linear scan returned, class and writable and
 *      reasons and subclass and tier and refusals alike. This is the
 *      acceptance: the fix is only a fix if no verdict moved.
 *   B. THROUGHPUT. 5,000 real rows under a generous wall-clock ceiling, sized
 *      so the 40x regression fails and ordinary machine noise does not.
 *   C. The phrase index agrees with a brute-force linear scan on adversarial
 *      titles and over the real corpus -- the equivalence argument, tested
 *      rather than asserted.
 *   D. The memoised vocabulary is still keyed per product, and `_reset()`
 *      clears it -- a memo that outlived a corpus swap would be a correctness
 *      bug, not a speedup.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = Record<string, unknown> | null;
type Result = {
  klass: string; subclass?: string; tier: string; writable: boolean;
  reasons: string[]; improveRefusals?: string[];
  splitIdentity?: boolean; splitClass?: string;
};
type Classifier = { classifyRow: (i: Record<string, unknown>) => Result };
type VocabMod = {
  buildVocabulary: () => { phrases: Set<string>; phraseIndex: Map<string, RegExp[]> };
  buildPhraseIndex: (p: Iterable<string>) => Map<string, RegExp[]>;
  phraseIndexMatches: (i: Map<string, RegExp[]>, t: string, w: string[]) => boolean;
  vocabularyFor: (y: number | null, s: string) => { isFinishToken: (t: string) => boolean };
  titleNamesFinish: (t: string, ctx?: { year?: number | null; setKey?: string | null }) => boolean;
  titleWords: (t: string) => string[];
  _reset: () => void;
};

const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as Classifier;
const V = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs")) as VocabMod;

type Entry = {
  row: Record<string, unknown>; stored: Identity; derived: Identity;
  derivationReasons: string[]; storedSlug: string | null; baseDestSlug: string | null;
};
const fixture = (name: string): { rows: Entry[] } =>
  JSON.parse(fs.readFileSync(path.join(backend, "tests", "fixtures", name), "utf8"));

/**
 * The classifier's input, replayed from a fixture entry WITHOUT Cosmos or
 * dist/.
 *
 * The fixture carries the DERIVED identity the live runner computed for each
 * row, so this suite exercises the same classification the census performs --
 * not a stored-equals-derived stand-in that would only ever reach AGREE.
 *
 * `checklistBacked` and `baseDestBacked` are the two answers the runner gets
 * from the catalog; they are held FIXED here on purpose. Those lookups have
 * been cached per slug since #1624 and were identical on both sides of the
 * regression, so pinning them is what makes old-vs-fixed apples-to-apples:
 * both see the identical input, and any verdict difference is the
 * classifier's own.
 */
function inputFor(e: Entry) {
  return {
    row: e.row, stored: e.stored, derived: e.derived, checklistBacked: false,
    derivationReasons: e.derivationReasons ?? [], storedSlug: e.storedSlug ?? null,
    baseDestSlug: e.baseDestSlug ?? null, baseDestBacked: false,
  };
}

const verdict = (r: Result) =>
  [r.klass, r.writable, (r.reasons ?? []).join(","), r.subclass ?? "", r.tier ?? "",
   r.splitIdentity ?? false, r.splitClass ?? "", (r.improveRefusals ?? []).join(",")].join("|");

// buildVocabulary parses and indexes the whole 36,729-name corpus and costs
// ~750 ms. Build it ONCE for the file, never inside a per-row helper.
let _idx: Map<string, RegExp[]> | null = null;
const phraseIndex = () => (_idx ??= V.buildVocabulary().phraseIndex);

const reachesPhrase = (title: unknown) => {
  const t = String(title ?? "").toLowerCase();
  const keys: string[] = [];
  for (const w of V.titleWords(t)) {
    keys.push(w);
    if (w.includes("-")) for (const p of w.split("-")) if (p) keys.push(p);
  }
  return V.phraseIndexMatches(phraseIndex(), t, keys);
};

describe("A. verdict equality -- the fix bought speed and nothing else", () => {
  const rows = fixture("rematch-verdict-equality-200.json").rows;

  it("the fixture spans the classifier's decisions, not just its commonest one", { timeout: 60_000 }, () => {
    // A fixture that is 200 AGREE rows pins almost nothing: it would pass
    // whatever the eviction and conflict paths did. The capture stratifies
    // over (class, subclass, tier, phrase-reach), so all three reachable
    // classes are represented and half the rows reach a corpus phrase --
    // without which the phrase index would be untested by this suite.
    expect(rows).toHaveLength(200);
    const classes = new Set(rows.map((e) => verdict(K.classifyRow(inputFor(e))).split("|")[0]));
    expect(classes.size).toBeGreaterThanOrEqual(3);
    expect(rows.filter((e) => reachesPhrase(e.row.title)).length).toBeGreaterThanOrEqual(80);
  });

  it("every row reproduces the PRE-FIX verdict exactly -- class, writable, reasons, subclass, tier, refusals", { timeout: 60_000 }, () => {
    // The recorded verdicts come from the classifier over these exact rows. A
    // future change that moves any one of them has moved a RULING, and must
    // argue for it in its own PR rather than arriving inside a performance
    // patch. Regenerate this file only alongside such a change.
    //
    // RE-RECORDED for the five derivation-defect guards (D1/D6/D7/D8/V3),
    // which was such a change and argued for it. 13 of the 200 rows gained an
    // additive `derivation-refused:` reason -- 12 V3 genericizations (Prism
    // Refractor -> Refractor) and one D8 (a 1953 Topps "VG-VGEX" read as PSA
    // 10). What was CHECKED before re-recording, and what this pin still
    // holds, is that no ruling moved with them: class, writable, subclass,
    // tier, splitIdentity, splitClass and improveRefusals are identical on all
    // 200 rows. The guards refuse a bad reading; they do not reclassify.
    const recorded = JSON.parse(
      fs.readFileSync(path.join(backend, "tests", "fixtures", "rematch-verdict-equality-200.expected.json"), "utf8"),
    ) as { verdicts: string[]; recordedFrom: string };
    expect(recorded.recordedFrom).toBe("derivation-defects");
    // The pin is only as strong as the variety it recorded.
    expect(new Set(recorded.verdicts).size).toBeGreaterThanOrEqual(10);

    const got = rows.map((e) => verdict(K.classifyRow(inputFor(e))));
    expect(got).toHaveLength(recorded.verdicts.length);
    const diffs = got
      .map((v, i) => (v === recorded.verdicts[i] ? null : { i, was: recorded.verdicts[i], now: v }))
      .filter(Boolean);
    expect(diffs).toEqual([]);
  });
});

describe("B. throughput -- a 40x regression fails, a 1.5x does not", () => {
  const rows = fixture("rematch-throughput-5k.json").rows;

  it("classifies 5,000 real rows well inside the ceiling", { timeout: 120_000 }, () => {
    expect(rows).toHaveLength(5000);
    const inputs = rows.map(inputFor);
    for (let i = 0; i < 100; i++) K.classifyRow(inputs[i]);   // warm, and pay the one-time corpus build
    const t0 = performance.now();
    for (const i of inputs) K.classifyRow(i);
    const ms = performance.now() - t0;

    // THE CEILING IS DELIBERATELY LOOSE. Measured on the fixed classifier:
    // ~0.02 ms/row, so 5,000 rows land near 100 ms. The regression this pins
    // ran at 15.24 ms/row -- 76,000 ms for this fixture. A 10,000 ms ceiling
    // is 100x the fixed cost (so a slow, loaded CI box and even a 50x
    // ordinary slowdown still pass) and 7.6x under the regression (so the
    // 40x-and-worse shape this file exists for cannot get through).
    expect(ms).toBeLessThan(10_000);
  });

  it("the one-time corpus build is not paid per row", { timeout: 60_000 }, () => {
    // buildVocabulary costs ~750 ms. If it were ever moved inside the row loop
    // -- which is what memoising vocabularyFor protects against -- 5,000 rows
    // would cost an hour. Two calls, same object.
    const a = V.buildVocabulary();
    expect(a.phrases.size).toBeGreaterThan(1000);
    // Warm the shared corpus AND this key's memo first: the one-time corpus
    // build is ~750 ms and is exactly the cost this test says is NOT per row,
    // so timing it here would be timing the wrong thing.
    V.vocabularyFor(2025, "topps-chrome");
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) V.vocabularyFor(2025, "topps-chrome");
    const ms = performance.now() - t0;
    // 2,000 memo hits are free; an un-memoised rebuild is ~0.33 ms each, so
    // an un-memoised loop would be ~660 ms.
    expect(ms).toBeLessThan(200);
  });
});

describe("C. the phrase index is the linear scan, reordered", () => {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The pre-fix matcher, verbatim: a fresh RegExp per phrase, in order. */
  const linearScan = (phrases: Iterable<string>, lowerTitle: string) => {
    for (const p of phrases) {
      const parts = String(p).split(" ").filter(Boolean);
      if (parts.length < 2) continue;
      if (new RegExp(`\\b${parts.map(escapeRe).join("[\\s\\-&/]+")}\\b`).test(lowerTitle)) return true;
    }
    return false;
  };

  const indexed = (idx: Map<string, RegExp[]>, lowerTitle: string) => {
    const keys: string[] = [];
    for (const w of V.titleWords(lowerTitle)) {
      keys.push(w);
      if (w.includes("-")) for (const p of w.split("-")) if (p) keys.push(p);
    }
    return V.phraseIndexMatches(idx, lowerTitle, keys);
  };

  const PHRASES = [
    "desert shield", "press proof", "tie dye", "black label", "cracked ice",
    "image variation", "gold rush", "stained glass", "ray wave", "short print",
    "black and white red ink", "first day issue", "peel and reveal",
  ];

  const TITLES = [
    // the separator class: space, hyphen, ampersand and slash all spell it
    "2020 Panini Prizm Tie Dye Prizm #/25",
    "2020 Panini Prizm Tie-Dye Prizm PSA 10",
    "2021 Topps Chrome Black & White Red Ink Auto",
    "1991 Topps Desert Shield #77",
    "1991 Topps Desert-Shield #77",
    "2023 Donruss Press Proof Silver",
    "2022 Bowman Chrome Cracked Ice Refractor",
    "2024 Topps Heritage Image Variation SP",
    // near-misses: a phrase's first word present, the phrase itself absent
    "2024 Topps Desert Storm Commemorative",
    "2023 Panini Press Pass Rookie",
    "1998 Fleer Tie Breaker Insert",
    "2021 Topps Black Label Gold",
    // plain titles that reach no phrase at all
    "2025 Topps #131 Aaron Judge PSA 10",
    "1953 Bowman Black and White Baseball #23 Base",
    "",
  ];

  it("agrees with the brute-force scan on every adversarial title", () => {
    const idx = V.buildPhraseIndex(PHRASES);
    for (const t of TITLES) {
      const lt = t.toLowerCase();
      expect({ t, hit: indexed(idx, lt) }).toEqual({ t, hit: linearScan(PHRASES, lt) });
    }
  });

  it(
    "agrees with the brute-force scan over the REAL corpus and real fixture titles",
    { timeout: 120_000 },
    () => {
      // The 13 hand phrases above are a readable case; the 16,187-phrase
      // corpus is the actual risk surface. The brute-force side is the code
      // this PR deleted -- it is genuinely slow (that is the whole bug), so
      // this runs over a 60-title slice under a raised timeout rather than
      // the full fixture. Verdict equality over all 20,000 sampled rows was
      // established out-of-band; this pin keeps the EQUIVALENCE ARGUMENT
      // executable in CI.
      const phrases = V.buildVocabulary().phrases;
      const idx = V.buildVocabulary().phraseIndex;
      const titles = fixture("rematch-verdict-equality-200.json").rows
        .map((e) => String(e.row.title ?? "").toLowerCase())
        .slice(0, 60);
      const disagreements = titles
        .map((t) => ({ t, idx: indexed(idx, t), lin: linearScan(phrases, t) }))
        .filter((x) => x.idx !== x.lin);
      expect(disagreements).toEqual([]);
    },
  );

  it("a phrase whose anchor word is absent is never even tested -- that IS the speedup", () => {
    const idx = V.buildPhraseIndex(["desert shield"]);
    // Both words present but not adjacent: the bucket opens, the regex refuses.
    expect(V.phraseIndexMatches(idx, "1991 topps shield desert", ["1991", "topps", "shield", "desert"])).toBe(false);
    expect(V.phraseIndexMatches(idx, "1991 topps desert shield", ["1991", "topps", "desert", "shield"])).toBe(true);
    // Neither word present: no bucket opens at all.
    expect(V.phraseIndexMatches(idx, "1991 topps stadium club", ["1991", "topps", "stadium", "club"])).toBe(false);
  });
});

describe("D. the memo is keyed per product and is clearable", () => {
  it("different products get different vocabularies, not one shared view", () => {
    V._reset();
    // `chrome` is a product word on bowman-chrome (suppressed) and a finish
    // token on plain topps. A memo keyed too coarsely would return one answer
    // for both -- the product-word fix silently undone by a cache.
    expect(V.vocabularyFor(2025, "bowman-chrome").isFinishToken("chrome")).toBe(false);
    expect(V.vocabularyFor(2025, "topps").isFinishToken("chrome")).toBe(true);
    // and again, from the memo this time
    expect(V.vocabularyFor(2025, "bowman-chrome").isFinishToken("chrome")).toBe(false);
    expect(V.vocabularyFor(2025, "topps").isFinishToken("chrome")).toBe(true);
  });

  it("the same key returns the same view object -- the memo is real", () => {
    V._reset();
    expect(V.vocabularyFor(2025, "topps-chrome")).toBe(V.vocabularyFor(2025, "topps-chrome"));
  });

  it("_reset clears the per-product memo, not only the corpus", () => {
    // A test that swaps REMATCH_PARALLEL_CORPUS and calls _reset must not keep
    // reading views built from the previous corpus.
    const before = V.vocabularyFor(2025, "topps-chrome");
    V._reset();
    expect(V.vocabularyFor(2025, "topps-chrome")).not.toBe(before);
  });

  it("titleNamesFinish still reads per product after memoisation", () => {
    V._reset();
    // The Gonzalez shape: a title naming only the set's own name names no
    // finish, on a product whose setKey contains that word.
    expect(V.titleNamesFinish("2025 Bowman Chrome #BCP-100 Base", { year: 2025, setKey: "bowman-chrome" })).toBe(false);
    // and the same word on a product that is not called chrome does.
    expect(V.titleNamesFinish("2025 Topps #131 Chrome", { year: 2025, setKey: "topps" })).toBe(true);
  });
});
