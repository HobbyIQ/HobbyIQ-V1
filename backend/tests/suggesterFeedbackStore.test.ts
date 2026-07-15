// CF-SUGGESTER-FEEDBACK (Drew, 2026-07-15) — pins the training-corpus
// store that captures every user confirm/reject on holding suggestions.
// This is proprietary learning data no vendor has; the trust boundary +
// idempotency here are load-bearing.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSuggesterFeedback,
  readFeedbackByUser,
  readFeedbackByCardId,
  _setContainerForTests,
  type SuggesterFeedbackDoc,
} from "../src/services/portfolioiq/suggesterFeedback.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.userId}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const uid = params.get("@uid");
            const cid = params.get("@cid");
            const act = params.get("@act");
            const lim = params.get("@lim");
            let rows = Array.from(store.values()) as SuggesterFeedbackDoc[];
            if (uid) rows = rows.filter((d) => d.userId === uid);
            if (cid) rows = rows.filter((d) => d.pickedCardId === cid);
            if (act) rows = rows.filter((d) => d.userAction === act);
            rows.sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
            if (lim) rows = rows.slice(0, lim);
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
afterEach(() => _setContainerForTests(null));

describe("recordSuggesterFeedback — guards", () => {
  it("no-ops on empty userId", async () => {
    await recordSuggesterFeedback({
      userId: "",
      holdingId: "h-1",
      autoParsed: {},
      userAction: "confirmed",
    });
    expect(store.size).toBe(0);
  });

  it("no-ops on empty holdingId", async () => {
    await recordSuggesterFeedback({
      userId: "u-1",
      holdingId: "",
      autoParsed: {},
      userAction: "confirmed",
    });
    expect(store.size).toBe(0);
  });
});

describe("recordSuggesterFeedback — write shape", () => {
  it("stamps observedAt + ttl + composite id", async () => {
    const t0 = Date.now();
    await recordSuggesterFeedback({
      userId: "u-1",
      holdingId: "h-hartman",
      autoParsed: { playerName: "Eric Hartman", cardYear: 2026 },
      userAction: "confirmed",
      pickedCardId: "cs-abc-123",
    });
    const rows = Array.from(store.values()) as SuggesterFeedbackDoc[];
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("u-1");
    expect(rows[0].holdingId).toBe("h-hartman");
    expect(rows[0].id.startsWith("h-hartman::")).toBe(true);
    expect(Math.abs(Date.parse(rows[0].observedAt) - t0)).toBeLessThan(5_000);
    expect(rows[0].ttl).toBe(365 * 24 * 3600);
  });

  it("captures corrections when user changed parser output", async () => {
    await recordSuggesterFeedback({
      userId: "u-1",
      holdingId: "h-1",
      autoParsed: { parallel: "Refractor" },  // parser under-specified
      userAction: "confirmed",
      pickedCardId: "cs-x",
      corrections: [
        { field: "parallel", before: "Refractor", after: "Reptilian Refractor" },
      ],
    });
    const rows = Array.from(store.values()) as SuggesterFeedbackDoc[];
    expect(rows[0].corrections).toHaveLength(1);
    expect(rows[0].corrections[0]).toEqual({
      field: "parallel",
      before: "Refractor",
      after: "Reptilian Refractor",
    });
  });

  it("records rejected events with null pickedCardId", async () => {
    await recordSuggesterFeedback({
      userId: "u-1",
      holdingId: "h-1",
      autoParsed: { playerName: "Wrong Name" },
      userAction: "rejected",
    });
    const rows = Array.from(store.values()) as SuggesterFeedbackDoc[];
    expect(rows[0].userAction).toBe("rejected");
    expect(rows[0].pickedCardId).toBeNull();
  });

  it("supports multiple events on same holding (user re-attests over time)", async () => {
    await recordSuggesterFeedback({
      userId: "u-1", holdingId: "h-1",
      autoParsed: {}, userAction: "confirmed", pickedCardId: "cs-A",
    });
    // simulate a small time gap
    await new Promise((r) => setTimeout(r, 5));
    await recordSuggesterFeedback({
      userId: "u-1", holdingId: "h-1",
      autoParsed: {}, userAction: "confirmed", pickedCardId: "cs-B",
    });
    // Both persist — the composite id differs via observedMs suffix
    expect(store.size).toBe(2);
  });
});

describe("readFeedbackByUser — partition-hit hot path", () => {
  it("returns user's feedback newest first, capped at limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSuggesterFeedback({
        userId: "u-1", holdingId: `h-${i}`,
        autoParsed: {}, userAction: "confirmed", pickedCardId: `cs-${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rows = await readFeedbackByUser({ userId: "u-1", limit: 3 });
    expect(rows).toHaveLength(3);
    // Newest first — last-inserted `h-4` should be first
    expect(rows[0].holdingId).toBe("h-4");
    expect(rows[2].holdingId).toBe("h-2");
  });

  it("filters by action when requested", async () => {
    await recordSuggesterFeedback({
      userId: "u-1", holdingId: "h-1",
      autoParsed: {}, userAction: "confirmed", pickedCardId: "cs-A",
    });
    await recordSuggesterFeedback({
      userId: "u-1", holdingId: "h-2",
      autoParsed: {}, userAction: "rejected",
    });
    const rejected = await readFeedbackByUser({ userId: "u-1", action: "rejected" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].userAction).toBe("rejected");
  });
});

describe("readFeedbackByCardId — cross-user consensus lookup", () => {
  it("returns confirms across users for a specific cardId", async () => {
    await recordSuggesterFeedback({
      userId: "u-A", holdingId: "h-1",
      autoParsed: {}, userAction: "confirmed", pickedCardId: "cs-hartman-blue",
    });
    await recordSuggesterFeedback({
      userId: "u-B", holdingId: "h-2",
      autoParsed: {}, userAction: "confirmed", pickedCardId: "cs-hartman-blue",
    });
    await recordSuggesterFeedback({
      userId: "u-C", holdingId: "h-3",
      autoParsed: {}, userAction: "rejected",  // NOT confirmed — should be excluded
    });
    const rows = await readFeedbackByCardId({ cardId: "cs-hartman-blue" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userAction === "confirmed")).toBe(true);
  });
});
