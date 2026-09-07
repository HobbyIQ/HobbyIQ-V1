// GO-LIVE P2-4 — the two canaries the checklist named as unbuilt:
// deal-scanner-failure and storefront-visibility-zero.
//
// What these pins protect, in the order the reviewer will want them:
//
//   1. THE SOURCE OF TRUTH. The deal-scanner canary must read App Insights
//      traces, NOT a container. Its Cosmos write is conditional on a deal
//      being found and a push delivering, so a row count reads a healthy
//      quiet hour and a dead process as the same zero. A future edit that
//      "simplifies" this into a container count is the regression these
//      pins exist to stop.
//   2. THRESHOLD ARITHMETIC. Every axis is pinned at its boundary — at,
//      just under, just over — because an off-by-one in a canary is
//      indistinguishable from the canary working until the day it matters.
//   3. MUTATION → RED. Each axis is shown flipping a real verdict, so a
//      pin that would pass against a gutted implementation is caught here
//      rather than in production.
//   4. BANNER SHAPE. The banner is the product: it is what an operator
//      reads at 3am. The reconciliation line and the measured-vs-threshold
//      columns are pinned as text.
//   5. THE WORKFLOWS carry the schedule, the issue lane and the thresholds
//      they claim to carry.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const wf = (name: string) => read(".github", "workflows", name);

type Summary = {
  timestamp: string | null;
  targetsScanned: number;
  dealsFound: number;
  notificationsSent: number;
  errors: number;
  durationMs: number;
};

const deal = require("../scripts/checkDealScannerHeartbeat.cjs") as {
  parseAiTable: (raw: string) => Array<Record<string, unknown>> | null;
  parseSummaries: (rows: Array<Record<string, unknown>>) => { parsed: Summary[]; unparsed: number };
  verdicts: (
    summaries: Summary[],
    opts: { now: number; maxSilenceHours: number; maxErrorRate: number },
  ) => {
    runs: number; latestIso: string | null; silenceH: number; heartbeatOk: boolean;
    scanned: number; errors: number; errorRate: number | null;
    dealsFound: number; notificationsSent: number; errorsOk: boolean;
  };
  numEnv: (raw: string | undefined, dflt: number) => number;
};

const store = require("../scripts/checkStorefrontVisibility.cjs") as {
  sellerEligibility: (u: unknown) => { eligible: boolean; reason: string | null; userId?: string; username?: string; plan?: string };
  effectivePlan: (u: unknown) => string;
  cohorts: (stamps: Array<string | null | undefined>, bucketMs?: number) => Array<{ at: string; count: number }>;
  dropVerdict: (
    cohorts: Array<{ at: string; count: number }>,
    maxDropPct: number,
  ) => { axis: string; ok: boolean; skipped: boolean; reason?: string; current?: number; prior?: number; dropPct?: number; floor?: number; currentAt?: string; priorAt?: string };
  coverageVerdict: (
    eligible: Array<{ userId: string; username?: string }>,
    withListings: Iterable<string>,
  ) => { eligible: number; covered: number; uncovered: Array<{ userId: string }>; ok: boolean };
};

// ── helpers ──────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-09-07T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString();

function summary(over: Partial<Summary> & { timestamp: string }): Summary {
  return {
    targetsScanned: 4, dealsFound: 0, notificationsSent: 0,
    errors: 0, durationMs: 1000, ...over,
  };
}

function aiTable(rows: Array<{ timestamp: string; message: string }>) {
  return JSON.stringify({
    tables: [{
      columns: [{ name: "timestamp" }, { name: "message" }],
      rows: rows.map((r) => [r.timestamp, r.message]),
    }],
  });
}

const scanLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "buyeriq_deal_scan_summary", source: "buyerIqDealScanner.service",
    startedAt: "2026-09-07T17:00:00.000Z", finishedAt: "2026-09-07T17:00:09.000Z",
    durationMs: 9000, targetsScanned: 4, targetsSkipped: 2, listingsFetched: 12,
    dealsFound: 0, notificationsSent: 0, notificationsSkippedDedup: 0,
    notificationsFailed: 0, errors: 0, ...over,
  });

