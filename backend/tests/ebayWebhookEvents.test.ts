import { describe, it, expect, beforeEach } from "vitest";
import {
  eventExists,
  captureEvent,
  markEventProcessed,
  markEventError,
  readEvent,
  _resetForTests,
} from "../src/services/ebay/ebayWebhookEvents.service.js";

beforeEach(() => {
  _resetForTests();
});

describe("ebayWebhookEvents capture-before-process store (PR D.6)", () => {
  it("captureEvent persists a new event and returns captured=true", async () => {
    const result = await captureEvent({
      notificationId: "notif-1",
      topic: "ITEM_SOLD",
      eventDate: "2026-05-21T10:00:00.000Z",
      envelope: { metadata: { topic: "ITEM_SOLD" }, notification: { notificationId: "notif-1" } },
    });
    expect(result).toEqual({ duplicate: false, captured: true });

    const stored = await readEvent("notif-1");
    expect(stored?.id).toBe("notif-1");
    expect(stored?.notificationId).toBe("notif-1");
    expect(stored?.topic).toBe("ITEM_SOLD");
    expect(stored?.eventDate).toBe("2026-05-21T10:00:00.000Z");
    expect(stored?.status).toBe("captured");
    expect(stored?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("captureEvent on duplicate notificationId returns duplicate=true and does not overwrite", async () => {
    await captureEvent({
      notificationId: "notif-dup",
      topic: "ITEM_SOLD",
      envelope: { first: true },
    });
    const firstStored = await readEvent("notif-dup");

    const second = await captureEvent({
      notificationId: "notif-dup",
      topic: "ITEM_SOLD",
      envelope: { second: true },
    });
    expect(second).toEqual({ duplicate: true, captured: false });

    const afterSecond = await readEvent("notif-dup");
    // Original envelope is preserved.
    expect(afterSecond?.envelope).toEqual({ first: true });
    expect(afterSecond?.capturedAt).toBe(firstStored?.capturedAt);
  });

  it("eventExists returns true for captured events and false for unknown ids", async () => {
    expect(await eventExists("never-captured")).toBe(false);
    await captureEvent({ notificationId: "notif-exists", topic: "ITEM_SOLD", envelope: {} });
    expect(await eventExists("notif-exists")).toBe(true);
    expect(await eventExists("")).toBe(false);
  });

  it("captureEvent rejects empty notificationId", async () => {
    const result = await captureEvent({
      notificationId: "",
      topic: "ITEM_SOLD",
      envelope: {},
    });
    expect(result).toEqual({ duplicate: false, captured: false });
  });

  it("markEventProcessed transitions status and records handlerResult", async () => {
    await captureEvent({ notificationId: "notif-proc", topic: "ITEM_SOLD", envelope: {} });
    await markEventProcessed("notif-proc", { matchedHoldingId: "h-1", action: "marked-sold" });

    const stored = await readEvent("notif-proc");
    expect(stored?.status).toBe("processed");
    expect(stored?.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored?.handlerResult).toEqual({ matchedHoldingId: "h-1", action: "marked-sold" });
  });

  it("markEventError transitions status and records handlerError", async () => {
    await captureEvent({ notificationId: "notif-err", topic: "ITEM_SOLD", envelope: {} });
    await markEventError("notif-err", "no holding found for offerId=OFFER-X");

    const stored = await readEvent("notif-err");
    expect(stored?.status).toBe("error");
    expect(stored?.handlerError).toBe("no holding found for offerId=OFFER-X");
    expect(stored?.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markEventProcessed/markEventError on unknown id is a silent no-op", async () => {
    // Should not throw.
    await markEventProcessed("never-captured", { foo: "bar" });
    await markEventError("never-captured", "boom");
    expect(await readEvent("never-captured")).toBeNull();
  });

  it("readEvent returns null on miss", async () => {
    expect(await readEvent("does-not-exist")).toBeNull();
  });
});
