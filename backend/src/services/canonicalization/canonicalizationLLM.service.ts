// CF-PHASE-6A-CANONICALIZATION (Drew, 2026-07-17). Anthropic client
// wrapper for the adjudication step. Same shape / pattern as
// aliasGeneration.service.ts (which already ships) — kept separate so
// its own model + cost knobs are tunable independently.

import Anthropic from "@anthropic-ai/sdk";
import type { CandidateCluster, LLMResolution, CanonicalEntityType } from "../../types/chCanonical.types.js";
import { buildAdjudicationPrompt, parseAdjudicationResponse } from "./canonicalizationPrompt.service.js";

const MODEL_ID = process.env.CLAUDE_CANONICALIZATION_MODEL ?? "claude-haiku-4-5-20251001";
const INPUT_COST_PER_MTOK = parseFloat(process.env.CLAUDE_INPUT_COST_PER_MTOK ?? "1.00");
const OUTPUT_COST_PER_MTOK = parseFloat(process.env.CLAUDE_OUTPUT_COST_PER_MTOK ?? "5.00");
/** Batch size — number of candidate clusters per LLM call. Larger =
 *  cheaper per cluster but higher tokens per call. 100 balances
 *  amortization against token budget (Haiku 4.5 has 200k context;
 *  100 clusters × ~10 strings × ~30 chars = ~30k chars fits easily). */
const DEFAULT_BATCH = parseInt(process.env.CLAUDE_CANONICALIZATION_BATCH ?? "100", 10);

let _client: Anthropic | null = null;
let _initFailed = false;

function getClient(): Anthropic | null {
  if (_client) return _client;
  if (_initFailed) return null;
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn("[canonicalization] CLAUDE_API_KEY not configured — LLM adjudication disabled");
    _initFailed = true;
    return null;
  }
  try {
    _client = new Anthropic({ apiKey });
    return _client;
  } catch (err: any) {
    console.warn("[canonicalization] client init failed:", err?.message ?? err);
    _initFailed = true;
    return null;
  }
}

export interface AdjudicateBatchResult {
  resolutions: LLMResolution[];
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Adjudicate a single batch of candidate clusters. Never throws — on
 * any failure (parse error, LLM outage, malformed output), returns
 * empty resolutions so the caller can decide to retry a smaller batch
 * or accept the vector-cluster output as-is.
 */
export async function adjudicateClusterBatch(
  entityType: CanonicalEntityType,
  clusters: ReadonlyArray<CandidateCluster>,
): Promise<AdjudicateBatchResult> {
  const empty: AdjudicateBatchResult = { resolutions: [], costUSD: 0, inputTokens: 0, outputTokens: 0 };
  const client = getClient();
  if (!client) return empty;
  if (clusters.length === 0) return empty;

  const { prompt, expectedClusterCount } = buildAdjudicationPrompt(entityType, clusters);

  try {
    const response = await client.messages.create({
      model: MODEL_ID,
      // Rough upper bound: ~150 tokens per JSON object × N clusters.
      max_tokens: Math.min(8000, Math.max(500, expectedClusterCount * 200)),
      messages: [{ role: "user", content: prompt }],
    });
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costUSD =
      (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
      (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

    // Response.content is an array of content blocks; concat any text blocks.
    // Use a runtime-narrowed loop instead of a type predicate — the SDK's
    // TextBlock type has additional required fields (citations) we don't
    // need, so writing an accurate type-guard for it is more churn than
    // it's worth here.
    let text = "";
    for (const block of response.content) {
      if ((block as { type?: string }).type === "text") {
        text += (block as { text?: string }).text ?? "";
      }
    }

    const resolutions = parseAdjudicationResponse(text, expectedClusterCount);
    if (!resolutions) {
      console.warn(JSON.stringify({
        event: "canonicalization_llm_parse_failed",
        source: "canonicalizationLLM.service",
        entityType,
        expectedClusterCount,
        outputTokens,
        preview: text.slice(0, 200),
      }));
      return { resolutions: [], costUSD, inputTokens, outputTokens };
    }
    return { resolutions, costUSD, inputTokens, outputTokens };
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "canonicalization_llm_error",
      source: "canonicalizationLLM.service",
      entityType,
      clusterCount: clusters.length,
      error: err?.message ?? String(err),
    }));
    return empty;
  }
}

/**
 * Adjudicate a list of clusters split into DEFAULT_BATCH-sized chunks.
 * Returns aggregate resolutions in the same order as the input.
 */
export async function adjudicateClusters(
  entityType: CanonicalEntityType,
  clusters: ReadonlyArray<CandidateCluster>,
  opts: { batchSize?: number } = {},
): Promise<{
  resolutions: LLMResolution[];
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  batchesRun: number;
  batchesFailed: number;
}> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const out: LLMResolution[] = [];
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let batchesRun = 0;
  let batchesFailed = 0;
  for (let i = 0; i < clusters.length; i += batchSize) {
    const slice = clusters.slice(i, i + batchSize);
    const result = await adjudicateClusterBatch(entityType, slice);
    batchesRun++;
    totalCost += result.costUSD;
    totalIn += result.inputTokens;
    totalOut += result.outputTokens;
    if (result.resolutions.length === slice.length) {
      out.push(...result.resolutions);
    } else {
      // On partial/failed batch, insert placeholder resolutions (same=false
      // with confidence 0) so the array stays aligned. The caller can
      // then decide to retry / fall back to embedding-only clustering.
      for (const _ of slice) {
        out.push({ same: false, splits: [], confidence: 0, reasoning: "batch failed" });
      }
      batchesFailed++;
    }
  }
  return { resolutions: out, totalCostUSD: totalCost, totalInputTokens: totalIn, totalOutputTokens: totalOut, batchesRun, batchesFailed };
}
