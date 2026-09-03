// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): the pins.
//
// Drew named five things this feature has to get right. Each is a describe
// block below, and each asserts the BEHAVIOUR (fire / don't fire, and what
// the user is told), not the implementation:
//
//   1. threshold fire / non-fire
//   2. direction
//   3. speculative labeling
//   4. rate limit
//   5. no double-fire on an idempotent reprice

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideFire,
  fireFingerprint,
  formatMoveAlert,
  normalizeRuleInput,
  DEFAULT_DAILY_CAP,
  type HoldingMoveRule,
  type ValueObservation,
} from "../src/services/advancedAlerts/holdingMoveRule.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function rule(over: Partial<HoldingMoveRule> = {}): HoldingMoveRule {
  return {
    ruleId: "r1",
    userId: "u1",
    holdingId: "h1",
    thresholdPct: 10,
    direction: "any",
    windowHours: 48,
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastFiredValue: null,
    lastFiredRung: null,
    lastFiredAt: null,
    lastFiredFingerprint: null,
    triggerCount: 0,
    ...over,
  };
}

/** An observation on an exact-pool rung — a real sale of this card+grade. */
function observed(value: number | null, hoursAgo = 1): ValueObservation {
  return {
    value,
    rungLabel: "exact-pool-projection",
    at: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  };
}

/** An observation on a fallback rung — evidence, but not this card+grade. */
function speculative(value: number | null, hoursAgo = 1): ValueObservation {
  return {
    value,
    rungLabel: "player-index-projection",
    at: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  };
}

afterEach(() => {
  delete process.env.HOLDING_MOVE_ALERT_DAILY_CAP;
});

// ─── PIN 1: threshold fire / non-fire ───────────────────────────────────────

