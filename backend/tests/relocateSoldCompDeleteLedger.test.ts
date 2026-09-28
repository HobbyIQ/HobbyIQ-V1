import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const R = require_(path.join(LIB, "relocate-sold-comp.cjs"));
const DL = require_(path.join(LIB, "delete-ledger.cjs"));

/**
 * relocateSoldComp's `ledger` option -- CF-NO-DELETE-WITHOUT-A-FULL-
 * DOCUMENT-LEDGER-LINE-FIRST (2026-09-28), wired at the ONE seam this
 * shared mover's own delete loop offers, which is why it covers most of the
 * ~30 callers grepped in this file's own header without touching each one.
 *
 * THE DROP OBJECT IS NOT THE FULL DOCUMENT. Every real caller (repoint-
 * sales-by-list.cjs, rekey-product-setkey.cjs, ...) hands in `drop: [{ id,
 * cardId }]` only -- never price/soldAt/grade/title. So the ledger step
 * re-reads the full document from the pool at the drop's own address right
 * before writing the ledger line; these tests seed the fake pool with a
 * FULL row at that address and pass only `{ id, cardId }` as the drop,
 * mirroring every real caller, to prove the re-read (not the drop object)
 * is what lands in the ledger.
 *
 * Three things this file pins:
 *   1. every delete this loop performs, when `ledger` is supplied, is
 *      preceded by a ledger line carrying the FULL document from that
 *      drop's own address;
 *   2. a ledger-write failure refuses that ONE delete (reported in
 *      `duplicatesLeft`, `ledgerWriteFailed: true`) without ever calling
 *      `.delete()` for it, while every OTHER drop in the same call still
 *      proceeds normally -- one failing ledger line does not sink the
 *      whole relocate.
 *   3. omitting `ledger` entirely (every existing caller) is byte-for-byte
 *      unchanged from before this option existed.
 */
type Doc = Record<string, any>;

function fakePool(seed: Doc[] = []) {
  const store = new Map<string, Doc>();
  const key = (id: string, pk: string) => `${pk}::${id}`;
  for (const d of seed) store.set(key(d.id, d.cardId), { ...d });
  return {
    store,
    items: {
      upsert: async (doc: Doc) => {
        store.set(key(doc.id, doc.cardId), { ...doc });
        return { resource: { ...doc } };
      },
    },
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        if (!store.delete(key(id, pk))) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return {};
      },
    }),
  };
}

const noGuard = () => ({ verdict: "ok" });

