import { describe, expect, it } from "vitest";
import {
  type ParallelAttributesRecord,
  validateParallelAttributesRecord,
} from "../src/services/parallelsReference/ingestion.js";

function baseRecord(): ParallelAttributesRecord {
  return {
    id: "2022 Topps Baseball|Gold|base",
    set: "2022 Topps Baseball",
    parallelName: "Gold",
    color: "gold",
    printRun: 2022,
    isAutograph: false,
    parentVariant: null,
    tierWithinSet: 3,
    sourceCitation: {
      type: "owner-knowledge",
      date: "2026-05-17T12:00:00Z",
    },
    lastReviewedAt: "2026-05-17T12:00:00Z",
    reviewedBy: "owner",
    schemaVersion: 1,
  };
}

describe("SourceCitation variants", () => {
  it("accepts cardboard-connection-checklist+owner-curation", () => {
    const record = baseRecord();
    record.sourceCitation = {
      type: "cardboard-connection-checklist+owner-curation",
      date: "2026-05-17T12:00:00Z",
      cardboardConnectionSourceUrl:
        "https://www.cardboardconnection.com/wp-content/uploads/2022/02/2022-Topps-Series-1-Baseball-checklist-Excel-spreadsheet.xlsx",
      worksheetPath: "/tmp/2022-topps.json",
    };

    expect(() => validateParallelAttributesRecord(record)).not.toThrow();
  });

  it("rejects cardboard connection citation without source url", () => {
    const record = baseRecord();
    // @ts-expect-error deliberate runtime validation case
    record.sourceCitation = {
      type: "cardboard-connection-checklist+owner-curation",
      date: "2026-05-17T12:00:00Z",
      worksheetPath: "/tmp/2022-topps.json",
    };

    expect(() => validateParallelAttributesRecord(record)).toThrow(
      /sourceCitation\.cardboardConnectionSourceUrl/,
    );
  });

  it("still accepts beckett-checklist+owner-curation", () => {
    const record = baseRecord();
    record.sourceCitation = {
      type: "beckett-checklist+owner-curation",
      date: "2026-05-17T12:00:00Z",
      beckettSourceUrl: "https://beckett-www.s3.amazonaws.com/example.xlsx",
      worksheetPath: "/tmp/2022-bowman.json",
    };

    expect(() => validateParallelAttributesRecord(record)).not.toThrow();
  });
});