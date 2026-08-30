/**
 * THE PARTITION KEY. sold_comps is partitioned on /cardId, and a partition key
 * cannot be patched. `moveCatalogRow` patches /hobbyiqCardId in place, which is
 * correct ONLY while the sale's cardId is not the loser's own slug.
 *
 * Measured: 474,654 of 1,257,125 2025-baseball pool rows (37.8%) and 332,308 of
 * 2,516,369 football rows (13.2%) carry a hiq slug as cardId. On the ray-wave
 * loser alone, 172 of 487 sales are in that state.
 *
 * Those rows must go through relocateSoldComp (upsert -> verify read-back ->
 * delete) and be counted on their OWN line. `salesRelocated` is different work
 * from `salesRepointed`: a slice is not a sibling counter, and summing them
 * would report work that never happened.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

describe("the two paths are chosen by the partition key", () => {
  it("branches on whether cardId IS the loser slug", () => {
    expect(source).toMatch(/if \(String\(row\.cardId \?\? ""\) === loserId\)/);
  });

  it("a sale whose cardId is the loser slug goes through relocateSoldComp", () => {
    const branch = source.slice(source.indexOf('if (String(row.cardId ?? "") === loserId)'));
    const untilElse = branch.slice(0, branch.indexOf("} else {"));
    expect(untilElse).toMatch(/relocateSoldComp\(/);
    expect(untilElse).toMatch(/stats\.salesRelocated\+\+/);
    // upsert -> verify read-back -> delete is the helper's contract; the caller
    // must actually ask for the verification.
    expect(untilElse).toMatch(/verifyFields: \["cardId", "hobbyiqCardId"\]/);
    expect(untilElse).toMatch(/drop: \[\{ id: row\.id, cardId: loserId \}\]/);
  });

  it("a sale under a foreign partition is patched in place and counted separately", () => {
    const branch = source.slice(source.indexOf("} else {", source.indexOf('if (String(row.cardId ?? "") === loserId)')));
    expect(branch.slice(0, 900)).toMatch(/\.patch\(\[/);
    expect(branch.slice(0, 900)).toMatch(/stats\.salesRepointed\+\+/);
  });

  it("the relocated row carries a RECOMPUTED contentHash for its new partition", () => {
    // contentHash is scoped to cardId. A row that moves partition carrying its
    // old hash is invisible to the store's pre-write dedup forever.
    expect(source).toMatch(/keep\.contentHash = contentHashOf\(keep\)/);
  });
});

describe("the counters are disjoint and never summed", () => {
  it("salesRepointed and salesRelocated are reported on their OWN lines", () => {
    expect(source).toMatch(/sales re-pointed \(patch\)/);
    expect(source).toMatch(/sales relocated \(re-key\)/);
  });

  it("no line adds the two together", () => {
    expect(source).not.toMatch(/salesRepointed \+ stats\.salesRelocated/);
    expect(source).not.toMatch(/salesRelocated \+ stats\.salesRepointed/);
  });

  it("a failed relocate is counted as failed, never as relocated", () => {
    expect(source).toMatch(/if \(res\.ok\) \{ stats\.salesRelocated\+\+; moved\+\+; \} else \{ stats\.salesRelocateFailed\+\+; \}/);
  });

  it("the reconciliation lists sales as COLLATERAL, not as rows written", () => {
    // Sales moved are not catalog rows written; folding them into `written`
    // would make the write reconciliation claim work it did not do.
    const rw = source.slice(source.indexOf("reportWrites({"));
    expect(rw.slice(0, 500)).toMatch(/written: stats\.consolidated/);
    expect(rw.slice(0, 500)).not.toMatch(/salesRepointed/);
    expect(source).toMatch(/collateral \(not rows written\)/);
  });
});

describe("the row is deleted LAST", () => {
  it("moves sales before the catalog row move", () => {
    const salesMove = source.indexOf("const it = pool.items.query(");
    const rowMove = source.indexOf("const res = await moveCatalogRow(cat, loser");
    expect(salesMove).toBeGreaterThan(-1);
    expect(rowMove).toBeGreaterThan(salesMove);
  });
});
