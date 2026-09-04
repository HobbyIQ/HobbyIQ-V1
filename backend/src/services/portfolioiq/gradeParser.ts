// CF-AUTOPRICE-GRADE-CONTRACT — parse legacy grade-label strings into
// canonical (gradeCompany, gradeValue) tuples for one-time Cosmos backfill.
//
// Used by scripts/backfill-grade-fields.ts. NOT a backend runtime shim:
// autoPriceHolding reads canonical fields directly; this parser exists
// only to convert pre-canonical-contract stored data so existing
// graded holdings get correct PSA/BGS/SGC comp pools after iOS contract
// rolls out.
//
// Conservative parsing: when the label is unambiguous, return the
// canonical tuple. When ambiguous (unknown company token, no numeric
// value, etc.) return null so the script can surface unparseable cases
// for manual review rather than guess.

export interface ParsedGrade {
  gradeCompany: string;
  gradeValue: number;
  /**
   * CF-BGS-BLACK-LABEL-INGEST (PR #495 follow-up): true when the input
   * label carried "Black Label" / "Pristine" / a standalone "BL" token
   * adjacent to a BGS 10. Absent for every other grade. Consumers
   * (autoPriceHolding, catalog inference, backfill scripts) use this to
   * pass "10 Black Label" as the grade string to getGraderPremium so
   * the 9x fallback tier fires instead of the regular BGS 10 3.5x tier.
   */
  isBlackLabel?: boolean;
  /**
   * CF-GRADE-QUALIFIER (Drew, 2026-07-23, issue #713). PSA qualifier
   * flag when the slab carries one — "OC" (off-center), "MK" (marks),
   * "ST" (stain), "PD" (print defect), "MC" (miscut), "OF" (out of
   * focus). A qualified grade is a card that would have graded higher
   * except for one specific issue; it still trades close to the base
   * tier but at a discount (typically 15-25% below unqualified).
   *
   * Only populated when a qualifier is detected. The base gradeValue
   * is the underlying tier — a "PSA 9 (OC)" produces
   * { gradeCompany: "PSA", gradeValue: 9, qualifier: "OC" }.
   *
   * Downstream: FMV projection layer should treat qualified rows as
   * being in the same comp pool as unqualified same-tier rows but
   * apply a per-qualifier discount when computing. That wiring is a
   * follow-up — this file just extracts the tag.
   */
  qualifier?: string;
  /**
   * CF-AUTHENTIC-BUCKET (Drew, 2026-08-15: "we need a new bucket for Auth for
   * all grading companies so vintage cards fall in there too").
   *
   * True when the slab is AUTHENTICATED but carries NO numeric grade —
   * "CGC AUTH", "PSA Authentic", "SGC AUTH", "BGS AUTHENTIC". Common on
   * vintage, and on any card trimmed, recoloured or otherwise altered, so it
   * trades well BELOW the same card raw.
   *
   * Measured on 2018 Bowman Chrome Ohtani #1: two "CGC AUTH" sales at $1,680
   * and $1,770 were counted as RAW comps against genuine raw sales at
   * $3,000-3,049, dragging the raw median to $2,900 and setting the low.
   * Across the pool: 4,313 rows say "CGC AUTH", 1,993 "PSA AUTH", 1,235
   * "SGC AUTH", 378 "BGS AUTH" — roughly 7,900 sales in the wrong bucket.
   *
   * gradeValue is 0 on purpose. Real grades run 0.5-10, so 0 cannot collide
   * with one; `gradeValue !== null` (this codebase's "is graded" test)
   * correctly stops these being raw; and any consumer guarding on a positive
   * grade skips them rather than treating them as a top grade.
   */
  isAuthentic?: boolean;
}

/** PSA grade qualifier flag codes. All slab-printed as parenthesized
 *  or space-separated single-token suffixes on the base grade.
 *  Reference: https://www.psacard.com/resources/gradingstandards */
