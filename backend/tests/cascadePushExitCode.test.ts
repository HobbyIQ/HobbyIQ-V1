// D13 (2026-08-29) — alert gates prove delivery. The cascade nightly ran
// for six weeks with `pushSent: 0` and exit 0: cascade-detect.yml never
// passed the APNs env, the provider was null, every send no-op'd. Two
// pins: (1) the exit-code decision's truth table — red ONLY when events
// were owed to opted-in users and the sender did not exist; (2) the
// fan-out surfaces `optedInUsers`, the number the decision needs, because
// `sent` alone cannot tell "nobody to notify" from "sender missing".
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CascadeEvent } from "../src/types/cascadeAlert.types.js";

const sendMock = vi.fn<any, Promise<{ sent: number; failed: number; removedTokens: number }>>();
const ownersMock = vi.fn<[string], Promise<Array<{ userId: string; apnsDeviceToken: string | null }>>>();

vi.mock("../src/services/notification.service.js", () => ({
  sendCascadeAlertNotification: (...args: unknown[]) => (sendMock as any)(...args),
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  listUsersOwningPlayerWithCascadeOptIn: (...args: unknown[]) => (ownersMock as any)(...args),
}));

const { cascadePushExitCode, sendCascadeAlertsForNewEvents } = await import(
  "../src/services/portfolioiq/cascadeNotify.service.js"
);

function mkEvent(overrides: Partial<CascadeEvent> = {}): CascadeEvent {
  return {
    player: "Paul Skenes",
    playerSlug: "paul_skenes",
    detectedAt: "2026-08-29T04:45:00Z",
    detectionInput: {
      rawMomentum: 1.02, gradedMomentum: 1.3, momentumRatio: 1.275, gradedDirection: "up",
      rawQualifyingCards: 6, gradedQualifyingCards: 5, playerTrendComputedAt: "2026-08-29T03:45:00Z",
    },
    severity: "insider",
    reason: "Graded +30% while raw +2%",
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  ownersMock.mockReset();
});

describe("cascadePushExitCode — the truth table", () => {
  it("RED: new events owed to opted-in users, provider missing (the six-week defect)", () => {
    expect(cascadePushExitCode({ newEvents: 3, optedInUsers: 2, providerConfigured: false })).toBe(1);
  });
  it("green: provider configured, even at zero sends", () => {
    expect(cascadePushExitCode({ newEvents: 3, optedInUsers: 2, providerConfigured: true })).toBe(0);
  });
  it("green: no new events — nothing was owed", () => {
    expect(cascadePushExitCode({ newEvents: 0, optedInUsers: 0, providerConfigured: false })).toBe(0);
  });
  it("green: new events but no opted-in owner — a legitimate zero", () => {
    expect(cascadePushExitCode({ newEvents: 3, optedInUsers: 0, providerConfigured: false })).toBe(0);
  });
});

describe("sendCascadeAlertsForNewEvents — surfaces optedInUsers", () => {
  it("counts opted-in owners across pushable events even when every send no-ops (provider null)", async () => {
    // A null provider returns sent:0 from the wire layer — exactly the
    // shape the nightly saw. The owners were still found.
    sendMock.mockResolvedValue({ sent: 0, failed: 0, removedTokens: 0 });
    ownersMock
      .mockResolvedValueOnce([{ userId: "u1", apnsDeviceToken: "t1" }, { userId: "u2", apnsDeviceToken: "t2" }])
      .mockResolvedValueOnce([{ userId: "u3", apnsDeviceToken: "t3" }]);
    const r = await sendCascadeAlertsForNewEvents([
      mkEvent({ player: "A", playerSlug: "a" }),
      mkEvent({ player: "B", playerSlug: "b", severity: "emerging" }),
    ]);
    expect(r.optedInUsers).toBe(3);
    expect(r.sent).toBe(0);
    expect(cascadePushExitCode({ newEvents: 2, optedInUsers: r.optedInUsers, providerConfigured: false })).toBe(1);
  });

  it("does not count owners of non-pushable (confirmed) events", async () => {
    ownersMock.mockResolvedValue([{ userId: "u1", apnsDeviceToken: "t1" }]);
    const r = await sendCascadeAlertsForNewEvents([mkEvent({ severity: "confirmed" })]);
    expect(ownersMock).not.toHaveBeenCalled();
    expect(r.optedInUsers).toBe(0);
  });
});
