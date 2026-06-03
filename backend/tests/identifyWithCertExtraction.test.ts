// CF-GRADED-SCAN-B1+B2 (2026-06-02) — opt-in cert extraction + wrap.
//
// Locks the response-contract states iOS and any other client will see
// across the four paths the opt-in introduces:
//
//   (1) Opt-OUT (default; no extractCert flag) — response is VERBATIM
//       CardsightIdentifyResponse. Existing contract unchanged.
//   (2) Opt-IN + OCR success + cert found — response is wrapped
//       { cardsight, certCandidate: {graderId, certNumber, ocrConfidence} }.
//   (3) Opt-IN + OCR success + NO cert digits — wrapped { cardsight }
//       only (certCandidate omitted).
//   (4) Opt-IN + OCR FAILURE (network / 500 / missing env) — wrapped
//       { cardsight } only; OCR failure NEVER blocks the Cardsight result.
//
// Plus pure-function locks on the certExtractor regex + confidence
// floor + context boost.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

vi.mock("../src/services/photoStorage/photoStorage.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/photoStorage/photoStorage.service.js",
  );
  return {
    ...actual,
    downloadBlobByUrl: vi.fn(async () => Buffer.from("fake-image-bytes")),
  };
});

vi.mock("../src/services/compiq/cardsight.client.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/cardsight.client.js",
  );
  return {
    ...actual,
    identify: vi.fn(async () => ({
      success: true,
      requestId: "test-req-id",
      processingTime: 42,
      detections: [
        { card_id: "test-uuid", title: "Test Card", confidence: 0.92 },
      ],
      messages: [],
    })),
  };
});

vi.mock("../src/services/azureVision/visionOcr.client.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/azureVision/visionOcr.client.js",
  );
  return {
    ...actual,
    extractTextFromImage: vi.fn(),
  };
});

