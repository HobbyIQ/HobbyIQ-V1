// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — /api/search/cards route tests.
//
// Covers the HTTP surface: auth gate (401), input validation (400),
// happy-path delegation to the dispatcher (200 + UnifiedSearchResponse
// shape), and the unhandled-error path (500).
//
// Mocks the dispatcher + authService so the test exercises the route
// handler in isolation; dispatcher behavior is covered separately in
// unifiedSearchDispatcher.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/services/authService.js", () => ({
  getUserBySession: vi.fn(),
}));

vi.mock("../src/services/unifiedSearch/index.js", () => ({
  dispatchSearch: vi.fn(),
}));

import { getUserBySession } from "../src/services/authService.js";
import { dispatchSearch } from "../src/services/unifiedSearch/index.js";
import searchRoutes from "../src/routes/search.routes.js";

const mockedGetUserBySession = getUserBySession as unknown as ReturnType<typeof vi.fn>;
const mockedDispatchSearch = dispatchSearch as unknown as ReturnType<typeof vi.fn>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/search", searchRoutes);
  return app;
}

beforeEach(() => {
  mockedGetUserBySession.mockReset();
  mockedDispatchSearch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/search/cards — auth", () => {
  it("401 when x-session-id header is missing", async () => {
    const res = await request(makeApp())
      .post("/api/search/cards")
      .send({ input: "any" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/x-session-id/i);
  });

  it("401 when session is invalid (user lookup returns null)", async () => {
    mockedGetUserBySession.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "bad-session")
      .send({ input: "any" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid session/);
  });

  it("does not call dispatcher when auth fails", async () => {
    await request(makeApp())
      .post("/api/search/cards")
      .send({ input: "any" });
    expect(mockedDispatchSearch).not.toHaveBeenCalled();
  });
});

describe("POST /api/search/cards — input validation", () => {
  beforeEach(() => {
    mockedGetUserBySession.mockResolvedValue({ userId: "user-1" });
  });

  it("400 when body.input is missing", async () => {
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/input/);
  });

  it("400 when body.input is not a string", async () => {
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: 12345 });
    expect(res.status).toBe(400);
  });

  it("400 when hint is provided but not 'cert' or 'freetext'", async () => {
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "any", hint: "auto" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hint/);
  });

  it("accepts hint='cert'", async () => {
    mockedDispatchSearch.mockResolvedValueOnce({
      input: { raw: "12345678", detectedMode: "cert", recognizingGraders: ["psa"] },
      candidates: [],
      warnings: [],
    });
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "12345678", hint: "cert" });
    expect(res.status).toBe(200);
    expect(mockedDispatchSearch).toHaveBeenCalledWith("12345678", "cert");
  });

  it("accepts hint='freetext'", async () => {
    mockedDispatchSearch.mockResolvedValueOnce({
      input: { raw: "Witt", detectedMode: "freetext" },
      candidates: [],
      warnings: [],
    });
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "Witt", hint: "freetext" });
    expect(res.status).toBe(200);
    expect(mockedDispatchSearch).toHaveBeenCalledWith("Witt", "freetext");
  });

  it("accepts undefined hint (auto-detect)", async () => {
    mockedDispatchSearch.mockResolvedValueOnce({
      input: { raw: "Witt", detectedMode: "freetext" },
      candidates: [],
      warnings: [],
    });
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "Witt" });
    expect(res.status).toBe(200);
    expect(mockedDispatchSearch).toHaveBeenCalledWith("Witt", undefined);
  });
});

describe("POST /api/search/cards — happy path", () => {
  beforeEach(() => {
    mockedGetUserBySession.mockResolvedValue({ userId: "user-1" });
  });

  it("200 with UnifiedSearchResponse shape on dispatcher success", async () => {
    const response = {
      input: { raw: "12345678", detectedMode: "cert", recognizingGraders: ["psa"] },
      candidates: [
        {
          candidateId: "psa:12345678",
          source: "psa-cert",
          attribution: "authoritative",
          confidence: 1.0,
          player: "Sample",
          year: 2020,
          brand: "Topps",
          setName: null,
          cardNumber: "1",
          parallel: null,
          variation: null,
          isAuto: false,
          serialNumber: null,
          grade: "10",
          gradeCompany: "PSA",
          gradeValue: 10,
          certNumber: "12345678",
          totalPopulation: 47,
          populationHigher: 0,
          title: "Sample Title — PSA 10",
          imageUrl: null,
          raw: { stub: true },
        },
      ],
      warnings: [],
    };
    mockedDispatchSearch.mockResolvedValueOnce(response);
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "12345678" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(response);
  });

  it("200 with empty candidates is a valid response (no candidates != error)", async () => {
    mockedDispatchSearch.mockResolvedValueOnce({
      input: { raw: "no-match", detectedMode: "freetext" },
      candidates: [],
      warnings: [],
    });
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "no-match" });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
  });
});

describe("POST /api/search/cards — unhandled error", () => {
  beforeEach(() => {
    mockedGetUserBySession.mockResolvedValue({ userId: "user-1" });
  });

  it("500 on unexpected dispatcher throw", async () => {
    mockedDispatchSearch.mockRejectedValueOnce(new Error("dispatcher boom"));
    const res = await request(makeApp())
      .post("/api/search/cards")
      .set("x-session-id", "s")
      .send({ input: "any" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/dispatcher boom/);
  });
});
