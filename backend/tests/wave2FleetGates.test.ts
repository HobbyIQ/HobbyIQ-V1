/**
 * CF-VERIFY-EACH-SLOT-BY-ITS-BANNER-NEVER-BY-RUN-CONCLUSION — the WAVE 2 fleet
 * gate pins.
 *
 * WHY THESE EXIST. Every gate in `backend/scripts/wave2/wave2-fleet.sh` is a
 * regex over a banner that another file prints. That is a coupling nothing in
 * CI would otherwise notice breaking: rename a label in
 * `rematch-sold-comps.cjs` and the fleet driver stops finding the number,
 * silently — and a gate that cannot find its number must HOLD, not pass. Two
 * kinds of pin here, and they check different things:
 *
 *   1. THE READERS MATCH THE REAL BANNERS. Fixture lines are copied from the
 *      exact `console.log` templates in rematch-sold-comps.cjs, and the
 *      corresponding pin asserts the source still contains that template. So a
 *      renamed label fails HERE rather than in a fleet run at 2am.
 *
 *   2. AN ABSENT NUMBER IS NOT ZERO. The readers must FAIL on a log that lacks
 *      the line, because "0 written" and "no banner" are opposite facts: the
 *      first is a slot that found nothing, the second is a slot whose outcome
 *      is unknown. #1963's eighteen slots were exactly the second wearing the
 *      costume of the first.
 *
 * The shell is exercised through `bash`, not reimplemented: a pin that
 * re-derives the regex in TypeScript would pass while the shell was broken.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each shell pin spawns a real bash, which costs seconds on Windows (Git bash)
// and is not free on CI either; several pins spawn more than once. The default
// per-test budget measures process startup rather than the behaviour under
// test, so this file sets its own.
const SHELL_TIMEOUT_MS = 120_000;

const repoRoot = join(__dirname, "..", "..");
const FLEET = join(repoRoot, "backend", "scripts", "wave2", "wave2-fleet.sh");
const REMATCH = join(repoRoot, "backend", "scripts", "rematch-sold-comps.cjs");
const WORKFLOW = join(repoRoot, ".github", "workflows", "backfill-runner.yml");

const fleetSrc = readFileSync(FLEET, "utf8");
const rematchSrc = readFileSync(REMATCH, "utf8");
const workflowSrc = readFileSync(WORKFLOW, "utf8");

/**
 * WHICH bash. On CI (ubuntu) it is on PATH. On a Windows dev box the PATH
 * `bash.exe` is usually the WSL stub, which is not a shell these pins can use,
 * while Git for Windows ships a real one — so try PATH first and fall back to
 * the Git bash before concluding there is none. A pin that silently skips on
 * the machine where the script is being WRITTEN is worth very little.
 */
