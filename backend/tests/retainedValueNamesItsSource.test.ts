/**
 * CF-A-RETAINED-VALUE-IS-STILL-A-WRITE (C-8, 2026-09-03).
 *
 * The confidence-gated skip branch in `repriceHoldingsForUser` does not
 * re-derive a number — it keeps the one already on the holding and stamps a
 * fresh `lastUpdated`. Until now it did that by hand-spreading the holding
 * literal, which is how the shape C-7 abolished survived the C-7 deploy: a
 * value with no `valueSource` at all.
 *
 * Live proof, holding 277b05a3 (Cal Ripken Jr., PSA 8), read read-only from
 * prod after reprice run 33807265583 on deploy 6acd213 — the deploy that made
 * `valueSource` a required parameter at every lane:
 *
 *     fairMarketValue        49.99
 *     fmvRung                "exact-pool-weighted-median"
 *     pricingSourceMeta      {slug, method, compsUsed: 41}  <- no confidence
 *     valueSource            (key ABSENT)
 *     verdict                "Insufficient comps"
 *     lastUpdated            2026-09-03T21:20:02Z   <- the skip branch
 *     sourceVendorUpdatedAt  2026-09-03T15:50:14Z   <- the real pricer, 5h30 earlier
 *
 * #1683 made the three C-7 fields required arguments, so no lane could DROP
 * them — but a lane that never calls the helper at all is not reached by a
 * required parameter. The three sibling rows repriced in the same run's 21:24Z
 * wave (Griffey, Maddux, Figueroa) all went through the helper and all carry
 * `valueSource` and a confidence; only rows that took the skip branch do not.
 *
 * The rule these pins encode: freshening `lastUpdated` is a CLAIM about the
 * row, a claim is a write, and a write names its source. A retention is
 * declared — never silent, and never upgraded.
 */
import { describe, expect, it } from "vitest";

import {
  writeHoldingValuation,
  type HoldingValuationWrite,
} from "../src/services/portfolioiq/writeHoldingValuation.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const NOW = "2026-09-03T22:00:00.000Z";

/**
 * The retention decision exactly as the skip branch makes it. Kept in the test
 * as a transcription of the branch so the SEMANTICS are pinned even though the
 * branch itself is inline in a 1,400-line function: what it carries forward,
 * what it refuses to invent, and what it records.
 */
function retentionWrite(holding: PortfolioHolding, failed: string[], estSource: string): PortfolioHolding {
  const keptFmv = typeof holding.fairMarketValue === "number" && Number.isFinite(holding.fairMarketValue)
    ? holding.fairMarketValue
    : null;
  const priorRung = typeof (holding as { fmvRung?: unknown }).fmvRung === "string"
    && (holding as { fmvRung?: string }).fmvRung
    ? (holding as { fmvRung: string }).fmvRung
    : null;
  const priorValueSource = (holding as { valueSource?: unknown }).valueSource;
  const priorMeta = (holding as { pricingSourceMeta?: Record<string, unknown> }).pricingSourceMeta;
  const priorConfidence = typeof priorMeta?.confidence === "number" && Number.isFinite(priorMeta.confidence)
    ? (priorMeta.confidence as number)
    : null;
  const retentionReason =
    `value retained unchanged by the confidence-gated reprice (${failed.join(", ")}; source=${estSource || "ok"})`;
  const w: HoldingValuationWrite = {
    fairMarketValue: keptFmv,
    rung: priorRung
      ? { rung: priorRung }
      : { noRung: `${retentionReason}; the prior pass named no rung` },
    valueSource: priorValueSource === "observed" || priorValueSource === "estimated"
      ? priorValueSource
      : "estimated",
    nowIso: NOW,
    ...(priorMeta
      ? {
          meta: {
            slug: typeof priorMeta.slug === "string" ? priorMeta.slug : null,
            compsUsed: typeof priorMeta.compsUsed === "number" ? priorMeta.compsUsed : null,
            confidence: priorConfidence,
          },
        }
      : { writeMeta: false }),
    fields: {
      verdict: "Insufficient comps",
      recommendation: "Hold",
      fmvRetainedReason: retentionReason,
      fmvRetainedAt: NOW,
    } as Partial<PortfolioHolding> & Record<string, unknown>,
  };
  return writeHoldingValuation(holding, w);
}

