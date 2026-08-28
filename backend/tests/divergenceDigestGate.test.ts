// CF-DIGEST-IS-FOR-MARKET-MOVES (Drew, 2026-08-28). The divergence digest
// exists to surface MARKET moves. A divergence whose price came from a
// fallback rung is an engine bug report — telemetry, never an email. The
// Hartman case is the regression: engine $339 vs cost $2,325, priced by a
// dilutive sibling rung — that must be suppressed; the same divergence priced
// by the exact pool must still fire.
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCostBasisDivergenceIfNoteworthy,
  drainDivergenceAlerts,
} from "../src/services/compiq/boundedProjectionAlerts.service.js";

const base = {
  userId: "user-test",
  holdingId: "h1",
  cardTitle: "Hartman Gold Refractor Auto PSA 9",
  slug: "hiq:baseball:2024:bowman-chrome:cpa-eha:gold-refractor:auto",
  costBasis: 2325,
  fmv: 339,
  fmvMethod: null as string | null,
  fmvBasisNote: null as string | null,
  fmvCompCount: null as number | null,
};

beforeEach(() => { drainDivergenceAlerts(); });

describe("CF-DIGEST-IS-FOR-MARKET-MOVES", () => {
  it("HARTMAN: a fallback-rung price never reaches the digest", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "sibling-parallel",
      fmvBasisNote: "composed anchor via brand-family proxy",
    });
    expect(fired).toBe(false);
    expect(drainDivergenceAlerts()).toHaveLength(0);
  });

  it("a unified exact-pool price DOES fire on a real market move", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "unified-market-value",
      fmvBasisNote: "unified: window=180d ...",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()).toHaveLength(1);
  });

  it("an exact-pool-supremacy tier price also fires", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "graded-projection",
      fmvBasisNote: "exact-pool supremacy: 130 comps on this exact card+grade; superseded [legacy]",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()).toHaveLength(1);
  });

  it("thresholds still gate first: small deltas never fire regardless of method", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      costBasis: 100, fmv: 90,   // -10%, $10 — under both thresholds
      fmvMethod: "unified-market-value",
    });
    expect(fired).toBe(false);
  });
});
