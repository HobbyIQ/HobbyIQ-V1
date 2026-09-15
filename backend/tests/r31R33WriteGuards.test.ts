/**
 * R31 AND R33 WOULD WRITE WRONG VALUES — THE THREE GUARDS
 * (slot-3 census, run 34958820305, artifact `collect-r3x/flat/census-slot-3.json`).
 *
 * Both scopes are APPLY lanes: R31 fills a blank parallel, R33 overwrites a
 * card number. A wrong value in either is not a missed improvement, it is a
 * real sale filed at an address that names a different card — the pool split
 * `feedback_one_card_one_row_one_pool` rules on. So both are held to
 * "absent beats wrong": every guard below REFUSES rather than guessing, and a
 * refusal leaves the row exactly where it already is.
 *
 * EVERY TITLE HERE IS A REAL POOL ROW, taken verbatim from that artifact's
 * `scopeSamples.r31.move` / `scopeSamples.r33.move`, and every "before" was
 * reproduced against the live classifier on `ae7cbf9b` before the guards were
 * written.
 *
 * -- WHAT THE ARTIFACT SAID vs WHAT IS STILL TRUE ---------------------------
 *
 * The artifact is `measuredAt: 2026-09-01`, and the checklist vocabulary has
 * moved since. Re-measuring every sample against the shipped corpus BEFORE
 * writing a line of guard changed what needed building, and the difference is
 * recorded here so the next reader does not re-derive the original theory:
 *
 *   ALREADY FIXED (17 of the 23 parallel-fill samples). The insert names the
 *   brief names — "Passing Grade", "Light It Up", "My House!", "Captain in
 *   Charge", "Downtown Duo" — and the truncated "purple" are ALL already
 *   refused today by the existing token gate. No new guard was needed and none
 *   was written for them; the controls below pin that they stay refused.
 *
 *   "Trophy Collection Bronze" IS A REAL RUNG on panini-illusions 2024, listed
 *   verbatim beside its 20 siblings. The brief cites it as an insert leaking
 *   through; the corpus says otherwise, so it is pinned as a legitimate WRITE.
 *   Guarding it would have broken a correct fill.
 *
 *   STILL BROKEN, and the reason T3b exists: the token gate is
 *   `toks.every(inOwn)` — every WORD appears somewhere among the product's rung
 *   names, in any names, in any order. "x-fractor" passes that on topps-chrome
 *   2024 while the only names there are `X-Fractor 1/1 Monster` and
 *   `X-Fractor 1/2 Mega`. That is a string no card carries.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));
const VOCAB = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs"));

/** R31's evidence, with every leg satisfied except the one under test. */
function r31({ title, parallel, listsToken, isRungPhrase = null, sibling = null }: {
  title: string; parallel: string; listsToken: boolean;
  isRungPhrase?: boolean | null; sibling?: boolean | null;
}) {
  return K.titleFillsTheBlankEvidence({
    row: { title },
    stored: { parallel: "base", printRun: null },
    derived: { parallel, printRun: null },
    axes: { filled: ["parallel"], changed: [], dropped: [] },
    titleParallel: parallel,
    checklistListsTitleParallel: listsToken,
    titleParallelIsARungPhrase: isRungPhrase,
    titleNamesSiblingProduct: sibling,
    titleSerial: null,
    derivedBacked: true,
  });
}

/** R33's evidence, with every leg satisfied except the one under test. */
function r33(title: string, titleNumber: string) {
  return K.titleCardNumberWinsEvidence({
    row: { title },
    stored: { cardNumber: "zzz-stored-differs" },
    derived: { cardNumber: titleNumber },
    axes: { changed: ["cardNumber"], dropped: [] },
    titleNumberIsChecklistRow: true,
    derivedBacked: true,
  });
}

