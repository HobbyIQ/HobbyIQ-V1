import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const { relocateSoldComp, readBackKeptRow, readBackShowsWrite, dedupeYearPrefix } = require_(
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

describe("CF-BOTH-ADDRESSES-MOVE-TOGETHER (fold-checklist-numbered-twins.cjs's own relocate call)", () => {
  // Verified finding: tca-ebay rows observed with cardId at the target
  // (hiq:...:topps-finest:39:orange-refractor:no-auto:num-25) but
  // hobbyiqCardId still on the old slug (hiq:...:topps:39:orange-refractor:
  // no-auto). Reviewed fold-checklist-numbered-twins.cjs's own
  // relocatePartitionKeyedSales: it builds `keep` with BOTH `cardId:
  // targetId` and `hobbyiqCardId: targetId` set explicitly (never left to a
  // spread from the old row), and passes verifyFields: ["cardId",
  // "hobbyiqCardId"] to relocateSoldComp -- so a write that upserted the
  // fields correctly is the ONLY way `ok: true` comes back. These tests pin
  // that guarantee at the relocateSoldComp layer directly: a write that
  // (hypothetically) only moved cardId and left hobbyiqCardId stale is
  // ALWAYS reported ok:false, verify-mismatch, never silently accepted.
  const target = "hiq:baseball:2026:topps-finest:39:orange-refractor:no-auto:num-25";
  const stale = "hiq:baseball:2026:topps:39:orange-refractor:no-auto";

  it("a write that moved cardId but left hobbyiqCardId on the old slug is caught by verifyFields, never accepted", async () => {
    // Simulates the exact defect class: the upsert store somehow persisted
    // cardId at the target but hobbyiqCardId at the stale slug (as if `keep`
    // had been built without the explicit hobbyiqCardId override). The
    // read-back must show this mismatch and refuse, not report ok:true.
    const corrupted = { id: "tca-ebay::999", cardId: target, hobbyiqCardId: stale, price: 12 };
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => (pk === target ? { resource: corrupted } : { resource: null }),
        delete: async () => {},
      }),
      items: {
        upsert: async () => { /* pretend the corrupted doc landed */ },
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep: { id: "tca-ebay::999", cardId: target, hobbyiqCardId: target, price: 12 },
      drop: [{ id: "tca-ebay::999", cardId: stale }],
      verifyFields: ["cardId", "hobbyiqCardId"],
      guard: () => ({ verdict: "ok" }),
      wait: async () => {},
    });
    expect(res.ok).toBe(false);
    // Never deleted the old row when the keeper could not be verified --
    // CF-A-VERIFY-MISMATCH-IS-A-DUPLICATE-NOT-A-FAILURE: report it, do not
    // strand the sale by deleting the twin under an unverified keeper.
    expect(res.deleted).toHaveLength(0);
  });

  it("fold-checklist-numbered-twins.cjs's relocatePartitionKeyedSales builds `keep` with an explicit hobbyiqCardId override, not a spread default", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "fold-checklist-numbered-twins.cjs"),
      "utf8",
    );
    const fn = source.slice(source.indexOf("async function relocatePartitionKeyedSales"));
    expect(fn).toMatch(/cardId:\s*targetId/);
    expect(fn).toMatch(/hobbyiqCardId:\s*targetId/);
    // Both fields must be set in the SAME object literal, after the row
    // spread, so neither can be shadowed by a stale field from the old row.
    const keepLine = fn.split("\n").find((l) => l.includes("cardId: targetId"));
    expect(keepLine).toBeDefined();
    expect(keepLine).toMatch(/\.\.\.stripSystem\(row\)/);
    expect(keepLine).toMatch(/cardId:\s*targetId.*hobbyiqCardId:\s*targetId|hobbyiqCardId:\s*targetId.*cardId:\s*targetId/);
    expect(fn).toContain('verifyFields: ["cardId", "hobbyiqCardId"]');
  });

  it("the moveCatalogRow PATCH path (non-partition-keyed sales) never touches cardId -- this is not the same gap", () => {
    // moveCatalogRow's sales patch queries by hobbyiqCardId = oldId and
    // patches ONLY /hobbyiqCardId, because cardId is the partition key and
    // cannot be patched in place. For the rows it touches, cardId legitimately
    // stays whatever it always was (never the twin's own partition to begin
    // with), so there is no cardId/hobbyiqCardId divergence to introduce --
    // the patch path answers a different population than the relocate path.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "catalog", "catalogRowOps.service.ts"),
      "utf8",
    );
    const patchOpsBlock = source.slice(source.indexOf("const ops: PatchOperation[]"), source.indexOf("const ops: PatchOperation[]") + 400);
    expect(patchOpsBlock).toContain('path: "/hobbyiqCardId"');
    expect(patchOpsBlock).not.toContain('path: "/cardId"');
  });
});

