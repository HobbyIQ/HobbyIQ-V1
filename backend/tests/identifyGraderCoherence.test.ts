// CF-FINALIZE (2026-06-03): graded-card coherence tests.
//
// Rule: Cardsight's native grading{} is the source of truth for
// grade/company across ALL graders. Cert OCR runs ONLY when Cardsight's
// detected company is PSA (it's the only grader whose cert NUMBER
// Cardsight doesn't return). For BGS / SGC / CGC, the certCandidate
// must be ABSENT and OCR must NOT be called.
//
// These live in a separate file from identifyWithCertExtraction.test.ts
// so per-grader `mockResolvedValueOnce` queues stay isolated from the
// other file's queues.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

vi.mock("../src/services/photoStorage/photoStorage.service.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    downloadBlobByUrl: vi.fn(async () => Buffer.from("fake-image-bytes")),
  };
});

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    identify: vi.fn(),
  };
});

vi.mock("../src/services/azureVision/visionOcr.client.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    extractTextFromImage: vi.fn(),
  };
});

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
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

const cardsightMod = await import("../src/services/compiq/cardsight.client.js");
const visionMod = await import("../src/services/azureVision/visionOcr.client.js");
let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Defensively wipe any queued mockResolvedValueOnce responses that
  // tests left behind so cross-test contamination can't sneak in.
  (cardsightMod.identify as any).mockReset();
  (visionMod.extractTextFromImage as any).mockReset();
});

function stubCardsightWithGrader(companyName: string) {
  (cardsightMod.identify as any).mockResolvedValue({
    success: true,
    requestId: "test-req-id",
    processingTime: 42,
    detections: [
      {
        confidence: "0.92",
        card: { card_id: "test-uuid", title: "Test Card" },
        grading: {
          confidence: "0.91",
          company: { id: companyName.toLowerCase(), name: companyName },
          grade: { id: "10", value: "10", condition: "PRISTINE" },
        },
      },
    ],
    messages: [],
  });
}

describe("CF-FINALIZE — non-PSA grader → no cert OCR, no certCandidate", () => {
  for (const grader of ["BGS", "SGC", "CGC"]) {
    it(`${grader} slab → cardsight grade present, certCandidate ABSENT, OCR NEVER called`, async () => {
      stubCardsightWithGrader(grader);
      // Defensive OCR stub — if the implementation incorrectly calls it,
      // we still want a sane return rather than undefined.
      (visionMod.extractTextFromImage as any).mockResolvedValue({
        lines: [{ text: "1234567890", confidence: 0.99 }],
        durationMs: 800,
      });

      const r = await request(app)
        .post("/api/portfolio/identify")
        .set("x-session-id", "test-sess")
        .send({
          blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
          extractCert: true, // OPT-IN — but non-PSA so OCR must be skipped
        });

      expect(r.status).toBe(200);
      // Wrapped shape (opt-in path).
      expect(r.body.cardsight).toBeDefined();
      // Cardsight's native grading{} is intact across all graders.
      expect(r.body.cardsight.detections[0].grading.company.name).toBe(grader);
      expect(r.body.cardsight.detections[0].grading.grade.value).toBe("10");
      // CertCandidate is ABSENT — coherence rule.
      expect(r.body.certCandidate).toBeUndefined();
      // OCR was NEVER called (efficiency + coherence guarantee).
      expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
    });
  }

  it("Cardsight detection with NO grading{} (raw card) → certCandidate ABSENT, OCR NEVER called", async () => {
    (cardsightMod.identify as any).mockResolvedValue({
      success: true,
      requestId: "test-req-id",
      processingTime: 42,
      detections: [
        {
          confidence: "0.92",
          card: { card_id: "raw-card", title: "Raw Card" },
          // no grading{} field — Cardsight didn't detect a slab
        },
      ],
      messages: [],
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
    expect(r.body.cardsight.detections[0].grading).toBeUndefined();
    expect(r.body.certCandidate).toBeUndefined();
    expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
  });

  it("PSA case-insensitive (company.name='psa' lowercase) → OCR IS called, certCandidate present", async () => {
    (cardsightMod.identify as any).mockResolvedValue({
      success: true,
      requestId: "test-req-id",
      processingTime: 42,
      detections: [
        {
          confidence: "0.92",
          card: { card_id: "test-uuid", title: "Test Card" },
          grading: {
            confidence: "0.91",
            company: { id: "psa", name: "psa" }, // lowercase
            grade: { id: "10", value: "10", condition: "GEM MINT" },
          },
        },
      ],
      messages: [],
    });
    (visionMod.extractTextFromImage as any).mockResolvedValue({
      lines: [{ text: "PSA CERT # 89765432", confidence: 0.96 }],
      durationMs: 800,
    });

    const r = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", "test-sess")
      .send({
        blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
        extractCert: true,
      });

    expect(r.status).toBe(200);
    expect(r.body.certCandidate).toBeDefined();
    expect(r.body.certCandidate.certNumber).toBe("89765432");
    expect(r.body.certCandidate.graderId).toBe("psa");
    expect(visionMod.extractTextFromImage).toHaveBeenCalledTimes(1);
  });

  it("PSA (uppercase) → OCR IS called, certCandidate present", async () => {
    stubCardsightWithGrader("PSA");
    (visionMod.extractTextFromImage as any).mockResolvedValue({
      lines: [{ text: "CERT 89765432", confidence: 0.97 }],
      durationMs: 800,
    });

    const r = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", "test-sess")
      .send({
        blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
        extractCert: true,
      });

    expect(r.status).toBe(200);
    expect(r.body.certCandidate).toBeDefined();
    expect(r.body.certCandidate.certNumber).toBe("89765432");
    expect(visionMod.extractTextFromImage).toHaveBeenCalledTimes(1);
  });

  it("OPT-OUT contract is BYTE-IDENTICAL — verbatim Cardsight, no wrap, no certCandidate", async () => {
    stubCardsightWithGrader("BGS");

    const r = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", "test-sess")
      .send({
        blobUrl: "https://test.blob.core.windows.net/uploads/c.jpg",
        // extractCert NOT sent — opt-out
      });

    expect(r.status).toBe(200);
    // Verbatim Cardsight shape (NOT wrapped under .cardsight)
    expect(r.body.success).toBe(true);
    expect(r.body.requestId).toBe("test-req-id");
    expect(r.body.detections[0].grading.company.name).toBe("BGS");
    // No wrap key, no certCandidate — the opt-out contract.
    expect(r.body.cardsight).toBeUndefined();
    expect(r.body.certCandidate).toBeUndefined();
    // OCR NEVER touched on opt-out, regardless of grader.
    expect(visionMod.extractTextFromImage).not.toHaveBeenCalled();
  });
});