const PSA_QUALIFIERS = new Set<string>(["OC", "MK", "ST", "PD", "MC", "OF"]);

// Match a qualifier suffix in ANY of these forms (only when it appears
// AFTER the grade numeric):
//   "PSA 9 (OC)"    parenthesized, space before
//   "PSA 9(OC)"     parenthesized, no space
//   "PSA 9 OC"      bare, space-separated
//   "PSA9 OC"       compressed company
// Enforces uppercase 2-letter tokens matching the PSA_QUALIFIERS set —
// otherwise a random 2-letter suffix (e.g. "PSA 9 MT" meaning MINT)
// would false-positive.
const QUALIFIER_TAIL_RE = /(?:\s*\(([A-Za-z]{2})\)|\s+([A-Za-z]{2}))(?:\s|$)/;

function detectQualifier(label: string): string | null {
  const m = label.match(QUALIFIER_TAIL_RE);
  if (!m) return null;
  const tag = (m[1] ?? m[2] ?? "").toUpperCase();
  return PSA_QUALIFIERS.has(tag) ? tag : null;
}

// Adjacent "Black Label" / "Pristine" / "BL" indicators on a BGS 10.
// Match any of these anywhere in the input string; scoped to BGS 10 by
// the caller (this file is a plain regex — the scoping check lives in
// parseGradeLabel's return path).
const BGS_BLACK_LABEL_PATTERNS = [
  /\bblack\s+label\b/i,
  /\bpristine\b/i,
  /\bbl\b/i,
];

// PSA's flagship label vernacular for a 10 — has multiple textual forms.
// Recognized as PSA 10 even when only the descriptor appears.
const PSA_10_PATTERNS = [
  /\bgem[\s-]*mt\b/i,
  /\bgem[\s-]*mint\b/i,
  /\bpristine\b/i,
];

// CF-PRISTINE-IS-A-PRODUCT-NOT-A-GRADE (2026-09-01).
//
// "Pristine" is the ONLY word in the PSA_10_PATTERNS descriptor vocabulary that
// is also the name of a Topps product line. A 16-word sweep over the other set
// words (Perfect / Gem / Mint / Chrome / Select / Optic / Prizm / Immaculate /
// Flawless / Gold Label / Sterling / Diamond / ...) found no other collision, so
// this guard is deliberately scoped to the one word rather than generalized.
//
// MEASURED MECHANISM (probe, origin/main 7e0087b):
//   "2024 Topps Pristine Baseball #131 Base"  -> PSA 10   (phantom)
//   "2024 Topps Pristine Baseball #5 Base"    -> null
// The card number is NOT what feeds the grade. 131 fails the 0<v<=10 range
// check, so detectedValue stays null and the descriptor-ONLY fallback fires on
// the bare word. "#5" is a *valid* grade value, so it populates detectedValue,
// which suppresses that fallback — i.e. the old code returned raw only by the
// accident of the card number happening to look like a grade. Both branches
// were wrong; this guard removes the dependence on that accident entirely.
//
// THE DISCRIMINATOR IS PRODUCT CONTEXT, NOT THE WORD. Topps Pristine is a real
// graded-card-heavy product line, so its titles legitimately carry real slab
// grades ("2024 Topps Pristine ... PSA 10") and those MUST survive. What must
// not survive is the set word ALONE standing in for a grade. So the guard fires
// only when the title reads as a product listing:
//   - a 4-digit year or a known brand token sits next to the word, AND
//   - no grading company is named anywhere in the title, AND
//   - no standalone grade phrase ("Pristine 10", "10 Pristine") is present.
//
// The third clause is what keeps grader vocabulary working. BGS and CGC both
// use "Pristine" as the LABEL for a ten — "CGC Pristine 10", "BGS 10 Pristine"
// — but those name a company, so clause two already lets them through. The
// numeric clause additionally protects a bare "Pristine 10" with no company.
//
// A bare "PRISTINE" label (the iOS card-scan input the descriptor fallback was
// built for) has neither year nor brand beside it, so it is untouched and still
// reads PSA 10 — the #1608-era pin in gradeParser.test.ts stays green.
const PRODUCT_BRAND_TOKENS =
  /\b(?:topps|panini|bowman|upper\s*deck|leaf|donruss|fleer|score|select|prizm|optic|immaculate|chronicles|absolute|obsidian|mosaic|hoops|contenders)\b/i;

