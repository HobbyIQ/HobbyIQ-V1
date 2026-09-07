import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const { relocateSoldComp, readBackKeptRow, readBackShowsWrite } = require_(
  path.join(LIB, "relocate-sold-comp.cjs"),
);

/**
 * THE READ-BACK VERIFIES THE KEEPER, NOT "SOME DOCUMENT".
 *
 * rematch-sold-comps IMPROVE, run 34004076637 (slot 26/32), reported four rows
 * as `FAILED at verify ...: read-back differs from the written row`. All four
 * keepers were in fact written correctly -- each is alive at its new address
 * carrying that run's own `rekeyedAt` (within 50ms of the log line) and a
 * `rekeyedFrom` naming the old identity -- and because the verify branch never
 * deletes, each id is now resident at TWO addresses:
 *
 *   tca-ebay::298562350714 | ::267756256691 | ::307125592205
 *       keeper hiq:pokemon:2015:xy7:98:base:no-auto
 *       twin   hiq:pokemon:2015:unknown:98:base:no-auto:num-98
 *   tca-ebay::366607950797
 *       keeper hiq:baseball:2015:bowman-chrome:62:refractor:no-auto:num-499
 *       twin   hiq:baseball:2015:bowman-chrome:62:base:no-auto
 *
 * TWO defects, and the tests below pin both.
 *
 * 1. A STALE READ IS NOT ALWAYS A 404. The retry loop accepted the first
 *    NON-NULL document, so when the keeper's address already held a document a
 *    lagging replica answered with the pre-upsert version instead of 404 --
 *    non-null, therefore accepted on attempt 0. The backoff retries and the
 *    query fallback never ran, and the caller compared its verifyFields
 *    against a row the helper had already called verified.
 *
 * 2. THE FALLBACK QUERY COULD ANSWER WITH THE TWIN. It OR'd on
 *    `c.hobbyiqCardId = @slug`, and a row's old-address twin carries a
 *    hobbyiqCardId too -- so the query used to confirm a move could hand back
 *    the very row the move is leaving behind.
 */
