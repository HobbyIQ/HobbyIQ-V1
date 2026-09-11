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
// Every container.items.upsert() call, across every container name, recorded
// here so a test can isolate the heartbeat doc's writes from
// buyeriq_deals_sent's without the two mocks colliding.
const upsertCalls: Array<{ container: string; doc: any }> = [];
// When set, upsert() on this container name rejects — used to simulate a
// Cosmos write outage on just the heartbeat container without touching the
// target-listing read path.
let upsertFailsFor: string | null = null;

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
        container: (name: string) => ({
          items: {
            query: () => ({ fetchAll: listTargets }),
            upsert: vi.fn(async (doc: any) => {
              upsertCalls.push({ container: name, doc });
              if (upsertFailsFor === name) throw new Error(`cosmos write down: ${name}`);
              return {};
            }),
          },
          item: () => ({ read: vi.fn(async () => ({ resource: undefined })) }),
        }),
      };
    }
  },
}));

const { runBuyerIqDealScan, heartbeatDocId, HEARTBEAT_CONTROL_CONTAINER } = await import(
  "../src/services/buyeriq/buyerIqDealScanner.service.js"
);

function summaries(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("buyeriq_deal_scan_summary"))
    .map((m) => JSON.parse(m));
}

function heartbeatDocWrites(): any[] {
  return upsertCalls
    .filter((c) => c.container === HEARTBEAT_CONTROL_CONTAINER && c.doc?.id === heartbeatDocId())
    .map((c) => c.doc);
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
    upsertCalls.length = 0;
    upsertFailsFor = null;
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

// The trace heartbeat is sampled away 90% of the time on App Insights (10%
// ingestion sampling): an hourly summary yields ~2.4 raw rows per 24h window,
// so P(zero rows) is ~9% by construction even on a scanner that ran every
// cycle. A durable Cosmos doc — one row, upserted in place, point-readable —
// cannot be sampled away, so the canary now reads that doc first. This block
// pins that the doc is written on every exit path, not just the trace.
describe("the durable heartbeat doc is upserted on every exit path (a point-read App Insights sampling cannot drop)", () => {
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    listTargets.mockReset();
    upsertCalls.length = 0;
    upsertFailsFor = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BUYERIQ_DEAL_SCANNER_DISABLE;
  });

  it("upserts the heartbeat doc into rematch_control, id heartbeat::buyeriq.deal.scanner, on a clean ok cycle", async () => {
    listTargets.mockResolvedValue({ resources: [] });
    const summary = await runBuyerIqDealScan();
    const writes = heartbeatDocWrites();
    expect(writes).toHaveLength(1);
    expect(HEARTBEAT_CONTROL_CONTAINER).toBe("rematch_control");
    expect(heartbeatDocId()).toBe("heartbeat::buyeriq.deal.scanner");
    expect(writes[0]).toMatchObject({
      id: "heartbeat::buyeriq.deal.scanner",
      outcome: "ok",
      lastRunAt: summary.finishedAt,
      targetsScanned: 0,
      errors: 0,
    });
  });

  it("upserts the doc when disabled by env — a silent return must still leave a fresh marker", async () => {
    process.env.BUYERIQ_DEAL_SCANNER_DISABLE = "true";
    await runBuyerIqDealScan();
    const writes = heartbeatDocWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].outcome).toBe("disabled");
  });

  it("upserts the doc when listing targets throws — an errored cycle must still be visible to the canary", async () => {
    listTargets.mockRejectedValue(new Error("cosmos down"));
    await runBuyerIqDealScan();
    const writes = heartbeatDocWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].outcome).toBe("error");
    expect(writes[0].errors).toBe(1);
  });

  it("upserts the doc on every exit path in one run, ok/disabled/error alike, one write per cycle", async () => {
    process.env.BUYERIQ_DEAL_SCANNER_DISABLE = "true";
    await runBuyerIqDealScan();
    delete process.env.BUYERIQ_DEAL_SCANNER_DISABLE;

    listTargets.mockRejectedValue(new Error("cosmos down"));
    await runBuyerIqDealScan();

    listTargets.mockReset();
    listTargets.mockResolvedValue({ resources: [] });
    await runBuyerIqDealScan();

    const writes = heartbeatDocWrites();
    expect(writes.map((d) => d.outcome)).toEqual(["disabled", "error", "ok"]);
  });

  it("carries a roleInstance from WEBSITE_ROLE_INSTANCE_ID when the process has one", async () => {
    process.env.WEBSITE_ROLE_INSTANCE_ID = "hobbyiq3-worker-abc123";
    listTargets.mockResolvedValue({ resources: [] });
    await runBuyerIqDealScan();
    expect(heartbeatDocWrites()[0].roleInstance).toBe("hobbyiq3-worker-abc123");
    delete process.env.WEBSITE_ROLE_INSTANCE_ID;
  });

  // A Cosmos failure writing the doc must never take the scan down with it —
  // writeHeartbeatDoc's try/catch is what this pins, per the same
  // never-fatal doctrine as every other Cosmos accessor in this file.
  it("a failing doc upsert does not fail the scan — runBuyerIqDealScan still resolves and the trace still fires", async () => {
    upsertFailsFor = HEARTBEAT_CONTROL_CONTAINER;
    listTargets.mockResolvedValue({ resources: [] });
    const warnSpy = vi.spyOn(console, "warn");
    await expect(runBuyerIqDealScan()).resolves.toMatchObject({ targetsScanned: 0 });
    // The write was ATTEMPTED (the mock records the call before throwing) but
    // the throw itself must not propagate — the trace heartbeat, the
    // pre-existing fallback signal, still went out regardless.
    expect(heartbeatDocWrites()).toHaveLength(1);
    expect(summaries(warnSpy)).toHaveLength(1);
    upsertFailsFor = null;
  });
});