function findBash(): string | null {
  for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash", "/bin/bash"]) {
    try {
      execFileSync(candidate, ["-c", "true"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}
const BASH = findBash();
const HAS_BASH = BASH !== null;

/** A pin that shells out, with a budget sized for process startup. */
const itShell = (name: string, fn: () => void) =>
  it.runIf(HAS_BASH)(name, fn, SHELL_TIMEOUT_MS);

/**
 * Git bash on Windows does not resolve a `C:\\Users\\...` argument; it wants
 * `/c/Users/...`. On Linux the path is already correct and passes straight
 * through, so only the SPELLING changes on the way into the shell.
 */
function toShellPath(p: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return win ? `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : p;
}

/**
 * Source the fleet script's function definitions without running its `case`
 * dispatcher, then call ONE reader against a fixture log. Returns
 * { rc, out } so a pin can assert on the refusal as well as the number.
 */
function reader(fn: string, logBody: string, extraArg = ""): { rc: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "wave2-pin-"));
  const log = join(dir, "slot.log");
  writeFileSync(log, logBody, "utf8");
  // `set -- ` clears $1 so the case statement takes its refusal branch, which
  // exits 2 — so the functions are sourced from a copy with the dispatcher cut.
  const cut = fleetSrc.slice(0, fleetSrc.indexOf('case "${1:-}" in'));
  const harness = join(dir, "harness.sh");
  writeFileSync(harness, `${cut}\n${fn} "${toShellPath(log)}" ${extraArg}\n`, "utf8");
  try {
    const out = execFileSync(BASH!, [toShellPath(harness)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { rc: 0, out: out.trim() };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    return { rc: err.status ?? 1, out: (err.stdout ?? "").trim() };
  }
}

describe("the fleet script exists and is a file-launched bash script", () => {
  it("is present at the documented path", () => {
    expect(existsSync(FLEET)).toBe(true);
  });

  // CF-HEREDOC-LAUNCHERS-DEADLOCK-IDLE-GATES: the wrapper's own cmdline carries
  // the chain's grep pattern when a launcher is piped in as a heredoc, so the
  // fleet must be a FILE that is invoked by path.
  it("is a real script with a shebang, not something meant to be piped in", () => {
    expect(fleetSrc.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("dispatches ONLY the seven inputs the workflow already declares", () => {
    const dispatched = [...fleetSrc.matchAll(/-f ([a-z_]+)=/g)].map((m) => m[1]);
    const allowed = new Set(["script", "apply", "mode", "scope", "slot", "slots", "concurrency"]);
    for (const name of dispatched) expect(allowed.has(name), `-f ${name}= is not an existing input`).toBe(true);
    // and every one it uses really is declared in the workflow
    for (const name of new Set(dispatched)) {
      expect(workflowSrc).toMatch(new RegExp(`^      ${name}:`, "m"));
    }
  });

  it("never dispatches an apply with the inherited default scope", () => {
    // MODE=apply-improve REFUSES scope=refractor (exit 2) — that refusal is
    // what killed eighteen slots of the 2026-09-07 fleet (#1963).
    expect(fleetSrc).not.toMatch(/-f scope=refractor/);
    expect(fleetSrc).toMatch(/dispatch apply-improve true improve/);
  });
});

/**
 * CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE (#1868). THE PIN THAT MATTERS
 * MOST IN THIS FILE.
 *
 * `gh run view --log` prefixes every line with `<job>\t<step>\t<ISO ts> `. A
 * `^`-anchored grep against that returns NOTHING — not an error, a silent zero
 * — and a whole night's classification once reported all-zeros for exactly this
 * reason. Every gate here is fed the SAME fixture twice: once raw (as `| tee`
 * writes it) and once wearing the gh prefix. Both must produce the same number.
 * A reader that passes only the raw form is the defect, dressed as a pass.
 */
const GH = (body: string): string =>
  body
    .split("\n")
    .map((l) => (l === "" ? l : `run-backfill\tRun backfill (DRY-RUN)\t2026-09-07T18:20:09.1234567Z ${l}`))
    .join("\n");

describe("every reader survives the `gh run view --log` prefix (#1868)", () => {
  const CENSUS = "CENSUS  slot 0/32  rows classified 514,583\n  IMPROVE            20,867    4.06%   AUTO      20,000  PROTECTED     867\n";
  const APPLY = "  re-keyed   1,200\n  skipped        30   <- re-checked at write time and no longer writable\n  intended 1,240 = written 1,200 + skipped 30 + failed 2 + not reached 8\n  failed          2\n  not reached     8\n";

  itShell("census_classified reads the same number raw and prefixed", () => {
    expect(reader("census_classified", CENSUS).out).toBe("514583");
    expect(reader("census_classified", GH(CENSUS)).out).toBe("514583");
  });

  itShell("census_class reads the same number raw and prefixed", () => {
    expect(reader("census_class", CENSUS, "IMPROVE").out).toBe("20867");
    expect(reader("census_class", GH(CENSUS), "IMPROVE").out).toBe("20867");
  });

  itShell("apply_written reads the same number raw and prefixed", () => {
    expect(reader("apply_written", APPLY).out).toBe("1200");
    expect(reader("apply_written", GH(APPLY)).out).toBe("1200");
  });

  itShell("apply_reconciled balances raw and prefixed", () => {
    expect(reader("apply_reconciled", APPLY).rc).toBe(0);
    expect(reader("apply_reconciled", GH(APPLY)).rc).toBe(0);
  });

  itShell("chain_outcome reads the same outcome raw and prefixed", () => {
    const killed = "rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=census\nworking\n";
    expect(reader("chain_outcome", killed).out).toBe("killed");
    expect(reader("chain_outcome", GH(killed)).out).toBe("killed");
    const refused = "rematch-sold-comps: STARTUP REFUSED at phase=class-scope -- the lane never began work\n";
    expect(reader("chain_outcome", GH(refused)).out).toBe("startup-refused");
  });

  // The prefix carries the STEP NAME, which for an apply contains the word
  // "APPLY" — a reader that did not strip it could match on the wrong thing.
  itShell("strips ANSI as well as the tab prefix", () => {
    const ansi = "[32mCENSUS  slot 0/32  rows classified 514,583[0m\n";
    expect(reader("census_classified", ansi).out).toBe("514583");
  });

  it("the fleet script normalizes before it greps, and says why", () => {
    expect(fleetSrc).toContain("CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE");
    expect(fleetSrc).toContain("normalize() {");
    // no reader may grep the raw file directly
    expect(fleetSrc).not.toMatch(/grep -aoE (?:'[^']*'|"[^"]*") "\$1"/);
  });
});

describe("the fleet reads the shard's own canary verdict rather than re-deriving it", () => {
  itShell("reads a passing canary", () => {
    const log = "  all 7 canaries hold -- the shard may stand, and the next shard may be censused.\n";
    expect(reader("canary_verdict", log).out).toBe("hold");
    expect(reader("canary_verdict", GH(log)).out).toBe("hold");
  });

  itShell("reads a regression", () => {
    const log = "!! 3 of 7 canaries REGRESSED. This shard is damage, not an improvement.\n";
    expect(reader("canary_verdict", log).out).toBe("regressed");
  });

  // AN ABSENT VERDICT IS NOT A PASS. rematch-canary-check.cjs exits 2 when a
  // slot has no canary at all, precisely because "a shard with no canary passes
  // this gate by construction" is an absence of measurement, not a pass.
  itShell("calls a missing verdict absent, never a pass", () => {
    expect(reader("canary_verdict", "  re-keyed 10\n").out).toBe("absent");
  });

  it("holds the slot on anything but a passing canary", () => {
    expect(fleetSrc).toContain('regressed) warn "slot $slot CANARY REGRESSION');
    expect(fleetSrc).toContain("NO canary verdict in the log");
  });

  it("the canary literals match the ones rematch-canary-check.cjs prints", () => {
    const cc = readFileSync(join(repoRoot, "backend", "scripts", "rematch-canary-check.cjs"), "utf8");
    expect(cc).toContain("canaries REGRESSED");
    expect(cc).toContain("canaries hold -- the shard may stand");
  });
});

describe("the census reader reads the banner rematch-sold-comps actually prints", () => {
  // The literal template, from the source. If this moves, the reader is stale.
  it("pins the census banner template in the producing script", () => {
    expect(rematchSrc).toContain("`\\nCENSUS  slot ${SLOT}/${SLOTS}  rows classified ${f(total)}");
  });

  itShell("reads 'rows classified' with thousands separators", () => {
    const { rc, out } = reader("census_classified", "CENSUS  slot 0/32  rows classified 514,583\n");
    expect(rc).toBe(0);
    expect(out).toBe("514583");
  });

  itShell("reads a class count off its census line", () => {
    const log = [
      "CENSUS  slot 0/32  rows classified 514,583",
      "  AGREE              36,981    7.19%   AUTO      30,000  PROTECTED   6,981",
      "  IMPROVE            20,867    4.06%   AUTO      20,000  PROTECTED     867",
      "",
    ].join("\n");
    const { rc, out } = reader("census_class", log, "IMPROVE");
    expect(rc).toBe(0);
    expect(out).toBe("20867");
  });

  // THE PIN THAT MATTERS. A log with no census banner must REFUSE.
  itShell("refuses a log with no census banner rather than calling it zero", () => {
    const { rc, out } = reader("census_classified", "some other output\nnothing to see\n");
    expect(rc).not.toBe(0);
    expect(out).toBe("");
  });

  itShell("is not fooled by the word appearing in prose", () => {
    const { rc } = reader("census_classified", "note: rows classified by the old parser were wrong\n");
    expect(rc).not.toBe(0);
  });
});