// ---------------------------------------------------------------------------
// GUARD 1 — A RUNG IS A NAME, NOT A BAG OF TOKENS (T3b)
// ---------------------------------------------------------------------------
describe("R31 fills only a phrase the product's ladder actually names", () => {
  it("the token gate really does pass these — the defect is real, not hypothetical", () => {
    // If this ever goes false the guard below is dead code and the test that
    // follows would pass for the wrong reason.
    expect(VOCAB.checklistListsParallel("x-fractor", 2024, "topps-chrome")).toBe(true);
    expect(VOCAB.checklistListsRungPhrase("x-fractor", 2024, "topps-chrome")).toBe(false);
  });

  it("refuses x-fractor on topps-chrome 2024 — no such rung exists", () => {
    const r = r31({
      title: "2024 Topps Chrome Rookies X-Fractor Caleb Williams #202 Rookie RC",
      parallel: "x-fractor", listsToken: true, isRungPhrase: false,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("not-a-rung-in-product:x-fractor");
  });

  it("ALLOWS a real rung the pool spells differently", () => {
    // `Snakeskin` is `Snakeskin Prizms` on the checklist and `Black and White
    // Checker` is `Prizm Black and White Checker` — same card, and the write
    // is correct. Refusing these would trade a leak for a regression; the
    // SPELLING is a separate concern from whether the rung exists.
    expect(VOCAB.checklistRungPhrase("snakeskin", 2024, "panini-prizm")).toBe("snakeskin prizms");
    expect(VOCAB.checklistRungPhrase("black and white checker", 2024, "panini-prizm"))
      .toBe("prizm black and white checker");
    for (const p of ["snakeskin", "black and white checker"]) {
      expect(r31({ title: "t", parallel: p, listsToken: true, isRungPhrase: true }).qualifies).toBe(true);
    }
  });

  it("ALLOWS Trophy Collection Bronze — the corpus lists it verbatim", () => {
    // The brief cites this as an insert leaking through. The shipped corpus
    // lists it beside its 20 siblings, so it is a legitimate fill and a guard
    // that refused it would be the defect.
    expect(VOCAB.checklistRungPhrase("trophy collection bronze", 2024, "panini-illusions"))
      .toBe("trophy collection bronze");
    expect(r31({
      title: "#'d /75 Panini Illusions - Patrick Mahomes II #42 Trophy Collection Bronze 2024",
      parallel: "trophy collection bronze", listsToken: true, isRungPhrase: true,
    }).qualifies).toBe(true);
  });

  it("an unasked caller keeps today's behaviour — the leg only narrows", () => {
    // `null` means the driver did not compute the phrase answer. The leg must
    // not refuse on absence, or every older caller starts refusing everything.
    expect(r31({ title: "t", parallel: "snakeskin", listsToken: true, isRungPhrase: null }).qualifies).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GUARD 2 — A FILL PRESUMES THE RIGHT ADDRESS (T5a)
// ---------------------------------------------------------------------------
describe("R31 refuses when the title names a sibling product", () => {
  it("refuses, naming the leg", () => {
    const r = r31({
      title: "2024 Panini Donruss Optic - Dexter Lawrence #151 White Sparkle Prizm",
      parallel: "white sparkle", listsToken: true, isRungPhrase: true, sibling: true,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-sibling-product");
  });

  it("does not refuse when the title names the same product, or a parent", () => {
    // A title naming the PARENT ("Donruss" on a donruss-optic row) is the same
    // family line, less specific — the ladder still belongs to the row. Only a
    // genuine fork is refused, which is what `null` encodes here.
    expect(r31({ title: "t", parallel: "snakeskin", listsToken: true, isRungPhrase: true, sibling: null }).qualifies).toBe(true);
    expect(r31({ title: "t", parallel: "snakeskin", listsToken: true, isRungPhrase: true, sibling: false }).qualifies).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE ROWS THE EXISTING TOKEN GATE ALREADY REFUSES
// ---------------------------------------------------------------------------
describe("insert names and truncated phrases stay refused", () => {
  it.each([
    ["passing grade", "panini-donruss"],
    ["light it up", "panini-donruss"],
    ["my house", "panini-donruss"],
    ["captain in charge", "panini-donruss"],
    ["downtown duo", "panini-donruss"],
    ["purple", "panini-donruss"],
  ])("%s is not a rung of %s", (parallel, setKey) => {
    // Pinned at the VOCABULARY, so this stays true regardless of which leg
    // does the refusing as the guards evolve.
    expect(VOCAB.checklistListsParallel(parallel, 2024, setKey)).toBe(false);
    expect(VOCAB.checklistListsRungPhrase(parallel, 2024, setKey)).toBe(false);
    const r = r31({ title: "t", parallel, listsToken: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain(`rung-not-in-product-checklist-vocabulary:${parallel}`);
  });
});

// ---------------------------------------------------------------------------
// GUARD 3 — A `#N` IS NOT ALWAYS A CARD NUMBER (N1b)
// ---------------------------------------------------------------------------
describe("R33 refuses a #N that is not a card number", () => {
  it("refuses an ordinal: #1 Overall Draft Pick", () => {
    const t = "2024 Caleb Williams Chicago Bears Rookie Absolute KABOOM #1 Overall Draft Pick - Raw 10";
    // The lexer really does read it as card #1 — the defect is real.
    expect(r33(t, "1").evidence.titleNumber).toBe("1");
    expect(r33(t, "1").failed).toContain("not-a-card-number:ordinal");
  });

  it("refuses a two-card lot: Base #250 + Hype #5", () => {
    const t = "2024 Panini Prizm Christian McCaffrey Base #250 + Hype #5 / San Francisco 49ers - Raw 10";
    expect(r33(t, "250").evidence.titleNumber).toBe("250");
    expect(r33(t, "250").failed).toContain("not-a-card-number:two-card-numbers:250,5");
  });

  it.each([
    ["2024 PANINI DONRUSS #394 BROCK BOWERS ROOKIE RC PSA 10", "394"],
    ["2024 Panini Prizm Draft Picks Instant Impact #23 Arch Manning Insert Card  - Raw 10", "23"],
    ["2024 Bowman U Chrome Tez Johnson Campus Icons Insert #CI-22 Oregon Ducks - Raw 10", "ci-22"],
    ["George Pickens 2024 Donruss Threads #34 - Raw 10", "34"],
    ["2024 Panini Mosaic Micro Mosaic#23 Nick Bosa - Raw 10", "23"],
  ])("ALLOWS a genuine card number: %s", (title, num) => {
    const r = r33(title, num);
    expect(r.failed.filter((f: string) => f.startsWith("not-a-card-number"))).toEqual([]);
    expect(r.qualifies).toBe(true);
  });

  it("does not read the PRODUCT name 'Draft Picks' as an ordinal", () => {
    // The ordinal test requires the qualifying word to follow the `#N`
    // directly. "Prizm Draft Picks #23" puts the product name BEFORE the
    // number, and #23 is a real address.
    const t = "2024 Panini Prizm Draft Picks Instant Impact #23 Arch Manning Insert Card  - Raw 10";
    expect(r33(t, "23").failed.some((f: string) => f.startsWith("not-a-card-number"))).toBe(false);
  });

  it("a title repeating its OWN number is one card, not a lot", () => {
    // De-duplication matters: sellers echo the number. Two mentions of #394 is
    // one card named twice, and refusing it would cost a real repair.
    const t = "2024 PANINI DONRUSS #394 BROCK BOWERS ROOKIE RC #394 PSA 10";
    expect(r33(t, "394").failed.some((f: string) => f.startsWith("not-a-card-number"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE SAMPLE, COUNTED
// ---------------------------------------------------------------------------
describe("the guards, measured over the artifact's own 30+30 move samples", () => {
  it("R33: 28 of 30 still write, 2 refused, and the 2 are the named defects", () => {
    const artifact = require_(path.join(
      "C:", "Users", "dvabu", "AppData", "Local", "Temp", "claude",
      "c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1",
      "8d4a7bf1-c977-4fd7-a42c-7359a99322ff", "scratchpad",
      "collect-r3x", "flat", "census-slot-3.json",
    )) as { scopeSamples: { r33: { move: string[] } } };

    let writes = 0;
    const refused: string[] = [];
    for (const line of artifact.scopeSamples.r33.move) {
      const title = (line.match(/"([^"]+)"/) || [])[1] || "";
      const ev = K.titleCardNumberWinsEvidence({
        row: { title }, stored: { cardNumber: "zzz-stored-differs" },
        derived: { cardNumber: null },
        axes: { changed: ["cardNumber"], dropped: [] },
        titleNumberIsChecklistRow: true, derivedBacked: true,
      });
      const leg = ev.failed.find((f: string) => f.startsWith("not-a-card-number"));
      if (leg) refused.push(leg.split(":").slice(0, 2).join(":"));
      else if (ev.evidence.titleNumber) writes++;
    }
    expect(artifact.scopeSamples.r33.move.length).toBe(30);
    expect(writes).toBe(28);
    expect(refused.sort()).toEqual(["not-a-card-number:ordinal", "not-a-card-number:two-card-numbers"]);
  });
});
