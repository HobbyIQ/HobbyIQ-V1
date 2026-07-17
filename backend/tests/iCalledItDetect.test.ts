// CF-SOCIAL-SURFACES (Drew, 2026-07-17): pinning tests for the "I Called
// It" detection layer. Pure — no Cosmos, no I/O.

import { describe, it, expect } from "vitest";
import {
  detectPurchaseAppreciated,
  detectAlertHit,
  buildShareablePayload,
  currentMarketValueOf,
  shortCardTitle,
  monthLabel,
  daysBetween,
  MOMENT_APPRECIATED_MULTIPLIER,
  MOMENT_DEPRECIATED_MULTIPLIER,
  MOMENT_MIN_HOLD_DAYS,
} from "../src/services/portfolioiq/iCalledItDetect.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import type { PriceAlert } from "../src/repositories/priceAlerts.repository.js";
import { detectMomentsFromInputs } from "../src/services/portfolioiq/iCalledItAnalyze.service.js";

// ── Fixture builders ────────────────────────────────────────────────────────
function daysAgo(n: number, now: Date = new Date("2026-07-17T12:00:00Z")): string {
  return new Date(now.getTime() - n * 86_400_000).toISOString();
}

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h1",
    playerName: "Eric Hartman",
    cardTitle: "2026 Bowman CPA-EHA Base Auto",
    cardNumber: "CPA-EHA",
    setName: "Bowman",
    cardYear: 2026,
    purchasePrice: 80,
    purchaseDate: daysAgo(75),
    fairMarketValue: 155,
    quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

function alert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    alertId: "a1",
    userId: "u1",
    cardId: "card-abc",
    playerName: "Eric Hartman",
    targetPrice: 100,
    direction: "above",
    currentPrice: 155,
    createdAt: daysAgo(45),
    triggeredAt: daysAgo(2),
    isActive: false,
    cardSnapshot: null,
    ...overrides,
  } as PriceAlert;
}

// ── Constants pin ───────────────────────────────────────────────────────────

describe("iCalledIt — thresholds pinned", () => {
  it("pins constants", () => {
    expect(MOMENT_APPRECIATED_MULTIPLIER).toBe(1.30);
    expect(MOMENT_DEPRECIATED_MULTIPLIER).toBe(0.70);
    expect(MOMENT_MIN_HOLD_DAYS).toBe(60);
  });
});

// ── Purchase-appreciated detector ───────────────────────────────────────────

describe("detectPurchaseAppreciated", () => {
  const now = new Date("2026-07-17T12:00:00Z");

  it("fires on 80→155 held 75 days (+94% gain, meets both guards)", () => {
    const m = detectPurchaseAppreciated(holding(), now);
    expect(m).not.toBeNull();
    expect(m!.eventType).toBe("purchase_appreciated");
    expect(m!.originalPrice).toBe(80);
    expect(m!.currentMarketValue).toBe(155);
    expect(m!.gainUsd).toBe(75);
    expect(m!.gainPct).toBeCloseTo(93.75, 1);
    expect(m!.player).toBe("Eric Hartman");
    expect(m!.shareablePayload.headline).toBe("+94% on Eric Hartman");
    expect(m!.shareablePayload.subline).toMatch(/Bought at \$80/);
    expect(m!.shareablePayload.subline).toMatch(/now \$155/);
    expect(m!.shareablePayload.cta).toBe("See the analysis");
  });

  it("blocks when hold days < 60 (30d hold, big gain still suppressed)", () => {
    const m = detectPurchaseAppreciated(
      holding({ purchaseDate: daysAgo(30, now) }),
      now,
    );
    expect(m).toBeNull();
  });

  it("blocks when currentMarketValue < 1.30× purchasePrice (25% gain suppressed)", () => {
    const m = detectPurchaseAppreciated(holding({ fairMarketValue: 100 }), now);
    expect(m).toBeNull();
  });

  it("fires at exactly 1.30× threshold (boundary — inclusive)", () => {
    const m = detectPurchaseAppreciated(
      holding({ purchasePrice: 100, fairMarketValue: 130 }),
      now,
    );
    expect(m).not.toBeNull();
    expect(m!.gainPct).toBe(30);
    expect(m!.gainUsd).toBe(30);
  });

  it("blocks when purchasePrice is missing/invalid", () => {
    expect(detectPurchaseAppreciated(holding({ purchasePrice: undefined }), now)).toBeNull();
    expect(detectPurchaseAppreciated(holding({ purchasePrice: 0 }), now)).toBeNull();
    expect(detectPurchaseAppreciated(holding({ purchasePrice: -5 }), now)).toBeNull();
  });

  it("blocks when purchaseDate is missing/unparseable", () => {
    expect(detectPurchaseAppreciated(holding({ purchaseDate: undefined }), now)).toBeNull();
    expect(detectPurchaseAppreciated(holding({ purchaseDate: "not-a-date" }), now)).toBeNull();
  });

  it("blocks when currentMarketValue is null (no FMV, no estimate)", () => {
    const m = detectPurchaseAppreciated(
      holding({ fairMarketValue: undefined, estimatedValue: null }),
      now,
    );
    expect(m).toBeNull();
  });

  it("falls back to estimatedValue when FMV absent", () => {
    const m = detectPurchaseAppreciated(
      holding({ fairMarketValue: undefined, estimatedValue: 200 }),
      now,
    );
    expect(m).not.toBeNull();
    expect(m!.currentMarketValue).toBe(200);
  });
});