describe("the apply readers read the apply summary block", () => {
  const APPLY_LOG = [
    "  re-keyed   1,200",
    "  skipped        30   <- re-checked at write time and no longer writable",
    "  failed          2",
    "  not reached     8",
    "",
    "  intended 1,240 = written 1,200 + skipped 30 + failed 2 + not reached 8",
    "",
  ].join("\n");

  it("pins the apply summary templates in the producing script", () => {
    expect(rematchSrc).toContain('`\\n  ${APPLY ? "re-keyed" : "would re-key"}   ${f(stats.written)}`');
    expect(rematchSrc).toContain("`  skipped        ${f(stats.skipped)}");
    expect(rematchSrc).toContain("`  failed         ${f(stats.failed)}");
    expect(rematchSrc).toContain("`  not reached    ${f(stats.notReached)}`");
    expect(rematchSrc).toContain(
      "`\\n  intended ${f(stats.intended)} = written ${f(stats.written)} + skipped ${f(stats.skipped)} + failed ${f(stats.failed)} + not reached ${f(stats.notReached)}`",
    );
  });

  itShell("reads written from an APPLY log", () => {
    expect(reader("apply_written", APPLY_LOG)).toEqual({ rc: 0, out: "1200" });
  });

  itShell("reads written from a REPORT log, which says 'would re-key'", () => {
    expect(reader("apply_written", "  would re-key   44,000\n")).toEqual({ rc: 0, out: "44000" });
  });

  itShell("reads skipped / failed / not reached", () => {
    expect(reader("apply_field", APPLY_LOG, "skipped").out).toBe("30");
    expect(reader("apply_field", APPLY_LOG, "failed").out).toBe("2");
    expect(reader("apply_field", APPLY_LOG, '"not reached"').out).toBe("8");
  });

  itShell("accepts a reconciliation that balances", () => {
    const { rc, out } = reader("apply_reconciled", APPLY_LOG);
    expect(rc).toBe(0);
    expect(out).toBe("1240");
  });

  // A DRIFTED RECONCILIATION IS A HOLD. The script itself exits 4 on drift;
  // the fleet must not pass the slot either.
  itShell("refuses a reconciliation that does NOT balance", () => {
    const drifted = "  intended 1,240 = written 1,000 + skipped 30 + failed 2 + not reached 8\n";
    expect(reader("apply_reconciled", drifted).rc).not.toBe(0);
  });

  itShell("refuses an ABSENT reconciliation — a missing line is not a balanced one", () => {
    expect(reader("apply_reconciled", "  re-keyed   1,200\n").rc).not.toBe(0);
  });
});

