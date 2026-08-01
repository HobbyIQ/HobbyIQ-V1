// CF-CONFIDENCE-SCORE (Drew, 2026-08-01). Assigns a confidence score
// 0-1 to any sold_comps row. Combines signals that historically
// correlate with confirmed-clean rows.
//
// Phase 1 (now): rule-based scoring. Signal weights are hand-tuned
// but the interface is model-ready.
//
// Phase 2 (later): learned weights via training on learning_events.
// The scoring function stays same-signature; ONLY the weights change,
// derived from observed correlations between features and clear/
// quarantine decisions.
//
// Score interpretation:
//   >= 0.85  auto-trust (write to sold_comps, no flag)
//   0.60-0.85  ingest with flag → labeler queue for later review
//   0.40-0.60  quarantine on write (borderline, needs human)
//   <  0.40  reject on write (near-certain contamination)

import type { RecordSoldCompInput } from "./soldCompsStore.service.js";
import { parseListingIdentity } from "./parseTitleIdentity.service.js";

export interface ConfidenceInput {
  row: RecordSoldCompInput;
  poolMedian?: number | null;
  poolSampleCount?: number;
  catalogHasCanonicalForCardnumberYear?: boolean;
  catalogAgreesOnSet?: boolean;
  sellerBadActorScore?: number;  // 0-1 where 1 = confirmed bad actor
}

export interface ConfidenceOutput {
  score: number;   // 0-1
  band: "auto-trust" | "flag-review" | "quarantine" | "reject";
  signals: Array<{ name: string; weight: number; contribution: number }>;
  explain: string;
}

// Hand-tuned weights for v1. Sum should be roughly 1.0.
const WEIGHTS = {
  hasValidSlug: 0.10,
  hasCardNumber: 0.08,
  hasPlayerName: 0.08,
  titleAgreesWithFields: 0.15,
  sourceTrust: 0.15,
  priceInBand: 0.20,
  catalogCanonical: 0.14,
  notBadActor: 0.10,
};

const SOURCE_TRUST: Record<string, number> = {
  "ebay-user-purchase": 1.0,
  "manual-user-entry": 0.9,
  "ebay-user-sale": 0.9,
  "cardhedge": 0.85,
  "ebay-browse-ended": 0.7,
  "cardsight": 0.5,
};

export function scoreRow(input: ConfidenceInput): ConfidenceOutput {
  const { row } = input;
  const signals: ConfidenceOutput["signals"] = [];
  let total = 0;

  // 1. Valid slug present
  const hasSlug = typeof (row as { hobbyiqCardId?: string }).hobbyiqCardId === "string";
  const hasSlugScore = hasSlug ? 1 : 0;
  signals.push({ name: "hasValidSlug", weight: WEIGHTS.hasValidSlug, contribution: hasSlugScore * WEIGHTS.hasValidSlug });
  total += hasSlugScore * WEIGHTS.hasValidSlug;

  // 2. cardNumber present
  const hasCn = !!row.cardNumber && String(row.cardNumber).trim().length > 0;
  const hasCnScore = hasCn ? 1 : 0;
  signals.push({ name: "hasCardNumber", weight: WEIGHTS.hasCardNumber, contribution: hasCnScore * WEIGHTS.hasCardNumber });
  total += hasCnScore * WEIGHTS.hasCardNumber;

  // 3. playerName present
  const hasName = !!row.playerName && String(row.playerName).trim().length > 0;
  const hasNameScore = hasName ? 1 : 0;
  signals.push({ name: "hasPlayerName", weight: WEIGHTS.hasPlayerName, contribution: hasNameScore * WEIGHTS.hasPlayerName });
  total += hasNameScore * WEIGHTS.hasPlayerName;

  // 4. Title agrees with structured fields (identity match)
  let titleAgrees = 0.5; // default neutral when no title
  if (row.title) {
    const parsed = parseListingIdentity(String(row.title));
    let agree = 0;
    let checks = 0;
    if (row.cardNumber && parsed.cardNumber) {
      checks++;
      if (row.cardNumber.toUpperCase() === parsed.cardNumber.toUpperCase()) agree++;
    }
    if (row.parallel && parsed.parallel) {
      checks++;
      if (row.parallel.toLowerCase().includes(parsed.parallel.toLowerCase())
        || parsed.parallel.toLowerCase().includes(row.parallel.toLowerCase())) agree++;
    }
    // Title mentions player last name?
    if (row.playerName) {
      checks++;
      const lastName = row.playerName.toLowerCase().split(/\s+/).slice(-1)[0] ?? "";
      if (lastName.length >= 4 && String(row.title).toLowerCase().includes(lastName)) agree++;
    }
    titleAgrees = checks > 0 ? agree / checks : 0.5;
  }
  signals.push({ name: "titleAgreesWithFields", weight: WEIGHTS.titleAgreesWithFields, contribution: titleAgrees * WEIGHTS.titleAgreesWithFields });
  total += titleAgrees * WEIGHTS.titleAgreesWithFields;

  // 5. Source trust
  const sourceScore = SOURCE_TRUST[row.source] ?? 0.5;
  signals.push({ name: "sourceTrust", weight: WEIGHTS.sourceTrust, contribution: sourceScore * WEIGHTS.sourceTrust });
  total += sourceScore * WEIGHTS.sourceTrust;

  // 6. Price is in band with pool median
  let priceInBand = 0.5;
  if (input.poolMedian && input.poolMedian > 0 && (input.poolSampleCount ?? 0) >= 5) {
    const ratio = row.price / input.poolMedian;
    if (ratio >= 0.5 && ratio <= 2.0) priceInBand = 1.0;
    else if (ratio >= 0.3 && ratio <= 3.0) priceInBand = 0.7;
    else if (ratio >= 0.2 && ratio <= 5.0) priceInBand = 0.3;
    else priceInBand = 0.0;
  }
  signals.push({ name: "priceInBand", weight: WEIGHTS.priceInBand, contribution: priceInBand * WEIGHTS.priceInBand });
  total += priceInBand * WEIGHTS.priceInBand;

  // 7. Catalog has canonical mapping for (cardNumber, year)
  const catalogScore = input.catalogHasCanonicalForCardnumberYear
    ? (input.catalogAgreesOnSet ? 1.0 : 0.3)
    : 0.5;
  signals.push({ name: "catalogCanonical", weight: WEIGHTS.catalogCanonical, contribution: catalogScore * WEIGHTS.catalogCanonical });
  total += catalogScore * WEIGHTS.catalogCanonical;

  // 8. Seller is not a known bad actor
  const notBadActor = 1 - (input.sellerBadActorScore ?? 0);
  signals.push({ name: "notBadActor", weight: WEIGHTS.notBadActor, contribution: notBadActor * WEIGHTS.notBadActor });
  total += notBadActor * WEIGHTS.notBadActor;

  const score = Math.max(0, Math.min(1, total));
  const band: ConfidenceOutput["band"] =
    score >= 0.85 ? "auto-trust"
    : score >= 0.60 ? "flag-review"
    : score >= 0.40 ? "quarantine"
    : "reject";

  const explain = signals
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 4)
    .map((s) => `${s.name}=${s.contribution.toFixed(2)}`)
    .join(", ");

  return { score, band, signals, explain };
}
