// CF-PHASE-6A-CANONICALIZATION (Drew, 2026-07-17). Prompt construction
// + response parsing for the LLM adjudication step. Pure functions;
// tested with fixtures. LLM I/O lives in canonicalizationLLM.service.ts.

import type { CandidateCluster, LLMResolution, CanonicalEntityType } from "../../types/chCanonical.types.js";

/**
 * Build a batched prompt asking the LLM to resolve up to N candidate
 * clusters at once. Batching is the cost lever — 100 clusters per call
 * amortizes the system-prompt overhead.
 *
 * Returns { prompt, expectedClusterCount } for verification when parsing.
 */
export function buildAdjudicationPrompt(
  entityType: CanonicalEntityType,
  clusters: ReadonlyArray<CandidateCluster>,
): { prompt: string; expectedClusterCount: number } {
  const clusterCount = clusters.length;
  const domainRules = domainRulesForType(entityType);

  const clusterBlocks = clusters.map((c, i) => {
    const stringsLine = c.strings.map((s) => `"${s}"`).join(", ");
    const contextLines: string[] = [];
    if (c.context && c.context.length > 0) {
      for (const ctx of c.context.slice(0, 3)) {
        const sample = ctx.sample_sale_titles.slice(0, 2).join(" | ");
        contextLines.push(`    "${ctx.string}" — recent: ${sample}`);
      }
    }
    return `Group ${i + 1}: [${stringsLine}]${contextLines.length ? "\n  Context:\n" + contextLines.join("\n") : ""}`;
  }).join("\n\n");

  const prompt = `You're normalizing sports card database ${entityType} strings.

For each candidate group, decide if all strings refer to the SAME ${entityType}.
- If yes: output the canonical form.
- If no: split into subgroups.

${domainRules}

Output a JSON array with EXACTLY ${clusterCount} objects, one per group in order:
[
  {
    "group": 1,
    "same": true,
    "canonical": "Mike Trout",
    "confidence": 0.98,
    "reasoning": "All strings are spelling/case variants of the same player."
  },
  {
    "group": 2,
    "same": false,
    "splits": [
      {"canonical": "Chris Sale", "strings": ["Chris Sale", "C. Sale"]},
      {"canonical": "Christopher Sale (basketball)", "strings": ["Christopher Sale (basketball)"]}
    ],
    "confidence": 0.85,
    "reasoning": "Two different athletes with the same name."
  }
]

Emit only the JSON. No prose before or after.

Groups:

${clusterBlocks}`;

  return { prompt, expectedClusterCount: clusterCount };
}

/**
 * Domain-specific normalization rules to hint the LLM about the shape
 * of the entity. Kept short — the LLM already knows sports cards; we're
 * just biasing tie-breaks.
 */
function domainRulesForType(entityType: CanonicalEntityType): string {
  if (entityType === "player") {
    return `Rules:
- Prefer "FirstName LastName" (not initials, not surname-first).
- Preserve suffixes: Jr, Sr, II, III, IV.
- Treat "Mike" and "Michael" as the same person when other signals agree.
- Split when players share a name but different sport / era.
- Ignore team names / era annotations in the canonical.`;
  }
  if (entityType === "set") {
    return `Rules:
- Prefer "YYYY Publisher SetName" ("2011 Topps Update").
- Merge when the same product is written as "Topps Update" and "2011 Topps Update".
- Split when the same publisher / name are different products across years.
- Distinguish "Chrome" / "Update" / "Draft" as distinct products.`;
  }
  // variant
  return `Rules:
- Prefer the shortest canonical form ("Base", "Refractor", "Gold").
- Merge print-run variance: "Gold /50" and "Gold" of the same set/year map to the same variant.
- Split parallels of different colors or finishes even if the base name matches.
- Preserve "Auto" / "Autograph" only when it's a distinct variant, not a modifier.`;
}

/**
 * Parse the LLM's JSON response back into a typed array. Defensive:
 * malformed responses produce null so the caller can retry the batch.
 */
export function parseAdjudicationResponse(
  responseText: string,
  expectedClusterCount: number,
): LLMResolution[] | null {
  const trimmed = responseText.trim();
  // Strip markdown code fences if present.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length !== expectedClusterCount) return null;

  const out: LLMResolution[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const same = item?.same === true;
    const confidence = typeof item?.confidence === "number" && item.confidence >= 0 && item.confidence <= 1
      ? item.confidence
      : 0.5;
    const reasoning = typeof item?.reasoning === "string" ? item.reasoning : undefined;
    if (same) {
      const canonical = typeof item?.canonical === "string" ? item.canonical.trim() : "";
      if (!canonical) return null;
      out.push({ same: true, canonical, confidence, reasoning });
    } else {
      const splits = Array.isArray(item?.splits) ? item.splits : null;
      if (!splits) return null;
      const parsedSplits: LLMResolution["splits"] = [];
      for (const s of splits as Array<Record<string, unknown>>) {
        const c = typeof s?.canonical === "string" ? s.canonical.trim() : "";
        const strings = Array.isArray(s?.strings) ? (s.strings as unknown[]).filter((x): x is string => typeof x === "string") : null;
        if (!c || !strings) return null;
        parsedSplits.push({ canonical: c, strings });
      }
      out.push({ same: false, splits: parsedSplits, confidence, reasoning });
    }
  }
  return out;
}
