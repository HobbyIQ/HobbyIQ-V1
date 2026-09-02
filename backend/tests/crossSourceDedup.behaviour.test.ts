/**
 * D3 — THE TWO LEGACY DEDUPS, EXECUTED.
 *
 * WHAT WAS WRONG. Both scripts had the same discriminator — a shared
 * `sourceExternalId` is the only thing that proves two rows in one bucket are
 * one sale — written out TWICE, once each, alongside a copy-pasted
 * `externalIdOf`. The tests that guarded it asserted over the SOURCE TEXT with
 * regexes, so a mutant that reverted either script to the rev-2 whole-bucket
 * collapse passed all 81 of them. A rule tested by grep is a rule nobody has
 * tested, and this is the file that fixes that.
 *
 * WHAT IS TESTED HERE. The rule now lives in scripts/lib/cross-source-cluster.cjs
 * and both scripts import it. So:
 *
 *   1. the LIB is executed directly, on the mandated refusals;
 *   2. BOTH SCRIPTS are executed end to end against a stubbed Cosmos, so
 *      "the lib is right" and "the script uses the lib" are two claims and both
 *      are checked;
 *   3. each script's own mutant — the rev-2 whole-bucket collapse — is loaded
 *      and asserted to BREAK these tests. A guard nobody can break is decoration.
 *
 * The exclusion is always a reversible `flaggedWrong` flag. Nothing here, in any
 * mode, may delete a pool row.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-xsrc-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

type Row = Record<string, unknown>;
const { provenClustersOf, resolveCluster } =
  require_(path.join(backend, "scripts", "lib", "cross-source-cluster.cjs")) as {
    provenClustersOf: (rows: Row[]) => { proven: Row[][]; sharedIds: string[]; refusedNoId: number; refusedDifferentIds: number };
    resolveCluster: (rows: Row[]) => { survivor: Row; toFlag: Row[]; alreadyFlagged: Row[] };
  };

const row = (over: Row = {}): Row => ({
  id: "tca-ebay::100", cardId: "hiq:football:2024:topps-chrome:1:base:no-auto",
  hobbyiqCardId: "hiq:football:2024:topps-chrome:1:base:no-auto",
  source: "tca-ebay", sourceExternalId: "100",
  title: "2024 Topps Chrome Caleb Williams #1", parallel: "Base", cardNumber: "1",
  playerName: "Caleb Williams", cardYear: 2024,
  gradeCompany: null, gradeValue: null, isAuto: false, printRun: null,
  price: 9.99, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-15T01:00:00Z",
  ...over,
});

// ── 1. the shared rule, executed ─────────────────────────────────────────────

describe("D3 — the shared discriminator, run rather than grepped", () => {
  it("THE MANDATED REFUSAL: two real sales, same everything, different item ids", () => {
    const r = provenClustersOf([
      row({ id: "tca-ebay::111", sourceExternalId: "111" }),
      row({ id: "tca-ebay::222", sourceExternalId: "222" }),
    ]);
    expect(r.proven).toEqual([]);
    expect(r.refusedDifferentIds).toBe(2);
  });

  it("a SHARED item id across two sources IS proven, and is the only thing that is", () => {
    const r = provenClustersOf([
      row({ id: "tca-ebay::777", source: "tca-ebay", sourceExternalId: "777" }),
      row({ id: "cardhedge::777", source: "cardhedge", sourceExternalId: "777" }),
    ]);
    expect(r.proven).toHaveLength(1);
    expect(r.proven[0]).toHaveLength(2);
    expect(r.sharedIds).toEqual(["777"]);
  });

  it("two rows with NO item id never cluster on their shared absence", () => {
    const r = provenClustersOf([
      row({ id: "a", sourceExternalId: null }),
      row({ id: "b", sourceExternalId: undefined }),
    ]);
    expect(r.proven).toEqual([]);
    expect(r.refusedNoId).toBe(2);
  });

  it("a proven pair and a bystander in one bucket: only the pair is touched", () => {
    const r = provenClustersOf([
      row({ id: "tca-ebay::777", sourceExternalId: "777" }),
      row({ id: "cardhedge::777", source: "cardhedge", sourceExternalId: "777" }),
      row({ id: "tca-ebay::999", sourceExternalId: "999" }),
    ]);
    expect(r.proven).toHaveLength(1);
    expect(r.proven[0].map((x) => x.id).sort()).toEqual(["cardhedge::777", "tca-ebay::777"]);
    // the bystander is a real sale; nothing counts it as refused-by-difference,
    // because this bucket DID prove something
    expect(r.refusedDifferentIds).toBe(0);
  });

  it("only-improve: an already-flagged loser is reported, never re-stamped", () => {
    // The RICHER row survives (pickSurvivor: more populated fields, then the
    // earliest observed). Here the flagged row is the poorer one, so it is the
    // loser -- and being already flagged it goes to `alreadyFlagged`, never to
    // `toFlag`, so a re-run cannot overwrite an earlier (possibly human) ruling.
    const rich = row({ id: "tca-ebay::777", sourceExternalId: "777", imageUrl: "http://i/1", team: "CHI", setName: "Topps Chrome", sport: "football", normalizedSetKey: "topps-chrome", hobbyiqCardId: "hiq:x" });
    const poor = row({ id: "cardhedge::777", source: "cardhedge", sourceExternalId: "777", flaggedWrong: true, imageUrl: null, team: null, setName: null, sport: null, normalizedSetKey: null, hobbyiqCardId: null });
    const { survivor, toFlag, alreadyFlagged } = resolveCluster([rich, poor]);
    expect(survivor.id).toBe("tca-ebay::777");
    expect(toFlag).toEqual([]);
    expect(alreadyFlagged.map((x) => x.id)).toEqual(["cardhedge::777"]);
  });
});

// ── 2. both scripts, executed end to end ─────────────────────────────────────

/** Rows both scripts will bucket together: same title, price and minute. The
 *  777 pair shares an item id (one sale, two vendors); the 111/222 pair does
 *  not (two real sales that happen to match). */
