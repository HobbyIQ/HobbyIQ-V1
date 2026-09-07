// CF-SCHEDULED-JOBS-CANARY pins (2026-09-07).
//
// The canary exists because the freshness canary reads ROWS and the TCA cron
// was red for two days while the webhook kept rows landing — green canary,
// dead job, nothing noticed. These pins protect the three things that make
// the new canary able to see that: the ENUMERATION (which workflows are
// asked about), the BREACH RULE (what counts as dead), and the EXEMPTION
// LANE (what is allowed to stay red).
//
// The enumeration count is asserted deliberately. Adding or retiring a cron
// workflow should be an act that updates a number in a test, never a silent
// drift in what the canary watches.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const canary = require(path.join(ROOT, "backend", "scripts", "checkScheduledJobsHealth.cjs"));
const {
  hasScheduleTrigger,
  workflowName,
  enumerateCronWorkflows,
  loadExemptions,
  verdictFor,
  parseRunsInput,
  assess,
} = canary;

const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const EXEMPTIONS = path.join(ROOT, "backend", "data", "scheduled-jobs-canary-exemptions.json");

const sched = (n: number, c = "failure") =>
  Array.from({ length: n }, () => ({ conclusion: c, event: "schedule" }));

describe("the enumeration — which workflows the canary watches", () => {
  it("finds a schedule nested in the top-level on: block", () => {
    expect(hasScheduleTrigger("name: x\non:\n  schedule:\n    - cron: '0 * * * *'\n")).toBe(true);
  });

  // The observed case, not a hypothetical: #1954 records two workflows taken
  // off the clock this way (the retired Cardsight crawl, the verdict-flip
  // scaffold). Counting them would alarm forever about jobs nobody wants run.
  it("a COMMENTED-OUT cron is not a schedule", () => {
    const yml = "name: x\non:\n  # schedule removed 2026-08-29 (D13) — see header.\n  workflow_dispatch:\n";
    expect(hasScheduleTrigger(yml)).toBe(false);
  });

  // deal-scanner-canary.yml really does say "schedule x 2" in a comment, and
  // verdict-flip-push-fanout.yml tests `github.event_name != "schedule"` in a
  // step body. A bare grep enumerates both and then reports them unmeasured.
  it("the WORD schedule outside the on: block is not a trigger", () => {
    const inStep = "name: x\non:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: |\n          if [ \"$E\" != \"schedule\" ]; then echo hi; fi\n";
    expect(hasScheduleTrigger(inStep)).toBe(false);
    const inComment = "# heartbeat ceiling is schedule x 2\nname: x\non:\n  workflow_dispatch:\n";
    expect(hasScheduleTrigger(inComment)).toBe(false);
  });

  it("a schedule under a DIFFERENT top-level key is not a trigger", () => {
    const yml = "name: x\non:\n  workflow_dispatch:\njobs:\n  schedule:\n    runs-on: ubuntu-latest\n";
    expect(hasScheduleTrigger(yml)).toBe(false);
  });

  // YAML 1.1 reads a bare `on` as boolean true, so some repos quote the key.
  it("the quoted \"on\": form is the same trigger block", () => {
    expect(hasScheduleTrigger('"on":\n  schedule:\n    - cron: "0 * * * *"\n')).toBe(true);
  });

  it("the single-line on: form carries no schedule", () => {
    expect(hasScheduleTrigger("on: push\n")).toBe(false);
    expect(hasScheduleTrigger("on: [push, pull_request]\n")).toBe(false);
  });

  it("reads the display name, and falls back to the filename", () => {
    expect(workflowName("name: Scheduled Jobs Canary\non:\n", "f.yml")).toBe("Scheduled Jobs Canary");
    expect(workflowName("on:\n  schedule:\n", "f.yml")).toBe("f.yml");
  });

  // THE PIN. Drift here is the failure mode the canary exists to prevent, so
  // it is a number somebody has to change on purpose.
  it("enumerates exactly the cron workflows in the repo", () => {
    const found = enumerateCronWorkflows(WORKFLOW_DIR);
    expect(found).not.toBeNull();
    expect(found.length).toBe(62);
    const files = found.map((f: { file: string }) => f.file);
    // The canary watches itself: a dead canary is worth alarming about.
    expect(files).toContain("scheduled-jobs-canary.yml");
    expect(files).toContain("tca-firehose-ingest.yml");
    expect(files).toContain("era-baselines-refresh.yml");
    // Off the clock, and must stay out.
    expect(files).not.toContain("cardsight-pricing-nightly.yml");
    expect(files).not.toContain("verdict-flip-push-fanout.yml");
    expect(files).not.toContain("sold-comps-content-hash-backfill.yml");
    // A pull_request check is not a cron and can never be enumerated.
    expect(files).not.toContain("regression.yml");
    expect(files).not.toContain("test.yml");
  });

  it("every enumerated file really does contain a schedule key", () => {
    for (const { file } of enumerateCronWorkflows(WORKFLOW_DIR)) {
      const yml = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
      expect(hasScheduleTrigger(yml), file).toBe(true);
    }
  });

  it("an unreadable workflow directory is null, not an empty list", () => {
    expect(enumerateCronWorkflows(path.join(ROOT, "no-such-dir-here"))).toBeNull();
  });
});