/** True when "Pristine" in this title is the Topps product line rather than a
 *  grade word: product context present, no grader named, no numeric grade
 *  phrase attached to the word. */
function pristineIsProductContext(text: string): boolean {
  if (!/\bpristine\b/i.test(text)) return false;
  // A named grading company means the title is talking about a slab.
  if (detectedCompanyOf(text)) return false;
  // "Pristine 10" / "10 Pristine" states a grade even with no company token.
  if (/\bpristine\b[\s-]*(?:10|[1-9](?:\.5)?)\b/i.test(text)) return false;
  if (/\b(?:10|[1-9](?:\.5)?)[\s-]*\bpristine\b/i.test(text)) return false;
  // Product context: a release year or a brand token in the same title.
  const hasYear = /\b(?:19|20)\d{2}\b/.test(text);
  const hasBrand = PRODUCT_BRAND_TOKENS.test(text);
  return hasYear || hasBrand;
}

// PSA's full grade-label vernacular. The slab printing uses descriptor
// words alongside the numeric grade ("MINT 9", "NM-MT 8", "EX-MT 6").
// iOS card-scan path historically captured these labels verbatim. When
// the parser sees a descriptor word paired with a numeric in the [1, 10]
// range, infer the company as PSA and use the numeric as the value.
//
// This is a CONSERVATIVE heuristic for backfill of legacy data — labels
// that match this pattern are virtually always from PSA slabs. BGS uses
// "MINT" too but pairs with a decimal grade ("BGS 9.5") that explicit
// company tokenization handles. SGC uses numeric-only labels ("SGC 9").
//
// Operators reviewing the backfill output can override individual
// inferences if they know a holding is actually BGS/SGC/CGC.
const PSA_DESCRIPTOR_PATTERNS = [
  /\bgem[\s-]*mt\b/i,
  /\bgem[\s-]*mint\b/i,
  /\bmint\b/i,         // PSA grades 9-10
  /\bnm[\s-]*mt\b/i,   // Near Mint-Mint, PSA 8
  /\bnm\b/i,           // Near Mint, PSA 7
  /\bex[\s-]*mt\b/i,   // Excellent-Mint, PSA 6
  /\bex\b/i,           // Excellent, PSA 5
  /\bvg[\s-]*ex\b/i,   // VG-Excellent, PSA 4
  /\bvg\b/i,           // Very Good, PSA 3
  /\bgood\b/i,         // PSA 2
  /\bpoor\b/i,         // PSA 1
];

// Company token recognition. Order matters: longer tokens checked first
// to avoid "BGS" matching when the label is actually "CGC BGS-format
// double-stamped" (rare but possible).
// Match company token followed by either a word boundary (PSA 10) or
// a digit (PSA10). `\b` alone wouldn't match between PSA and 10 because
// both letters and digits are \w characters.
const COMPANY_TOKENS: Array<{ token: RegExp; canonical: string }> = [
  { token: /\bpsa(?=\b|\d)/i, canonical: "PSA" },
  { token: /\bbgs(?=\b|\d)/i, canonical: "BGS" },
  { token: /\bsgc(?=\b|\d)/i, canonical: "SGC" },
  { token: /\bcgc(?=\b|\d)/i, canonical: "CGC" },
  { token: /\bcsg(?=\b|\d)/i, canonical: "CSG" },
  { token: /\bhga(?=\b|\d)/i, canonical: "HGA" },
];

