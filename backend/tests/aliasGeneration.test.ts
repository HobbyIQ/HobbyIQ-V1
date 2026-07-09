// CF-LLM-ALIAS-GENERATION (2026-07-08) — JSON parsing + robustness
// for Claude alias generation. Doesn't hit the Anthropic API — mocks
// the client so tests run offline.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLAUDE_API_KEY = "test-key";
});

async function loadService() {
  const mod = await import("../src/services/search/aliasGeneration.service.js");
  mod._resetAliasGenerationForTesting();
  return mod;
}

describe("CF-LLM-ALIAS-GENERATION — generateAliasesForCanonical", () => {
  it("parses valid Claude JSON response into GeneratedAlias[]", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { alias: "bubblegum", kind: "alternate-spelling" },
            { alias: "bubble gum", kind: "spacing-variant" },
            { alias: "snackpack", kind: "nickname" },
          ]),
        },
      ],
      usage: { input_tokens: 40, output_tokens: 60 },
    });
    const { generateAliasesForCanonical } = await loadService();

    const result = await generateAliasesForCanonical("gum ball", "parallel");
    expect(result).not.toBeNull();
    expect(result!.aliases).toHaveLength(3);
    expect(result!.aliases[0].alias).toBe("bubblegum");
    expect(result!.aliases[0].kind).toBe("alternate-spelling");
    expect(result!.usage.inputTokens).toBe(40);
    expect(result!.usage.outputTokens).toBe(60);
  });

  it("dedupes aliases and drops the canonical itself", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { alias: "gum ball", kind: "other" },   // === canonical, must drop
            { alias: "bubblegum", kind: "alternate-spelling" },
            { alias: "Bubblegum", kind: "alternate-spelling" }, // case-dupe of prior
            { alias: "snackpack", kind: "nickname" },
          ]),
        },
      ],
      usage: { input_tokens: 40, output_tokens: 60 },
    });
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("gum ball", "parallel");
    expect(result!.aliases.map((a) => a.alias.toLowerCase())).toEqual([
      "bubblegum",
      "snackpack",
    ]);
  });

  it("survives markdown code fences around the JSON", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '```json\n[{"alias":"bubble gum","kind":"spacing-variant"}]\n```',
        },
      ],
      usage: { input_tokens: 30, output_tokens: 20 },
    });
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("gum ball", "parallel");
    expect(result!.aliases).toHaveLength(1);
    expect(result!.aliases[0].alias).toBe("bubble gum");
  });

  it("returns null when CLAUDE_API_KEY is missing", async () => {
    delete process.env.CLAUDE_API_KEY;
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("anything", "parallel");
    expect(result).toBeNull();
    process.env.CLAUDE_API_KEY = "test-key";
  });

  it("returns null on Claude API error", async () => {
    mockCreate.mockRejectedValue(new Error("rate-limited"));
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("anything", "parallel");
    expect(result).toBeNull();
  });

  it("returns empty aliases on malformed JSON", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "not a valid json" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("gum ball", "parallel");
    expect(result).not.toBeNull();
    expect(result!.aliases).toEqual([]);
  });

  it("estimates cost based on token counts", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    // Using default rates: $1/M input, $5/M output
    // Expected: 1000/1M * 1 + 500/1M * 5 = 0.001 + 0.0025 = 0.0035
    const { generateAliasesForCanonical } = await loadService();
    const result = await generateAliasesForCanonical("test", "parallel");
    expect(result!.estimatedCostUSD).toBeCloseTo(0.0035, 5);
  });
});

describe("CF-LLM-ALIAS-GENERATION — suggestSimilarQueries", () => {
  it("returns parsed string array from Claude response", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            "Josiah Hartshorn 2025 Bowman Draft Chrome",
            "Josiah Hartshorn Gum Ball Auto",
            "J. Hartshorn Bubblegum",
          ]),
        },
      ],
      usage: { input_tokens: 30, output_tokens: 40 },
    });
    const { suggestSimilarQueries } = await loadService();
    const result = await suggestSimilarQueries("Josia Hartshorn Bubblegum");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Josiah Hartshorn 2025 Bowman Draft Chrome");
  });

  it("returns empty array when CLAUDE_API_KEY missing", async () => {
    delete process.env.CLAUDE_API_KEY;
    const { suggestSimilarQueries } = await loadService();
    const result = await suggestSimilarQueries("anything");
    expect(result).toEqual([]);
    process.env.CLAUDE_API_KEY = "test-key";
  });
});
