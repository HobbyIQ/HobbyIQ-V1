import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll } from "vitest";

/**
 * CF-A-DUPLICATE-IS-NOT-A-COLLISION, the reconciler side (run 35485294973,
 * 2026-09-19).
 *
 * THE GAP THIS CLOSES. `ingest-checklist-csv-to-catalog.cjs` folds a "source
 * duplicate" -- one card the staged file listed twice with an identical
 * identity tuple -- and keeps it once, never refuses it (see
 * `plan.duplicatesFolded` and the `sourceDuplicates++` it drives). Its OWN
 * rows-read banner has always declared this and balanced:
 *
 *   csv rows read 11,468 = written 11,382 + failed 0 + skipped 0 + refused 0
 *     + source duplicates 86  (balances)
 *
 * but the call into the SHARED reconciler (writeReconciliation.ts,
 * `reportWrites`) only ever passed `intended: rows` and `written`, with no
 * bucket for the fold. `reconcileWrites` computes
 * `unaccounted = intended - (written + skipped + refused + failed)`, and with
 * the 86 folded duplicates missing from every term on the right it printed
 *
 *   !! ingest-checklist-csv-to-catalog: WORK VANISHED
 *   !!   UNACCOUNTED  86   0.75% of intended
 *   !! Do not treat this run as complete.
 *
 * on a run that was, in fact, complete and balanced. THE FIX: `sourceDuplicates`
 * is now folded into the `skipped` bucket handed to `reportWrites` -- a
 * declared, deliberate non-write is exactly the case `skipped` exists for --
 * alongside the existing `skipCount()` / `refuseCount()` terms.
 *
 * These drive the REAL script as a child process, in APPLY mode, against a
 * stubbed Cosmos and the REAL (unstubbed) writeReconciliation module, so a
 * regression can only pass by the actual banner the operator reads.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-dup-reconcile-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function stageDir(name: string, csv: string, manifest: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(tmp, "d-"));
  fs.writeFileSync(path.join(d, `${name}.csv`), csv);
  fs.writeFileSync(path.join(d, `${name}.manifest.json`), JSON.stringify(manifest));
  return d;
}

/**
 * Stubs ONLY `@azure/cosmos`. `writeReconciliation` and every other dist
 * module the ingest requires run FOR REAL, so the WORK VANISHED alarm is the
 * genuine `reconcileWrites` arithmetic, not a mock of it. A point-read
 * (`item().read()`) always misses (404), so every row's first `lookup()`
 * takes the "new row" branch, and `upsert` records what was written and
 * always succeeds (unless `FAIL_ON` names a cardNumber to fail, for the
 * genuinely-vanished-row fixture below).
 */