/**
 * Parse a grade-label string into canonical (gradeCompany, gradeValue).
 * Returns null for raw/ungraded cards (empty string, "Raw", "Ungraded")
 * and for labels that can't be confidently parsed.
 *
 * Recognized formats:
 *   - "PSA 10", "PSA10", "psa 10"   → { gradeCompany: "PSA", gradeValue: 10 }
 *   - "BGS 9.5", "BGS9.5"           → { gradeCompany: "BGS", gradeValue: 9.5 }
 *   - "GEM MT 10", "Gem Mt 10"      → { gradeCompany: "PSA", gradeValue: 10 }
 *                                       (PSA's official label vernacular)
 *   - "SGC 9", "CGC 9"              → expected company tokens
 *   - ""  / "Raw" / "Ungraded"      → null (not graded)
 *   - "10" / "9.5" / number-only    → null (no company; surfaced for review)
 *   - "GEM" alone                   → null (no value; surfaced for review)
 */
/** Company token for a label, or null. Shared by the Authentic branch and the
 *  main numeric path so both agree on the grader. */
function detectedCompanyOf(text: string): string | null {
  for (const { token, canonical } of COMPANY_TOKENS) {
    if (token.test(text)) return canonical;
  }
  return null;
}

/**
 * The grade value anchored to ONE grading company in `text`, or null.
 *
 * Matches "PSA 10", "PSA10", "PSA-10", "PSA10.0" — the company token followed
 * by optional whitespace/hyphen and the grade number.
 *
 * CF-GRADE-MODIFIER-BETWEEN (Drew, 2026-07-29). Vendor titles often interpose
 * a grade-modifier word between the company token and the digit: "PSA MINT 9",
 * "PSA GEM MT 10", "BGS PRISTINE 10". An optional whitelisted modifier is
 * allowed so the anchored path catches these. OBSERVED: "MICHAEL JORDAN 1986
 * FLEER STICKER #8 ROOKIE PSA MINT 9" — anchored match failed, and the
 * any-number fallback picked "8" out of "#8" as the grade instead of PSA 9.
 *
 * Shared by company selection and value extraction so both ask the same
 * question of the same text: "does this grader carry a real grade here?"
 */
function anchoredGradeValue(text: string, company: string): number | null {
  const companyRe = new RegExp(
    `\\b${company}\\b[\\s-]*` +
    `(?:(?:GEM[\\s-]+)?(?:MT|MINT|PRISTINE|NM(?:-MT)?|EX(?:-MT)?)[\\s-]+)?` +
    `([0-9]+(?:\\.[0-9]+)?)`,
    "i",
  );
  const m = text.match(companyRe);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10 ? parsed : null;
}

