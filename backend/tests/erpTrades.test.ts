// CF-ERP-EXPANSION-#7 (2026-06-03): trade FMV-allocation pure math + audit.

import { describe, expect, it } from "vitest";
import { allocateTradeProceeds } from "../src/services/portfolioiq/erpTrades.service.js";

describe("allocateTradeProceeds — invariants", () => {
  it("Σ gl_i MUST equal realizedGainLoss (sum-to-total invariant)", () => {
    // 3 outgoing cards with disparate FMVs + bases; 2 incoming; cashToMe + 25
    const r = allocateTradeProceeds({
      outgoingFmvs: [100, 50, 25],
      outgoingCostBases: [40, 30, 10],
      incomingFmvs: [80, 70],
      cashToMe: 25,
    });
    const sumGl = r.perOutgoing.reduce((acc, x) => acc + x.realizedGainLoss, 0);
    expect(Math.round(sumGl * 100) / 100).toBe(r.totals.realizedGainLoss);
  });

  it("balanced trade: fmvOut = fmvIn + cashToMe; balanceCheck = 0", () => {
    const r = allocateTradeProceeds({
      outgoingFmvs: [100],
      outgoingCostBases: [40],
      incomingFmvs: [90],
      cashToMe: 10,
    });
    expect(r.totals.balanceCheck).toBe(0);
  });

  it("traded down (gave up more FMV than received): balanceCheck > 0", () => {
    const r = allocateTradeProceeds({
      outgoingFmvs: [200],
      outgoingCostBases: [50],
      incomingFmvs: [150],
      cashToMe: 0,
    });
    expect(r.totals.balanceCheck).toBeGreaterThan(0);
  });

  it("came out ahead: balanceCheck < 0", () => {
    const r = allocateTradeProceeds({
      outgoingFmvs: [100],
      outgoingCostBases: [40],
      incomingFmvs: [150],
      cashToMe: 0,
    });
    expect(r.totals.balanceCheck).toBeLessThan(0);
  });

  it("cash to me (received): amountRealized increases", () => {
    const r = allocateTradeProceeds({
      outgoingFmvs: [100],
      outgoingCostBases: [40],
      incomingFmvs: [50],
      cashToMe: 50,
    });
    expect(r.totals.amountRealized).toBe(100);  // 50 + 50
    expect(r.totals.realizedGainLoss).toBe(60); // 100 − 40
  });

  it("cash from me (paid): amountRealized decreases (cashToMe negative)", () => {
    const r = allocateTradeProceeds({
      outgoingFmvs: [100],
      outgoingCostBases: [40],
      incomingFmvs: [200],
      cashToMe: -100,
    });
    expect(r.totals.amountRealized).toBe(100);  // 200 + (−100)
    expect(r.totals.realizedGainLoss).toBe(60);
  });

  it("CPA worked example: $40-basis / $100-FMV → $90-FMV + $10 cash → $60 gain", () => {
    // From the user's brief: "give a $40-basis / $100-FMV card for a $90-FMV
    // card + $10 cash, and show it lands at $60 realized gain, $90 new-holding basis"
    const r = allocateTradeProceeds({
      outgoingFmvs: [100],
      outgoingCostBases: [40],
      incomingFmvs: [90],
      cashToMe: 10,
    });
    expect(r.totals.amountRealized).toBe(100);     // fmvIn 90 + cash 10
    expect(r.totals.basisGivenUp).toBe(40);
    expect(r.totals.realizedGainLoss).toBe(60);    // 100 − 40
    expect(r.perOutgoing[0].proceeds).toBe(100);
    expect(r.perOutgoing[0].realizedGainLoss).toBe(60);
    expect(r.totals.balanceCheck).toBe(0);
    // Incoming card's new-holding basis = its FMV (90). This is asserted at
    // the persistence layer (recordTradeTransaction); the math fn just
    // returns fmvIn so the caller can stamp purchasePrice=totalCostBasis=90.
    expect(r.totals.fmvIn).toBe(90);
  });

  it("multi-card: 2 outgoing → proceeds allocated proportional to FMV share", () => {
    // outgoing FMV split 80/20, amountRealized = 100
    // expected proceeds: 80, 20
    const r = allocateTradeProceeds({
      outgoingFmvs: [80, 20],
      outgoingCostBases: [40, 10],
      incomingFmvs: [100],
      cashToMe: 0,
    });
    expect(r.perOutgoing[0].proceeds).toBe(80);
    expect(r.perOutgoing[1].proceeds).toBe(20);
    expect(r.perOutgoing[0].realizedGainLoss).toBe(40);   // 80 − 40
    expect(r.perOutgoing[1].realizedGainLoss).toBe(10);   // 20 − 10
  });

  it("uneven fmv share doesn't drift via floating point — last leg residual", () => {
    // Three legs at 100/100/100, amountRealized = 100 → 33.33/33.33/33.34
    const r = allocateTradeProceeds({
      outgoingFmvs: [100, 100, 100],
      outgoingCostBases: [10, 20, 30],
      incomingFmvs: [],
      cashToMe: 100,
    });
    const sumProceeds = r.perOutgoing.reduce((acc, x) => acc + x.proceeds, 0);
    expect(Math.round(sumProceeds * 100) / 100).toBe(100);
    const sumGl = r.perOutgoing.reduce((acc, x) => acc + x.realizedGainLoss, 0);
    expect(Math.round(sumGl * 100) / 100).toBe(r.totals.realizedGainLoss);
  });
});
