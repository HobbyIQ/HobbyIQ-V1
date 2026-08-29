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
