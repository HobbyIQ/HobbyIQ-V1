/**
 * CF-A-NOTE-IS-NOT-A-RUNG (Drew, 2026-09-25).
 *
 * Tonight's census: 251,043 checklist-grade card_catalog rows (2024-2026
 * Topps/Bowman) carry a channel word, an inline print-run count,
 * "exclusive", pack odds, SKU text or a stray parenthetical glued into
 * `parallel`. This drives the REAL ingester script as a child process
 * (never a copy) to pin:
 *
 *   1. a dirty parallel is REFUSED, counted in its own bucket
 *      (`refused: note in rung name N`), with examples and the suggested
 *      clean name -- never auto-rewritten, never written;
 *   2. the rows-read reconciliation still balances with the new term
 *      folded in;
 *   3. the manifest waiver (`allowNoteInRungName` + reason, BOTH required)
 *      lets the row through, still visible in the banner as WAIVED;
 *   4. REPORT mode never touches Cosmos -- the gate is a pure per-row check,
 *      well before the one `lookup()` call this script makes.
 *
 * The guard runs identically in REPORT and APPLY (it is evaluated before the
 * `if (!APPLY) { written++; ...; return; }` early-out), so these tests use
 * REPORT mode throughout: no Cosmos connection needed, no stub required, and
 * the banner text is identical either way for this gate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-note-in-rung-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const COSMOS_CONNECTION_STRING = "AccountEndpoint=https://example.invalid:443/;AccountKey=ZmFrZQ==;";

function stageDir(name: string, csv: string, manifest: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(tmp, "d-"));
  fs.writeFileSync(path.join(d, `${name}.csv`), csv);
  fs.writeFileSync(path.join(d, `${name}.manifest.json`), JSON.stringify(manifest));
  return d;
}

function runIngestReport(dir: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist" },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout ?? ""), status: typeof e.status === "number" ? e.status : 1 };
  }
}

describe("a dirty parallel is REFUSED, counted, never written", () => {
  const dir = stageDir("2024-note-basketball", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Purple Tinsel (Meijer exclusive),false,,Alpha Player",
    "base,2,Silver Wave,false,,Beta Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2024, setKey: "note-test-set", setName: "2024 Note Test" });

  it("refuses row #1 and names the kind + suggested clean name in the banner", () => {
    const { stdout, status } = runIngestReport(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/refused: note in rung name\s+1/);
    expect(stdout).toContain("catalog rows written   1");
    expect(stdout).toMatch(/1\|"Purple Tinsel \(Meijer exclusive\)" -> channel/);
    expect(stdout).toContain('suggested: "Purple Tinsel"');
  });

  it("balances the rows-read reconciliation with the new term folded in", () => {
    const { stdout, status } = runIngestReport(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/csv rows read 2 = written 1 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 0 \+ present\/checklist 0 \+ rung twin 0 \+ note in rung name 1\s+\(balances\)/);
    expect(stdout).not.toContain("WORK VANISHED");
    expect(stdout).not.toContain("MISMATCH");
  });
});

describe("multiple dirty shapes in one file are all named, up to 5 examples", () => {
  const dir = stageDir("2025-note-baseball-multi", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Silver Crackle Foil (Super Box exclusive),false,,Player One",
    'base,2,"Crackle Foil: 10,400 copies",false,,Player Two',
    "base,3,Gold Wave 1:38 packs,false,,Player Three",
    "base,4,Platinum2999,false,,Player Four",
    "base,5,Teal (limited),false,,Player Five",
    "base,6,Clean Refractor,false,,Player Six",
    "",
  ].join("\n"), { sport: "baseball", year: 2025, setKey: "note-multi-set", setName: "2025 Note Multi" });

  it("refuses all 5 dirty rows and writes the 1 clean row", () => {
    const { stdout, status } = runIngestReport(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/refused: note in rung name\s+5/);
    expect(stdout).toContain("catalog rows written   1");
    expect(stdout).toMatch(/csv rows read 6 = written 1 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 0 \+ present\/checklist 0 \+ rung twin 0 \+ note in rung name 5\s+\(balances\)/);
  });
});

describe("the manifest can waive the guard for a genuine stated rung -- never an env flag", () => {
  const dir = stageDir("2024-note-waived", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Purple Tinsel (Meijer exclusive),false,,Alpha Player",
    "",
  ].join("\n"), {
    sport: "basketball", year: 2024, setKey: "note-waived-set", setName: "2024 Note Waived",
    allowNoteInRungName: true,
    allowNoteInRungNameReason: "test fixture: the checklist itself prints the parenthetical as part of the rung name",
  });

  it("writes the row and still surfaces the waiver, with its reason, in the banner", () => {
    const { stdout, status } = runIngestReport(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("refused: note in rung name 0");
    expect(stdout).toContain("catalog rows written   1");
    expect(stdout).toMatch(/note-in-rung-name WAIVED \(reason: test fixture: the checklist itself prints the parenthetical as part of the rung name\) 1/);
    expect(stdout).toMatch(/WAIVED: 1\|"Purple Tinsel \(Meijer exclusive\)" -> channel/);
    expect(stdout).toMatch(/csv rows read 1 = written 1 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 0 \+ present\/checklist 0 \+ rung twin 0 \+ note in rung name 0\s+\(balances\)/);
  });

  it("an unreasoned allowNoteInRungName (no string reason) does NOT waive the guard", () => {
    const dirNoReason = stageDir("2024-note-waived-noreason", [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,Purple Tinsel (Meijer exclusive),false,,Alpha Player",
      "",
    ].join("\n"), {
      sport: "basketball", year: 2024, setKey: "note-waived-noreason-set", setName: "2024 Note Waived No Reason",
      allowNoteInRungName: true,
      // no allowNoteInRungNameReason
    });
    const { stdout, status } = runIngestReport(dirNoReason);
    expect(status).toBe(0);
    expect(stdout).toContain("refused: note in rung name 1");
    expect(stdout).toContain("catalog rows written   0");
  });
});

describe("REPORT mode never touches Cosmos -- the gate is a pure per-row check", () => {
  const dir = stageDir("2024-note-report-only", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Purple Tinsel (Meijer exclusive),false,,Alpha Player",
    "base,2,Silver Wave,false,,Beta Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2024, setKey: "note-report-set", setName: "2024 Note Report" });

  it("reports without a COSMOS_CONNECTION_STRING pointing anywhere real, and without ever calling the Cosmos SDK's query/item paths", () => {
    // No shim is installed at all: if REPORT mode ever tried to reach Cosmos,
    // the fake connection string would either throw during client
    // construction attempts to actually connect, or hang — this test's own
    // clean, fast pass is the proof no network call was attempted.
    const { stdout, status } = runIngestReport(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("REPORT ONLY — nothing written");
    expect(stdout).toContain("refused: note in rung name 1");
    expect(stdout).toContain("catalog rows written   1");
  });
});

describe("mutation check: removing the ingest-side gate writes the dirty row instead of refusing it", () => {
  it("removing the per-row hygiene check in main's loop writes the row and drops the bucket", () => {
    const src = fs.readFileSync(script, "utf8");
    const marker = /if \(isCardLineParallel\(parallel, declaredVocab\)\) \{ cardLineParallel\+\+; continue; \}\s*\/\/ CF-A-NOTE-IS-NOT-A-RUNG[\s\S]*?\n      rawRows\.push/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, 'if (isCardLineParallel(parallel, declaredVocab)) { cardLineParallel++; continue; }\n      rawRows.push');
    expect(mutated).not.toBe(src);

    const dir = stageDir("2024-note-mutant", [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,Purple Tinsel (Meijer exclusive),false,,Alpha Player",
      "",
    ].join("\n"), { sport: "basketball", year: 2024, setKey: "note-mutant-set", setName: "2024 Note Mutant" });

    const mutantPath = path.join(path.dirname(script), `mutant-note-${Date.now()}.cjs`);
    fs.writeFileSync(mutantPath, mutated);
    try {
      const { execFileSync: run } = require("node:child_process");
      const stdout = run(process.execPath, [mutantPath], {
        env: { ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist" },
        encoding: "utf8",
      });
      expect(String(stdout)).toContain("catalog rows written   1");
      expect(String(stdout)).toContain("refused: note in rung name 0");
    } finally {
      try { fs.rmSync(mutantPath, { force: true }); } catch { /* best effort */ }
    }
  });
});

describe("the committed script is loadable", () => {
  it("node parses it", () => {
    expect(() => execFileSync(process.execPath, ["--check", script], { stdio: "pipe" })).not.toThrow();
  });
});
