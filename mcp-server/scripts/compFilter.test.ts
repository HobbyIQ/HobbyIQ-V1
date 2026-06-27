// Unit test for CF-MCP-CARDNUMBER-ISOLATION — verifies filterCompsForCard
// isolates a single card out of a multi-card player+set comp pool using the
// card number, so a high-value autograph is never blended with cheap base
// prospects under the same player+set+year.
//
// Regression context: 2026-06-27 the MCP /predict path priced the
// "2026 Bowman Chrome Eric Hartman 1st Bowman Auto #CPA-EHA" at ~$39 because
// all 268 player comps (dominated by $1-10 #BCP-102 base prospects) were
// blended into one anchor. Card-number isolation drops the pool to the 51
// #CPA-EHA comps (median ~$110), restoring the correct ~$125 anchor.
//
// Run: cd mcp-server && npx tsx --test scripts/compFilter.test.ts

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { filterCompsForCard } from "../compFilter.js";

type Comp = { price: number; date: string; title: string; grade?: string; source?: string };

// Synthetic pool mirroring the Eric Hartman shape: many cheap base prospects
// (#BCP-102), a few autos (#CPA-EHA), one off-set reprint.
function pool(): Comp[] {
  const comps: Comp[] = [];
  // 20 cheap base prospects #BCP-102 ($8-12)
  for (let i = 0; i < 20; i++) {
    comps.push({
      price: 8 + (i % 5),
      date: "2026-06-25T00:00:00.000Z",
      title: `2026 Bowman Chrome Eric Hartman #BCP-102 Prospects - Raw`,
    });
  }
  // 6 autos #CPA-EHA ($100-130)
  for (let i = 0; i < 6; i++) {
    comps.push({
      price: 100 + i * 5,
      date: "2026-06-26T00:00:00.000Z",
      title: `2026 Bowman Chrome Eric Hartman 1st Auto #CPA-EHA Braves - Raw`,
    });
  }
  // off-set reprint noise
  comps.push({
    price: 3,
    date: "2026-06-20T00:00:00.000Z",
    title: `2026 Eric Hartman Bowman Chrome CUSTOM reprint ACEO`,
  });
  return comps;
}

describe("CF-MCP-CARDNUMBER-ISOLATION — filterCompsForCard", () => {
  it("isolates the auto (#CPA-EHA) out of a base-prospect-dominated pool", () => {
    const out = filterCompsForCard(pool() as any, "Eric Hartman", 2026, "Bowman Chrome", "CPA-EHA");
    assert.equal(out.length, 6, "should keep only the 6 #CPA-EHA autos");
    for (const c of out) {
      assert.ok(/cpa-eha/i.test(c.title), `unexpected non-auto title: ${c.title}`);
    }
    const prices = out.map((c) => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    assert.ok(median >= 100, `median should reflect the auto (got ${median})`);
  });

  it("normalizes punctuation/spacing so '#CPA-EHA' and 'CPA EHA' both match", () => {
    const comps: Comp[] = [
      { price: 120, date: "2026-06-26T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman Auto CPA EHA Braves" },
      { price: 125, date: "2026-06-26T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman Auto #CPA-EHA Braves" },
      { price: 130, date: "2026-06-26T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman Auto cpaeha Braves" },
      { price: 9, date: "2026-06-25T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman #BCP-102 Braves" },
    ];
    const out = filterCompsForCard(comps as any, "Eric Hartman", 2026, "Bowman Chrome", "CPA-EHA");
    assert.equal(out.length, 3, "all three punctuation variants of CPA-EHA should match");
  });

  it("bypasses the 30% fallback: keeps a small authoritative card-number match", () => {
    // 5 autos out of 100 comps = 5% — well under the 30% ratio rule, but a
    // precise card-number match must still win.
    const comps: Comp[] = [];
    for (let i = 0; i < 95; i++) {
      comps.push({ price: 10, date: "2026-06-25T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman #BCP-102 Braves" });
    }
    for (let i = 0; i < 5; i++) {
      comps.push({ price: 120, date: "2026-06-26T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman Auto #CPA-EHA Braves" });
    }
    const out = filterCompsForCard(comps as any, "Eric Hartman", 2026, "Bowman Chrome", "CPA-EHA");
    assert.equal(out.length, 5, "5/100 (5%) card-number match must survive despite 30% rule");
    assert.ok(out.every((c) => c.price === 120), "only autos should remain");
  });

  it("falls back to relevance filter when card-number match is too thin (<3)", () => {
    // Only 1 auto present — below the ≥3 minimum, so we keep the broader set.
    const comps: Comp[] = [];
    for (let i = 0; i < 10; i++) {
      comps.push({ price: 10, date: "2026-06-25T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman #BCP-102 Braves" });
    }
    comps.push({ price: 120, date: "2026-06-26T00:00:00.000Z", title: "2026 Bowman Chrome Eric Hartman Auto #CPA-EHA Braves" });
    const out = filterCompsForCard(comps as any, "Eric Hartman", 2026, "Bowman Chrome", "CPA-EHA");
    assert.equal(out.length, 11, "thin card-number match (<3) should not isolate; keep relevance set");
  });

  it("no cardNumber → existing relevance behavior (drops reprints, keeps rest)", () => {
    const out = filterCompsForCard(pool() as any, "Eric Hartman", 2026, "Bowman Chrome");
    // 26 real comps kept, the custom/reprint/aceo dropped.
    assert.equal(out.length, 26, "reprint/custom/aceo noise should be dropped");
    assert.ok(!out.some((c) => /custom|reprint|aceo/i.test(c.title)));
  });

  it("empty pool returns empty", () => {
    assert.deepEqual(filterCompsForCard([], "Eric Hartman", 2026, "Bowman Chrome", "CPA-EHA"), []);
  });
});
