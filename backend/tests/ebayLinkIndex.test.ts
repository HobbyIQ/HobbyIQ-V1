// CF-EBAY-LINK-INDEX-P0.5 (Drew, 2026-07-26). Pins the ebay_link_index
// service — the point-read replacement for cross-partition scans on
// every eBay webhook.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  writeLinkIndex,
  removeLinkIndex,
  findByOfferId,
  findByListingId,
  _setContainerForTests,
} from "../src/services/portfolioiq/ebayLinkIndex.service.js";

function fakeContainer(opts: {
  onUpsert?: (doc: any) => void;
  onDelete?: (id: string, pk: string) => void;
  onRead?: (id: string, pk: string) => any;
  failMode?: "throw-on-write" | "throw-on-read" | "throw-on-delete" | null;
} = {}): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        if (opts.failMode === "throw-on-write") throw new Error("simulated write failure");
        store.set(`${doc.ebayId}::${doc.id}`, doc);
        opts.onUpsert?.(doc);
        return { resource: doc };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          if (opts.failMode === "throw-on-read") throw new Error("simulated read failure");
          opts.onRead?.(id, pk);
          const key = `${pk}::${id}`;
          if (!store.has(key)) {
            const err: any = new Error("not found");
            err.statusCode = 404;
            err.code = 404;
            throw err;
          }
          return { resource: store.get(key) as T };
        },
        async delete() {
          if (opts.failMode === "throw-on-delete") throw new Error("simulated delete failure");
          opts.onDelete?.(id, pk);
          const key = `${pk}::${id}`;
          if (!store.has(key)) {
            const err: any = new Error("not found");
            err.statusCode = 404;
            err.code = 404;
            throw err;
          }
          store.delete(key);
          return { resource: undefined };
        },
      };
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

describe("writeLinkIndex", () => {
  it("writes both offer and listing rows for a full link", async () => {
    const r = await writeLinkIndex({
      userId: "u-1",
      holdingId: "h-1",
      offerId: "off-abc",
      listingId: "list-xyz",
    });
    expect(r.offerWritten).toBe(true);
    expect(r.listingWritten).toBe(true);
    expect(store.size).toBe(2);
    const offerDoc = store.get("off-abc::offer::off-abc");
    const listingDoc = store.get("list-xyz::listing::list-xyz");
    expect(offerDoc).toMatchObject({
      id: "offer::off-abc",
      ebayId: "off-abc",
      ebayIdKind: "offer",
      userId: "u-1",
      holdingId: "h-1",
    });
    expect(listingDoc).toMatchObject({
      id: "listing::list-xyz",
      ebayId: "list-xyz",
      ebayIdKind: "listing",
      userId: "u-1",
      holdingId: "h-1",
    });
  });

  it("writes only one row when caller supplies only offerId", async () => {
    const r = await writeLinkIndex({
      userId: "u-1", holdingId: "h-1", offerId: "off-only", listingId: null,
    });
    expect(r.offerWritten).toBe(true);
    expect(r.listingWritten).toBe(false);
    expect(store.size).toBe(1);
  });

  it("returns { false, false } on missing userId or holdingId (guard)", async () => {
    const r1 = await writeLinkIndex({
      userId: "", holdingId: "h", offerId: "off",
    });
    const r2 = await writeLinkIndex({
      userId: "u", holdingId: "", offerId: "off",
    });
    expect(r1).toEqual({ offerWritten: false, listingWritten: false });
    expect(r2).toEqual({ offerWritten: false, listingWritten: false });
    expect(store.size).toBe(0);
  });

  it("returns { false, false } when both offerId and listingId are absent", async () => {
    const r = await writeLinkIndex({ userId: "u", holdingId: "h" });
    expect(r).toEqual({ offerWritten: false, listingWritten: false });
    expect(store.size).toBe(0);
  });

  it("swallows Cosmos errors — never rejects (best-effort contract)", async () => {
    const f = fakeContainer({ failMode: "throw-on-write" });
    _setContainerForTests(f.container);
    const r = await writeLinkIndex({
      userId: "u", holdingId: "h", offerId: "off", listingId: "list",
    });
    expect(r).toEqual({ offerWritten: false, listingWritten: false });
  });

  it("upserts overwrite the same id (idempotent re-link)", async () => {
    await writeLinkIndex({ userId: "u-1", holdingId: "h-1", offerId: "off-1" });
    await writeLinkIndex({ userId: "u-2", holdingId: "h-2", offerId: "off-1" });
    expect(store.size).toBe(1);
    const doc = store.get("off-1::offer::off-1");
    expect(doc.userId).toBe("u-2");
    expect(doc.holdingId).toBe("h-2");
  });
});

describe("removeLinkIndex", () => {
  it("deletes both offer + listing rows", async () => {
    await writeLinkIndex({
      userId: "u-1", holdingId: "h-1", offerId: "off-a", listingId: "list-b",
    });
    expect(store.size).toBe(2);
    const r = await removeLinkIndex({ offerId: "off-a", listingId: "list-b" });
    expect(r).toEqual({ offerDeleted: true, listingDeleted: true });
    expect(store.size).toBe(0);
  });

  it("is idempotent — 404 on non-existent id returns true", async () => {
    const r = await removeLinkIndex({ offerId: "never-existed" });
    expect(r.offerDeleted).toBe(true);
    expect(r.listingDeleted).toBe(false);
  });

  it("skips null ids", async () => {
    const r = await removeLinkIndex({ offerId: null, listingId: null });
    expect(r).toEqual({ offerDeleted: false, listingDeleted: false });
  });
});

describe("findByOfferId / findByListingId", () => {
  it("returns the index entry on point-read hit", async () => {
    await writeLinkIndex({
      userId: "u-42", holdingId: "h-99", offerId: "off-hit", listingId: "list-hit",
    });
    const byOffer = await findByOfferId("off-hit");
    const byListing = await findByListingId("list-hit");
    expect(byOffer).toMatchObject({
      userId: "u-42", holdingId: "h-99",
      ebayId: "off-hit", ebayIdKind: "offer",
    });
    expect(byListing).toMatchObject({
      userId: "u-42", holdingId: "h-99",
      ebayId: "list-hit", ebayIdKind: "listing",
    });
  });

  it("returns null on 404 miss", async () => {
    const r = await findByOfferId("does-not-exist");
    expect(r).toBeNull();
  });

  it("returns null on transient read failure (fallback contract)", async () => {
    const f = fakeContainer({ failMode: "throw-on-read" });
    _setContainerForTests(f.container);
    const r = await findByOfferId("anything");
    expect(r).toBeNull();
  });

  it("returns null on empty id (guard)", async () => {
    expect(await findByOfferId("")).toBeNull();
    expect(await findByListingId("")).toBeNull();
  });
});

describe("point-read intent — no cross-partition scans", () => {
  it("findByOfferId targets the exact (id, partition) tuple", async () => {
    const reads: Array<{ id: string; pk: string }> = [];
    const f = fakeContainer({ onRead: (id, pk) => reads.push({ id, pk }) });
    _setContainerForTests(f.container);
    await writeLinkIndex({ userId: "u", holdingId: "h", offerId: "off-x" });
    await findByOfferId("off-x");
    expect(reads).toEqual([{ id: "offer::off-x", pk: "off-x" }]);
  });
});