describe("the breach rule — what counts as a dead cron", () => {
  it("two consecutive scheduled failures is a breach", () => {
    expect(verdictFor(sched(2), { consecutive: 2 }).status).toBe("breach");
  });

  // A single red is a transient: an upstream 500, a runner hiccup, a 429.
  // Alarming on it trains the reader to mute the canary.
  it("ONE failure is not a breach", () => {
    const runs = [{ conclusion: "failure", event: "schedule" }, { conclusion: "success", event: "schedule" }];
    expect(verdictFor(runs, { consecutive: 2 }).status).toBe("ok");
  });

  it("the boundary: exactly `consecutive` failures fires, one fewer does not", () => {
    expect(verdictFor(sched(3), { consecutive: 3 }).status).toBe("breach");
    const two = [...sched(2), { conclusion: "success", event: "schedule" }];
    expect(verdictFor(two, { consecutive: 3 }).status).toBe("ok");
  });

  // The whole point of the canary. A manual probe says nothing about whether
  // the cron is healthy, and must not be able to mask a dead one.
  it("a green workflow_dispatch between two red crons does NOT break the streak", () => {
    const runs = [
      { conclusion: "failure", event: "schedule" },
      { conclusion: "success", event: "workflow_dispatch" },
      { conclusion: "failure", event: "schedule" },
    ];
    expect(verdictFor(runs, { consecutive: 2 }).status).toBe("breach");
  });

  it("a RED workflow_dispatch cannot manufacture a breach", () => {
    const runs = [
      { conclusion: "failure", event: "workflow_dispatch" },
      { conclusion: "failure", event: "workflow_dispatch" },
      { conclusion: "success", event: "schedule" },
      { conclusion: "success", event: "schedule" },
    ];
    expect(verdictFor(runs, { consecutive: 2 }).status).toBe("ok");
  });

  it("a run still in flight is neither a failure nor a rescue", () => {
    const runs = [
      { conclusion: null, event: "schedule" },
      ...sched(2),
    ];
    // The in-flight run is skipped; the two decided reds below it still breach.
    expect(verdictFor(runs, { consecutive: 2 }).status).toBe("breach");
  });

  it("timed_out is a red — a job that never finished did not do its work", () => {
    const runs = [
      { conclusion: "timed_out", event: "schedule" },
      { conclusion: "failure", event: "schedule" },
    ];
    expect(verdictFor(runs, { consecutive: 2 }).status).toBe("breach");
  });

  // `cancelled` is usually a human or a superseding run; `skipped` is a
  // job-level `if` declining. Neither is the workflow failing.
  it("cancelled and skipped are not failures", () => {
    expect(verdictFor([{ conclusion: "cancelled", event: "schedule" }, { conclusion: "cancelled", event: "schedule" }], { consecutive: 2 }).status).toBe("ok");
    expect(verdictFor([{ conclusion: "skipped", event: "schedule" }, { conclusion: "skipped", event: "schedule" }], { consecutive: 2 }).status).toBe("ok");
  });

  // "Not enough runs to tell" and "healthy" are different answers and must
  // never share a line — a brand-new or weekly cron has shown no pattern yet.
  it("too little history is `insufficient`, never `ok`", () => {
    expect(verdictFor(sched(1), { consecutive: 2 }).status).toBe("insufficient");
    expect(verdictFor([], { consecutive: 2 }).status).toBe("insufficient");
  });
});

