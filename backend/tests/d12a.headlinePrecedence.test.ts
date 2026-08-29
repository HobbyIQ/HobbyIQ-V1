// CF-ONE-HEADLINE-CHAIN (2026-08-29, checklist D12a). #1432 aligned the
// holding's headline to `marketValue ?? predictedPrice ?? fmv` at four of the
// places portfolioStore reads a unified result. The "final authority"
// override at the end of autoPriceHolding still read predictedPrice first,
// and the priceSurfaceRung producer above it read `predictedPrice ?? fmv`
// with no marketValue at all — so the same holding could carry a different
// headline depending on which branch wrote last.
//
// The chains live inside a private function, so this is a source pin, the
// same way #1432 pinned that routes never write a grade-curve number: every
// `<unified>.x ?? <unified>.y` chain over marketValue / predictedPrice / fmv
// must read marketValue first, and there must be enough of them for the pin
// to mean something.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/services/portfolioiq/portfolioStore.service.ts", import.meta.url), "utf8");

/** Every chain of the form `r.a ?? r.b [?? r.c]` over the three headline
 *  fields on the same receiver, scanned line by line. Comment lines (the
 *  prose describes the OLD shapes) are skipped by prefix; a block-comment
 *  regex is not used because a `/*` inside code swallows half the file. */
function headlineChains(): string[] {
  const re = /\b([A-Za-z_]\w*)\.(marketValue|predictedPrice|fmv)!?\s*\?\?\s*\1\.(marketValue|predictedPrice|fmv)!?(?:\s*\?\?\s*\1\.(marketValue|predictedPrice|fmv)!?)?/g;
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    out.push(...(line.match(re) ?? []));
  }
  return out;
}

describe("the unified headline reads marketValue ?? predictedPrice ?? fmv everywhere", () => {
  it("there are at least eight chains — the pin is not vacuous", () => {
    expect(headlineChains().length).toBeGreaterThanOrEqual(8);
  });

  it("no chain reads predictedPrice before marketValue", () => {
    // Mutation check: restoring `predictedPrice ?? marketValue ?? fmv` at the
    // final-authority site puts two offenders in this list.
    const offenders = headlineChains().filter((c) => !/^\w+\.marketValue/.test(c));
    expect(offenders).toEqual([]);
  });

  it("every chain reaches fmv through marketValue", () => {
    const offenders = headlineChains().filter((c) => /\.fmv/.test(c) && !/\.marketValue/.test(c));
    expect(offenders).toEqual([]);
  });
});