describe("relocateSoldComp's ledger option", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-ledger-test-"));
    process.env.LEDGER_OUT = tmp;
    DL.closeAllLedgerFds();
  });

  afterEach(() => {
    DL.closeAllLedgerFds();
    delete process.env.LEDGER_OUT;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("writes a full-document ledger line before deleting each drop", async () => {
    const oldRow = {
      id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto",
      price: 5.5, soldAt: "2026-09-01T00:00:00.000Z", title: "old address copy",
    };
    const pool = fakePool([oldRow]);
    const keep = { id: "s1", cardId: "hiq:baseball:2025:topps:1:auto:no-auto", price: 5.5, title: "new address copy" };
    // The keeper must be readable back for relocateSoldComp to reach the
    // delete loop at all -- seed it too.
    await pool.items.upsert(keep);

    const result = await R.relocateSoldComp(pool, {
      keep, drop: [{ id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto" }],
      verifyFields: [], guard: noGuard,
      ledger: { lane: "test-relocate-lane", action: "move", reason: "unit-test", toId: keep.cardId, container: "sold_comps" },
    });

    expect(result.deleted.length).toBe(1);
    expect(pool.store.has("hiq:baseball:2025:topps:1:base:no-auto::s1")).toBe(false);

    const ledgerPath = DL.ledgerPathFor("test-relocate-lane");
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.doc.id).toBe("s1");
    expect(line.doc.cardId).toBe("hiq:baseball:2025:topps:1:base:no-auto");
    // The FULL document, not a summary -- price/soldAt/title all present,
    // exactly the fields the isauto-flip incident's plan-line-only trail
    // never carried.
    expect(line.doc.price).toBe(5.5);
    expect(line.doc.soldAt).toBe("2026-09-01T00:00:00.000Z");
    expect(line.doc.title).toBe("old address copy");
    expect(line.toId).toBe(keep.cardId);
    expect(line.container).toBe("sold_comps");
  });

  it("refuses the delete (never calls .delete()) when the ledger write fails, without touching other drops", async () => {
    const oldRow1 = { id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto", price: 1 };
    const oldRow2 = { id: "s2", cardId: "hiq:baseball:2025:topps:2:base:no-auto", price: 2 };
    const pool = fakePool([oldRow1, oldRow2]);
    const keep = { id: "s1", cardId: "hiq:baseball:2025:topps:1:auto:no-auto", price: 1 };
    await pool.items.upsert(keep);

    // Force the ledger write to fail: point LEDGER_OUT at a path a file
    // already occupies, so mkdirSync throws inside appendLedgerLineSync.
    const blocker = path.join(tmp, "blocked");
    fs.writeFileSync(blocker, "occupied");
    process.env.LEDGER_OUT = blocker;
    DL.closeAllLedgerFds();

    const deleteCallsById: Record<string, number> = {};
    const realItem = pool.item.bind(pool);
    (pool as any).item = (id: string, pk: string) => {
      const wrapped = realItem(id, pk);
      const realDelete = wrapped.delete;
      wrapped.delete = async (...args: any[]) => {
        deleteCallsById[id] = (deleteCallsById[id] ?? 0) + 1;
        return realDelete(...args);
      };
      return wrapped;
    };

    const result = await R.relocateSoldComp(pool, {
      keep,
      drop: [
        { id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto" }, // ledger-write-failed -> .delete() never reached
        { id: "s9-not-a-drop", cardId: "hiq:baseball:2025:topps:9:base:no-auto" }, // never in the pool -> ordinary 404 (already gone); proves the loop CONTINUES past the ledger failure
      ],
      verifyFields: [], guard: noGuard,
      ledger: { lane: "blocked-lane", action: "move", reason: "unit-test" },
    });

    // The FIRST drop's delete is refused by the ledger failure -- .delete()
    // for it is never reached.
    expect(deleteCallsById["s1"]).toBeUndefined();
    // The SECOND drop still ran its own delete call (and 404'd, harmlessly,
    // since it was never in the pool) -- one failing ledger line does not
    // abort the rest of the loop.
    expect(deleteCallsById["s9-not-a-drop"]).toBe(1);
    expect(result.alreadyGone.some((d: any) => d.id === "s9-not-a-drop")).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.duplicatesLeft.length).toBeGreaterThanOrEqual(1);
    const failedDrop = result.duplicatesLeft.find((d: any) => d.id === "s1");
    expect(failedDrop).toBeDefined();
    expect(failedDrop.ledgerWriteFailed).toBe(true);
    // The row is STILL in the pool -- nothing was lost.
    expect(pool.store.has("hiq:baseball:2025:topps:1:base:no-auto::s1")).toBe(true);
  });

  it("omitting `ledger` entirely behaves exactly as before this option existed", async () => {
    const oldRow = { id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto", price: 1 };
    const pool = fakePool([oldRow]);
    const keep = { id: "s1", cardId: "hiq:baseball:2025:topps:1:auto:no-auto", price: 1 };
    await pool.items.upsert(keep);

    const result = await R.relocateSoldComp(pool, {
      keep, drop: [{ id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto" }],
      verifyFields: [], guard: noGuard,
      // no `ledger` key at all
    });

    expect(result.ok).toBe(true);
    expect(result.deleted.length).toBe(1);
    expect(pool.store.has("hiq:baseball:2025:topps:1:base:no-auto::s1")).toBe(false);
  });
});