// ── 1. SOURCE OF TRUTH ───────────────────────────────────────────────────
describe("1. the deal-scanner canary reads traces, not a container", () => {
  const src = read("backend", "scripts", "checkDealScannerHeartbeat.cjs");

  it("never opens a Cosmos client — the heartbeat is a trace, not a row count", () => {
    // Strip comments first: the header MUST be free to name buyeriq_deals_sent
    // when explaining why counting it would be wrong. What may not exist is
    // executable code that opens a client or reads that container.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/@azure\/cosmos/);
    expect(code).not.toMatch(/CosmosClient/);
    expect(code).not.toMatch(/buyeriq_deals_sent/);
    // and the explanation itself must survive, or the next editor loses the reason
    expect(src).toContain("buyeriq_deals_sent");
  });

  it("names the event it keys on, and rejects rows carrying any other event", () => {
    expect(src).toContain("buyeriq_deal_scan_summary");
    const { parsed, unparsed } = deal.parseSummaries([
      { timestamp: hoursAgo(1), message: scanLine() },
      { timestamp: hoursAgo(1), message: JSON.stringify({ event: "buyeriq_target_refused_no_identity" }) },
    ]);
    expect(parsed).toHaveLength(1);
    expect(unparsed).toBe(1);
  });

  it("states WHY a row count would be wrong, so the next editor does not 'simplify' it", () => {
    expect(src).toMatch(/CONDITIONAL/);
    expect(src).toMatch(/push\.sent > 0/);
  });
});

describe("1b. the storefront canary reads the pool the public route serves", () => {
  const src = read("backend", "scripts", "checkStorefrontVisibility.cjs");

  it("queries marketplace_listings and derives sellers from users", () => {
    expect(src).toContain('container("marketplace_listings")');
    expect(src).toContain('COSMOS_USERS_CONTAINER || "users"');
  });

  it("applies NO visibility predicate, because the served route applies none", () => {
    expect(src).toContain("SELECT c.sellerId, c.lastUpdatedAt FROM c");
    expect(src).toMatch(/visibility IS ROW PRESENCE/);
  });

  it("gates the eligible-seller set on the same four things the writer does", () => {
    const writer = read("backend", "scripts", "backfillMarketplaceListings.cjs");
    for (const gate of ["pro_seller", "investor", "publicShareEnabled", "emailVerification"]) {
      expect(writer).toContain(gate);
      expect(src).toContain(gate);
    }
    // usernameLower is the writer's last gate; the canary must carry it too,
    // or the two would measure different populations.
    expect(writer).toContain("usernameLower");
    expect(src).toContain("usernameLower");
  });
});

// ── 2. THRESHOLD ARITHMETIC, AT THE BOUNDARY ─────────────────────────────
describe("2. deal-scanner heartbeat arithmetic", () => {
  const opts = { now: NOW, maxSilenceHours: 2, maxErrorRate: 0.5 };

  it("just under the ceiling is ok; exactly at it is ok; past it is SILENT", () => {
    expect(deal.verdicts([summary({ timestamp: hoursAgo(1.9) })], opts).heartbeatOk).toBe(true);
    expect(deal.verdicts([summary({ timestamp: hoursAgo(2) })], opts).heartbeatOk).toBe(true);
    expect(deal.verdicts([summary({ timestamp: hoursAgo(2.1) })], opts).heartbeatOk).toBe(false);
  });

  it("NO run in the window is Infinity, never 0 — an empty result set is the loudest signal", () => {
    const v = deal.verdicts([], opts);
    expect(v.silenceH).toBe(Infinity);
    expect(v.heartbeatOk).toBe(false);
    expect(v.runs).toBe(0);
  });

  it("the newest run wins, so an old run cannot mask a stalled one", () => {
    const v = deal.verdicts(
      [summary({ timestamp: hoursAgo(10) }), summary({ timestamp: hoursAgo(0.5) })],
      opts,
    );
    expect(v.heartbeatOk).toBe(true);
    expect(v.latestIso).toBe(hoursAgo(0.5));
  });

  it("2h is exactly 2x the job's own 60-minute interval", () => {
    const job = read("backend", "src", "jobs", "buyerIqDealScanner.job.ts");
    expect(job).toContain("const DEFAULT_INTERVAL_MIN = 60;");
    expect(deal.numEnv(undefined, 2)).toBe(2);   // the script's default
    expect(2 * 60).toBe(120);                     // 2h, in the job's units
  });
});