describe("verifyNoDuplicatesAcrossPartitions -- OPTIONAL cross-partition backstop (run 36353646453)", () => {
  // Default OFF: no existing caller's fake pool answers this query shape, so
  // omitting the option must never issue it -- every one of the other 22+
  // callers is byte-for-byte unaffected.
  it("OFF by default: pool.items.query is never called for the extra verify", async () => {
    let queryCalls = 0;
    const written: Array<Record<string, unknown>> = [];
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => {},
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: () => { queryCalls++; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    };
    const keep = { id: "s::1", cardId: "hiq:a:1:b:1:base:no-auto", hobbyiqCardId: "hiq:a:1:b:1:base:no-auto" };
    const res = await relocateSoldComp(pool as never, {
      keep, drop: [], verifyFields: [], guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    // The read-back's OWN query fallback only fires when the point-read
    // never shows the write -- here the point-read finds `keep` on attempt 0
    // (upsert pushed it into `written` first), so queryCalls being 0 proves
    // NEITHER the read-back fallback NOR the new verify ran.
    expect(queryCalls).toBe(0);
  });

  it("ON, and the pool is clean: reports ok:true, no extra duplicatesLeft", async () => {
    const written: Array<Record<string, unknown>> = [];
    const deleted: string[] = [];
    const keep = { id: "s::1", cardId: "hiq:a:1:b:1:base:no-auto", hobbyiqCardId: "hiq:a:1:b:1:base:no-auto" };
    const drop = { id: "s::1", cardId: "hiq:a:1:b:1:base:no-auto:legacy" };
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => { deleted.push(`${id}@${pk}`); },
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: (spec: { query: string; parameters: Array<{ name: string; value: string }> }) => {
          expect(spec.query).toContain("SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE c.id = @id");
          const id = spec.parameters.find((p) => p.name === "@id")!.value;
          // The clean pool: only the keeper answers to this id, at keep.cardId.
          const resources = written.filter((w) => w.id === id).map((w) => ({ id: w.id, cardId: w.cardId, hobbyiqCardId: w.hobbyiqCardId }));
          return { fetchAll: async () => ({ resources }) };
        },
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep, drop: [drop], verifyFields: [], guard: () => ({ verdict: "ok" }),
      verifyNoDuplicatesAcrossPartitions: true,
    });
    expect(res.ok).toBe(true);
    expect(res.duplicatesLeft).toEqual([]);
    expect(deleted).toEqual([`${drop.id}@${drop.cardId}`]);
  });

  it("ON, and a leftover this call was never told about is still resident: reported in duplicatesLeft, ok:false", async () => {
    const keep = { id: "s::1", cardId: "hiq:a:1:b:1:base:no-auto", hobbyiqCardId: "hiq:a:1:b:1:base:no-auto" };
    const leftover = { id: "s::1", cardId: "1765857544536x502800993546556500", hobbyiqCardId: "hiq:a:1:b:1:base:no-auto" };
    const written: Array<Record<string, unknown>> = [];
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => {},
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        // The caller's OWN drop list never named `leftover` -- this is the
        // exact shape an upstream scan bug (the old id-only dedup in
        // sales-at-id.cjs) produces: a real document the delete loop was
        // never told to touch.
        query: () => ({ fetchAll: async () => ({ resources: [{ ...keep }, { ...leftover }] }) }),
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep, drop: [], verifyFields: [], guard: () => ({ verdict: "ok" }),
      verifyNoDuplicatesAcrossPartitions: true,
    });
    expect(res.ok).toBe(false);
    expect(res.duplicatesLeft).toHaveLength(1);
    expect(res.duplicatesLeft[0]).toMatchObject({
      id: "s::1",
      cardId: "1765857544536x502800993546556500",
      hobbyiqCardId: "hiq:a:1:b:1:base:no-auto",
      viaCrossPartitionVerify: true,
    });
  });

  it("ON, and the verify query itself throws: FAILED, never a clean ok:true", async () => {
    const keep = { id: "s::1", cardId: "hiq:a:1:b:1:base:no-auto", hobbyiqCardId: "hiq:a:1:b:1:base:no-auto" };
    const written: Array<Record<string, unknown>> = [];
    const pool = {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => {},
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: () => ({ fetchAll: async () => { throw new Error("probe: verify query threw"); } }),
      },
    };
    const res = await relocateSoldComp(pool as never, {
      keep, drop: [], verifyFields: [], guard: () => ({ verdict: "ok" }),
      verifyNoDuplicatesAcrossPartitions: true,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    expect(res.error).toMatch(/cross-partition duplicate verify threw/);
  });
});

