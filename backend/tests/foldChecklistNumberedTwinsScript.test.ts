import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "fold-checklist-numbered-twins.cjs");
const source = fs.readFileSync(script, "utf8");

describe("fold-checklist-numbered-twins -- the scope refusal", () => {
  // The lesson from MODE=source defaulting to baseballcardpedia and reporting
  // 13.14M rows: a whole-scope write must be asked for by name.

  it("REFUSES with exit 1 when dispatched with no SPORTS and no YEARS", () => {
    let code: number | null = null;
    let out = "";
    try {
      execFileSync(process.execPath, [script], {
        // cwd is pinned to the backend dir so the run does not depend on where
        // vitest was invoked from, and the env is REPLACED rather than spread:
        // inheriting an ambient SPORTS/YEARS from the shell would hand the
        // script the very scope this test is asserting it does not have.
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          COSMOS_CONNECTION_STRING: "dummy",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      code = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      code = err.status ?? null;
      out = String(err.stderr ?? "") + String(err.stdout ?? "");
    }
    expect(code).toBe(1);
    expect(out).toMatch(/would fold the ENTIRE catalog/i);
    expect(out).toMatch(/SCOPE=all/);
  });

  it("puts the refusal AHEAD of every require that can throw, so a stale dist cannot fake it", () => {
    // This is the defect that made the run above pass for the wrong reason in a
    // checkout with a stale `dist`: the refusal sat inside main(), below
    // top-level requires of dist/ and @azure/cosmos, so the process exited on a
    // MODULE_NOT_FOUND that merely LOOKED like a refusal (exit 1, no message).
    // Assert the ORDER in the source, not just the observed exit code.
    const refusal = source.indexOf("would fold the ENTIRE catalog");
    expect(refusal).toBeGreaterThan(-1);

    // Every top-level require EXCEPT the node builtins `path` and `crypto`,
    // which cannot fail to resolve, must come after the refusal.
    const risky = [...source.matchAll(/^[ \t]*(?:const|let|var)\b[^\n]*\brequire\([^\n]*$/gm)]
      .filter((m) => !/require\((["'])(?:node:)?(?:path|crypto)\1\)/.test(m[0]));

    expect(risky.length).toBeGreaterThan(0);
    for (const m of risky) expect(m.index ?? 0).toBeGreaterThan(refusal);
  });
});

describe("fold-checklist-numbered-twins -- the report contract", () => {
  it("prints counters by KIND and by PRODUCT FAMILY", () => {
    expect(source).toMatch(/by KIND:/);
    expect(source).toMatch(/by PRODUCT FAMILY/);
    for (const kind of ["unnumbered-twin", "respelled-same-print-run", "no-auto-ghost"]) {
      expect(source).toContain(kind);
    }
    expect(source).toContain("productFamilyOf");
    // A rival print run is reported, never folded -- it must have its own
    // counter and its own sample block, outside the fold kinds.
    expect(source).toContain("rivalPrintRun");
    expect(source).toMatch(/RIVAL \/N \(reported, NOT folded\)/);
    expect(source).toMatch(/RIVAL \/N SAMPLES/);
  });

  it("pins Drew's Harris case into the sample selection", () => {
    expect(source).toMatch(/SAMPLE_PINS.*cpa-mh/);
    expect(source).toMatch(/PINNED SAMPLE/);
  });

  it("prints the house budget line verbatim, so the runner's relaunch grep fires", () => {
    expect(source).toContain("stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here");
  });

  it("counts relocated sales on their OWN line, never summed into re-pointed", () => {
    // A slice is not a sibling counter: these are different work.
    expect(source).toMatch(/sales re-pointed \(patch\)/);
    expect(source).toMatch(/sales relocated \(re-key\)/);
    expect(source).not.toMatch(/salesRepointed \+ stats\.salesRelocated/);
  });

  it("asserts the checklist row survives rather than assuming it", () => {
    expect(source).toContain("survivorNotIncumbent");
    expect(source).toMatch(/survivor !== "incumbent"/);
  });

  it("walks the holdings MAP and never JOINs into it", () => {
    expect(source).toContain("Object.entries(holdings)");
    expect(source).toMatch(/refusing to claim holdings are clean/);
    // The forbidden JOIN must not appear in QUERY text. It does appear in the
    // comment that forbids it, so strip comments before asserting rather than
    // letting the doc-block fake a failure.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/JOIN\s+h\s+IN\s+c\.holdings/i);
    expect(code).toMatch(/SELECT c\.id, c\.userId, c\.holdings FROM c/);
  });

  it("routes partition-keyed sales through relocate-sold-comp, not the in-place patch", () => {
    expect(source).toContain("relocateSoldComp");
    expect(source).toMatch(/c\.cardId = @t/);
  });
});

describe("fold-checklist-numbered-twins -- reportWrites counters are DISJOINT", () => {
  it("written + skipped + failed reconcile against intended, with written sub-totals kept out of skipped", () => {
    // Mirrors the script's own arithmetic: every twin-level outcome is counted
    // exactly once. Sub-totals of `written` (un-numbered / respelled-same-/N /
    // ghost) are printed on their own line and never added to `skipped`, and a
    // rival /N is a SKIP -- it is reported, never folded.
    const stats = {
      twinsFolded: 7,
      unnumberedTwin: 3,
      respelledSamePrintRun: 3,
      noAutoGhost: 1,
      noChecklistNumbered: 11,
      ambiguous: 2,
      twinIsChecklist: 5,
      twinIsTarget: 9,
      differentIdentity: 4,
      rivalPrintRun: 6,
      failed: 1,
    };
    expect(stats.unnumberedTwin + stats.respelledSamePrintRun + stats.noAutoGhost).toBe(stats.twinsFolded);

    const skipped = stats.noChecklistNumbered + stats.ambiguous + stats.twinIsChecklist + stats.twinIsTarget + stats.differentIdentity + stats.rivalPrintRun;
    const intended = stats.twinsFolded + skipped + stats.failed;
    const r = reconcileWrites({ job: "fold-checklist-numbered-twins", intended, written: stats.twinsFolded, skipped, failed: stats.failed });
    expect(r.ok).toBe(true);
  });

  it("folding a written sub-total into skipped breaks the reconciliation -- which is why it must not happen", () => {
    const r = reconcileWrites({ job: "fold-checklist-numbered-twins", intended: 20, written: 7, skipped: 31 + 3, failed: 1 });
    expect(r.ok).toBe(false);
  });
});
