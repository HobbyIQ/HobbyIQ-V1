// CF-TOKEN-BUILDERS-SHARED / CF-TOKEN-COVERAGE-STALENESS (2026-08-22).
//
// WHY THIS FILE EXISTS. The coverage canary counted EMPTY searchTokens arrays
// and called that coverage. "Empty" and "correct" are different questions, and
// only the first was ever asked. A row written by an older builder is
// non-empty — so it counted as covered — while missing the canonical fields
// the searcher relies on. It then misses every indexed arm and falls through
// to the unindexed CONTAINS scans at full cost, with the canary green.
//
// On 2026-08-21 the canary reported 27,253 missing and "OK — within threshold".
// A check that cannot fail is not a check, so the first thing the staleness
// pass did on 2026-08-22 was find a real bug the count could never have seen:
// stored tokens disagreed with the searcher's own tokenizer around apostrophes
// and diacritics, so "Sergio Aguero" matched nothing by surname. See
// CF-TOKEN-FOLD-TO-MATCH-SEARCHER below.
//
// The builders now live in ONE module that both the backfill and the canary
// import, so the canary compares against the same code that writes the data.
//
// THIS FILE PINS:
//   1. Both row shapes are read. Reading only the cardsight shape is the
//      original bug (CF-SEARCH-ENRICH-BOTH-SHAPES) and is what left millions of
//      canonical rows unindexed for months.
//   2. Hyphenated card numbers emit their fragments, so "cpa" finds "CPA-EHA".
//   3. A row the builders cannot describe yields NO tokens, so the backfill can
//      refuse it. An empty array is defined-and-not-null and would satisfy a
//      missing-only filter forever.
//   4. classifyRowTokens detects the stale case the canary was blind to.
//   5. EXTRA stored tokens are not stale. Rows accumulate tokens from sources
//      these builders do not model; flagging those would make the canary cry
//      wolf on every one.

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const {
  buildSearchText,
  buildSearchTokens,
  classifyRowTokens,
  TOKEN_SOURCE_FIELDS,
} = require_("../scripts/comp-quality/searchTokenBuilders.cjs");

const tokensFor = (row: Record<string, unknown>) =>
  buildSearchTokens(buildSearchText(row));

describe("searchTokenBuilders — both row shapes", () => {
  it("reads the canonical shape", () => {
    // The shape the original job could not see.
    const t = tokensFor({
      playerName: "Leo De Vries",
      setKey: "2024-bowman-chrome",
      cardNumber: "BCP-69",
      year: 2024,
      parallel: "Blue Raywave",
    });
    for (const want of ["leo", "vries", "bowman", "chrome", "bcp-69", "bcp", "69", "2024", "blue", "raywave"]) {
      expect(t).toContain(want);
    }
  });

  it("reads the cardsight shape", () => {
    const t = tokensFor({
      player: "Shohei Ohtani",
      releaseName: "2018 Topps Chrome Update",
      number: "HMT1",
      year: 2018,
      parallels: [{ name: "Refractor" }],
      attributes: ["Rookie"],
    });
    for (const want of ["shohei", "ohtani", "topps", "chrome", "update", "hmt1", "refractor", "rookie"]) {
      expect(t).toContain(want);
    }
  });

  it("splits hyphenated card numbers into fragments", () => {
    // So a user typing either half still hits the row.
    const t = tokensFor({ playerName: "Eric Hartman", cardNumber: "CPA-EHA", year: 2026 });
    expect(t).toContain("cpa-eha");
    expect(t).toContain("cpa");
    expect(t).toContain("eha");
  });

  it("omits a Base parallel but keeps a real one", () => {
    expect(tokensFor({ playerName: "A Player", parallel: "Base" })).not.toContain("base");
    expect(tokensFor({ playerName: "A Player", parallel: "Gold" })).toContain("gold");
  });

  it("produces NOTHING for a row it cannot describe", () => {
    // The backfill's refusal guard depends on this. Writing [] here would be
    // defined-and-not-null and would satisfy a missing-only filter forever.
    expect(tokensFor({ id: "hiq:whatever" })).toEqual([]);
    expect(buildSearchText({})).toBe("");
  });

  it("drops single characters", () => {
    // Tokens under 2 chars are noise against ARRAY_CONTAINS.
    expect(tokensFor({ playerName: "A B", year: 2024 })).not.toContain("a");
  });
});

