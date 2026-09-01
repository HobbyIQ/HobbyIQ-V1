/**
 * CF-A-SWING-IS-NOT-A-MARKET (2026-09-01).
 *
 * Every oscillation measured this session was PERSISTED with no alarm: the
 * holdings list renders the stored fairMarketValue faithfully, so a value
 * flapping 10x between 6h cron cycles looked exactly like a value that had
 * settled. Holding 9b971b03 (RA-JC) logged 21.25 x5 -> 212.95 -> 20.625 ->
 * 20.625 -> 213.8 -> 20.625; ca820b08 (Gonzalez) 168.74 -> 4.17 -> 4.15 ->
 * 4.12 -> 4.11 -> 168.74/187.
 *
 * The value still stands — a swing is observed, never clamped (grade
 * monotonicity is not an invariant, and neither is price continuity; a real
 * market can double). What was missing is the signal.
 */
import { describe, it, expect } from "vitest";
import {
  perUnitFmvForSwing,
  swingRatio,
  isSwingAlarming,
  DEFAULT_SWING_ALARM_RATIO,
} from "../src/services/portfolioiq/portfolioStore.service.js";

describe("perUnitFmvForSwing", () => {
  it("prefers a positive fairMarketValue, falls back to the estimate", () => {
    expect(perUnitFmvForSwing({ fairMarketValue: 212.95, estimatedValue: 9 })).toBe(212.95);
    expect(perUnitFmvForSwing({ fairMarketValue: null, estimatedValue: 96.34 })).toBe(96.34);
  });

  it("is null when there is no number — a FIRST price is not a swing", () => {
    expect(perUnitFmvForSwing({})).toBeNull();
    expect(perUnitFmvForSwing({ fairMarketValue: 0, estimatedValue: 0 })).toBeNull();
    expect(perUnitFmvForSwing({ fairMarketValue: Number.NaN })).toBeNull();
  });
});

describe("swingRatio — direction-free", () => {
  it("measures the multiple whichever way the value moved", () => {
    // The RA-JC swing, both directions.
    expect(swingRatio(20.625, 213.8)).toBeCloseTo(10.37, 2);
    expect(swingRatio(213.8, 20.625)).toBeCloseTo(10.37, 2);
    // The Gonzalez swing.
    expect(swingRatio(4.11, 168.74)).toBeCloseTo(41.06, 1);
  });

  it("is null when either side is missing", () => {
    expect(swingRatio(null, 100)).toBeNull();
    expect(swingRatio(100, null)).toBeNull();
    expect(swingRatio(0, 100)).toBeNull();
  });
});

describe("isSwingAlarming — the trigger and the non-trigger", () => {
  it("TRIGGERS on the measured oscillations, in both directions", () => {
    expect(isSwingAlarming(20.625, 213.8)).toBe(true);    // RA-JC up
    expect(isSwingAlarming(213.8, 20.625)).toBe(true);    // RA-JC down
    expect(isSwingAlarming(168.74, 4.17)).toBe(true);     // Gonzalez down
    expect(isSwingAlarming(4.11, 187)).toBe(true);        // Gonzalez up
  });

  it("is SILENT at 1.5x — an ordinary move is not an alarm", () => {
    expect(isSwingAlarming(100, 150)).toBe(false);
    expect(isSwingAlarming(150, 100)).toBe(false);
    // The estimated-drift pairs are alarming or not on their own merits:
    // Verlander 96.34 -> 64.12 is 1.50x, quiet.
    expect(isSwingAlarming(96.34, 64.12)).toBe(false);
    // Judge 131.88 -> 106 is 1.24x, quiet.
    expect(isSwingAlarming(131.88, 106)).toBe(false);
  });

  it("is exclusive at exactly 2x — 2.00x quiet, 2.01x loud", () => {
    expect(DEFAULT_SWING_ALARM_RATIO).toBe(2);
    expect(isSwingAlarming(100, 200)).toBe(false);
    expect(isSwingAlarming(100, 201)).toBe(true);
    expect(isSwingAlarming(200, 100)).toBe(false);
    expect(isSwingAlarming(201, 100)).toBe(true);
  });

  it("never fires on a first price, and honours a custom threshold", () => {
    expect(isSwingAlarming(null, 213.8)).toBe(false);
    expect(isSwingAlarming(20.625, null)).toBe(false);
    // A stricter threshold catches the 1.5x move the default lets through.
    expect(isSwingAlarming(100, 150, 1.4)).toBe(true);
    expect(isSwingAlarming(20.625, 213.8, 20)).toBe(false);
  });
});
