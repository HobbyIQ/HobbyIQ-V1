import { describe, it, expect } from "vitest";
import {
  validateParallelAttributesRecord,
  type ParallelAttributesRecord,
} from "../src/services/parallelsReference/ingestion.js";

function base(): ParallelAttributesRecord {
  return {
    id: "2024 Bowman Chrome Baseball|Blue|base",
    set: "2024 Bowman Chrome Baseball",
    parallelName: "Blue",
    color: "blue",
    printRun: 150,
    isAutograph: false,
    parentVariant: "Refractor",
    tierWithinSet: 4,
    sourceCitation: {
      type: "beckett-checklist+owner-curation",
      date: "2026-05-17T15:00:00Z",
      beckettSourceUrl: "https://example.invalid/sheet.xlsx",
      worksheetPath: "/abs/path/ws.json",
      note: "reviewed by owner",
    },
    lastReviewedAt: "2026-05-17T15:00:00Z",
    reviewedBy: "owner",
    schemaVersion: 1,
  };
}

describe("Phase B SourceCitation variant", () => {
  it("accepts beckett-checklist+owner-curation citation with required fields", () => {
    expect(() => validateParallelAttributesRecord(base())).not.toThrow();
  });

  it("accepts citation without optional note", () => {
    const r = base();
    r.sourceCitation = {
      type: "beckett-checklist+owner-curation",
      date: "2026-05-17T15:00:00Z",
      beckettSourceUrl: "https://example.invalid/sheet.xlsx",
      worksheetPath: "/abs/path/ws.json",
    };
    expect(() => validateParallelAttributesRecord(r)).not.toThrow();
  });

  it("rejects citation with missing date", () => {
    const r = base();
    // @ts-expect-error — deliberately invalid for runtime validator test
    r.sourceCitation = {
      type: "beckett-checklist+owner-curation",
      beckettSourceUrl: "https://example.invalid/sheet.xlsx",
      worksheetPath: "/abs/path/ws.json",
    };
    expect(() => validateParallelAttributesRecord(r)).toThrow(/sourceCitation\.date/);
  });

  it("rejects citation with non-ISO date", () => {
    const r = base();
    r.sourceCitation = {
      type: "beckett-checklist+owner-curation",
      date: "May 17 2026",
      beckettSourceUrl: "https://example.invalid/sheet.xlsx",
      worksheetPath: "/abs/path/ws.json",
    };
    expect(() => validateParallelAttributesRecord(r)).toThrow();
  });
});

describe("existing SourceCitation variants still validate", () => {
  it("owner-knowledge", () => {
    const r = base();
    r.sourceCitation = { type: "owner-knowledge", date: "2026-05-17T15:00:00Z" };
    expect(() => validateParallelAttributesRecord(r)).not.toThrow();
  });

  it("ch-derived", () => {
    const r = base();
    r.sourceCitation = {
      type: "ch-derived",
      cardIdsSampled: ["x", "y"],
      date: "2026-05-17T15:00:00Z",
    };
    expect(() => validateParallelAttributesRecord(r)).not.toThrow();
  });
});
