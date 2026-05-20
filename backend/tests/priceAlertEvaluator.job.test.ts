import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PriceAlert } from "../src/repositories/priceAlerts.repository.js";

// --- Hoisted mocks ----------------------------------------------------------
// vi.mock() is hoisted; the evaluator imports these modules statically so we
// must intercept them at module-graph time.

const listAllActiveAlertsMock = vi.fn<[], Promise<PriceAlert[]>>();
const recordAlertEvaluationMock = vi.fn<
  [string, string, { currentPrice: number | null; triggered: boolean }],
  Promise<void>
>();
const computeEstimateMock = vi.fn<[unknown], Promise<Record<string, unknown>>>();
const sendPriceAlertNotificationMock = vi.fn<
  [string, { title: string; body: string; cardId: string; alertId: string }],
  Promise<{ sent: number; failed: number }>
>();

vi.mock("../src/repositories/priceAlerts.repository.js", () => ({
  listAllActiveAlerts: (...args: unknown[]) =>
    (listAllActiveAlertsMock as any)(...args),
  recordAlertEvaluation: (...args: unknown[]) =>
    (recordAlertEvaluationMock as any)(...args),
}));

vi.mock("../src/services/compiq/compiqEstimate.service.js", () => ({
  computeEstimate: (...args: unknown[]) => (computeEstimateMock as any)(...args),
}));

vi.mock("../src/services/notification.service.js", () => ({
  sendPriceAlertNotification: (...args: unknown[]) =>
    (sendPriceAlertNotificationMock as any)(...args),
}));

// Import the module-under-test AFTER mocks are registered.
const { runPriceAlertEvaluator } = await import(
  "../src/jobs/priceAlertEvaluator.job.js"
);

function makeAlert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    alertId: "alert-1",
    userId: "user-1",
    cardId: "card-1",
    playerName: "Mike Trout",
    targetPrice: 50,
    direction: "above",
    currentPrice: null,
    createdAt: "2026-01-01T00:00:00Z",
    triggeredAt: null,
    isActive: true,
    cardSnapshot: {
      playerName: "Mike Trout",
      year: 2011,
      setName: "Topps Update",
      cardNumber: "US175",
      grade: "PSA 10",
      variant: null,
      printRun: null,
      isRookie: true,
    },
    ...overrides,
  };
}

describe("priceAlertEvaluator — Apify-to-CompIQ migration", () => {
  beforeEach(() => {
    listAllActiveAlertsMock.mockReset();
    recordAlertEvaluationMock.mockReset();
    computeEstimateMock.mockReset();
    sendPriceAlertNotificationMock.mockReset();
    recordAlertEvaluationMock.mockResolvedValue(undefined);
    sendPriceAlertNotificationMock.mockResolvedValue({ sent: 1, failed: 0 });
  });

  it("triggers when fairMarketValue crosses the 'above' threshold and fires push", async () => {
    listAllActiveAlertsMock.mockResolvedValue([
      makeAlert({ targetPrice: 50, direction: "above" }),
    ]);
    computeEstimateMock.mockResolvedValue({ fairMarketValue: 60 });

    const summary = await runPriceAlertEvaluator();

    expect(computeEstimateMock).toHaveBeenCalledTimes(1);
    const req = computeEstimateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req.playerName).toBe("Mike Trout");
    expect(req.cardYear).toBe(2011);
    expect(req.product).toBe("Topps Update");
    expect(req.gradeCompany).toBe("PSA");
    expect(req.gradeValue).toBe(10);

    expect(recordAlertEvaluationMock).toHaveBeenCalledWith(
      "user-1",
      "alert-1",
      { currentPrice: 60, triggered: true },
    );
    expect(sendPriceAlertNotificationMock).toHaveBeenCalledTimes(1);
    expect(summary.evaluated).toBe(1);
    expect(summary.triggered).toBe(1);
    expect(summary.pricingErrors).toBe(0);
    expect(summary.pushSent).toBe(1);
  });

  it("counts pricingErrors and does not flip or push when computeEstimate throws", async () => {
    listAllActiveAlertsMock.mockResolvedValue([
      makeAlert({ targetPrice: 50, direction: "above" }),
    ]);
    computeEstimateMock.mockRejectedValue(new Error("upstream boom"));

    const summary = await runPriceAlertEvaluator();

    expect(recordAlertEvaluationMock).toHaveBeenCalledWith(
      "user-1",
      "alert-1",
      { currentPrice: null, triggered: false },
    );
    expect(sendPriceAlertNotificationMock).not.toHaveBeenCalled();
    expect(summary.evaluated).toBe(1);
    expect(summary.triggered).toBe(0);
    expect(summary.pricingErrors).toBe(1);
    expect(summary.pushSent).toBe(0);
  });

  it("treats null fairMarketValue (thin-data short-circuit) as no signal — no trigger, no push", async () => {
    listAllActiveAlertsMock.mockResolvedValue([
      makeAlert({ targetPrice: 50, direction: "above" }),
    ]);
    computeEstimateMock.mockResolvedValue({ fairMarketValue: null });

    const summary = await runPriceAlertEvaluator();

    expect(recordAlertEvaluationMock).toHaveBeenCalledWith(
      "user-1",
      "alert-1",
      { currentPrice: null, triggered: false },
    );
    expect(sendPriceAlertNotificationMock).not.toHaveBeenCalled();
    expect(summary.evaluated).toBe(1);
    expect(summary.triggered).toBe(0);
    expect(summary.pricingErrors).toBe(0);
  });
});
