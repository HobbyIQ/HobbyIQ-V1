// The buyeriq_deal_scan_summary trace IS the deal-scanner canary's heartbeat
// (#1967): the canary measures "the scanner is dead" by its absence. So every
// exit from runBuyerIqDealScan must emit exactly one — including the paths
// that used to return silently, which were indistinguishable from a scheduler
// that never ran.
//
// AND IT MUST GO OUT ON stderr (2026-09-09). #1982 set the App Insights console
// subscriber to `logSendingLevel: WARN`, which keeps stderr (console.error /
// console.warn) and DROPS stdout (console.log / console.info). This heartbeat
// was on stdout, so it silently stopped reaching App Insights on each role's
// #1982 deploy while the scan itself kept running — 24h of zero heartbeats
// against a live scanner, which is exactly the false "scanner is dead" verdict
// the canary exists to avoid. `emitsOnStderrNotStdout` below is the pin: it
// fails if the heartbeat ever moves back to a stream the filter drops.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listTargets = vi.fn();

vi.mock("../src/services/buyeriq/buyeriqStore.service.js", () => ({}));
vi.mock("../src/services/compiq/oneValuationPath.service.js", () => ({
  valueIdentity: vi.fn(async () => null),
}));
vi.mock("../src/services/ebay/ebayListingSearch.service.js", () => ({
  fetchCardActiveListings: vi.fn(async () => []),
}));
vi.mock("../src/services/notification.service.js", () => ({
  sendBuyerIqDealNotification: vi.fn(async () => ({ sent: 0 })),
}));
vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() {
      return {
        container: () => ({
          items: {
            query: () => ({ fetchAll: listTargets }),
            upsert: vi.fn(async () => ({})),
          },
          item: () => ({ read: vi.fn(async () => ({ resource: undefined })) }),
        }),
      };
    }
  },
}));

const { runBuyerIqDealScan } = await import("../src/services/buyeriq/buyerIqDealScanner.service.js");

function summaries(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("buyeriq_deal_scan_summary"))
    .map((m) => JSON.parse(m));
}

describe("deal scan summary is emitted on every exit path", () => {
  let logSpy: any;   // stdout — must NEVER carry the heartbeat
  let warnSpy: any;  // stderr — the stream App Insights keeps
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listTargets.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BUYERIQ_DEAL_SCANNER_DISABLE;
  });

  it("emits a heartbeat on a zero-target cycle", async () => {
    listTargets.mockResolvedValue({ resources: [] });
    await runBuyerIqDealScan();
    const s = summaries(warnSpy);
    expect(s).toHaveLength(1);
    expect(s[0].outcome).toBe("ok");
    expect(s[0].targetsScanned).toBe(0);
  });

  it("emits a heartbeat when disabled by env — a silent return looked like a dead job", async () => {
    process.env.BUYERIQ_DEAL_SCANNER_DISABLE = "true";
    await runBuyerIqDealScan();
    const s = summaries(warnSpy);
    expect(s).toHaveLength(1);
    expect(s[0].outcome).toBe("disabled");
  });

  it("emits a heartbeat when listing the targets throws", async () => {
    listTargets.mockRejectedValue(new Error("cosmos down"));
    await runBuyerIqDealScan();
    const s = summaries(warnSpy);
    expect(s).toHaveLength(1);
    expect(s[0].outcome).toBe("error");
    expect(s[0].errors).toBe(1);
  });

  // THE REGRESSION PIN. App Insights keeps stderr and drops stdout under
  // `logSendingLevel: WARN` (#1982). A heartbeat on stdout is invisible to the
  // canary no matter how faithfully it is emitted, which is how the scanner
  // read as dead for 24h while it was running fine.
  it("emits the heartbeat on stderr, not stdout — stdout is dropped by the WARN filter", async () => {
    listTargets.mockResolvedValue({ resources: [] });
    await runBuyerIqDealScan();
    expect(summaries(warnSpy)).toHaveLength(1);
    expect(summaries(logSpy)).toHaveLength(0);
  });

  it("emits the heartbeat on stderr on every exit path, never on stdout", async () => {
    // disabled
    process.env.BUYERIQ_DEAL_SCANNER_DISABLE = "true";
    await runBuyerIqDealScan();
    delete process.env.BUYERIQ_DEAL_SCANNER_DISABLE;
    // error
    listTargets.mockRejectedValue(new Error("cosmos down"));
    await runBuyerIqDealScan();
    // ok
    listTargets.mockReset();
    listTargets.mockResolvedValue({ resources: [] });
    await runBuyerIqDealScan();

    expect(summaries(warnSpy).map((x) => x.outcome)).toEqual(["disabled", "error", "ok"]);
    expect(summaries(logSpy)).toHaveLength(0);
  });
});
