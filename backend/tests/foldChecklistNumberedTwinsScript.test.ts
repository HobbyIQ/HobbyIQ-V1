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
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\Windows",
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

  it("CF-A-CROSS-PRODUCT-FOLD-IS-NOT-A-FOLD: a twin and target whose id setKey SEGMENTS disagree are skipped as their own bucket, never attempted", () => {
    // Run 35414193671: identityKeyOf groups by the setKey FIELD (right for
    // R1, D23 mid-flight rename), but an ingest-auto-seed twin's FIELD can
    // drift from its own id -- `bowman-paper -> bowman`, `bowman-chrome-
    // sapphire -> bowman`, `bowman-chrome -> bowman-draft` all threw inside
    // moveCatalogRow's own guard and were miscounted as `failed`. Caught here
    // BEFORE the attempt, so it costs no write and is not a defect count.
    expect(source).toContain("crossProductNotFolded");
    expect(source).toMatch(/cross-product \(not folded\)/);
    // Must be checked using the ID's own setKey segment (split(":")[3]),
    // never the row's setKey FIELD -- the field is exactly what put them in
    // one group; re-reading it here would never catch the drift.
    expect(source).toMatch(/twin\.id[^\n]*split\(":"\)\[3\]/);
    expect(source).toMatch(/target\.id[^\n]*split\(":"\)\[3\]/);
    // The check runs BEFORE the try{} that calls moveCatalogRow, never after
    // -- a skip that costs a write attempt first is not "caught before it".
    const crossProductCheckIdx = source.indexOf("crossProductNotFolded++");
    const tryBlockIdx = source.indexOf("ASK FIRST, RELOCATE AFTER");
    expect(crossProductCheckIdx).toBeGreaterThan(-1);
    expect(tryBlockIdx).toBeGreaterThan(-1);
    expect(crossProductCheckIdx).toBeLessThan(tryBlockIdx);
  });

  it("every FAILED fold is printed in full, never a 5-line sample", () => {
    // Run 35414193671, link 1: written 1,704, failed 632, but only 6 lines
    // printed -- `if (stats.failed <= 5)`. An operator could not tell 632
    // instances of one defect from 632 different ones. Fixed: every failure
    // is collected and printed, with the full stack, not a 140-character
    // truncation.
    expect(source).not.toMatch(/if\s*\(\s*stats\.failed\s*<=\s*5\s*\)/);
    expect(source).toMatch(/failures\.push/);
    expect(source).toMatch(/FAILED -- every one, in full/);
  });
});

describe("fold-checklist-numbered-twins -- the run's log is kept as a durable artifact", () => {
  it("the backfill-runner workflow uploads this lane's log, matching the pattern every other refile/fold lane already uses", () => {
    const workflow = fs.readFileSync(
      path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/Upload the checklist-numbered fold log/);
    // The step must gate on the EXISTING inputs.script value, never introduce
    // a new workflow_dispatch input.
    expect(workflow).toMatch(/inputs\.script == 'fold-checklist-numbered-twins'/);
    // Path is the same /tmp/backfill.log every other script's stdout is
    // tee'd to -- no new log file, no new input needed for it to exist.
    const uploadBlock = workflow.slice(workflow.indexOf("Upload the checklist-numbered fold log"), workflow.indexOf("Upload the checklist-numbered fold log") + 500);
    expect(uploadBlock).toContain("/tmp/backfill.log");
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