/** The Ripken row as it actually sits in prod: no `valueSource` key at all. */
const ripken = (): PortfolioHolding => ({
  id: "277b05a3-935f-451a-b5b7-97eb926a3542",
  playerName: "Cal Ripken, Jr.",
  fairMarketValue: 49.99,
  fmvRung: "exact-pool-weighted-median",
  pricingSourceMeta: {
    slug: "1675907831540x230095593572250400",
    method: "exact-pool-weighted-median",
    compsUsed: 41,
  },
  valuationStatus: "observed",
  quantity: 1,
} as unknown as PortfolioHolding);

describe("a retained value names its source (holding 277b05a3)", () => {
  it("the live defect: the row it starts from carries NO valueSource key", () => {
    // Guards the premise. If this ever fails, the fixture drifted from the
    // shape the fix is about and the pins below stop meaning anything.
    expect("valueSource" in (ripken() as object)).toBe(false);
  });

  it("a retention writes valueSource — the shape #1683 could not reach", () => {
    const out = retentionWrite(ripken(), ["compsUsed=0<3"], "no-recent-comps");
    expect(out.valueSource).toBeDefined();
    expect(out.valueSource).not.toBeNull();
    expect(["observed", "estimated"]).toContain(out.valueSource);
  });

  it("the number and its rung are carried forward unchanged — a retention keeps, never re-derives", () => {
    const out = retentionWrite(ripken(), ["compsUsed=0<3"], "no-recent-comps");
    expect(out.fairMarketValue).toBe(49.99);
    expect(out.fmvRung).toBe("exact-pool-weighted-median");
    expect((out.pricingSourceMeta as { method?: string })?.method).toBe("exact-pool-weighted-median");
  });

  it("a value whose prior pass claimed nothing is NOT upgraded to observed", () => {
    // The honest direction is downward. This branch verified nothing, so it
    // may not promote an unlabelled number to a market observation — that is
    // exactly the conflation C-7 exists to stop.
    const out = retentionWrite(ripken(), ["compsUsed=0<3"], "no-recent-comps");
    expect(out.valueSource).toBe("estimated");
  });

  it("a prior 'observed' is preserved, not downgraded — the evidence did not vanish", () => {
    const griffey = {
      ...ripken(),
      fairMarketValue: 1850,
      fmvRung: "exact-pool-last-sale",
      valueSource: "observed",
      pricingSourceMeta: { slug: "hiq:...", method: "exact-pool-last-sale", compsUsed: 39, confidence: 1 },
    } as unknown as PortfolioHolding;
    const out = retentionWrite(griffey, ["compsUsed=0<3"], "no-recent-comps");
    expect(out.valueSource).toBe("observed");
    expect((out.pricingSourceMeta as { confidence?: number })?.confidence).toBe(1);
  });

  it("no confidence is invented: absent stays null, present is carried", () => {
    const kept = retentionWrite(ripken(), ["compsUsed=0<3"], "no-recent-comps");
    // The helper omits a null confidence from the meta rather than writing a
    // number nobody computed. What must never happen is a fabricated value.
    expect((kept.pricingSourceMeta as { confidence?: unknown })?.confidence ?? null).toBeNull();

    const withConf = retentionWrite(
      { ...ripken(), pricingSourceMeta: { slug: "s", method: "m", compsUsed: 4, confidence: 0.33 } } as unknown as PortfolioHolding,
      ["compsUsed=0<3"],
      "no-recent-comps",
    );
    expect((withConf.pricingSourceMeta as { confidence?: number })?.confidence).toBeCloseTo(0.33, 5);
  });

  it("the retention is RECORDED on the row, so a fresh lastUpdated is explainable", () => {
    const out = retentionWrite(ripken(), ["compsUsed=0<3"], "no-recent-comps");
    const anyOut = out as unknown as Record<string, unknown>;
    expect(anyOut.fmvRetainedReason).toMatch(/retained unchanged/);
    expect(anyOut.fmvRetainedReason).toMatch(/no-recent-comps/);
    expect(anyOut.fmvRetainedAt).toBe(NOW);
    expect(out.lastUpdated).toBe(NOW);
  });

  it("a retention over a rung-less value states the absence instead of leaving it blank", () => {
    const noRung = { ...ripken(), fmvRung: null } as unknown as PortfolioHolding;
    const out = retentionWrite(noRung, ["confidence=12<40"], "low-confidence");
    expect(out.fmvRung).toBeNull();
    expect((out as unknown as Record<string, unknown>).fmvRungAbsentReason)
      .toMatch(/named no rung/);
  });

  it("an unpriced holding retains null — a retention invents no number", () => {
    const unpriced = { ...ripken(), fairMarketValue: null } as unknown as PortfolioHolding;
    const out = retentionWrite(unpriced, ["fairValue=0<=0"], "no-recent-comps");
    expect(out.fairMarketValue).toBeNull();
  });
});
