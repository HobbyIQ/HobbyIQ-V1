// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE — the exit path, pinned (#1809).
//
// THE RUN THAT WROTE THIS FILE. Four APPLY shards of
// retire-self-derived-identities (sport=baseball, slots=16):
//
//   33975816175 slot 1   last line 17:22:23   killed 18:17:31   (55m silent)
//   33975825863 slot 2   last line 16:14:14   killed 18:17:49  (123m silent)
//   33975834391 slot 3   last line 16:36:18   killed 18:17:53  (101m silent)
//   33975840824 slot 4   last line 16:22:59   killed 18:18:01  (115m silent)
//
// Every one of them printed its banner, its `RECONCILE ... BALANCES` and its
// `reconciled: intended ... = written ... + skipped ...`. Every one of them
// then printed NOTHING AT ALL until
//
//   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
//
// and — the detail that names the cause — not one of the four ever printed a
// `VERIFY BY READ` line. A slow verify still prints when its cap fires. This
// was not a slow verify. This was a process that had FINISHED and would not
// EXIT.
//
// WHY IT WOULD NOT EXIT. #1799 capped the verify with `Promise.race`. A race
// picks a winner and ABANDONS the loser; it does not cancel it. The loser was
// a cross-partition aggregate wrapped in the lane's own `retry()`, which kept
// sleeping on REF'd `setTimeout`s and re-issuing the query. A ref'd handle is
// exactly what keeps node alive. So `main()` resolved, the report finished,
// and node sat on the abandoned work until the runner killed the step — and a
// killed step reports nothing, so the run went red on data that was already
// correct and durable.
//
// THE RULE. A lane does not END. It EXITS: explicitly, after flushing, with
// the code it means. Before this change all 62 budgeted lanes had a failure
// path that exited (`main().catch(... process.exit(3))`) and a SUCCESS path
// that merely hoped the event loop would drain. That asymmetry IS the bug.
//
// These pins are mutation-sensitive by construction:
//   - delete the explicit exit from finishLane   -> the live-handle test hangs
//   - drop the abort from capped()               -> the abandoned-retry test fails
//   - let a lane fall off the end of main()      -> the census test names it
//   - shrink the workflow's timeout-minutes      -> the exit-margin test fails
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const LIB = read("backend", "scripts", "lib", "runner-budget.cjs");
const RUNNER = read(".github", "workflows", "backfill-runner.yml");

/** Run a throwaway script under the real node, with a hard wall-clock kill.
 *  `timedOut` is the whole point: it is how a NON-EXITING process is detected
 *  without hanging this suite the way it hung the runner. */
function runNode(source: string, killMs = 15000) {
  const file = path.join(
    fs.mkdtempSync(path.join(require("node:os").tmpdir(), "lane-exit-")),
    "probe.cjs",
  );
  fs.writeFileSync(file, source);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    timeout: killMs,
    killSignal: "SIGKILL",
    cwd: BACKEND,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    /** True when the process had to be killed — i.e. it did NOT exit itself. */
    timedOut: r.signal === "SIGKILL" || (r as { error?: Error }).error?.message?.includes("ETIMEDOUT") === true,
    ms: Date.now() - t0,
  };
}

const LIB_REQUIRE =
  `const { budget, finishLane } = require(${JSON.stringify(
    path.join(BACKEND, "scripts", "lib", "runner-budget.cjs"),
  )});`;