describe("2b. deal-scanner error-rate arithmetic", () => {
  const opts = { now: NOW, maxSilenceHours: 2, maxErrorRate: 0.5 };

  it("divides errors by TARGETS SCANNED, not by run count", () => {
    const v = deal.verdicts(
      [summary({ timestamp: hoursAgo(1), targetsScanned: 4, errors: 2 })],
      opts,
    );
    expect(v.errorRate).toBe(0.5);
    expect(v.scanned).toBe(4);
  });

  it("exactly at the ceiling passes; over it fires", () => {
    const at = deal.verdicts([summary({ timestamp: hoursAgo(1), targetsScanned: 4, errors: 2 })], opts);
    expect(at.errorsOk).toBe(true);
    const over = deal.verdicts([summary({ timestamp: hoursAgo(1), targetsScanned: 4, errors: 3 })], opts);
    expect(over.errorsOk).toBe(false);
  });

  it("a window that scanned nothing has NO rate and cannot fire — 0/0 is not health", () => {
    const v = deal.verdicts([summary({ timestamp: hoursAgo(1), targetsScanned: 0, errors: 0 })], opts);
    expect(v.errorRate).toBeNull();
    expect(v.errorsOk).toBe(true);
  });

  it("rate 0 disables the axis entirely", () => {
    const v = deal.verdicts(
      [summary({ timestamp: hoursAgo(1), targetsScanned: 4, errors: 4 })],
      { ...opts, maxErrorRate: 0 },
    );
    expect(v.errorsOk).toBe(true);
  });
});

describe("2c. storefront day-over-day arithmetic", () => {
  const c = (at: string, count: number) => ({ at, count });

  it("a drop of exactly the ceiling passes; one row more fires", () => {
    expect(store.dropVerdict([c("2026-09-07T07:42:00Z", 10), c("2026-09-06T07:42:00Z", 20)], 0.5).ok).toBe(true);
    expect(store.dropVerdict([c("2026-09-07T07:42:00Z", 9), c("2026-09-06T07:42:00Z", 20)], 0.5).ok).toBe(false);
  });

  it("growth is never a drop", () => {
    const v = store.dropVerdict([c("2026-09-07T07:42:00Z", 40), c("2026-09-06T07:42:00Z", 20)], 0.5);
    expect(v.dropPct).toBe(0);
    expect(v.ok).toBe(true);
  });

  it("a total wipe is a 100% drop and fires", () => {
    const v = store.dropVerdict([c("2026-09-07T07:42:00Z", 0), c("2026-09-06T07:42:00Z", 19)], 0.5);
    expect(v.dropPct).toBe(1);
    expect(v.ok).toBe(false);
  });

  it("ONE cohort is SKIPPED, not passed — 'could not measure' is not '0% drop'", () => {
    const v = store.dropVerdict([c("2026-09-07T07:42:00Z", 19)], 0.5);
    expect(v.skipped).toBe(true);
    expect(v.reason).toBe("no prior refresh cohort");
    expect(v.dropPct).toBeUndefined();
  });

  it("an empty prior cohort is skipped rather than dividing by zero", () => {
    const v = store.dropVerdict([c("2026-09-07T07:42:00Z", 5), c("2026-09-06T07:42:00Z", 0)], 0.5);
    expect(v.skipped).toBe(true);
  });

  it("0 disables the axis", () => {
    expect(store.dropVerdict([c("a", 0), c("b", 100)], 0).skipped).toBe(true);
  });

  it("the floor it prints is the row count the pool may not go under", () => {
    const v = store.dropVerdict([c("2026-09-07T07:42:00Z", 11), c("2026-09-06T07:42:00Z", 20)], 0.5);
    expect(v.floor).toBe(10);
    expect(v.ok).toBe(true);
  });
});