describe("the exemption lane — what is allowed to stay red", () => {
  it("the repo's exemption file parses and is the source of the list", () => {
    const ex = loadExemptions(EXEMPTIONS);
    expect(ex).not.toBeNull();
    expect(Array.isArray(ex)).toBe(true);
  });

  // Documented, deliberate, and asserted: the brief named Tier 1 harness and
  // era-baselines, and BOTH were checked and found stale — Tier 1 is a
  // pull_request check (never enumerated), and era-baselines is red on a
  // missing `npm run build`, not the timeout its RESOLVED memory describes.
  // Exempting either would hide a live defect behind a stale reason.
  it("is EMPTY today — no cron is silenced", () => {
    expect(loadExemptions(EXEMPTIONS)).toEqual([]);
  });

  it("an unreadable exemption file is null, so the canary refuses rather than assuming none", () => {
    expect(loadExemptions(path.join(ROOT, "no-such-exemptions.json"))).toBeNull();
    // A malformed one is equally a refusal, not an empty list.
    const bad = path.join(ROOT, "backend", "package.json"); // valid JSON, wrong shape
    expect(loadExemptions(bad)).toBeNull();
  });

  it("an exempt breach is still MEASURED — the alarm is hidden, never the evidence", () => {
    const rows = assess({
      workflows: [{ file: "a.yml", name: "A" }],
      runsByFile: { "a.yml": sched(2) },
      exemptions: [{ workflow: "a.yml", reason: "by design" }],
      consecutive: 2,
    });
    expect(rows[0].status).toBe("breach");
    expect(rows[0].exempt).toBe(true);
  });

  it("a non-exempt breach is a breach", () => {
    const rows = assess({
      workflows: [{ file: "a.yml", name: "A" }],
      runsByFile: { "a.yml": sched(2) },
      exemptions: [],
      consecutive: 2,
    });
    expect(rows[0].status).toBe("breach");
    expect(rows[0].exempt).toBe(false);
  });
});

describe("a workflow with no answer is unmeasured, not healthy", () => {
  it("a missing entry is `unmeasured`", () => {
    const rows = assess({ workflows: [{ file: "a.yml", name: "A" }], runsByFile: {}, exemptions: [], consecutive: 2 });
    expect(rows[0].status).toBe("unmeasured");
  });

  // An empty array is a real answer ("this cron has no scheduled history").
  // A missing key means the query failed. They must not collapse together.
  it("an EMPTY array is a real answer, not a failed query", () => {
    const rows = assess({ workflows: [{ file: "a.yml", name: "A" }], runsByFile: { "a.yml": [] }, exemptions: [], consecutive: 2 });
    expect(rows[0].status).toBe("insufficient");
  });

  it("a payload that is not an object keyed by workflow is a fetch failure", () => {
    expect(parseRunsInput("not json")).toBeNull();
    expect(parseRunsInput("[1,2,3]")).toBeNull();
    expect(parseRunsInput('{"a.yml":[]}')).toEqual({ "a.yml": [] });
  });

  it("every enumerated workflow lands in exactly one bucket", () => {
    const rows = assess({
      workflows: [
        { file: "a.yml", name: "A" },
        { file: "b.yml", name: "B" },
        { file: "c.yml", name: "C" },
        { file: "d.yml", name: "D" },
      ],
      runsByFile: {
        "a.yml": sched(2, "success"),
        "b.yml": sched(2),
        "c.yml": sched(1),
        // d.yml absent -> unmeasured
      },
      exemptions: [],
      consecutive: 2,
    });
    const counts = rows.reduce((m: Record<string, number>, r: { status: string }) => {
      m[r.status] = (m[r.status] || 0) + 1;
      return m;
    }, {});
    expect(counts).toEqual({ ok: 1, breach: 1, insufficient: 1, unmeasured: 1 });
    expect(rows.length).toBe(4);
  });
});

