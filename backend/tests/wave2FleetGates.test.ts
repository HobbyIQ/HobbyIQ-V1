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

  /**
   * AN ESCAPE-BEARING LINE IS DROPPED, NOT DE-COLOURED — and that is deliberate.
   *
   * The obvious reading of "strip ANSI" is to de-colour the line and keep it.
   * But in a `gh run view --log` capture the ONLY lines carrying an escape are
   * Actions' own command echoes: the lane's banners are plain `console.log` and
   * are never coloured. Keeping a de-coloured echo is exactly how the first
   * version of this filter read `budget` off the relaunch step's own grep
   * pattern, on run 33947033673.
   *
   * So the rule is: an escape means "this is Actions talking, not the lane", and
   * the line goes. The `sed` that removes ANSI afterwards is belt-and-braces for
   * a raw capture, not the primary defence.
   */
  itShell("drops an escape-bearing line rather than de-colouring and trusting it", () => {
    const coloured = "\u001b[32mCENSUS  slot 0/32  rows classified 999,999\u001b[0m\n";
    expect(reader("census_classified", coloured).rc).not.toBe(0);
    // the same banner, plain, is read normally
    expect(reader("census_classified", "CENSUS  slot 0/32  rows classified 514,583\n").out).toBe("514583");
  });

  it("the fleet script normalizes before it greps, and says why", () => {
    expect(fleetSrc).toContain("CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE");
    expect(fleetSrc).toContain("normalize() {");
    // no reader may grep the raw file directly
    expect(fleetSrc).not.toMatch(/grep -aoE (?:'[^']*'|"[^"]*") "\$1"/);
  });

  /**
   * THE LOG CONTAINS THE GATE'S OWN GREP PATTERNS — measured, not imagined.
   *
   * `gh run view --log` includes each step's script as Actions echoes it, so the
   * relaunch step's own `grep -aqE "stopped at the .*budget"` is IN THE LOG as
   * text. Against run 33947033673 the first version of `chain_outcome` read
   * `budget` from a run that never hit its budget, because it matched that echo.
   *
   * And the echo does NOT carry a real ESC byte: the capture stores the literal
   * two characters `^` `[` (verified with `od -c`), so a filter written as
   * $'\x1b[' matches nothing at all. Both spellings must be excluded.
   */
  it("drops Actions' own echoed commands, in both spellings of the escape", () => {
    expect(fleetSrc).toContain("THE LOG CONTAINS THE GATE'S OWN GREP PATTERNS");
    // the group marker, the LITERAL caret-bracket a capture carries, and a real ESC
    expect(fleetSrc).toMatch(/grep -av -e '##\\\[' -e '\\\^\\\[\\\[' -e "\$\{ESC\}\\\["/);
  });

  itShell("does not read a verdict out of an echoed grep pattern", () => {
    // The exact shape of the two lines that fooled the first version.
    const poisoned = [
      "run-backfill\tUNKNOWN STEP\t2026-09-05T05:31:41Z CENSUS  slot 0/32  rows classified 514,583",
      "run-backfill\tUNKNOWN STEP\t2026-09-05T05:32:49Z ##[group]Run if grep -aqE \"stopped at the .*budget\" /tmp/backfill.log; then",
      "run-backfill\tUNKNOWN STEP\t2026-09-05T05:32:49Z ^[[36;1mif grep -aqE \"stopped at the .*budget\" /tmp/backfill.log; then^[[0m",
      "run-backfill\tUNKNOWN STEP\t2026-09-05T05:32:50Z finishLane: exiting code 0",
      "",
    ].join("\n");
    // The lane finished; the only "budget" text present is the workflow's echo.
    expect(reader("chain_outcome", poisoned).out).toBe("finished");
    // and the real banner is still read through the same filter
    expect(reader("census_classified", poisoned).out).toBe("514583");
  });
});

