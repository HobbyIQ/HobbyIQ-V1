import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll } from "vitest";

/**
 * CF-A-FAILED-ROW-IS-NOT-A-SKIPPED-ROW (2026-09-13, follow-up to the
 * id-integrity guard in namedInsertSetIsItsOwnCardSet.test.ts).
 *
 * THE GAP THIS CLOSES. A report run over acq-2026-09-13-scc printed
 * `rows skipped 0   <- no card number, no player, or unslugable` on the same
 * run that printed `failed 3` for three NNO rows — unslugable for exactly the
 * reason the skipped line's own caption names. An operator reading the
 * banner had no way to tell those three failures WERE that case, because the
 * only detail ever reached stderr, truncated to the first 5 of the whole
 * run, with no file name attached.
 *
 * THE FIX, banner-only, no src touched:
 *
 *   1. `rows failed N <- unslugable (no card number/player); listed below by
 *      file`, followed by every failed row's file, cardNumber, player and
 *      reason — once each, not just the first 5.
 *   2. A final line, `csv rows read R = written W + failed F + skipped S +
 *      refused X`, computed and CHECKED — never merely printed — so a row
 *      this run read that landed in no bucket (or in two) exits non-zero
 *      instead of reconciling by coincidence, the same discipline
 *      CF-RECONCILE-DOCUMENTS-NOT-CALLS already applies to written vs
 *      plannedIds a few lines below it.
 *
 * These drive the REAL script as a child process — never a copy of it — so a
 * banner change here can only pass by actually appearing in stdout.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-banner-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A dummy connection string satisfies the top-of-main "is it set" guard.
 *  REPORT mode (no APPLY) returns before any Cosmos call — see the ingest's
 *  own `if (!APPLY) { written++; ...; return; }`, well before its one
 *  `lookup()` call — so this never touches a network. */
const COSMOS_CONNECTION_STRING = "AccountEndpoint=https://example.invalid:443/;AccountKey=ZmFrZQ==;";

function stageDir(name: string, csv: string, manifest: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(tmp, "d-"));
  fs.writeFileSync(path.join(d, `${name}.csv`), csv);
  fs.writeFileSync(path.join(d, `${name}.manifest.json`), JSON.stringify(manifest));
  return d;
}

function runIngest(dir: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist" },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    // A non-zero exit throws; the child's stdout is still on the error.
    return { stdout: String(e.stdout ?? ""), status: typeof e.status === "number" ? e.status : 1 };
  }
}