// ── 1. THE REPRODUCTION ────────────────────────────────────────────────────
//
// A fake container whose query NEVER resolves, standing in for the Cosmos
// aggregate that was still in flight when the runner killed the step. The
// handle is REAL — a live socket — because that is what actually keeps node
// alive; a bare pending promise does not, and a test that used one would pass
// against the very bug it is meant to catch.
describe("a lane whose verify query never resolves still exits within the cap", () => {
  const fakeContainerThatNeverAnswers = `
    const net = require("net");
    // A server that accepts and never replies: an in-flight request that will
    // outlive any cap unless something cancels it.
    const srv = net.createServer(() => {});
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      const container = {
        items: {
          query() {
            return { fetchAll: (opts) => new Promise((_res, rej) => {
              const s = net.connect(port, "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\n\\r\\n"));
              s.on("error", () => {});
              // DELIBERATELY UNCOOPERATIVE, and that is the whole point. The
              // real @azure/cosmos request that hung run 33975816175 and its
              // three siblings did NOT tear its connection down when the race
              // stopped waiting for it. A fake that politely destroys its
              // socket on abort leaves nothing behind — so the probe would
              // exit even with the explicit exit REMOVED, and this pin would
              // pass against the very bug it exists to catch (verified: it
              // did). This fake keeps the handle open, so only an explicit
              // process.exit can end the probe.
              void opts; void CONTAINER_SIGNAL; void rej;
            }) };
          },
        },
      };
      __RUN__(container, srv);
    });
  `;

  it("prints its cap line, and the PROCESS EXITS — it is not killed at the ceiling", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      let CONTAINER_SIGNAL = null;
      ${fakeContainerThatNeverAnswers.replace("__RUN__", "run")}
      async function run(container, srv) {
        // A one-second verify cap standing in for the ten-minute one.
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 1000 });
        const vt0 = Date.now();
        const v = await b.capped(vt0, "retiredReason", (signal) => {
          CONTAINER_SIGNAL = signal;
          return container.items.query({}).fetchAll({ abortSignal: signal });
        });
        console.log("VERIFY BY READ  baseball: retiredReason now " + b.shown(v));
        console.log("[probe] main returned, v=" + v);
        srv.close();
        // THE LINE UNDER TEST. Without it this process sits on the abandoned
        // socket until something external kills it.
        await finishLane(0);
      }
    `);

    expect(r.timedOut, "the lane did NOT exit — it had to be killed, exactly as run 33975816175 was").toBe(false);
    expect(r.stdout).toContain("could not confirm within the cap");
    expect(r.stdout).toContain("UNCONFIRMED (verify cap)");
    expect(r.stdout).toContain("[probe] main returned, v=null");
    expect(r.status, "a lane whose verify was merely UNREAD is not a failed lane").toBe(0);
  });

  it("exits promptly after the cap, not merely eventually", () => {
    // The cap is 1s. An exit that takes 15s would still 'pass' a liveness
    // check while failing the operator, so the budget for the exit is pinned.
    const r = runNode(`
      ${LIB_REQUIRE}
      let CONTAINER_SIGNAL = null;
      ${fakeContainerThatNeverAnswers.replace("__RUN__", "run")}
      async function run(container, srv) {
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 1000 });
        await b.capped(Date.now(), "x", (signal) => {
          CONTAINER_SIGNAL = signal;
          return container.items.query({}).fetchAll({ abortSignal: signal });
        });
        srv.close();
        await finishLane(0);
      }
    `);
    expect(r.timedOut).toBe(false);
    expect(r.ms, `the lane took ${r.ms}ms to exit after a 1s cap`).toBeLessThan(10000);
  });
});

// ── 2. THE MUTATION CHECK ──────────────────────────────────────────────────
//
// A pin that cannot fail is decoration. This runs the SAME probe with the
// explicit exit REMOVED and asserts the process then hangs — proving the test
// detects the live handle rather than passing because node happened to exit.
describe("MUTATION: remove the explicit exit and the lane hangs", () => {
  it("without finishLane() the probe has to be killed — the handle is real", () => {
    const r = runNode(
      `
      ${LIB_REQUIRE}
      let CONTAINER_SIGNAL = null;
      const net = require("net");
      const srv = net.createServer(() => {});
      srv.listen(0, "127.0.0.1", async () => {
        const port = srv.address().port;
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 500 });
        await b.capped(Date.now(), "x", (signal) => new Promise((_res, rej) => {
          const s = net.connect(port, "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\n\\r\\n"));
          s.on("error", () => {});
          // The mutation: the abandoned request IGNORES the abort, as the
          // real Cosmos call did before this change.
        }));
        console.log("[probe] main returned");
        // NO finishLane() — the mutation. srv and the socket stay open.
      });
    `,
      6000,
    );
    expect(r.stdout).toContain("[probe] main returned");
    expect(
      r.timedOut,
      "the mutation did NOT hang, so this suite would not have caught the original bug",
    ).toBe(true);
  });

  it("MUTATION: an abandoned retry loop keeps node alive when nothing aborts it", () => {
    // The precise mechanism from the four killed runs: the race resolves, and
    // the loser's retry loop goes on sleeping on REF'd timers.
    const r = runNode(
      `
      const VERIFY_MS = 300;
      let calls = 0;
      const throttled = async () => { calls++; throw new Error("Request rate is too large 429"); };
      const retry = async (fn, tries = 12) => {
        let wait = 200;
        for (let a = 0; ; a++) {
          try { return await fn(); }
          catch (e) {
            if (a >= tries) throw e;
            await new Promise((r) => setTimeout(r, wait)); // REF'd: holds the loop
            wait = Math.min(wait * 2, 30000);
          }
        }
      };
      (async () => {
        try {
          await Promise.race([
            retry(throttled, 12),
            new Promise((_r, rej) => setTimeout(() => rej(new Error("verify-cap")), VERIFY_MS).unref?.()),
          ]);
        } catch (e) { console.log("[probe] capped: " + e.message); }
        console.log("[probe] main returned while retry keeps looping");
      })();
    `,
      5000,
    );
    expect(r.stdout).toContain("[probe] capped: verify-cap");
    expect(r.stdout).toContain("[probe] main returned");
    expect(r.timedOut, "an abandoned retry loop must be shown to hold the process open").toBe(true);
  });
});

// ── 3. THE ABORT ───────────────────────────────────────────────────────────
describe("capped() cancels the loser instead of merely abandoning it", () => {
  it("hands the caller an abort signal and fires it when the cap expires", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 300 });
        let aborted = false;
        await b.capped(Date.now(), "x", (signal) => new Promise((_res, _rej) => {
          if (!signal) { console.log("[probe] NO SIGNAL GIVEN"); return; }
          // Print from INSIDE the listener: capped() aborts in a finally
          // block, so by the time it resolves the abort has been delivered.
          signal.addEventListener("abort", () => {
            aborted = true;
            console.log("[probe] aborted=true");
          });
        }));
        if (!aborted) console.log("[probe] aborted=false");
        await finishLane(0);
      })();
    `);
    expect(r.stdout).not.toContain("[probe] NO SIGNAL GIVEN");
    expect(r.stdout, "the cap must ABORT the loser, not walk away from it").toContain("[probe] aborted=true");
    expect(r.timedOut).toBe(false);
  });

  // FOUND WHILE WRITING THIS PIN. The first cut of the fix unref'd the cap
  // timer, reasoning that the cap must never itself hold the process open.
  // That is backwards. If the abandoned query holds no ref'd handle of its
  // own, an unref'd cap means node exits the instant main() awaits -- BEFORE
  // the cap fires -- and the lane prints NO VERIFY LINE AT ALL. That is the
  // same symptom as the four killed runs (silence where a number belongs),
  // arrived at from the opposite direction. The cap holds the loop just long
  // enough to report, and clearTimeout releases it.
  it("a cap on a query holding NO handle still prints, instead of exiting silently", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 300 });
        // A promise that never settles and holds NOTHING: no socket, no timer.
        const v = await b.capped(Date.now(), "retiredReason", () => new Promise(() => {}));
        console.log("[probe] v=" + v + " capFired=" + b.capFired());
        await finishLane(0);
      })();
    `);
    expect(
      r.stdout,
      "the lane exited before its own cap fired and printed nothing — silence is the "
        + "one outcome this change exists to prevent",
    ).toContain("could not confirm within the cap");
    expect(r.stdout).toContain("[probe] v=null capFired=true");
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
  });

  it("a verify that answers inside the cap still returns its number", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 5000 });
        const v = await b.capped(Date.now(), "retiredReason", async () => 61450);
        console.log("[probe] v=" + v + " shown=" + b.shown(v));
        console.log("[probe] capFired=" + b.capFired());
        await finishLane(0);
      })();
    `);
    expect(r.stdout).toContain("[probe] v=61450 shown=61,450 rows");
    expect(r.stdout, "a cap that did not fire must not claim it did").toContain("[probe] capFired=false");
    expect(r.stdout).not.toContain("could not confirm");
    expect(r.timedOut).toBe(false);
  });
});