describe("2d. storefront cohorts and coverage", () => {
  it("stamps within the same minute are ONE run, so a straddling rebuild is not a collapse", () => {
    const out = store.cohorts([
      "2026-09-07T07:42:56.483Z", "2026-09-07T07:42:56.900Z", "2026-09-07T07:42:10.000Z",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
  });

  it("orders cohorts newest first, which is what makes [0] today and [1] yesterday", () => {
    const out = store.cohorts([
      "2026-09-05T07:42:00Z", "2026-09-07T07:42:00Z", "2026-09-06T07:42:00Z",
    ]);
    expect(out.map((x) => x.count)).toEqual([1, 1, 1]);
    expect(out[0].at > out[1].at).toBe(true);
    expect(out[1].at > out[2].at).toBe(true);
  });

  it("unparseable and missing stamps are dropped from cohorts, never counted as now", () => {
    expect(store.cohorts([null, undefined, "", "not-a-date"])).toEqual([]);
  });

  it("an eligible seller with no row is UNCOVERED and is named", () => {
    const v = store.coverageVerdict(
      [{ userId: "u1", username: "alice" }, { userId: "u2", username: "bob" }],
      ["u1"],
    );
    expect(v.ok).toBe(false);
    expect(v.covered).toBe(1);
    expect(v.uncovered.map((s) => s.userId)).toEqual(["u2"]);
  });

  it("an EMPTY eligible set cannot fire — a pre-launch state is not an outage", () => {
    const v = store.coverageVerdict([], []);
    expect(v.ok).toBe(true);
    expect(v.eligible).toBe(0);
  });

  it("the four eligibility gates each refuse with their own named reason", () => {
    const ok = {
      userId: "u1", plan: "pro_seller", publicShareEnabled: true,
      emailVerification: { verifiedAt: "2026-01-01T00:00:00Z" }, usernameLower: "alice",
    };
    expect(store.sellerEligibility(ok).eligible).toBe(true);
    expect(store.sellerEligibility({ ...ok, plan: "collector" }).reason).toBe("plan");
    expect(store.sellerEligibility({ ...ok, publicShareEnabled: false }).reason).toBe("publicShareDisabled");
    expect(store.sellerEligibility({ ...ok, emailVerification: null }).reason).toBe("emailUnverified");
    expect(store.sellerEligibility({ ...ok, usernameLower: null }).reason).toBe("noUsername");
  });

  it("entitlementOverride beats plan, exactly as the writer's effectivePlan does", () => {
    expect(store.effectivePlan({ plan: "free", entitlementOverride: "pro_seller" })).toBe("pro_seller");
    expect(store.effectivePlan({ plan: "nonsense" })).toBe("free");
    expect(store.sellerEligibility({
      userId: "u1", plan: "free", entitlementOverride: "investor", publicShareEnabled: true,
      emailVerification: { verifiedAt: "2026-01-01T00:00:00Z" }, usernameLower: "alice",
    }).eligible).toBe(true);
  });
});

// ── 3. THE QUERY FAILING IS NOT THE JOB DYING ────────────────────────────
describe("3. a broken query and a dead scanner are different incidents", () => {
  it("a shapeless payload parses to null, which the script reports as exit 2", () => {
    expect(deal.parseAiTable("not json")).toBeNull();
    expect(deal.parseAiTable(JSON.stringify({ tables: [] }))).toBeNull();
    expect(deal.parseAiTable(JSON.stringify({ tables: [{ columns: [{ name: "x" }] }] }))).toBeNull();
    const src = read("backend", "scripts", "checkDealScannerHeartbeat.cjs");
    expect(src).toContain("the scanner was NOT measured");
    expect(src).toMatch(/return 2;/);
  });

  it("an EMPTY table is a real answer — zero runs, exit 1, not exit 2", () => {
    const rows = deal.parseAiTable(aiTable([]));
    expect(rows).toEqual([]);
    expect(deal.verdicts([], { now: NOW, maxSilenceHours: 2, maxErrorRate: 0.5 }).heartbeatOk).toBe(false);
  });

  it("columns are read BY NAME, so a reordered projection cannot shift the reading", () => {
    const swapped = JSON.stringify({
      tables: [{
        columns: [{ name: "message" }, { name: "timestamp" }],
        rows: [[scanLine(), hoursAgo(1)]],
      }],
    });
    const rows = deal.parseAiTable(swapped)!;
    expect(rows[0].timestamp).toBe(hoursAgo(1));
    const { parsed } = deal.parseSummaries(rows);
    expect(parsed[0].targetsScanned).toBe(4);
  });
});

// ── 4. MUTATION → RED ────────────────────────────────────────────────────
describe("4. mutation turns each axis red", () => {
  const opts = { now: NOW, maxSilenceHours: 2, maxErrorRate: 0.5 };

  it("MUTANT: heartbeat that ignores the timestamp would pass a 3-day silence — the real one fails it", () => {
    const threeDaysStale = [summary({ timestamp: hoursAgo(72) })];
    expect(deal.verdicts(threeDaysStale, opts).heartbeatOk).toBe(false);
    // A mutant returning `runs > 0` would say true here; pin the difference.
    expect(deal.verdicts(threeDaysStale, opts).runs).toBe(1);
  });

  it("MUTANT: an error axis keyed on run count would pass 4-of-4 failures", () => {
    const allErrored = [summary({ timestamp: hoursAgo(1), targetsScanned: 4, errors: 4 })];
    expect(deal.verdicts(allErrored, opts).errorsOk).toBe(false);
    expect(deal.verdicts(allErrored, opts).errorRate).toBe(1);
  });

  it("MUTANT: a drop axis that treated a missing prior as 0% would pass a wipe", () => {
    const wipe = store.dropVerdict(
      [{ at: "2026-09-07T07:42:00Z", count: 0 }, { at: "2026-09-06T07:42:00Z", count: 19 }],
      0.5,
    );
    expect(wipe.skipped).toBe(false);
    expect(wipe.ok).toBe(false);
  });

  it("MUTANT: coverage that counted DISTINCT sellers in the pool would miss an absent seller", () => {
    // Two eligible sellers, one row-bearing seller. A pool-side distinct
    // count says "1 seller has listings" and looks fine; coverage does not.
    expect(store.coverageVerdict([{ userId: "u1" }, { userId: "u2" }], ["u1"]).ok).toBe(false);
  });
});

// ── 5. BANNER SHAPE ──────────────────────────────────────────────────────
describe("5. the banner an operator reads at 3am", () => {
  it("the deal-scanner banner names its source of truth, its axes and reconciles", () => {
    const src = read("backend", "scripts", "checkDealScannerHeartbeat.cjs");
    expect(src).toContain("[deal-scanner-canary] source of truth: App Insights traces");
    expect(src).toContain("axis        measured                          threshold        verdict");
    expect(src).toMatch(/reconcile: \$\{rows\.length\} trace rows = /);
    expect(src).toContain("RECONCILES");
    expect(src).toContain("MISMATCH");
  });

  it("the storefront banner names its source of truth, four axes and TWO reconciliations", () => {
    const src = read("backend", "scripts", "checkStorefrontVisibility.cjs");
    expect(src).toContain("[storefront-canary] source of truth: Cosmos marketplace_listings");
    expect(src).toContain("axis            measured                             threshold        verdict");
    for (const axis of ["total", "sellers", "day-over-day", "refresh age"]) {
      expect(src).toContain(axis);
    }
    expect(src).toContain("reconcile listings:");
    expect(src).toContain("reconcile sellers:");
  });

  it("both scripts exit through finishLane, so a killed step is distinguishable from a clean one", () => {
    for (const f of ["checkDealScannerHeartbeat.cjs", "checkStorefrontVisibility.cjs"]) {
      const src = read("backend", "scripts", f);
      expect(src).toContain('require(path.join(__dirname, "lib", "runner-budget.cjs"))');
      expect(src).toContain("finishLane(");
    }
  });

  it("the storefront canary budgets its loop, per CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS", () => {
    const src = read("backend", "scripts", "checkStorefrontVisibility.cjs");
    // All three constants declared — the vocabulary the margin pin computes from.
    expect(src).toMatch(/budget\(\{\s*minutes:/);
    expect(src).toMatch(/reserveMs: [\d_]+/);
    expect(src).toMatch(/verifyMs: [\d_]+/);
    expect(src).toContain("b.describe()");
  });

  it("neither script writes: no upsert, no delete, no patch, no APPLY", () => {
    for (const f of ["checkDealScannerHeartbeat.cjs", "checkStorefrontVisibility.cjs"]) {
      const src = read("backend", "scripts", f);
      expect(src).not.toMatch(/\.upsert\(|\.replace\(|\.patch\(|\.delete\(|\.create\(/);
      expect(src).not.toMatch(/\bAPPLY\b/);
    }
  });
});

// ── 6. THE WORKFLOWS ─────────────────────────────────────────────────────
describe("6. the two canary workflows", () => {
  const dealYml = wf("deal-scanner-canary.yml");
  const storeYml = wf("storefront-visibility-canary.yml");

  it("both run every 6h on the minutes they claim", () => {
    expect(dealYml).toMatch(/- cron: '15 \*\/6 \* \* \*'/);
    expect(storeYml).toMatch(/- cron: '0 \*\/6 \* \* \*'/);
  });

  // Enumerated, not hard-coded: a fifth six-hourly canary landing on a taken
  // minute must turn this red rather than quietly doubling the load on one
  // minute of the hour. (cleanliness-canary.yml at :17 was already here and
  // an earlier draft of this pin had not noticed it.)
  it("no two six-hourly canaries share a cron minute", () => {
    const wfDir = path.join(ROOT, ".github", "workflows");
    const byMinute = new Map<string, string[]>();
    for (const f of fs.readdirSync(wfDir).filter((n) => /-canary\.yml$/.test(n))) {
      const m = read(".github", "workflows", f).match(/- cron: ["']?(\d+) \*\/6 \* \* \*/);
      if (!m) continue;                       // not six-hourly (e.g. the daily one)
      byMinute.set(m[1], [...(byMinute.get(m[1]) ?? []), f]);
    }
    const collisions = [...byMinute.entries()].filter(([, files]) => files.length > 1);
    expect(collisions).toEqual([]);
    expect(byMinute.size).toBeGreaterThanOrEqual(5);
  });

  it("each runs its own script and nothing else", () => {
    expect(dealYml).toContain("node scripts/checkDealScannerHeartbeat.cjs");
    expect(storeYml).toContain("node scripts/checkStorefrontVisibility.cjs");
  });

  it("each files its issue on github.token alone — an Azure outage must not silence its own alert", () => {
    for (const yml of [dealYml, storeYml]) {
      expect(yml).toContain("GH_TOKEN: ${{ github.token }}");
      expect(yml).toContain("issues: write");
      expect(yml).toContain("--label ops --label canary");
      // The alert step must not be the thing that needs Azure.
      const alertStep = yml.slice(yml.indexOf("Open or update"));
      expect(alertStep).not.toContain("azure/login");
    }
  });

  // Verified against the live repo 2026-09-07: neither `ops` nor `canary`
  // exists (both 404). `gh issue create` FAILS OUTRIGHT on an unknown label,
  // so a labelled-only create would file nothing and leave a ::warning:: —
  // the alert silently absent in exactly the incident it exists for.
  it("a missing label cannot swallow the issue: labelled create falls back to unlabelled", () => {
    for (const yml of [dealYml, storeYml]) {
      // Count only executable lines — the comment above the branch names
      // `gh issue create` while explaining why the fallback exists.
      const invocations = yml
        .split("\n")
        .filter((l) => !/^\s*#/.test(l) && l.includes("gh issue create"));
      expect(invocations).toHaveLength(2);
      const createBranch = yml.slice(yml.lastIndexOf("gh issue create"));
      expect(createBranch).not.toContain("--label");
      // ...and the warning is the LAST resort, after both attempts
      expect(yml).toMatch(/--label ops --label canary \\\n\s+\|\| gh issue create/);
    }
  });

  it("the dedup lookup does NOT filter by a label, or it would miss every time", () => {
    for (const yml of [dealYml, storeYml]) {
      expect(yml).toContain('gh issue list --repo "$GITHUB_REPOSITORY" --state open \\');
      expect(yml).not.toMatch(/gh issue list[^\n]*--label/);
      // the exact-title match is what identifies the thread instead
      expect(yml).toContain('--search "$TITLE in:title" --json number,title');
      expect(yml).toContain("gh issue comment");
    }
  });

  it("the alert fires only when the CANARY step failed, not on a checkout or npm hiccup", () => {
    for (const yml of [dealYml, storeYml]) {
      expect(yml).toContain("if: ${{ failure() && steps.canary.outcome == 'failure' }}");
      expect(yml).toContain("id: canary");
    }
  });

  it("the workflow defaults match the scripts' documented defaults", () => {
    expect(dealYml).toContain("MAX_SILENCE_HOURS: ${{ inputs.max_silence_hours || '2' }}");
    expect(dealYml).toContain("WINDOW_HOURS: ${{ inputs.window_hours || '24' }}");
    expect(storeYml).toContain("MIN_LISTINGS=\"${{ inputs.min_listings || '0' }}\"");
    expect(storeYml).toContain("MAX_DROP_PCT=\"${{ inputs.max_drop_pct || '0.5' }}\"");
    expect(storeYml).toContain("MAX_REFRESH_AGE_HOURS=\"${{ inputs.max_refresh_age_hours || '48' }}\"");
  });

  it("the deal-scanner workflow carries the App Insights app-id and the exact event it keys on", () => {
    expect(dealYml).toContain("468bd437-5d16-47b4-90fb-5ee5d41726ae");
    expect(dealYml).toContain("buyeriq_deal_scan_summary");
    // An empty file from the CLI is a failed query, not zero runs.
    expect(dealYml).toContain("the scanner was NOT measured");
  });

  it("the storefront workflow reads the connection string from App Service and never prints it", () => {
    expect(storeYml).toContain("az webapp config appsettings list");
    expect(storeYml).toContain("COSMOS_CONNECTION_STRING=$(az webapp config appsettings list");
    expect(storeYml).not.toMatch(/echo .*\$COSMOS_CONNECTION_STRING/);
  });

  it("NEITHER touches backfill-runner.yml inputs", () => {
    for (const yml of [dealYml, storeYml]) {
      expect(yml).not.toContain("backfill-runner");
    }
  });

  it("the storefront step ceiling clears the script's own budget with margin", () => {
    // RUN_MINUTES=8 loop + 1m reserve + 2m verify = 11m worst case under 25.
    expect(storeYml).toContain("RUN_MINUTES=8");
    expect(storeYml).toMatch(/timeout-minutes: 25/);
    expect(25 - (8 + 1 + 2)).toBeGreaterThanOrEqual(14);
  });
});

// ── 7. THE CANARY MAP ────────────────────────────────────────────────────
describe("7. the canary map lists every canary that exists", () => {
  const map = read("backend", "docs", "reference", "canary-map.md");

  // Not a fixed list: the map falls behind the moment someone adds a canary
  // and forgets the doc — which is exactly what had already happened to
  // catalog-duplicates-canary.yml. Enumerating the directory means a NEW
  // canary turns this red until it is written down.
  it("lists EVERY *-canary.yml in the repo — the map cannot fall behind", () => {
    const wfDir = path.join(ROOT, ".github", "workflows");
    const canaries = fs.readdirSync(wfDir).filter((f) => /-canary\.yml$/.test(f));
    expect(canaries.length).toBeGreaterThanOrEqual(5);
    const missing = canaries.filter((f) => !map.includes(f));
    expect(missing).toEqual([]);
  });

  it("names the two this PR adds, and they exist", () => {
    for (const w of ["deal-scanner-canary.yml", "storefront-visibility-canary.yml"]) {
      expect(map).toContain(w);
      expect(fs.existsSync(path.join(ROOT, ".github", "workflows", w))).toBe(true);
    }
  });

  it("gives each canary a source of truth and a threshold", () => {
    expect(map).toContain("buyeriq_deal_scan_summary");
    expect(map).toContain("marketplace_listings");
    expect(map).toContain("sold_comps");
    expect(map).toContain("card_catalog");
  });
});
