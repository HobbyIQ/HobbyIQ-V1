// CF-SCHEDULED-JOBS-CANARY (2026-09-07). The freshness canary reads ROWS.
// The TCA firehose cron was red on EIGHT consecutive scheduled runs
// (2026-09-06T00:59Z → 2026-09-07T18:24Z) and nothing noticed, because the
// live writer for sold_comps is the 30-minute WEBHOOK, not the cron: rows kept
// landing at 20-27k/day, the freshness canary stayed green the whole time, and
// the `match-enricher` job that `needs: ingest` was skipped eight times in
// silence. See backend/docs/reports/2026-09-07-tca-flow-check.md.
//
// A row canary cannot see this. It is measuring the pool, and the pool was
// fine. The thing that broke was a JOB, and the only evidence a job broke is
// its own run history. So this canary reads conclusions, not rows.
//
// WHAT IT ASKS. For every workflow in .github/workflows that carries a
// `schedule:` trigger: did its last two SCHEDULED runs both fail? Two, not
// one — a single red is a transient (an upstream HTTP 500, a runner
// hiccup, a 429) and alarming on it trains the reader to ignore the canary
// before there is anything to protect. Two in a row is a pattern: whatever
// broke is still broken and the next run will not fix it either.
//
// WHY ONLY `schedule` RUNS COUNT. A workflow_dispatch run is somebody
// testing, often deliberately against a broken input, and its conclusion says
// nothing about whether the cron is healthy. Mixing them in means a red
// manual probe can mask a green cron or manufacture a breach that is not one.
// The event filter is applied to the runs BEFORE the last-two window is
// taken, so "last 2 scheduled runs" means exactly that.
//
// WHY THE ENUMERATION IS DERIVED, NOT LISTED. A hand-maintained list of cron
// workflows goes stale the first time somebody adds one, and the workflow it
// misses is invisible in precisely the way this canary exists to prevent. The
// list is computed from the repo on every run. It is also PINNED by a test:
// the count is asserted, so adding or removing a cron workflow is a
// deliberate act that updates a number, never a silent drift.
//
// WHY THE EXEMPTIONS ARE A FILE. Same reason, opposite direction. Silencing
// an alarm is the highest-consequence edit in a canary, so it does not happen
// in this script's source — it happens in
// backend/data/scheduled-jobs-canary-exemptions.json, which carries a reason
// and an exit condition per entry and is reviewed as data. That file is
// EMPTY today, deliberately; see its own $comment for why the two names in
// the original brief (Tier 1 harness, era-baselines timeout) were both
// checked and both found stale.
//
// Env:
//   RUNS_JSON      required. Conclusions per workflow, as JSON, on a path or
//                  on stdin ("-"). The workflow fetches it with `gh api` and
//                  pipes it in. Keeping the fetch OUTSIDE this script is
//                  deliberate and matches checkDealScannerHeartbeat.cjs: no
//                  network here, unit-testable on fixtures, and the query
//                  lives where an operator can re-run it by hand.
//
//                  Shape: { "<workflow file>": [ {conclusion, event, ...}, ... ] }
//                  newest first, as `gh api .../runs` returns them.
//
//   WORKFLOW_DIR   default <repo>/.github/workflows. Overridable for tests.
//   EXEMPTIONS     default backend/data/scheduled-jobs-canary-exemptions.json.
//   CONSECUTIVE    default 2. Consecutive scheduled failures that constitute
//                  a breach. Lowering it to 1 makes every transient an alarm.

const fs = require("node:fs");
const path = require("node:path");
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(REPO_ROOT, ".github", "workflows");
const EXEMPTIONS_PATH =
  process.env.EXEMPTIONS || path.join(REPO_ROOT, "backend", "data", "scheduled-jobs-canary-exemptions.json");
const CONSECUTIVE = numEnv(process.env.CONSECUTIVE, 2);

function numEnv(raw, dflt) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : dflt;
}

/**
 * Does this workflow YAML declare a `schedule:` trigger?
 *
 * Parsed by structure, not by a bare `grep schedule`, because both false
 * answers are real and both are silent:
 *
 *   - A COMMENTED-OUT schedule (`# - cron: ...`) is a workflow somebody
 *     deliberately took off the clock. Counting it would alarm forever on a
 *     job that is not supposed to run — and a canary that cries about a
 *     disabled job is a canary people mute. #1954's own note records two
 *     workflows in exactly this state (the retired Cardsight crawl and the
 *     verdict-flip scaffold), so this is an observed case, not a hypothetical.
 *
 *   - The word "schedule" inside a `name:`, an `if:`, or a step's shell body
 *     is not a trigger. `deal-scanner-canary.yml` says "schedule x 2" in a
 *     comment; a naive match would enumerate workflows that have no cron at
 *     all and then report them as "no runs", which is noise dressed as a
 *     finding.
 *
 * So: find the top-level `on:` block, and look for a `schedule:` key nested
 * directly inside it, on a line that is not a comment.
 */
