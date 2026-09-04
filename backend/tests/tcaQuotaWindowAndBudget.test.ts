// CF-TCA-QUOTA-WINDOW + CF-TCA-RESET-WINDOW-BUDGET (Drew, 2026-09-04).
//
// Two jobs draw on the SAME 200K/day TCA /sales cap, and the schedule had
// them fighting over it: the portfolio priority pull ran at 00:00 UTC with a
// 15-minute budget, so it was still pulling when the firehose's 00:05
// reset-window run started. The firehose's own quota-visibility guard
// (CF-TCA-QUOTA-VISIBILITY) exists to report exactly that shape -- "something
// else is draining the 200K/day cap before this cron runs" -- and the thing
// draining it was us.
//
// The second half: the 00:05 run then stopped on OUR wall clock rather than
// TCA's quota. max_minutes is only ever populated by workflow_dispatch, so
// every cron fell through to the same 12-minute fallback and the reset-window
// run halted with the cursor preserved and the cap nowhere near exhausted. A
// budget must bind on the scarce resource; that one bound on the abundant one.
//
// These pins assert the RELATIONSHIPS, not the literals -- following the
// lesson recorded in freshnessCanaryRowFloor: a number that is supposed to be
// re-tuned must not need a test edit to move. What must never come back is
// the overlap and the wall-clock-bound reset run.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOWS = path.join(__dirname, "..", "..", ".github", "workflows");
const read = (f: string) =>
  fs.readFileSync(path.join(WORKFLOWS, f), "utf8").replace(/\r\n/g, "\n");

const PRIORITY = read("portfolio-priority-pull.yml");
const FIREHOSE = read("tca-firehose-ingest.yml");

/** Every `- cron: '...'` in a workflow, in file order. */
function crons(yml: string): string[] {
  return [...yml.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/** Minutes past midnight UTC for a `M H * * *` cron. */
function minuteOfDay(cron: string): number {
  const [min, hour] = cron.split(/\s+/);
  return Number(hour) * 60 + Number(min);
}

describe("the priority pull and the firehose do not share a quota window", () => {
  it("the priority pull runs on exactly one daily cron", () => {
    expect(crons(PRIORITY)).toHaveLength(1);
  });

  it("the priority pull no longer runs at the 00:00 quota reset", () => {
    // The original slot, and the whole bug: 00:00 + a 15-minute budget
    // overlaps the 00:05 firehose run on a shared cap.
    expect(crons(PRIORITY)[0]).not.toBe("0 0 * * *");
  });

  it("the priority pull finishes well before the firehose's reset-window run", () => {
    // Its wall-clock budget must be spent, and the day's cap must reset,
    // before the firehose opens the fresh budget at 00:05.
    const pull = minuteOfDay(crons(PRIORITY)[0]);
    const budget = Number(
      PRIORITY.match(/max_minutes:[\s\S]*?default:\s*'(\d+)'/)![1],
    );
    const resetWindow = 24 * 60 + 5; // the next day's 00:05 firehose run
    expect(pull).toBeGreaterThan(0);
    expect(pull + budget).toBeLessThan(resetWindow);
    // And a full hour of slack on top, so a slow run cannot creep back in.
    expect(resetWindow - (pull + budget)).toBeGreaterThanOrEqual(60);
  });
});

describe("the firehose's reset-window run is budgeted on quota, not our clock", () => {
  const RESET_CRON = "5 0 * * *";

  it("still runs the reset-window pass plus the platform-lag passes", () => {
    // CF-TCA-PLATFORM-LAG: eBay lands a day behind TCGplayer, so the extra
    // passes re-pull yesterday as each platform publishes. Dropping them
    // would silently lose a platform's day.
    const c = crons(FIREHOSE);
    expect(c).toContain(RESET_CRON);
    expect(c.length).toBeGreaterThanOrEqual(4);
  });

  it("resolves a LARGER budget for the reset-window run than for the others", () => {
    // The mechanism, not the numbers: github.event.schedule tells the crons
    // apart (the pattern promote-staging-pending.yml already uses), so the
    // reset run is not capped at the platform-lag fallback.
    const m = FIREHOSE.match(
      /TOTAL_MIN="\$\{\{ inputs\.max_minutes \|\| \(github\.event\.schedule == '([^']+)' && '(\d+)' \|\| '(\d+)'\) \}\}"/,
    );
    expect(m, "the ingest budget must be resolved per-schedule").not.toBeNull();
    const [, cron, resetBudget, otherBudget] = m!;
    expect(cron).toBe(RESET_CRON);
    expect(Number(resetBudget)).toBeGreaterThan(Number(otherBudget));
    // The point of the change: the reset run gets a materially bigger window.
    expect(Number(resetBudget)).toBeGreaterThanOrEqual(40);
  });

  it("the match-enricher tracks the ingest budget", () => {
    // A 40-minute pull lands far more unmatched rows than a 12-minute one.
    // An enricher still stopping at 12 leaves them __pendingMatch for a day.
    const m = FIREHOSE.match(
      /MAX_MINUTES="\$\{\{ inputs\.max_minutes \|\| \(github\.event\.schedule == '([^']+)' && '(\d+)' \|\| '(\d+)'\) \}\}"/,
    );
    expect(m, "the enricher budget must be resolved per-schedule").not.toBeNull();
    expect(m![1]).toBe(RESET_CRON);
    expect(Number(m![2])).toBeGreaterThan(Number(m![3]));
  });

  it("every job ceiling clears the largest budget it can resolve", () => {
    // A timeout-minutes below MAX_MINUTES means the runner kills the job
    // mid-page, and the cursor advance is the one thing we lose.
    const budgets = [
      ...FIREHOSE.matchAll(/(?:TOTAL_MIN|MAX_MINUTES)="\$\{\{ inputs\.max_minutes \|\| \(github\.event\.schedule == '[^']+' && '(\d+)' \|\| '(\d+)'\) \}\}"/g),
    ].flatMap((m) => [Number(m[1]), Number(m[2])]);
    expect(budgets.length).toBeGreaterThan(0);
    const maxBudget = Math.max(...budgets);

    const timeouts = [...FIREHOSE.matchAll(/^\s*timeout-minutes:\s*(\d+)/gm)].map(
      (m) => Number(m[1]),
    );
    expect(timeouts).toHaveLength(2); // ingest + match-enricher
    for (const t of timeouts) expect(t).toBeGreaterThanOrEqual(maxBudget + 5);
  });

  it("keeps the cron APPLY guard and the quota-visibility gate intact", () => {
    // Raising a budget must not quietly drop the guards that make a green
    // run mean a real write. CF-INGEST-CRON-GUARD + CF-TCA-QUOTA-VISIBILITY.
    expect(FIREHOSE).toMatch(/Assert APPLY=true on scheduled runs/);
    expect(FIREHOSE).toMatch(/refusing to burn TCA quota on dry-run/);
    expect(FIREHOSE).toMatch(/PLATFORMS_OK/);
    expect(FIREHOSE).toMatch(/x-ratelimit-remaining/);
    expect(FIREHOSE).toMatch(/Build backend \(dist\/ for enricher requires\)/);
  });
});