// ── Alert-hit detector ──────────────────────────────────────────────────────

describe("detectAlertHit", () => {
  const now = new Date("2026-07-17T12:00:00Z");

  it("fires when triggeredAt is set and market is at/above target for direction=above", () => {
    const m = detectAlertHit(holding(), alert(), now);
    expect(m).not.toBeNull();
    expect(m!.eventType).toBe("alert_hit");
    expect(m!.originalPrice).toBe(100);   // targetPrice, NOT purchase price
    expect(m!.currentMarketValue).toBe(155);
    expect(m!.gainUsd).toBe(55);
    expect(m!.gainPct).toBe(55);
    expect(m!.shareablePayload.subline).toMatch(/Alerted at \$100/);
  });

  it("blocks when triggeredAt is null (alert never fired)", () => {
    expect(detectAlertHit(holding(), alert({ triggeredAt: null }), now)).toBeNull();
  });

  it("fires for direction=below when market is at/below target", () => {
    const h = holding({ fairMarketValue: 50 });
    const a = alert({ direction: "below", targetPrice: 60 });
    const m = detectAlertHit(h, a, now);
    expect(m).not.toBeNull();
    expect(m!.gainUsd).toBe(-10);
    expect(m!.gainPct).toBeCloseTo(-16.67, 1);
  });

  it("blocks direction=above when market has reversed back BELOW target (stale flex)", () => {
    // triggered at some point but the current price has fallen below target
    expect(
      detectAlertHit(holding({ fairMarketValue: 80 }), alert({ direction: "above", targetPrice: 100 }), now),
    ).toBeNull();
  });

  it("blocks direction=below when market has reversed back ABOVE target", () => {
    expect(
      detectAlertHit(
        holding({ fairMarketValue: 200 }),
        alert({ direction: "below", targetPrice: 60, triggeredAt: daysAgo(3, now) }),
        now,
      ),
    ).toBeNull();
  });

  it("uses alert.playerName when set, else holding.playerName", () => {
    const m = detectAlertHit(
      holding({ playerName: "Fallback Player" }),
      alert({ playerName: "" }),
      now,
    );
    expect(m).not.toBeNull();
    expect(m!.player).toBe("Fallback Player");
  });
});

// ── Payload + shape helpers ─────────────────────────────────────────────────

describe("buildShareablePayload", () => {
  it("formats headline as +N% on Player, rounded", () => {
    const p = buildShareablePayload({
      eventType: "purchase_appreciated",
      player: "Eric Hartman",
      originalPrice: 80,
      currentMarketValue: 155,
      gainPct: 93.75,
      cardTitleShort: "Hartman CPA-EHA",
      eventDate: "2026-05-10T00:00:00Z",
    });
    expect(p.headline).toBe("+94% on Eric Hartman");
    expect(p.subline).toBe("Bought at $80 in May, now $155");
    expect(p.cta).toBe("See the analysis");
    expect(p.cardTitleShort).toBe("Hartman CPA-EHA");
  });

  it("uses 'Alerted at' for alert_hit", () => {
    const p = buildShareablePayload({
      eventType: "alert_hit",
      player: "Kurtz",
      originalPrice: 100,
      currentMarketValue: 130,
      gainPct: 30,
      cardTitleShort: "Kurtz Prizm",
      eventDate: "2026-06-15T00:00:00Z",
    });
    expect(p.subline).toBe("Alerted at $100 in June, now $130");
  });

  it("handles negative gains", () => {
    const p = buildShareablePayload({
      eventType: "purchase_appreciated",
      player: "Player",
      originalPrice: 100,
      currentMarketValue: 70,
      gainPct: -30,
      cardTitleShort: "Player Card",
      eventDate: "2026-01-01T00:00:00Z",
    });
    expect(p.headline).toBe("-30% on Player");
  });
});

