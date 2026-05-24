/**
 * Phase 1 MCP rewire — route-layer tests for GET /api/compiq/comps-by-player.
 * Covers query-param validation (400 responses) and happy-path shape via a
 * mocked service. Service-internal aggregation behavior is covered in
 * compsByPlayer.service.test.ts.
 */
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service BEFORE importing the app so the route picks up the mock.
vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: vi.fn(),
}));

import * as svc from "../src/services/compiq/compsByPlayer.service.js";
import app from "../src/app";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/compiq/comps-by-player — validation", () => {
  it("400 when playerName missing", async () => {
    const res = await request(app).get("/api/compiq/comps-by-player?product=Topps+Update");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerName/i);
    expect(svc.fetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("400 when product missing", async () => {
    const res = await request(app).get("/api/compiq/comps-by-player?playerName=Mike+Trout");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product/i);
    expect(svc.fetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("400 when cardYear is non-numeric", async () => {
    const res = await request(app).get(
      "/api/compiq/comps-by-player?playerName=Mike+Trout&product=Topps+Update&cardYear=abc",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cardYear/i);
    expect(svc.fetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("400 when cardYear is out of range", async () => {
    const res = await request(app).get(
      "/api/compiq/comps-by-player?playerName=Mike+Trout&product=Topps+Update&cardYear=1899",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cardYear/i);
  });
});

describe("GET /api/compiq/comps-by-player — happy path", () => {
  it("forwards query params to the service and returns its response unchanged", async () => {
    const stub = {
      player: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      cardIds: ["card-1"],
      comps: [
        { cardId: "card-1", price: 310, date: "2026-05-20T00:00:00Z", title: "2011 Topps Update Trout", source: "cardsight" as const },
      ],
      cached: false,
      warnings: [],
    };
    (svc.fetchCompsByPlayer as any).mockResolvedValue(stub);

    const res = await request(app).get(
      "/api/compiq/comps-by-player?playerName=Mike+Trout&product=Topps+Update&cardYear=2011",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(stub);
    expect(svc.fetchCompsByPlayer).toHaveBeenCalledWith({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      parallel: undefined,
      gradeCompany: undefined,
      gradeValue: undefined,
    });
  });

  it("forwards optional parallel + grade* params when present", async () => {
    (svc.fetchCompsByPlayer as any).mockResolvedValue({
      player: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      cardIds: [],
      comps: [],
      cached: false,
      warnings: [],
    });

    await request(app).get(
      "/api/compiq/comps-by-player?playerName=Mike+Trout&product=Topps+Update&cardYear=2011&parallel=Refractor&gradeCompany=PSA&gradeValue=10",
    );
    expect(svc.fetchCompsByPlayer).toHaveBeenCalledWith({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      parallel: "Refractor",
      gradeCompany: "PSA",
      gradeValue: "10",
    });
  });
});
