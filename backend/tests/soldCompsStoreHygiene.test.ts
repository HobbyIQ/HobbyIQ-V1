// CF-SOLD-COMPS-FOUNDATION (Drew, 2026-07-14) — pins the hygiene guards
// on the sold_comps store. Same pattern as card_valuation_history tests
// (PR #431) — protect the shared pool from bad-data pollution because
// wrong comps poison OTHER users' prices.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
  readCompsByCardId,
  readCompsByPlayer,
  _setContainerForTests,
  type SoldCompDoc,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    // CF-FAKE-MUST-IMPLEMENT-DELETE (2026-08-20). The fake had no `item()`, so
    // the pre-write dedup's `c.item(id, pk).delete()` threw and was swallowed
    // by its best-effort catch. That made this suite NON-DETERMINISTIC:
    // scoreForCanonical tie-breaks on observedAt, so two writes landing in the
    // SAME millisecond score equal and dedup skips (1 row), while a millisecond
    // apart lets the incoming row win — it deletes the existing one, the delete
    // silently fails against this fake, and BOTH rows survive (2 rows).
    //
    // Same lesson the @h filter above was added for, one layer down: the store
    // was behaving correctly and the fake was lying about the outcome. A fake
    // that no-ops a mutation does not make a test lenient, it makes it random.
    item(id: string, partitionKey: string) {
      return {
        async delete() {
          store.delete(`${partitionKey}::${id}`);
          return { resource: undefined };
        },
      };
    },
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
            const player = params.get("@player");
            const lim = params.get("@lim");
            // CF-CONTENT-HASH-DEDUP: recordSoldComp probes for an existing row
            // by contentHash before writing. This fake did not know about @h,
            // so that probe fell through every filter and returned the WHOLE
            // store — making the second write of any test look like a
            // duplicate and silently skipping it. That is why three tests here
            // saw an empty store or one row short; the store was correct and
            // the fake was lying. Filter on it like Cosmos would.
            // D31 TRANSITION: `@h` is now an ARRAY of the hash forms a stored
            // row could carry (the new whole-parallel hash, plus the legacy
            // form that stripped a trailing " Refractor"), matched with
            // ARRAY_CONTAINS. A fake that still compared it as a scalar would
            // match nothing and make every second write look like a NEW sale
            // -- the same "the fake was lying" trap as the note above, in the
            // opposite direction. Accept both shapes.
            const contentHash = params.get("@h");
            let rows = Array.from(store.values()) as SoldCompDoc[];
            if (contentHash !== undefined) {
              const wanted = Array.isArray(contentHash) ? contentHash : [contentHash];
              return { resources: rows.filter((d) => wanted.includes((d as { contentHash?: string }).contentHash as string)) };
            }
            // CF-ONE-TRANSACTION-ONE-ROW (D9): recordSoldComp probes for the
            // same id filed under another cardId partition before it writes.
            // Same lesson as @h above -- an unknown param must not fall
            // through to the whole store, or the probe "finds" every row and
            // the supersede deletes them.
            const sameId = params.get("@id");
            if (sameId !== undefined) {
              const notCardId = params.get("@cardId");
              return { resources: rows.filter((d) => d.id === sameId && d.cardId !== notCardId) };
            }
            if (cid) rows = rows.filter((d) => d.cardId === cid);
            if (from) rows = rows.filter((d) => d.soldAt >= from);
            if (to) rows = rows.filter((d) => d.soldAt <= to);
            if (player) rows = rows.filter((d) => d.playerName.toLowerCase() === String(player).toLowerCase());
            rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : a.soldAt > b.soldAt ? -1 : 0));
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

