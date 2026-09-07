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

  // ── THE CAP MUST BE ARMED BEFORE run() IS CALLED (2026-09-07) ────────────
  //
  // CF-A-CAP-YOU-ARM-SECOND-IS-NOT-ARMED. `capped()` used to build its race as
  //
  //     Promise.race([ run(ac.signal), new Promise((_,rej) => { timer = ... }) ])
  //
  // and array elements evaluate LEFT TO RIGHT. So `run(ac.signal)` was CALLED
  // first, and an async function body runs synchronously until its first
  // `await` — everything run() did before suspending happened while the cap
  // timer DID NOT YET EXIST. A callee that never reaches a suspension point
  // never arms the cap at all, and the lane goes silent with no line to say so.
  //
  // The two assertions below are different claims and both matter:
  //
  //   1. the cap NARRATES (it was armed) — this is what the fix guarantees;
  //   2. the process still EXITS.
  //
  // What is deliberately NOT asserted is that the cap fires ON TIME. A callee
  // that blocks the event loop also blocks the timer callback, and no timer in
  // node can pre-empt synchronous work; the measured behaviour is that the 8s
  // prologue under a 3s cap now narrates but still returns at ~8s. Pinning a
  // deadline here would pin a lie.
  it("a run() that blocks synchronously before its first await still gets a cap line", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 300 });
        // The prologue spins PAST the cap before the callee ever suspends,
        // then never settles. Under the old ordering the timer for this call
        // was constructed only after the spin, so the cap could not fire
        // during it — and with the callee never settling afterwards, the race
        // never resolved and nothing was ever printed.
        const v = await b.capped(Date.now(), "sync-prologue", async () => {
          const end = Date.now() + 1500;
          while (Date.now() < end) { /* the window the cap must already cover */ }
          await new Promise(() => {});
        });
        console.log("[probe] v=" + v + " capFired=" + b.capFired());
        await finishLane(0);
      })();
    `);
    expect(
      r.stdout,
      "a callee that blocks and then never settles produced no cap line at all",
    ).toContain("could not confirm within the cap");
    expect(r.stdout).toContain("[probe] v=null capFired=true");
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
  });

  // MUTATION, and it took a wrong first cut to find the honest one. A callee
  // that spins and THEN awaits still gets a line out of the old ordering: the
  // spin ends, run() suspends, the timer is finally constructed with a
  // `remaining` that has already elapsed, and it fires on the next turn
  // (measured: 1,888ms under a 300ms cap — late, but printed). So a delayed
  // cap is NOT what the old ordering loses.
  //
  // What it loses is the cap ENTIRELY, whenever the callee never reaches a
  // suspension point: no await, no yield, no second race element, no timer.
  // The helper's own `capped()` cannot be handed such a callee in a way this
  // suite can survive — a spin with no exit would wedge the probe forever
  // either way — so the mutation pins the ORDERING ITSELF: with the timer
  // armed second, `timer` is still null while run() executes, and with it
  // armed first it is not. That is the exact property the fix establishes.
  it("MUTATION: with the timer armed second, the cap does not exist while run() runs", () => {
    const r = runNode(`
      (async () => {
        // THE OLD ORDERING. run() is the first race element, so it is invoked
        // before the second element constructs the timer.
        let armedDuringRun = null;
        const cappedOldOrder = async (verifyMs, run) => {
          let timer = null;
          try {
            return await Promise.race([
              run(() => { armedDuringRun = timer !== null; }),  // <- called FIRST
              new Promise((_res, rej) => {                      // <- armed SECOND
                timer = setTimeout(() => rej(new Error("verify-cap")), verifyMs);
              }),
            ]);
          } catch (e) { return null; }
          finally { if (timer) clearTimeout(timer); }
        };
        await cappedOldOrder(300, async (observe) => {
          observe();               // what is armed at the top of run()?
          return 1;
        });
        console.log("[probe] oldOrder armedDuringRun=" + armedDuringRun);

        // THE FIXED ORDERING, same shape, timer first.
        let armedDuringRun2 = null;
        const cappedArmFirst = async (verifyMs, run) => {
          let timer = null;
          try {
            const cap = new Promise((_res, rej) => {
              timer = setTimeout(() => rej(new Error("verify-cap")), verifyMs);
            });
            cap.catch(() => {});
            return await Promise.race([run(() => { armedDuringRun2 = timer !== null; }), cap]);
          } catch (e) { return null; }
          finally { if (timer) clearTimeout(timer); }
        };
        await cappedArmFirst(300, async (observe) => { observe(); return 1; });
        console.log("[probe] armFirst armedDuringRun=" + armedDuringRun2);
      })();
    `, 10000);
    expect(
      r.stdout,
      "the old ordering already had its cap armed when run() started — then the "
        + "reordering fixes nothing and this pin is pinning noise",
    ).toContain("[probe] oldOrder armedDuringRun=false");
    expect(
      r.stdout,
      "arming first did not actually arm the timer before run() — the fix does not "
        + "do what it claims",
    ).toContain("[probe] armFirst armedDuringRun=true");
    expect(r.timedOut).toBe(false);
  });

  // And the property, asserted against the REAL helper rather than a replica:
  // the source must construct its cap promise before it calls run().
  it("the shipped capped() constructs its cap BEFORE it invokes run()", () => {
    const fn = LIB.slice(LIB.indexOf("const capped = async (vt0, label, run)"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    // COMMENTS ARE STRIPPED FIRST, and finding out why cost a red run. This
    // block is heavily commented, and those comments QUOTE the very code they
    // explain ("`Promise.race([run(ac.signal), ...])`"). A naive indexOf found
    // the prose mention hundreds of characters before the real call and the pin
    // failed against a correctly-ordered file. A pin that reads comments is not
    // reading the program.
    const code = body
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .filter((l) => !/^\s*\*/.test(l))
      .join("\n");
    const armed = code.indexOf("timer = setTimeout(");
    const called = code.indexOf("run(ac.signal)");
    expect(armed, "capped() no longer arms a cap timer at all").toBeGreaterThan(-1);
    expect(called, "capped() no longer invokes run(ac.signal)").toBeGreaterThan(-1);
    expect(
      armed,
      "run(ac.signal) is invoked before the cap timer is armed — a synchronous "
        + "prologue in the callee runs with no cap in existence",
    ).toBeLessThan(called);
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

// ── 9. NO LANE KEEPS A PRIVATE COPY OF THE CAP ─────────────────────────────
//
// CF-ONE-CAP-NOT-A-COPY-OF-IT (2026-09-06). Four more sharded APPLY runs of
// retire-self-derived-identities — slots 9-12 of 16, baseball, dispatched
// 01:45Z from main, LONG after #1809, #1828 and #1844 had all merged:
//
//   34004719519 slot  9   work done in 320s   last line 01:52:13   killed 04:16:50
//   34004725658 slot 10   work done in 606s   last line 01:56:55   killed 04:16:46
//   34004731758 slot 11   work done in  84s   last line 01:48:17   killed 04:16:54
//   34004737931 slot 12   work done in 735s   last line 01:59:30   killed 04:17:12
//
// Each printed its banner, its `RECONCILE ... BALANCES` and its
// `reconciled: intended ... = written ... + skipped ...`, and then NOTHING
// until the 150-minute kill. And once again — the tell — not one printed a
// `VERIFY BY READ` line.
//
// Slot 11 is the whole argument in one row: it finished every product it owned
// in EIGHTY-FOUR SECONDS and still cost the fleet two and a half hours of a
// runner, then reported a red step for work that was complete and durable.
//
// WHY EVERY PIN ABOVE PASSED WHILE THE LANE HUNG. Sections 5-8 ask two things
// of a lane's SOURCE: that it calls finishLane(), and that it imports it from
// this helper. retire-self-derived-identities did both, and had since #1809.
// Everything else above tests the HELPER — including the one assertion that
// names this exact defect, "the cap timer is REF'd, so the cap can never be
// lost to an early exit". That assertion read runner-budget.cjs. The lane was
// not running runner-budget.cjs's cap. It had its own, fifty lines from the
// bottom of main(), and that copy did the one thing the helper's is pinned not
// to do:
//
//     timer = setTimeout(() => rej(new Error("verify-cap")), left);
//     if (timer.unref) timer.unref();          // <- the defect
//
// With the cap unref'd AND retry()'s backoff sleeps unref'd (correct on their
// own — a retry nobody awaits must not hold the process), NOTHING the lane
// owned was ref'd. An unref'd timer cannot hold the loop open, and it also
// cannot be relied on to fire: the cap never rejected, the race never settled,
// main() never resolved, and the unconditional exit section 8 guarantees was
// never REACHED. A guarantee about what happens inside finishLane() cannot
// help a lane that never gets there.
//
// What kept the process ALIVE for those 144 minutes was the other half: the
// abandoned cross-partition request's sockets, which belong to the SDK and ARE
// ref'd. So the two halves conspire — the SDK's handles keep node running, and
// the lane's unref'd cap never fires to end the verify. Section 10 below
// isolates the lane's half and shows the signature it produces on its own.
//
// So the census below stops asking only "does the lane call the helper" and
// starts asking "is the helper the ONLY cap in the lane". A private
// Promise.race-plus-setTimeout verify cap is now a red build wherever it is
// written, because the helper's version is pinned correct and a copy of it is
// not pinned at all.
describe("the verify cap lives in the helper, and lanes do not re-implement it", () => {
  /** A lane's own `capped`/verify race: the shape that is now forbidden. */
  const PRIVATE_CAP = /const\s+capped\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s{0,6}\};/;

  /** Source with comments removed. These lanes DOCUMENT the defect they were
   *  fixed for — retire-self-derived-identities quotes the unrefd cap line
   *  verbatim in its header, as the explanation of what went wrong — and a
   *  census that cannot tell a description of a bug from the bug itself fails
   *  on its own documentation. */
  const codeOf = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  for (const lane of LANES) {
    it(`${lane.script} does not hand-roll its own verify cap`, () => {
      const m = PRIVATE_CAP.exec(codeOf(lane.src));
      if (!m) return; // no local capped at all — nothing to re-implement
      // A local `capped` is allowed ONLY as a thin delegation to the helper's.
      expect(
        /\.capped\(/.test(m[0]),
        `${lane.script} defines its own capped() that does not delegate to the helper's `
          + `budget().capped(). The helper's cap is pinned REF'd; a private copy is pinned `
          + `nothing, and the copy in this lane unrefd its timer — which is why runs `
          + `34004719519, 34004725658, 34004731758 and 34004737931 went silent from a `
          + `balanced reconcile straight to the 150-minute kill without ever printing a `
          + `VERIFY BY READ line.`,
      ).toBe(true);
    });

    it(`${lane.script} never unrefs a verify-cap timer`, () => {
      // The precise defect, wherever it is spelled. An unrefd cap in a
      // process whose only other timers are unrefd retry sleeps means node
      // deschedules everything and the cap NEVER FIRES — silence, which is the
      // one outcome this whole file exists to make impossible.
      const race = /Promise\.race\(\[[\s\S]{0,900}?\]\)/g;
      for (const blk of codeOf(lane.src).match(race) ?? []) {
        if (!/verify-cap/.test(blk)) continue;
        expect(
          /unref\(\)/.test(blk),
          `${lane.script} unrefs the timer that enforces its verify cap. An unrefd cap is `
            + `not a cap: node exits before it fires, or — when nothing else is refd — `
            + `stops scheduling and it never fires at all. Use budget().capped(), whose `
            + `timer is REFd and released by clearTimeout in a finally.`,
        ).toBe(false);
      }
    });
  }

  it("the lane that hung now routes its cap through the helper", () => {
    // Named explicitly, because a regex census that silently matched nothing
    // would be a green build that pins nothing at all.
    const src = read("backend", "scripts", "retire-self-derived-identities.cjs");
    expect(src, "the lane must take its clock from the helper").toMatch(/budget\(\{/);
    expect(src, "and its cap from the same object").toMatch(/\.capped\(/);
    expect(
      /timer\.unref\(\)/.test(codeOf(src)),
      "the unrefd cap timer that caused the 144-minute silence must not come back",
    ).toBe(false);
  });
});

// ── 10. THE MUTATION TEST FOR SECTION 9 ────────────────────────────────────
//
// Section 9 is a source census, and a census that cannot fail is decoration.
// This drives the ACTUAL defect — an unrefd cap racing a query that never
// settles, in a process whose only other timers are unrefd — and proves it
// produces exactly the slot-9 signature: the reconcile prints, the VERIFY line
// does NOT, and the process never exits on its own.
describe("the unrefd cap really is the hang (mutation)", () => {
  const LANE_SHAPE = (unref: boolean) => `
    (async () => {
      // THE CONDITION THAT MATTERS. The real lane reaches its verify with no
      // ref'd handle of its own: the Cosmos request is in flight but its
      // sockets are the SDK's, and retry()'s backoff sleeps are unref'd. So
      // this probe deliberately holds NOTHING ref'd except whatever the cap
      // itself refs. That is the whole experiment: with the cap ref'd, node
      // stays alive long enough to fire it and report; with the cap unref'd,
      // node has no reason to keep scheduling and the cap never fires at all.
      // retry()'s backoff sleeps are unrefd in the real lane, and correctly so.
      const retry = async (fn, tries, signal) => {
        let wait = 50;
        for (let a = 0; ; a++) {
          if (signal && signal.aborted) throw new Error("verify-cap");
          try { return await fn(); } catch (e) {
            if (signal && signal.aborted) throw new Error("verify-cap");
            if (a >= tries) throw e;
            await new Promise((r) => { const t = setTimeout(r, wait); t.unref(); });
          }
        }
      };
      const capped = async (label) => {
        let timer = null;
        const ac = new AbortController();
        try {
          await Promise.race([
            retry(() => new Promise(() => {}), 2, ac.signal),
            new Promise((_, rej) => {
              timer = setTimeout(() => rej(new Error("verify-cap")), 800);
              ${unref ? "if (timer.unref) timer.unref();" : ""}
            }),
          ]);
        } catch (e) {
          console.log("  VERIFY BY READ " + label + ": could not confirm (" + e.message + ")");
          return null;
        } finally { if (timer) clearTimeout(timer); ac.abort(); }
      };
      console.log("[retire-self-derived-identities] reconciled: intended 74,810"
        + " = written 1 + skipped 74,809");
      await capped("retiredReason");
      console.log("main() resolved");
    })();
  `;

  // WHAT THE TWO CASES PROVE, AND WHY THE UNREF'D ONE DOES NOT ITSELF HANG.
  // Stripped to its essentials the defect is not "the process blocks", it is
  // "the cap never fires and main() never resolves". In this probe, where the
  // pending request holds nothing at all, node simply runs out of ref'd work
  // and exits 0 — silently, mid-verify, having printed no VERIFY line and
  // never reaching the code after `await capped(...)`. In the real lane the
  // Cosmos SDK's in-flight sockets ARE ref'd, so instead of exiting early the
  // process sits on them; either way the cap that was supposed to end the
  // verify never fires and finishLane() is never reached. The observable
  // signature is the same one slots 9-12 wrote into their logs, and it is what
  // this pair asserts: reconcile printed, VERIFY line absent, main() never
  // resolved.
  it("UNREFD: the reconcile prints, the VERIFY line never does, main() never resolves", () => {
    const r = runNode(LANE_SHAPE(true), 6000);
    expect(r.stdout).toContain("reconciled: intended 74,810");
    expect(
      r.stdout,
      "slot 9's signature exactly: no VERIFY BY READ line was ever printed",
    ).not.toContain("VERIFY BY READ");
    expect(
      r.stdout,
      "the verify never completed, so nothing after it ran — in CI, with the SDK's ref'd "
        + "sockets in flight, this is the 144 minutes of silence instead of an early exit",
    ).not.toContain("main() resolved");
  });

  it("REFD: the cap fires, the VERIFY line prints, the lane finishes", () => {
    const r = runNode(LANE_SHAPE(false), 6000);
    expect(r.stdout).toContain("reconciled: intended 74,810");
    expect(r.stdout, "a cap that can fire always reports").toContain("VERIFY BY READ");
    expect(r.stdout, "and the lane goes on to its exit").toContain("main() resolved");
    expect(r.timedOut).toBe(false);
  });
});

// ── 11. A DATA CHANNEL IS NOT A LOG ────────────────────────────────────────
//
// CF-A-DATA-CHANNEL-IS-NOT-A-LOG (#1846).
//
// The nightly acquire-for-withheld-holdings, run 34019169292 (07:26Z, cron
// 20 7, on main). Its read-only plan step did everything right: it walked 131
// holdings across 12 portfolio docs, found 13 withheld on identity grounds,
// built 15 acquisition cells and printed
//
//   RECONCILED  YES  cells=15 matched=11 needs-source=2 unreadable=2 tonight=10
//
// to STDERR, because in MODE=json this lane routes every human line through
// `note()` precisely so stdout stays one parseable document. The workflow step
// even carries the comment saying so. And the next step died anyway:
//
//   jq: parse error: Invalid literal at line 739, column 11
//   ##[error]Process completed with exit code 5
//
// Line 739 of the captured stdout was not a truncated write, not a partial
// document and not a stray console.log in the lane. The uploaded artifact
// proves it: the JSON closed cleanly with `}` on line 738, and line 739 was
//
//   finishLane: exiting code 0
//
// — THIS FILE'S OWN operator proof, written by the shared helper to fd 1,
// unconditionally, after main() had returned. Nothing the lane could do
// suppressed it. The pipeline stopped before ingest: nothing was written, no
// dispatch was made, ten matched cells went unacquired.
//
// WHY THE FIX IS NOT "SEND IT TO STDERR". Section 8's proof exists because the
// runner reads a lane as `node <script>.cjs | tee /tmp/backfill.log` — stdout
// only. Moving the line to stderr for every lane would keep it on the
// operator's screen and delete it from the artifact the gates and the
// post-mortems read, re-creating the silence #1809 exists to prevent.
//
// So the destination is the LANE'S to declare, and the DEFAULT DOES NOT MOVE.
// Both pins below are needed: one alone would be satisfied by a fix that
// breaks the other.
describe("finishLane narrates to the fd the lane names, and stdout stays the default", () => {
  it("MODE=json output parses: the exit line is not appended to the document", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        // Exactly the lane's shape: the document, then the helper's exit.
        process.stdout.write(JSON.stringify({ tonight: [1, 2, 3], counts: { matched: 11 } }, null, 2) + "\\n");
        await finishLane(0, { narrateTo: "stderr" });
      })();
    `);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);

    // THE ASSERTION THE WORKFLOW ACTUALLY MAKES. `jq` is not on this box, but
    // JSON.parse rejects the identical trailing-literal input — this is the
    // step that went red, reproduced.
    let parsed: { tonight: number[] } | null = null;
    expect(
      () => { parsed = JSON.parse(r.stdout) as { tonight: number[] }; },
      "stdout must be ONE parseable document; run 34019169292 died on `jq: parse error: "
        + "Invalid literal at line 739, column 11`, which was the exit line",
    ).not.toThrow();
    expect(parsed!.tonight).toHaveLength(3);

    // And the proof is not LOST — it moved, it did not vanish. A fix that
    // deletes the line to make the parse pass fails here.
    expect(
      r.stderr,
      "the operator's proof must still be written, on the other fd",
    ).toContain("finishLane: exiting code 0");
  });

  it("the DEFAULT is still stdout — the runner tees stdout, so the proof must land there", () => {
    const r = runNode(`
      ${LIB_REQUIRE}
      (async () => {
        console.log("reconciled: intended 202,189 = written 694 + skipped 201,495");
        await finishLane(0);
      })();
    `);
    expect(r.timedOut).toBe(false);
    expect(
      r.stdout,
      "`| tee /tmp/backfill.log` captures STDOUT; a blanket move to stderr deletes the "
        + "proof from every gate's log and re-opens #1809",
    ).toContain("finishLane: exiting code 0");
    expect(r.stderr).not.toContain("finishLane: exiting code 0");
  });

  it("the verify-cap notice follows the same fd — it would break the parse too", () => {
    // The other line finishLane writes. It was a console.log, i.e. fd 1
    // regardless of what the lane asked for, so a capped verify in a json run
    // would have broken the document the same way the exit line did.
    const r = runNode(`
      ${LIB_REQUIRE}
      // The lane declares the fd ONCE and both helpers take it. budget() needs
      // it too: its VERIFY BY READ line is printed from inside capped(), long
      // before finishLane is reached, so it lands ABOVE the document.
      const b = budget({ minutes: 1, reserveMs: 1000, verifyMs: 1, narrateTo: "stderr" });
      (async () => {
        // Force the cap to fire: a verify t0 already past the cap.
        await b.capped(Date.now() - 60_000, "rows", async () => 1);
        process.stdout.write(JSON.stringify({ tonight: [] }, null, 2) + "\\n");
        await finishLane(0, { budget: b, narrateTo: "stderr" });
      })();
    `);
    expect(r.timedOut).toBe(false);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain("VERIFY BY READ");
    expect(r.stderr).toContain("the verify cap fired");
  });

  // MUTATION. Hard-code fd 1 back into the helper's narration and the json
  // document stops parsing — the exact failure of run 34019169292.
  it("MUTATION: narrate to fd 1 regardless of the lane, and the document is unparseable again", () => {
    const r = runNode(`
      const fs = require("node:fs");
      (async () => {
        process.stdout.write(JSON.stringify({ tonight: [1, 2, 3] }, null, 2) + "\\n");
        // The OLD body: fd 1, whatever the lane asked for.
        fs.writeSync(1, "finishLane: exiting code 0\\n");
        process.exit(0);
      })();
    `);
    expect(
      () => JSON.parse(r.stdout),
      "the mutation did NOT break the parse, so this pin would not have caught run 34019169292",
    ).toThrow();
  });

  // The lane must actually USE it. A helper that can narrate to stderr and a
  // lane that never asks it to is the same red run tomorrow night.
  it("acquire-for-withheld-holdings declares stderr in MODE=json", () => {
    const src = fs.readFileSync(
      path.join(BACKEND, "scripts", "acquire-for-withheld-holdings.cjs"),
      "utf8",
    );
    expect(src, "the lane must name the fd").toMatch(/narrateTo/);
    expect(src, "and it must pick stderr from the json mode it already computes")
      .toMatch(/JSON_MODE\s*\?\s*"stderr"\s*:\s*"stdout"/);

    // BOTH tails — the success path and the FATAL path. A fatal in json mode
    // corrupts the document just as thoroughly, and the workflow's `jq` cannot
    // tell a crashed lane from a polluted one: it just says parse error.
    //
    // Sliced from each call site to the end of its line rather than matched
    // with a brace regex: the success tail spreads `{ ...(ctx || {}) }`, and a
    // `[^}]*` stops dead at the inner brace.
    const tails = [...src.matchAll(/finishLane\([01],/g)].map((m) =>
      src.slice(m.index!, src.indexOf("\n", m.index!)));
    expect(tails.length, "both the success and the failure tail call finishLane").toBe(2);
    for (const t of tails) expect(t, `${t} must carry narrateTo`).toMatch(/narrateTo/);

    // And the budget's own cap lines take the same fd.
    expect(src, "budget() narrates too — its VERIFY BY READ line is on the same stream")
      .toMatch(/budget\(\{[\s\S]{0,900}?narrateTo/);
  });

  // The workflow reads the FILE the lane wrote, not the stdout capture. Belt
  // and braces: even a future stray print cannot break the plan step.
  it("the workflow parses the plan FILE, not the stdout capture", () => {
    const wf = fs.readFileSync(
      path.join(BACKEND, "..", ".github", "workflows", "acquire-for-withheld-holdings.yml"),
      "utf8",
    );
    expect(wf, "OUT= is the lane's verified file and the step must read it")
      .toMatch(/cp\s+\/tmp\/acquisition-plan\.json\s+\/tmp\/plan\.json/);
    expect(
      wf,
      "the raw stdout redirect is what made a log line a parse error",
    ).not.toMatch(/acquire-for-withheld-holdings\.cjs\s*>\s*\/tmp\/plan\.json/);
  });
});

// ── 12. THE VERIFY READS ITS OWN LEDGER, AND THE CAP ENDS THE LANE ───────
//
// CF-VERIFY-THE-WRITE-BY-READING-IT-BACK (2026-09-07).
//
// The diagnostic run 34059648410 (retire-self-derived-identities, slot 13/16,
// baseball, APPLY) is the one that finally located the wedge, because #1906
// had narrated both sides of the boundary:
//
//   21:02:38  RECONCILE  seen 52,815 = ... => 52,815 BALANCES
//   21:02:38  narrate: reportWrites returned — arming the verify, 600s cap
//   21:02:38  narrate: issuing COUNT(1) for retiredReason (sport=baseball)
//   23:30:45  ##[error] ... timed out after 150 minutes
//
// 148 minutes inside ONE `SELECT VALUE COUNT(1)`, under a 600-second cap that
// never fired. All TEN apply runs of this lane on record died in that query,
// every one of them AFTER its writes had landed and reconciled.
//
// WHY THE CAP DID NOT FIRE, which is the part that generalises. The helper's
// cap timer is REF'd and armed before run() (#1859, #1904) and it fires
// correctly against a never-settling promise. What no `setTimeout` in node
// can survive is MICROTASK STARVATION: a callee that loops on already-resolved
// promises never yields to the macrotask queue, so the timer is scheduled and
// never runs. Section 12b drives exactly that and asserts it.
//
// So the fix is not a bigger cap — it is a verify that cannot starve. A run
// holds its own write ledger, so it reads back the ids IT wrote, by
// point-read, single-partition, no cross-partition fan-out at all.
describe("the retire lane verifies by reading its own write ledger", () => {
  const src = read("backend", "scripts", "retire-self-derived-identities.cjs");
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("the sport-wide COUNT(1) that killed all ten apply runs is gone", () => {
    expect(
      codeOnly,
      "a cross-partition SELECT VALUE COUNT(1) over card_catalog does not return; "
        + "it is what ran 148 minutes in run 34059648410 and 887s in run 33960686247",
    ).not.toMatch(/SELECT VALUE COUNT\(1\)/);
  });

  it("it keeps a ledger of the ids it wrote, with their partition keys", () => {
    expect(codeOnly, "the ledger is declared").toMatch(/const ledger = \[\]/);
    // Every write site records: the two markers are written by different
    // branches, and a ledger missing one would report a real write as absent.
    const pushes = codeOnly.match(/ledger\.push\(/g) ?? [];
    expect(
      pushes.length,
      "all three write sites (parent retire, graded child, unverified) must record",
    ).toBe(3);
    // The partition key travels with the id: a point-read needs both.
    expect(codeOnly).toMatch(/ledger\.push\(\{ id: String\([^)]+\), pk: pkOf\([^)]+\), field:/);
  });

  it("the ledger's partition key MIRRORS the one the write used", () => {
    // patchCatalogRowFields computes `cardId ? String(cardId) : id`. A ledger
    // that recorded a raw null cardId would point-read the wrong partition,
    // get nothing, and report a good write as MISSING THE MARKER -- and since
    // a mismatch now ends the lane non-zero, that would turn a healthy run
    // red. Read exactly where the write went.
    expect(codeOnly).toMatch(/const pkOf = \(row\) =>[\s\S]{0,160}row\.cardId \? String\(row\.cardId\) : String\(row && row\.id\)/);
    const svc = read("backend", "src", "services", "catalog", "catalogRowOps.service.ts");
    expect(
      svc,
      "the rule being mirrored must still be the rule patchCatalogRowFields applies",
    ).toMatch(/const pk = cardId \? String\(cardId\) : id;/);
    // And no write site may go back to handing the raw field through.
    expect(codeOnly).not.toMatch(/pk: \w+\.cardId/);
  });

  it("the verify point-reads those ids instead of scanning the sport", () => {
    // container.item(id, pk).read() is a single-partition lookup at ~1 RU.
    expect(codeOnly, "the read-back is a point-read").toMatch(/cat\.item\(e\.id, e\.pk\)\.read\(\)/);
    // And it is still under the helper's cap, chunked so one cap covers it.
    expect(codeOnly).toMatch(/LANE_BUDGET\.capped\(vt0/);
  });

  it("an empty ledger is a no-op that SAYS it verified nothing", () => {
    // Nine of the ten killed runs wrote 0-21 rows, because an earlier run had
    // already marked their products. `written 0` must not read as a skipped
    // or failed verify.
    expect(src).toMatch(/written 0 — nothing to verify, the ledger is empty/);
    expect(codeOnly).toMatch(/if \(ledger\.length === 0\)/);
  });

  it("it reports verified n of n written, and reconciles that arithmetic", () => {
    expect(src).toMatch(/verified \$\{f\(verified\)\} of \$\{f\(ledger\.length\)\} written/);
    expect(src, "the verify reconciles like the loop does").toMatch(/VERIFY RECONCILE/);
    expect(src).toMatch(/DOES NOT BALANCE/);
  });

  it("an incomplete verify ends the lane non-zero and prints NO budget marker", () => {
    // THE CONTRACT WITH #1913. The relaunch step has three branches:
    //   (a) budget marker  -> re-dispatch
    //   (b) finishLane + green -> finished
    //   (c) neither -> KILLED, re-dispatch withheld, investigate
    // A verify that could not confirm must land in (c), never (a): the marker
    // is a promise that this slice's work is durable, and an unverified slice
    // cannot make it.
    expect(src, "it names what it could not confirm").toMatch(/VERIFY INCOMPLETE —/);
    // Non-zero exit, so the step is red.
    expect(codeOnly).toMatch(/finishLane\(capHit \? 6 : 7/);
    // The marker is DEFERRED past the verify and only emitted on the good path.
    expect(codeOnly, "the marker is a function, called after the verify")
      .toMatch(/const emitBudgetMarker = \(\) =>/);
    const verifyIdx = codeOnly.indexOf("VERIFY INCOMPLETE");
    const emitIdx = codeOnly.lastIndexOf("emitBudgetMarker();");
    expect(
      emitIdx,
      "the budget marker must be emitted AFTER the VERIFY INCOMPLETE early-return, "
        + "or a slice that could not verify still gets re-dispatched",
    ).toBeGreaterThan(verifyIdx);
  });

  it("the marker wording the relaunch greps for is unchanged", () => {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). Moving WHEN it prints must not move
    // WHAT it prints.
    expect(src).toContain("stopped at the clock budget with products left");
  });
});

// ── 12b. MICROTASK STARVATION IS WHY THE CAP NEVER FIRED (MUTATION) ─────
//
// The census in section 9 proved the cap timer is REF'd, and the probe in
// section 10 proved a REF'd cap fires against a never-settling promise. Both
// were true of the shipped code on 2026-09-06, and slot 13 hung anyway. This
// is the missing case: the callee never yields to the macrotask queue, so the
// timer that enforces the cap is scheduled and never runs.
//
// This is not a hypothetical shape. The Cosmos SDK's cross-partition query
// pipeline drains continuations through resolved promises, which is exactly
// this. It is also unfixable by any timer-based cap — which is the argument
// for deleting the query rather than capping it harder.
describe("a starved event loop defeats any setTimeout cap (mutation)", () => {
  const STARVE = `
    ${LIB_REQUIRE}
    const B = budget({ minutes: 1, reserveMs: 1000, verifyMs: 700 });
    (async () => {
      console.log("reconciled: intended 52,815 = written 0 + skipped 52,815");
      const v = await B.capped(Date.now(), "retiredReason", async () => {
        console.log("issuing COUNT(1)");
        // The SDK shape: continuations on already-resolved promises, forever.
        // No await ever reaches the macrotask queue, so no timer can run.
        for (;;) { await Promise.resolve(); }
      });
      console.log("VERIFY BY READ " + v);
      return { budget: B };
    })().then((c) => finishLane(0, c));
  `;

  it("the cap does NOT fire, and the lane never exits — slot 13's signature", () => {
    const r = runNode(STARVE, 6000);
    expect(r.stdout).toContain("issuing COUNT(1)");
    expect(
      r.stdout,
      "run 34059648410 printed `issuing COUNT(1)` and then nothing for 148 minutes",
    ).not.toContain("VERIFY BY READ");
    expect(r.stdout).not.toContain("finishLane: exiting code");
    expect(
      r.timedOut,
      "no setTimeout-based cap can pre-empt a starved loop — which is why the "
        + "COUNT had to be deleted, not capped harder",
    ).toBe(true);
  });

  // And the shipped verify's shape does NOT starve: a point-read loop awaits
  // real I/O, so timers keep running and the cap remains enforceable.
  it("a point-read loop yields, so the cap still fires there", () => {
    const POINT_READS = `
      ${LIB_REQUIRE}
      const B = budget({ minutes: 1, reserveMs: 1000, verifyMs: 700 });
      (async () => {
        const v = await B.capped(Date.now(), "ledger 1-200", async (signal) => {
          // I/O-shaped: each read yields to the macrotask queue, exactly as a
          // Cosmos point-read does. A slow ledger therefore hits the cap
          // instead of hanging the step.
          for (;;) {
            if (signal && signal.aborted) throw new Error("verify-cap");
            await new Promise((r) => setTimeout(r, 5));
          }
        });
        console.log("capped returned " + v);
        return { budget: B };
      })().then((c) => finishLane(0, c));
    `;
    const r = runNode(POINT_READS, 8000);
    expect(r.stdout, "the cap reports rather than hanging").toContain("capped returned null");
    expect(r.stdout).toContain("finishLane: exiting code 0");
    expect(r.timedOut, "the lane ended itself").toBe(false);
  });
});
