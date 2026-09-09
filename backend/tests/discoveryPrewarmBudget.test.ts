// CF-PREWARM-COLD-BUDGET pins (2026-09-09).
//
// The discovery pre-warm died on `curl: (28) Operation timed out after 60002
// milliseconds` on 09-08 and 09-09. Nothing was broken server-side: App
// Insights shows the same endpoint answering 200 in 42.8s (09-07) and 55.0s /
// 57.0s (09-06), then aborting at 59.86s — the request lost to its own budget
// by 140 milliseconds after days of visibly trending into the wall.
//
// Two things made that a hard failure instead of a slow night, and both are
// pinned here because both are one careless edit away from coming back:
//
//   1. THE BUDGET. This job fires immediately after the deploy restart, so
//      the first call of the night pays the entire cold cross-partition scan
//      it exists to pay. A budget near the observed cold cost is not a budget.
//
//   2. THE BLAST RADIUS. The step ran under `set -e` with the curls bare, so
//      the first timeout killed the step and basketball and football were
//      never warmed at all. A pre-warm that abandons five of six caches the
//      moment one is slow is doing the opposite of its job.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOW = path.join(
  __dirname, "..", "..", ".github", "workflows", "discovery-prewarm-nightly.yml",
);
const yml = fs.readFileSync(WORKFLOW, "utf8");

/** The warm step's body — the related-cards step below it has its own,
 *  deliberately smaller budget and must not be read as part of this one. */
function warmStep(): string {
  const start = yml.indexOf("- name: Warm /trending and /trending-players");
  const end = yml.indexOf("- name: Warm /related-cards");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return yml.slice(start, end);
}

/** The budgets curl is actually GIVEN, not every number in the step.
 *  The step documents the old `--max-time 60` in its incident comment, and a
 *  test that read prose as configuration would fail on the very explanation
 *  of the fix — and, worse, would pass if someone reinstated 60 on the real
 *  flag while a comment still said 180. Comment lines are dropped first. */
function warmBudgets(): number[] {
  const code = warmStep()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  return [...code.matchAll(/--max-time (\d+)/g)].map((m) => Number(m[1]));
}

describe("the discovery pre-warm budget", () => {
  it("gives every warm call more than the observed cold-scan cost", () => {
    const budgets = warmBudgets();
    expect(budgets.length).toBeGreaterThan(0);
    // 59.86s was measured on a request that then aborted. Anything at or
    // below 60 reproduces the incident exactly.
    for (const b of budgets) expect(b).toBeGreaterThan(60);
  });

  it("keeps every warm budget under the App Service 240s idle limit", () => {
    // Past 240s App Service cuts the connection with no response at all
    // (ResultCode 0) — the client would then be timing itself against a wall
    // it can never win, which is the shape that kept the cleanliness and
    // prospect crons red.
    const budgets = warmBudgets();
    expect(budgets.length).toBeGreaterThan(0);
    for (const b of budgets) expect(b).toBeLessThan(240);
  });

  it("warms all three sports even when one of them fails", () => {
    const step = warmStep();
    // The failure of a single call must be caught, not fatal...
    expect(step).toMatch(/::warning::.*continuing so the other sports still warm/);
    // ...and the step must still be able to go red when NOTHING warmed,
    // otherwise a fully dead API would report success.
    expect(step).toMatch(/WARMED[\s\S]*-eq 0/);
    expect(step).toMatch(/::error::every discovery warm failed/);
  });

  it("still writes the file the related-cards step reads", () => {
    // related-cards greps slugs out of /tmp/trending-baseball.json. The warm
    // loop was rewritten to iterate paths; if that renamed the output the
    // next step would silently warm nothing.
    expect(warmStep()).toMatch(/-o "\/tmp\/\$path-\$sport\.json"/);
    expect(yml).toContain("/tmp/trending-baseball.json");
  });
});
