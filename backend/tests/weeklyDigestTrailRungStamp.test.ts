// CF-A-MOVER-NEEDS-CORROBORATION (Drew, 2026-09-03) — the WRITER pin.
//
// The digest's movers gate is only as good as the evidence on the trail.
// Before this change NO append site stamped a rung: a live census of the
// portfolio container found 23,936 price points, 52 carrying a
// valuationStatus and ZERO carrying a rungLabel. The gate had nothing to
// read, so it admitted every reprice write as an observed sale.
//
// This suite pins the WRITER, not the reader:
//
//   • every append site that KNOWS its rung stamps it, and
//   • the one lane that genuinely does not know (the legacy reprice path,
//     which writes `fmvRung: null` onto the holding) writes NO rung rather
//     than inventing one — absence is the honest answer there, and the
//     digest reads absence as uncorroborated.
//
// It is a source-shape pin. The append sites sit inside autoPriceHolding /
// repriceHoldingsForUser, behind a live Cosmos read and a full estimate
// computation; asserting on the emitted point would mean standing up that
// whole path. What can regress silently is a site QUIETLY LOSING its stamp
// — a refactor dropping the spread, a new site copied from the legacy one
// — and that is exactly what reading the source catches.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isExactPoolRung } from "../src/services/compiq/fmvRung.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "..", "src", "services", "portfolioiq", "portfolioStore.service.ts");
const src = readFileSync(STORE, "utf8");

/** The body of each appendPriceHistory(...) call, matched by walking
 *  balanced parens from the call site. */
function appendCallBodies(text: string): string[] {
  const out: string[] = [];
  const needle = "appendPriceHistory(";
  let i = text.indexOf(needle);
  while (i !== -1) {
    // Skip the declaration itself.
    const lineStart = text.lastIndexOf("\n", i) + 1;
    if (!text.slice(lineStart, i).includes("function ")) {
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(text.slice(i, j + 1));
    }
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

describe("the price-history writer stamps the rung", () => {
  const bodies = appendCallBodies(src);

  it("finds every append site", () => {
    // 10 call sites at the time of writing. The count is asserted loosely:
    // adding a site is fine, but it must satisfy the rules below.
    expect(bodies.length).toBeGreaterThanOrEqual(10);
  });

  it("PortfolioPricePoint carries rungLabel, and absence is NOT exact-pool", () => {
    expect(src).toMatch(/rungLabel\?: string;/);
    // The doctrine itself: an absent label can never read as corroborated.
    expect(isExactPoolRung(undefined)).toBe(false);
    expect(isExactPoolRung(null)).toBe(false);
    expect(isExactPoolRung("")).toBe(false);
    expect(isExactPoolRung("player-index-projection")).toBe(false);
    expect(isExactPoolRung("sibling-estimate")).toBe(false);
    expect(isExactPoolRung("exact-pool-projection")).toBe(true);
  });

  it("EVERY engine-priced site stamps a rung", () => {
    // A site is engine-priced when it writes a value the pricing engine
    // produced — identified here by the rung/FMV variables in scope.
    const enginePriced = bodies.filter(
      (b) =>
        b.includes("oneEntryFmv") ||
        b.includes("bFmv") ||
        b.includes("value: canonical") ||
        b.includes("gate.canonical") ||
        b.includes("fairMarketValueOverride"),
    );
    expect(enginePriced.length).toBe(5);
    for (const b of enginePriced) {
      expect(b).toMatch(/rungLabel/);
    }
  });

  it("the legacy reprice lane stamps NOTHING — it does not know its rung", () => {
    // It writes `fmvRung: null` onto the holding; a rung on the point would
    // be invented evidence. Absence is correct, and must stay deliberate.
    const legacy = bodies.filter((b) => b.includes("value: fairValue"));
    expect(legacy.length).toBe(1);
    expect(legacy[0]).not.toMatch(/rungLabel/);
    expect(src).toMatch(/does not know which\s*\n?\s*\/\/ rung produced `fairValue`/);
  });

  it("user-action sites (add / update / regrade) stamp no rung", () => {
    // A user typing a price is not a market read. These must never claim
    // an exact-pool rung.
    const userSites = bodies.filter(
      (b) =>
        b.includes('source: "add"') ||
        b.includes('source: "update"') ||
        b.includes('source: "regrade"'),
    );
    expect(userSites.length).toBe(4);
    for (const b of userSites) {
      expect(b).not.toMatch(/rungLabel/);
    }
  });

  it("MUTATION: a hardcoded exact-pool literal at an append site is a red", () => {
    // Guard the guard. Stamping a constant "exact-pool-*" instead of the
    // engine's own label would corroborate everything and rebuild the bug.
    for (const b of bodies) {
      expect(b).not.toMatch(/rungLabel:\s*["'`]exact-pool/);
    }
  });
});