describe("chain_outcome tells the four outcomes apart", () => {
  // These are the exact strings backfill-runner.yml branches on. If the runner
  // and the fleet disagree about what a log means, the fleet is the one that
  // keeps dispatching.
  const cases: Array<[string, string]> = [
    ["rematch-sold-comps: STARTUP REFUSED at phase=env -- the lane never began work", "startup-refused"],
    ["rematch-sold-comps: STARTUP ok -- module load beginning (pid 1)\n", "died-in-startup"],
    ["rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=census\n  stopped at the 140-minute budget\n", "budget"],
    ["rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=census\nfinishLane: exiting code 0\n", "finished"],
    ["rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=census\nfinishLane: exiting code 5\n", "verdict"],
    ["rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=census\nwork work work\n", "killed"],
  ];
  for (const [log, expected] of cases) {
    itShell(`reads ${JSON.stringify(expected)}`, () => {
      expect(reader("chain_outcome", log).out).toBe(expected);
    });
  }

  itShell("calls an empty log empty, not a budget kill", () => {
    expect(reader("chain_outcome", "").out).toBe("empty-log");
  });

  it("the runner branches on the same literals", () => {
    expect(workflowSrc).toContain('grep -aq "rematch-sold-comps: STARTUP REFUSED"');
    expect(workflowSrc).toContain('grep -aqE "stopped at the .*budget"');
    expect(workflowSrc).toContain('grep -aqE "finishLane: exiting code 0( |$)"');
  });
});

