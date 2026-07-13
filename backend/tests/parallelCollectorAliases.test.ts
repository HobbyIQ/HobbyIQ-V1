// CF-PARALLEL-COLLECTOR-ALIASES (Drew, 2026-07-13, PR #410) — verifies the
// collector-common alias translation. Ensures we only rewrite Cardsight's
// parallel label when the cardNumber prefix confirms the alias applies —
// no blanket "X-Fractor → Refractor" that would corrupt a genuine
// X-Fractor from a different set.

import { describe, expect, it } from "vitest";
import {
  applyCollectorAlias,
  expandCollectorQuery,
  _listCollectorAliases,
} from "../src/services/compiq/parallelCollectorAliases.js";

describe("applyCollectorAlias — CPA-* Blue X-Fractor → Blue Refractor", () => {
  it("rewrites for CPA-EHA (the reported case)", () => {
    const r = applyCollectorAlias("Blue X-Fractor", "CPA-EHA");
    expect(r.aliased).toBe(true);
    expect(r.parallel).toBe("Blue Refractor");
    expect(r.alias?.reason).toContain("Bowman");
  });

  it("rewrites for other CPA-* card numbers", () => {
    expect(applyCollectorAlias("Blue X-Fractor", "CPA-JJ").aliased).toBe(true);
    expect(applyCollectorAlias("Blue X-Fractor", "CPA-DBA").aliased).toBe(true);
  });

  it("rewrites for BCPA-* card numbers (variant Bowman naming)", () => {
    expect(applyCollectorAlias("Blue X-Fractor", "BCPA-EHA").aliased).toBe(true);
  });

  it("case-insensitive on parallel name", () => {
    expect(applyCollectorAlias("blue x-fractor", "CPA-EHA").aliased).toBe(true);
    expect(applyCollectorAlias("BLUE X-FRACTOR", "CPA-EHA").aliased).toBe(true);
  });

  it("case-insensitive on cardNumber", () => {
    expect(applyCollectorAlias("Blue X-Fractor", "cpa-eha").aliased).toBe(true);
  });

  it("trims whitespace on both inputs", () => {
    expect(applyCollectorAlias("  Blue X-Fractor  ", "  CPA-EHA  ").aliased).toBe(true);
  });
});

describe("applyCollectorAlias — no-match cases", () => {
  it("does NOT rewrite when cardNumber prefix doesn't match", () => {
    // Topps Chrome X-Fractor exists as a real parallel with TCA-*/TSA-*
    // numbers. Don't corrupt it into "Blue Refractor".
    const r = applyCollectorAlias("Blue X-Fractor", "TCA-BB");
    expect(r.aliased).toBe(false);
    expect(r.parallel).toBe("Blue X-Fractor");
  });

  it("does NOT rewrite when the parallel is a different variant on CPA-*", () => {
    const r = applyCollectorAlias("Speckle Refractor", "CPA-EHA");
    expect(r.aliased).toBe(false);
    expect(r.parallel).toBe("Speckle Refractor");
  });

  it("returns null-safe on null/undefined inputs", () => {
    expect(applyCollectorAlias(null, "CPA-EHA").aliased).toBe(false);
    expect(applyCollectorAlias("Blue X-Fractor", null).aliased).toBe(false);
    expect(applyCollectorAlias(undefined, undefined).aliased).toBe(false);
  });

  it("returns null-safe on empty strings", () => {
    expect(applyCollectorAlias("", "CPA-EHA").aliased).toBe(false);
    expect(applyCollectorAlias("Blue X-Fractor", "").aliased).toBe(false);
  });
});

describe("expandCollectorQuery — reverse-direction search expansion", () => {
  it("expands 'Blue Refractor' → 'Blue X-Fractor' expansion", () => {
    const r = expandCollectorQuery("eric hartman blue refractor auto");
    expect(r.expansions).toContain("Blue X-Fractor");
  });

  it("is case-insensitive on the query", () => {
    expect(expandCollectorQuery("BLUE REFRACTOR").expansions).toContain("Blue X-Fractor");
  });

  it("returns empty expansions when the query has no aliased phrase", () => {
    expect(expandCollectorQuery("mookie betts topps chrome").expansions).toEqual([]);
  });

  it("preserves the original query on the return object", () => {
    const q = "some query";
    const r = expandCollectorQuery(q);
    expect(r.original).toBe(q);
  });
});

describe("_listCollectorAliases — audit shape", () => {
  it("every alias row has non-empty prefixes, both names, and a reason", () => {
    const aliases = _listCollectorAliases();
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) {
      expect(a.cardNumberPrefixes.length).toBeGreaterThan(0);
      expect(a.cardsightName.length).toBeGreaterThan(0);
      expect(a.collectorName.length).toBeGreaterThan(0);
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });
});
