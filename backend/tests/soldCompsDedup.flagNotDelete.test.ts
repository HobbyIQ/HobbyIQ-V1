/**
 * A DEDUP NEVER HARD-DELETES, AND THE GUARD MUST NOT BE REMOVABLE QUIETLY.
 *
 * Both dedup scripts hard-deleted (`container.item().delete()`). Neither has
 * ever run — sold-comps-clean.yml is workflow_dispatch-only with apply
 * defaulting false and ZERO runs ever — so nothing has been lost. They are
 * landmines to defuse, not an active leak, and this is the tripwire that keeps
 * them defused.
 *
 * Two kinds of assertion here, deliberately:
 *   - BEHAVIOURAL, against a fake container: what the code actually does to the
 *     pool. This is the real proof.
 *   - SOURCE-LEVEL, for the properties a fake cannot show — that no delete call
 *     is reachable in the path at all, and that the retracted normalization is
 *     gone rather than merely unreached on the paths the fake exercises.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const read = (p: string) => fs.readFileSync(path.join(backend, "scripts", p), "utf8");

const crossSource = read("crossSourceDedupSoldComps.cjs");
const soldCompsClean = read("sold-comps-cross-source-dedup.cjs");
const triage = read("triage-contenthash-collisions.cjs");
const triageLib = read(path.join("lib", "collision-triage.cjs"));

/** `Set.delete(x)` on the inflight tracker is not a Cosmos delete. Only a
 *  delete on a container ITEM removes a sale from the pool. */
const cosmosDeletes = (src: string): string[] =>
  src.split("\n").filter((l) => /\.item\([^)]*\)\s*\.delete\(|deleteWithRetry|\.items\.[a-zA-Z]*delete/.test(l));

describe("no hard delete survives in any dedup path", () => {
  for (const [name, src] of [
    ["crossSourceDedupSoldComps.cjs", crossSource],
    ["sold-comps-cross-source-dedup.cjs", soldCompsClean],
    ["triage-contenthash-collisions.cjs", triage],
    ["lib/collision-triage.cjs", triageLib],
  ] as const) {
    it(`${name} never deletes a pool row`, () => {
      expect(cosmosDeletes(src)).toEqual([]);
    });
  }

  it("the old deleteWithRetry helper is gone, not merely unused", () => {
    expect(crossSource).not.toMatch(/function deleteWithRetry/);
    expect(crossSource).toMatch(/function flagWithRetry/);
  });

  it("both scripts exclude by flaggedWrong instead", () => {
    for (const src of [crossSource, soldCompsClean]) {
      expect(src).toMatch(/"\/flaggedWrong", value: true/);
    }
  });

  it("every flag carries provenance: which row superseded it, why, and when", () => {
    for (const src of [crossSource, soldCompsClean, triage]) {
      expect(src).toMatch(/\/dedupSupersededBy/);
      expect(src).toMatch(/\/dedupReason/);
      expect(src).toMatch(/\/dedupAt/);
    }
  });

  it("`supersededBy` is NOT invented — flaggedWrong is the existing filter surface", () => {
    // Every FMV read path already filters flaggedWrong. A new field would have
    // to be threaded through all of them before it excluded anything at all.
    for (const src of [crossSource, soldCompsClean, triage]) {
      expect(src).not.toMatch(/"\/supersededBy"/);
    }
  });
});

