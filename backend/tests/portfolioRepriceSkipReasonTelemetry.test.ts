/**
 * CF-REPRICE-SKIP-REASON-TELEMETRY (2026-06-01) tests.
 *
 * Pre-CF the job aggregated per-holding skip reasons in `result.updates`
 * but discarded them — only the line-aggregate
 * `[portfolio.reprice.job] done users=N withHoldings=N requested=N
 * repriced=N skipped=N freshSkipped=N errors=N durationMs=N` made it to
 * telemetry, forcing per-holding archaeology via App Insights traces
 * (`[compiq.computeEstimate variant-mismatch guard tripped]` +
 * `cardsight.findComps.start` cross-references) to decompose the skip
 * rate.
 *
 * Post-CF the job emits one structured warn per skipped holding:
 *   { event: "portfolioReprice_skipped_holding",
 *     source: "portfolioReprice.job",
 *     userId, holdingId, cardsightCardId,
 *     verdict: "variant-mismatch" | "insufficient-comps"
 *            | "low-confidence" | "error",
 *     reason: <truncated to 500 chars> }
 *
 * Cardless-class entries (reason starts with "missing_card_identity")
 * are EXCLUDED: the identity CF's
 * `repriceHoldingsForUser_skipped_cardless` event already covers them
 * at the row level. Double-emit avoided to keep the skip-rate KQL's
 * decomposition clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __portfolioRepriceJobInternals } from "../src/jobs/portfolioReprice.job";

const { emitPerHoldingSkipEvents, verdictFromUpdate } =
  __portfolioRepriceJobInternals;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// Verdict mapping — pure function tests
// ────────────────────────────────────────────────────────────────────────────

describe("verdictFromUpdate — reason-string → verdict label mapping", () => {
  it('source=variant-mismatch in reason → "variant-mismatch"', () => {
    expect(
      verdictFromUpdate(
        "skipped",
        "confidence-gate: confidence=0<55, compsUsed=0<3, fairValue=0<=0 (source=variant-mismatch)",
      ),
    ).toBe("variant-mismatch");
  });

  it('source=no-recent-comps in reason → "insufficient-comps"', () => {
    expect(
      verdictFromUpdate(
        "skipped",
        "confidence-gate: compsUsed=0<3 (source=no-recent-comps, daysSinceNewestComp=null)",
      ),
    ).toBe("insufficient-comps");
  });

  it('compsUsed gate failed without explicit source → "insufficient-comps"', () => {
    expect(
      verdictFromUpdate(
        "skipped",
        "confidence-gate: compsUsed=1<3 (source=live)",
      ),
    ).toBe("insufficient-comps");
  });

  it('confidence gate failed only → "low-confidence"', () => {
    expect(
      verdictFromUpdate(
        "skipped",
        "confidence-gate: confidence=40<55 (source=live)",
      ),
    ).toBe("low-confidence");
  });

  it('status=error → "error" regardless of reason', () => {
    expect(verdictFromUpdate("error", "Cardsight timeout after 10s")).toBe(
      "error",
    );
    // Even with a variant-mismatch-looking string, error wins.
    expect(
      verdictFromUpdate("error", "source=variant-mismatch fallthrough"),
    ).toBe("error");
  });

  it('defensive fallback on unrecognized reason shape → "low-confidence"', () => {
    expect(verdictFromUpdate("skipped", "unrecognized-shape-from-future")).toBe(
      "low-confidence",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// emitPerHoldingSkipEvents — bounded payload + cardless exclusion
// ────────────────────────────────────────────────────────────────────────────

describe("emitPerHoldingSkipEvents — mixed-skip run", () => {
  it("emits exactly one event per non-cardless skip + none for repriced/fresh + does NOT double-emit cardless", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Simulate a 5-holding run: one variant-mismatch skip, one
    // insufficient-comps skip, one cardless skip (already emitted by
    // the identity CF's row-level safety net), one repriced, one fresh.
    emitPerHoldingSkipEvents("test-user-abc", [
      {
        id: "h-variant",
        status: "skipped",
        reason: "confidence-gate: confidence=0<55, compsUsed=0<3, fairValue=0<=0 (source=variant-mismatch)",
        cardsightCardId: "uuid-variant",
      },
      {
        id: "h-noComps",
        status: "skipped",
        reason: "confidence-gate: compsUsed=0<3 (source=no-recent-comps, daysSinceNewestComp=null)",
        cardsightCardId: "uuid-no-comps",
      },
      {
        id: "h-cardless",
        status: "skipped",
        reason: "missing_card_identity (cardYear=null AND cardsightCardId=null)",
        cardsightCardId: null,
      },
      {
        id: "h-repriced",
        status: "repriced",
      },
      {
        id: "h-fresh",
        status: "fresh",
      },
    ]);

    // Exactly 2 warn calls — variant-mismatch + insufficient-comps.
    // Cardless excluded (double-emit avoidance). Repriced + fresh excluded.
    const emits = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("portfolioReprice_skipped_holding"));
    expect(emits.length).toBe(2);

    // Parse the emitted JSONs and assert the per-event shape.
    const parsed = emits.map((s) => JSON.parse(s));

    const variantEvent = parsed.find((p) => p.holdingId === "h-variant");
    expect(variantEvent).toBeTruthy();
    expect(variantEvent.event).toBe("portfolioReprice_skipped_holding");
    expect(variantEvent.source).toBe("portfolioReprice.job");
    expect(variantEvent.userId).toBe("test-user-abc");
    expect(variantEvent.cardsightCardId).toBe("uuid-variant");
    expect(variantEvent.verdict).toBe("variant-mismatch");
    expect(variantEvent.reason).toMatch(/source=variant-mismatch/);

    const noCompsEvent = parsed.find((p) => p.holdingId === "h-noComps");
    expect(noCompsEvent).toBeTruthy();
    expect(noCompsEvent.verdict).toBe("insufficient-comps");
    expect(noCompsEvent.cardsightCardId).toBe("uuid-no-comps");

    // Cardless explicitly NOT in the emitted set.
    expect(parsed.find((p) => p.holdingId === "h-cardless")).toBeUndefined();
    // Repriced + fresh also not emitted.
    expect(parsed.find((p) => p.holdingId === "h-repriced")).toBeUndefined();
    expect(parsed.find((p) => p.holdingId === "h-fresh")).toBeUndefined();
  });

  it("status=error emits with verdict=error and truncates a long reason to 500 chars + suffix", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const longReason = "Cardsight upstream error: " + "x".repeat(800);
    emitPerHoldingSkipEvents("test-user-error", [
      {
        id: "h-error",
        status: "error",
        reason: longReason,
        cardsightCardId: "uuid-err",
      },
    ]);

    const emits = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("portfolioReprice_skipped_holding"));
    expect(emits.length).toBe(1);
    const parsed = JSON.parse(emits[0]);
    expect(parsed.verdict).toBe("error");
    expect(parsed.cardsightCardId).toBe("uuid-err");
    // Reason payload bounded — 500 char cap + truncation marker.
    expect(parsed.reason.length).toBe(500 + "...(truncated)".length);
    expect(parsed.reason.endsWith("...(truncated)")).toBe(true);
  });

  it("empty updates[] emits zero events (no false-positive emits)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitPerHoldingSkipEvents("user-no-work", []);
    const emits = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("portfolioReprice_skipped_holding"));
    expect(emits.length).toBe(0);
  });

  it("entries missing reason field still emit (defensive — verdict falls back to low-confidence)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitPerHoldingSkipEvents("user-no-reason", [
      { id: "h-no-reason", status: "skipped", cardsightCardId: "uuid-x" },
    ]);
    const emits = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("portfolioReprice_skipped_holding"));
    expect(emits.length).toBe(1);
    const parsed = JSON.parse(emits[0]);
    expect(parsed.verdict).toBe("low-confidence");
    expect(parsed.reason).toBe("");
  });

  it("entries with missing cardsightCardId emit cardsightCardId=null (not undefined or omitted)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitPerHoldingSkipEvents("user-no-csid", [
      {
        id: "h-no-csid",
        status: "skipped",
        reason: "confidence-gate: confidence=0<55 (source=live)",
        // cardsightCardId field omitted entirely
      },
    ]);
    const emits = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("portfolioReprice_skipped_holding"));
    expect(emits.length).toBe(1);
    const parsed = JSON.parse(emits[0]);
    expect(parsed.cardsightCardId).toBeNull();
  });
});