describe("the apply gate holds when it cannot prove the slot", () => {
  const CENSUS_OK = [
    "  re-keyed   100",
    "  skipped     0",
    "  failed      0",
    "  not reached 0",
    "  intended 100 = written 100 + skipped 0 + failed 0 + not reached 0",
    "  all 7 canaries hold -- the shard may stand, and the next shard may be censused.",
    "",
  ].join("\n");

  function gate(log: string, expected: number, canary: boolean): number {
    const dir = mkdtempSync(join(tmpdir(), "wave2-gate-"));
    const f = join(dir, "slot.log");
    writeFileSync(f, log, "utf8");
    const cut = fleetSrc.slice(0, fleetSrc.indexOf('case "${1:-}" in'));
    const h = join(dir, "h.sh");
    writeFileSync(h, `${cut}\ngate_apply_slot 7 "${toShellPath(f)}" ${expected} ${canary}\n`, "utf8");
    try {
      execFileSync(BASH!, [toShellPath(h)], { stdio: ["ignore", "pipe", "pipe"] });
      return 0;
    } catch (e: unknown) {
      return (e as { status?: number }).status ?? 1;
    }
  }

  itShell("passes a slot inside the ±5% band", () => {
    expect(gate(CENSUS_OK, 100, false)).toBe(0);
    expect(gate(CENSUS_OK, 104, false)).toBe(0);
  });

  itShell("holds a slot that wrote far more than its census said was writable", () => {
    expect(gate(CENSUS_OK, 50, false)).not.toBe(0);
  });

  itShell("holds a slot that wrote far less", () => {
    expect(gate(CENSUS_OK, 400, false)).not.toBe(0);
  });

  // THE ZERO CASE. There is no percentage band around zero, and a slot writing
  // into a class its census found empty is the shape of a scope failure.
  itShell("admits only zero where the census found zero writable", () => {
    const zero = [
      "  re-keyed   0",
      "  intended 0 = written 0 + skipped 0 + failed 0 + not reached 0",
      "  all 7 canaries hold -- the shard may stand, and the next shard may be censused.",
      "",
    ].join("\n");
    expect(gate(zero, 0, false)).toBe(0);
    expect(gate(CENSUS_OK, 0, false)).not.toBe(0);
  });

  // THE CANARY IS A CEILING. Slot 0 proves nothing has gone wrong yet, so the
  // only claim it must satisfy is that it did not out-write its own census.
  itShell("the canary passes when it writes at or under the census, including far under", () => {
    expect(gate(CENSUS_OK, 100, true)).toBe(0);
    expect(gate(CENSUS_OK, 100000, true)).toBe(0);
  });

  itShell("the canary holds when it out-writes its census", () => {
    expect(gate(CENSUS_OK, 99, true)).not.toBe(0);
  });

  itShell("holds a slot whose banner is missing entirely", () => {
    expect(gate("nothing here\n", 100, false)).not.toBe(0);
    expect(gate("nothing here\n", 100, true)).not.toBe(0);
  });
});

describe("an apply cannot run without the census that gates it", () => {
  it("refuses when WAVE2_CENSUS_DIR is unset", () => {
    expect(fleetSrc).toContain('[ -n "$CENSUS_DIR" ] || die "WAVE2_CENSUS_DIR is unset');
  });

  it("dispatches nothing unless WAVE2_DISPATCH=true", () => {
    // The default is a dry run: an apply is armed by hand, never by running the
    // script with no arguments beyond the phase.
    expect(fleetSrc).toContain('DISPATCH="${WAVE2_DISPATCH:-false}"');
    expect(fleetSrc).toContain('if [ "$DISPATCH" != "true" ]; then');
  });

  it("runs the apply in waves, canary first", () => {
    expect(fleetSrc).toContain('WAVE_SIZE="${WAVE2_WAVE_SIZE:-4}"');
    expect(fleetSrc).toContain("run_apply_slots true 0");
    // and a held slot stops the fleet rather than letting the next wave go
    expect(fleetSrc).toMatch(/run_apply_slots false "\$\{wave\[@\]\}" \|\| die/);
  });
});

