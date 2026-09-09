#!/usr/bin/env node
/**
 * CF-LONG-CRONS-DIE-AT-THE-IDLE-CUT (2026-09-09).
 *
 * Dispatch a long admin job over HTTP and poll it to completion.
 *
 * WHY A POLLER AND NOT A BIGGER TIMEOUT
 * -------------------------------------
 * Three nightly crons called endpoints that do minutes of server-side work
 * and waited on one HTTP response. App Insights (14d, app-id 468bd437-…):
 *
 *   /api/cleanliness/anomalies?force=true   11 requests, ALL ResultCode 0,
 *                                           every one cut at 89.9s — the
 *                                           lane has never once received a
 *                                           drift comparison.
 *   .../personal-prospect-breakout/run      38 × 200, p95 142.5s, max 211.6s.
 *   /api/dailyiq/brief?fresh=true           183 × 200 (p95 182.9s) and
 *                                           17 × ResultCode 0 at exactly
 *                                           240.0s.
 *
 * 240.0s is the App Service front end's idle cut, and it belongs to the
 * platform: it fires when a connection carries no bytes for that long,
 * whatever the client's own budget says. #1985 raised the anomalies curl
 * ceiling from 90s to 900s on the theory that the client was impatient; the
 * platform would have cut it at 240 regardless. Widening a timeout was never
 * available as the fix.
 *
 * A poll has no idle problem: each request is short and the connection
 * carries bytes constantly. The server runs the job in the background and
 * this script asks, every few seconds, whether it has settled.
 *
 * "UNKNOWN-HERE" IS NOT "DONE"
 * ----------------------------
 * HobbyIQ3 serves on 2 instances. A dispatch lands on one worker; each poll
 * load-balances and lands about half the time on the OTHER, which has never
 * heard of the job id and answers `unknown-here`. That is honest ignorance,
 * NOT a verdict — repriceJobTracker learned this the expensive way when a
 * poll answering `idle` was read as "finished" and a web page said "Refresh
 * complete." mid-run. This poller therefore settles ONLY on an explicit
 * `settled:true` from a worker that owns the id, and treats every
 * `unknown-here` as keep-asking. A run it never gets a terminal answer for
 * is reported as UNKNOWN at the deadline — never as success, never as
 * failure, because both would be claims this script cannot support.
 *
 * BANNER CONTRACT
 * ---------------
 * Same shape the backfill lanes print (see scripts/lib/runner-budget.cjs):
 * a `reconciled:` line naming what was intended against what landed, and a
 * terminal `finishLane: exiting code N`. The reconcile is what makes a green
 * run readable after the fact; a lane that prints only its exit code proves
 * nothing.
 *
 * USAGE
 *   node scripts/poll-admin-job.cjs \
 *     --dispatch-url <url> [--method POST] [--body '<json>'] \
 *     --status-url <url> [--status-query sport=baseball] \
 *     [--auth-header "Authorization: Bearer $TOK"] \
 *     [--poll-interval-ms 5000] [--deadline-ms 1500000] \
 *     [--label anomalies]
 *
 * Exit codes: 0 settled done · 1 settled error / dispatch failed ·
 *             2 deadline reached with no terminal answer (UNKNOWN).
 */

const LABEL_DEFAULT = "admin-job";

function parseArgs(argv) {
  const out = { headers: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--dispatch-url": out.dispatchUrl = next(); break;
      case "--status-url": out.statusUrl = next(); break;
      case "--method": out.method = next(); break;
      case "--body": out.body = next(); break;
      case "--auth-header": out.headers.push(next()); break;
      case "--header": out.headers.push(next()); break;
      case "--status-query": out.statusQuery = next(); break;
      case "--poll-interval-ms": out.pollIntervalMs = Number(next()); break;
      case "--deadline-ms": out.deadlineMs = Number(next()); break;
      case "--label": out.label = next(); break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!out.dispatchUrl) throw new Error("--dispatch-url is required");
  if (!out.statusUrl) throw new Error("--status-url is required");
  out.method = out.method || "GET";
  out.label = out.label || LABEL_DEFAULT;
  // 5s between polls: fast enough that a 90s job is not padded much, slow
  // enough that a 25-minute ceiling is ~300 requests, not 30,000.
  out.pollIntervalMs = Number.isFinite(out.pollIntervalMs) ? out.pollIntervalMs : 5_000;
  // 25 minutes. The longest of these jobs measured 220s; the ceiling is for
  // a pathological night, and the workflow's own timeout-minutes is above it.
  out.deadlineMs = Number.isFinite(out.deadlineMs) ? out.deadlineMs : 25 * 60 * 1000;
  return out;
}

function headerObject(pairs) {
  const h = {};
  for (const raw of pairs) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    h[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return h;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { ok: true, json: JSON.parse(text), text };
  } catch {
    return { ok: false, json: null, text };
  }
}

/**
 * Decide what a status body means. Kept pure and exported so the contract
 * is testable without a server: the one rule that matters is that only an
 * explicit settled verdict from a worker owning the id ends the poll.
 */
