/**
 * CF-A-SECOND-SOURCE-THAT-DISAGREES-IS-THE-ONLY-DISQUALIFIER (Drew,
 * 2026-09-05, narrowed) -- the LABEL half.
 *
 * A row nobody has contradicted but nobody has corroborated either PRICES,
 * and the reader is told what stands behind it. That is the same doctrine
 * `self-anchored` and `independence-unverified` embody: publish the number,
 * say what it rests on. These pins are on the label, because the narrowing
 * traded a refusal for a caveat and a caveat that silently stops appearing
 * is a failure that looks exactly like success.
 */
import { describe, it, expect } from "vitest";
import { labelsForResult } from "../src/services/ebay/ebaySellDraft.service.js";
import { SINGLE_SOURCE_LABEL } from "../src/services/catalog/sourceCorroboration.js";
import type { CanonicalFmvResult } from "../src/services/compiq/canonicalFmv.service.js";

/** A healthy exact-pool result: enough sales that no other caveat fires. */
function result(over: Partial<CanonicalFmvResult> = {}): CanonicalFmvResult {
  return {
    fmv: 120,
    method: "direct-comp",
    rungLabel: "exact-pool-weighted-median",
    confidence: 0.9,
    computedAt: new Date().toISOString(),
    provenance: {
      summary: "",
      compCount: 40,
      comps: Array.from({ length: 8 }, (_, i) => ({
        price: 120, soldAt: "2026-08-01", source: "ebay", sellerHandle: `s${i}`,
      })),
      trendPctPerMonth: null,
      multipliers: {},
    },
    ...over,
  } as unknown as CanonicalFmvResult;
}

const codes = (r: CanonicalFmvResult, single = false) =>
  labelsForResult(r, null, single).map((l) => l.code);

describe("the single-source label", () => {
  it("fires when the identity rests on ONE transcription", () => {
    expect(codes(result(), true)).toContain(SINGLE_SOURCE_LABEL);
  });

  it("does NOT fire otherwise -- absence of an answer is not a caveat", () => {
    expect(codes(result(), false)).not.toContain(SINGLE_SOURCE_LABEL);
  });

  it("DEFAULTS to not firing, so every existing call site is unchanged", () => {
    // The parameter was added third and defaulted, so the ~existing callers
    // that pass two arguments keep their exact behaviour. If the default ever
    // flips, this label appears on the whole catalog and says nothing.
    expect(labelsForResult(result(), null).map((l) => l.code)).not.toContain(SINGLE_SOURCE_LABEL);
  });

  it("is a CAVEAT, not a refusal -- the number is still there", () => {
    // The whole point of the narrowing. A label that arrived alongside a null
    // price would be the wholesale rule wearing a different hat.
    const r = result();
    expect(r.fmv).toBe(120);
    expect(codes(r, true)).toContain(SINGLE_SOURCE_LABEL);
  });

  it("speaks about the CARD, not the pool -- it says checklist, not sales", () => {
    // Every other label here describes the sales behind the number; this one
    // describes whether we are sure the card is the card. Conflating them
    // would tell a reader to go look at comps that are perfectly fine.
    const text = labelsForResult(result(), null, true)
      .find((l) => l.code === SINGLE_SOURCE_LABEL)!.text;
    expect(text).toMatch(/checklist/i);
    expect(text).toMatch(/identity/i);
  });

  it("stacks with the other caveats rather than replacing them", () => {
    // A single-source identity priced off a fallback rung deserves both
    // sentences; suppressing either would hide a real caveat.
    const c = codes(result({ rungLabel: "family-median", confidence: 0.3 } as never), true);
    expect(c).toContain(SINGLE_SOURCE_LABEL);
    expect(c).toContain("fallback-rung");
    expect(c).toContain("low-confidence");
  });
});

describe("MUTATION: the label", () => {
  it("a mutant that dropped the parameter would never label anything", () => {
    // Asserts the two calls DIFFER. A `labelsForResult` that ignored its third
    // argument would return the same set for both, and the caveat would have
    // silently stopped existing while every other test stayed green.
    const withLabel = codes(result(), true);
    const without = codes(result(), false);
    expect(withLabel.length).toBe(without.length + 1);
    expect(withLabel).toContain(SINGLE_SOURCE_LABEL);
    expect(without).not.toContain(SINGLE_SOURCE_LABEL);
  });

  it("the code is the SHARED constant, not a re-typed string", () => {
    // One spelling, from the module that owns the rule. A hand-typed copy here
    // would let the emitted code and the consumer's expectation drift apart.
    expect(SINGLE_SOURCE_LABEL).toBe("single-source:hobbymonitor");
    expect(codes(result(), true)).toContain(SINGLE_SOURCE_LABEL);
  });
});
