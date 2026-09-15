/**
 * CF-THE-CHECKLIST-SPELLS-ITS-OWN-RUNGS (round-2 ladder probe, 2026-09-15).
 *
 * `parallel-ladder-plan-2026-09-15.md` split the audit's "37% of sports rows
 * sit at a parallel nothing backs" bucket into three causes and found that
 * 938,802 rows are not a gap at all -- they name a rung the checklist DOES
 * back, under a longer spelling. The largest gap cell,
 * `baseball/2025/panini-prizm` at 333,931 rows, is 100% this: the catalog
 * holds `Silver Prizms` and `Red Ice Prizms`; the pool writes `Silver` and
 * `Red Ice`. An acquirer sent there would buy a ladder we already own.
 *
 * Every product, rung and count asserted here is read from the SHIPPED corpus
 * (`data/checklist-parallel-names.json`), not from the plan's prose.
 *
 * -- THE RULE ---------------------------------------------------------------
 *
 * For the identity's own (sport, year, setKey): if EXACTLY ONE checklist rung
 * extends the stated finish, and extends it only by that product's stock words
 * (Prizm/Refractor/Holo/...), take the checklist's spelling. Zero, or two or
 * more: leave the stated finish exactly as written. Never guess, never Base.
 *
 * -- THE TWO WAYS THIS COULD GO WRONG, BOTH PINNED --------------------------
 *
 *   AMBIGUITY. `Blue` on 2025 panini-prizm extends into FOUR real rungs. The
 *   tie must be counted over ALL of them, BEFORE the family-word filter --
 *   an earlier draft filtered first, which left one survivor and adopted it,
 *   silently choosing one of four distinct cards.
 *
 *   A CHANGED CARD. An adoption is a strict EXTENSION of the text the row
 *   already carried, so the colour word cannot change. Pinned as a property
 *   over every product in the corpus rather than as a list of examples.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  checklistSpellingFor,
  noteSpellingAdopted,
  spellingAdoptedCount,
  resetSpellingAdoptedCount,
  _resetSpellingAdoption,
} from "../src/services/portfolioiq/checklistSpellingAdoption";
import { _resetParallelNameVocabulary } from "../src/services/portfolioiq/parallelNameVocabulary";

beforeEach(() => {
  _resetSpellingAdoption();
  _resetParallelNameVocabulary();
  resetSpellingAdoptedCount();
});

const PRIZM = { sport: "baseball", year: 2025, setKey: "panini-prizm" };
const PRISTINE = { sport: "baseball", year: 2025, setKey: "topps-pristine" };

// ---------------------------------------------------------------------------
// THE PROBE'S OWN EXAMPLES
// ---------------------------------------------------------------------------
describe("the checklist's spelling is adopted where it is unambiguous", () => {
  it.each([
    // [stated finish, the checklist's spelling of that same rung]
    ["Silver", "Silver Prizms"],
    ["Red Ice", "Red Ice Prizms"],
  ])("%s -> %s on 2025 panini-prizm", (stated, want) => {
    expect(checklistSpellingFor(stated, PRIZM)).toBe(want);
  });

  it("Aqua -> Aqua Refractor on 2025 topps-pristine", () => {
    expect(checklistSpellingFor("Aqua", PRISTINE)).toBe("Aqua Refractor");
  });

  it("does not fire when the row already spells it the checklist's way", () => {
    // Not a failure -- there is nothing to adopt. It matters because the
    // banner counts adoptions, and a no-op must not inflate the count.
    expect(checklistSpellingFor("Silver Prizms", PRIZM)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE AMBIGUITY REFUSAL -- THE WHOLE SAFETY PROPERTY
// ---------------------------------------------------------------------------
describe("two rungs sharing a prefix means no adoption", () => {
  it("refuses Blue, which is four real rungs on this product", () => {
    // Blue Prizms / Blue Ice Prizms / Blue Pulsar Prizms / Blue Shimmer FOTL
    // Prizms. Picking any one would file the sale on a card it may not be.
    expect(checklistSpellingFor("Blue", PRIZM)).toBeNull();
  });

  it("refuses Green, likewise", () => {
    expect(checklistSpellingFor("Green", PRIZM)).toBeNull();
  });

  it("the ambiguity is real, read from the shipped corpus", () => {
    // The refusals above would also pass if the product simply had no Blue
    // rung at all. This proves they are refusals of a genuine tie.
    const raw = JSON.parse(
      readFileSync("data/checklist-parallel-names.json", "utf8"),
    ) as { products?: Record<string, { parallels?: { name?: string }[] }> };
    const names = (raw.products?.["baseball|2025|panini-prizm"]?.parallels ?? [])
      .map((p) => String(p.name ?? ""));
    const blues = names.filter((n) => /^blue\b/i.test(n));
    expect(blues.length).toBeGreaterThan(1);
    const silvers = names.filter((n) => /^silver\b/i.test(n));
    expect(silvers).toEqual(["Silver Prizms"]);
  });
});

// ---------------------------------------------------------------------------
// WHAT IT REFUSES TO TOUCH
// ---------------------------------------------------------------------------
describe("refusals", () => {
  it("never respells Base -- Base is the absence of a rung", () => {
    expect(checklistSpellingFor("Base", PRIZM)).toBeNull();
    expect(checklistSpellingFor("base", PRIZM)).toBeNull();
  });

  it("never answers for a product the corpus does not carry", () => {
    expect(checklistSpellingFor("Silver", { sport: "baseball", year: 1899, setKey: "nope" })).toBeNull();
  });

  it("never answers without full product context", () => {
    // A rung means nothing without the product whose ladder it is on. The
    // corpus cannot say which rungs exist, so there is no question to answer.
    expect(checklistSpellingFor("Silver", { sport: "baseball", year: 2025, setKey: null })).toBeNull();
    expect(checklistSpellingFor("Silver", { sport: null, year: 2025, setKey: "panini-prizm" })).toBeNull();
    expect(checklistSpellingFor("Silver", { sport: "baseball", year: null, setKey: "panini-prizm" })).toBeNull();
  });

  it("never crosses to a sibling product", () => {
    // `Encased Aqua Refractor` (pool) vs `Pristine Aqua Refractor` (source) is
    // a RENAME, not an extension -- the R34/R35 re-key lane, not this one.
    // Adopting across it would need to invent, so it refuses.
    expect(checklistSpellingFor("Encased Aqua Refractor", PRISTINE)).toBeNull();
  });

  it("never treats a colour or pattern word as a mere spelling", () => {
    // The corpus's most common trailing words are colours, so an "extends by
    // one word" rule with no vocabulary would read two rungs as one.
    const raw = JSON.parse(
      readFileSync("data/checklist-parallel-names.json", "utf8"),
    ) as { products?: Record<string, { sport?: string; year?: number; setKey?: string; parallels?: { name?: string }[] }> };
    for (const product of Object.values(raw.products ?? {})) {
      const sport = product.sport, year = product.year, setKey = product.setKey;
      if (!sport || !year || !setKey) continue;
      for (const p of product.parallels ?? []) {
        const name = String(p.name ?? "").trim();
        if (!name) continue;
        const got = checklistSpellingFor(name, { sport, year, setKey });
        // A full rung name may only ever resolve to itself-extended-by-stock,
        // never to a name that adds a colour.
        if (got === null) continue;
        const norm = (x: string) => x.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
        expect(norm(got).startsWith(norm(name))).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE PROPERTY: AN ADOPTION NEVER CHANGES THE CARD
// ---------------------------------------------------------------------------
describe("spellingAdoptionNeverChangesTheColour", () => {
  it("every adoption is a strict extension of the stated text", () => {
    // Over every product and every rung in the shipped corpus. If an adoption
    // could ever drop or alter a leading word, it would be naming a different
    // card -- and the colour is always a leading word.
    const raw = JSON.parse(
      readFileSync("data/checklist-parallel-names.json", "utf8"),
    ) as { products?: Record<string, { sport?: string; year?: number; setKey?: string; parallels?: { name?: string }[] }> };

    const COLOURS = /\b(gold|silver|blue|red|green|orange|purple|pink|yellow|black|white|aqua|teal|bronze|copper|fuchsia|magenta|emerald|ruby|sapphire|onyx)\b/gi;
    let checked = 0;
    const violations: string[] = [];

    for (const product of Object.values(raw.products ?? {})) {
      const sport = product.sport, year = product.year, setKey = product.setKey;
      if (!sport || !year || !setKey) continue;
      for (const p of product.parallels ?? []) {
        const name = String(p.name ?? "").trim();
        if (!name) continue;
        // Probe with the rung's own first word(s) -- the shape the pool writes.
        const words = name.split(/\s+/);
        if (words.length < 2) continue;
        const stated = words.slice(0, words.length - 1).join(" ");
        const got = checklistSpellingFor(stated, { sport, year, setKey });
        if (got === null) continue;
        checked++;
        const before = (stated.match(COLOURS) ?? []).map((s) => s.toLowerCase()).join(",");
        const after = (got.match(COLOURS) ?? []).map((s) => s.toLowerCase()).join(",");
        if (!after.startsWith(before) && violations.length < 20) {
          violations.push(`${stated} -> ${got}`);
        }
        // EXTENSION IS MEASURED ON THE NORMALISED KEY, NOT THE RAW STRING.
        // The corpus spells one card several ways -- `Mini-Diamond` vs `Mini
        // Diamond`, `&` vs `and`, `Tie-Dye` vs `Tie Dye` -- and `key()`
        // deliberately folds exactly that, because punctuation is spelling and
        // not identity. A raw-prefix assertion here reported 20 "violations"
        // that were all one card spelled two ways, which is the thing this
        // module exists to reconcile rather than a defect in it.
        const norm = (x: string) => x.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
        if (!norm(got).startsWith(norm(stated)) && violations.length < 20) {
          violations.push(`NOT-AN-EXTENSION ${stated} -> ${got}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // The property is only meaningful if it actually exercised the rule.
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE REPORT-ONLY COUNTER
// ---------------------------------------------------------------------------
describe("the banner counter is report-only", () => {
  it("counts what the deriver tells it to, and resets", () => {
    expect(spellingAdoptedCount()).toBe(0);
    noteSpellingAdopted();
    noteSpellingAdopted();
    expect(spellingAdoptedCount()).toBe(2);
    resetSpellingAdoptedCount();
    expect(spellingAdoptedCount()).toBe(0);
  });
});
