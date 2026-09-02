/**
 * THE contentHash GUARD IS PRE-FLIGHT, NOT POST-HOC.
 *
 * The first build probed the hash INSIDE `moveSalesAndRow`, incremented a
 * counter, and refused AFTER the group loop had finished. Under APPLY that
 * refusal is theatre: every colliding sale is already upserted or patched onto
 * the winner's partition by the time `exit(2)` fires, and `exit(2)` only
 * spares the groups the loop had not reached. Since `contentHash` is the
 * store's partition-scoped PRE-WRITE dedup key, each collision landed means a
 * future genuine sale is silently swallowed at ingest -- the exact outcome the
 * guard exists to prevent.
 *
 * This is an ORDERING property, so it is asserted on the ORDER of the source:
 * the probe and its refusal must both sit ABOVE the first write. A behavioural
 * test cannot see it without a live Cosmos, and the failure only appears under
 * APPLY, which is precisely why it shipped green.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

const at = (needle: string): number => {
  const i = source.indexOf(needle);
  expect(i, `expected to find ${needle} in the fleet`).toBeGreaterThan(-1);
  return i;
};

describe("the refusal happens BEFORE the first write", () => {
  it("the pre-flight runs, and refuses, above the write phase", () => {
    const preflightCall = at("await preflightHashCollisions(plan)");
    const refusal = at("preflight.collisions > 0");
    const writePhase = at("-- the write phase");
    const firstWrite = at("await moveSalesAndRow(");

    expect(preflightCall).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(writePhase);
    expect(writePhase).toBeLessThan(firstWrite);
  });

  it("the refusal exits 2 and says nothing was written", () => {
    const block = source.slice(at("preflight.collisions > 0"), at("-- the write phase"));
    expect(block).toMatch(/process\.exit\(2\)/);
    expect(block).toMatch(/NOTHING HAS BEEN WRITTEN/);
  });

  it("the decide loop collects a PLAN instead of writing as it goes", () => {
    expect(source).toMatch(/plan\.push\(\{ key, kind, rows, winner, losers, reason/);
    // and the write loop consumes that plan
    const writePhase = source.slice(at("-- the write phase"), at("-- report ---"));
    expect(writePhase).toMatch(/for \(const \{ key, kind, rows, winner, losers, reason \} of plan\)/);
  });

  it("the OLD post-hoc guard is gone: no collision refusal survives below the write loop", () => {
    const belowWrites = source.slice(at("await moveSalesAndRow("));
    expect(belowWrites).not.toMatch(/hashCollisionRisk > 0/);
    expect(belowWrites).not.toMatch(/process\.exit\(2\)/);
  });

  it("the probe no longer lives inside moveSalesAndRow", () => {
    const fn = source.slice(at("async function moveSalesAndRow"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toMatch(/hashCollisionRisk\+\+/);
    expect(body).not.toMatch(/seenHash/);
  });
});

describe("the seen-set is seeded with the WINNER's own sales", () => {
  const fn = source.slice(at("async function preflightHashCollisions"), at("let gi = 0;"));

  it("the winner's existing sales go into the set BEFORE any loser is probed", () => {
    const seed = fn.indexOf("salesUnder(pool, winnerId)");
    const losers = fn.indexOf("for (const loser of losers)");
    expect(seed).toBeGreaterThan(-1);
    expect(losers).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(losers);
  });

  it("the hash index is scoped per WINNER PARTITION, not per loser", () => {
    // The first build scoped `seenHash` per LOSER inside moveSalesAndRow, so a
    // loser colliding with the WINNER's sales -- or with another loser's --
    // was never counted. Its reported 530 was a floor, not the count.
    //
    // D30-R3 replaced the seen-SET with a hash-keyed MAP of clusters, because
    // the criterion is no longer "has this hash been seen?" but "what is IN
    // this cluster?" -- a cluster blocks only when >= 2 of its rows share a
    // sourceExternalId. The scope property is unchanged and still pinned here.
    const perGroup = fn.indexOf("const byHash = new Map()");
    const perLoser = fn.indexOf("for (const loser of losers)");
    expect(perGroup).toBeGreaterThan(-1);
    expect(perGroup).toBeLessThan(perLoser);
  });

  it("every loser adds into the SAME index, so cross-loser collisions count", () => {
    // The winner's sales and every loser's go through one `add`, which appends
    // to the cluster for that hash. Nothing is re-initialised per loser.
    expect(fn).toMatch(/for \(const row of await salesUnder\(pool, winnerId\)\) add\(row\)/);
    expect(fn).toMatch(/for \(const row of await salesUnder\(pool, String\(loser\.id\)\)\) add\(row\)/);
    expect(fn).toMatch(/byHash\.set\(h, arr\)/);
  });

  it("a cluster of one is never a collision, and the count is rows-beyond-the-first", () => {
    expect(fn).toMatch(/if \(cluster\.length < 2\) continue/);
    expect(fn).toMatch(/const extra = cluster\.length - 1/);
  });

  it("only an unresolved true dupe blocks; the rest are counted as corroborated", () => {
    // D30-R3. Distinct-externalId rows that merely hash alike are two REAL
    // sales (af14c29c) and must never FATAL -- they are counted on their own
    // non-blocking line instead. Both branches are pinned so neither can be
    // dropped into the other.
    expect(fn).toMatch(/if \(clusterIsBlocking\(cluster\)\)/);
    expect(fn).toMatch(/blocking \+= extra/);
    expect(fn).toMatch(/corroborated \+= extra/);
  });

  it("the pre-flight reader is read-only", () => {
    // bounded to salesUnder's own body: from its signature to the `return out;`
    // that ends it, so the assertion cannot drift into the next function.
    const start = at("async function salesUnder");
    const body = source.slice(start, source.indexOf("return out;", start));
    expect(body).not.toMatch(/\.patch\(|\.upsert\(|\.delete\(|\.replace\(/);
    expect(body).toMatch(/SELECT /);
  });
});

describe("REPORT ONLY still reports the number", () => {
  it("the count is printed whether or not APPLY is set", () => {
    const print = source.slice(at("contentHash PRE-FLIGHT"), at("if (APPLY && preflight.collisions > 0)"));
    expect(print).toMatch(/COLLISIONS/);
    expect(print).toMatch(/groups planned/);
    expect(print).toMatch(/sales probed/);
    // the printing is NOT inside an APPLY branch
    expect(print).not.toMatch(/if \(APPLY\)/);
  });
});

describe("a mid-rename row is a SKIP, not a failure", () => {
  it("every row in the fold is checked, not just the winner", () => {
    // moveCatalogRow's buildIncoming THROWS when a slug's setKey segment
    // disagrees with the row's own setKey FIELD ("a key needs both halves",
    // #1348) -- and it builds the incoming row from the LOSER's fields at the
    // WINNER's slug, so a mid-rename LOSER throws just the same. Checking only
    // the winner left 2 failures in the measured baseball slice, both CPA
    // groups where the mid-rename row was a loser.
    const block = source.slice(at("const midRename ="), at("// DECIDED, NOT WRITTEN"));
    expect(block).toMatch(/\[winner, \.\.\.losers\]\.some/);
    expect(block).toMatch(/stats\.skippedRenameOwned\+\+/);
  });

  it("the skip happens BEFORE the group joins the plan, so it never reaches a write", () => {
    expect(at("const midRename =")).toBeLessThan(at("plan.push({ key, kind, rows, winner, losers"));
  });

  it("it lands on the rename counter, never on `failed`", () => {
    const block = source.slice(at("const midRename ="), at("// DECIDED, NOT WRITTEN"));
    expect(block).not.toMatch(/stats\.failed/);
  });
});