const POOL = [
  { id: "tca-ebay::777", cardId: "hiq:x", hobbyiqCardId: "hiq:x", source: "tca-ebay", sourceExternalId: "777",
    title: "2024 Topps Chrome Caleb Williams #1", price: 40, soldAt: "2026-08-14T23:30:00Z",
    observedAt: "2026-08-15T01:00:00Z", playerName: "Caleb Williams", cardYear: 2024, cardNumber: "1",
    parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, imageUrl: "http://i/1", team: "CHI",
    setName: "Topps Chrome", sport: "football", printRun: null, normalizedSetKey: "topps-chrome" },
  { id: "cardhedge::777", cardId: "hiq:x", hobbyiqCardId: "hiq:x", source: "cardhedge", sourceExternalId: "777",
    title: "2024 Topps Chrome Caleb Williams #1", price: 40, soldAt: "2026-08-14T23:30:00Z",
    observedAt: "2026-08-16T01:00:00Z", playerName: "Caleb Williams", cardYear: 2024, cardNumber: "1",
    parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null },
  { id: "tca-ebay::111", cardId: "hiq:y", hobbyiqCardId: "hiq:y", source: "tca-ebay", sourceExternalId: "111",
    title: "2024 Topps Chrome Rome Odunze #2", price: 9.99, soldAt: "2026-08-14T22:00:00Z",
    observedAt: "2026-08-15T01:00:00Z", playerName: "Rome Odunze", cardYear: 2024, cardNumber: "2",
    parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null },
  { id: "tca-ebay::222", cardId: "hiq:y", hobbyiqCardId: "hiq:y", source: "tca-ebay", sourceExternalId: "222",
    title: "2024 Topps Chrome Rome Odunze #2", price: 9.99, soldAt: "2026-08-14T22:00:00Z",
    observedAt: "2026-08-15T01:00:00Z", playerName: "Rome Odunze", cardYear: 2024, cardNumber: "2",
    parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null },
];

const stubFor = (pool: Record<string, unknown>[]) => `
const Module = require("module");
const POOL = ${JSON.stringify(pool)};
const writes = [];
const iter = (rows) => { let done = false; return {
  hasMoreResults: () => !done,
  fetchNext: async () => { done = true; return { resources: rows }; },
}; };
class CosmosClient {
  constructor() {}
  database() { return { container: (name) => ({
    items: { query: () => iter(POOL) },
    item: (id, pk) => ({
      patch: async (ops) => { writes.push({ id, pk, ops }); return {}; },
      delete: async () => { writes.push({ id, pk, op: "DELETE" }); throw new Error("a dedup must never delete a pool row"); },
      read: async () => ({ resource: POOL.find((r) => r.id === id) || null }),
    }),
  }) }; }
}
process.on("exit", () => { require("fs").writeFileSync(process.env.WRITES_OUT, JSON.stringify(writes)); });
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return { CosmosClient };
  return realLoad.apply(this, arguments);
};
`;

/**
 * Run one of the two scripts, optionally against a MUTATED copy of it.
 *
 * A mutant is written beside the real script (same directory) so its relative
 * `require("./lib/...")` paths still resolve — the point of the mutant is to
 * change ONE expression, not to change what it can load.
 */
