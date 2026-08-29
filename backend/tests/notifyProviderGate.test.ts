// D13 (2026-08-29) — alert gates prove delivery. The four admin notify
// crons gated on HTTP 200 only; watchlist-digest and grade-worthy exited 0
// "regardless of sent count". With no APNs provider every push no-ops and
// pushesSent:0 looks like a quiet night. Pins:
//   - the two notify services report pushProviderConfigured (behavioral)
//   - the three admin routes spread pushProviderConfigured into .summary
//   - the two push scripts go red on a scheduled run without a provider
//   - the three admin workflows print the one summary line and exit 1 on a
//     scheduled non-dry-run with providerConfigured=false, reading the
//     boolean with has() (jq's // treats false as missing)
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const providerMock = vi.fn<[], boolean>();
vi.mock("../src/services/notification.service.js", () => ({
  isPushProviderConfigured: () => providerMock(),
  sendWatchlistDigestNotification: async () => ({ sent: 0, failed: 0, removedTokens: 0 }),
  sendGradeWorthyNotification: async () => ({ sent: 0, failed: 0, removedTokens: 0 }),
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  listUsersWithWatchlistOptIn: async () => [],
  listUsersWithGradeWorthyOptIn: async () => [],
}));

const { sendWatchlistDigestsForOptedInUsers } = await import(
  "../src/services/portfolioiq/watchlistDigestNotify.service.js"
);
const { sendGradeWorthyPushesForOptedInUsers } = await import(
  "../src/services/portfolioiq/gradeWorthyPushNotify.service.js"
);

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

beforeEach(() => { providerMock.mockReset(); });

describe("notify services report pushProviderConfigured", () => {
  it("watchlist digest: false when the provider is missing, true when present", async () => {
    providerMock.mockReturnValue(false);
    expect((await sendWatchlistDigestsForOptedInUsers()).pushProviderConfigured).toBe(false);
    providerMock.mockReturnValue(true);
    expect((await sendWatchlistDigestsForOptedInUsers()).pushProviderConfigured).toBe(true);
  });
  it("grade-worthy: false when the provider is missing, true when present", async () => {
    providerMock.mockReturnValue(false);
    expect((await sendGradeWorthyPushesForOptedInUsers()).pushProviderConfigured).toBe(false);
    providerMock.mockReturnValue(true);
    expect((await sendGradeWorthyPushesForOptedInUsers()).pushProviderConfigured).toBe(true);
  });
});

describe("admin notify routes spread pushProviderConfigured into the summary", () => {
  const src = read("backend", "src", "routes", "ebayImportRematch.routes.ts");
  for (const route of ["sell-side-notify/run", "personal-prospect-breakout/run", "grade-arbitrage-notify/run"]) {
    it(route, () => {
      const start = src.indexOf(`"/admin/${route}"`);
      expect(start).toBeGreaterThan(0);
      const body = src.slice(start, src.indexOf("\n});", start));
      expect(body).toContain("summary: { ...summary, pushProviderConfigured: isPushProviderConfigured() }");
    });
  }
});

describe("push scripts go red on a scheduled run without a provider", () => {
  for (const script of ["send-watchlist-digest.cjs", "send-grade-worthy-push.cjs"]) {
    it(script, () => {
      const src = read("backend", "scripts", script);
      expect(src).toContain("pushProviderConfigured: result.pushProviderConfigured === true");
      expect(src).toContain("process.exit(pushProviderExitCode(result.pushProviderConfigured === true, process.env))");
      expect(src).toMatch(/env\.GITHUB_EVENT_NAME === "schedule"/);
      expect(src).toMatch(/if \(scheduled\) \{ console\.error\(`::error::\$\{line\}`\); return 1; \}/);
      expect(src).not.toContain("0 completed (regardless of sent count)");
    });
  }
});

describe("admin notify workflows assert the summary", () => {
  const cases: Array<[string, string]> = [
    ["grade-arbitrage-notify-nightly.yml", ".summary.candidatesForNotify"],
    ["sell-side-notify-nightly.yml", ".summary.candidatesForNotify"],
    ["personal-prospect-breakout-nightly.yml", ".summary.matches"],
  ];
  for (const [wf, candidatesPath] of cases) {
    it(wf, () => {
      const yml = read(".github", "workflows", wf);
      expect(yml).toContain("EVENT_NAME: ${{ github.event_name }}");
      expect(yml).toContain(`CANDIDATES=$(jq -r '${candidatesPath} // 0' response.json)`);
      expect(yml).toContain(`has("pushProviderConfigured")`);
      expect(yml).toContain('echo "notify summary: candidates=$CANDIDATES pushesSent=$PUSHES providerConfigured=$CONFIGURED"');
      expect(yml).toMatch(/if \[ "\$EVENT_NAME" = "schedule" \] && \[ "\$DRY_RUN" != "true" \] && \[ "\$CONFIGURED" = "false" \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi/);
      // The boolean must never be read through // (false would read as missing).
      expect(yml).not.toMatch(/pushProviderConfigured \/\//);
    });
  }
});
