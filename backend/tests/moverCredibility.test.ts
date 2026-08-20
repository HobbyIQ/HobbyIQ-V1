// CF-MOVER-CREDIBILITY (2026-08-20).
//
// Drew: "I am not seeing the sales index move." It was never frozen — it was
// showing noise, and noise is stable.
//
// Every case below is a REAL row from the live 7-day baseball window, which
// held 463,374 comps and 24,962 qualifying movers. No shortage of signal; the
// top 20 was simply reserved for cards that trade for pennies.

import { describe, it, expect } from "vitest";
import {
  moverCredibility, looksDamaged, MOVER_DEFAULTS,
} from "../src/services/compiq/moverCredibility.service.js";

const cand = (prior: number, cur: number, n = 5) => ({
  priorMedian: prior,
  currentMedian: cur,
  deltaPct: ((cur - prior) / prior) * 100,
  deltaUSD: cur - prior,
  salesInWindow: n,
});

describe("CF-MOVER-CREDIBILITY", () => {
  it("rejects the actual junk that topped the live index", () => {
    // $0.01 -> $10 read as +99,900%, and cleared the old abs>=$1 guard.
    expect(moverCredibility(cand(0.01, 10, 3)).ok).toBe(false);
    expect(moverCredibility(cand(0.45, 435, 3)).ok).toBe(false);
    expect(moverCredibility(cand(0.11, 90, 4)).ok).toBe(false);
    expect(moverCredibility(cand(0.16, 85, 3)).ok).toBe(false);
    expect(moverCredibility(cand(10.5, 20000, 25)).ok).toBe(false);
  });

  it("rejects the -100% losers that filled the down list", () => {
    // Every top loser landed on $0.01-$1.57.
    expect(moverCredibility(cand(115, 0.01, 3)).ok).toBe(false);
    expect(moverCredibility(cand(79.99, 0.11, 3)).ok).toBe(false);
    expect(moverCredibility(cand(895, 1.57, 3)).ok).toBe(false);
    expect(moverCredibility(cand(5449, 13.5, 3)).ok).toBe(false);
  });

  it("ALLOWS genuine moves, including large ones", () => {
    // The point is not to flatten the index — a card doubling in a week is
    // real and belongs at the top.
    expect(moverCredibility(cand(100, 200)).ok).toBe(true);     // +100%
    expect(moverCredibility(cand(200, 100)).ok).toBe(true);     // -50%
    expect(moverCredibility(cand(50, 240)).ok).toBe(true);      // 4.8x, under the fold cap
    expect(moverCredibility(cand(1200, 1500)).ok).toBe(true);
    expect(moverCredibility(cand(12, 30)).ok).toBe(true);
  });

  it("names the reason it rejected, so a short list is explainable", () => {
    // An index that silently filters everything looks identical to a broken
    // one — which is how this stayed invisible.
    const r = moverCredibility(cand(0.01, 10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("prior median");
    const r2 = moverCredibility(cand(10, 10.5));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("abs move");
  });

  it("thresholds are configurable but default sanely", () => {
    expect(MOVER_DEFAULTS.minPriorUsd).toBe(5);
    expect(MOVER_DEFAULTS.maxFoldChange).toBe(5);
    // A caller may loosen the floor without touching the code.
    expect(moverCredibility(cand(2, 6), { minPriorUsd: 1 }).ok).toBe(true);
  });

  it("detects damaged-card shorthand in real titles", () => {
    for (const t of [
      "Jim Palmer 2025 Donruss #57 Orioles MLB READ FREE SHIP",
      "Miguel Cabrera Read Free Shipping",
      "1990 Topps Frank Thomas creased corner",
      "2024 Bowman Chrome auto - damaged",
      "1955 Topps #55 miscut as-is",
    ]) expect(looksDamaged(t), t).toBe(true);
  });

  it("does NOT flag products whose names contain those letters", () => {
    // Word boundaries are load-bearing: "Threads" is a Panini product line,
    // and an unanchored /read/ would drop the entire set from the index.
    for (const t of [
      "2024 Panini Threads Rookie Card",
      "2025 Topps Bread & Butter insert",
      "Already Legendary insert #12",
      "2024 Topps Chrome Ready For It #RF-1",
    ]) expect(looksDamaged(t), t).toBe(false);
  });

  it("treats an absent title as undamaged rather than guessing", () => {
    expect(looksDamaged(null)).toBe(false);
    expect(looksDamaged(undefined)).toBe(false);
    expect(looksDamaged("")).toBe(false);
  });
});
