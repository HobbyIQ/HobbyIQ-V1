// CF-PRE-INGEST-CLEAN (Drew, 2026-08-01). Unified pre-write cleaner
// called from inside recordSoldComp. Inspects input.source and applies
// vendor-specific validation. Any caller of recordSoldComp automatically
// gets the cleaning pass — no code changes at 46 call sites.
//
// Two-pass ingest cleaning:
//   Pass 1 (here): vendor-specific validation + title-parse refinement
//   Pass 2 (recordSoldComp): content-hash dedup, price sanity, bad-actor
//                            check, cardsight-unverified tag
//
// Returns { input, flags } on pass, or { rejected } on fail.

import { parseListingIdentity } from "./parseTitleIdentity.service.js";
import type { RecordSoldCompInput } from "./soldCompsStore.service.js";

export interface PreIngestResult {
  input?: RecordSoldCompInput;
  flags: Array<{ kind: string; detail?: string }>;
  rejected?: { category: string; reason: string };
}

export function preIngestClean(input: RecordSoldCompInput): PreIngestResult {
  const flags: PreIngestResult["flags"] = [];

  // Universal invalids
  if (typeof input.price !== "number" || input.price <= 0) {
    return { flags: [], rejected: { category: "invalid", reason: "no valid price" } };
  }
  if (!input.soldAt) {
    return { flags: [], rejected: { category: "invalid", reason: "no soldAt date" } };
  }
  if (!input.cardId || !String(input.cardId).trim()) {
    return { flags: [], rejected: { category: "invalid", reason: "no cardId" } };
  }
  if (!input.playerName || !String(input.playerName).trim()) {
    return { flags: [], rejected: { category: "invalid", reason: "no playerName" } };
  }

  // Refined per-source
  const refined = { ...input };
  const title = String(refined.title ?? "");
  const parsedFromTitle = title ? parseListingIdentity(title) : null;

  // Vendor-specific rules
  switch (refined.source) {
    case "cardsight": {
      // Cardsight fuzzy-match rejection: title must mention player OR cardNumber
      if (title) {
        const lastName = String(refined.playerName).toLowerCase().split(/\s+/).slice(-1)[0] ?? "";
        const hasLastName = lastName.length >= 4;
        const numberLower = String(refined.cardNumber ?? "").toLowerCase();
        const titleLower = title.toLowerCase();
        const mentionsPlayer = hasLastName && titleLower.includes(lastName);
        const mentionsNumber = numberLower && titleLower.includes(numberLower);
        if (!mentionsPlayer && !mentionsNumber) {
          return {
            flags: [],
            rejected: {
              category: "fuzzy-match",
              reason: `cardsight fuzzy-match: title mentions neither "${lastName}" nor "${numberLower}"`,
            },
          };
        }
      }
      // Prefer title-parsed identity when available (Cardsight's parallel field unreliable)
      if (parsedFromTitle) {
        if (parsedFromTitle.cardNumber) refined.cardNumber = parsedFromTitle.cardNumber;
        if (parsedFromTitle.parallel) refined.parallel = parsedFromTitle.parallel;
        if (parsedFromTitle.isAuto !== undefined) refined.isAuto = parsedFromTitle.isAuto;
      }
      flags.push({ kind: "unverified", detail: "cardsight-source" });
      break;
    }

    case "cardhedge": {
      // Title-parse refinement (CH is trusted but titles can carry more detail than CH's structured fields)
      if (parsedFromTitle) {
        if (parsedFromTitle.cardNumber && !refined.cardNumber) refined.cardNumber = parsedFromTitle.cardNumber;
        if (parsedFromTitle.parallel && (!refined.parallel || refined.parallel === "Base")) refined.parallel = parsedFromTitle.parallel;
        if (parsedFromTitle.isAuto !== undefined && refined.isAuto === undefined) refined.isAuto = parsedFromTitle.isAuto;
      }
      break;
    }

    case "manual-user-entry": {
      // Strict: parallel required (silent Base default caused the 2026-08-01 Hartman incident)
      if (!refined.parallel || !String(refined.parallel).trim()) {
        return {
          flags: [],
          rejected: {
            category: "invalid",
            reason: "parallel required for manual entry (pass 'Base' explicitly for unnumbered matte)",
          },
        };
      }
      // Future-date reject (>1 day skew)
      const ms = Date.parse(String(refined.soldAt));
      if (!Number.isFinite(ms) || ms > Date.now() + 86_400_000) {
        return { flags: [], rejected: { category: "invalid", reason: "soldAt is invalid or in the future" } };
      }
      break;
    }

    case "ebay-user-purchase":
    case "ebay-user-sale":
    case "ebay-browse-ended": {
      // High trust — title-parse refines if fields aren't already set
      if (parsedFromTitle) {
        if (parsedFromTitle.cardNumber && !refined.cardNumber) refined.cardNumber = parsedFromTitle.cardNumber;
        if (parsedFromTitle.parallel && (!refined.parallel || refined.parallel === "Base")) refined.parallel = parsedFromTitle.parallel;
        if (parsedFromTitle.isAuto !== undefined && refined.isAuto === undefined) refined.isAuto = parsedFromTitle.isAuto;
      }
      break;
    }

    default:
      // Unknown source — allow through but flag it
      flags.push({ kind: "unknownSource", detail: refined.source });
      break;
  }

  return { input: refined, flags };
}