describe("the workflow wiring", () => {
  const yml = fs.readFileSync(path.join(WORKFLOW_DIR, "scheduled-jobs-canary.yml"), "utf8").replace(/\r\n/g, "\n");

  it("runs on a cron, offset from the other six-hourly canaries", () => {
    expect(yml).toMatch(/schedule:\n\s+- cron: '5 \*\/6 \* \* \*'/);
  });

  // ONE parser. The first cut re-implemented hasScheduleTrigger in awk here
  // and the two disagreed immediately — the awk matched nothing, so every
  // workflow would have been reported unmeasured and the canary would have
  // failed with 61 phantom findings on its first run.
  it("the fetch loop enumerates via the script's own --list, not a second parser", () => {
    expect(yml).toContain("node backend/scripts/checkScheduledJobsHealth.cjs --list");
    // No awk INVOCATION. The word survives in the comment explaining why the
    // second parser was removed, and that comment is the point — asserting on
    // the bare word would forbid recording the reason.
    const code = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/[^a-zA-Z]awk /);
  });

  // Server-side, so the per_page window is spent entirely on scheduled runs.
  // A burst of dispatches must not push the crons out of the page.
  it("filters to scheduled runs server-side", () => {
    expect(yml).toContain("runs?event=schedule&per_page=$LOOKBACK");
  });

  // The `>-` hazard from #1954: a folded block yields a truthy string
  // regardless of run state, which would fire the alert on every green run.
  it("the alert condition is a single-line expression, never a folded block", () => {
    expect(yml).toContain("if: ${{ failure() && steps.canary.outcome == 'failure' }}");
    expect(yml).not.toMatch(/if:\s*>-/);
  });

  // github.token only. An Azure outage can take out a dozen crons at once and
  // must not also take out the alert about them.
  it("the alert lane needs no azure/login", () => {
    const alertStep = yml.slice(yml.indexOf("Open or update the scheduled-jobs-red issue"));
    expect(alertStep).toContain("GH_TOKEN: ${{ github.token }}");
    expect(alertStep).not.toContain("azure/login");
  });

  // `gh issue create` fails outright on a label the repo does not carry, so a
  // labelled-only create would file NOTHING in exactly the incident it exists
  // for. Labels are best-effort; the issue is not.
  it("the issue create falls back to unlabelled", () => {
    expect(yml).toMatch(/--label ops --label canary \\\n\s+\|\| gh issue create/);
  });

  // A label filter matching nothing misses every time and files a fresh issue
  // every six hours instead of threading onto the open one.
  it("the dedup lookup matches on title, not on a label filter", () => {
    expect(yml).toContain('--search "$TITLE in:title"');
    expect(yml).not.toMatch(/gh issue list[^\n]*--label/);
  });

  it("reads run history, which needs actions: read", () => {
    expect(yml).toMatch(/permissions:\n(\s+\w+: \w+\n)*\s+actions: read/);
    expect(yml).toMatch(/issues: write/);
  });
});