function runScript(
  script: "crossSourceDedupSoldComps.cjs" | "sold-comps-cross-source-dedup.cjs",
  env: Record<string, string>,
  mutate?: (src: string) => string,
): { out: string; writes: { id: string; op?: string; ops?: { path: string; value: unknown }[] }[] } {
  const stubPath = path.join(tmp, "stub.cjs");
  fs.writeFileSync(stubPath, stubFor(POOL));
  const writesOut = path.join(tmp, `writes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(writesOut, "[]");

  let target = path.join(backend, "scripts", script);
  if (mutate) {
    const src = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    const mutated = mutate(src);
    if (mutated === src) throw new Error(`MUTATION DID NOT APPLY to ${script} — the anchor text has moved`);
    target = path.join(backend, "scripts", `__mutant-${Math.random().toString(36).slice(2)}-${script}`);
    fs.writeFileSync(target, mutated);
  }

  let out = "";
  try {
    out = execFileSync(process.execPath, ["--require", stubPath, target], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://x/;AccountKey=x==;",
        WRITES_OUT: writesOut, ...env,
      },
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = String(err.stdout ?? "") + String(err.stderr ?? "");
  } finally {
    if (mutate) { try { fs.rmSync(target); } catch { /* best effort */ } }
  }
  return { out, writes: JSON.parse(fs.readFileSync(writesOut, "utf8")) };
}

describe("D3 — crossSourceDedupSoldComps.cjs, executed", () => {
  it("APPLY flags exactly the ONE proven duplicate, and never the 111/222 pair", () => {
    const { writes } = runScript("crossSourceDedupSoldComps.cjs", { DRY_RUN: "false", BULK_END_DATE: "2026-01-01" });
    expect(writes.map((w) => w.id)).toEqual(["cardhedge::777"]);
    const paths = (writes[0].ops ?? []).map((o) => o.path);
    expect(paths).toContain("/flaggedWrong");
    expect(paths).toContain("/dedupSupersededBy");
    expect(writes.some((w) => w.op === "DELETE")).toBe(false);
  });

  it("it says out loud that it REFUSED the two same-price same-minute sales", () => {
    const { out } = runScript("crossSourceDedupSoldComps.cjs", { DRY_RUN: "true", BULK_END_DATE: "2026-01-01" });
    expect(out).toMatch(/same key, different item ids\s*:\s*2/);
  });

  it("D4: the reconciliation counts real skipped rows, not a hardcoded zero", () => {
    const { out } = runScript("crossSourceDedupSoldComps.cjs", { DRY_RUN: "false", BULK_END_DATE: "2026-01-01" });
    expect(out).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ failed 0/);
    // and the literal is gone from the source, so the zero above is COMPUTED
    const src = fs.readFileSync(path.join(backend, "scripts", "crossSourceDedupSoldComps.cjs"), "utf8");
    expect(src).not.toMatch(/\+ skipped 0 \+/);
  });
});

describe("D3 — sold-comps-cross-source-dedup.cjs, executed", () => {
  it("APPLY flags exactly the ONE proven duplicate, and never the 111/222 pair", () => {
    const { writes } = runScript("sold-comps-cross-source-dedup.cjs", { APPLY: "true", MIN_PRICE: "1" });
    expect(writes.map((w) => w.id)).toEqual(["cardhedge::777"]);
    const paths = (writes[0].ops ?? []).map((o) => o.path);
    expect(paths).toContain("/flaggedWrong");
    expect(paths).toContain("/dedupSupersededBy");
    expect(writes.some((w) => w.op === "DELETE")).toBe(false);
  });

  it("it says out loud that it REFUSED the two same-price same-minute sales", () => {
    const { out } = runScript("sold-comps-cross-source-dedup.cjs", { APPLY: "false", MIN_PRICE: "1" });
    expect(out).toMatch(/same bucket, different external ids\s+2/);
  });

  it("D4: the reconciliation counts real skipped rows, not a hardcoded zero", () => {
    const { out } = runScript("sold-comps-cross-source-dedup.cjs", { APPLY: "true", MIN_PRICE: "1" });
    expect(out).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ failed 0/);
    const src = fs.readFileSync(path.join(backend, "scripts", "sold-comps-cross-source-dedup.cjs"), "utf8");
    expect(src).not.toMatch(/\+ skipped 0 \+/);
  });

  it("D4: a run whose only loser is ALREADY flagged reconciles 1 = 0 + 1 + 0", () => {
    // The case the hardcoded zero hid entirely: intended used to exclude the
    // skipped rows, so this run reconciled 0 = 0 + 0 + 0 and vouched for nothing.
    const stubPath = path.join(tmp, "stub-preflagged.cjs");
    // The SAME pool, with the loser already flagged. Built from the object
    // rather than by patching serialized JSON, so the fixture cannot silently
    // fail to apply and pass this test for the wrong reason.
    fs.writeFileSync(stubPath, stubFor(POOL.map((r) =>
      r.id === "cardhedge::777" ? { ...r, flaggedWrong: true } : r,
    )));
    const writesOut = path.join(tmp, `writes-pf-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(writesOut, "[]");
    let out = "";
    try {
      out = execFileSync(process.execPath, ["--require", stubPath, path.join(backend, "scripts", "sold-comps-cross-source-dedup.cjs")], {
        cwd: backend,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
          COSMOS_CONNECTION_STRING: "AccountEndpoint=https://x/;AccountKey=x==;",
          WRITES_OUT: writesOut, APPLY: "true", MIN_PRICE: "1" },
        encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) { const err = e as { stdout?: string; stderr?: string }; out = String(err.stdout ?? "") + String(err.stderr ?? ""); }
    expect(out).toMatch(/reconciled: intended 1 = written 0 \+ skipped 1 \+ failed 0/);
    expect(JSON.parse(fs.readFileSync(writesOut, "utf8"))).toEqual([]);
  });
});