// ── 4. FLUSH BEFORE EXIT ───────────────────────────────────────────────────
//
// process.exit() truncates a pipe that has not drained, and the runner reads
// every lane through `| tee /tmp/backfill.log` — a PIPE, so stdout is
// asynchronous. An exit that dropped the reconcile lines would break the
// relaunch gate that greps them (CF-RELAUNCH-ONLY-ON-BUDGET).
describe("the exit flushes what the relaunch gate greps for", () => {
  it("a large final report survives the exit, through a pipe", () => {
    const probe = `
      ${LIB_REQUIRE}
      (async () => {
        for (let i = 0; i < 4000; i++) console.log("  filler line " + i + " ".repeat(40));
        console.log("  RECONCILE  seen 180,913 = retired 3,887 + unverified 61,450"
          + " + alreadyMarked 2,692 + cardLevelLeft 112,884  => 180,913 BALANCES");
        console.log("[retire-self-derived-identities] reconciled: intended 180,937"
          + " = written 65,361 + skipped 115,576");
        console.log("  stopped at the 110-minute budget with products left");
        await finishLane(0);
      })();
    `;
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "lane-flush-"));
    const file = path.join(dir, "probe.cjs");
    fs.writeFileSync(file, probe);
    // Through a real pipe, which is what makes stdout async.
    const out = execFileSync(
      process.execPath,
      ["-e", `require("child_process").execFileSync(process.execPath, [${JSON.stringify(file)}], { stdio: "inherit" })`],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(out).toContain("=> 180,913 BALANCES");
    expect(out).toContain("reconciled: intended 180,937 = written 65,361 + skipped 115,576");
    expect(out).toContain("stopped at the 110-minute budget");
    expect(out.split("\n").filter((l) => l.includes("filler line")).length).toBe(4000);
  });
});