describe("recordSoldComp — hygiene guards (trust-boundary protection)", () => {
  it("no-ops silently when cardId is empty (pending-review holdings must never emit)", async () => {
    await recordSoldComp({
      cardId: "",
      playerName: "Eric Hartman",
      price: 420,
      soldAt: "2026-07-05T00:00:00Z",
      source: "ebay-user-purchase",
    });
    expect(store.size).toBe(0);
  });

  it("no-ops silently when playerName is empty (identity signal missing)", async () => {
    await recordSoldComp({
      cardId: "cs-1",
      playerName: "",
      price: 420,
      soldAt: "2026-07-05T00:00:00Z",
      source: "ebay-user-purchase",
    });
    expect(store.size).toBe(0);
  });

  it("no-ops when price is 0 or negative (defensive vs seller data-entry errors)", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 0,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
    });
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: -50,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
    });
    expect(store.size).toBe(0);
  });

  it("no-ops when soldAt is empty", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 420,
      soldAt: "", source: "ebay-user-purchase",
    });
    expect(store.size).toBe(0);
  });
});

describe("recordSoldComp — idempotency via composite id", () => {
  it("same (source, externalId) upserts to same row — no duplicates", async () => {
    const input = {
      cardId: "cs-hartman-blue",
      playerName: "Eric Hartman",
      price: 420,
      soldAt: "2026-07-05T00:00:00Z",
      source: "ebay-user-purchase" as const,
      sourceExternalId: "ebay-item-999",
    };
    await recordSoldComp(input);
    await recordSoldComp(input);
    await recordSoldComp({ ...input, price: 450 });  // price update
    expect(store.size).toBe(1);
    const doc = Array.from(store.values())[0] as SoldCompDoc;
    expect(doc.price).toBe(450);  // last write wins
  });

  // CF-CONTENT-HASH-DEDUP (2026-07-21, extended 2026-08-06). This test used to
  // assert that two different externalIds ALWAYS produce two rows. That belief
  // is the one the store's own comment now calls wrong: CardHedge emits the
  // SAME eBay listing under two externalId shapes ("<cardId>x<listing>" and
  // "ch-daily::<listing>"), so keying only on the id minted dupes that fooled
  // the pool. Identity is contentHash — (cardId, parallel, isAuto, grade,
  // price, soldAt) — because two sellers listing the same card at the same
  // price in the same SECOND is lottery-tier.
  //
  // So the axis under test is CONTENT, not the id. Both halves are pinned.
  it("same content + different externalIds → ONE row (CH multi-path dedup)", async () => {
    const base = {
      cardId: "cs-hartman-blue",
      playerName: "Eric Hartman",
      price: 420,
      soldAt: "2026-07-05T00:00:00Z",
      source: "ebay-user-purchase" as const,
    };
    await recordSoldComp({ ...base, sourceExternalId: "ebay-A" });
    await recordSoldComp({ ...base, sourceExternalId: "ebay-B" });
    expect(store.size).toBe(1);
  });

  it("different content + different externalIds → separate rows", async () => {
    // Genuinely distinct sales must still both land, or dedup would be eating
    // real comps rather than duplicates — the failure mode that matters.
    const base = {
      cardId: "cs-hartman-blue",
      playerName: "Eric Hartman",
      source: "ebay-user-purchase" as const,
    };
    await recordSoldComp({ ...base, price: 420, soldAt: "2026-07-05T00:00:00Z", sourceExternalId: "ebay-A" });
    await recordSoldComp({ ...base, price: 505, soldAt: "2026-07-06T00:00:00Z", sourceExternalId: "ebay-B" });
    expect(store.size).toBe(2);
  });

  it("no externalId → deterministic id from (cardId, source, soldAt) — still idempotent", async () => {
    const base = {
      cardId: "cs-hartman-blue",
      playerName: "Eric Hartman",
      price: 420,
      soldAt: "2026-07-05T00:00:00Z",
      source: "manual-user-entry" as const,
      // preIngestClean made `parallel` REQUIRED for manual-user-entry after the
      // 2026-08-01 Hartman incident, where a silent Base default mispriced a
      // parallel. Without it both writes here are correctly rejected and the
      // store stays empty — which is what made this test red, not the
      // idempotency it is actually pinning.
      parallel: "Base",
    };
    await recordSoldComp(base);
    await recordSoldComp(base);   // exact same → same id
    expect(store.size).toBe(1);
  });
});

