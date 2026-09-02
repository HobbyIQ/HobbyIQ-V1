// Speculation pricing — the stale-comp line, pinned (Drew, 2026-09-02).
//
// "the last comps from 2 months ago aren't a fair price. It is priced
// based on speculation and today's market."
//
// What is pinned here: (1) the line fires on a cold pool and stays silent
// on a warm one — the whole point, since a line that always shows says
// nothing; (2) it stays silent on any age we cannot trust, rather than
// guessing old; (3) it never touches the rung vocabulary, which
// rung.test.ts pins separately and which this change does not edit.
import { describe, expect, it } from "vitest";
import { describeRung, describeStaleness, STALE_COMP_DAYS } from "./rung";

describe("describeStaleness", () => {
  it("a 60-day-old comp renders the speculation line", () => {
    const s = describeStaleness(60);
    expect(s).not.toBeNull();
    expect(s!.weeks).toBe(9);
    expect(s!.daysSinceNewestComp).toBe(60);
    // Drew's framing, both halves: the print is old AND we price to today.
    expect(s!.long).toMatch(/9 weeks ago/);
    expect(s!.long).toMatch(/aren't fair value today/);
    expect(s!.long).toMatch(/projects today's market/);
    expect(s!.short).toMatch(/today's market/);
  });

  it("a fresh comp shows no speculation line at all", () => {
    for (const days of [0, 1, 7, 30, STALE_COMP_DAYS]) {
      expect(describeStaleness(days), `${days}d`).toBeNull();
    }
  });

  it("fires only strictly past the threshold", () => {
    expect(describeStaleness(STALE_COMP_DAYS)).toBeNull();
    expect(describeStaleness(STALE_COMP_DAYS + 1)).not.toBeNull();
  });

  it("an age we cannot trust is never dressed as stale", () => {
    // Missing, unparseable, or negative: say nothing. A value we cannot
    // date does not get told it is old.
    for (const bad of [null, undefined, NaN, Infinity, -1, -400]) {
      expect(describeStaleness(bad as number | null | undefined), String(bad)).toBeNull();
    }
  });

  it("never says '0 weeks' — a stale card is at least one week cold", () => {
    // Guards the rounding: any firing age must read as >= 1 week.
    for (let d = STALE_COMP_DAYS + 1; d <= 400; d++) {
      const s = describeStaleness(d);
      expect(s, `${d}d`).not.toBeNull();
      expect(s!.weeks, `${d}d`).toBeGreaterThanOrEqual(1);
    }
  });

  it("the threshold sits inside Drew's 30-60 day band", () => {
    expect(STALE_COMP_DAYS).toBeGreaterThanOrEqual(30);
    expect(STALE_COMP_DAYS).toBeLessThanOrEqual(60);
  });

  it("leaves the rung vocabulary untouched — staleness is a second fact", () => {
    // The same rung reads identically whether or not the pool is cold;
    // the age is additive, never a rewrite of which pool priced the card.
    const rung = describeRung("exact-pool-projection", { compsUsed: 5 });
    expect(rung.kind).toBe("observed");
    expect(rung.text).toBe("projected from 5 sales of this card");
    expect(rung.text).not.toMatch(/week|stale|today's market/);
  });
});
