// D13 (2026-08-29) — alert gates prove delivery. Workflow-only fixes have
// no unit under test, so the gate IS the text. These pins keep the three
// structural changes from quietly reverting:
//   5. nightly-cleanliness can go red: missing ADMIN_API_TOKEN and an
//      empty anomalies response exit 1 (they exited 0); the four
//      dispatches remain and each prints its backfill-runner run URL
//   6. daily-market-insights-publish fails when gainers+losers+notable == 0
//   7. the retired Cardsight crawl and the permanent-dry-run verdict-flip
//      scaffold have no `schedule:`; ingest health no longer monitors
//      `cardsight`
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const wf = (name: string) => read(".github", "workflows", name);

describe("5. nightly-cleanliness never goes red — fixed", () => {
  const yml = wf("nightly-cleanliness.yml");
  it("a missing ADMIN_API_TOKEN is exit 1, not a warning", () => {
    expect(yml).toMatch(/if \[ -z "\$TOK" \]; then\n(\s+#[^\n]*\n)?\s+echo "::error::ADMIN_API_TOKEN not found[^\n]*"\n\s+exit 1\n\s+fi/);
    expect(yml).not.toContain("::warning::ADMIN_API_TOKEN not found");
  });
  it("an empty anomalies response is exit 1, not a warning", () => {
    expect(yml).toMatch(/if \[ -z "\$RESULT" \]; then\n(\s+#[^\n]*\n)?\s+echo "::error::anomaly detection returned empty[^\n]*"\n\s+exit 1\n\s+fi/);
    expect(yml).not.toContain("::warning::anomaly detection returned empty");
  });
  it("no guard exits 0 any more", () => {
    const code = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/\bexit 0\b/);
  });
  it("the four dispatches stay and each prints its run URL", () => {
    for (const s of [
      "backfill-catalog-driven-canonicalize",
      "promote-sold-comps-trust-tier",
      "baseline-pool-snapshot",
      "auto-quarantine-contaminated-pools",
    ]) {
      expect(yml).toContain(`-f script=${s} \\`);
      expect(yml).toContain(`'"dispatched ${s} → " + .[0].url + " (" + .[0].status + ")"'`);
    }
    expect(yml.match(/--workflow=backfill-runner\.yml --limit 1/g)?.length).toBe(4);
  });
});

describe("6. daily-market-insights-publish asserts content", () => {
  const yml = wf("daily-market-insights-publish.yml");
  it("reads the three counts and fails when their sum is zero", () => {
    for (const k of ["topGainersCount", "topLosersCount", "notableSalesCount"]) {
      expect(yml).toContain(`jq -r '.${k} // 0' response.json`);
    }
    expect(yml).toContain('echo "publish summary: slot=$SLOT gainers=$GAINERS losers=$LOSERS notable=$NOTABLE pool=$POOL"');
    expect(yml).toMatch(/if \[ "\$\(\(GAINERS \+ LOSERS \+ NOTABLE\)\)" -eq 0 \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi/);
  });
});

describe("7. retired vendor + dry-run scaffold are off the cron", () => {
  it("cardsight-pricing-nightly has workflow_dispatch only, and says why", () => {
    const yml = wf("cardsight-pricing-nightly.yml");
    expect(yml).not.toMatch(/^\s+schedule:/m);
    expect(yml).not.toMatch(/^\s+- cron:/m);
    expect(yml).toMatch(/^on:\n(\s+#[^\n]*\n)*\s+workflow_dispatch:/m);
    expect(yml).toContain("retired from");
    expect(yml).toContain("2026-08-16");
  });
  it("verdict-flip-push-fanout has workflow_dispatch only, and names the dry-run lines", () => {
    const yml = wf("verdict-flip-push-fanout.yml");
    expect(yml).not.toMatch(/^\s+schedule:/m);
    expect(yml).not.toMatch(/^\s+- cron:/m);
    expect(yml).toContain("verdict-flip-push-fanout.cjs:68,149");
  });
  it("the verdict-flip script really is a permanent dry-run (the reason the cron is gone)", () => {
    const src = read("backend", "scripts", "verdict-flip-push-fanout.cjs");
    expect(src).toContain("const dryRun = args.dryRun !== false;");
    expect(src).toContain("const out = { dryRun: true };");
    expect(src).not.toMatch(/apn\.Provider|sendToTokens|notification\.service/);
  });
  it("ingest health no longer monitors cardsight", () => {
    const src = read("backend", "src", "routes", "ingestHealth.routes.ts");
    expect(src).toContain('const KNOWN_SOURCES = ["cardhedge", "tca-ebay"];');
    expect(src).not.toMatch(/KNOWN_SOURCES = \[[^\]]*cardsight/);
  });
});

// ── P1-5 / P1-7 / P2-5 (2026-09-07) ──────────────────────────────────────
// Workflow-only fixes again have no unit under test, so the gate IS the text.
describe("P1-5. a failed deploy is no longer silent", () => {
  const yml = wf("daily-refresh.yml");
  const job = () => yml.slice(yml.indexOf("deploy-failure-alert:"));
  const cond = () => /^\s+if: (.*)$/m.exec(job())![1];

  it("the alert job exists, with the permission it needs and nothing more", () => {
    expect(yml).toContain("deploy-failure-alert:");
    expect(yml).toContain("needs: [deploy-and-refresh, reprice-holdings]");
    expect(job()).toContain("issues: write");
    // It files a ticket; it must never be able to push code.
    expect(job()).not.toMatch(/contents:\s*write/);
  });

  it("the condition is a single-line ${{ }} expression, never a >- folded block", () => {
    // A `>-` block folds newlines into spaces and yields a non-empty string,
    // which GitHub evaluates as TRUTHY regardless of the run's state — the
    // alert would then fire on every green nightly. Refuse the shape outright.
    const c = cond();
    expect(c.startsWith(">-")).toBe(false);
    expect(c.startsWith("|")).toBe(false);
    expect(c.trim().startsWith("${{")).toBe(true);
    expect(c.trim().endsWith("}}")).toBe(true);
    expect(c).toContain("!cancelled()");
  });

  it("it fires on job CONCLUSIONS, and only when the ET gate opened", () => {
    const c = cond();
    expect(c).toContain("needs.deploy-and-refresh.outputs.should_run == 'true'");
    expect(c).toContain("needs.deploy-and-refresh.result == 'failure'");
    expect(c).toContain("needs.reprice-holdings.result == 'failure'");
    // A sha proves a deploy ran, never that it worked (2026-09-04). Nothing
    // in the gate may key off one.
    expect(c).not.toMatch(/sha/i);
  });

  it("the smoke's engine_ok verdict reaches the issue body, outage vs stale fixture", () => {
    expect(job()).toContain("ENGINE_OK: ${{ needs.deploy-and-refresh.outputs.engine_ok }}");
    expect(job()).toMatch(/case "\$ENGINE_OK" in/);
    expect(job()).toContain("stale fixture expectation, not an outage");
    expect(job()).toContain("engine_ok=false");
  });

  it("the title carries the date and sha, and the labels are ops + deploy", () => {
    expect(job()).toContain('TITLE="DEPLOY FAILED $TODAY $SHA_SHORT"');
    expect(job()).toContain("--label ops --label deploy");
  });

  it("it names the failed STEPS and links the run, not just 'the job is red'", () => {
    expect(job()).toContain('select(.conclusion == "failure")');
    expect(job()).toContain("$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID");
  });

  it("a retry on the same broken commit threads instead of filing a second ticket", () => {
    expect(job()).toContain("gh issue list");
    expect(job()).toContain("gh issue comment");
    expect(job()).toMatch(/--state open --label deploy/);
  });

  it("needs no Azure login, no App Service read, and no new dispatch input", () => {
    // The alert must survive the failures it reports: an Azure outage or an
    // expired OIDC credential would otherwise take out the deploy and the
    // alert about the deploy together.
    expect(job()).not.toContain("azure/login");
    expect(job()).not.toContain("az webapp config appsettings");
    expect(job()).toContain("GH_TOKEN: ${{ github.token }}");
    // No secret is read here, so nothing needs masking.
    expect(job()).not.toContain("::add-mask::");
    // `on:` still offers exactly workflow_dispatch with no inputs.
    expect(yml.slice(0, yml.indexOf("jobs:"))).not.toContain("inputs:");
  });
});

describe("P1-7 + P2-5. the red scheduled jobs", () => {
  it("marketplace-listings-refresh reports its count from backend/ (P2-5)", () => {
    // Nine consecutive red nights: `Cannot find module '@azure/cosmos'` from
    // the repo root while deps install under backend/.
    expect(wf("marketplace-listings-refresh.yml")).toMatch(
      /- name: Report post-run listings count\n\s+working-directory: backend\n/,
    );
  });

  it("catalog-cardYear-backfill reports its coverage from backend/ (same cause)", () => {
    expect(wf("catalog-cardyear-backfill.yml")).toMatch(
      /- name: Report post-run coverage\n\s+working-directory: backend\n/,
    );
  });

  it("every inline `node -e` requiring @azure/cosmos can actually resolve it", () => {
    // The generalisation of the two fixes above. This defect has now shipped
    // four times, so pin the CLASS rather than the individual instances.
    //
    // The rule is RESOLVABILITY, not a fixed directory: a step may either run
    // from `backend/` (where npm ci installs) or run at the repo root in a
    // workflow that installed @azure/cosmos there. bcp-sweep.yml does the
    // latter and is green — a test demanding `working-directory: backend`
    // everywhere would have called it a defect and been wrong.
    const dir = path.join(ROOT, ".github", "workflows");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      const yml = read(".github", "workflows", f);
      const installsAtRoot = /npm i(nstall)? @azure\/cosmos[^\n]*\n/.test(
        yml.replace(/\n\s+working-directory: backend\n/g, "\n  WD_BACKEND\n"),
      );
      const steps = yml.split(/\n\s+- name: /).slice(1);
      for (const step of steps) {
        if (!/require\(["']@azure\/cosmos["']\)/.test(step)) continue;
        const head = step.slice(0, step.indexOf("run:"));
        const runsInBackend = /working-directory:\s*backend/.test(head);
        if (!runsInBackend && !installsAtRoot) {
          offenders.push(`${f} -> ${step.split("\n")[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catalog-gap-digest survives the protected-branch push it can never win", () => {
    const yml = wf("catalog-gap-digest.yml");
    // `main` requires 2 status checks, so a cron's direct push is always
    // refused (GH006). The digest has already been MAILED by this point.
    expect(yml).toContain("::notice::push to protected main refused (expected)");
    expect(yml).toMatch(/if git push origin HEAD:main 2>\/dev\/null; then/);
    // The report still has to survive somewhere, or the diff loses its memory.
    expect(yml).toContain("uses: actions/upload-artifact@v4");
    expect(yml).toContain("path: backend/data/gap-reports/");
  });

  it("nightly-slug-backfill's idle floor is the one Azure actually accepts", () => {
    const yml = wf("nightly-slug-backfill.yml");
    // 4000 (until 08-18) and 8000 (until 09-07) were both under the floor, so
    // the teardown failed EVERY run and parked sold_comps at the 40000 working
    // ceiling — the exact bill the scale-down exists to avoid.
    expect(yml).toContain('SOLD_IDLE_MAX: "10000"');
    expect(yml).not.toContain('SOLD_IDLE_MAX: "8000"');
    expect(yml).toContain("Highest RUs provisioned");
  });

  it("cosmos-throughput lands on the floor Azure names instead of failing on a stale one", () => {
    const src = read("backend", "scripts", "cosmos-throughput.cjs");
    // The floor is a high-water mark: it only ever rises, so any hardcoded
    // idle number goes stale the next time the container is provisioned up.
    expect(src).toMatch(/required minimum throughput \(\\d\+\)/);
    expect(src).toContain("is below the autoscale floor Azure reports");
    // A rejection for any OTHER reason must still throw.
    expect(src).toContain("if (!Number.isFinite(floor) || floor <= target) throw e;");
    // The readback must compare against what was actually attempted.
    expect(src).toContain("if (landed !== intended)");
  });

  it("tca-firehose tells a reconciliation red apart from a quota cap", () => {
    const yml = wf("tca-firehose-ingest.yml");
    // 2026-09-07 wrote 915 rows and still reported "wrote nothing on every
    // platform ... quota exhausted" with 199,998 calls remaining.
    expect(yml).toContain("This is NOT a quota cap");
    expect(yml).toMatch(/4\) PLATFORMS_OK=\$\(\(PLATFORMS_OK\+1\)\)/);
    expect(yml).toContain("RECONCILE_RED=1");
    // Still red — exit 4 is a real signal, just a different one.
    expect(yml).toMatch(
      /if \[ "\$\{RECONCILE_RED:-0\}" -eq 1 \]; then\n(\s+#[^\n]*\n)*\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi/,
    );
  });
});
