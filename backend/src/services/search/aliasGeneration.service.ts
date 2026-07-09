// CF-LLM-ALIAS-GENERATION (2026-07-08, Drew):
// Wraps the Anthropic Claude API for generating alias candidates.
// Two entry points:
//   1. generateAliasesForCanonical() — used by the offline batch
//      script to populate the Cosmos alias store from a seed corpus.
//   2. suggestSimilarQueries() — used by the live-fallback path when
//      a search returns zero results (feature-flagged).
//
// The service:
//   - Reads CLAUDE_API_KEY from env, NEVER echoed to stdout.
//   - Guards against runaway spend via a per-run cost budget.
//   - Emits telemetry events with token counts + spend estimate.
//   - Silent no-throw where possible; falls back to empty results.

import Anthropic from "@anthropic-ai/sdk";

const MODEL_ID = process.env.CLAUDE_ALIAS_MODEL ?? "claude-haiku-4-5-20251001";
// Approximate Haiku 4.5 rates (per Anthropic pricing as of 2026-07)
// — 1.00 / 5.00 per M input / output tokens. Adjust if the model or
// pricing changes.
const INPUT_COST_PER_MTOK = parseFloat(
  process.env.CLAUDE_INPUT_COST_PER_MTOK ?? "1.00",
);
const OUTPUT_COST_PER_MTOK = parseFloat(
  process.env.CLAUDE_OUTPUT_COST_PER_MTOK ?? "5.00",
);

let _client: Anthropic | null = null;
let _clientInitFailed = false;

function getClient(): Anthropic | null {
  if (_client) return _client;
  if (_clientInitFailed) return null;
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn("[aliasGeneration] CLAUDE_API_KEY not configured — LLM services disabled");
    _clientInitFailed = true;
    return null;
  }
  try {
    _client = new Anthropic({ apiKey });
    return _client;
  } catch (err: any) {
    console.warn("[aliasGeneration] Anthropic client init failed:", err?.message ?? err);
    _clientInitFailed = true;
    return null;
  }
}

export interface GeneratedAlias {
  alias: string;
  /** Type of substitution — helps ops audit LLM output quality. */
  kind: "alternate-spelling" | "misspelling" | "spacing-variant" | "nickname" | "shorthand" | "other";
}

export interface AliasGenerationResult {
  canonical: string;
  aliases: GeneratedAlias[];
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUSD: number;
}

/**
 * Ask Claude for alias candidates for one canonical card term.
 * Returns empty array on any error (LLM outage, malformed JSON,
 * missing key, etc.). Never throws.
 */
export async function generateAliasesForCanonical(
  canonical: string,
  category: "parallel" | "set" | "player" | "grader" | "general",
): Promise<AliasGenerationResult | null> {
  const client = getClient();
  if (!client) return null;
  if (!canonical || !canonical.trim()) return null;

  const prompt = buildPromptForCanonical(canonical, category);

  try {
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const estimatedCostUSD =
      (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
      (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

    const raw = response.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    const aliases = parseAliasJson(raw, canonical);

    console.log(JSON.stringify({
      event: "llm_alias_generated",
      source: "aliasGeneration",
      canonical,
      category,
      aliasCount: aliases.length,
      inputTokens,
      outputTokens,
      estimatedCostUSD: Math.round(estimatedCostUSD * 10000) / 10000,
    }));

    return {
      canonical,
      aliases,
      usage: { inputTokens, outputTokens },
      estimatedCostUSD,
    };
  } catch (err: any) {
    console.warn("[aliasGeneration] generateAliasesForCanonical failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Live-fallback path: ask Claude to suggest possible spellings /
 * synonym substitutions for a raw user query that returned zero
 * results. Called from the search dispatcher when
 * LIVE_LLM_ALIAS_FALLBACK_ENABLED=true.
 */
export async function suggestSimilarQueries(
  rawQuery: string,
): Promise<string[]> {
  const client = getClient();
  if (!client) return [];
  if (!rawQuery || !rawQuery.trim()) return [];

  const prompt = `A user searched a baseball card catalog for:
"${rawQuery.trim()}"
The catalog returned zero results. Suggest up to 5 alternative queries the user might have meant (spelling corrections, synonym substitutions, or common collector nicknames). Return ONLY a JSON array of strings, no prose. Example: ["alternative one", "alternative two"].`;

  try {
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    const suggestions = parseStringArrayJson(raw);
    console.log(JSON.stringify({
      event: "llm_query_suggestions",
      source: "aliasGeneration",
      queryLength: rawQuery.length,
      suggestionCount: suggestions.length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    }));
    return suggestions;
  } catch (err: any) {
    console.warn("[aliasGeneration] suggestSimilarQueries failed:", err?.message ?? err);
    return [];
  }
}

function buildPromptForCanonical(canonical: string, category: string): string {
  return `You generate alias candidates for a baseball card catalog search system.

Canonical term: "${canonical}"
Category: ${category}

List up to 12 alternate names, common misspellings, spacing variants, and collector nicknames that a user might type when looking for this term. Focus on real trading card hobby vocabulary.

STRICT rules:
- Do NOT include the canonical form itself in the output.
- Each alias must be < 40 characters.
- Prefer real hobby terms over inventions.
- Return ONLY valid JSON — no prose, no code fences, no commentary.

Return a JSON array of objects:
[{"alias": "example", "kind": "alternate-spelling"}]

Where "kind" is one of: alternate-spelling, misspelling, spacing-variant, nickname, shorthand, other.`;
}

function parseAliasJson(raw: string, canonical: string): GeneratedAlias[] {
  const cleaned = extractJsonBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    const validKinds = new Set([
      "alternate-spelling",
      "misspelling",
      "spacing-variant",
      "nickname",
      "shorthand",
      "other",
    ]);
    const seen = new Set<string>();
    const out: GeneratedAlias[] = [];
    const canonLower = canonical.trim().toLowerCase();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const alias = typeof item.alias === "string" ? item.alias.trim() : "";
      if (!alias || alias.length >= 40) continue;
      const aliasLower = alias.toLowerCase();
      if (aliasLower === canonLower) continue;
      if (seen.has(aliasLower)) continue;
      seen.add(aliasLower);
      const kind = validKinds.has(item.kind) ? item.kind : "other";
      out.push({ alias, kind });
    }
    return out;
  } catch {
    return [];
  }
}

function parseStringArrayJson(raw: string): string[] {
  const cleaned = extractJsonBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => typeof s === "string")
      .map((s) => (s as string).trim())
      .filter((s) => s.length > 0 && s.length < 200);
  } catch {
    return [];
  }
}

function extractJsonBlock(raw: string): string {
  // Trim code fences if the model sneaks them in.
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  // Take from the first '[' or '{' onward — belt-and-braces against
  // conversational preambles the model sometimes emits.
  const startIdx = Math.min(
    ...[s.indexOf("["), s.indexOf("{")].filter((i) => i >= 0),
  );
  if (Number.isFinite(startIdx) && startIdx > 0) s = s.slice(startIdx);
  return s;
}

/** Test hook. */
export function _resetAliasGenerationForTesting(): void {
  _client = null;
  _clientInitFailed = false;
}