export function parseGradeLabel(label: string | null | undefined): ParsedGrade | null {
  if (!label) return null;
  const trimmed = String(label).trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "raw" || lower === "ungraded" || lower === "none") return null;

  // ── Authenticated, no numeric grade ──────────────────────────────────
  // Runs BEFORE the numeric scan. "CGC AUTH" carries no digit, so the scan
  // returns null and the row falls through to RAW — the bug this fixes.
  //
  // "AUTO"/"AUTOGRAPH" is deliberately not a trigger: that is a signature on
  // the card, not an authentication-only slab. And a numeric grade sitting
  // beside the word means the slab IS graded and "AUTH" describes the
  // autograph ("CGC AUTH w/ 10 AUTO GRADE"), so the bucket is only claimed
  // when no grade number is present. Card numbers and years are stripped
  // first so "#1" and "2018" cannot be mistaken for a grade.
  if (/\bauth(?:entic|enticated)?\b/i.test(trimmed)) {
    const withoutNoise = trimmed
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/#\s*[\w-]+/g, " ");
    const hasNumericGrade = /\b(?:10|[1-9](?:\.5)?)\b/.test(withoutNoise);
    // A GRADING COMPANY IS REQUIRED. Without one, "Authentic" is far more
    // often a product or marketing word than an authentication:
    // "SP Authentic" is an Upper Deck product line, and a dry run over the
    // pool tagged 6,450 rows — mostly "2001 SP Authentic Baseball" — as
    // authenticated slabs on the strength of the word alone. That is a worse
    // error than the bug being fixed, so no company means no bucket.
    const company = detectedCompanyOf(trimmed);
    if (!hasNumericGrade && company) {
      return { gradeCompany: company, gradeValue: 0, isAuthentic: true };
    }
  }

  // ── Detect company token ─────────────────────────────────────────────
  //
  // CF-THE-GRADER-WITH-THE-NUMBER-WINS (Drew, 2026-08-31). A title may name
  // more than one grader, and only one of them is the slab this card is in:
  //
  //     "1968 TOPPS #230 PETE ROSE SGC 6 Bright and Sharp! Reds Not PSA or BVG"
  //     "Kylian Mbappe 2020-21 Topps Now C.L #041 SGC 10 not PSA"
  //     "Shohei Ohtani 2018 Topps #700 Rookie BGS 9.5 w/2x10 subs PSA Regrade?"
  //
  // The second grader is a comparison, a cross-over pitch or a regrade
  // question — never the holder. Picking by COMPANY_TOKENS order (PSA first,
  // always) attributed all three to PSA, and since PSA has no number beside it
  // the anchored match then failed and the whole parse returned null. Measured
  // over 1,048 tca-ebay demotion candidates: 69 (6.58%) are exactly this shape,
  // each one a correctly-stored grade the parser could not see.
  //
  // So candidates are ranked by EVIDENCE, not by list position: a grader with a
  // valid grade value anchored to it beats one without. Ties fall back to
  // COMPANY_TOKENS order, which preserves the previous behaviour whenever the
  // evidence does not distinguish them.
  const presentCompanies = COMPANY_TOKENS.filter(({ token }) => token.test(trimmed));
  const detectedCompany: string | null = presentCompanies.length
    ? (presentCompanies.find(({ canonical }) => anchoredGradeValue(trimmed, canonical) !== null)
        ?? presentCompanies[0]).canonical
    : null;

  // ── Detect numeric value ─────────────────────────────────────────────
  // Look for a decimal number (e.g. 9.5) or integer (10, 9, 8) that
  // sits in a valid grade range (0.5-10).
  //
  // CF-GRADE-PARSE-COMPANY-ADJACENT (Drew, 2026-07-28). When a company
  // token is present, prefer the number that comes RIGHT AFTER it —
  // titles like "2025 BOWMAN DRAFT PSA 7" have both "2025" (year, too
  // big to be a grade) and "7" (grade), but the old logic picked the
  // first stripped number which was 2025 → skipped → null. Now we
  // look for the digit anchored to the company token first, and only
  // fall back to any-number scan if that misses.
  let detectedValue: number | null = detectedCompany
    ? anchoredGradeValue(trimmed, detectedCompany)
    : null;

  // Fallback: any-number scan (used for descriptor-only labels where
  // there's no company token, or when the anchored match failed).
  if (detectedValue === null) {
    let strippedForNumber = trimmed;
    for (const { token } of COMPANY_TOKENS) {
      strippedForNumber = strippedForNumber.replace(token, " ");
    }
    strippedForNumber = strippedForNumber
      .replace(/\bgem[\s-]*(mt|mint)\b/gi, " ")
      .replace(/\bmt\b/gi, " ")
      .replace(/\bmint\b/gi, " ")
      .replace(/\bpristine\b/gi, " ");
    // Skip 4-digit years like 2020-2029 to avoid false matches on
    // titles like "2025 Bowman ... MINT 10" where the anchored-match
    // path missed.
    const noYears = strippedForNumber.replace(/\b(19|20)\d{2}\b/g, " ");
    const numberMatch = noYears.match(/(\d+(?:\.\d+)?)/);
    if (numberMatch) {
      const parsed = Number(numberMatch[1]);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
        detectedValue = parsed;
      }
    }
  }

  // ── PSA descriptor-only fallback (no numeric, descriptor signals 10) ─
  // Labels like "GEM MT" / "PRISTINE" without a numeric value are PSA's
  // top-grade conventions. Only infer PSA 10 when the descriptor IS
  // present AND no other company token competes AND no numeric is found.
  if (!detectedCompany && !detectedValue) {
    // CF-PRISTINE-IS-A-PRODUCT-NOT-A-GRADE: when the ONLY descriptor carrying
    // this title is a product-context "Pristine", there is no grade word here
    // at all — fall through to raw rather than minting a PSA 10. A title that
    // also says "Gem Mint" still resolves on that word.
    const otherPsa10Descriptor = PSA_10_PATTERNS
      .filter((re) => re.source !== /\bpristine\b/i.source)
      .some((re) => re.test(trimmed));
    const pristineIsGradeWord =
      /\bpristine\b/i.test(trimmed) && !pristineIsProductContext(trimmed);
    if (otherPsa10Descriptor || pristineIsGradeWord) {
      return { gradeCompany: "PSA", gradeValue: 10 };
    }
  }

  // ── PSA descriptor + numeric → infer PSA ─────────────────────────────
  // "GEM MT 10" / "MINT 9" / "NM-MT 8" / "EX-MT 6" etc. all follow PSA's
  // slab-label vernacular. When no explicit company token but a PSA
  // descriptor is present alongside a valid grade numeric, infer PSA.
  // Conservative backfill heuristic — BGS/SGC use either explicit company
  // tokens (handled above) or decimal grades that don't match these
  // integer-only descriptor patterns.
  if (!detectedCompany && detectedValue !== null) {
    const hasPsaDescriptor = PSA_DESCRIPTOR_PATTERNS.some((re) => re.test(trimmed));
    if (hasPsaDescriptor) {
      return { gradeCompany: "PSA", gradeValue: detectedValue };
    }
  }

  // ── Decide ───────────────────────────────────────────────────────────
  if (detectedCompany && detectedValue !== null) {
    // CF-BGS-BLACK-LABEL-INGEST: elevate a BGS 10 to Black Label ONLY
    // when the input carries one of the tier indicators AND the tuple
    // is exactly (BGS, 10). "PSA 10 Pristine" (which some Cardsight
    // labels use for gem-mint 10s) intentionally does NOT flip this
    // bit — it's a BGS-only tier.
    if (
      detectedCompany === "BGS"
      && detectedValue === 10
      && BGS_BLACK_LABEL_PATTERNS.some((re) => re.test(trimmed))
    ) {
      return {
        gradeCompany: detectedCompany,
        gradeValue: detectedValue,
        isBlackLabel: true,
      };
    }
    // CF-GRADE-QUALIFIER (issue #713): PSA qualifier flags only.
    // BGS/SGC/CGC use half-point deductions instead of qualifiers,
    // so we scope detection to PSA to avoid false-positives on
    // legitimate BGS/SGC/CGC label text.
    if (detectedCompany === "PSA") {
      const qualifier = detectQualifier(trimmed);
      if (qualifier) {
        return {
          gradeCompany: detectedCompany,
          gradeValue: detectedValue,
          qualifier,
        };
      }
    }
    return { gradeCompany: detectedCompany, gradeValue: detectedValue };
  }

  // Ambiguous: surface for manual review by returning null. The
  // backfill script logs unparseable labels so an operator can fix
  // them before re-running.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// CF-A-GRADE-IS-A-GRADER-TOKEN-PLUS-A-NUMERAL (Drew, 2026-09-04).
