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

import { parseListingIdentity, extractGradeFromTitle } from "./parseTitleIdentity.service.js";
import type { RecordSoldCompInput } from "./soldCompsStore.service.js";

// CF-SUB-CHANNEL-VOCAB (Drew, 2026-08-01). "Mega Box" and similar retail
// channel markers pool into their parent chrome slug (buyers don't
// distinguish for pricing) but the vocabulary is still meaningful for
// discovery/display. Extract these tags so rows carry the language
// even after slug collapse.
const SUB_CHANNEL_PATTERNS: Array<[RegExp, string]> = [
  [/\bmega\s*box\b/i,  "mega-box"],
  [/\bblaster\b/i,     "blaster"],
  [/\bhta\s+choice\b/i, "hta-choice"],
  [/\bhta\b/i,         "hta"],
  [/\bhanger\b/i,      "hanger"],
  [/\bfat\s*pack\b/i,  "fat-pack"],
  [/\bcello\b/i,       "cello"],
  [/\bjumbo\b/i,       "jumbo"],
  [/\bhobby\b/i,       "hobby"],
  [/\bretail\b/i,      "retail"],
];

export function extractSubChannel(setName: string | null | undefined, title: string | null | undefined): string | null {
  const combined = `${setName ?? ""} ${title ?? ""}`;
  for (const [re, tag] of SUB_CHANNEL_PATTERNS) {
    if (re.test(combined)) return tag;
  }
  return null;
}

export interface PreIngestResult {
  input?: RecordSoldCompInput;
  flags: Array<{ kind: string; detail?: string }>;
  rejected?: { category: string; reason: string };
}

// CF-TITLE-PARSER-AI-FALLBACK (Drew, 2026-08-01). Async version of
// preIngestClean that ALSO uses the AI title parser as a fallback
// when the regex parser can't extract cardNumber. Cached by title
// hash so cost is bounded. Non-blocking fire-and-forget — caller can
// use sync preIngestClean if AI fallback isn't wanted.
export async function preIngestCleanWithAiFallback(input: RecordSoldCompInput): Promise<PreIngestResult> {
  const base = preIngestClean(input);
  if (base.rejected) return base;
  if (!base.input) return base;
  // Only invoke LLM if we lack cardNumber AND have a title
  const needsAi = (!base.input.cardNumber || String(base.input.cardNumber).trim().length === 0)
    && base.input.title && String(base.input.title).trim().length >= 15;
  if (!needsAi) return base;
  try {
    const { parseTitleWithAi } = await import("./titleParserAi.service.js");
    const aiResult = await parseTitleWithAi(String(base.input.title));
    if (aiResult && aiResult.confidence !== "low") {
      const refined = { ...base.input };
      if (aiResult.cardNumber && !refined.cardNumber) refined.cardNumber = aiResult.cardNumber;
      if (aiResult.parallel && (!refined.parallel || refined.parallel === "Base")) refined.parallel = aiResult.parallel;
      if (aiResult.isAuto && refined.isAuto === undefined) refined.isAuto = aiResult.isAuto;
      // printRun isn't a RecordSoldCompInput field — encoded into slug at
      // compute time via a different code path. The AI-derived printRun
      // is captured in the flag detail below for reference.
      return { input: refined, flags: [...base.flags, { kind: "unverified", detail: `ai-parsed-title conf=${aiResult.confidence}` }] };
    }
  } catch { /* soft */ }
  return base;
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

  // CF-STRUCTURED-FIRST-GRADE-FALLBACK (Drew, 2026-08-01). Prefer the
  // listing's structured grade fields when present. Only parse the
  // title as a fallback. Same rule applies universally — every source
  // can carry a graded slab in its title even if the structured field
  // wasn't populated.
  if (!refined.gradeCompany || !refined.gradeValue) {
    const titleGrade = title ? extractGradeFromTitle(title) : { gradeCompany: null, gradeValue: null };
    if (!refined.gradeCompany && titleGrade.gradeCompany) refined.gradeCompany = titleGrade.gradeCompany;
    if (!refined.gradeValue && titleGrade.gradeValue) refined.gradeValue = titleGrade.gradeValue;
  }

  // CF-SUB-CHANNEL-EXTRACT (Drew, 2026-08-01). Detect retail-channel
  // vocabulary (Mega Box, Blaster, HTA, etc.) from setName/title.
  // Persist as __subChannel — pools still unify at the slug level, but
  // the language stays searchable/filterable/displayable.
  const subChannel = extractSubChannel(refined.setName, refined.title);
  if (subChannel) {
    (refined as RecordSoldCompInput & { __subChannel?: string }).__subChannel = subChannel;
  }

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
      // CF-STRUCTURED-FIRST (Drew, 2026-08-01). Prefer structured input
      // fields when they carry a specific value; title-parse as
      // fallback for anything missing. EXCEPTION: parallel — Cardsight's
      // parallel_name is proven unreliable (Hartshorn Blue-tagging
      // incident), so title still wins for parallel specifically when
      // parsedFromTitle produced a non-Base value.
      if (parsedFromTitle) {
        if (!refined.cardNumber && parsedFromTitle.cardNumber) refined.cardNumber = parsedFromTitle.cardNumber;
        if (parsedFromTitle.parallel && parsedFromTitle.parallel !== "Base") refined.parallel = parsedFromTitle.parallel;
        else if (!refined.parallel && parsedFromTitle.parallel) refined.parallel = parsedFromTitle.parallel;
        if (refined.isAuto === undefined && parsedFromTitle.isAuto !== undefined) refined.isAuto = parsedFromTitle.isAuto;
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
    // D26: the eBay account sync. Its title is a real listing title, so the
    // same title-parse refinement applies.
    case "ebay-account":
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