describe("readBackKeptRow: only a read that SHOWS THE WRITE is a read-back", () => {
  const keep = {
    id: "tca-ebay::366607950797",
    cardId: "hiq:baseball:2015:bowman-chrome:62:refractor:no-auto:num-499",
    hobbyiqCardId: "hiq:baseball:2015:bowman-chrome:62:refractor:no-auto:num-499",
    rekeyedAt: "2026-09-06T02:02:50.346Z",
  };
  // The real stale twin, from the container. Note it carries a hobbyiqCardId
  // that ends in the SAME `:num-499` tail -- which is exactly how an OR on
  // hobbyiqCardId can pick it up.
  const twin = {
    id: "tca-ebay::366607950797",
    cardId: "hiq:baseball:2015:bowman-chrome:62:base:no-auto",
    hobbyiqCardId: "hiq:baseball:2015:bowman-chrome:62:base:no-auto:num-499",
  };
  const VERIFY = ["cardId", "hobbyiqCardId", "rekeyedAt"];

  it("retries past a stale non-null point-read and returns the keeper", async () => {
    // Defect 1, exactly: attempt 0 answers with the PRE-UPSERT version of the
    // row at the keeper's own address (no rekeyedAt yet). Before the fix this
    // was returned as the read-back and the caller called it a mismatch.
    const stale = { id: keep.id, cardId: keep.cardId, hobbyiqCardId: keep.hobbyiqCardId };
    let reads = 0;
    const pool = {
      item: () => ({
        read: async () => {
          reads += 1;
          return { resource: reads === 1 ? stale : keep };
        },
      }),
      items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    };

    const back = await readBackKeptRow(pool, keep, (fn: any) => fn(), async () => {}, VERIFY);

    expect(reads).toBeGreaterThan(1); // the stale read did NOT end the loop
    expect(back).toBeTruthy();
    expect(back.rekeyedAt).toBe(keep.rekeyedAt);
    expect(back.__via).toBe("point-read-retry-1");
  });

  it("the query fallback returns the keeper where the OR-query would return the twin", async () => {
    // THE MUTATION TARGET. The point read never shows the write (every attempt
    // 404s), so the fallback query decides. This fake container answers the
    // query the way Cosmos would: the keeper matches `c.cardId = @pk`, and the
    // TWIN matches `c.hobbyiqCardId = @slug` -- so a query that OR's on the
    // slug returns BOTH, and the twin is the row this helper is moving away
    // from. Restore the OR and this test goes red.
    const rows = [keep, twin];
    let sawQuery = "";
    const pool = {
      item: () => ({
        read: async () => {
          const e: any = new Error("NotFound");
          e.code = 404;
          throw e;
        },
      }),
      items: {
        query: (spec: any) => {
          sawQuery = String(spec.query);
          const p = Object.fromEntries(spec.parameters.map((x: any) => [x.name, x.value]));
          const orOnSlug = /hobbyiqCardId\s*=\s*@slug/.test(sawQuery);
          const resources = rows.filter(
            (r: any) =>
              r.id === p["@id"] &&
              (r.cardId === p["@pk"] || (orOnSlug && r.hobbyiqCardId === p["@slug"])),
          );
          return { fetchAll: async () => ({ resources }) };
        },
      },
    };

    const back = await readBackKeptRow(pool, keep, (fn: any) => fn(), async () => {}, VERIFY);

    // The query must not be addressed by hobbyiqCardId at all: the twin
    // carries one, so an OR on it is a query that can confirm the wrong row.
    expect(sawQuery).not.toMatch(/hobbyiqCardId/);
    expect(back).toBeTruthy();
    expect(back.cardId).toBe(keep.cardId);
    expect(back.rekeyedAt).toBe(keep.rekeyedAt);
    expect(back.__via).toBe("query-point-read");
  });

  it("a read that never shows the write is still null — the caller deletes nothing", async () => {
    // The safety this fix must not weaken: a genuinely missing keeper is still
    // a failure, and the old row is still not deleted.
    const pool = {
      item: () => ({
        read: async () => {
          const e: any = new Error("NotFound");
          e.code = 404;
          throw e;
        },
      }),
      items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    };
    const back = await readBackKeptRow(pool, keep, (fn: any) => fn(), async () => {}, VERIFY);
    expect(back).toBeNull();
  });

  it("readBackShowsWrite is the SAME predicate the caller applies", () => {
    // One predicate, or the helper can accept a document the caller then
    // rejects -- which is the whole shape of run 34004076637's four failures.
    expect(readBackShowsWrite(keep, keep, ["cardId", "hobbyiqCardId", "rekeyedAt"])).toBe(true);
    expect(readBackShowsWrite(twin, keep, ["cardId"])).toBe(false);
    expect(readBackShowsWrite({ ...keep, rekeyedAt: undefined }, keep, ["rekeyedAt"])).toBe(false);
    expect(readBackShowsWrite(null, keep, [])).toBe(false);
  });
});

describe("relocateSoldComp: the stale replica no longer costs a re-key", () => {
  it("a stale first read is retried past, and the old row IS deleted", async () => {
    // End to end, the run-34004076637 shape: the keeper's address already held
    // a document, the first read-back showed the pre-upsert version, and the
    // relocate reported `FAILED at verify` while the write had landed. It now
    // completes -- which is what keeps the id from being resident twice.
    const keep = {
      id: "tca-ebay::298562350714",
      cardId: "hiq:pokemon:2015:xy7:98:base:no-auto",
      hobbyiqCardId: "hiq:pokemon:2015:xy7:98:base:no-auto",
      rekeyedAt: "2026-09-06T02:02:02.372Z",
    };
    const drop = {
      id: "tca-ebay::298562350714",
      cardId: "hiq:pokemon:2015:unknown:98:base:no-auto:num-98",
    };
    const stale = { id: keep.id, cardId: keep.cardId, hobbyiqCardId: "hiq:pokemon:2015:unknown:98:base:no-auto" };

    let readBacks = 0;
    const deleted: string[] = [];
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => {
          if (pk !== keep.cardId) return { resource: null };
          readBacks += 1;
          // 1st read = the pre-upsert existence probe, 2nd = stale read-back.
          return { resource: readBacks <= 2 ? stale : keep };
        },
        delete: async () => {
          deleted.push(`${id}@${pk}`);
        },
      }),
      items: {
        upsert: async () => ({ resource: keep }),
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [drop],
      verifyFields: ["cardId", "hobbyiqCardId", "rekeyedAt"],
      wait: async () => {},
    });

    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toHaveLength(0);
    expect(deleted).toEqual([`${drop.id}@${drop.cardId}`]);
  });
});

