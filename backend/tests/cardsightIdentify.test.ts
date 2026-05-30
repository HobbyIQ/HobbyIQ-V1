// CF-CARDSIGHT-IDENTIFY-INTEGRATION tests.
//
// Covers three layers:
//   1. cardsight.client.identify -- the raw client method (fetch-mocked)
//   2. identify.service.identifyCardByBlobUrl -- service composition
//      (blob download mocked + client.identify mocked)
//   3. POST /api/portfolio/identify -- route handler via supertest
//
// Error semantics under test:
//   - Cardsight `success: false` is NOT an error (pass through as 200)
//   - 400 + VALIDATION_ERROR -> CardsightValidationError -> 400
//   - Timeout -> CardsightTimeoutError -> 504
//   - 5xx after retries -> CardsightApiError -> 502
//   - Blob download failure -> IdentifyBlobDownloadError -> 502

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.CARDSIGHT_API_KEY = "test-key";

// Stub Azure photo storage so we can control downloadBlobByUrl behavior.
vi.mock("../src/services/photoStorage/photoStorage.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    downloadBlobByUrl: vi.fn(),
  };
});

import {
  identify as cardsightIdentify,
  CardsightApiError,
  CardsightTimeoutError,
  CardsightValidationError,
} from "../src/services/compiq/cardsight.client";
import {
  identifyCardByBlobUrl,
  IdentifyBlobDownloadError,
} from "../src/services/cardsight/identify.service";
import * as photoStorage from "../src/services/photoStorage/photoStorage.service";
import app from "../src/app";

// ─── Fixtures ───────────────────────────────────────────────────────────

const HAPPY_BODY = {
  success: true,
  requestId: "req-happy-1",
  processingTime: 1250,
  detections: [
    {
      confidence: "High",
      card: {
        id: "card-uuid-1",
        year: "2017",
        manufacturer: "Topps",
        releaseName: "Chrome",
        setName: "Base Set",
        name: "Aaron Judge",
        number: "99",
      },
      grading: {
        confidence: "High",
        company: { name: "PSA" },
        grade: { value: "10", condition: "Gem Mint" },
      },
    },
  ],
};

const NO_DETECT_BODY = {
  success: false,
  requestId: "req-no-detect-1",
  processingTime: 108,
  messages: [
    {
      type: "warning",
      message: "Image resolution (100x100) is below the recommended size for accurate results.",
    },
  ],
};

const VALIDATION_BODY = {
  error: "Image dimensions too small. Minimum dimension is 100px",
  code: "VALIDATION_ERROR",
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const FAKE_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // tiny JPEG-ish bytes
const FAKE_BLOB_URL =
  "https://stghobbyiqdev.blob.core.windows.net/card-images/u1/identify/123-abc.jpg";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests: cardsight.client.identify (raw client) ──────────────────────

describe("cardsight.client.identify -- raw client method", () => {
  it("happy path: 200 + detections -> returns body verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(HAPPY_BODY, 200, { "x-request-id": "req-happy-1" })),
    );
    const result = await cardsightIdentify(FAKE_IMAGE, "test.jpg", "image/jpeg");
    expect(result.success).toBe(true);
    expect(result.detections).toHaveLength(1);
    expect(result.detections?.[0].card.name).toBe("Aaron Judge");
    expect(result.detections?.[0].grading?.company.name).toBe("PSA");
  });

  it("200 + success:false + messages -> returns body verbatim (NOT thrown)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(NO_DETECT_BODY, 200, { "x-request-id": "req-no-detect-1" })),
    );
    const result = await cardsightIdentify(FAKE_IMAGE);
    expect(result.success).toBe(false);
    expect(result.detections).toBeUndefined();
    expect(result.messages?.[0].type).toBe("warning");
  });

  it("400 + VALIDATION_ERROR -> throws CardsightValidationError with code + requestId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(VALIDATION_BODY, 400, { "x-request-id": "req-validation-1" }),
      ),
    );
    await expect(cardsightIdentify(FAKE_IMAGE)).rejects.toBeInstanceOf(CardsightValidationError);
    try {
      await cardsightIdentify(FAKE_IMAGE);
    } catch (err) {
      expect(err).toBeInstanceOf(CardsightValidationError);
      const ve = err as CardsightValidationError;
      expect(ve.code).toBe("VALIDATION_ERROR");
      expect(ve.message).toContain("100px");
      expect(ve.requestId).toBe("req-validation-1");
    }
  });

  it("5xx after retries -> throws CardsightApiError", async () => {
    // fetchWithRetry retries 3x on 5xx, then throws. Mock returns 500 every call.
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ error: "server error" }, 500)));
    await expect(cardsightIdentify(FAKE_IMAGE)).rejects.toBeInstanceOf(CardsightApiError);
  }, 30_000);

  it("timeout (AbortError) -> throws CardsightTimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("timeout");
        err.name = "TimeoutError";
        throw err;
      }),
    );
    await expect(cardsightIdentify(FAKE_IMAGE)).rejects.toBeInstanceOf(CardsightTimeoutError);
  });

  it("missing CARDSIGHT_API_KEY -> throws CardsightApiError without calling fetch", async () => {
    const original = process.env.CARDSIGHT_API_KEY;
    delete process.env.CARDSIGHT_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(cardsightIdentify(FAKE_IMAGE)).rejects.toBeInstanceOf(CardsightApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.CARDSIGHT_API_KEY = original;
    }
  });
});

