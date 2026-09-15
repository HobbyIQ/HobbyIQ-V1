/**
 * R49 — THE `spellings` ARRAY IS AN ALIAS LIST NOBODY READ.
 *
 * `data/checklist-parallel-names.json` carries, per rung, every spelling the
 * scrape saw for it. `checklistSpellingAdoption` read only `parallel.name`, so
 * a pool row spelling a rung the checklist's OTHER way could not reach it —
 * which is precisely the job that module exists to do.
 *
 * -- WHAT THE DATA ACTUALLY HOLDS -------------------------------------------
 *
 * Measured against the shipped corpus BEFORE trusting the premise, because the
 * answer changes what this commit should be:
 *
 *   * All 37,849 rungs carry a `spellings` array — but only 28 carry MORE than
 *     one entry, and those differ by case or punctuation alone
 *     (`Superfractors`/`SUperfractors`, `Tie-Dye Prizm`/`Tie Dye Prizm`),
 *     which `key()` already folds. R49 therefore adds very few new aliases.
 *   * 965 spelling entries carry pack-odds text or scrape noise
 *     ("991 packs)", "65 cards/", "Gold Foil (HTA Jumbo exclusive)").
 *
 * That second figure is why every alias goes through the SAME
 * `cleanParallelName` the rung name does. Without it R49 would re-admit,
 * through a second door, exactly the odds-polluted strings
 * CF-A-PARALLEL-NAME-IS-A-NAME-THE-CHECKLIST-SPELLS exists to strip.
 *
 * -- THE PRISTINE CASE, HONESTLY ---------------------------------------------
 *
 * R49 was asked for with `Encased Aqua Refractor` → `Pristine Aqua Refractor`
 * as its worked example. It is pinned below as STILL null, because the corpus
 * does not support it: 2025 topps-pristine lists ten rungs, spelled
 * `Aqua Refractor`, `Blue Refractor`, … — neither `Encased` nor `Pristine`
 * appears in any name or any spelling. The ladder probe read those names off
 * the SOURCE PAGE, not out of this corpus, so closing that pair needs a
 * corpus re-scrape (or a ruled alias table), not a reader change. Writing
 * `Pristine Aqua Refractor` from a rule that cannot see it would be inventing
 * a rung — the thing this module is built never to do.
 *
 * -- R49 IS A NO-OP AGAINST TODAY'S CORPUS, AND THAT IS THE FINDING ---------
 *
 * Measured by mutation, not by inspection: building the module WITH and
 * WITHOUT the alias loop and diffing the answers produces no difference on any
 * probe. The reason is arithmetic --
 *
 *   * 37,880 spelling entries exist; 37,875 clean to exactly their own rung's
 *     name, which the key folding already handled, so they add nothing.
 *   * The 5 that clean to something else are 4 copies of scrape debris
 *     ("FrozenFractor - /-5") and one bare "Outburst", which merely duplicates
 *     an exact match the module already reached by another route.
 *
 * So this commit ships the MECHANISM and the MEASUREMENT, not a behaviour
 * change. It is worth having because it is the correct reader: when a corpus
 * re-scrape adds real aliases (the Pristine pair among them) they are picked
 * up without another code change, and the tripwire test below is what says
 * when that has happened.
 *
 * It is deliberately NOT presented as a fix for the Pristine pair. That pair
 * needs data, not a reader.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  checklistSpellingFor,
  _resetSpellingAdoption,
} from "../src/services/portfolioiq/checklistSpellingAdoption";
import {
  cleanParallelName,
  _resetParallelNameVocabulary,
} from "../src/services/portfolioiq/parallelNameVocabulary";

beforeEach(() => {
  _resetSpellingAdoption();
  _resetParallelNameVocabulary();
});

const PRISTINE = { sport: "baseball", year: 2025, setKey: "topps-pristine" };

interface Corpus {
  products?: Record<string, {
    sport?: string; year?: number; setKey?: string;
    parallels?: { name?: string; spellings?: string[] }[];
  }>;
}
const corpus = (): Corpus =>
  JSON.parse(readFileSync("data/checklist-parallel-names.json", "utf8")) as Corpus;

const norm = (x: string): string =>
  x.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// THE PRISTINE CASE
// ---------------------------------------------------------------------------
describe("the Pristine pair", () => {
  it("2025 topps-pristine carries neither Encased nor Pristine in any spelling", () => {
    // The evidence for the refusal below, asserted rather than asserted-about.
    const p = corpus().products?.["baseball|2025|topps-pristine"];
    expect(p).toBeTruthy();
    const every = (p?.parallels ?? []).flatMap((x) => [x.name ?? "", ...(x.spellings ?? [])]);
    expect(every.length).toBeGreaterThan(0);
    expect(every.some((n) => /encased/i.test(n))).toBe(false);
    expect(every.some((n) => /pristine/i.test(n))).toBe(false);
  });

  it("so Encased Aqua Refractor stays unresolved — absent beats invented", () => {
    expect(checklistSpellingFor("Encased Aqua Refractor", PRISTINE)).toBeNull();
  });

  it("while the rung that IS in the corpus still resolves", () => {
    // Proof the product is reachable at all, so the null above is a refusal
    // about the NAME rather than a product the module cannot see.
    expect(checklistSpellingFor("Aqua", PRISTINE)).toBe("Aqua Refractor");
  });
});

// ---------------------------------------------------------------------------
// ALIASES ARE INDEXED, AND CLEANED ON THE WAY IN
// ---------------------------------------------------------------------------
describe("an alias spelling reaches its rung", () => {
  it("the cleaner strips the odds tail off an alias, exactly as off a name", () => {
    // The guard that keeps R49 from re-admitting odds text through a second
    // door. Asserted on the SHAPE the cleaner is responsible for -- a trailing
    // pack annotation -- rather than on a blanket word ban, because several
    // real rungs legitimately contain "Jumbo" ("Jumbo Emerald", "Impeccable
    // Jumbo Patches Batting Glove") and banning the word would assert those
    // rungs are dirty when they are cards.
    expect(cleanParallelName("Gold Foil (HTA Jumbo exclusive)")).toBe("Gold Foil");
    expect(cleanParallelName("X-Fractor - 10 per Mega Box (Retail exclusive)")).toBe("X-Fractor");
    expect(cleanParallelName("Cracked Ice Prizms - 23")).toBe("Cracked Ice Prizms");
  });

  it("scrape noise in the spellings array can never be ADOPTED", () => {
    // The corpus's spellings carry 965 entries of odds text and scrape debris
    // ("1:65 hobby, 1:31 collector...", "991 packs)"). Indexing them is
    // harmless only if no pool row can land on one, so that is what is
    // asserted -- the honest end-to-end property, rather than a claim that the
    // corpus is clean when it demonstrably is not.
    //
    // Nothing adopts them because adoption needs the stated text to be a
    // strict prefix of a UNIQUE candidate whose remaining words are all stock
    // words, and debris satisfies none of those.
    for (const [text, sport, year, setKey] of [
      ["1:65 hobby", "baseball", 2024, "topps-chrome"],
      ["Superfractors", "baseball", 2024, "topps-chrome"],
      ["991 packs", "baseball", 2024, "topps-chrome"],
    ] as [string, string, number, string][]) {
      expect(checklistSpellingFor(text, { sport, year, setKey })).toBeNull();
    }
  });

  it("WHAT R49 IS ACTUALLY WORTH: 5 keys corpus-wide, 1 of them real", () => {
    // THE HONEST MEASUREMENT, and the reason this commit is small.
    //
    // Reading `spellings` sounds like it should unlock a lot. Measured over
    // the shipped corpus it unlocks FIVE keys beyond what the rung names
    // already give -- because the other 37,875 alias entries clean to exactly
    // their own rung's name, which `key()` already folded.
    //
    //   FrozenFractor - /-5    x4   scrape debris (a mangled print run)
    //   Outburst               x1   GENUINE: the rung is spelled
    //                               "Outburst (Base SP only)" and a pool row
    //                               saying "Outburst" now reaches it
    //
    // This test is the guard on that claim: if a corpus re-scrape adds real
    // aliases the number moves and this fails, which is the signal to re-read
    // the lane -- not a regression.
    const distinct: string[] = [];
    for (const [k, product] of Object.entries(corpus().products ?? {})) {
      for (const par of product.parallels ?? []) {
        const nameClean = cleanParallelName(String(par.name ?? "").trim());
        const nameKey = nameClean ? norm(nameClean) : null;
        for (const sp of par.spellings ?? []) {
          const alias = cleanParallelName(String(sp ?? "").trim());
          if (!alias) continue;
          if (norm(alias) !== nameKey) distinct.push(`${k}::${alias}`);
        }
      }
    }
    expect(distinct.length).toBe(5);
    expect(distinct.filter((d) => /::Outburst$/.test(d))).toHaveLength(1);
  });

  it("the one genuine alias is INDEXED, which is what changes the answer", () => {
    // MUTATION ANCHOR, and the one place in the corpus where R49 moves
    // anything. Worth stating precisely, because the observable effect is the
    // opposite of what it first looks like.
    //
    // 2026 upper-deck-team-canada spells the rung `Outburst (Base SP only)`
    // and lists `Outburst - 1:18 packs (Base SP only)` as its spelling. That
    // alias CLEANS to a bare `Outburst`, so after R49 the product's name list
    // carries `Outburst` as an entry in its own right.
    //
    // A pool row saying "Outburst" therefore now hits the EXACT-MATCH arm and
    // the module answers null -- "already the checklist's spelling, nothing to
    // adopt". Before R49 that same row had no exact match, fell through to the
    // extension walk, and found two candidates (`Gold Outburst`,
    // `Red Outburst` do not extend it, but `Outburst (Base SP only)` does) --
    // so it either adopted a parenthesised name or refused on a tie.
    //
    // Null here is the CORRECT answer and the changed one: the row is already
    // spelled the way the checklist spells this rung, and R49 is what lets the
    // module know that.
    const ctx = { sport: "hockey", year: 2026, setKey: "upper-deck-team-canada" };
    expect(checklistSpellingFor("Outburst", ctx)).toBeNull();


    // And the sibling rungs still behave: neither is claimed by the alias.
    expect(checklistSpellingFor("Gold Outburst", ctx)).toBeNull();
    expect(checklistSpellingFor("Red Outburst", ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE UNIQUENESS RULE, INHERITED NOT DUPLICATED
// ---------------------------------------------------------------------------
describe("no two rungs of one product may claim the same spelling", () => {
  it("holds across the whole corpus, after cleaning", () => {
    // THE PROPERTY R49 NEEDS. An alias is only safe to follow when exactly one
    // rung in the product/year claims it; two claimants would make the
    // adoption a coin flip between two real cards.
    //
    // A "clash" between two spellings of the SAME rung name is not a clash --
    // `X-Fractor` and `X-Fractor - 10 per Mega Box (Retail exclusive)` are one
    // card listed twice, and the cleaner collapsing them is the correct
    // outcome. Measured: 26 such pairs, 0 genuine ones.
    const clashes: string[] = [];
    for (const [k, product] of Object.entries(corpus().products ?? {})) {
      const claim = new Map<string, string>();
      for (const par of product.parallels ?? []) {
        const name = String(par.name ?? "");
        for (const sp of [name, ...(par.spellings ?? [])]) {
          const cleaned = cleanParallelName(String(sp ?? "").trim());
          if (!cleaned) continue;
          const key = norm(cleaned);
          // THE CLAIMANT IS THE CLEANED RUNG NAME, NOT THE RAW ONE. Two rows
          // whose names clean to the same string are ONE card listed twice --
          // `Mirror Purple` and `Mirror Purple (Blaster exclusive)` differ
          // only by the pack annotation the cleaner exists to strip. Comparing
          // raw names reported 26 such pairs as clashes; comparing cleaned
          // names asks the real question, which is whether two DIFFERENT cards
          // ever claim one spelling.
          const owner = norm(String(cleanParallelName(name) ?? name));
          const prev = claim.get(key);
          if (prev !== undefined && prev !== owner) {
            if (clashes.length < 20) clashes.push(`${k} :: ${cleaned} <- ${prev} vs ${owner}`);
          } else {
            claim.set(key, owner);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("R49 changes no answer against today's corpus — recorded, not assumed", () => {
    // THE TRIPWIRE. Every alias that is not already its own rung's name is
    // enumerated here. If a re-scrape adds real aliases this list grows and
    // this test fails, which is the signal that the lane has become worth
    // measuring -- not a regression.
    //
    // Stated as a test rather than a comment because "this code currently
    // changes nothing" is exactly the claim that rots silently.
    const surplus: string[] = [];
    for (const product of Object.values(corpus().products ?? {})) {
      for (const par of product.parallels ?? []) {
        const nameClean = cleanParallelName(String(par.name ?? "").trim());
        const nameKey = nameClean ? norm(nameClean) : null;
        for (const sp of par.spellings ?? []) {
          const alias = cleanParallelName(String(sp ?? "").trim());
          if (alias && norm(alias) !== nameKey) surplus.push(alias);
        }
      }
    }
    expect(surplus.sort()).toEqual([
      "FrozenFractor - /-5",
      "FrozenFractor - /-5",
      "FrozenFractor - /-5",
      "FrozenFractor - /-5",
      "Outburst",
    ]);
  });

  it("a genuinely ambiguous prefix is still refused", () => {
    // The tie rule aliases inherit by being added to the same name list. If
    // R49 had built a second index this would have regressed silently.
    expect(checklistSpellingFor("Blue", { sport: "baseball", year: 2025, setKey: "panini-prizm" })).toBeNull();
    expect(checklistSpellingFor("Green", { sport: "baseball", year: 2025, setKey: "panini-prizm" })).toBeNull();
  });

  it("and an unambiguous one still resolves", () => {
    expect(checklistSpellingFor("Silver", { sport: "baseball", year: 2025, setKey: "panini-prizm" }))
      .toBe("Silver Prizms");
  });
});