/**
 * THE REAL LOG, COMMITTED. Fixtures I wrote can only encode what I already
 * believed; this excerpt is bytes taken verbatim from `gh run view --log` on
 * run 33947033673 (rematch slot 0, 2026-09-05) — the census banner, its four
 * class lines, the canary verdict, and the two echoed-command lines that made
 * the first version of `chain_outcome` report `budget` on a run that never hit
 * one. It is the difference between a gate that passes its author's imagination
 * and a gate that passes the runner.
 */
describe("the gates read a REAL captured runner log", () => {
  const REAL = readFileSync(
    join(repoRoot, "backend", "tests", "fixtures", "wave2", "real-census-slot0-excerpt.txt"),
    "utf8",
  );

  itShell("reads the census total and every class off it", () => {
    expect(reader("census_classified", REAL).out).toBe("514583");
    expect(reader("census_class", REAL, "AGREE").out).toBe("36981");
    expect(reader("census_class", REAL, "IMPROVE").out).toBe("20867");
    expect(reader("census_class", REAL, "CONFLICT").out).toBe("381423");
    expect(reader("census_class", REAL, "UNDERIVABLE").out).toBe("75312");
  });

  itShell("reads the real canary verdict", () => {
    expect(reader("canary_verdict", REAL).out).toBe("hold");
  });

  // THE REGRESSION THIS FIXTURE EXISTS FOR. Both `stopped at the .*budget`
  // lines in it are Actions echoing the relaunch step's own grep. If the
  // echoed-command filter is ever weakened, this flips back to "budget".
  itShell("does NOT read a budget stop out of the workflow's echoed grep", () => {
    expect(reader("chain_outcome", REAL).out).not.toBe("budget");
  });

  it("the fixture really does contain the poison lines", () => {
    // If a future edit sanitises the fixture, the pin above stops proving
    // anything — so the fixture's own hazard is asserted.
    expect(REAL).toContain('grep -aqE "stopped at the .*budget"');
    expect(REAL).toContain("##[group]");
    // NOTE THE SPELLING: the capture stores the LITERAL two characters `^` `[`,
    // not an ESC byte (verified with od -c). A filter written as $'\\x1b[' would
    // miss this line entirely, which is how the first version of the echoed-command
    // filter let the relaunch step's own grep through.
    expect(REAL).toContain("^[[36;1m");
    expect(REAL.includes(String.fromCharCode(27))).toBe(false);
    // and it is a gh capture, not a raw one
    expect(REAL).toMatch(/^run-backfill	/m);
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
    // The four-outcome shell moved into .github/actions/relaunch-on-marker on
    // 2026-09-07: seventy-two copies of it had grown backfill-runner.yml to
    // 553 KB, past GitHub's 512 KB limit, where a dispatch is accepted and NO
    // job is ever created (30+ runs sat queued). The literals are unchanged;
    // they are now written once. The STARTUP prefix is parameterised, so the
    // lane's half — that the prefix IS `rematch-sold-comps` — is asserted on
    // the workflow, and the arm that greps it on the composite.
    const relaunchSrc = readFileSync(
      join(repoRoot, ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8",
    );
    expect(relaunchSrc).toContain('grep -aq "$RELAUNCH_STARTUP_PREFIX: STARTUP REFUSED"');
    expect(workflowSrc).toContain("startup-marker-prefix: rematch-sold-comps");
    expect(relaunchSrc).toContain('grep -aqE "stopped at the .*budget"');
    expect(relaunchSrc).toContain('grep -aqE "finishLane: exiting code 0( |$)"');
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

/**
 * THE STALLED-LANE PREFLIGHT.
 *
 * Measured while taking this driver's own shape proof on 2026-09-07: 30
 * backfill-runner runs QUEUED and ZERO in_progress, the oldest waiting over two
 * and a half hours without ever starting, while every other workflow ran
 * normally. Adding 32 more 180-minute jobs to that queue does not start 32
 * jobs — it ages them, and the driver would only learn so after burning
 * WAVE2_MAX_CHAIN_MINUTES per slot.
 */
describe("the fleet refuses to dispatch into a stalled lane", () => {
  it("checks the lane before dispatching, in both dispatching phases", () => {
    expect(fleetSrc).toContain("preflight_lane() {");
    // once in the census phase, once in the apply path
    expect(fleetSrc.match(/^ *preflight_lane$/gm)?.length).toBe(2);
  });

  it("treats a deep queue with NOTHING running as stalled, not busy", () => {
    // The distinguishing condition is `running == 0`, not queue depth alone: a
    // deep queue that is MOVING is merely busy and must not be refused.
    expect(fleetSrc).toMatch(/running:-0\}" -eq 0/);
    expect(fleetSrc).toMatch(/queued:-0\}" -ge/);
    expect(fleetSrc).toContain("the backfill lane is STALLED");
  });

  it("can be bypassed deliberately, and only deliberately", () => {
    expect(fleetSrc).toContain('WAVE2_SKIP_PREFLIGHT:-false');
    expect(fleetSrc).toContain("WAVE2_SKIP_PREFLIGHT=true to queue behind it deliberately");
  });

  // An unreadable lane is not an empty one. If the query fails, say so and
  // proceed — refusing on a failed `gh` call would make the driver unusable
  // offline, and the preflight is an early warning, not a safety interlock.
  it("proceeds with a warning when it cannot read the lane at all", () => {
    expect(fleetSrc).toContain("could not read the backfill lane's state — proceeding blind");
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

/**
 * CF-A-RUN-IS-IDENTIFIED-BY-ITS-LOG-NOT-BY-ITS-TIMING (#1974) — THE FINDER PINS.
 *
 * THE DEFECT THESE EXIST TO KEEP DEAD. `latest_run_for_slot` accepted a `slot`
 * argument and never referenced it. It returned the newest backfill-runner run
 * created after the dispatch timestamp — and backfill-runner is a SHARED lane
 * that every repair, retire and park script in the repo dispatches into. On
 * 2026-09-08 01:44Z the fleet read all 32 census slots off ONE stranger's run: a
 * park lane whose log says `Script confirmed:
 * backend/scripts/relocate-pool-rows-by-list.cjs`. Every banner reader found
 * nothing in it, `chain_outcome` called nothing a kill, and 32 slots reported
 * `outcome=killed` without a single census run ever being opened.
 *
 * So the pin that matters most here is the NEGATIVE one: a stranger's log must
 * be REJECTED. A finder that only proves it accepts the right run would have
 * passed on 09-08 as well — the old one accepted the right run too, whenever it
 * happened to be newest.
 *
 * Fixtures are the real line shapes, both spellings:
 *   - the workflow's `Script confirmed: backend/scripts/<name>.cjs`
 *   - the lane's `rematch-sold-comps  MODE=census  READ ONLY  slot 0/32 ...`
 * which is the one line stating script, mode and slot together.
 */
describe("the finder identifies a run by its log, not by when it started (#1974)", () => {
  const CONFIRM = (script: string) => `Script confirmed: backend/scripts/${script}.cjs`;
  const BANNER = (mode: string, slot: number, slots = 32) =>
    `rematch-sold-comps  MODE=${mode}  ${mode === "census" ? "READ ONLY" : "APPLY"}  slot ${slot}/${slots}  budget 140m  limit none`;

  /** A whole plausible run log for one slot. */
  const runLog = (script: string, mode: string, slot: number) =>
    [
      "rematch-sold-comps: STARTUP ok -- module load beginning (pid 1234)",
      CONFIRM(script),
      BANNER(mode, slot),
      "CENSUS  slot " + slot + "/32  rows classified 514,583",
      "finishLane: exiting code 0",
      "",
    ].join("\n");

  /** THE ACTUAL 2026-09-08 STRANGER: a park lane dispatched in the same minute. */
  const PARK_LANE = [
    CONFIRM("relocate-pool-rows-by-list"),
    "relocate-pool-rows-by-list  MODE=pool  slot 0/1",
    "  relocated 1,204 row(s)",
    "finishLane: exiting code 0",
    "",
  ].join("\n");

  const ident = (log: string, mode: string, slot: number) =>
    reader("run_log_identifies_slot", log, `${mode} ${slot}`).rc;

  itShell("accepts the run whose log names this script, this mode and this slot", () => {
    expect(ident(runLog("rematch-sold-comps", "census", 0), "census", 0)).toBe(0);
    expect(ident(GH(runLog("rematch-sold-comps", "census", 0)), "census", 0)).toBe(0);
  });

  // THE PIN THIS FILE EXISTS FOR.
  itShell("REJECTS the park lane the 09-08 fleet latched onto", () => {
    expect(ident(PARK_LANE, "census", 0)).not.toBe(0);
    expect(ident(GH(PARK_LANE), "census", 0)).not.toBe(0);
  });

  itShell("rejects another script's run even when it carries a slot 0 banner", () => {
    const other = [CONFIRM("retire-self-derived-identities"), "SLOT: 0", "MODE: census", ""].join("\n");
    expect(ident(other, "census", 0)).not.toBe(0);
  });

  itShell("rejects the right script running a DIFFERENT slot", () => {
    const slot7 = runLog("rematch-sold-comps", "census", 7);
    expect(ident(slot7, "census", 0)).not.toBe(0);
    expect(ident(slot7, "census", 7)).toBe(0);
  });

  /**
   * THE OFF-BY-A-DIGIT THAT WOULD REINTRODUCE THE BUG. The banner spells the
   * slot `slot 1/32`. A pattern matching a bare `slot 1` also matches
   * `slot 13/32`, so slot 1 would attach to slot 13's run — a different shard
   * of the same corpus, which is the hardest kind of wrong run to notice
   * because every banner reader finds plausible numbers in it.
   */
  itShell("does not let slot 1 attach to slot 13's run", () => {
    const slot13 = runLog("rematch-sold-comps", "census", 13);
    expect(ident(slot13, "census", 1)).not.toBe(0);
    expect(ident(slot13, "census", 13)).toBe(0);
  });

  itShell("rejects the right script and slot in the WRONG mode", () => {
    const applyRun = runLog("rematch-sold-comps", "apply-improve", 0);
    expect(ident(applyRun, "census", 0)).not.toBe(0);
    expect(ident(applyRun, "apply-improve", 0)).toBe(0);
  });

  // A run that refused at startup never printed the lane banner, but its
  // outcome is a REAL outcome for this slot and must stay readable — otherwise
  // #1963's startup refusals would come back as `unfound`.
  itShell("still identifies a slot whose run refused before printing a banner", () => {
    const refused = [
      CONFIRM("rematch-sold-comps"),
      "SLOT: 0",
      "MODE: census",
      "rematch-sold-comps: STARTUP REFUSED at phase=class-scope -- the lane never began work",
      "",
    ].join("\n");
    expect(ident(refused, "census", 0)).toBe(0);
    expect(reader("chain_outcome", refused).out).toBe("startup-refused");
  });

  itShell("an empty log identifies nothing", () => {
    expect(ident("", "census", 0)).not.toBe(0);
  });

  it("the finder reads a log and never returns a run on timing alone", () => {
    expect(fleetSrc).toContain("CF-A-RUN-IS-IDENTIFIED-BY-ITS-LOG-NOT-BY-ITS-TIMING");
    expect(fleetSrc).toContain("run_log_identifies_slot() {");
    expect(fleetSrc).toContain("find_run_for_slot() {");
    // the defect's function is gone entirely — not left beside its replacement
    expect(fleetSrc).not.toContain("latest_run_for_slot");
    // and the finder's accept path really is gated on the identity check
    expect(fleetSrc).toMatch(/if run_log_identifies_slot "\$probe" "\$mode" "\$slot"; then/);
  });

  /**
   * `unfound` AND `killed` ARE OPPOSITE CLAIMS. `killed` says we read a run and
   * it died; `unfound` says we never found the run. #1974 reported the second
   * as the first, which is what made a broken finder look like a dead fleet.
   */
  it("gives up as `unfound`, never as `killed`", () => {
    expect(fleetSrc).toMatch(/printf 'unfound'/);
    // the give-up branch is the finder's failure, not chain_outcome's else
    expect(fleetSrc).toMatch(/run=\$\(find_run_for_slot "\$mode" "\$slot" "\$since"\) \|\| \{/);
    // and `killed` is still only ever chain_outcome's word about a log it READ
    const killedUses = [...fleetSrc.matchAll(/printf 'killed'/g)];
    expect(killedUses.length).toBe(1);
  });

  // The verdict is read from the SAME identity check, on the completed log.
  // Finding the right run while it is in progress does not prove the file
  // captured at the end is that run's.
  it("re-asserts identity on the completed log before reading a verdict", () => {
    const follow = fleetSrc.slice(fleetSrc.indexOf("follow_slot() {"), fleetSrc.indexOf("selected_slots() {"));
    expect(follow).toMatch(/if ! run_log_identifies_slot "\$log" "\$mode" "\$slot"; then/);
    // and that refusal precedes the chain_outcome read
    expect(follow.indexOf("run_log_identifies_slot \"$log\"")).toBeLessThan(follow.indexOf("outcome=$(chain_outcome"));
  });

  // A chain follows a relaunch onto a NEW run id; that link is found the same
  // way, so the fleet cannot drift onto a stranger between links.
  it("follows a relaunch through the finder, not through `newest run`", () => {
    const follow = fleetSrc.slice(fleetSrc.indexOf("follow_slot() {"), fleetSrc.indexOf("selected_slots() {"));
    expect(follow).toContain("find_run_for_slot");
    expect(follow).not.toContain("--limit 60");
  });

  // Each phase tells the finder which MODE it dispatched, or a census would
  // accept an apply run of the same slot.
  it("each phase passes the mode it dispatched", () => {
    expect(fleetSrc).toContain('follow_slot census "$s" "$since" census');
    expect(fleetSrc).toContain('follow_slot apply "$s" "$since" apply-improve');
  });
});

/**
 * WAVE2_ONLY_SLOTS — driving a SUBSET of the shard table, not a smaller one.
 *
 * WAVE2_SLOTS is the DENOMINATOR: it is dispatched as `-f slots=` and decides
 * which rows a slot owns. Lowering it to 1 to verify the driver on one slot
 * would silently re-shard the corpus, and the resulting census would describe a
 * shard table that exists nowhere else. WAVE2_ONLY_SLOTS selects which slots of
 * the SAME table to drive, and leaves the denominator alone.
 */
describe("WAVE2_ONLY_SLOTS drives a subset without re-sharding the corpus", () => {
  const slots = (only: string, total = "32"): { rc: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-slots-"));
    const cut = fleetSrc.slice(0, fleetSrc.indexOf('case "${1:-}" in'));
    const harness = join(dir, "h.sh");
    writeFileSync(harness, `${cut}\nselected_slots | tr '\\n' ' '\n`, "utf8");
    try {
      const out = execFileSync(BASH!, [toShellPath(harness)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_ONLY_SLOTS: only, WAVE2_SLOTS: total },
      });
      return { rc: 0, out: out.trim() };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string };
      return { rc: err.status ?? 1, out: (err.stdout ?? "").trim() };
    }
  };

  itShell("unset drives the whole table", () => {
    expect(slots("").out.split(/\s+/).length).toBe(32);
  });

  itShell("names one slot, and only that slot", () => {
    expect(slots("0").out).toBe("0");
    expect(slots("7").out).toBe("7");
  });

  itShell("accepts a comma list", () => {
    expect(slots("0,3,31").out).toBe("0 3 31");
  });

  itShell("refuses a slot outside the shard table", () => {
    expect(slots("32").rc).not.toBe(0);
  });

  itShell("refuses a value that is not a slot number", () => {
    expect(slots("all").rc).not.toBe(0);
  });

  it("selecting slots never changes the dispatched denominator", () => {
    // `-f slots=` is fed by SLOTS, never by ONLY_SLOTS
    expect(fleetSrc).toContain('-f slot="$slot" -f slots="$SLOTS"');
    expect(fleetSrc).not.toMatch(/-f slots="\$ONLY_SLOTS"/);
  });
});
