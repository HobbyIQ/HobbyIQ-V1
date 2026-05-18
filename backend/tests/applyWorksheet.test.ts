import { describe, it, expect } from "vitest";
import { applyWorksheet, parsePrintRun } from "../src/curation/applyWorksheet.js";
import { generateWorksheet, type Worksheet } from "../src/curation/worksheetGenerator.js";
import {
  analyzeEligibility,
  type StagedFileLike,
} from "../src/curation/eligibilityAnalyzer.js";

function eligible(): Worksheet {
  const staged: StagedFileLike = {
    schemaVersion: 1,
    year: 2024,
    brand: "Bowman Chrome",
    setLabel: "2024 Bowman Chrome Baseball",
    sourceUrl: "https://example.invalid/sheet.xlsx",
    parallels: [
      { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
      { rawName: "Gold", printRun: 50, isOneOfOne: false, note: null },
    ],
  };
  return generateWorksheet(analyzeEligibility(staged), {
    generatedAt: "2026-05-17T12:00:00Z",
  });
}

function reviewed(ws: Worksheet): Worksheet {
  return {
    ...ws,
    status: "reviewed",
    reviewedAt: "2026-05-17T15:00:00Z",
    reviewerNote: "Reviewed by Dave",
    parallels: ws.parallels.map((p) => ({
      ...p,
      color: { value: p.canonicalParallelName.toLowerCase(), provenance: "owner-edited" },
    })),
  };
}

describe("parsePrintRun", () => {
  it("parses /250 → 250", () => expect(parsePrintRun("/250")).toBe(250));
  it("parses '1/1' → 1", () => expect(parsePrintRun("1/1")).toBe(1));
  it("parses bare integer", () => expect(parsePrintRun("150")).toBe(150));
  it("returns null for Unnumbered/empty", () => {
    expect(parsePrintRun("Unnumbered")).toBeNull();
    expect(parsePrintRun("")).toBeNull();
    expect(parsePrintRun("n/a")).toBeNull();
  });
});

describe("applyWorksheet — gating", () => {
  it("rejects status=pending", async () => {
    await expect(
      applyWorksheet(eligible(), {
        reviewedBy: "owner",
        worksheetPath: "/tmp/ws.json",
      }),
    ).rejects.toThrow(/status must be "reviewed"/);
  });

  it("rejects when reviewedAt < generatedAt", async () => {
    const ws: Worksheet = {
      ...reviewed(eligible()),
      reviewedAt: "2026-01-01T00:00:00Z",
    };
    await expect(
      applyWorksheet(ws, { reviewedBy: "owner", worksheetPath: "/tmp/ws.json" }),
    ).rejects.toThrow(/BEFORE generatedAt/);
  });

  it("rejects empty reviewerNote", async () => {
    const ws = { ...reviewed(eligible()), reviewerNote: "" };
    await expect(
      applyWorksheet(ws, { reviewedBy: "owner", worksheetPath: "/tmp/ws.json" }),
    ).rejects.toThrow(/reviewerNote/);
  });

  it("requires container when apply=true", async () => {
    const ws = reviewed(eligible());
    await expect(
      applyWorksheet(ws, {
        reviewedBy: "owner",
        worksheetPath: "/tmp/ws.json",
        apply: true,
      }),
    ).rejects.toThrow(/container is required/);
  });
});

describe("applyWorksheet — dry run", () => {
  it("returns dry-run-would-upsert for every non-skipped row", async () => {
    const result = await applyWorksheet(reviewed(eligible()), {
      reviewedBy: "owner",
      worksheetPath: "/tmp/ws.json",
    });
    expect(result.apply).toBe(false);
    expect(result.dryRunCount).toBe(2);
    expect(result.upsertedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.rows.every((r) => r.outcome === "dry-run-would-upsert")).toBe(true);
    expect(result.rows[0]!.recordId).toBe("2024 Bowman Chrome Baseball|Blue|base");
  });

  it("records skipped rows when skip=true", async () => {
    const ws = reviewed(eligible());
    ws.parallels[1]!.skip = true;
    const result = await applyWorksheet(ws, {
      reviewedBy: "owner",
      worksheetPath: "/tmp/ws.json",
    });
    expect(result.dryRunCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.rows[1]!.outcome).toBe("skipped-by-flag");
  });

  it("records validation error when color is blank", async () => {
    const ws = reviewed(eligible());
    ws.parallels[0]!.color = { value: null, provenance: "blank" };
    const result = await applyWorksheet(ws, {
      reviewedBy: "owner",
      worksheetPath: "/tmp/ws.json",
    });
    expect(result.errorCount).toBe(1);
    expect(result.rows[0]!.outcome).toBe("skipped-validation-error");
    expect(result.rows[0]!.error).toMatch(/color is blank/);
    // Second row still dry-runs.
    expect(result.rows[1]!.outcome).toBe("dry-run-would-upsert");
  });
});

describe("applyWorksheet — record assembly", () => {
  it("builds composite id and sourceCitation correctly via mock container", async () => {
    type Captured = {
      id: string;
      sourceCitation: {
        type: string;
        beckettSourceUrl?: string;
        worksheetPath?: string;
      };
    };
    const captured: Captured[] = [];
    const mockContainer = {
      items: {
        upsert: async (record: Captured) => {
          captured.push(record);
          return { statusCode: 200, resource: record };
        },
      },
    };
    const result = await applyWorksheet(reviewed(eligible()), {
      reviewedBy: "owner",
      worksheetPath: "/abs/path/to/ws.json",
      apply: true,
      container: mockContainer as unknown as import("@azure/cosmos").Container,
    });
    expect(result.apply).toBe(true);
    expect(result.upsertedCount).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.id).toBe("2024 Bowman Chrome Baseball|Blue|base");
    expect(captured[0]!.sourceCitation.type).toBe("beckett-checklist+owner-curation");
    expect(captured[0]!.sourceCitation.beckettSourceUrl).toBe(
      "https://example.invalid/sheet.xlsx",
    );
    expect(captured[0]!.sourceCitation.worksheetPath).toBe("/abs/path/to/ws.json");
  });
});
