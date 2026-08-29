// D13 (2026-08-29) — alert gates prove delivery. DailyIQ stamped the day
// `notifiedAt` even when the APNs provider was missing: every send
// no-op'd, pushesSent=0, and the idempotency gate then refused a re-run
// for the rest of the day. Pins:
//   provider null                 → day NOT marked, warn event emitted
//   provider present, 0 opted-in  → day marked (a legitimate zero)
//   provider present, N opted-in  → day marked, sends attempted
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const markNotifiedMock = vi.fn<[string], Promise<void>>();
const getTopPlayersMock = vi.fn<[string], Promise<{ notifiedAt?: string } | null>>();
const saveTopPlayersMock = vi.fn<any, Promise<void>>();
const prefsMock = vi.fn<[], Promise<Array<{ userId: string }>>>();
const sendMock = vi.fn<any, Promise<{ sent: number; failed: number; removedTokens: number }>>();
const providerMock = vi.fn<[], boolean>();

vi.mock("../src/routes/dailyiq.routes.js", () => ({
  buildDailyBrief: async () => ({
    mlb: [{ playerId: "p1", playerName: "Paul Skenes", league: "MLB" }],
    milb: [],
  }),
}));
vi.mock("../src/repositories/dailyiq.repository.js", () => ({
  saveTopPlayers: (...a: unknown[]) => (saveTopPlayersMock as any)(...a),
  markNotified: (...a: unknown[]) => (markNotifiedMock as any)(...a),
  getTopPlayers: (...a: unknown[]) => (getTopPlayersMock as any)(...a),
}));
vi.mock("../src/repositories/alertPreferences.repository.js", () => ({
  getAllDailyIQAlertPreferences: () => prefsMock(),
}));
vi.mock("../src/services/dailyiq/watchlistStore.service.js", () => ({
  getWatchlistSet: async () => new Set<string>(),
}));
vi.mock("../src/services/notification.service.js", () => ({
  sendDailyIQNotification: (...a: unknown[]) => (sendMock as any)(...a),
  isPushProviderConfigured: () => providerMock(),
}));

const { runDailyIQJob } = await import("../src/jobs/dailyiq.job.js");

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  markNotifiedMock.mockReset().mockResolvedValue(undefined);
  getTopPlayersMock.mockReset().mockResolvedValue(null);
  saveTopPlayersMock.mockReset().mockResolvedValue(undefined);
  prefsMock.mockReset();
  sendMock.mockReset().mockResolvedValue({ sent: 0, failed: 0, removedTokens: 0 });
  providerMock.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function warnEvents(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
    .filter((x): x is Record<string, unknown> => !!x && typeof x.event === "string");
}

describe("DailyIQ marks the day only when a push was attempted", () => {
  it("provider missing → the day is NOT marked and dailyiq_push_provider_missing is emitted", async () => {
    providerMock.mockReturnValue(false);
    prefsMock.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
    const r = await runDailyIQJob();
    expect(markNotifiedMock).not.toHaveBeenCalled();
    expect(r.marked).toBe(false);
    expect(r.pushProviderConfigured).toBe(false);
    const ev = warnEvents().find((e) => e.event === "dailyiq_push_provider_missing");
    expect(ev).toBeTruthy();
    expect(ev!.optedInUsers).toBe(2);
    expect(ev!.date).toBe(r.date);
  });

  it("provider present + zero opted-in users → still marked (a legitimate zero)", async () => {
    providerMock.mockReturnValue(true);
    prefsMock.mockResolvedValue([]);
    const r = await runDailyIQJob();
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledWith(r.date);
    expect(r.marked).toBe(true);
    expect(r.pushesSent).toBe(0);
    expect(warnEvents().find((e) => e.event === "dailyiq_push_provider_missing")).toBeUndefined();
  });

  it("provider present + opted-in users → sends attempted and the day marked", async () => {
    providerMock.mockReturnValue(true);
    prefsMock.mockResolvedValue([{ userId: "u1" }]);
    sendMock.mockResolvedValue({ sent: 1, failed: 0, removedTokens: 0 });
    const r = await runDailyIQJob();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(r.marked).toBe(true);
    expect(r.usersNotified).toBe(1);
  });

  it("an unmarked day is re-runnable: the idempotency gate only trips on notifiedAt", async () => {
    providerMock.mockReturnValue(true);
    prefsMock.mockResolvedValue([{ userId: "u1" }]);
    getTopPlayersMock.mockResolvedValue({ notifiedAt: "2026-08-29T13:00:00Z" });
    const r = await runDailyIQJob();
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.marked).toBe(true);
    expect(r.pushesSent).toBe(0);
  });
});