function hasScheduleTrigger(yml) {
  const lines = String(yml).replace(/\r\n/g, "\n").split("\n");
  let inOn = false;
  let onIndent = 0;
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    if (!inOn) {
      // `on:` at column 0. GitHub also accepts the quoted form `"on":`
      // (YAML 1.1 reads a bare `on` as the boolean true, so some repos quote
      // it); both are the same trigger block and both must be found.
      if (indent === 0 && /^("on"|'on'|on)\s*:/.test(trimmed)) {
        inOn = true;
        onIndent = indent;
        // The single-line forms `on: push` / `on: [push]` carry no schedule
        // and open no block.
        const after = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (after !== "") return false;
      }
      continue;
    }

    // Any other key back at `on:`'s own indent ends the block.
    if (indent <= onIndent) return false;
    if (/^schedule\s*:/.test(trimmed)) return true;
  }
  return false;
}

/** The workflow's display name, which is what `gh run list` and the Actions
 *  UI show. Falls back to the filename so a nameless workflow is still
 *  identifiable rather than blank. */
function workflowName(yml, file) {
  for (const raw of String(yml).replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    const m = /^name\s*:\s*(.+?)\s*$/.exec(raw);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  return file;
}

/**
 * Every workflow file that runs on a cron, sorted so the banner is stable
 * run to run (an unstable order makes two banners impossible to diff).
 */
function enumerateCronWorkflows(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return null;
  }
  const out = [];
  for (const file of files.sort()) {
    let yml;
    try { yml = fs.readFileSync(path.join(dir, file), "utf8"); } catch { continue; }
    if (!hasScheduleTrigger(yml)) continue;
    out.push({ file, name: workflowName(yml, file) });
  }
  return out;
}

/** The exemption list, read from the repo. A missing or malformed file is
 *  NOT treated as "no exemptions" — it is a fetch failure, because silently
 *  running with an empty list would turn an unreadable file into a pile of
 *  alarms and an unreadable file that should have exempted something into a
 *  false alarm. Returns null so main() can exit 2. */
function loadExemptions(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || !Array.isArray(doc.exempt)) return null;
  return doc.exempt.map((e) => (typeof e === "string" ? { workflow: e, reason: "" } : e))
    .filter((e) => e && typeof e.workflow === "string");
}

/**
 * The verdict for one workflow.
 *
 * `runs` arrives newest-first. Scheduled runs are filtered FIRST, then the
 * last `consecutive` of those are examined — so a manual dispatch between two
 * red crons cannot break the streak, and a run still in flight
 * (conclusion null) is not a failure.
 *
 * A workflow with FEWER than `consecutive` scheduled runs cannot breach.
 * That is deliberate: a newly added cron, or one whose cron fires weekly and
 * has only run once in the lookback, has not yet shown a pattern. It is
 * reported as `insufficient` and PRINTED — "not enough runs to tell" is a
 * different answer from "healthy", and the two must never share a line.
 */
function verdictFor(runs, { consecutive }) {
  const scheduled = (runs || []).filter((r) => r && r.event === "schedule");
  // A run with no conclusion is queued or in progress. It is not evidence
  // either way, so it neither breaks a red streak nor counts toward one.
  const decided = scheduled.filter((r) => r.conclusion !== null && r.conclusion !== undefined && r.conclusion !== "");
  const window = decided.slice(0, consecutive);

  if (window.length < consecutive) {
    return {
      status: "insufficient",
      scheduledRuns: decided.length,
      window: window.map((r) => r.conclusion),
      latest: window[0] || null,
    };
  }
  // `failure` is the red this canary is about. `cancelled` is usually a human
  // or a newer run superseding this one, and `skipped` means a job-level `if`
  // declined — neither is the workflow failing, so neither counts toward a
  // breach. `timed_out` DOES: a job that never finishes did not do its work.
  const isRed = (c) => c === "failure" || c === "timed_out";
  const allRed = window.every((r) => isRed(r.conclusion));
  return {
    status: allRed ? "breach" : "ok",
    scheduledRuns: decided.length,
    window: window.map((r) => r.conclusion),
    latest: window[0] || null,
  };
}