//
// parseGradeLabel above reads a SLAB LABEL — the string printed on the
// holder, or captured by the iOS card-scan: "GEM MT 10", "MINT 9",
// "NM-MT 8". On that input the PSA descriptor vernacular IS the grade,
// and the any-number fallback has exactly one number to find. Both are
// correct there and stay.
//
// A MARKETPLACE TITLE IS NOT A LABEL. It carries a card number, a year, a
// print run, a team name and a seller's condition prose, and on that input
// the same two heuristics compose into a card-number reader:
//
//   "Mickey Mantle #5 NM"            -> PSA 5    (NM is the descriptor,
//   "Ted Williams #8 EX"             -> PSA 8     #N is the "grade")
//   "Nolan Ryan #1 VG"               -> PSA 1
//   "Roberto Clemente NM-MT #9"      -> PSA 9
//   "Raw ungraded NM-MT 8 vintage"   -> PSA 8    (the title says RAW)
//   "Card GEM MINT 10 no grader"     -> PSA 10
//
// MEASURED on origin/main (probe, this branch's parent): every line above
// is this parser's output today. The mechanism is compositional — the
// adjective satisfies PSA_DESCRIPTOR_PATTERNS, which licenses the inference,
// and the any-number fallback then supplies the CARD NUMBER as its value.
// Neither half is a grade. A wrong grade is a wrong card: the row lands on a
// graded slug it was never in, the raw pool loses a real sale, and the row
// then feeds GRADE_CALIBRATION as evidence for a curve it is not on.
//
// THE CONTRACT, on a title:
//   - a grade requires an explicit GRADER TOKEN (PSA/BGS/SGC/CGC/CSG/HGA/
//     TAG/...), and the numeral is the one that FOLLOWS it, skipping the
//     slab-label words a holder actually prints between the two (GRADED,
//     GEM, MINT, MT, PRISTINE, AUTHENTIC, BLACK LABEL, EX-MT);
//   - "#N" is a card number, never a grade;
//   - a raw condition adjective with no grader (VG, EX, NM, VG-EX, EX-MT,
//     NM-MT, "or better") describes an UNGRADED card — it is raw-with-
//     condition, not a tier;
//   - ABSENT BEATS WRONG. A title that states no grade returns null, which
//     is a real answer meaning "raw / leave the stored grade alone", never
//     a licence to guess one.
//
// This is the same reading #1691 shipped as gradeFromTitleStrict in the
// census classifier, which refuses these rows. That classifier is a
// READER and this is the WRITER: until this function is the one the write
// path calls, the census keeps refusing rows the ingest keeps creating.
// gradeParserStrictEquivalence.test.ts pins the two to the same answers.