describe("the banner names every failed row and reconciles rows read to every bucket", () => {
  // The real shape: 4 rows, 1 of them NNO with no player passed to the
  // deriver (the ingest never passes playerName — see line 559-577), which
  // throws "unnumbered card has no player to identify it" and is caught by
  // the same outer try that counts `failed`.
  const dir = stageDir("2020-test-basketball", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "base,2,,false,,Beta Player",
    "base,NNO,,false,,Team Checklist",
    "base,3,,false,,Gamma Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2020, setKey: "test-set", setName: "2020 Test Basketball" });

  it("reads 4 rows, writes 3, fails 1 — and prints the failed row's file, cardNumber and player", () => {
    const { stdout, status } = runIngest(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("csv rows read          4");
    expect(stdout).toContain("catalog rows written   3");
    expect(stdout).toContain("failed                 1");
    expect(stdout).toMatch(/rows failed\s+1\s+<- unslugable \(no card number\/player\); listed below by file/);
    // Named once, by file — not the truncated "failed NNO: hobbyiq-cardid: ..."
    // stderr line, which carries no filename at all.
    expect(stdout).toMatch(/2020-test-basketball\.csv\s+#NNO\s+Team Checklist\s+--/);
  });

  it("prints the final reconciliation line, checked and balanced", () => {
    const { stdout, status } = runIngest(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/csv rows read 4 = written 3 \+ failed 1 \+ skipped 0 \+ refused 0\s+\(balances\)/);
  });
});

describe("a run with a skip AND a refusal still balances — every bucket, not just written/failed", () => {
  // #47 collides on a blank parallel (refused, whole file, 2 rows) alongside
  // a player-name-parallel roster line (skipped, 1 row) and one clean row.
  const dir = stageDir("1989-pro-set-football", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,46,,false,,Neal Anderson",
    "base,47,,false,,William Perry",
    "base,47,,false,,Ron Morris",
    "base,48,Neal Anderson,false,,Neal Anderson",
    "",
  ].join("\n"), { sport: "football", year: 1989, setKey: "pro-set", setName: "1989 Pro Set Football" });

  it("names the id-integrity refusal AND still balances rows read against every bucket", () => {
    const { stdout, status } = runIngest(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("csv rows read          4");
    // "Neal Anderson" naming itself as #48's parallel is a roster line
    // (CF-A-PLAYER-IS-NOT-A-RUNG), filtered out BEFORE the pre-flight plan —
    // so it lands in `skipped` (rows with player-name parallel: 1) and the
    // remaining 3 rows (#46, #47 x2) go into the file-level refusal.
    expect(stdout).toMatch(/rows with player-name parallel 1/);
    expect(stdout).toMatch(/files REFUSED, id integrity 1 \(3 rows\)/);
    // The arithmetic assertion is what matters: every one of the 4 rows this
    // run read lands in exactly one bucket, whichever gate dropped it.
    expect(stdout).toMatch(/csv rows read 4 = written 0 \+ failed 0 \+ skipped 1 \+ refused 3\s+\(balances\)/);
  });
});

describe("the reconciliation is a real assertion, not a printed hope", () => {
  it("the check compares `rows` against written+failed+skipped+refused and exits 5 on a mismatch", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/const reconciled = written \+ failed \+ skipped \+ refused;/);
    expect(src).toMatch(/if \(rows !== reconciled\) \{/);
    expect(src).toMatch(/return \{ exitCode: 5 \};/);
  });

  it("a mutant that stops checking the balance is caught by the real script's absence of the guard", () => {
    const src = fs.readFileSync(script, "utf8");
    const mutated = src.replace(
      /if \(rows !== reconciled\) \{[\s\S]*?return \{ exitCode: 5 \};\s*\}/,
      "",
    );
    expect(mutated).not.toBe(src);
    expect(mutated).not.toMatch(/return \{ exitCode: 5 \};/);
  });

  it("`skipped` and `refused` are their own terms — a whole-file refusal is never laundered into skipped", () => {
    const src = fs.readFileSync(script, "utf8");
    // CF-ONE-SITE-COMPUTES-THE-SKIP-TOTAL: skipCount()/refuseCount() are the
    // single, shared computation the APPLY reconciliation (reportWrites) and
    // this rows-read banner both call, so `+ subsetCollision` appears exactly
    // once in the file and a mutation dropping it is caught on both banners
    // at once (see tests/sccPartialIsTerminalAndSiblingLadders.test.ts,
    // "drop `+ subsetCollision`").
    expect(src).toMatch(/function skipCount\(\) \{\s*return skippedRow \+ notReached \+ unnamedParallel \+ cardLineParallel \+ playerNameParallel \+ subsetCollision;\s*\}/);
    expect(src).toMatch(/function refuseCount\(\) \{\s*return refusedRows \+ explodedRows;\s*\}/);
    expect(src).toMatch(/const skipped = skipCount\(\);/);
    expect(src).toMatch(/const refused = refuseCount\(\);/);
    // Exactly one call site sums subsetCollision — the mutation test in
    // sccPartialIsTerminalAndSiblingLadders.test.ts relies on a single
    // `.replace(" + subsetCollision", "")` removing it everywhere.
    expect(src.split(" + subsetCollision").length - 1).toBe(1);
  });
});

describe("the committed script is loadable", () => {
  it("node parses it", () => {
    expect(() => execFileSync(process.execPath, ["--check", script], { stdio: "pipe" })).not.toThrow();
  });
});
