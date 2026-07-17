// CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Pinning tests for the
// cascade fan-out worker. APNs sender + Cosmos owner lookup are both
// mocked so this file exercises only the policy layer:
//
//   1. Severity gate: insider + emerging fire, confirmed does NOT
//   2. Opt-in gate: users without pushOnCascade are never queried (the
//      store helper returns empty and the sender is never called)
//   3. Ownership gate: users whose holdings don't match the player are
//      never notified
//   4. Best-effort semantics: a single-owner send failure does not
//      abort the batch — later owners still receive their push
//   5. Aggregate counts are surfaced back to the caller (nightly)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CascadeEvent } from "../src/types/cascadeAlert.types.js";

// ── Hoisted mocks ────────────────────────────────────────────────────
//
// The service-under-test statically imports both notification.service
// and portfolioStore.service, so mocks must be registered before the
// dynamic import below.

const sendCascadeAlertNotificationMock = vi.fn<
  [
    string,
    {
      player: string;
      playerSlug: string;
      severity: "insider" | "emerging" | "confirmed";
      momentumRatio: number;
      reason: string;
    },
  ],
  Promise<{ sent: number; failed: number; removedTokens: number }>
>();

const listUsersOwningPlayerWithCascadeOptInMock = vi.fn<
  [string],
  Promise<Array<{ userId: string; apnsDeviceToken: string | null }>>
>();

vi.mock("../src/services/notification.service.js", () => ({
  sendCascadeAlertNotification: (...args: unknown[]) =>
    (sendCascadeAlertNotificationMock as any)(...args),
}));

vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  listUsersOwningPlayerWithCascadeOptIn: (...args: unknown[]) =>
    (listUsersOwningPlayerWithCascadeOptInMock as any)(...args),
}));

const { sendCascadeAlertsForNewEvents, _PUSHABLE_SEVERITIES } = await import(
  "../src/services/portfolioiq/cascadeNotify.service.js"
);

function mkEvent(overrides: Partial<CascadeEvent> = {}): CascadeEvent {
  return {
    player: "Paul Skenes",
    playerSlug: "paul_skenes",
    detectedAt: "2026-07-17T04:45:00Z",
    detectionInput: {
      rawMomentum: 1.02,
      gradedMomentum: 1.30,
      momentumRatio: 1.275,
      gradedDirection: "up",
      rawQualifyingCards: 6,
      gradedQualifyingCards: 5,
      playerTrendComputedAt: "2026-07-17T03:45:00Z",
    },
    severity: "insider",
    reason: "Graded +30% while raw +2% — early insider signal",
    ...overrides,
  };
}

beforeEach(() => {
  sendCascadeAlertNotificationMock.mockReset();
  listUsersOwningPlayerWithCascadeOptInMock.mockReset();
  // Default: sender returns a 1-sent success; suite overrides per test.
  sendCascadeAlertNotificationMock.mockResolvedValue({ sent: 1, failed: 0, removedTokens: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendCascadeAlertsForNewEvents — severity gate", () => {
  it("fires push for insider-severity events", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([
      { userId: "user-1", apnsDeviceToken: "tok-1" },
    ]);
    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ severity: "insider" }),
    ]);
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ severity: "insider", player: "Paul Skenes" }),
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("fires push for emerging-severity events", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([
      { userId: "user-2", apnsDeviceToken: "tok-2" },
    ]);
    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ severity: "emerging" }),
    ]);
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledWith(
      "user-2",
      expect.objectContaining({ severity: "emerging" }),
    );
    expect(result.sent).toBe(1);
  });

  it("does NOT fire push for confirmed-severity events (too noisy)", async () => {
    // Owner lookup should not even be attempted for skipped severities.
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([
      { userId: "user-3", apnsDeviceToken: "tok-3" },
    ]);
    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ severity: "confirmed" }),
    ]);
    expect(listUsersOwningPlayerWithCascadeOptInMock).not.toHaveBeenCalled();
    expect(sendCascadeAlertNotificationMock).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("_PUSHABLE_SEVERITIES contract: exactly insider + emerging", () => {
    expect([..._PUSHABLE_SEVERITIES].sort()).toEqual(["emerging", "insider"]);
  });
});

