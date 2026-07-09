// CF-QUERY-ALIAS-EXPANSION (2026-07-08, Drew):
// Given a raw user query, produce up to N alias-substituted variants
// suitable for a fan-out CH search. Preserves the ORIGINAL query as
// the highest-priority variant (rank +1.0) and each expanded variant
// gets +0.5, so callers can merge results and preserve relevance.
//
// Called by /suggest-corrections and by any future search route that
// wants the alias-fanout behavior.

import { getAliasIndex } from "./aliasStore.service.js";

export interface ExpandedQueryVariant {
  query: string;
  /** Relevance boost. Original query = 1.0; each alias substitution
   *  yields 1 - 0.5 * <hops from original>. Callers add this to their
   *  own scoring signal (e.g. CH match score) to preserve ordering. */
  rankBoost: number;
  /** Tokens that were substituted, for observability. */
  substitutions: Array<{ from: string; to: string; category: string }>;
}

const MAX_VARIANTS_DEFAULT = 5;
const MAX_TOKEN_LENGTH_FOR_LOOKUP = 40;

/**
 * Tokenize the raw query into whitespace-separated tokens, preserving
 * case. Multi-word tokens ("gum ball") are ALSO tried as a single
 * lookup key so aliases like "gum ball" → "bubblegum" fire on the
 * 2-token compound.
 */
function tokenize(raw: string): { tokens: string[]; bigrams: string[] } {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  const tokens = cleaned.split(" ").filter(Boolean);
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return { tokens, bigrams };
}

/**
 * Produce alias-substituted variants of the raw query. Always includes
 * the original as variant #0. Never returns duplicates. Bounded to
 * `maxVariants` — original + N-1 substitutions.
 */
export async function expandQueryWithAliases(
  rawQuery: string,
  opts: { maxVariants?: number } = {},
): Promise<ExpandedQueryVariant[]> {
  const query = rawQuery.trim();
  if (!query) return [];
  const maxVariants = opts.maxVariants ?? MAX_VARIANTS_DEFAULT;

  const idx = await getAliasIndex();
  const { tokens, bigrams } = tokenize(query);

  // For each token (and bigram), find any alias mapping and produce a
  // substituted-query candidate. Deduplicated by normalized string.
  const variants = new Map<string, ExpandedQueryVariant>();
  variants.set(query.toLowerCase(), {
    query,
    rankBoost: 1.0,
    substitutions: [],
  });

  // Try bigrams FIRST (higher-specificity). If "gum ball" is aliased
  // to "bubblegum", substituting the 2-token span into the raw query
  // is preferred over substituting individual tokens.
  for (const bigram of bigrams) {
    if (bigram.length > MAX_TOKEN_LENGTH_FOR_LOOKUP) continue;
    const entry = idx.byAlias.get(bigram.toLowerCase());
    if (!entry) continue;

    // When the input span isn't already the canonical, add a variant
    // substituting to the canonical form.
    if (entry.canonical.toLowerCase() !== bigram.toLowerCase()) {
      addVariant(variants, substituteSpan(query, bigram, entry.canonical), {
        from: bigram,
        to: entry.canonical,
        category: entry.category,
      });
    }

    // Always fan out to sibling aliases (including when the input IS the
    // canonical — this covers the "user types Gum Ball, CH indexed as
    // bubblegum in some rows" reverse case).
    const canonKey = `${entry.category}:${entry.canonical.trim().toLowerCase()}`;
    const canonEntry = idx.byCanonical.get(canonKey);
    if (canonEntry) {
      for (const sibling of canonEntry.aliases) {
        if (sibling.toLowerCase() === bigram.toLowerCase()) continue;
        addVariant(variants, substituteSpan(query, bigram, sibling), {
          from: bigram,
          to: sibling,
          category: entry.category,
        });
      }
    }
  }

  // Single-token substitutions second — lower priority but still valuable.
  for (const token of tokens) {
    if (token.length > MAX_TOKEN_LENGTH_FOR_LOOKUP) continue;
    if (token.length < 2) continue;
    const entry = idx.byAlias.get(token.toLowerCase());
    if (!entry) continue;

    if (entry.canonical.toLowerCase() !== token.toLowerCase()) {
      addVariant(variants, substituteSpan(query, token, entry.canonical), {
        from: token,
        to: entry.canonical,
        category: entry.category,
      });
    }

    const canonKey = `${entry.category}:${entry.canonical.trim().toLowerCase()}`;
    const canonEntry = idx.byCanonical.get(canonKey);
    if (canonEntry) {
      for (const sibling of canonEntry.aliases) {
        if (sibling.toLowerCase() === token.toLowerCase()) continue;
        addVariant(variants, substituteSpan(query, token, sibling), {
          from: token,
          to: sibling,
          category: entry.category,
        });
      }
    }
  }

  // Sort: original first (rank 1.0), then alias variants by rank desc.
  // Break ties by fewer substitutions (closer to the original).
  const list = Array.from(variants.values());
  list.sort((a, b) => {
    if (b.rankBoost !== a.rankBoost) return b.rankBoost - a.rankBoost;
    return a.substitutions.length - b.substitutions.length;
  });
  return list.slice(0, maxVariants);
}

function addVariant(
  variants: Map<string, ExpandedQueryVariant>,
  substituted: string,
  sub: { from: string; to: string; category: string },
): void {
  const key = substituted.toLowerCase();
  if (variants.has(key)) {
    // Merge the substitution list on already-seen variants so
    // observability captures multi-path derivations.
    const existing = variants.get(key)!;
    if (!existing.substitutions.some((s) => s.from === sub.from && s.to === sub.to)) {
      existing.substitutions.push(sub);
    }
    return;
  }
  variants.set(key, {
    query: substituted,
    rankBoost: 0.5,   // alias substitution — half the weight of the original
    substitutions: [sub],
  });
}

/**
 * Whole-word case-insensitive substitution of `from` → `to` in `text`.
 * Uses a word-boundary regex so "green" inside "greenfield" doesn't
 * accidentally get rewritten.
 */
function substituteSpan(text: string, from: string, to: string): string {
  // Escape the from-string for regex use.
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\b` doesn't work well when the token contains a space (bigram).
  // In that case, allow flexible whitespace between the words.
  const pattern = from.includes(" ")
    ? escaped.replace(/\s+/g, "\\s+")
    : `\\b${escaped}\\b`;
  const re = new RegExp(pattern, "i");
  return text.replace(re, to);
}
