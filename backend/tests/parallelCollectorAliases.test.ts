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

describe("applyCollectorAlias — Blue X-Fractor / Blue Refractor are DISTINCT (2026-07-13 revert)", () => {
  it("does NOT rewrite Blue X-Fractor on CPA-* (they're different cards, not aliases)", () => {
    // Blue Refractor lives on CardHedge (befe9bcc-...); Blue X-Fractor
    // lives on Cardsight (1778542140951...). Two physical variants,
    // NOT two names for one variant. Aliasing would show users the
    // wrong card with the right-sounding label.
    const r = applyCollectorAlias("Blue X-Fractor", "CPA-EHA");
    expect(r.aliased).toBe(false);
    expect(r.parallel).toBe("Blue X-Fractor");
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

describe("expandCollectorQuery — no expansions while alias table is empty", () => {
  it("returns empty expansions for the previously-aliased Blue Refractor case", () => {
    const r = expandCollectorQuery("eric hartman blue refractor auto");
    expect(r.expansions).toEqual([]);
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

describe("_listCollectorAliases — currently empty by design", () => {
  it("table is empty after the 2026-07-13 revert", () => {
    // Kept as an infrastructure hook: shape validation runs on every row
    // when we add one. Until we find two vendors using different names
    // for THE SAME card, the table stays empty.
    expect(_listCollectorAliases()).toEqual([]);
  });

  it("shape invariant on any future rows: non-empty prefixes + names + reason", () => {
    for (const a of _listCollectorAliases()) {
      expect(a.cardNumberPrefixes.length).toBeGreaterThan(0);
      expect(a.cardsightName.length).toBeGreaterThan(0);
      expect(a.collectorName.length).toBeGreaterThan(0);
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });
});