describe("shape helpers", () => {
  it("currentMarketValueOf prefers FMV over estimate", () => {
    expect(
      currentMarketValueOf({ fairMarketValue: 100, estimatedValue: 200 } as any),
    ).toBe(100);
    expect(
      currentMarketValueOf({ fairMarketValue: null, estimatedValue: 200 } as any),
    ).toBe(200);
    expect(currentMarketValueOf({ fairMarketValue: null, estimatedValue: null } as any)).toBeNull();
    expect(currentMarketValueOf(null)).toBeNull();
  });

  it("shortCardTitle: lastname + cardNumber", () => {
    expect(
      shortCardTitle({ playerName: "Eric Hartman", cardNumber: "CPA-EHA" } as any),
    ).toBe("Hartman CPA-EHA");
  });

  it("monthLabel maps ISO date to English month", () => {
    expect(monthLabel("2026-05-10T00:00:00Z")).toBe("May");
    expect(monthLabel("2026-12-31T23:00:00Z")).toBe("December");
    expect(monthLabel(undefined)).toBe("recently");
    expect(monthLabel("garbage")).toBe("recently");
  });

  it("daysBetween: 60 days apart == 60", () => {
    const a = new Date("2026-07-17T00:00:00Z");
    const b = new Date("2026-05-18T00:00:00Z");
    expect(daysBetween(a, b)).toBe(60);
  });
});

// ── Orchestration (detectMomentsFromInputs) ─────────────────────────────────

describe("detectMomentsFromInputs — dedup + sort", () => {
  const now = new Date("2026-07-17T12:00:00Z");

  it("dedupes: alert_hit on holdingId H suppresses purchase_appreciated on same H", () => {
    const h = holding({ id: "h1", cardId: "card-abc" } as any);
    const a = alert({ cardId: "card-abc" });
    const r = detectMomentsFromInputs([h], [a], now);
    expect(r.count).toBe(1);
    expect(r.moments[0].eventType).toBe("alert_hit");
  });

  it("purchase_appreciated on H2 coexists with alert_hit on H1", () => {
    const h1 = holding({ id: "h1", cardId: "card-abc" } as any);
    const h2 = holding({
      id: "h2",
      cardId: "card-xyz",
      playerName: "Second Player",
      purchasePrice: 50,
      fairMarketValue: 100,
      purchaseDate: daysAgo(80, now),
    } as any);
    const a = alert({ cardId: "card-abc" });
    const r = detectMomentsFromInputs([h1, h2], [a], now);
    expect(r.count).toBe(2);
    // gainPct sort: h2 = +100%, h1 alert = +55% → h2 first
    expect(r.moments[0].player).toBe("Second Player");
    expect(r.moments[1].eventType).toBe("alert_hit");
  });

  it("sorts moments by gainPct DESC", () => {
    const cheap = holding({
      id: "cheap",
      playerName: "Cheap Cheer",
      purchasePrice: 10,
      fairMarketValue: 100,       // +900%
      purchaseDate: daysAgo(100, now),
    });
    const modest = holding({
      id: "modest",
      playerName: "Modest Move",
      purchasePrice: 100,
      fairMarketValue: 140,       // +40%
      purchaseDate: daysAgo(100, now),
    });
    const r = detectMomentsFromInputs([modest, cheap], [], now);
    expect(r.count).toBe(2);
    expect(r.moments[0].player).toBe("Cheap Cheer");
    expect(r.moments[1].player).toBe("Modest Move");
  });

  it("returns empty when no holdings qualify", () => {
    const r = detectMomentsFromInputs(
      [holding({ fairMarketValue: 100, purchasePrice: 100 })],
      [],
      now,
    );
    expect(r.count).toBe(0);
    expect(r.moments).toEqual([]);
  });

  it("skips alerts that don't match any holding", () => {
    const a = alert({ cardId: "orphan-card", playerName: "Ghost Player" });
    const r = detectMomentsFromInputs([], [a], now);
    expect(r.count).toBe(0);
  });
});