function classifyStatus(body) {
  if (!body || typeof body !== "object") return { kind: "keep-polling", reason: "unparseable" };
  const status = body.status;
  if (status === "done") return { kind: "done", body };
  if (status === "error") return { kind: "error", error: body.error || "job reported error" };
  // `unknown-here` — the worker answering never issued this id. The run may
  // be alive on the other instance. Never a verdict.
  if (status === "unknown-here") return { kind: "keep-polling", reason: "unknown-here" };
  if (status === "running") return { kind: "keep-polling", reason: "running" };
  // `idle` after our own dispatch is the same ambiguity as unknown-here:
  // this worker holds nothing, which does not mean nothing is running.
  if (status === "idle") return { kind: "keep-polling", reason: "idle" };
  return { kind: "keep-polling", reason: `unrecognised status ${String(status)}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  const headers = headerObject(args.headers);
  const startedAt = Date.now();

  // ── dispatch ──────────────────────────────────────────────────────────
  const dispatchInit = { method: args.method, headers: { ...headers } };
  if (args.body) {
    dispatchInit.headers["Content-Type"] = "application/json";
    dispatchInit.body = args.body;
  }
  const dispatchRes = await fetch(args.dispatchUrl, dispatchInit);
  const dispatched = await readJson(dispatchRes);
  if (dispatchRes.status !== 202 && dispatchRes.status !== 200) {
    console.error(
      `::error::${args.label}: dispatch failed HTTP ${dispatchRes.status} — ${dispatched.text.slice(0, 400)}`,
    );
    console.log(`  reconciled: intended 1 dispatch = 0 accepted (HTTP ${dispatchRes.status})`);
    return 1;
  }
  const jobId = dispatched.json && dispatched.json.jobId;
  if (!jobId) {
    console.error(
      `::error::${args.label}: dispatch answered ${dispatchRes.status} without a jobId — cannot poll a run it will not name`,
    );
    console.log(`  reconciled: intended 1 dispatch = 0 pollable (no jobId)`);
    return 1;
  }
  const already = dispatched.json.alreadyRunning === true;
  console.log(
    `${args.label}: dispatched jobId=${jobId}${already ? " (adopted a run already in flight)" : ""}`,
  );

  // ── poll ──────────────────────────────────────────────────────────────
  const statusBase = args.statusUrl.includes("?")
    ? `${args.statusUrl}&jobId=${encodeURIComponent(jobId)}`
    : `${args.statusUrl}?jobId=${encodeURIComponent(jobId)}`;
  const statusUrl = args.statusQuery ? `${statusBase}&${args.statusQuery}` : statusBase;

  const deadline = startedAt + args.deadlineMs;
  let polls = 0;
  let unknownHere = 0;
  for (;;) {
    if (Date.now() >= deadline) {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      // Neither success nor failure: this script never received a terminal
      // answer, and the run may well have finished on the other instance.
      // Say exactly that; a cron that guesses here is how a silent failure
      // gets called green.
      console.error(
        `::error::${args.label}: no terminal answer within ${secs}s (${polls} polls, ${unknownHere} answered unknown-here) — the run may still be in flight; this is UNKNOWN, not a failure`,
      );
      console.log(
        `  reconciled: intended 1 run = 0 confirmed settled after ${polls} polls (${secs}s)`,
      );
      return 2;
    }
    await sleep(args.pollIntervalMs);
    polls++;
    let body = null;
    try {
      const res = await fetch(statusUrl, { headers });
      const parsed = await readJson(res);
      body = parsed.json;
      if (!res.ok && !body) {
        console.log(`  poll ${polls}: HTTP ${res.status} (transient) — asking again`);
        continue;
      }
    } catch (err) {
      // A dropped poll is not a verdict either.
      console.log(`  poll ${polls}: request failed (${err && err.message}) — asking again`);
      continue;
    }
    const verdict = classifyStatus(body);
    if (verdict.kind === "keep-polling") {
      if (verdict.reason === "unknown-here") unknownHere++;
      if (polls % 6 === 0) {
        console.log(`  poll ${polls}: ${verdict.reason} (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
      }
      continue;
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    if (verdict.kind === "error") {
      console.error(`::error::${args.label}: run failed after ${secs}s — ${verdict.error}`);
      console.log(`  reconciled: intended 1 run = 1 settled, 0 succeeded (${polls} polls, ${secs}s)`);
      return 1;
    }
    console.log(`${args.label}: settled done after ${secs}s (${polls} polls, ${unknownHere} unknown-here)`);
    console.log(`  reconciled: intended 1 run = 1 settled done (${polls} polls, ${secs}s)`);
    // The lane's own result, for the step that reads it.
    console.log(`RESULT_JSON ${JSON.stringify(verdict.body)}`);
    return 0;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      console.log(`finishLane: exiting code ${code}`);
      process.exit(code);
    })
    .catch((err) => {
      console.error(`::error::poll-admin-job FATAL: ${(err && err.stack) || err}`);
      console.log("finishLane: exiting code 1");
      process.exit(1);
    });
}

module.exports = { classifyStatus, parseArgs, headerObject };