describe("the retracted \" Refractor\" strip is gone from both normParallel copies", () => {
  it("neither dedup script strips a trailing Refractor", () => {
    for (const src of [crossSource, soldCompsClean]) {
      expect(src).not.toMatch(/replace\(\/ refractors\?\$\//);
    }
  });

  it("crossSourceDedupSoldComps still normalizes whitespace and case", () => {
    // The fix removes the RETRACTED rule, not the normalization around it.
    const fn = crossSource.slice(crossSource.indexOf("function normParallel"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/toLowerCase\(\)/);
    expect(body).toMatch(/\\s\+/);
  });
});

describe("minute precision is backported to sold-comps-cross-source-dedup (af14c29c)", () => {
  it("the group key uses TIME_SLICE_LEN, not a hardcoded 10-char day", () => {
    const fn = soldCompsClean.slice(soldCompsClean.indexOf("function groupKey"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/TIME_SLICE_LEN/);
    expect(body).not.toMatch(/slice\(0, 10\)/);
  });

  it("minute is the default precision", () => {
    expect(soldCompsClean).toMatch(/TIME_PRECISION\s*=\s*\(process\.env\.TIME_PRECISION \|\| "minute"\)/);
    expect(soldCompsClean).toMatch(/TIME_PRECISION === "day" \? 10 : TIME_PRECISION === "hour" \? 13 : 16/);
  });
});

// ── behavioural: what the code does to a pool ────────────────────────────────

type Patch = { op: string; path: string; value: unknown };
type Call = { id: string; pk: string; ops: Patch[] };

/** A container that records patches and FAILS LOUDLY on any delete. */
function fakeContainer(rows: Record<string, unknown>[]) {
  const patches: Call[] = [];
  const deletes: string[] = [];
  return {
    patches,
    deletes,
    item: (id: string, pk: string) => ({
      patch: async (ops: Patch[]) => { patches.push({ id, pk, ops }); return {}; },
      delete: async () => { deletes.push(id); throw new Error("a dedup must never delete a pool row"); },
      read: async () => ({ resource: rows.find((r) => r.id === id) ?? null }),
    }),
  };
}

describe("flagWithRetry writes a reversible exclusion, never a delete", () => {
  it("patches flaggedWrong plus provenance, and touches nothing else", async () => {
    // The helper is module-private, so it is exercised through the real file
    // with the container it would be handed in production.
    const src = crossSource
      .replace(/^const \{ CosmosClient \}.*$/m, "const CosmosClient = null;")
      .replace(/^main\(\).*$/m, "");
    const mod = { exports: {} as Record<string, unknown> };
    const fn = new Function("module", "exports", "require", "process", `${src}\nmodule.exports = { flagWithRetry };`);
    fn(mod, mod.exports, require_, { ...process, env: { ...process.env, COSMOS_CONNECTION_STRING: "x" } });
    const flagWithRetry = mod.exports.flagWithRetry as (
      c: unknown, id: string, pk: string, o: { survivingId: string; reason: string }
    ) => Promise<boolean>;

    const pool = fakeContainer([{ id: "loser", cardId: "hiq:x" }]);
    await flagWithRetry(pool, "loser", "hiq:x", { survivingId: "winner", reason: "shared-id:555" });

    expect(pool.deletes).toEqual([]);
    expect(pool.patches).toHaveLength(1);
    const ops = pool.patches[0].ops;
    expect(ops.find((o) => o.path === "/flaggedWrong")?.value).toBe(true);
    expect(ops.find((o) => o.path === "/dedupSupersededBy")?.value).toBe("winner");
    expect(ops.find((o) => o.path === "/dedupReason")?.value).toBe("shared-id:555");
    expect(ops.some((o) => o.path === "/dedupAt")).toBe(true);
    // the sale itself is untouched: no price, soldAt or identity is rewritten
    expect(ops.every((o) => o.path.startsWith("/flagged") || o.path.startsWith("/dedup"))).toBe(true);
  });
});

describe("only-improve: a flag is never lifted and never re-stamped", () => {
  it("crossSourceDedupSoldComps skips a row that is already flagged", () => {
    expect(crossSource).toMatch(/if \(s\.row\.flaggedWrong === true\) \{ alreadyFlagged\+\+; continue; \}/);
  });

  it("sold-comps-cross-source-dedup skips a row that is already flagged", () => {
    expect(soldCompsClean).toMatch(/if \(row\.flaggedWrong === true\) \{ already\+\+; continue; \}/);
  });

  it("the triage's flag helper returns early on an already-flagged row", () => {
    const fn = triage.slice(triage.indexOf("async function flagSuperseded"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/if \(row\.flaggedWrong === true\) return "already-flagged"/);
  });

  it("nothing anywhere sets flaggedWrong back to false", () => {
    for (const src of [crossSource, soldCompsClean, triage]) {
      expect(src).not.toMatch(/"\/flaggedWrong", value: false/);
    }
  });
});