describe("sendCascadeAlertsForNewEvents — opt-in + ownership gates", () => {
  it("skips users who have not opted in (owner lookup returns empty)", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([]);
    const result = await sendCascadeAlertsForNewEvents([mkEvent()]);
    expect(listUsersOwningPlayerWithCascadeOptInMock).toHaveBeenCalledTimes(1);
    expect(sendCascadeAlertNotificationMock).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("skips users whose holdings don't include the event's player", async () => {
    // The store helper is authoritative on ownership: an empty result
    // means either no opt-in or no owned holding for this player. The
    // fan-out worker treats both the same — nothing to send.
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([]);
    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ player: "Jackson Chourio", playerSlug: "jackson_chourio" }),
    ]);
    expect(sendCascadeAlertNotificationMock).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("passes the event's player display name (not slug) to the lookup", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([]);
    await sendCascadeAlertsForNewEvents([
      mkEvent({ player: "Ronald Acuna Jr", playerSlug: "ronald_acuna_jr" }),
    ]);
    expect(listUsersOwningPlayerWithCascadeOptInMock).toHaveBeenCalledWith(
      "Ronald Acuna Jr",
    );
  });
});

describe("sendCascadeAlertsForNewEvents — best-effort semantics", () => {
  it("continues to later owners after a per-owner send failure", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([
      { userId: "user-fail", apnsDeviceToken: "tok-fail" },
      { userId: "user-ok", apnsDeviceToken: "tok-ok" },
    ]);
    // First call throws, second succeeds.
    sendCascadeAlertNotificationMock
      .mockRejectedValueOnce(new Error("network flake"))
      .mockResolvedValueOnce({ sent: 1, failed: 0, removedTokens: 0 });

    const result = await sendCascadeAlertsForNewEvents([mkEvent()]);

    // Both owners were attempted despite the first-owner throw.
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("continues to later EVENTS after a per-event owner-lookup failure", async () => {
    // First event's owner lookup throws; second event's succeeds.
    listUsersOwningPlayerWithCascadeOptInMock
      .mockRejectedValueOnce(new Error("cosmos throttle"))
      .mockResolvedValueOnce([{ userId: "user-late", apnsDeviceToken: "tok-late" }]);

    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ player: "First Player", playerSlug: "first_player" }),
      mkEvent({ player: "Second Player", playerSlug: "second_player" }),
    ]);

    expect(listUsersOwningPlayerWithCascadeOptInMock).toHaveBeenCalledTimes(2);
    // Only the second event's owner receives a push.
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledWith(
      "user-late",
      expect.objectContaining({ player: "Second Player" }),
    );
    expect(result.sent).toBe(1);
  });

  it("aggregates sent+failed counts across the batch", async () => {
    listUsersOwningPlayerWithCascadeOptInMock
      .mockResolvedValueOnce([{ userId: "user-a", apnsDeviceToken: "tok-a" }])
      .mockResolvedValueOnce([{ userId: "user-b", apnsDeviceToken: "tok-b" }]);
    sendCascadeAlertNotificationMock
      .mockResolvedValueOnce({ sent: 2, failed: 1, removedTokens: 0 })
      .mockResolvedValueOnce({ sent: 3, failed: 0, removedTokens: 0 });

    const result = await sendCascadeAlertsForNewEvents([
      mkEvent({ player: "P1", playerSlug: "p1" }),
      mkEvent({ player: "P2", playerSlug: "p2" }),
    ]);

    expect(result.sent).toBe(5);
    expect(result.failed).toBe(1);
  });
});

describe("sendCascadeAlertsForNewEvents — payload shape", () => {
  it("forwards player, playerSlug, severity, momentumRatio, reason to the sender", async () => {
    listUsersOwningPlayerWithCascadeOptInMock.mockResolvedValue([
      { userId: "user-pl", apnsDeviceToken: "tok-pl" },
    ]);
    await sendCascadeAlertsForNewEvents([
      mkEvent({
        player: "Eric Hartman",
        playerSlug: "eric_hartman",
        severity: "emerging",
        detectionInput: {
          rawMomentum: 1.10,
          gradedMomentum: 1.55,
          momentumRatio: 1.409,
          gradedDirection: "up",
          rawQualifyingCards: 4,
          gradedQualifyingCards: 4,
          playerTrendComputedAt: "2026-07-17T03:45:00Z",
        },
        reason: "Graded +55% is 40.9% ahead of raw +10% — cascade emerging",
      }),
    ]);

    expect(sendCascadeAlertNotificationMock).toHaveBeenCalledWith("user-pl", {
      player: "Eric Hartman",
      playerSlug: "eric_hartman",
      severity: "emerging",
      momentumRatio: 1.409,
      reason: "Graded +55% is 40.9% ahead of raw +10% — cascade emerging",
    });
  });

  it("empty input array returns zero counts and never queries the store", async () => {
    const result = await sendCascadeAlertsForNewEvents([]);
    expect(listUsersOwningPlayerWithCascadeOptInMock).not.toHaveBeenCalled();
    expect(sendCascadeAlertNotificationMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });
});
