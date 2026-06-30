// CF-COMPIQ-SCAN-ROUTE (2026-06-30) — pins the iOS slab scanning entry
// point. Phase 2 of the iOS slab scanning project.
//
// THIS FILE PINS:
//   1. Missing image input → 400
//   2. hint=graded → cert-OCR only, no image-match fallback
//   3. hint=raw → image-match only, no cert-OCR attempt
//   4. hint=auto OR omitted → cert-OCR first, image-match fallback
//   5. cert-OCR success returns matchPath="cert-ocr" + certInfo
//   6. image-match success returns matchPath="image-match", certInfo=null
//   7. Both fail → success=true with cardsightCardId=null (iOS shows
//      "couldn't match" UI; the request was VALID even if no match)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const certOcrMock = vi.fn();
const imageMatchMock = vi.fn();

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedge.client.js")>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return {
    ...actual,
    getCardDetailsByCertImage: (...args: unknown[]) => certOcrMock(...args),
    identifyCardByImage: (...args: unknown[]) => imageMatchMock(...args),
  };
});

vi.mock("../src/middleware/requireSession.js", () => ({
  requireSession: (req: any, _res: any, next: any) => {
    req.user = { userId: "test-user" };
    next();
  },
}));

vi.mock("../src/middleware/requireRateLimited.js", () => ({
  requireRateLimited: () => (_req: any, _res: any, next: any) => next(),
}));

let app: express.Express;

beforeEach(async () => {
  certOcrMock.mockReset();
  imageMatchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
  // Re-import the routes module so the mocks apply
  vi.resetModules();
  const routesMod = await import("../src/routes/compiq.routes.js");
  app = express();
  app.use(express.json());
  app.use("/api/compiq", routesMod.default);
});

afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
});

describe("CF-COMPIQ-SCAN-ROUTE — /api/compiq/scan", () => {
  it("missing image input → 400", async () => {
    const r = await request(app).post("/api/compiq/scan").send({});
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(certOcrMock).not.toHaveBeenCalled();
    expect(imageMatchMock).not.toHaveBeenCalled();
  });

  it("hint=graded → cert-OCR only (no image-match fallback)", async () => {
    certOcrMock.mockResolvedValueOnce({
      cert_info: { cert_number: "12345", grader: "PSA", grade: "10" },
      card: { card_id: "card-xyz", player: "Mike Trout", set: "2011 Topps Update Baseball", number: "US175", variant: "Base" },
      match_confidence: 0.95,
    });
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageUrl: "https://blob/slab.jpg", hint: "graded" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.cardsightCardId).toBe("card-xyz");
    expect(r.body.matchPath).toBe("cert-ocr");
    expect(r.body.matchConfidence).toBe(0.95);
    expect(r.body.player).toBe("Mike Trout");
    expect(r.body.certInfo).toEqual({ certNumber: "12345", grader: "PSA", grade: "10" });
    expect(certOcrMock).toHaveBeenCalledTimes(1);
    expect(imageMatchMock).not.toHaveBeenCalled();
  });

  it("hint=raw → image-match only (no cert-OCR attempted)", async () => {
    imageMatchMock.mockResolvedValueOnce({
      success: true,
      best_match: { card_id: "card-abc", player: "Bobby Witt Jr.", set: "2022 Topps", number: "1", variant: "Base", confidence: 0.88 },
      candidates: [],
    });
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageBase64: "abc", hint: "raw" });
    expect(r.status).toBe(200);
    expect(r.body.cardsightCardId).toBe("card-abc");
    expect(r.body.matchPath).toBe("image-match");
    expect(r.body.matchConfidence).toBe(0.88);
    expect(r.body.certInfo).toBeNull();
    expect(certOcrMock).not.toHaveBeenCalled();
    expect(imageMatchMock).toHaveBeenCalledTimes(1);
  });

  it("hint=auto + cert-OCR hits → returns cert-OCR result (no image-match)", async () => {
    certOcrMock.mockResolvedValueOnce({
      cert_info: { cert_number: "999", grader: "BGS", grade: "9.5" },
      card: { card_id: "card-bgs", player: "Test", set: "Set", number: "1", variant: "Base" },
      match_confidence: 0.91,
    });
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageUrl: "https://x/y" });
    expect(r.body.matchPath).toBe("cert-ocr");
    expect(certOcrMock).toHaveBeenCalledTimes(1);
    expect(imageMatchMock).not.toHaveBeenCalled();
  });

  it("hint=auto + cert-OCR yields no card_id → falls back to image-match", async () => {
    certOcrMock.mockResolvedValueOnce({
      cert_info: { cert_number: null, grader: null, grade: null },
      card: null,  // OCR couldn't read the label
      match_confidence: null,
    });
    imageMatchMock.mockResolvedValueOnce({
      success: true,
      best_match: { card_id: "card-fb", player: "Fallback Player", set: "S", number: "9", variant: "Base", confidence: 0.72 },
      candidates: [],
    });
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageUrl: "https://x/y" });
    expect(r.body.matchPath).toBe("image-match");
    expect(r.body.cardsightCardId).toBe("card-fb");
    expect(certOcrMock).toHaveBeenCalledTimes(1);
    expect(imageMatchMock).toHaveBeenCalledTimes(1);
  });

  it("both paths fail → success=true with cardsightCardId=null (iOS shows fallback UI)", async () => {
    certOcrMock.mockResolvedValueOnce({ cert_info: {}, card: null, match_confidence: null });
    imageMatchMock.mockResolvedValueOnce({ success: true, best_match: null, candidates: [] });
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageUrl: "https://x/y" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.cardsightCardId).toBeNull();
    expect(r.body.matchPath).toBeNull();
    expect(r.body.player).toBeNull();
    expect(r.body.certInfo).toBeNull();
  });

  it("CH wrapper returns null (HTTP error / no API key) → no match", async () => {
    certOcrMock.mockResolvedValueOnce(null);
    imageMatchMock.mockResolvedValueOnce(null);
    const r = await request(app)
      .post("/api/compiq/scan")
      .send({ imageUrl: "https://x/y" });
    expect(r.body.success).toBe(true);
    expect(r.body.cardsightCardId).toBeNull();
    expect(r.body.matchPath).toBeNull();
  });
});