describe("the mover guards the address it is moving TO", () => {
  // CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07). Being the sanctioned mover
  // is about ORDER -- never losing the sale between the upsert and the delete.
  // It was never about the ADDRESS: `to` comes from a list file, and until now
  // the mover wrote it unchecked, so a re-key to an unreadable key landed with
  // a verified read-back to prove it. The guard is injected here (the shipped
  // path loads it from dist/), so these drive the decision directly.
  const OK = "hiq:baseball:2024:topps:1:base:no-auto";
  const keeper = () => ({ id: "tca-ebay::1", cardId: OK, hobbyiqCardId: OK, price: 5, soldAt: "2024-05-01" });

  it("REFUSES a malformed destination, and writes and deletes nothing", async () => {
    const calls: string[] = [];
    const pool = {
      item: () => ({ read: async () => { calls.push("read"); return { resource: null }; },
                     delete: async () => { calls.push("delete"); } }),
      items: { upsert: async () => { calls.push("upsert"); }, query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    };
    const res = await relocateSoldComp(pool as never, {
      keep: keeper(), drop: [{ id: "tca-ebay::1", cardId: "hiq:football:2024:topps:1:base:no-auto" }],
      guard: () => ({ verdict: "park", reason: "malformed-key", detail: "the cardId address has an EMPTY sport segment" }),
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("guard");
    expect(String(res.error)).toContain("EMPTY sport segment");
    // The whole point: an unaddressable destination is REFUSED, not written.
    // A row half-moved to a key nothing can read back is worse than not moved.
    expect(calls).toEqual([]);
    expect(res.duplicatesLeft).toEqual([]);
  });

  it("a dry run reports the SAME refusal an APPLY would hit", async () => {
    const res = await relocateSoldComp({} as never, {
      keep: keeper(), drop: [], dryRun: true,
      guard: () => ({ verdict: "park", reason: "malformed-key", detail: "unreadable" }),
    });
    // Judged ahead of the dry-run return, so an operator sees the refusal
    // before APPLY rather than a plan that will not happen.
    expect(res.stage).toBe("guard");
    expect(res.ok).toBe(false);
  });

  it("a SPLIT-identity park still MOVES -- the sale is real, it just carries the stamp", async () => {
    const written: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    const keep = keeper();
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => { deleted.push(`${id}@${pk}`); },
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep, drop: [{ id: "tca-ebay::1", cardId: "hiq:football:2024:topps:1:base:no-auto" }],
      verifyFields: ["cardId", "hobbyiqCardId"],
      guard: (doc: Record<string, unknown>) => {
        doc.identityUnverified = true;
        doc.identityUnverifiedReason = "split-identity";
        return { verdict: "park", reason: "split-identity", detail: "sport disagrees" };
      },
    });
    expect(res.ok).toBe(true);
    expect(written).toHaveLength(1);
    // Parked out of every pool, but PRESENT -- and the old address is gone, so
    // the row is not left resident at two addresses.
    expect(written[0]!.identityUnverified).toBe(true);
    expect(deleted).toEqual(["tca-ebay::1@hiq:football:2024:topps:1:base:no-auto"]);
  });

  it("an OK verdict moves the row exactly as before", async () => {
    const written: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => { deleted.push(`${id}@${pk}`); },
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep: keeper(), drop: [{ id: "tca-ebay::1", cardId: "hiq:football:2024:topps:1:base:no-auto" }],
      verifyFields: ["cardId", "hobbyiqCardId"],
      guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(written[0]!.identityUnverified).toBeUndefined();
    expect(deleted).toHaveLength(1);
  });
});