vi.mock("../src/services/authService.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/authService.js",
  );
  return {
    ...actual,
    // CF-PAYMENTS-B1: plan field added so requireRateLimited("scansPerMonth")
    // on /api/portfolio/identify can read user.plan; "pro_seller" makes
    // requireRateLimited short-circuit (unlimited cap) since these tests
    // assert response shape, not rate-limit behavior.
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

const visionMod = await import("../src/services/azureVision/visionOcr.client.js");
let app: any;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-mock auth's default return so each test starts with valid session.
  const authMod = await import("../src/services/authService.js");
  (authMod.getUserBySession as any).mockResolvedValue({
    userId: "test-user",
    email: "t@t",
    username: null,
    fullName: null,
    plan: "pro_seller",
    createdAt: "2026-01-01T00:00:00Z",
  });
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

describe("CF-GRADED-SCAN — /api/portfolio/identify opt-in cert extraction", () => {
  describe("(1) Opt-OUT default — verbatim Cardsight contract", () => {
    it("response is the raw CardsightIdentifyResponse (no wrap)", async () => {
      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({ blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg" });

      expect(r.status).toBe(200);
      // Verbatim Cardsight shape — no `cardsight` wrap key, no certCandidate.
      expect(r.body.success).toBe(true);
      expect(r.body.requestId).toBe("test-req-id");
      expect(r.body.detections).toEqual([
        { card_id: "test-uuid", title: "Test Card", confidence: 0.92 },
      ]);
      expect(r.body.cardsight).toBeUndefined();
      expect(r.body.certCandidate).toBeUndefined();
      // OCR client MUST NOT have been called on opt-out path.
      expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
    });

    it("absent extractCert flag is treated as opt-out (no OCR call)", async () => {
      await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({ blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg" });
      expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
    });

    it("extractCert:false is treated as opt-out", async () => {
      await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: false,
        });
      expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
    });
  });

  describe("(2) Opt-IN + OCR success + cert found — wrapped shape with certCandidate", () => {
    it("body.extractCert:true returns { cardsight, certCandidate }", async () => {
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce({
        lines: [
          { text: "PSA GEM MT 10", confidence: 0.95 },
          { text: "CERT # 89765432", confidence: 0.97 },
          { text: "2018 Topps Chrome Refractor", confidence: 0.91 },
        ],
        durationMs: 850,
      });

      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true,
        });

      expect(r.status).toBe(200);
      expect(r.body.cardsight).toBeDefined();
      expect(r.body.cardsight.success).toBe(true);
      expect(r.body.cardsight.requestId).toBe("test-req-id");
      expect(r.body.certCandidate).toBeDefined();
      expect(r.body.certCandidate.graderId).toBe("psa");
      expect(r.body.certCandidate.certNumber).toBe("89765432");
      expect(typeof r.body.certCandidate.ocrConfidence).toBe("number");
      // 0.97 + 0.2 context (CERT token) → clamped at 1.0.
      expect(r.body.certCandidate.ocrConfidence).toBeGreaterThan(0.95);
      expect(r.body.certCandidate.ocrConfidence).toBeLessThanOrEqual(1.0);
    });

    it("query ?withCertExtraction=true is an alternate opt-in surface", async () => {
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce({
        lines: [{ text: "PSA 12345678", confidence: 0.9 }],
        durationMs: 800,
      });

      const r = await request(app)
        .post("/api/portfolio/identify?withCertExtraction=true")
        .set("x-session-id", "test-sess")
        .send({ blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg" });

      expect(r.status).toBe(200);
      expect(r.body.cardsight).toBeDefined();
      expect(r.body.certCandidate).toBeDefined();
      expect(r.body.certCandidate.certNumber).toBe("12345678");
    });
  });

  describe("(3) Opt-IN + OCR success + no cert digits — wrapped without certCandidate", () => {
    it("OCR returns lines but none contain a 6-12 digit run", async () => {
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce({
        lines: [
          { text: "2018 Topps Chrome Refractor", confidence: 0.95 },
          { text: "Shohei Ohtani", confidence: 0.97 },
        ],
        durationMs: 700,
      });

      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true,
        });

      expect(r.status).toBe(200);
      expect(r.body.cardsight).toBeDefined();
      expect(r.body.cardsight.success).toBe(true);
      // certCandidate OMITTED (undefined), not null.
      expect(r.body.certCandidate).toBeUndefined();
    });

    it("OCR returns lines but only very-low-confidence digit hits — extractor floors them", async () => {
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce({
        lines: [
          // confidence 0.1 is below the 0.3 floor → skipped entirely.
          { text: "blurry text with 12345678 inside", confidence: 0.1 },
        ],
        durationMs: 700,
      });

      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true,
        });

      expect(r.status).toBe(200);
      expect(r.body.certCandidate).toBeUndefined();
    });
  });

  describe("(4) Opt-IN + OCR failure — wrapped Cardsight still returns", () => {
    it("OCR returns null (e.g. env unset / network) → certCandidate omitted, cardsight intact", async () => {
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce(null);

      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true,
        });

      expect(r.status).toBe(200);
      expect(r.body.cardsight).toBeDefined();
      expect(r.body.cardsight.success).toBe(true);
      expect(r.body.cardsight.requestId).toBe("test-req-id");
      expect(r.body.certCandidate).toBeUndefined();
    });

    it("OCR client never throws — even on synthetic catastrophe — wrapped result still returns", async () => {
      // Simulate a deeper failure: the mock returns null (the documented
      // never-throw contract from visionOcr.client). Wrapped response
      // structure must still be correct.
      (visionMod.extractTextFromImage as any).mockResolvedValueOnce(null);
      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true,
        });
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["cardsight"]);
    });
  });

  describe("Auth gate still applies to both shapes", () => {
    it("opt-out: missing x-session-id returns 401", async () => {
      // override authService to return null this call
      const authMod = await import("../src/services/authService.js");
      (authMod.getUserBySession as any).mockResolvedValueOnce(null);
      const r = await request(app).post("/api/portfolio/identify").send({
        blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
      });
      expect(r.status).toBe(401);
    });

    it("opt-in: missing x-session-id returns 401 (no OCR called)", async () => {
      const authMod = await import("../src/services/authService.js");
      (authMod.getUserBySession as any).mockResolvedValueOnce(null);
      const r = await request(app).post("/api/portfolio/identify").send({
        blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
        extractCert: true,
      });
      expect(r.status).toBe(401);
      // No OCR call because auth gate fires before request body is processed.
      expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pure-function locks on the certExtractor regex + confidence floor.
// ─────────────────────────────────────────────────────────────────────

describe("certExtractor — pure-function shape locks", () => {
  it("extracts a 6-12 digit run from a high-confidence line", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    const out = extractCertCandidate([
      { text: "PSA 89765432", confidence: 0.95 },
    ]);
    expect(out).not.toBeNull();
    expect(out!.graderId).toBe("psa");
    expect(out!.certNumber).toBe("89765432");
  });

  it("returns null when no digit run exists", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    expect(
      extractCertCandidate([
        { text: "Shohei Ohtani Two-Way Player", confidence: 0.95 },
      ]),
    ).toBeNull();
  });

  it("returns null when all candidate lines are below confidence floor 0.3", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    expect(
      extractCertCandidate([{ text: "PSA 12345678", confidence: 0.2 }]),
    ).toBeNull();
  });

  it("rejects 5-digit and 13-digit runs (outside 6-12 bounds)", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    expect(
      extractCertCandidate([{ text: "PSA 12345 13", confidence: 0.95 }]),
    ).toBeNull();
    expect(
      extractCertCandidate([
        { text: "abc 1234567890123 xyz", confidence: 0.95 },
      ]),
    ).toBeNull();
  });

  it("picks the highest-confidence candidate when multiple lines have digit runs", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    const out = extractCertCandidate([
      { text: "Random noise 11111111", confidence: 0.4 }, // floor 0.4
      { text: "PSA CERT 89765432", confidence: 0.95 },     // boosted with context
    ]);
    expect(out!.certNumber).toBe("89765432");
    // 0.95 + 0.2 (PSA + CERT context) → clamped to 1.0.
    expect(out!.ocrConfidence).toBeCloseTo(1.0, 2);
  });

  it("applies context boost only when grader/cert token present", async () => {
    const { extractCertCandidate } = await import(
      "../src/services/azureVision/certExtractor.js"
    );
    const withContext = extractCertCandidate([
      { text: "PSA 89765432", confidence: 0.5 },
    ]);
    const withoutContext = extractCertCandidate([
      { text: "Random 89765432", confidence: 0.5 },
    ]);
    expect(withContext!.ocrConfidence).toBeGreaterThan(
      withoutContext!.ocrConfidence,
    );
    // 0.5 + 0.2 = 0.7
    expect(withContext!.ocrConfidence).toBeCloseTo(0.7, 2);
    // 0.5 unchanged
    expect(withoutContext!.ocrConfidence).toBeCloseTo(0.5, 2);
  });
});
