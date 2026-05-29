// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — Cardsight catalog ranking helper.
//
// Per design doc 23038d7 §2. Adapted from the legacy CardHedge-shape
// ranking at compiq.routes.ts:758-836 into a Cardsight-shape-specific
// helper that the new /api/search/cards endpoint uses to score
// free-text catalog hits before mapping them through
// `cardsightCatalogToCardIdentity`.
//
// Why Cardsight-shape-specific (not shape-agnostic): the W3
// implementation choice deliberately keeps the helper bound to
// Cardsight's `CardsightCatalogResult` shape. W4 picker migration
// (CF-PICKER-MIGRATE-TO-CARDSIGHT, absorbed into v1 per D1) migrates
// the legacy /api/compiq/search-list off CardHedge onto Cardsight,
// at which point the legacy route can call THIS helper. Until W4,
// search-list keeps its inline CardHedge-keyed logic at
// compiq.routes.ts:758-836 untouched.
//
// The ranking math (autograph score + color score + rookie boost +
// stable sort by score then original order) is preserved exactly
// from the legacy implementation; only the blob construction
// changes from CardHedge field names (set/number/title/name/variant)
// to Cardsight field names (name/number/releaseName/setName/player).

import type { CardsightCatalogResult } from "../compiq/cardsight.client.js";
import { detectAutoFromBlob } from "./cardsightCatalogAdapter.js";

// Vendor-agnostic regexes (same patterns as the adapter).
const AUTO_TEXT_RE =
  /\b(auto|autograph|autographs|signature|signed)\b/i;

// Color tokens recognized when the user types a color hint. Compound
// tokens ("sky blue") come BEFORE primary tokens ("blue") so the
// regex greedy-matches the longer form first.
const COLOR_RE =
  /\b(sky\s+blue|royal\s+blue|navy|aqua|red|blue|green|gold|orange|purple|pink|yellow|black|white|silver|atomic|prizm|mojo|shimmer|wave|rainbow|refractor)\b/gi;

const ROOKIE_RE = /\b(1st|rookie|rc)\b/i;

/**
 * Per-hit scored entry used internally for ordering. Not exported —
 * the dispatcher receives ranked `CardsightCatalogResult[]` (already
 * sorted; score lives on the CardIdentity via `confidence`).
 */
interface ScoredHit {
  hit: CardsightCatalogResult;
  score: number;
  originalIndex: number;
}

/**
 * Rank Cardsight catalog hits by relevance to the user's query.
 *
 * Scoring components (matches the legacy CardHedge ranking exactly):
 *   - colorScore: +3 per color match in setName/releaseName/name
 *                 (variant proxy on Cardsight), +1 weaker fallback,
 *                 -1 penalty if user wanted plain "blue" alone and
 *                 the hit is "sky blue" (over-specific match)
 *   - autoScore:  +5 if user wanted auto AND hit is auto;
 *                 -2 if user wanted auto AND hit is not auto
 *   - rookieBoost: +0.5 if "1st"/"rookie"/"rc" appears in any text
 *
 * If the user explicitly asked for an autograph, non-auto hits are
 * filtered out entirely (matches legacy behavior at compiq.routes.ts:833).
 *
 * Returns hits sorted by (score desc, originalIndex asc) — stable
 * sort preserves Cardsight's API-returned order on ties.
 *
 * The returned array carries a `score` property per hit via the
 * `[CardsightCatalogResult, number]` tuple shape, which the
 * dispatcher consumes via `cardsightCatalogToCardIdentity(hit, score)`.
 */
export function rankCatalogHits(
  hits: CardsightCatalogResult[],
  query: string,
): Array<{ hit: CardsightCatalogResult; score: number }> {
  if (hits.length === 0) return [];

  const q = query.toLowerCase();
  const wantsAuto = AUTO_TEXT_RE.test(q);

  const wantedColors = Array.from(q.matchAll(COLOR_RE)).map((m) =>
    m[0].toLowerCase().replace(/\s+/g, " "),
  );

  const scored: ScoredHit[] = hits.map((hit, originalIndex) => {
    const auto = detectAutoFromBlob(hit);

    // Cardsight has no direct "variant" field — setName + releaseName
    // carry the parallel/insert tokens. Mirror the legacy variant-vs-set
    // priority by treating setName as the higher-signal field (analog
    // of CardHedge `variant`) and releaseName as the lower-signal field
    // (analog of CardHedge `set`).
    const variantText = (hit.setName ?? "").toLowerCase();
    const setText = (hit.releaseName ?? "").toLowerCase();
    const numberText = (hit.number ?? "").toLowerCase();
    const nameText = (hit.name ?? "").toLowerCase();

    let colorScore = 0;
    if (wantedColors.length > 0) {
      for (const col of wantedColors) {
        if (variantText.includes(col)) colorScore += 3;
        else if (setText.includes(col)) colorScore += 1;
      }
      // Penalty: user said "blue" alone, hit is "sky blue" — over-specific
      // match shouldn't outrank a plain-blue parallel.
      if (
        wantedColors.includes("blue") &&
        !wantedColors.some((c) => c !== "blue") &&
        variantText.includes("sky blue")
      ) {
        colorScore -= 1;
      }
    }

    const autoScore = wantsAuto ? (auto ? 5 : -2) : 0;

    const rookieBoost = ROOKIE_RE.test(
      `${setText} ${variantText} ${numberText} ${nameText}`,
    )
      ? 0.5
      : 0;

    return {
      hit,
      score: colorScore + autoScore + rookieBoost,
      originalIndex,
    };
  });

  // Stable sort: highest score first; preserve original API order on ties.
  scored.sort(
    (a, b) => b.score - a.score || a.originalIndex - b.originalIndex,
  );

  // Hide non-auto hits when user explicitly asked for an autograph.
  // Matches legacy filter at compiq.routes.ts:833.
  const filtered = wantsAuto
    ? scored.filter((s) => detectAutoFromBlob(s.hit))
    : scored;

  return filtered.map(({ hit, score }) => ({ hit, score }));
}
