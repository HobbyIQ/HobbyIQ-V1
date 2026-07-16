// CF-CARD-VALUATION-HISTORY (Drew, 2026-07-13, PR #431) — verifies the
// hygiene guards on the valuation snapshot store. These tests pin the
// FIVE bias-avoidance properties Drew flagged in the backtest design
// brief.
//
// The guards enforced here:
//   1. Look-ahead: readValuationHistory respects maxDate (never returns
//      snapshots dated after the cutoff)
//   2. Look-ahead (write): every doc records computedAt server-side
//   3. Sample transparency: sampleCount is always emitted (never omitted)
//   4. Verdict always set (never missing — downstream joins need it)
//   5. Idempotency: same (cardId, date) upserts overwrite, never duplicate

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  upsertValuationSnapshot,
  readValuationHistory,
  _setContainerForTests,
  type ValuationHistoryDoc,
} from "../src/services/portfolioiq/cardValuationHistoryStore.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const cid = params.get("@cid");
            const from = params.get("@from");
            const to = params.get("@to");
            const rows = Array.from(store.values())
              .filter((d) => d.cardId === cid)
              .filter((d) => d.date >= from && d.date <= to)
              .sort((a, b) => a.date.localeCompare(b.date));
            return { resources: rows };
          },
        };
      },
    },
  } as unknown as Container;
  return { container, store };
}

let store: Map<string, any>;
beforeEach(() => {
  const f = fakeContainer();
  store = f.store;
  _setContainerForTests(f.container);
});
afterEach(() => {
  _setContainerForTests(null);
});

describe("hygiene guard #1 — look-ahead: readValuationHistory respects maxDate", () => {
  it("never returns snapshots dated AFTER the maxDate cutoff", async () => {
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: "2026-07-10", marketValue: 100 });
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: "2026-07-13", marketValue: 120 });
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: "2026-07-15", marketValue: 140 });

    // Backtest asking "what was the model saying on 2026-07-13?"
    const asOfSellDate = await readValuationHistory({
      cardId: "c1", fromDate: "2026-07-01", maxDate: "2026-07-13",
    });
    const dates = asOfSellDate.map((r) => r.date);
    expect(dates).toEqual(["2026-07-10", "2026-07-13"]);
    // The 2026-07-15 snapshot MUST NOT leak into a 2026-07-13 backtest.
    expect(dates).not.toContain("2026-07-15");
  });

  it("with default maxDate (today), never returns future-dated docs", async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const futureIso = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: todayIso, marketValue: 100 });
    // A future-dated snapshot (buggy caller or clock skew)
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: futureIso, marketValue: 999 });
    const r = await readValuationHistory({ cardId: "c1" });   // no maxDate → defaults to today
    expect(r.some((d) => d.date === todayIso)).toBe(true);
    expect(r.some((d) => d.date === futureIso)).toBe(false);
  });
});

describe("hygiene guard #2 — computedAt is server-stamped, not caller-supplied", () => {
  it("computedAt on the persisted doc reflects real server time (not caller clock)", async () => {
    const t0 = Date.now();
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2000-01-01", marketValue: 100,
    });
    const doc = Array.from(store.values())[0] as ValuationHistoryDoc;
    const stampedMs = Date.parse(doc.computedAt);
    // computedAt is within 5 seconds of the test's t0 — proves it wasn't
    // taken from the (deliberately absurd) 2000-01-01 `today` field.
    expect(Math.abs(stampedMs - t0)).toBeLessThan(5_000);
    // The `date` field IS the caller-supplied YYYY-MM-DD — that's the
    // "as of" marker for backtest joins. Different from computedAt.
    expect(doc.date).toBe("2000-01-01");
  });
});

describe("hygiene guard #3 — sampleCount is always emitted", () => {
  it("defaults to 0 when caller omits, never undefined", async () => {
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2026-07-13",
      // deliberately omit sampleCount
    });
    const doc = Array.from(store.values())[0] as ValuationHistoryDoc;
    expect(doc.sampleCount).toBe(0);
    expect(doc.sampleCount).not.toBeUndefined();
  });

  it("preserves caller-supplied sampleCount", async () => {
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2026-07-13", sampleCount: 42,
    });
    const doc = Array.from(store.values())[0] as ValuationHistoryDoc;
    expect(doc.sampleCount).toBe(42);
  });
});

describe("hygiene guard #4 — verdict is always set (downstream joins require it)", () => {
  it("defaults to 'unavailable' when caller omits", async () => {
    await upsertValuationSnapshot({ cardId: "c1", source: "manual", today: "2026-07-13" });
    const doc = Array.from(store.values())[0] as ValuationHistoryDoc;
    expect(doc.verdict).toBe("unavailable");
    expect(doc.verdict).not.toBeUndefined();
  });

  it("preserves caller-supplied verdict", async () => {
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2026-07-13", verdict: "strong_bull",
    });
    const doc = Array.from(store.values())[0] as ValuationHistoryDoc;
    expect(doc.verdict).toBe("strong_bull");
  });
});

describe("hygiene guard #5 — idempotency (no duplicate rows on repeat writes)", () => {
  it("second upsert for same (cardId, date) overwrites, doesn't duplicate", async () => {
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2026-07-13", marketValue: 100,
    });
    await upsertValuationSnapshot({
      cardId: "c1", source: "manual", today: "2026-07-13", marketValue: 105,
    });
    const rows = await readValuationHistory({
      cardId: "c1", fromDate: "2026-07-13", maxDate: "2026-07-13",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].marketValue).toBe(105);
  });
});

describe("hygiene guard bonus — cardId required (silent skip on empty)", () => {
  it("upsert with empty cardId no-ops silently (never poisons the store)", async () => {
    await upsertValuationSnapshot({
      cardId: "", source: "manual", today: "2026-07-13", marketValue: 100,
    });
    expect(store.size).toBe(0);
  });
});