// ─── Tests: identify.service.identifyCardByBlobUrl ──────────────────────

describe("identify.service.identifyCardByBlobUrl -- service composition", () => {
  it("downloads blob + calls cardsight identify + returns response", async () => {
    vi.mocked(photoStorage.downloadBlobByUrl).mockResolvedValue(FAKE_IMAGE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(HAPPY_BODY, 200, { "x-request-id": "req-happy-2" })),
    );

    const result = await identifyCardByBlobUrl(FAKE_BLOB_URL, "123-abc.jpg");
    expect(photoStorage.downloadBlobByUrl).toHaveBeenCalledWith(FAKE_BLOB_URL);
    expect(result.success).toBe(true);
    expect(result.detections?.[0].card.id).toBe("card-uuid-1");
  });

  it("blob download failure -> throws IdentifyBlobDownloadError (NOT Cardsight error)", async () => {
    vi.mocked(photoStorage.downloadBlobByUrl).mockRejectedValue(
      new Error("Invalid blob URL: https://attacker.example.com/foo"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(identifyCardByBlobUrl(FAKE_BLOB_URL)).rejects.toBeInstanceOf(
      IdentifyBlobDownloadError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Tests: POST /api/portfolio/identify route ──────────────────────────

async function signIn(): Promise<string> {
  const r = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

describe("POST /api/portfolio/identify -- route handler", () => {
  it("happy path: 200 with detections", async () => {
    vi.mocked(photoStorage.downloadBlobByUrl).mockResolvedValue(FAKE_IMAGE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(HAPPY_BODY, 200, { "x-request-id": "req-route-1" })),
    );
    const session = await signIn();

    const res = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", session)
      .send({ blobUrl: FAKE_BLOB_URL, blobName: "123-abc.jpg" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.detections).toHaveLength(1);
    expect(res.body.detections[0].card.name).toBe("Aaron Judge");
  });

  it("Cardsight success:false -> 200 pass-through (NOT 4xx/5xx)", async () => {
    vi.mocked(photoStorage.downloadBlobByUrl).mockResolvedValue(FAKE_IMAGE);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(NO_DETECT_BODY, 200)));
    const session = await signIn();

    const res = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", session)
      .send({ blobUrl: FAKE_BLOB_URL });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.messages?.[0].type).toBe("warning");
    expect(res.body.detections).toBeUndefined();
  });

  it("missing blobUrl -> 400 with clear error", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", session)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("blobUrl is required");
  });

  it("missing x-session-id -> 401", async () => {
    const res = await request(app)
      .post("/api/portfolio/identify")
      .send({ blobUrl: FAKE_BLOB_URL });
    expect(res.status).toBe(401);
  });

  it("Cardsight validation error -> 400 with code + requestId", async () => {
    vi.mocked(photoStorage.downloadBlobByUrl).mockResolvedValue(FAKE_IMAGE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(VALIDATION_BODY, 400, { "x-request-id": "req-val-route" })),
    );
    const session = await signIn();

    const res = await request(app)
      .post("/api/portfolio/identify")
      .set("x-session-id", session)
      .send({ blobUrl: FAKE_BLOB_URL });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.requestId).toBe("req-val-route");
    expect(res.body.error).toContain("100px");
  });
});
