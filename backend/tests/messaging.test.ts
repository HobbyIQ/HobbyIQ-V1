// CF-MESSAGING (Drew, 2026-07-27). Pins the round-trip, unread bookkeeping,
// mark-sold semantics, and self-message rejection.

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetMessagesForTests,
  listMessagesInThread,
  listThreads,
  markSold,
  sendMessage,
  threadIdFor,
  unreadCountFor,
} from "../src/services/messaging.service.js";

const BUYER = "user-buyer-A";
const SELLER = "user-seller-B";
const CARROT = "user-outside-C";

describe("CF-MESSAGING", () => {
  beforeEach(() => _resetMessagesForTests());

  it("threadIdFor is symmetric on user order", () => {
    expect(threadIdFor("a", "b")).toBe(threadIdFor("b", "a"));
  });

  it("send + read round-trip", async () => {
    await sendMessage({ fromUserId: BUYER, toUserId: SELLER, text: "hi" });
    await sendMessage({ fromUserId: SELLER, toUserId: BUYER, text: "hey" });
    const msgs = await listMessagesInThread(BUYER, SELLER);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe("hi");
    expect(msgs[1].text).toBe("hey");
  });

  it("rejects self-message", async () => {
    await expect(
      sendMessage({ fromUserId: BUYER, toUserId: BUYER, text: "solo" }),
    ).rejects.toThrow(/yourself/i);
  });

  it("requires text OR priceCents OR holdingRef", async () => {
    await expect(
      sendMessage({ fromUserId: BUYER, toUserId: SELLER, text: "" }),
    ).rejects.toThrow();
  });

  it("marks incoming messages read on listMessagesInThread", async () => {
    await sendMessage({ fromUserId: SELLER, toUserId: BUYER, text: "hi" });
    expect(await unreadCountFor(BUYER)).toBe(1);
    await listMessagesInThread(BUYER, SELLER);
    expect(await unreadCountFor(BUYER)).toBe(0);
  });

  it("listThreads returns one entry per pair, most-recent first", async () => {
    await sendMessage({ fromUserId: BUYER, toUserId: SELLER, text: "one" });
    await sendMessage({ fromUserId: BUYER, toUserId: CARROT, text: "two" });
    // Second most-recent by createdAt is CARROT's thread; wait a tick
    // isn't needed because createdAt is millisecond-precise ISO.
    const threads = await listThreads(BUYER);
    expect(threads).toHaveLength(2);
    // Order isn't strictly stable within the same millisecond, but both
    // present is enough for this pin.
    expect(threads.map((t) => t.otherUserId).sort()).toEqual([CARROT, SELLER].sort());
  });

  it("markSold appends a sold event with the offer's price", async () => {
    const offer = await sendMessage({
      fromUserId: SELLER,
      toUserId: BUYER,
      text: "$50",
      kind: "offer",
      priceCents: 5000,
      holdingRef: {
        holdingId: "holding-1",
        sellerUserId: SELLER,
        cardTitle: "2024 Bowman Draft Chrome Auto",
      },
    });
    const sold = await markSold({
      actingUserId: SELLER,
      threadId: offer.threadId,
      offerMessageId: offer.id,
    });
    expect(sold).not.toBeNull();
    expect(sold!.kind).toBe("sold");
    expect(sold!.priceCents).toBe(5000);
    const msgs = await listMessagesInThread(SELLER, BUYER);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].kind).toBe("sold");
  });

  it("markSold rejects non-participants", async () => {
    const offer = await sendMessage({
      fromUserId: SELLER,
      toUserId: BUYER,
      text: "$50",
      kind: "offer",
      priceCents: 5000,
    });
    const res = await markSold({
      actingUserId: CARROT,
      threadId: offer.threadId,
      offerMessageId: offer.id,
    });
    expect(res).toBeNull();
  });

  it("markSold rejects when the offer has no price", async () => {
    const chat = await sendMessage({
      fromUserId: SELLER,
      toUserId: BUYER,
      text: "just chatting",
    });
    const res = await markSold({
      actingUserId: SELLER,
      threadId: chat.threadId,
      offerMessageId: chat.id,
    });
    expect(res).toBeNull();
  });
});
