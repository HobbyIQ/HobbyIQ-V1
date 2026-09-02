// CF-VALUATION-REPORT (Drew, 2026-09-02) — the report's rung vocabulary,
// pinned against the engine's.
//
// reportRung.ts is a server-side mirror of the CLOSED rung vocabulary in
// compiq/fmvRung.ts, and it must also agree WORD FOR WORD with the web's
// mirror (apps/web/src/lib/rung.ts) — a holding described as "estimate
// from the grade curve" in the app must not become something else in the
// PDF of the same portfolio.
//
// Three copies is three chances to drift, so the vocabulary is read from
// source here rather than retyped: a rung added to the engine without
// being added to the report is a RED TEST, not a silent `unknown rung` in
// a document a collector hands to an insurer.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  describeRung,
  isExactPoolRung,
  isKnownRung,
  EXACT_POOL_RUNGS,
  FALLBACK_RUNGS,
  NO_BASIS_RUNG,
} from "../src/services/portfolioiq/reportRung.js";

const REPO = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("describeRung doctrine", () => {
  it("every exact-pool rung is observed and says it read this card's sales", () => {
    for (const label of EXACT_POOL_RUNGS) {
      const d = describeRung(label, { compsUsed: 5 });
      expect(d.kind, label).toBe("observed");
      expect(d.label).toBe(label);
      expect(d.text, label).toMatch(/this card/);
      expect(isExactPoolRung(label)).toBe(true);
    }
  });

  it("every fallback rung is an estimate and its words begin with 'estimate'", () => {
    for (const label of FALLBACK_RUNGS) {
      const d = describeRung(label);
      expect(d.kind, label).toBe("estimate");
      expect(d.text, label).toMatch(/^estimate/);
      expect(isExactPoolRung(label), label).toBe(false);
    }
  });

  it("no-basis is unpriced; an unknown label is surfaced, never hidden", () => {
    expect(describeRung(NO_BASIS_RUNG).kind).toBe("unpriced");
    const unknown = describeRung("some-new-rung");
    expect(unknown.kind).toBe("unknown");
    expect(unknown.text).toContain("some-new-rung");
    expect(isKnownRung("some-new-rung")).toBe(false);
  });

  it("a missing label says so rather than assuming the best case", () => {
    expect(describeRung(null).kind).toBe("unknown");
    expect(describeRung(null).text).toBe("rung not reported");
    expect(describeRung("").label).toBeNull();
  });

  it("pluralizes the sale count and degrades to 'sales' when unknown", () => {
    expect(describeRung("exact-pool-projection", { compsUsed: 1 }).text)
      .toContain("1 sale of this card");
    expect(describeRung("exact-pool-projection", { compsUsed: 7 }).text)
      .toContain("7 sales of this card");
    expect(describeRung("exact-pool-projection").text).toContain("sales of this card");
  });
});

describe("the vocabulary matches the engine and the web", () => {
  it("holds every exact-pool rung named in fmvRung.ts", () => {
    const src = read("backend/src/services/compiq/fmvRung.ts");
    // The exact-pool union members, as string literals in the source.
    const engine = [...src.matchAll(/"(exact-pool-[a-z-]+)"/g)].map((m) => m[1]);
    expect(engine.length).toBeGreaterThan(0);
    for (const label of new Set(engine)) {
      expect(
        (EXACT_POOL_RUNGS as readonly string[]).includes(label),
        `fmvRung.ts names "${label}" but reportRung.ts does not`,
      ).toBe(true);
    }
  });

  it("holds every fallback rung fmvRung.ts names directly", () => {
    const src = read("backend/src/services/compiq/fmvRung.ts");
    // The rungs fmvRung.ts spells out itself (the ladder unions it folds
    // in are typed elsewhere and are covered by the web-parity check).
    for (const label of [
      "cross-grade-fallback",
      "grade-curve-estimate",
      "graded-pool-inverse",
      "player-index-projection",
      "sibling-estimate",
    ]) {
      expect(src, `fmvRung.ts no longer names "${label}"`).toContain(`"${label}"`);
      expect(
        (FALLBACK_RUNGS as readonly string[]).includes(label),
        `reportRung.ts is missing "${label}"`,
      ).toBe(true);
    }
  });

  it("has exactly the same vocabulary as the web's mirror", () => {
    const web = read("apps/web/src/lib/rung.ts");
    const listFrom = (marker: string): string[] => {
      const start = web.indexOf(marker);
      expect(start, `${marker} not found in the web mirror`).toBeGreaterThan(-1);
      const block = web.slice(start, web.indexOf("] as const", start));
      return [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    };
    expect([...listFrom("export const EXACT_POOL_RUNGS")].sort())
      .toEqual([...EXACT_POOL_RUNGS].sort());
    expect([...listFrom("export const FALLBACK_RUNGS")].sort())
      .toEqual([...FALLBACK_RUNGS].sort());
  });

  it("describes every rung in exactly the words the web uses", () => {
    // Word-for-word parity: the app and the exported document must not
    // describe the same holding differently.
    //
    // The web builds its strings with a `${salesPhrase(n)}` template, so
    // the comparison substitutes that placeholder back into this module's
    // rendered text before looking for it in the web source. Every phrase
    // is then matched WHOLE — no truncated needle that could pass on a
    // coincidental suffix.
    const web = read("apps/web/src/lib/rung.ts");
    const SALES = "5 sales";
    let checked = 0;
    for (const label of [...EXACT_POOL_RUNGS, ...FALLBACK_RUNGS]) {
      const rendered = describeRung(label, { compsUsed: 5 }).text;
      // The web writes the count as a template literal; ours is rendered.
      const asWebSource = rendered.includes(SALES)
        ? rendered.replace(SALES, "${salesPhrase(n)}")
        : rendered;
      expect(
        web,
        `the web mirror does not describe "${label}" as "${asWebSource}"`,
      ).toContain(asWebSource);
      checked += 1;
    }
    // A parity test that silently checked nothing would be worse than none.
    expect(checked).toBe(EXACT_POOL_RUNGS.length + FALLBACK_RUNGS.length);
  });
});
