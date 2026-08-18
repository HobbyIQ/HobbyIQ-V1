// CF-CARDSIGHT-UUID-IMAGE (Drew, 2026-07-13, PR #414) — verifies the
// image-URL patcher rewrites imageUrl for both Cardsight-native shapes
// (bare parent + exploded compound) and leaves CardHedge CDN URLs alone.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { patchCardsightImageUrls } from "../src/utils/cardsightImageUrlPatcher.js";

// CF-CS-IMAGE-KILL-SWITCH (Drew, 2026-08-02) made the patcher return early
// when CARDSIGHT_API_KEY is empty — an unset key means the upstream proxy 401s
// and every filled-in URL renders as a broken image, so leaving imageUrl null
// is correct. CI never sets that key, so these fill-in tests silently exercised
// the kill switch instead of the patching logic and asserted against null.
//
// Enable it around the fill-in cases, and pin the kill switch itself below so
// the early-return keeps its own coverage rather than masquerading as this.
const KEY = "test-cardsight-key-not-a-real-credential";
let priorKey: string | undefined;
beforeEach(() => { priorKey = process.env.CARDSIGHT_API_KEY; process.env.CARDSIGHT_API_KEY = KEY; });
afterEach(() => {
  if (priorKey === undefined) delete process.env.CARDSIGHT_API_KEY;
  else process.env.CARDSIGHT_API_KEY = priorKey;
});

// Mock the Express Request just enough for absoluteApiUrl.
const fakeReq = {
  protocol: "https",
  get: (h: string) => (h === "host" ? "hobbyiq3.example.com" : undefined),
  headers: { host: "hobbyiq3.example.com" },
} as any;

describe("patchCardsightImageUrls", () => {
  it("populates imageUrl for exploded compound candidateIds — extracts PARENT UUID", () => {
    const candidates = [
      {
        candidateId: "cardsight:befe9bcc-e7e8-458c-9cd8-ce831848b9a1::334908f4-bf5f-4ed5-98c7-75113561ab55",
        imageUrl: null,
      },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toContain(
      "/api/compiq/card-image/befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
    );
    // parallel UUID must NOT be in the image URL (parallels don't have
    // their own images per Cardsight's API design)
    expect(candidates[0].imageUrl).not.toContain("334908f4");
  });

  it("populates imageUrl for bare-parent Cardsight candidateIds", () => {
    const candidates = [
      {
        candidateId: "cardsight:befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
        imageUrl: null,
      },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toContain(
      "/api/compiq/card-image/befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
    );
  });

  it("leaves CardHedge http(s) CDN URLs alone", () => {
    const chImage = "https://942284f33c575895b4be9de571ca6e40.cdn.bubble.io/d112/f1778772718503x687531413799132800/resize";
    const candidates = [
      { candidateId: "cardsight:1778542139387x224921916000968560", imageUrl: chImage },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toBe(chImage);
  });

  it("does not populate for cert-source rows (no candidateId matching cardsight prefix)", () => {
    const candidates = [
      { candidateId: "psa-cert:12345678", imageUrl: null },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toBeNull();
  });

  it("survives candidates with missing candidateId", () => {
    const candidates: any[] = [
      { imageUrl: null },
      { candidateId: null, imageUrl: null },
      { candidateId: 123, imageUrl: null },
    ];
    expect(() => patchCardsightImageUrls(fakeReq, candidates)).not.toThrow();
    expect(candidates.every((c) => c.imageUrl === null)).toBe(true);
  });

  it("does not populate for malformed compound (non-UUID halves)", () => {
    const candidates = [
      { candidateId: "cardsight:not-a-uuid::also-bad", imageUrl: null },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toBeNull();
  });

  it("populates for legacy bubble.io ids (contains 'x' - the bubble.io separator)", () => {
    // Bubble.io IDs use format like "1778542139387x224921916000968560"
    // (contains 'x' as separator, not UUID hyphens). These represent
    // CH-catalog-snapshotted cards from the old Cardsight API. Only the
    // strict UUID regex will match — the `x` bubble format falls out.
    // This is the intended behavior post-#412 (CH candidates get their
    // real CDN url from the dispatcher, not our proxy).
    const candidates = [
      { candidateId: "cardsight:1778542139387x224921916000968560", imageUrl: null },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    // The 'x' breaks the UUID pattern → imageUrl stays null
    expect(candidates[0].imageUrl).toBeNull();
  });

  // CF-CS-IMAGE-KILL-SWITCH (Drew, 2026-08-02). Pinned explicitly because it
  // is what CI actually runs with — an unset key must leave imageUrl null so
  // the client draws a placeholder instead of a dead 404 image.
  it("KILL SWITCH: fills nothing when CARDSIGHT_API_KEY is absent", () => {
    delete process.env.CARDSIGHT_API_KEY;
    const candidates = [
      { candidateId: "cardsight:befe9bcc-e7e8-458c-9cd8-ce831848b9a1", imageUrl: null },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toBeNull();
  });

  it("KILL SWITCH: an empty/whitespace key counts as absent", () => {
    process.env.CARDSIGHT_API_KEY = "   ";
    const candidates = [
      { candidateId: "cardsight:befe9bcc-e7e8-458c-9cd8-ce831848b9a1", imageUrl: null },
    ];
    patchCardsightImageUrls(fakeReq, candidates);
    expect(candidates[0].imageUrl).toBeNull();
  });
});