function shimOf(opts: { failCardNumber?: string } = {}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const FAIL_ON = ${JSON.stringify(opts.failCardNumber ?? null)};
const written = [];
const stub = {
  CosmosClient: class {
    database() {
      return {
        container() {
          return {
            item(id) {
              return { read: async () => { const e = new Error("404"); e.code = 404; throw e; } };
            },
            items: {
              upsert: async (doc) => {
                // Simulate a write that REPORTS success (resolves normally)
                // but is never actually counted anywhere -- the "genuinely
                // vanished" shape reconcileWrites exists to catch. It must
                // still surface as a real shortfall.
                if (FAIL_ON && String(doc.cardNumber) === FAIL_ON) {
                  return { resource: doc };
                }
                written.push(doc);
                return { resource: doc };
              },
              // CF-A-SIBLING-KEY-IS-STILL-THE-SAME-RUNG's rung-level check
              // queries card_catalog before every write. This fixture has no
              // sibling twins staged, so the query always returns an empty,
              // single (non-continuing) page.
              query() {
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => { done = true; return { resources: [] }; },
                };
              },
            },
          };
        },
      };
    }
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

const COSMOS_CONNECTION_STRING = "AccountEndpoint=https://example.invalid:443/;AccountKey=ZmFrZQ==;";

function runIngestApply(
  dir: string,
  opts: { failCardNumber?: string; scriptPath?: string } = {},
): { stdout: string; stderr: string; status: number } {
  // spawnSync, not execFileSync: `reportWrites` prints its WORK VANISHED
  // banner via console.error but the process still exits 0 (reconcileWrites
  // sets process.exitCode = 4, but `finishLane` -- CF-A-LANE-EXITS-WHEN-ITS-
  // WORK-IS-DONE -- calls it with the ctx.exitCode from main()'s return value,
  // which reportWrites does not feed into). execFileSync only captures stderr
  // on a NON-ZERO exit; a clean-exit run that alarmed on stderr would silently
  // lose the banner this test exists to check.
  const r = spawnSync(process.execPath, [opts.scriptPath ?? script], {
    env: {
      ...process.env,
      COSMOS_CONNECTION_STRING,
      DIR: dir,
      SOURCE: "sportscardchecklist",
      BACKFILL_APPLY: "true",
      // Each `it()` below re-runs the same staged directory against a fresh
      // Cosmos stub. Without this, the SECOND run resumes past the
      // `.ingested` marker the first run wrote (APPLY writes it) and reports
      // "files already done 1 / rows read 0" instead of re-ingesting.
      REINGEST: "true",
      NODE_OPTIONS: `--require ${JSON.stringify(shimOf(opts))}`,
    },
    encoding: "utf8",
  });
  return {
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    status: typeof r.status === "number" ? r.status : 1,
  };
}

describe("a fixture with a folded source duplicate balances and does not alarm", () => {
  // 3 rows: #1 and #2 are genuinely distinct cards; #3 is byte-for-byte #1's
  // identity tuple (same cardNumber, same blank parallel, same isAuto/printRun)
  // repeated -- the "source listed the same card twice" shape, folded by
  // INSERT_SET.planFile's idCollisions() into `duplicatesFolded`.
  const dir = stageDir("2020-test-basketball-dup", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "base,2,,false,,Beta Player",
    "base,1,,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2020, setKey: "dup-test-set", setName: "2020 Test Basketball Dup" });

  it("prints the balanced rows-read banner with the fold declared", () => {
    const { stdout, status } = runIngestApply(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/csv rows read 3 = written 2 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 1 \+ present\/checklist 0 \+ rung twin 0\s+\(balances\)/);
  });

  it("does NOT print WORK VANISHED / UNACCOUNTED — the reportWrites call must declare the fold too", () => {
    const { stdout, stderr, status } = runIngestApply(dir);
    expect(status).toBe(0);
    expect(stdout + stderr).not.toContain("WORK VANISHED");
    expect(stdout + stderr).not.toContain("UNACCOUNTED");
    // The real reconciler's clean-run message, proving reportWrites was fed
    // the fold rather than merely skipped.
    expect(stdout).toMatch(/\[ingest-checklist-csv-to-catalog\] reconciled: intended 3 = written 2 \+ skipped 1/);
  });
});

describe("a row that vanishes for real still alarms", () => {
  // Same shape (3 rows, one folded duplicate leaves 2 to write), but the
  // Cosmos stub is told to swallow card #2's write silently -- it resolves
  // as if it succeeded, but is never pushed to the `written` sink. This is
  // the "job reported success and had written almost nothing" class
  // writeReconciliation.ts exists for; the fix must not have weakened the
  // alarm for a row that is genuinely unaccounted.
  const dir = stageDir("2020-test-basketball-vanish", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "base,2,,false,,Beta Player",
    "base,1,,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2020, setKey: "vanish-test-set", setName: "2020 Test Basketball Vanish" });

  it("still reconciles the banner's own arithmetic (the script counts `written` from its own upsert return, not the stub's side sink)", () => {
    // The ingest script counts `written` from `landed` (the upsert's return
    // value), which the stub still returns even when it does not push to its
    // recording sink. So this fixture does not, by itself, make `written`
    // disagree with `rows` -- it proves the OPPOSITE case matters: the
    // reconciliation is only as honest as the counters main() derives, which
    // is exactly why CF-RECONCILE-DOCUMENTS-NOT-CALLS and the mutation test
    // below assert the arithmetic directly rather than trusting a fixture to
    // desynchronise it through the network layer.
    const { stdout, status } = runIngestApply(dir, { failCardNumber: "2" });
    expect(status).toBe(0);
    expect(stdout).toMatch(/csv rows read 3 = written 2 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 1 \+ present\/checklist 0 \+ rung twin 0\s+\(balances\)/);
  });

  it("a mutant that under-declares skipped to reportWrites (drops sourceDuplicates) DOES alarm on this fixture", () => {
    // This is the real regression check for the fix: revert the `reportWrites`
    // call to its pre-fix shape (skipped: skipCount() + refuseCount(), the
    // fold NOT included) and confirm the same balanced-CSV run now prints the
    // false alarm run 35485294973 hit -- proving the fold, not tolerance
    // slop, is what silences it.
    const src = fs.readFileSync(script, "utf8");
    const mutated = src.replace(
      "skipped: skipCount() + refuseCount() + sourceDuplicates + siblingGuardCount(), failed });",
      "skipped: skipCount() + refuseCount(), failed });",
    );
    expect(mutated).not.toBe(src);
    // Written into scripts/ itself (as a sibling temp file, cleaned up below)
    // rather than under os.tmpdir(): the script resolves its dist requires
    // via `path.resolve(__dirname, "..")`, so it must sit beside the real
    // script's own directory for that resolution to land on this repo's
    // backend/dist, exactly as the shipped script does.
    const mutantPath = path.join(path.dirname(script), `mutant-ingest-checklist-csv-to-catalog.${Date.now()}.cjs`);
    fs.writeFileSync(mutantPath, mutated);
    try {
      const { stdout, stderr, status } = runIngestApply(dir, { scriptPath: mutantPath });
      expect(status).toBe(0);
      // The mutant still balances ITS OWN rows-read banner (that arithmetic
      // already included source duplicates before this fix), but the shared
      // reconciler was handed a `skipped` one short of the fold, so it must
      // print WORK VANISHED / UNACCOUNTED 1 -- the exact false alarm this PR
      // removes for the real script.
      expect(stdout + stderr).toContain("WORK VANISHED");
      expect(stdout + stderr).toMatch(/UNACCOUNTED\s+1/);
    } finally {
      try { fs.rmSync(mutantPath, { force: true }); } catch { /* best effort */ }
    }
  });
});

describe("the fix is the declared call site, not a change to the shared reconciler", () => {
  it("reportWrites is called with sourceDuplicates folded into skipped", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(
      /reportWrites\(\{ job: "ingest-checklist-csv-to-catalog", intended: rows, written, skipped: skipCount\(\) \+ refuseCount\(\) \+ sourceDuplicates \+ siblingGuardCount\(\), failed \}\);/,
    );
  });

  it("writeReconciliation.ts itself is untouched by this fix — the alarm logic still fires on a genuine shortfall", () => {
    const reconciliation = fs.readFileSync(
      path.join(backend, "src", "services", "ops", "writeReconciliation.ts"),
      "utf8",
    );
    expect(reconciliation).toContain("WORK VANISHED");
    expect(reconciliation).toMatch(/const unaccounted = Math\.max\(0, intended - accounted\);/);
  });
});

describe("the committed script is loadable", () => {
  it("node parses it", () => {
    expect(() => execFileSync(process.execPath, ["--check", script], { stdio: "pipe" })).not.toThrow();
  });
});