describe("recordSoldComp — provenance + confidence stamping", () => {
  it("verifiedByUser=true defaults confidence to 1.0", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 420,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
      verifiedByUser: true,
    });
    const doc = Array.from(store.values())[0] as SoldCompDoc;
    expect(doc.confidence).toBe(1.0);
    expect(doc.verifiedByUser).toBe(true);
  });

  it("no verifiedByUser flag → confidence defaults to 0.5", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 420,
      soldAt: "2026-07-05T00:00:00Z", source: "cardhedge",
    });
    const doc = Array.from(store.values())[0] as SoldCompDoc;
    expect(doc.confidence).toBe(0.5);
    expect(doc.verifiedByUser).toBe(false);
  });

  it("server-stamps observedAt regardless of caller", async () => {
    const t0 = Date.now();
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 420,
      soldAt: "2020-01-01T00:00:00Z",  // caller sends deliberately-old date
      source: "ebay-user-purchase",
    });
    const doc = Array.from(store.values())[0] as SoldCompDoc;
    // observedAt reflects OUR clock, not caller's soldAt
    const observedMs = Date.parse(doc.observedAt);
    expect(Math.abs(observedMs - t0)).toBeLessThan(5_000);
    // soldAt preserved as-is
    expect(doc.soldAt).toBe("2020-01-01T00:00:00Z");
  });

  it("contributorUserId + sellerHandle preserved for provenance audits", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 420,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
      contributorUserId: "user-abc",
      sellerHandle: "ko_kardz",
    });
    const doc = Array.from(store.values())[0] as SoldCompDoc;
    expect(doc.contributorUserId).toBe("user-abc");
    expect(doc.sellerHandle).toBe("ko_kardz");
  });
});

describe("readCompsByCardId — engine hot path", () => {
  it("returns comps ordered by soldAt DESC (newest first)", async () => {
    for (const day of ["2026-07-01", "2026-07-05", "2026-07-10"]) {
      await recordSoldComp({
        cardId: "cs-1", playerName: "Eric Hartman", price: 400,
        soldAt: `${day}T00:00:00Z`, source: "ebay-user-purchase",
        sourceExternalId: `id-${day}`,
      });
    }
    const rows = await readCompsByCardId({ cardId: "cs-1", fromDate: "2026-06-01T00:00:00Z" });
    expect(rows).toHaveLength(3);
    expect(rows[0].soldAt).toBe("2026-07-10T00:00:00Z");
    expect(rows[2].soldAt).toBe("2026-07-01T00:00:00Z");
  });

  it("filters by sources[] when provided", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 400,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 380,
      soldAt: "2026-07-06T00:00:00Z", source: "cardhedge",
      sourceExternalId: "b",
    });
    const userOnly = await readCompsByCardId({
      cardId: "cs-1", fromDate: "2026-06-01T00:00:00Z",
      sources: ["ebay-user-purchase"],
    });
    expect(userOnly).toHaveLength(1);
    expect(userOnly[0].source).toBe("ebay-user-purchase");
  });

  it("respects fromDate cutoff", async () => {
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 400,
      soldAt: "2025-01-01T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "old",
    });
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 500,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "new",
    });
    const recent = await readCompsByCardId({
      cardId: "cs-1", fromDate: "2026-06-01T00:00:00Z",
    });
    expect(recent).toHaveLength(1);
    expect(recent[0].sourceExternalId).toBe("new");
  });
});

describe("readCompsByPlayer — cross-partition search", () => {
  it("returns matching player's comps across cardIds, case-insensitive", async () => {
    await recordSoldComp({
      cardId: "cs-A", playerName: "Eric Hartman", price: 420,
      soldAt: "2026-07-05T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    await recordSoldComp({
      cardId: "cs-B", playerName: "eric hartman", price: 300,
      soldAt: "2026-07-06T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "b",
    });
    await recordSoldComp({
      cardId: "cs-C", playerName: "Mookie Betts", price: 100,
      soldAt: "2026-07-06T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "c",
    });
    const rows = await readCompsByPlayer({
      playerName: "Eric Hartman",
      fromDate: "2026-06-01T00:00:00Z",
    });
    expect(rows).toHaveLength(2);
    // Newest first
    expect(rows[0].sourceExternalId).toBe("b");
  });
});