function parseRunsInput(raw) {
  let doc;
  try { doc = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  return doc;
}

function readInput() {
  const src = process.env.RUNS_JSON;
  if (!src) return null;
  try {
    return src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
  } catch { return null; }
}

/**
 * Assess every enumerated workflow. Exemptions are applied AFTER the verdict
 * is computed, never before: an exempt workflow that is breaching still has
 * its breach measured and printed, it just does not fail the run. Suppressing
 * the measurement instead of the alarm would make the exemption file a place
 * where evidence disappears.
 */
function assess({ workflows, runsByFile, exemptions, consecutive }) {
  const exemptFiles = new Set(exemptions.map((e) => e.workflow));
  const rows = [];
  for (const w of workflows) {
    const runs = runsByFile[w.file];
    if (runs === undefined) {
      // The query did not answer for this workflow. Not "healthy".
      rows.push({ ...w, status: "unmeasured", scheduledRuns: 0, window: [], exempt: exemptFiles.has(w.file) });
      continue;
    }
    const v = verdictFor(runs, { consecutive });
    rows.push({ ...w, ...v, exempt: exemptFiles.has(w.file) });
  }
  return rows;
}

/**
 * LIST MODE. `--list` prints one cron workflow filename per line and exits.
 *
 * This exists so the workflow's fetch loop and this script's assessment use
 * ONE parser. The first cut of the workflow re-implemented hasScheduleTrigger
 * in awk, and the two disagreed immediately — the awk matched nothing (an
 * `exit 0` inside a rule still runs END, which exited 1 and overrode it), so
 * every workflow would have been queried never, reported `unmeasured`, and
 * the canary would have failed with 61 phantom findings on its first run.
 *
 * Two parsers that must agree forever is a defect waiting for its turn. There
 * is one parser, and the shell asks it.
 */
function runListMode() {
  const workflows = enumerateCronWorkflows(WORKFLOW_DIR);
  if (workflows === null) {
    console.error(`::error::[scheduled-jobs-canary] could not read workflow directory ${WORKFLOW_DIR}`);
    return 2;
  }
  for (const w of workflows) console.log(w.file);
  return 0;
}

async function main() {
  if (process.argv.includes("--list")) return runListMode();

  const workflows = enumerateCronWorkflows(WORKFLOW_DIR);
  if (workflows === null) {
    console.error(`::error::[scheduled-jobs-canary] could not read workflow directory ${WORKFLOW_DIR}`);
    return 2;
  }
  const exemptions = loadExemptions(EXEMPTIONS_PATH);
  if (exemptions === null) {
    console.error(
      `::error::[scheduled-jobs-canary] exemption list unreadable at ${EXEMPTIONS_PATH} — refusing to run with an assumed-empty list`,
    );
    return 2;
  }
  const raw = readInput();
  if (raw === null) {
    console.error('::error::[scheduled-jobs-canary] RUNS_JSON required (a path, or "-" for stdin)');
    return 2;
  }
  const runsByFile = parseRunsInput(raw);
  if (runsByFile === null) {
    // Not "every job is fine" — the question was never answered.
    console.error(
      "::error::[scheduled-jobs-canary] run payload did not parse as an object keyed by workflow file — the jobs were NOT measured",
    );
    return 2;
  }

  const rows = assess({ workflows, runsByFile, exemptions, consecutive: CONSECUTIVE });

  console.log("[scheduled-jobs-canary] source of truth: GitHub Actions run conclusions, event=schedule");
  console.log(
    `[scheduled-jobs-canary] ${workflows.length} cron workflow(s) enumerated from ${path.relative(REPO_ROOT, WORKFLOW_DIR) || WORKFLOW_DIR}; ` +
    `breach = last ${CONSECUTIVE} scheduled runs all failed; ${exemptions.length} exempt`,
  );
  console.log("");

  const breaches = rows.filter((r) => r.status === "breach" && !r.exempt);
  const exemptBreaches = rows.filter((r) => r.status === "breach" && r.exempt);
  const unmeasured = rows.filter((r) => r.status === "unmeasured");
  const insufficient = rows.filter((r) => r.status === "insufficient");
  const ok = rows.filter((r) => r.status === "ok");

  console.log("axis        measured                          threshold        verdict");
  console.log("---------   -------------------------------   --------------   -------");
  console.log(
    `breaches    ${`${breaches.length} of ${rows.length} cron workflows`.padEnd(31)}   ` +
    `${"== 0".padEnd(14)}   ${breaches.length === 0 ? "ok" : "BREACH"}`,
  );
  console.log(
    `unmeasured  ${`${unmeasured.length} workflow(s) had no answer`.padEnd(31)}   ` +
    `${"== 0".padEnd(14)}   ${unmeasured.length === 0 ? "ok" : "UNMEASURED"}`,
  );
  console.log("");

  if (breaches.length > 0) {
    console.log("[scheduled-jobs-canary] BREACHING —");
    for (const b of breaches) {
      console.log(`  ${b.name}  (${b.file})  last ${CONSECUTIVE} scheduled: ${b.window.join(", ")}`);
    }
    console.log("");
  }
  if (exemptBreaches.length > 0) {
    // Measured and printed, deliberately not alarming. An exemption hides the
    // alarm, never the evidence.
    console.log("[scheduled-jobs-canary] breaching but EXEMPT —");
    for (const b of exemptBreaches) {
      const reason = (exemptions.find((e) => e.workflow === b.file) || {}).reason || "(no reason recorded)";
      console.log(`  ${b.name}  (${b.file})  ${b.window.join(", ")}  — ${reason}`);
    }
    console.log("");
  }
  if (insufficient.length > 0) {
    console.log(
      `[scheduled-jobs-canary] ${insufficient.length} workflow(s) have fewer than ${CONSECUTIVE} scheduled runs in the window — not enough history to judge:`,
    );
    for (const i of insufficient) console.log(`  ${i.name}  (${i.file})  ${i.scheduledRuns} scheduled run(s)`);
    console.log("");
  }
  if (unmeasured.length > 0) {
    console.log("[scheduled-jobs-canary] NOT MEASURED (the query returned nothing for these) —");
    for (const u of unmeasured) console.log(`  ${u.name}  (${u.file})`);
    console.log("");
  }

  // RECONCILIATION. Name every enumerated workflow and where it landed, so a
  // workflow that silently fell out of the report is itself visible. Same
  // contract the ingest lanes carry: every row lands in exactly one bucket.
  const accounted = ok.length + breaches.length + exemptBreaches.length + insufficient.length + unmeasured.length;
  console.log(
    `[scheduled-jobs-canary] reconcile: ${rows.length} enumerated = ${ok.length} ok + ${breaches.length} breach + ` +
    `${exemptBreaches.length} exempt-breach + ${insufficient.length} insufficient + ${unmeasured.length} unmeasured  ` +
    `${accounted === rows.length ? "RECONCILES" : "MISMATCH"}`,
  );

  if (unmeasured.length > 0) {
    console.error(
      `::error::${unmeasured.length} cron workflow(s) were not measured — the run query returned no entry for them, ` +
      `so their health is unknown, not good`,
    );
    return 1;
  }
  if (breaches.length > 0) {
    for (const b of breaches) {
      console.error(
        `::error::${b.name} has failed its last ${CONSECUTIVE} scheduled runs (${b.window.join(", ")}) — ` +
        `a cron this dead stops doing its work while every row-based canary stays green`,
      );
    }
    return 1;
  }

  console.log(
    `[scheduled-jobs-canary] OK — ${ok.length} of ${rows.length} cron workflow(s) healthy on their last ${CONSECUTIVE} scheduled runs` +
    (insufficient.length ? `, ${insufficient.length} with too little history to judge` : ""),
  );
  return 0;
}

module.exports = {
  runListMode,
  hasScheduleTrigger,
  workflowName,
  enumerateCronWorkflows,
  loadExemptions,
  verdictFor,
  parseRunsInput,
  assess,
  numEnv,
};

if (require.main === module) {
  // LIST MODE BYPASSES finishLane. `finishLane` prints "finishLane: exiting
  // code 0" on STDOUT, and the shell consumes this output as a filename list
  // — that banner would be read as a 62nd workflow named
  // "finishLane: exiting code 0", queried, and reported unmeasured. Caught by
  // piping the real output through `grep -v '\.yml$'`.
  if (process.argv.includes("--list")) {
    process.exitCode = runListMode();
  } else {
  main()
    .then((code) => finishLane(code))
    .catch(async (e) => {
      console.error("::error::[scheduled-jobs-canary] FAILED:", (e && e.message) || e);
      await finishLane(1);
    });
  }
}