describe("CF-TOKEN-FOLD-TO-MATCH-SEARCHER", () => {
  // Found 2026-08-22 by the staleness canary on its first real run.
  //
  // catalogSearch tokenizes the USER'S query with .replace(/[^\w\s-]/g, " "),
  // so apostrophes and diacritics are separators on the query side. This
  // builder split on /[^a-z0-9-]+/ and stored the raw form. ARRAY_CONTAINS is
  // exact, so any disagreement between the two is simply a miss.

  const tokensForName = (playerName: string) => tokensFor({ playerName });

  it("finds a card by surname across an apostrophe", () => {
    // Stored o'neal, user types neal. Before this fix the row could not be
    // reached by surname at all.
    expect(tokensForName("Shaquille O'Neal")).toContain("neal");
  });

  it("emits the ASCII form users actually type", () => {
    // The sharpest case: the stored form was agüero and the builder wanted
    // ag/ero, so NEITHER matched a user typing aguero.
    expect(tokensForName("Sergio Agüero")).toContain("aguero");
    expect(tokensForName("José Ramírez")).toContain("ramirez");
    expect(tokensForName("Jhoan Peña")).toContain("pena");
  });

  it("keeps the accented form too, so both spellings hit", () => {
    // Additive, never a swap — a user who does type the diacritic still wins.
    const t = tokensForName("Sergio Agüero");
    expect(t).toContain("aguero");
    expect(t.some((x: string) => x.includes("ero"))).toBe(true);
  });

  it("strips trailing punctuation from real catalog noise", () => {
    // Observed in prod: playerName "Cristian Pache 1st UER:" stored uer: with
    // the colon, which no query can produce.
    expect(tokensFor({ playerName: "Cristian Pache 1st UER:" })).toContain("uer");
  });

  it("still emits hyphenated card numbers and their fragments", () => {
    // The folding pass must not cost the existing behaviour.
    const t = tokensFor({ playerName: "Eric Hartman", cardNumber: "CPA-EHA" });
    expect(t).toContain("cpa-eha");
    expect(t).toContain("cpa");
    expect(t).toContain("eha");
  });

  it("does not emit single characters from split punctuation", () => {
    // "O'Neal" splits to o + neal; a bare "o" would match almost everything.
    expect(tokensForName("Shaquille O'Neal")).not.toContain("o");
  });
});

describe("classifyRowTokens — the canary's missing question", () => {
  const canonicalRow = {
    playerName: "Leo De Vries",
    setKey: "2024-bowman-chrome",
    cardNumber: "BCP-69",
    year: 2024,
    parallel: "Blue Raywave",
  };

  it("calls a fully-tokenised row ok", () => {
    expect(classifyRowTokens({ ...canonicalRow, searchTokens: tokensFor(canonicalRow) })).toBe("ok");
  });

  it("calls an untokenised row empty", () => {
    expect(classifyRowTokens({ ...canonicalRow, searchTokens: [] })).toBe("empty");
    expect(classifyRowTokens({ ...canonicalRow })).toBe("empty");
  });

  it("catches the exact case the canary was blind to", () => {
    // Tokens written by a builder that only saw the cardsight shape: non-empty,
    // so a missing-tokens count reports this row as covered, while the player
    // and parallel the searcher anchors on are absent.
    const staleTokens = ["2024"];
    expect(staleTokens.length).toBeGreaterThan(0);          // not "empty"
    expect(classifyRowTokens({ ...canonicalRow, searchTokens: staleTokens })).toBe("stale");
  });

  it("flags a row missing only its parallel", () => {
    const partial = tokensFor(canonicalRow).filter((t: string) => t !== "raywave");
    expect(classifyRowTokens({ ...canonicalRow, searchTokens: partial })).toBe("stale");
  });

  it("does NOT flag extra stored tokens as stale", () => {
    // Asymmetric on purpose: rows legitimately carry tokens from sources these
    // builders do not model. Only MISSING tokens mean a lookup that will not
    // hit the index.
    const extra = [...tokensFor(canonicalRow), "cardhedge", "somevendorslug"];
    expect(classifyRowTokens({ ...canonicalRow, searchTokens: extra })).toBe("ok");
  });

  it("does not call a row stale when there is nothing to compare against", () => {
    // Builders produce nothing for this row, so its tokens cannot be judged.
    expect(classifyRowTokens({ id: "hiq:x", searchTokens: ["leftover"] })).toBe("ok");
  });
});

describe("TOKEN_SOURCE_FIELDS", () => {
  it("projects every field the builders read", () => {
    // A SELECT missing one of these would make every affected row look stale —
    // omit c.parallel and every parallel row becomes a false alarm.
    for (const f of ["c.playerName", "c.player", "c.setKey", "c.setName", "c.releaseName",
                     "c.cardNumber", "c.number", "c.year", "c.parallel", "c.parallelSlug",
                     "c.parallels", "c.attributes", "c.searchTokens"]) {
      expect(TOKEN_SOURCE_FIELDS).toContain(f);
    }
  });
});