describe("the I9 re-baseline path is the artifact the workflow already uploads", () => {
  it("the workflow uploads a census artifact for EVERY rematch run", () => {
    expect(workflowSrc).toContain("name: rematch-census-slot-${{ inputs.slot }}-${{ github.run_id }}");
    expect(workflowSrc).toContain("if: ${{ always() && inputs.script == 'rematch-sold-comps' }}");
  });

  it("the census artifact carries the fields rebaseline-i9-reference.cjs requires", () => {
    // rebaseline skips a file unless it has `slot`, `classified` and `counts`.
    expect(rematchSrc).toMatch(/const census = \{[\s\S]*?slot: SLOT/);
    expect(rematchSrc).toMatch(/classified: total/);
    expect(rematchSrc).toMatch(/counts, byTier:/);
    const rb = readFileSync(join(repoRoot, "backend", "scripts", "rebaseline-i9-reference.cjs"), "utf8");
    expect(rb).toContain("if (!classified || j.slot === undefined || !j.counts)");
  });

  it("the collect phase points at that artifact by its real name", () => {
    expect(fleetSrc).toContain('-p "rematch-census-slot-$s-*"');
    expect(fleetSrc).toContain("rebaseline-i9-reference.cjs --from");
  });

  // #1950's prefilter is gated on MODE === "apply-improve", so a CENSUS
  // classifies every in-slot row. That is what makes its `classified` a
  // whole-shard number and therefore a legitimate corpus reference.
  it("the apply prefilter cannot narrow a census", () => {
    expect(rematchSrc).toMatch(/const APPLY_PREFILTER = MODE === "apply-improve"/);
  });

  /**
   * WHY A CENSUS AND AN `apply-improve scope=improve` REPORT ARE COMPARABLE.
   *
   * The existing reference was NOT taken under mode=census: every artifact
   * behind rematch-census-shares.json carries `mode: "apply-improve"` with
   * `applyPrefilter` absent. They are still comparable to a mode=census draw,
   * and the reason is specific and worth pinning: `applyPrefilterFor` returns
   * null unless the scope is a SINGLE kind that has an entry in the table, and
   * IMPROVE has no entry — it has no cheap necessary condition readable off a
   * stored row. So scope=improve classifies every in-slot row either way.
   *
   * The ruled single-kind scopes DO get a prefilter, their `classified` counts
   * only rows that could be that class, and feeding one of those artifacts to
   * the re-baseline would record a filtered subset as a corpus reference.
   */
  it("scope=improve gets no prefilter, which is what makes the two draws comparable", () => {
    const classify = readFileSync(join(repoRoot, "backend", "scripts", "lib", "rematch-classify.cjs"), "utf8");
    const at = classify.indexOf("function applyPrefilterFor(");
    expect(at).toBeGreaterThan(-1);
    const fn = classify.slice(at, at + 400);
    // a multi-kind scope, and any kind with no table entry, both get null
    expect(fn).toContain("if (kinds.length !== 1) return null;");
    expect(fn).toMatch(/APPLY_PREFILTERS\[kinds\[0\]\] \?\? null/);

    // and the table has entries ONLY for the two ruled scopes — never IMPROVE
    const tableAt = classify.indexOf("const APPLY_PREFILTERS = {");
    const table = classify.slice(tableAt, classify.indexOf("\n};", tableAt));
    expect(table).toContain("GRADE_FROM_TITLE");
    expect(table).toContain("YEAR_FROM_TITLE_VINTAGE");
    expect(table).not.toMatch(/\[\s*IMPROVE\s*\]/);
  });
});
