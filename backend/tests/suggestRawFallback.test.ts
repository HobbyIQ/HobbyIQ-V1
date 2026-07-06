// CF-TYPEAHEAD-RAW-FALLBACK (2026-07-05) — pins the /api/compiq/suggest
// contract that iOS uses to guard against the dropdown swallowing
// Return-key intent. Every response above the min-chars threshold
// carries a `rawFallback` object iOS renders as a permanent "Search
// catalog for '<query>'" row.

import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
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

vi.mock("../src/services/compiq/catalogSource.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // Return the noisy autocomplete that inspired the guard — "trout"
    // matches Trout & Flies before it matches Mike Trout.
    autocompleteCards: vi.fn(async () => ["Trout & Flies", "Trout Fishing Gear", "Trout River Runners"]),
  };
});

import app from "../src/app";

describe("CF-TYPEAHEAD-RAW-FALLBACK — GET /api/compiq/suggest", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("emits `rawFallback` with dispatch metadata when q ≥ 3 chars", async () => {
    const res = await request(app).get("/api/compiq/suggest?q=trout").set("x-session-id", "s");
    expect(res.status).toBe(200);
    expect(res.body.rawFallback).toBeTruthy();
    expect(res.body.rawFallback.text).toBe("trout");
    expect(res.body.rawFallback.label).toBe('Search catalog for "trout"');
    expect(res.body.rawFallback.dispatchEndpoint).toBe("/api/search/cards");
  });

  it("preserves the raw autocomplete suggestions alongside rawFallback", async () => {
    const res = await request(app).get("/api/compiq/suggest?q=trout").set("x-session-id", "s");
    expect(res.body.suggestions).toEqual(["Trout & Flies", "Trout Fishing Gear", "Trout River Runners"]);
  });

  it("emits rawFallback = null when q is below the 3-char threshold", async () => {
    const res = await request(app).get("/api/compiq/suggest?q=tr").set("x-session-id", "s");
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.rawFallback).toBeNull();
  });

  it("rawFallback.label preserves the original user casing (not the normalized lowercase)", async () => {
    const res = await request(app).get("/api/compiq/suggest?q=Mike+Trout").set("x-session-id", "s");
    expect(res.body.rawFallback.label).toBe('Search catalog for "Mike Trout"');
    // But the .text is normalized so iOS can hand it back to /search/cards without re-normalizing
    expect(res.body.rawFallback.text).toBe("mike trout");
  });
});
