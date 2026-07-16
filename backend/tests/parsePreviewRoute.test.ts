// CF-PARSE-PREVIEW (2026-07-09, Drew) — thin sanity tests for the
// POST /api/compiq/parse-preview route. The heavy lifting is already
// tested by cardQueryParser.test.ts; this just locks in the wire
// contract iOS reads (chips array, confidence float, parsed object
// shape).

import { describe, it, expect, vi } from "vitest";
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

import app from "../src/app";

describe("POST /api/compiq/parse-preview", () => {
  it("returns chips + parsed for a well-formed query", async () => {
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({ query: "2026 bowman chrome owen carey black bcp-69" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.parsed).toBeTruthy();
    expect(res.body.parsed.playerName).toBe("Owen Carey");
    expect(res.body.parsed.year).toBe(2026);
    expect(res.body.parsed.parallel).toBe("Black");
    expect(res.body.parsed.cardNumber).toBe("BCP-69");
    expect(Array.isArray(res.body.chips)).toBe(true);
    // The chip row is presentation-ready — no null slots.
    for (const chip of res.body.chips) {
      expect(chip).toHaveProperty("label");
      expect(chip).toHaveProperty("value");
      expect(chip.label).toBeTruthy();
      expect(chip.value).toBeTruthy();
    }
    // Owen Carey Black BCP-69 should produce chips for Player, Year,
    // Brand, Set (if not identical to brand), Parallel, #.
    const labels = new Set(
      (res.body.chips as Array<{ label: string }>).map((c) => c.label),
    );
    expect(labels.has("Player")).toBe(true);
    expect(labels.has("Year")).toBe(true);
    expect(labels.has("Parallel")).toBe(true);
    expect(labels.has("#")).toBe(true);
  });

  it("handles empty query gracefully (returns empty structure, no error)", async () => {
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({ query: "" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.parsed).toBeNull();
    expect(res.body.confidence).toBe(0);
  });

  it("handles missing query field gracefully", async () => {
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.parsed).toBeNull();
  });

  it("filters out chip slots whose parser fields are null", async () => {
    // Bare "owen carey" — no year, no set, no parallel, no card #.
    // Only the Player chip should show up.
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({ query: "owen carey" });

    expect(res.status).toBe(200);
    const chips = res.body.chips as Array<{ label: string; value: string }>;
    expect(chips.every((c) => c.value != null && c.value.length > 0)).toBe(true);
    const labels = chips.map((c) => c.label);
    // Player must be there; year/parallel/# must NOT be there.
    expect(labels).toContain("Player");
    expect(labels).not.toContain("Year");
    expect(labels).not.toContain("Parallel");
    expect(labels).not.toContain("#");
  });

  it("includes Auto chip when isAuto is inferred", async () => {
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({ query: "2025 bowman draft chrome red auto ethan salas cpa-es" });

    expect(res.status).toBe(200);
    const chips = res.body.chips as Array<{ label: string; value: string }>;
    const autoChip = chips.find((c) => c.label === "Auto");
    expect(autoChip).toBeTruthy();
  });

  it("includes Grade chip when both grader + grade are present", async () => {
    const res = await request(app)
      .post("/api/compiq/parse-preview")
      .set("x-session-id", "test-sess")
      .send({ query: "2021 topps chrome shohei ohtani psa 10" });

    expect(res.status).toBe(200);
    const chips = res.body.chips as Array<{ label: string; value: string }>;
    const gradeChip = chips.find((c) => c.label === "Grade");
    expect(gradeChip).toBeTruthy();
    expect(gradeChip!.value).toBe("PSA 10");
  });
});