// ── 3. the mutants must be LETHAL ────────────────────────────────────────────

describe("D3 — MUTANTS: the rev-2 whole-bucket collapse must break these tests", () => {
  /** The rev-2 defect, restored: every row in the bucket is one sale, whatever
   *  its item id says. This is what BOTH scripts did before the discriminator,
   *  and what a regex-over-source test could not see being put back. */
  const collapseWholeBucket = (src: string): string =>
    src.replace(
      "const { proven, refusedNoId: noId, refusedDifferentIds: diff } = provenClustersOf(",
      "const { refusedNoId: noId, refusedDifferentIds: diff } = provenClustersOf(",
    ).replace(
      /(const \{ refusedNoId: noId, refusedDifferentIds: diff \} = provenClustersOf\((rows|arr)\);)/,
      "$1\n    const proven = [$2];",
    );

  it("MUTANT crossSourceDedupSoldComps: collapsing the bucket flags a REAL sale", () => {
    const { writes } = runScript(
      "crossSourceDedupSoldComps.cjs",
      { DRY_RUN: "false", BULK_END_DATE: "2026-01-01" },
      collapseWholeBucket,
    );
    const ids = writes.map((w) => w.id).sort();
    // The mutant flags one of the 111/222 pair — two genuinely different
    // listings — which the shipped script never does.
    expect(ids).toContain("tca-ebay::222");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("MUTANT sold-comps-cross-source-dedup: collapsing the bucket flags a REAL sale", () => {
    const { writes } = runScript(
      "sold-comps-cross-source-dedup.cjs",
      { APPLY: "true", MIN_PRICE: "1" },
      collapseWholeBucket,
    );
    const ids = writes.map((w) => w.id).sort();
    expect(ids).toContain("tca-ebay::222");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("MUTANT the shared lib: ignoring sourceExternalId collapses both buckets", () => {
    // One layer down: the lib itself. Every row reports the same id — the shape
    // of a script that does not read the field at all.
    const libSrc = fs.readFileSync(path.join(backend, "scripts", "lib", "cross-source-cluster.cjs"), "utf8").replace(/\r\n/g, "\n");
    const mutant = libSrc.replace("const ext = externalIdOf(r);", 'const ext = "SAME";');
    expect(mutant, "mutation must actually apply").not.toBe(libSrc);
    const mod = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", "require", "__dirname", mutant)(
      mod, mod.exports, require_, path.join(backend, "scripts", "lib"),
    );
    const mutated = (mod.exports as { provenClustersOf: (r: Row[]) => { proven: Row[][] } }).provenClustersOf;
    const twoRealSales = [row({ id: "a", sourceExternalId: "111" }), row({ id: "b", sourceExternalId: "222" })];
    expect(provenClustersOf(twoRealSales).proven).toEqual([]);
    expect(mutated(twoRealSales).proven).toHaveLength(1);
  });
});

describe("D3 — the copy-pasted key logic is gone, not merely unused", () => {
  it("neither script declares its own externalIdOf any more", () => {
    for (const s of ["crossSourceDedupSoldComps.cjs", "sold-comps-cross-source-dedup.cjs"]) {
      const src = fs.readFileSync(path.join(backend, "scripts", s), "utf8");
      expect(src, `${s} still declares its own externalIdOf`).not.toMatch(/function externalIdOf/);
      expect(src).toMatch(/require\(path\.join\(__dirname, "lib", "cross-source-cluster\.cjs"\)\)/);
    }
  });

  it("the lib imports externalIdOf from the triage rule rather than redefining it", () => {
    const src = fs.readFileSync(path.join(backend, "scripts", "lib", "cross-source-cluster.cjs"), "utf8");
    expect(src).not.toMatch(/function externalIdOf/);
    expect(src).toMatch(/require\(path\.join\(__dirname, "collision-triage\.cjs"\)\)/);
  });
});
