// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4 PR B). Route-shape
// smoke tests. Cosmos is stubbed via vi.mock — the goal is to verify
// (a) canonicalization uses slug() consistently, (b) 400s on bad input,
// (c) exact vs fuzzy vs miss branches all return the expected shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const listParallelsByProductYearMock = vi.fn();
const getParallelByCanonicalKeyMock = vi.fn();
const listParallelsForFuzzyResolveMock = vi.fn();

vi.mock("../src/repositories/referenceCatalog.repository.js", () => ({
  listParallelsByProductYear: (...args: unknown[]) =>
    listParallelsByProductYearMock(...args),
  getParallelByCanonicalKey: (...args: unknown[]) =>
    getParallelByCanonicalKeyMock(...args),
  listParallelsForFuzzyResolve: (...args: unknown[]) =>
    listParallelsForFuzzyResolveMock(...args),
}));

async function buildApp() {
  const routes = await import("../src/routes/reference.routes");
  const app = express();
  app.use("/api/reference", routes.default);
  return app;
}

const doc = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "abc123",
  docType: "parallel",
  productKey: "bowman",
  product: "Bowman",
  year: 2026,
  cardSetKey: "chrome",
  cardSet: "Chrome",
  parallelKey: "gold-refractor",
  parallel: "Gold Refractor",
  printRun: 50,
  numbered: true,
  runVaries: false,
  perCardRun: false,
  auto: false,
  licensed: true,
  confidence: "Verified",
  notes: "",
  sourceUrl: null,
  schemaVersion: 1,
  updatedAt: "2026-07-10T00:00:00.000Z",
  ...overrides,
});

describe("GET /api/reference/parallels", () => {
  beforeEach(() => {
    listParallelsByProductYearMock.mockReset();
    getParallelByCanonicalKeyMock.mockReset();
    listParallelsForFuzzyResolveMock.mockReset();
  });

  it("400s on missing product", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/reference/parallels?year=2026");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400s on missing / bad year", async () => {
    const app = await buildApp();
    const r1 = await request(app).get("/api/reference/parallels?product=Bowman");
    expect(r1.status).toBe(400);
    const r2 = await request(app).get(
      "/api/reference/parallels?product=Bowman&year=abc",
    );
    expect(r2.status).toBe(400);
    const r3 = await request(app).get(
      "/api/reference/parallels?product=Bowman&year=1800",
    );
    expect(r3.status).toBe(400);
  });

  it("canonicalizes product via slug() before the Cosmos call", async () => {
    listParallelsByProductYearMock.mockResolvedValue([]);
    const app = await buildApp();
    await request(app)
      .get("/api/reference/parallels?product=Bowman%20Chrome&year=2026");
    expect(listParallelsByProductYearMock).toHaveBeenCalledWith(
      "bowman-chrome",
      2026,
    );
  });

  it("returns docs verbatim + count", async () => {
    const docs = [doc(), doc({ parallel: "Red Refractor", parallelKey: "red-refractor", printRun: 5 })];
    listParallelsByProductYearMock.mockResolvedValue(docs);
    const app = await buildApp();
    const res = await request(app).get(
      "/api/reference/parallels?product=Bowman&year=2026",
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.parallels).toHaveLength(2);
    expect(res.body.productKey).toBe("bowman");
  });
});

describe("GET /api/reference/parallels/resolve", () => {
  beforeEach(() => {
    listParallelsByProductYearMock.mockReset();
    getParallelByCanonicalKeyMock.mockReset();
    listParallelsForFuzzyResolveMock.mockReset();
  });

  it("400s on missing parallel", async () => {
    const app = await buildApp();
    const res = await request(app).get(
      "/api/reference/parallels/resolve?product=Bowman&year=2026",
    );
    expect(res.status).toBe(400);
  });

  it("returns exact match when canonical key hits (with cardSet)", async () => {
    const hit = doc();
    getParallelByCanonicalKeyMock.mockResolvedValue(hit);
    const app = await buildApp();
    const res = await request(app).get(
      "/api/reference/parallels/resolve?product=Bowman&year=2026&cardSet=Chrome&parallel=Gold%20Refractor",
    );
    expect(res.status).toBe(200);
    expect(res.body.match).toBe("exact");
    expect(res.body.parallel.parallelKey).toBe("gold-refractor");
    expect(getParallelByCanonicalKeyMock).toHaveBeenCalledWith(
      "bowman",
      2026,
      "chrome",
      "gold-refractor",
    );
    // Fuzzy fallback should not be reached on exact hit.
    expect(listParallelsForFuzzyResolveMock).not.toHaveBeenCalled();
  });

  it("falls back to fuzzy match when exact misses", async () => {
    getParallelByCanonicalKeyMock.mockResolvedValue(null);
    listParallelsForFuzzyResolveMock.mockResolvedValue([
      doc({ parallelKey: "gold-refractor", parallel: "Gold Refractor" }),
      doc({ parallelKey: "blue-refractor", parallel: "Blue Refractor" }),
    ]);
    const app = await buildApp();
    const res = await request(app).get(
      "/api/reference/parallels/resolve?product=Bowman&year=2026&cardSet=Chrome&parallel=Gold",
    );
    expect(res.status).toBe(200);
    // "gold" tokens ⊂ "gold-refractor" → highest score
    expect(res.body.parallel.parallelKey).toBe("gold-refractor");
  });

  it("returns miss when no candidates + no exact", async () => {
    getParallelByCanonicalKeyMock.mockResolvedValue(null);
    listParallelsForFuzzyResolveMock.mockResolvedValue([]);
    const app = await buildApp();
    const res = await request(app).get(
      "/api/reference/parallels/resolve?product=Bowman&year=2026&parallel=Nonesuch",
    );
    expect(res.status).toBe(200);
    expect(res.body.match).toBe("miss");
    expect(res.body.parallel).toBeNull();
  });

  it("returns miss when best fuzzy score is below threshold", async () => {
    getParallelByCanonicalKeyMock.mockResolvedValue(null);
    listParallelsForFuzzyResolveMock.mockResolvedValue([
      doc({ parallelKey: "gold-refractor", parallel: "Gold Refractor" }),
    ]);
    const app = await buildApp();
    // Zero overlap with "gold-refractor" — score should be 0, well below 0.35.
    const res = await request(app).get(
      "/api/reference/parallels/resolve?product=Bowman&year=2026&parallel=Blue%20Prizm",
    );
    expect(res.status).toBe(200);
    expect(res.body.match).toBe("miss");
    expect(res.body.parallel).toBeNull();
  });
});