// ── 5. THE CENSUS: EVERY BUDGETED LANE ROUTES THROUGH THE HELPER ───────────
function whitelistedScripts(): string[] {
  const blk = RUNNER.slice(RUNNER.indexOf("      script:"));
  const m = /options:\n((?:\s*(?:-|#).*\n)+)/.exec(blk);
  expect(m, "the script input must declare its options list").toBeTruthy();
  return (m as RegExpExecArray)[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

type Lane = { script: string; src: string };

const LANES: Lane[] = whitelistedScripts()
  .map((script) => ({ script, file: path.join("backend", "scripts", `${script}.cjs`) }))
  .filter(({ file }) => fs.existsSync(path.join(ROOT, file)))
  .map(({ script, file }) => ({ script, src: read(file) }))
  .filter((l) => /RUN_MINUTES|BUDGET_MS/.test(l.src));

describe("every budgeted lane ends by EXITING, not by hoping the loop drains", () => {
  it("the census found the lanes it is supposed to govern", () => {
    expect(LANES.length).toBeGreaterThanOrEqual(60);
  });

  for (const lane of LANES) {
    it(`${lane.script} routes its ending through finishLane()`, () => {
      expect(
        /finishLane\s*\(/.test(lane.src),
        `${lane.script} never calls finishLane(). Its success path falls off the end of `
          + `main() and trusts the event loop to drain — the exact bet runs 33975816175, `
          + `33975825863, 33975834391 and 33975840824 lost AFTER reconciling clean.`,
      ).toBe(true);
    });

    it(`${lane.script} imports finishLane from the ONE helper`, () => {
      expect(
        /\{[^}]*\bfinishLane\b[^}]*\}\s*=\s*require\([^)]*runner-budget\.cjs"\)\s*\)/.test(lane.src),
        `${lane.script} calls finishLane() without requiring it from `
          + `scripts/lib/runner-budget.cjs — the fix lives in ONE place or it is not a fix.`,
      ).toBe(true);
    });

    it(`${lane.script} exits on SUCCESS, not only on failure`, () => {
      // The asymmetry that was the bug: every lane already exited on error.
      const tail = lane.src.slice(-1200);
      expect(
        /\.then\(\s*(?:\([^)]*\)|\w+)\s*=>\s*finishLane\(/.test(tail)
          || /await finishLane\(\s*0/.test(tail)
          || /finishLane\(\s*process\.exitCode/.test(tail),
        `${lane.script} has no success-path exit. A failure path that exits and a success `
          + `path that hopes is precisely the asymmetry #1809 closed.`,
      ).toBe(true);
    });
  }
});

// ── 6. THE HELPER ITSELF ───────────────────────────────────────────────────
describe("finishLane is the single exit path", () => {
  it("exits explicitly — the guarantee is process.exit, not a drained loop", () => {
    expect(LIB).toMatch(/async function finishLane\(/);
    expect(LIB, "the guarantee IS the explicit exit").toMatch(/process\.exit\(code\)/);
  });

  it("flushes before it exits, because the runner reads the lane through a pipe", () => {
    const fn = /async function finishLane\([\s\S]*?\n\}/.exec(LIB)?.[0] ?? "";
    expect(fn).toMatch(/await flushStdio\(\)/);
    expect(fn.indexOf("await flushStdio()")).toBeLessThan(fn.indexOf("process.exit(code)"));
  });

  it("disposes the Cosmos client when one is handed to it", () => {
    expect(LIB).toMatch(/client\.dispose/);
  });

  it("the flush cannot itself become a way to hold the process open", () => {
    const fn = /async function flushStdio\(\)[\s\S]*?\n\}/.exec(LIB)?.[0] ?? "";
    expect(fn, "an unbounded flush would be the same bug wearing a different hat").toMatch(/setTimeout/);
    expect(fn).toMatch(/unref/);
  });

  it("the cap timer is REF'd, so the cap can never be lost to an early exit", () => {
    const fn = /const capped = async \([\s\S]*?\n  \};/.exec(LIB)?.[0] ?? "";
    expect(fn).toMatch(/timer = setTimeout\(/);
    expect(
      /timer\.unref\(\)/.test(fn),
      "an unref'd cap timer lets node exit BEFORE the cap fires when the query holds no "
        + "handle, and the lane then prints no VERIFY line at all — silence, which is the "
        + "exact symptom this change exists to remove. clearTimeout in the finally is what "
        + "releases the loop instead.",
    ).toBe(false);
    expect(fn, "the cap must be released on every path").toMatch(/finally[\s\S]*clearTimeout\(timer\)/);
  });

  it("capped() aborts the loser and records that the cap fired", () => {
    const fn = /const capped = async \([\s\S]*?\n  \};/.exec(LIB)?.[0] ?? "";
    expect(fn).toMatch(/new AbortController\(\)/);
    expect(fn, "the abort must be in a finally, so it runs on every path").toMatch(/finally[\s\S]*ac\.abort\(\)/);
    expect(fn).toMatch(/capFired = true/);
    expect(fn, "the caller needs the signal to pass to the SDK").toMatch(/run\(ac\.signal\)/);
  });
});

// ── 7. THE MARGIN INCLUDES THE EXIT ────────────────────────────────────────
//
// runnerBudgetMargin.test.ts pins RUN_MINUTES + reserve + verify + startup.
// That arithmetic silently assumed the exit was free. It is not: it is a
// flush plus a dispose, and the four killed runs are what an unbudgeted exit
// costs. The margin is re-asserted here WITH the exit path counted.
describe("the ceiling leaves >= 15 minutes AFTER the exit path is paid for", () => {
  function stepCeilingMinutes(): number {
    const step = RUNNER.split(/^      - name: /m).find((s) => /^Run backfill \(/.test(s));
    const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(step as string);
    return Number((m as RegExpExecArray)[1]);
  }

  /** The exit path's own worst case: flushStdio's 2s-per-stream ceiling plus
   *  the dispose. Rounded up to a whole minute, because a budget stated in
   *  minutes cannot be honest about seconds. */
  const EXIT_MINUTES = 1;
  const STARTUP_MINUTES = 1;
  const REQUIRED_MARGIN_MINUTES = 15;

  const CEILING = stepCeilingMinutes();

  function msDefault(src: string, name: string): number | null {
    const re = new RegExp(
      `${name}\\s*=\\s*Number\\(process\\.env\\.[A-Z_]+ \\|\\| ([0-9]+(?:\\s*\\*\\s*[0-9]+)*)\\)`,
    );
    const m = re.exec(src);
    if (m) return m[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
    const kw = name.replace(/_MS$/, "").toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
    const m2 = new RegExp(`${kw}Ms:\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)`).exec(src);
    if (m2) return m2[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
    return null;
  }

  const BUDGET_PATTERNS: RegExp[] = [
    /const RUN_MS = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\) \* 60_?000/,
    /const RUN_MINUTES = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\)/,
    /const RUN_MINUTES = Number\(arg\("[a-z-]+", *(?:process\.)?env\(?"?RUN_MINUTES"?,? *"?(\d+)"?\)?\)\)/,
    /const RUN_MINUTES = Number\(arg\("[a-z-]+", *process\.env\.RUN_MINUTES \?\? "(\d+)"\)\)/,
    /const RUN_MINUTES = Math\.max\(\d+, Number\(arg\("[a-z-]+", "(\d+)"\)\)\)/,
    /const BUDGET_MS = Number\(process\.env\.[A-Z_]+ \|\| (\d+) \* 60 \* 1000\)/,
    /runMinutes\((\d+)\)/,
    /minutes: (\d+)[,\s]/,
  ];

  it("the ceiling is still the 150 the four kills hit", () => {
    expect(CEILING).toBe(150);
  });

  for (const lane of LANES) {
    it(`${lane.script}: budget + reserve + verify + startup + EXIT fits with >= ${REQUIRED_MARGIN_MINUTES}m spare`, () => {
      let runM: number | null = null;
      for (const re of BUDGET_PATTERNS) {
        const m = re.exec(lane.src);
        if (m) { runM = Number(m[1]); break; }
      }
      expect(runM, `${lane.script}'s budget is unreadable, so its margin is uncomputable`).not.toBeNull();

      const reserve = (msDefault(lane.src, "RESERVE_MS")
        ?? msDefault(lane.src, "PRODUCT_RESERVE_MS")
        ?? msDefault(lane.src, "RESERVE_FLOOR_MS") ?? 0) / 60000;
      const verify = (msDefault(lane.src, "VERIFY_MS") ?? 0) / 60000;
      const worstCase = (runM as number) + reserve + verify + STARTUP_MINUTES + EXIT_MINUTES;
      const margin = CEILING - worstCase;

      expect(
        margin,
        `${lane.script}: RUN_MINUTES=${runM} + ${reserve}m reserve + ${verify}m verify + `
          + `${STARTUP_MINUTES}m startup + ${EXIT_MINUTES}m EXIT = ${worstCase}m against a `
          + `${CEILING}m ceiling leaves ${margin}m — need >= ${REQUIRED_MARGIN_MINUTES}. `
          + `The exit is not free: flushing a piped stdout and disposing the client is what `
          + `stands between a clean reconcile and the kill that took runs 33975816175, `
          + `33975825863, 33975834391 and 33975840824.`,
      ).toBeGreaterThanOrEqual(REQUIRED_MARGIN_MINUTES);
    });
  }
});

// ── 8. THE EXIT IS UNCONDITIONAL ───────────────────────────────────────────
//
// CF-A-LANE-EXITS-UNCONDITIONALLY (2026-09-05). #1809 made every lane CALL
// finishLane(), and section 5 above pins that it does. Four sharded APPLY
// runs of retire-self-derived-identities dispatched AFTER #1828 merged
// (bf47ba1, 21:30Z) STILL died at the ceiling:
//
//   33993974633  dispatched 21:45Z
//   33994076178  dispatched 21:48Z
//   33994101308  dispatched 21:48Z
//   33994112578  dispatched 21:48Z
//
// Every one of them printed its full reconcile —
//
//   RECONCILE  seen 202,186 … => 202,186 BALANCES
//   [retire-self-derived-identities] reconciled: intended 202,189
//       = written 694 + skipped 201,495
//
// — and every one of them then printed nothing until
//
//   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
//
// So finishLane() WAS reached and the process still did not exit. The call
// being made is not the guarantee; section 5 pins a call, and a call that
// awaits forever is indistinguishable in source from one that returns.
//
// THE MECHANISM. finishLane AWAITED its cleanup — `client.dispose()` and
// `flushStdio()` — before its `process.exit`. Against section 1's fake both
// settle instantly. Against the real @azure/cosmos SDK, with the abandoned
// cross-partition aggregate still in flight, neither need settle at all: the
// dispose tears down an agent whose sockets are mid-request, and the flush
// waits on a `write` callback from a pipe whose reader (`tee`) is not
// draining. The exit line is simply never reached.
//
// THE RULE, RESTATED. Cleanup is best-effort and CAPPED. The exit is
// UNCONDITIONAL. These pins use a fake that is uncooperative in the two ways
// the real SDK was: a `dispose()` that never resolves, and a query that never
// settles while holding a REAL handle.
describe("finishLane exits even when cleanup never finishes", () => {
  const NEVER_RESOLVING_DISPOSE = `
    const net = require("net");
    const srv = net.createServer(() => {});
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      // A live socket, so only an explicit exit can end this process.
      const s = net.connect(port, "127.0.0.1", () => s.write("ping"));
      s.on("error", () => {});
      const client = {
        // THE DEFECT, REPRODUCED: dispose() never resolves. The old finishLane
        // awaited exactly this.
        dispose: () => new Promise(() => {}),
      };
      __BODY__
    });
  `;

  it("a dispose() that never resolves does not strand the lane", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      ${NEVER_RESOLVING_DISPOSE.replace(
        "__BODY__",
        `console.log("[probe] calling finishLane"); await finishLane(0, { client });`,
      )}
    `);
    expect(r.stdout).toContain("[probe] calling finishLane");
    expect(
      r.timedOut,
      "finishLane awaited a dispose that never resolved — the exact shape that killed runs "
        + "33993974633, 33994076178, 33994101308 and 33994112578 AFTER they reconciled clean",
    ).toBe(false);
    expect(r.status).toBe(0);
  });

  it("it exits PROMPTLY — the cleanup cap is short, not the step ceiling", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      ${NEVER_RESOLVING_DISPOSE.replace("__BODY__", `await finishLane(0, { client });`)}
    `);
    expect(r.timedOut).toBe(false);
    // The cap is 5s; a lane that took the runner's 150 minutes to notice its
    // dispose was wedged is the bug, not a slow tidy-up.
    expect(r.ms, `the lane took ${r.ms}ms to exit past a wedged dispose`).toBeLessThan(12000);
  });

  it("carries the non-zero code out even when cleanup is wedged", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      ${NEVER_RESOLVING_DISPOSE.replace("__BODY__", `await finishLane(3, { client });`)}
    `);
    expect(r.timedOut).toBe(false);
    expect(r.status, "a failing lane that cannot exit reports nothing at all").toBe(3);
  });

  it("a dispose that THROWS is not a failed lane either", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        await finishLane(0, { client: { dispose: () => { throw new Error("socket already gone"); } } });
      })();
    `);
    expect(r.timedOut).toBe(false);
    expect(r.status, "cleanup that throws must not fail a run whose writes reconciled").toBe(0);
  });

  // THE OPERATOR'S PROOF. The four runs above are indistinguishable, in their
  // logs, from a lane that exited and a runner that killed it anyway: both
  // end at the reconcile. An explicit exit line is what makes "did it exit?"
  // answerable from the log alone.
  it("prints an explicit exit line, so a log that ends at the reconcile is a KNOWN kill", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        console.log("[retire-self-derived-identities] reconciled: intended 202,189"
          + " = written 694 + skipped 201,495");
        await finishLane(0);
      })();
    `);
    expect(r.stdout).toContain("reconciled: intended 202,189");
    expect(
      r.stdout,
      "the log must SAY the lane exited; without it, a killed step and a clean exit read alike",
    ).toContain("finishLane: exiting code 0");
    expect(r.timedOut).toBe(false);
  });

  it("the exit line survives a wedged dispose — it is written after the cap, not before it", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      ${NEVER_RESOLVING_DISPOSE.replace("__BODY__", `await finishLane(0, { client });`)}
    `);
    expect(r.stdout).toContain("finishLane: exiting code 0");
  });

  // MUTATION. The guarantee is the CAP, not the call: restore the unbounded
  // await and the probe hangs exactly as the four runs did.
  it("MUTATION: await the wedged dispose unbounded and the lane hangs again", () => {
    const r = runNode(
      `
      const net = require("net");
      const srv = net.createServer(() => {});
      srv.listen(0, "127.0.0.1", async () => {
        const port = srv.address().port;
        const s = net.connect(port, "127.0.0.1", () => s.write("ping"));
        s.on("error", () => {});
        const client = { dispose: () => new Promise(() => {}) };
        console.log("[probe] calling the OLD finishLane");
        // The old body: await the cleanup, THEN exit.
        await client.dispose();
        process.exit(0);
      });
    `,
      6000,
    );
    expect(r.stdout).toContain("[probe] calling the OLD finishLane");
    expect(
      r.timedOut,
      "the mutation did NOT hang, so these pins would not have caught the four timed-out runs",
    ).toBe(true);
  });

  it("the helper states the unconditional exit in source", () => {
    const fn = /async function finishLane\([\s\S]*?\n\}/.exec(LIB)?.[0] ?? "";
    // Cleanup runs under a cap...
    expect(fn, "cleanup must be capped, or an await inside it can strand the exit").toMatch(/underExitCap\(/);
    // ...and the exit is NOT inside that cap.
    expect(fn.indexOf("underExitCap(")).toBeLessThan(fn.indexOf("process.exit(code)"));
    const cap = /async function underExitCap\([\s\S]*?\n\}/.exec(LIB)?.[0] ?? "";
    expect(cap, "the cap must race the cleanup, not await it").toMatch(/Promise\.race\(/);
    expect(cap).toMatch(/setTimeout\(/);
  });
});