/**
 * CF-CH-CARD-SET-ALREADY-HAS-THE-YEAR, THE MOVE-SIDE HALF (2026-09-28).
 *
 * The 2026-09-28 dedupe census (content-differs.csv) found 154/155 refused
 * "duplicate" pairs differing ONLY in a doubled leading product year --
 * "2025 2025 Topps Chrome Update Baseball #AC-AB Base" vs the healthy form
 * -- with the newer (repointed) copy carrying the bug in 71 of them. The
 * producer (backfill-sold-comps-from-ch.cjs) was fixed 2026-08-24 (commit
 * 0000f60); this is the healer for rows written before that fix, wired into
 * every mover that builds a `keep` object (rekey-product-setkey,
 * repoint-sales-by-list, repoint-sales-isauto-flip).
 */
describe("dedupeYearPrefix: idempotent leading-year de-duplication", () => {
  it("strips a doubled leading year down to one copy", () => {
    expect(dedupeYearPrefix("2025 2025 Topps Chrome Update Baseball #AC-AB Base", 2025)).toBe(
      "2025 Topps Chrome Update Baseball #AC-AB Base",
    );
  });

  it("leaves an already-singly-prefixed title unchanged", () => {
    const t = "2025 Topps Chrome Update Baseball #AC-AB Base";
    expect(dedupeYearPrefix(t, 2025)).toBe(t);
  });

  it("running it twice is a no-op (idempotent)", () => {
    const once = dedupeYearPrefix("2025 2025 Topps Chrome Update Baseball #AC-AB Base", 2025);
    const twice = dedupeYearPrefix(once, 2025);
    expect(twice).toBe(once);
  });

  it("leaves a title with no year prefix at all unchanged", () => {
    const t = "Cy Young 2025 2025 Topps Chrome Platinum Blue Vibrations Refractor /150 #251";
    // The doubled year here is NOT leading -- "Cy Young" comes first -- so
    // this is a different (unaddressed) shape, not the leading-prefix bug.
    expect(dedupeYearPrefix(t, 2025)).toBe(t);
  });

  it("does nothing without a year to compare against", () => {
    const t = "2025 2025 Topps Chrome Update Baseball #AC-AB Base";
    expect(dedupeYearPrefix(t, null)).toBe(t);
    expect(dedupeYearPrefix(t, undefined)).toBe(t);
  });

  it("handles a null/empty title without throwing", () => {
    expect(dedupeYearPrefix(null, 2025)).toBe("");
    expect(dedupeYearPrefix(undefined, 2025)).toBe("");
    expect(dedupeYearPrefix("", 2025)).toBe("");
  });

  it("also collapses a hyphen-joined doubled year", () => {
    expect(dedupeYearPrefix("1954-1954 Topps Baseball #133 Base", 1954)).toBe(
      "1954 Topps Baseball #133 Base",
    );
  });

  it("also collapses a hyphen BETWEEN the two years (review follow-up, PR #2474)", () => {
    // The gap fixed by this review round: dedupeYearPrefix's own regex used
    // to require its TWO year-tokens to be joined by [\s-]+ once, but the
    // FIRST fix's regex only matched a hyphen after the second year
    // ("<year> <year>-"), not between the two ("<year>-<year> "). Both gaps
    // now accept space OR hyphen.
    expect(dedupeYearPrefix("2025-2025 Topps Chrome Update Baseball #AC-AB Base", 2025)).toBe(
      "2025 Topps Chrome Update Baseball #AC-AB Base",
    );
  });
});

/**
 * CENTRALIZATION (review follow-up, 2026-09-28: PR #2474 review). The first
 * cut wired dedupeYearPrefix into three individual movers' own `keep`
 * builds -- but relocateSoldComp has ~30 callers that all build `keep` via
 * `stripSystem(row)` the same way, and the reviewer's count (~15+ found by
 * grepping `stripSystem(` near a relocateSoldComp call) is why it moved
 * INSIDE relocateSoldComp itself: every caller inherits the heal for free,
 * with no per-caller edit and no future mover starting unhealed by default.
 * These tests pin the heal at the ONE place it now lives, proving the
 * healed title is what actually gets upserted -- not merely what a helper
 * function returns in isolation.
 */
