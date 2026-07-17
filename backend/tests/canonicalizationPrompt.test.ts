// CF-PHASE-6A-CANONICALIZATION (2026-07-17) — pin prompt formatting
// + response parsing. Pure-function tests; no LLM calls.

import { describe, it, expect } from "vitest";
import {
  buildAdjudicationPrompt,
  parseAdjudicationResponse,
} from "../src/services/canonicalization/canonicalizationPrompt.service.js";

describe("buildAdjudicationPrompt", () => {
  it("emits the expected cluster count for downstream verification", () => {
    const { expectedClusterCount } = buildAdjudicationPrompt("player", [
      { strings: ["a"], min_similarity: 1 },
      { strings: ["b"], min_similarity: 1 },
      { strings: ["c"], min_similarity: 1 },
    ]);
    expect(expectedClusterCount).toBe(3);
  });

  it("labels groups 1..N in order", () => {
    const { prompt } = buildAdjudicationPrompt("player", [
      { strings: ["Mike Trout"], min_similarity: 1 },
      { strings: ["Chris Sale"], min_similarity: 1 },
    ]);
    expect(prompt).toContain("Group 1: [\"Mike Trout\"]");
    expect(prompt).toContain("Group 2: [\"Chris Sale\"]");
  });

  it("emits domain-specific rules for player", () => {
    const { prompt } = buildAdjudicationPrompt("player", [
      { strings: ["x"], min_similarity: 1 },
    ]);
    expect(prompt).toContain("Mike");
    expect(prompt).toContain("suffixes");
  });

  it("emits domain-specific rules for set", () => {
    const { prompt } = buildAdjudicationPrompt("set", [
      { strings: ["x"], min_similarity: 1 },
    ]);
    expect(prompt).toContain("YYYY Publisher");
  });

  it("emits domain-specific rules for variant", () => {
    const { prompt } = buildAdjudicationPrompt("variant", [
      { strings: ["x"], min_similarity: 1 },
    ]);
    expect(prompt).toContain("Refractor");
  });

  it("includes context lines when provided", () => {
    const { prompt } = buildAdjudicationPrompt("player", [
      {
        strings: ["Mike Trout"],
        min_similarity: 1,
        context: [{
          string: "Mike Trout",
          sample_sale_titles: ["2011 Topps Update Trout RC", "2012 Bowman Chrome"],
          sample_years: [2011, 2012],
          sample_sports: ["Baseball"],
        }],
      },
    ]);
    expect(prompt).toContain("2011 Topps Update Trout RC");
  });

  it("mandates JSON-only output", () => {
    const { prompt } = buildAdjudicationPrompt("set", [
      { strings: ["x"], min_similarity: 1 },
    ]);
    expect(prompt).toContain("Emit only the JSON");
  });
});

describe("parseAdjudicationResponse", () => {
  it("parses a single same=true resolution", () => {
    const raw = JSON.stringify([{
      group: 1,
      same: true,
      canonical: "Mike Trout",
      confidence: 0.98,
      reasoning: "spelling variants",
    }]);
    const parsed = parseAdjudicationResponse(raw, 1);
    expect(parsed).not.toBeNull();
    expect(parsed![0].same).toBe(true);
    expect(parsed![0].canonical).toBe("Mike Trout");
    expect(parsed![0].confidence).toBe(0.98);
  });

  it("parses a same=false resolution with splits", () => {
    const raw = JSON.stringify([{
      group: 1,
      same: false,
      splits: [
        { canonical: "Chris Sale (baseball)", strings: ["Chris Sale"] },
        { canonical: "Chris Sale (basketball)", strings: ["Christopher Sale"] },
      ],
      confidence: 0.87,
    }]);
    const parsed = parseAdjudicationResponse(raw, 1);
    expect(parsed).not.toBeNull();
    expect(parsed![0].same).toBe(false);
    expect(parsed![0].splits!.length).toBe(2);
    expect(parsed![0].splits![0].canonical).toBe("Chris Sale (baseball)");
  });

  it("strips markdown code fences (```json ... ```)", () => {
    const raw = "```json\n" + JSON.stringify([{
      same: true, canonical: "X", confidence: 0.9,
    }]) + "\n```";
    const parsed = parseAdjudicationResponse(raw, 1);
    expect(parsed).not.toBeNull();
    expect(parsed![0].canonical).toBe("X");
  });

  it("returns null when the response is not an array", () => {
    expect(parseAdjudicationResponse(JSON.stringify({ same: true }), 1)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseAdjudicationResponse("not json", 1)).toBeNull();
  });

  it("returns null when cluster count doesn't match expected", () => {
    const raw = JSON.stringify([
      { same: true, canonical: "X", confidence: 0.9 },
    ]);
    expect(parseAdjudicationResponse(raw, 2)).toBeNull();
  });

  it("returns null when same=true but canonical missing", () => {
    const raw = JSON.stringify([{ same: true, confidence: 0.9 }]);
    expect(parseAdjudicationResponse(raw, 1)).toBeNull();
  });

  it("returns null when same=false but splits missing", () => {
    const raw = JSON.stringify([{ same: false, confidence: 0.9 }]);
    expect(parseAdjudicationResponse(raw, 1)).toBeNull();
  });

  it("returns null when split.canonical is missing or empty", () => {
    const raw = JSON.stringify([{
      same: false,
      splits: [{ canonical: "", strings: ["x"] }],
      confidence: 0.9,
    }]);
    expect(parseAdjudicationResponse(raw, 1)).toBeNull();
  });

  it("clamps out-of-range confidence to 0.5 default (defensive)", () => {
    const raw = JSON.stringify([{
      same: true, canonical: "X", confidence: 5,
    }]);
    const parsed = parseAdjudicationResponse(raw, 1);
    expect(parsed).not.toBeNull();
    expect(parsed![0].confidence).toBe(0.5);
  });

  it("preserves reasoning when present", () => {
    const raw = JSON.stringify([{
      same: true, canonical: "X", confidence: 0.9, reasoning: "same person",
    }]);
    const parsed = parseAdjudicationResponse(raw, 1);
    expect(parsed![0].reasoning).toBe("same person");
  });
});