/** Grader tokens. A grade exists on a title only if one of these appears. */
export const TITLE_GRADER_RE = /\b(PSA|BGS|BVG|SGC|CGC|CSG|HGA|TAG|ISA|GMA|KSA)\b/i;

/** Raw-condition adjectives. WITHOUT a grader token beside them these are a
 *  seller describing an ungraded card, and they are not grades. */
export const TITLE_RAW_CONDITION_RE =
  /\b(?:VG-?VGEX|VG-?EX|EX-?MT|NM-?MT|GD-?VG|P-?FR|VG|EX|NM|GD|FR|PR|GEM\s*MINT|MINT|NEAR\s*MINT|EXCELLENT|VERY\s*GOOD|GOOD|POOR|FAIR)\b/i;

/**
 * Read a grade off a marketplace TITLE under the strict contract above.
 *
 * Returns null when the title states no grade — a real answer, not a
 * missing one. Callers holding a SLAB LABEL (iOS card-scan, PSA cert
 * `gradeDescription`) want parseGradeLabel instead: on a label the
 * descriptor vernacular is the grade.
 */
export function parseGradeFromTitle(title: string | null | undefined): ParsedGrade | null {
  const t = String(title ?? "").trim();
  if (!t) return null;

  // CF-THE-GRADER-WITH-THE-NUMBER-WINS (Drew, 2026-08-31), carried over from
  // parseGradeLabel. A title may name more than one grader and only one of
  // them is the holder this card is in — the others are a comparison, a
  // cross-over pitch or a regrade question:
  //
  //   "2021 Panini Chronicles Elite PSA #29 Isaac Paredes RC SGC 10 Gem Mint"
  //   "1968 TOPPS #230 PETE ROSE SGC 6 ... Not PSA or BVG"
  //
  // Taking the FIRST token attributes both to PSA, which carries no numeral,
  // and the whole parse then reads null on a correctly-stated grade. So every
  // grader token in the title is tried, and the one with a numeral adjacent
  // to it wins; ties fall to the leftmost, which is the single-grader case.
  const graderRe = new RegExp(TITLE_GRADER_RE.source, "gi");
  const candidates: Array<{ company: string; after: string }> = [];
  for (const g of t.matchAll(graderRe)) {
    if (g.index === undefined) continue;
    candidates.push({ company: g[1].toUpperCase(), after: t.slice(g.index + g[0].length) });
  }
  if (!candidates.length) return null;

  // Read FORWARD from the grader token only. A digit EARLIER in the title is
  // a year, a card number or a print run — never this card's grade.
  const NUMERAL_AFTER_GRADER =
    /^[\s.:\-]*(?:(?:GRADED|GRADE|AUTH(?:ENTIC(?:ATED)?)?|CARD|GEM|MINT|NEAR|MT|PRISTINE|BLACK|LABEL|[A-Z]{2}(?:-[A-Z]{2})?)[\s.:\-]*){0,4}(10(?:\.0)?|[1-9](?:\.5|\.0)?)(?!\d)/i;
  const winner = candidates.find((c) => {
    const hit = c.after.match(NUMERAL_AFTER_GRADER);
    if (!hit) return false;
    const v = Number(hit[1]);
    return Number.isFinite(v) && v > 0 && v <= 10;
  }) ?? candidates[0];

  // BVG is Beckett's vintage label — the same house as BGS, and the pool
  // keys on BGS. Every other token is already its own canonical company.
  const gradeCompany = winner.company === "BVG" ? "BGS" : winner.company;
  const after = winner.after;
  const m = after.match(NUMERAL_AFTER_GRADER);

  if (!m) {
    // No numeral belongs to this grader. An AUTHENTICATED-but-ungraded slab
    // is still a real answer — the CF-AUTHENTIC-BUCKET row — and it is the
    // one grade-bearing outcome that carries no numeral. Card numbers and
    // years are stripped first so "#1" and "2018" cannot stand in for one.
    if (/\bauth(?:entic|enticated)?\b/i.test(t)) {
      const withoutNoise = t
        .replace(/\b(?:19|20)\d{2}\b/g, " ")
        .replace(/#\s*[\w-]+/g, " ");
      if (!/\b(?:10|[1-9](?:\.5)?)\b/.test(withoutNoise)) {
        return { gradeCompany, gradeValue: 0, isAuthentic: true };
      }
    }
    return null;
  }

  const gradeValue = Number(m[1]);
  if (!Number.isFinite(gradeValue) || gradeValue <= 0 || gradeValue > 10) return null;

  // Black Label is a BGS-10-only tier, scoped exactly as parseGradeLabel
  // scopes it — same rule, same one place it can fire.
  if (
    gradeCompany === "BGS"
    && gradeValue === 10
    && BGS_BLACK_LABEL_PATTERNS.some((re) => re.test(t))
  ) {
    return { gradeCompany, gradeValue, isBlackLabel: true };
  }

  // PSA qualifier flags (issue #713). BGS/SGC/CGC use half-point deductions
  // rather than qualifiers, so detection stays scoped to PSA. The qualifier
  // is read from the text AFTER the numeral, so a two-letter word earlier in
  // the title cannot supply one.
  if (gradeCompany === "PSA") {
    const tail = after.slice(m[0].length);
    const qualifier = detectQualifier(tail);
    if (qualifier) return { gradeCompany, gradeValue, qualifier };
  }

  return { gradeCompany, gradeValue };
}