describe("relocateSoldComp heals a doubled-year title centrally, for every caller", () => {
  function poolFake(written: Array<Record<string, unknown>>) {
    return {
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: written.find((w) => w.id === id && w.cardId === pk) ?? null }),
        delete: async () => {},
      }),
      items: {
        upsert: async (d: Record<string, unknown>) => { written.push({ ...d }); },
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };
  }

  it("heals keep.title before the upsert, with no caller having to call dedupeYearPrefix itself", async () => {
    const written: Array<Record<string, unknown>> = [];
    const keep = {
      id: "ch-daily::1",
      cardId: "hiq:baseball:2025:topps-chrome-update-series:ac-ab:base:auto",
      hobbyiqCardId: "hiq:baseball:2025:topps-chrome-update-series:ac-ab:base:auto",
      cardYear: 2025,
      title: "2025 2025 Topps Chrome Update Baseball #AC-AB Base",
    };
    const res = await relocateSoldComp(poolFake(written) as never, {
      keep, drop: [], verifyFields: [], guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(written[0]!.title).toBe("2025 Topps Chrome Update Baseball #AC-AB Base");
    // The caller's own `keep` object is mutated in place too (same contract
    // the guard already has), so a caller reading `keep.title` afterward
    // (an example/plan-row log line, say) sees the healed form as well.
    expect(keep.title).toBe("2025 Topps Chrome Update Baseball #AC-AB Base");
  });

  it("representative mover: rekey-product-setkey's own keep shape (stripSystem + address rewrite) persists the healed title", async () => {
    // Mirrors rekey-product-setkey.cjs's own keep build: stripSystem(row)
    // then cardId/hobbyiqCardId/setKey overwritten -- title is carried
    // through UNTOUCHED by the caller, same as production code, and must
    // still come out healed because relocateSoldComp heals it centrally.
    const written: Array<Record<string, unknown>> = [];
    const row = {
      id: "tca-ebay::42", cardId: "1765857132073x655930228459218600",
      cardYear: 2025, title: "2025 2025 Topps Chrome Update Baseball #AC-AB Base",
    };
    const keep = { ...row };
    keep.cardId = "hiq:baseball:2025:topps-chrome-update-series:ac-ab:base:auto";
    (keep as Record<string, unknown>).hobbyiqCardId = keep.cardId;
    const res = await relocateSoldComp(poolFake(written) as never, {
      keep, drop: [{ id: row.id, cardId: row.cardId }], verifyFields: [], guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(written[0]!.title).toBe("2025 Topps Chrome Update Baseball #AC-AB Base");
  });

  it("representative mover: repoint-sales-isauto-flip's own keep shape (spread + address rewrite) persists the healed title", async () => {
    // Mirrors repoint-sales-isauto-flip.cjs's own
    // stripSystem({ ...sale, cardId: toId, hobbyiqCardId: toId }) shape.
    const written: Array<Record<string, unknown>> = [];
    const sale = {
      id: "tca-ebay::43", cardId: "hiq:baseball:2025:topps-chrome-update:ac-jv:base:no-auto",
      cardYear: 2025, title: "2025 2025 Topps Chrome Update Baseball #AC-JV Base",
    };
    const toId = "hiq:baseball:2025:topps-chrome-update-series:ac-jv:base:auto";
    const keep = { ...sale, cardId: toId, hobbyiqCardId: toId };
    const res = await relocateSoldComp(poolFake(written) as never, {
      keep, drop: [{ id: sale.id, cardId: sale.cardId }], verifyFields: [], guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(written[0]!.title).toBe("2025 Topps Chrome Update Baseball #AC-JV Base");
  });

  it("a title with no doubled year passes through unchanged -- centralization is a no-op for healthy rows", async () => {
    const written: Array<Record<string, unknown>> = [];
    const keep = {
      id: "tca-ebay::44", cardId: "hiq:baseball:2024:bowman-chrome:cpa-vh:gold-refractor:auto:num-50",
      cardYear: 2024, title: "2024 Bowman Chrome Victor Hurtado Gold Refractor Auto #CPA-VH",
    };
    const res = await relocateSoldComp(poolFake(written) as never, {
      keep, drop: [], verifyFields: [], guard: () => ({ verdict: "ok" }),
    });
    expect(res.ok).toBe(true);
    expect(written[0]!.title).toBe("2024 Bowman Chrome Victor Hurtado Gold Refractor Auto #CPA-VH");
  });
});