describe("PIN threshold", () => {
  it("fires when the move exceeds the threshold", () => {
    const d = decideFire(rule({ thresholdPct: 10 }), observed(100, 2), observed(115), 0, NOW);
    expect(d.fire).toBe(true);
    expect(d.movePct).toBeCloseTo(15, 6);
  });

  it("does NOT fire when the move is under the threshold", () => {
    const d = decideFire(rule({ thresholdPct: 10 }), observed(100, 2), observed(109), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("below-threshold");
    // The move is still measured on a non-fire — the caller logs it.
    expect(d.movePct).toBeCloseTo(9, 6);
  });

  it("fires exactly AT the threshold (>= not >)", () => {
    const d = decideFire(rule({ thresholdPct: 10 }), observed(100, 2), observed(110), 0, NOW);
    expect(d.fire).toBe(true);
  });

  it("measures magnitude, so a 10% rule fires on a -12% move", () => {
    const d = decideFire(rule({ thresholdPct: 10 }), observed(100, 2), observed(88), 0, NOW);
    expect(d.fire).toBe(true);
    expect(d.movePct).toBeCloseTo(-12, 6);
  });

  it("does not fire without a baseline — it establishes one silently", () => {
    const d = decideFire(rule(), observed(null, 2), observed(150), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no-baseline");
  });

  it("does not fire when the current value is unpriced", () => {
    const d = decideFire(rule(), observed(100, 2), observed(null), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("unpriced");
  });

  it("does not fire on a baseline older than the window", () => {
    const d = decideFire(
      rule({ windowHours: 24 }),
      observed(100, 72), // 3 days back, window is 1 day
      observed(150),
      0,
      NOW,
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("stale-baseline");
  });

  it("fires on a slow drift that no single reprice would have tripped", () => {
    // The baseline is the last ALERTED value, not the last reprice, so a
    // 4%-per-tick drift across a 48h window still reaches 12%.
    const d = decideFire(rule({ thresholdPct: 10, windowHours: 48 }), observed(100, 40), observed(112), 0, NOW);
    expect(d.fire).toBe(true);
  });
});

// ─── PIN 2: direction ───────────────────────────────────────────────────────

describe("PIN direction", () => {
  it("an 'up' rule fires on a rise", () => {
    expect(decideFire(rule({ direction: "up" }), observed(100, 2), observed(120), 0, NOW).fire).toBe(true);
  });

  it("an 'up' rule does NOT fire on a fall, however large", () => {
    const d = decideFire(rule({ direction: "up" }), observed(100, 2), observed(40), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("wrong-direction");
  });

  it("a 'down' rule fires on a fall", () => {
    expect(decideFire(rule({ direction: "down" }), observed(100, 2), observed(80), 0, NOW).fire).toBe(true);
  });

  it("a 'down' rule does NOT fire on a rise, however large", () => {
    const d = decideFire(rule({ direction: "down" }), observed(100, 2), observed(300), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("wrong-direction");
  });

  it("an 'any' rule fires in both directions", () => {
    expect(decideFire(rule({ direction: "any" }), observed(100, 2), observed(120), 0, NOW).fire).toBe(true);
    expect(decideFire(rule({ direction: "any" }), observed(100, 2), observed(80), 0, NOW).fire).toBe(true);
  });
});

// ─── PIN 3: speculative labeling ────────────────────────────────────────────

describe("PIN speculative labeling", () => {
  it("a move between two exact-pool rungs is OBSERVED", () => {
    const d = decideFire(rule(), observed(100, 2), observed(120), 0, NOW);
    expect(d.fire).toBe(true);
    expect(d.observed).toBe(true);
  });

  it("a move whose CURRENT end is a fallback rung is not observed", () => {
    const d = decideFire(rule(), observed(100, 2), speculative(120), 0, NOW);
    expect(d.observed).toBe(false);
  });

  it("a move whose BASELINE end is a fallback rung is not observed", () => {
    const d = decideFire(rule(), speculative(100, 2), observed(120), 0, NOW);
    expect(d.observed).toBe(false);
  });

  it("a speculative move still FIRES — labeled, never suppressed", () => {
    // PUBLISH + LABEL: the user asked to hear about a 10% move and it moved.
    const d = decideFire(rule(), speculative(100, 2), speculative(130), 0, NOW);
    expect(d.fire).toBe(true);
    expect(d.observed).toBe(false);
  });

  it("the alert text SAYS SO when the move is speculative", () => {
    const d = decideFire(rule(), speculative(100, 2), speculative(130), 0, NOW);
    const msg = formatMoveAlert(rule(), "Bobby Witt Jr", "2019 Bowman Chrome #BCP-100", d, 100, 130);
    expect(msg.body).toContain("Estimated");
    expect(msg.body).toMatch(/no recent sale of this exact card/i);
  });

  it("the alert text does NOT hedge when the move is observed", () => {
    const d = decideFire(rule(), observed(100, 2), observed(130), 0, NOW);
    const msg = formatMoveAlert(rule(), "Bobby Witt Jr", "2019 Bowman Chrome #BCP-100", d, 100, 130);
    expect(msg.body).not.toContain("Estimated");
  });

  it("quotes the BASIS — both dollar values, not a bare percentage", () => {
    const d = decideFire(rule(), observed(100, 2), observed(130), 0, NOW);
    const msg = formatMoveAlert(rule(), "Bobby Witt Jr", "2019 Bowman Chrome #BCP-100", d, 100, 130);
    expect(msg.body).toContain("$100.00");
    expect(msg.body).toContain("$130.00");
    expect(msg.title).toContain("30.0%");
  });

  it("a fire whose baseline rung was a fallback is NOT observed, even when the current end is exact-pool", () => {
    // Regression: the baseline rung must come from the rung STORED with the
    // last fire, not from whatever the holding's rung happens to be now. A
    // card that was priced off a player index last week and off its own pool
    // today has not been observed to move — the basis changed underneath it.
    const carried = rule({
      lastFiredValue: 100,
      lastFiredRung: "player-index-projection",
      lastFiredAt: new Date(NOW - 3600_000).toISOString(),
      lastFiredFingerprint: "stale-fp",
    });
    const d = decideFire(
      carried,
      { value: 100, rungLabel: carried.lastFiredRung, at: carried.lastFiredAt! },
      observed(130),
      0,
      NOW,
    );
    expect(d.fire).toBe(true);
    expect(d.observed).toBe(false);
  });

  it("an unknown / missing rung is treated as NOT observed", () => {
    const d = decideFire(
      rule(),
      { value: 100, rungLabel: null, at: new Date(NOW - 7200_000).toISOString() },
      { value: 130, rungLabel: undefined, at: new Date(NOW).toISOString() },
      0,
      NOW,
    );
    expect(d.observed).toBe(false);
  });
});

// ─── PIN 4: rate limit ──────────────────────────────────────────────────────

describe("PIN rate limit", () => {
  it("fires while under the cap", () => {
    const d = decideFire(rule(), observed(100, 2), observed(130), DEFAULT_DAILY_CAP - 1, NOW);
    expect(d.fire).toBe(true);
  });

  it("does NOT fire at the cap", () => {
    const d = decideFire(rule(), observed(100, 2), observed(130), DEFAULT_DAILY_CAP, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("rate-limited");
  });

  it("does not fire above the cap", () => {
    const d = decideFire(rule(), observed(100, 2), observed(130), DEFAULT_DAILY_CAP + 50, NOW);
    expect(d.reason).toBe("rate-limited");
  });

  it("honours HOLDING_MOVE_ALERT_DAILY_CAP", () => {
    process.env.HOLDING_MOVE_ALERT_DAILY_CAP = "2";
    expect(decideFire(rule(), observed(100, 2), observed(130), 1, NOW).fire).toBe(true);
    expect(decideFire(rule(), observed(100, 2), observed(130), 2, NOW).fire).toBe(false);
  });

  it("the rate limit is checked AFTER the move is measured", () => {
    // A suppressed fire still reports what it would have said, so the
    // telemetry can show what a user missed to their cap.
    const d = decideFire(rule(), observed(100, 2), observed(130), DEFAULT_DAILY_CAP, NOW);
    expect(d.movePct).toBeCloseTo(30, 6);
    expect(d.fingerprint).not.toBeNull();
  });
});

// ─── PIN 5: no double-fire on an idempotent reprice ─────────────────────────

describe("PIN no double-fire on idempotent reprice", () => {
  it("does not re-fire when the same pair is re-observed", () => {
    const first = decideFire(rule(), observed(100, 2), observed(130), 0, NOW);
    expect(first.fire).toBe(true);

    // The reprice runs again over an unchanged market: same baseline, same
    // value, same rung. The rule now carries the fingerprint of the fire.
    const after = rule({
      lastFiredValue: 130,
      lastFiredRung: "exact-pool-projection",
      lastFiredAt: new Date(NOW).toISOString(),
      lastFiredFingerprint: first.fingerprint,
    });
    const second = decideFire(after, observed(100, 2), observed(130), 1, NOW);
    expect(second.fire).toBe(false);
    expect(second.reason).toBe("duplicate");
  });

  it("DOES fire again when the value moves further", () => {
    const first = decideFire(rule(), observed(100, 2), observed(130), 0, NOW);
    const after = rule({
      lastFiredValue: 130,
      lastFiredRung: "exact-pool-projection",
      lastFiredAt: new Date(NOW).toISOString(),
      lastFiredFingerprint: first.fingerprint,
    });
    // New baseline is the quoted 130; a further move to 150 is +15.4%.
    const second = decideFire(after, observed(130, 1), observed(150), 1, NOW);
    expect(second.fire).toBe(true);
    expect(second.reason).toBeNull();
  });

  it("float noise re-derives to the SAME fingerprint", () => {
    // 41.20000000000001 is the same observation as 41.20.
    expect(fireFingerprint("h1", 40, 41.20000000000001, "exact-pool-projection")).toBe(
      fireFingerprint("h1", 40, 41.2, "exact-pool-projection"),
    );
  });

  it("a different rung on the same numbers is a DIFFERENT fingerprint", () => {
    // The number stopped coming from the exact pool — that is new
    // information about the basis even though the dollar value matches.
    expect(fireFingerprint("h1", 100, 130, "exact-pool-projection")).not.toBe(
      fireFingerprint("h1", 100, 130, "player-index-projection"),
    );
  });

  it("a different holding is a different fingerprint", () => {
    expect(fireFingerprint("h1", 100, 130, "exact-pool-projection")).not.toBe(
      fireFingerprint("h2", 100, 130, "exact-pool-projection"),
    );
  });

  it("an inactive rule never fires", () => {
    const d = decideFire(rule({ isActive: false }), observed(100, 2), observed(500), 0, NOW);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("inactive");
  });
});

// ─── Input normalization ────────────────────────────────────────────────────

describe("normalizeRuleInput", () => {
  it("accepts a well-formed body", () => {
    expect(normalizeRuleInput({ thresholdPct: 15, direction: "down", windowHours: 72 })).toEqual({
      thresholdPct: 15,
      direction: "down",
      windowHours: 72,
    });
  });

  it("defaults direction to any and window to 24h", () => {
    expect(normalizeRuleInput({ thresholdPct: 10 })).toEqual({
      thresholdPct: 10,
      direction: "any",
      windowHours: 24,
    });
  });

  it("takes the magnitude of a negative threshold", () => {
    // "-10" from a UI that encodes a downward move in the sign still means
    // a 10% rule; `direction` is where down-ness belongs.
    expect(normalizeRuleInput({ thresholdPct: -10 })?.thresholdPct).toBe(10);
  });

  it("rejects an out-of-range threshold", () => {
    expect(normalizeRuleInput({ thresholdPct: 0 })).toBeNull();
    expect(normalizeRuleInput({ thresholdPct: 100000 })).toBeNull();
    expect(normalizeRuleInput({ thresholdPct: "lots" })).toBeNull();
  });

  it("clamps the window rather than rejecting it", () => {
    expect(normalizeRuleInput({ thresholdPct: 10, windowHours: 0 })?.windowHours).toBe(1);
    expect(normalizeRuleInput({ thresholdPct: 10, windowHours: 99999 })?.windowHours).toBe(24 * 90);
  });

  it("falls back to 'any' on an unrecognized direction", () => {
    expect(normalizeRuleInput({ thresholdPct: 10, direction: "sideways" })?.direction).toBe("any");
  });

  it("rejects a non-object body", () => {
    expect(normalizeRuleInput(null)).toBeNull();
    expect(normalizeRuleInput("10%")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. The rule row is its OWN feed type.
//
// The pre-existing hardcoded 10%/18% emitter (evaluateHoldingAlerts) writes
// type "value-move", and it runs inside the holding loop of
// repriceHoldingsForUser — ABOVE the rule sweep, in the SAME pass. addAlert
// dedups on (holdingId, type) within 6h. So when both fire on one holding,
// a shared type means the legacy row wins and the user's rule row — its rule
// text, its basis, its speculative label — is silently dropped from the feed.
//
// The pin reads the REAL emitter out of portfolioStore.service.ts, so
// reverting the type to "value-move" reds it.
describe("the rule-driven feed row survives a legacy value-move in the same pass", () => {
  const storeSrc = readFileSync(
    new URL("../src/services/portfolioiq/portfolioStore.service.ts", import.meta.url),
    "utf8",
  );

  /** addAlert's dedup rule, verbatim from portfolioStore.service.ts. */
  type FeedRow = { id: string; createdAt: string; holdingId: string; type: string; message: string };
  function addAlert(doc: { alerts: FeedRow[] }, alert: Omit<FeedRow, "id" | "createdAt">): void {
    const now = new Date().toISOString();
    const lastSimilar = [...doc.alerts]
      .reverse()
      .find((a) => a.holdingId === alert.holdingId && a.type === alert.type);
    if (lastSimilar) {
      const lastTime = new Date(lastSimilar.createdAt).getTime();
      const currentTime = new Date(now).getTime();
      if (Number.isFinite(lastTime) && Number.isFinite(currentTime) && currentTime - lastTime < 6 * 3600_000) {
        return;
      }
    }
    doc.alerts.push({ ...alert, id: String(doc.alerts.length + 1), createdAt: now });
  }

  /** The type string the rule sweep actually passes to addAlert. */
  function ruleSweepFeedType(): string {
    const anchor = storeSrc.indexOf("outcome.feedAlert.level");
    expect(anchor, "rule sweep addAlert call not found").toBeGreaterThan(-1);
    const m = /type:\s*"([a-z-]+)"/.exec(storeSrc.slice(anchor, anchor + 400));
    expect(m, "no type on the rule sweep addAlert call").not.toBeNull();
    return m![1];
  }

  it("the legacy emitter still writes value-move", () => {
    // Guards the premise: if the legacy type ever changes, this pin's
    // reasoning has to be revisited rather than silently passing.
    const anchor = storeSrc.indexOf("function evaluateHoldingAlerts");
    expect(anchor).toBeGreaterThan(-1);
    expect(storeSrc.slice(anchor, anchor + 2500)).toContain('type: "value-move"');
  });

  it("the rule sweep does NOT reuse the legacy type", () => {
    expect(ruleSweepFeedType()).not.toBe("value-move");
  });

  it("legacy + rule on the SAME holding in one pass yields BOTH feed rows", () => {
    const doc = { alerts: [] as FeedRow[] };
    // The legacy 10%/18% emitter fires first — it runs above the sweep.
    addAlert(doc, { holdingId: "h1", type: "value-move", message: "Judge moved +12.0% (100 -> 112)." });
    // Then the user's rule fires on that same holding, with the real type.
    addAlert(doc, {
      holdingId: "h1",
      type: ruleSweepFeedType(),
      message: "Your 10% rule fired — +12.0% over 24h.",
    });
    // Both land. Revert the type to "value-move" and this drops to 1.
    expect(doc.alerts).toHaveLength(2);
    expect(doc.alerts.map((a) => a.message)).toEqual([
      "Judge moved +12.0% (100 -> 112).",
      "Your 10% rule fired — +12.0% over 24h.",
    ]);
  });

  it("the rule type still dedups against ITSELF within 6h", () => {
    // The distinct type must not cost the rule its own rate guard.
    const doc = { alerts: [] as FeedRow[] };
    const t = ruleSweepFeedType();
    addAlert(doc, { holdingId: "h1", type: t, message: "first" });
    addAlert(doc, { holdingId: "h1", type: t, message: "second" });
    expect(doc.alerts).toHaveLength(1);
    expect(doc.alerts[0].message).toBe("first");
  });

  it("the new type is declared on the PortfolioAlert union", () => {
    // An emitter writing a type the union does not carry would not compile,
    // but the union is also what every reader switches on. Pin both.
    expect(storeSrc).toContain(`| "${ruleSweepFeedType()}"`);
  });
});
