// CF-HOLDING-FIELD-NORMALIZER (Drew, 2026-07-14): the standard for
// cleaning messy eBay-imported holding fields before they hit the
// suggester, resolver, or comp bridge. Pure functions — no I/O, fully
// testable, safe to call defensively at multiple points in the pipeline.
//
// WHY THIS EXISTS
// ---------------
// eBay title parsing produces messy structured fields:
//   setName:   "2026 Bowman" (year duplicated with cardYear),
//              "bowman baseball" (casing / category noise),
//              "2025-26 Bowman" (year-range prefix)
//   parallel:  "Chrome" (that's a set, not a parallel),
//              "Chrome Refractor" (set prefix + real parallel),
//              "Chrome Prospects Refractor" (set + subset + parallel)
//   playerName: "Refractors Eric Hartman" (parallel word leaked into name)
//   cardNumber: lowercase, whitespace variance
//
// Uncleaned, these produce garbage queries like
// "2026 2026 Bowman Eric Hartman Chrome #CPA-EHA" that CH's tokenizer
// zeros out. The 2026-07-14 probe on Drew's 36 active holdings had 32
// return no candidates from EITHER vendor — the messy-field bug, not
// a catalog gap.
//
// RULES
// -----
// Each rule is a pure transformation with a name + reason so the
// normalize() summary can report what changed. Rules compose in the
// order defined below. Every rule is opt-outable via NormalizeOptions
// for testing / edge-case suppression.
//
// Adding a new rule:
//   1. Add it to the RULES array
//   2. Add a test in holdingFieldNormalizer.test.ts pinning the
//      before/after
//   3. Document the pattern (real observed messy value) in the rule's
//      comment so future readers know why the rule exists
//
// Rules are additive/defensive — normalize() must always be safe to
// call on already-clean data (idempotent). If a rule can't confidently
// clean a value, leave it unchanged rather than guess.

import { canonicalVariationName } from "../catalog/variationVocabulary.js";

export interface NormalizableHoldingFields {
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
  /** CF-A-PARALLEL-FIELD-HOLDS-ONLY-THE-PARALLEL (Drew, 2026-09-05). The
   *  destination axes R10 moves a mis-filed token ONTO. Each is optional and
   *  each is only ever written when it is blank, or already equal to what the
   *  parallel states — a stated value is never contradicted, and a stated
   *  `false` is never flipped. Passed through untouched otherwise, so every
   *  existing caller that omits them keeps its exact current behaviour. */
  printRun?: number | null;
  /** Numeric grade, e.g. 10 / 9.5. */
  grade?: number | string | null;
  /** Grader token, e.g. "PSA" / "BGS". Grade doctrine: the grade is read from
   *  the GRADER TOKEN only (feedback_grade_from_grader_token_only) — an
   *  adjective or a card number never mints one. */
  gradeCompany?: string | null;
  /** CF-SETNAME-FROM-PRODUCT (Drew, 2026-07-23). Older manually-entered
   *  holdings stored the setName under `product` and left `setName`
   *  undefined. When both fields are provided, R6 uses `product` as a
   *  fallback source for `setName`. Passed through unchanged. */
  product?: string | null;
}

export interface NormalizeOptions {
  /** Set of rule names to skip (for tests). Defaults to none. */
  skipRules?: Set<string>;
}

export interface NormalizeChange {
  rule: string;
  field: "playerName" | "setName" | "parallel" | "cardNumber" | "product" | "printRun" | "isAuto" | "grade" | "gradeCompany";
  before: string | null;
  after: string | null;
}

export interface NormalizeResult {
  fields: NormalizableHoldingFields;
  changes: NormalizeChange[];
}

/**
 * Vocabulary shared by parallel-decontamination + player-decontamination.
 * Words that CAN appear in the parallel field or leak into playerName
 * that shouldn't be there. Case-insensitive.
 */
/**
 * Words that are SET/SUBSET names, not parallel names. Safe to strip
 * from the parallel field's leading tokens because a real parallel
 * ("Blue Refractor", "Green Shimmer") wouldn't start with these.
 * Used by R3 (parallel_strip_subset_prefix).
 */
const SUBSET_WORDS = [
  "chrome",
  "prospects",
  "prospect",
  "autographs",
  "autograph",
  "baseball",
  "basketball",
  "football",
  "hockey",
];

/**
 * Words that CAN legitimately appear in a parallel name but should
 * NEVER be the leading token of a player's name. Union with
 * SUBSET_WORDS for R4 (playerName_strip_leading_noise). Kept separate
 * from SUBSET_WORDS so R3 doesn't wrongly strip "Sapphire" from a
 * "Sapphire Refractor" parallel string (Sapphire IS a subset but the
 * parallel-scope word is different than the leaking-into-player case).
 *
 * OBSERVED (2026-07-14 audit):
 *   playerName "Sapphire Owen Carey" for a BSPA-OC card — Sapphire is
 *   the Bowman Sapphire subset name that leaked into the parser output.
 */
const PLAYERNAME_LEADING_NOISE_EXTRA = [
  "sapphire",
  "sterling",
  "heritage",
  "topps",
  "bowman",
  "panini",
  "prizm",
  "select",
  "optic",
  "mosaic",
  "refractors",
  "refractor",
  // CF-HERITAGE-PLAYERNAME-NOISE (Drew, 2026-07-29). Topps Heritage
  // has subset words that CH sometimes prepends to the player field
  // itself (not just the set/parallel). OBSERVED: "Patchwork Jac
  // Caglianone" for Heritage #136 — "Patchwork" is a Heritage subset
  // name pointing to the patchwork uniform-swatch variant, not a
  // person's name. Same shape for Chrome/Action Variation subsets.
  "patchwork",
  "action",     // Heritage \"Action Variation\" subset
  "variation",  // \"Action Variation\" trailing word
  "sp",         // \"SP\" short-print marker
  "ssp",        // \"SSP\" super short-print marker
  // CF-INSERT-LEADING-NOISE (Drew, 2026-08-08). Observed catalog rows
  // where insert-set descriptors leaked to the front of playerName:
  //   "Debut Shohei Ohtani"          (2018 Topps Update US285)
  //   "Complete Set Shohei Ohtani"   (Topps Update DRIP-30)
  //   "Rookie Debut Shohei Ohtani"   (variant)
  // Adding these lets R4 strip them so playerName resolves clean.
  "debut",
  "rookie",     // "Rookie Debut …" leading combo
  "complete",   // "Complete Set …"
  "set",        // when "set" leads (only after "complete" strip)
  "the",        // "The Show …" occasionally
  "an",         // "An International …"
  "a",          // rare, "A Debut …"
];

/**
 * Words that IF they're the entire parallel field (or the whole prefix
 * of it) mean the parallel is set/subset noise, not a real parallel.
 * Real parallels can INCLUDE "Refractor" (base refractor is a real SKU)
 * so we only strip the WORDS above, then check what's left.
 */
const PARALLEL_NULL_ON_EMPTY = true;

interface Rule {
  name: string;
  apply(fields: NormalizableHoldingFields, changes: NormalizeChange[]): NormalizableHoldingFields;
}

const RULES: Rule[] = [
  // ── R10 parallel: A PARALLEL FIELD HOLDS ONLY THE PARALLEL ─────────
  // CF-A-PARALLEL-FIELD-HOLDS-ONLY-THE-PARALLEL (Drew, 2026-09-05).
  //
  // OBSERVED (PR #1845, holdings 4a82faed + 25bc5079, one user):
  //   parallel: "Refractor Auto / 499"
  // — an eBay `Parallel/Variety` aspect the SELLER typed as a listing-title
  // fragment. Three facts are jammed into one field: the parallel word
  // ("Refractor"), the auto flag ("Auto") and the print run ("/ 499"). The
  // slug built from it reads
  //
  //   ...:cpa-dt:refractor-auto-499:auto:num-499
  //           ^^^^^^^^^^^^^^^^^^^^^ a parallel that no checklist names
  //
  // while the checklist twin is `...:cpa-dt:refractor:auto:num-499`. The
  // holding therefore prices off a pool of one — its own purchase — and
  // `recheck-holding-identity MODE=rederive` GATE 2 correctly REFUSES the
  // re-point, because a stored parallel the destination does not carry is,
  // as far as that gate can tell, a different card.
  //
  // THE SPLIT IS LOSSLESS, AND THAT IS THE WHOLE PERMISSION SLIP.
  // A user-set field is never overwritten by an automatic pass. What this
  // rule does is NOT an overwrite — it is a NORMALIZATION that moves each
  // token to the axis that already exists for it and keeps every fact:
  //
  //   "Refractor Auto / 499"  →  parallel "Refractor"
  //                              + isAuto true      (its own field)
  //                              + printRun 499     (its own field)
  //
  // Nothing is discarded, so the holding still states everything it stated.
  //
  // AND THE SPLIT ONLY WRITES A BLANK OR AN AGREEMENT. Every destination is
  // guarded: a print run is written only when `printRun` is blank; the auto
  // flag only when `isAuto` is blank — a stated `false` is NEVER flipped,
  // because a seller who typed "Auto" into the variety box does not outrank a
  // holding that says this copy is unsigned; a grade only when both grade
  // axes are blank, and only from a GRADER TOKEN carrying its number
  // (feedback_grade_from_grader_token_only — #1704 minted PSA N out of
  // adjectives and card numbers, and 38k stored rows paid for it).
  //
  // ON DISAGREEMENT THE STATED FIELD STANDS AND THE TOKEN STILL LEAVES THE
  // PARALLEL. It was never parallel information in the first place, so
  // keeping it would leave the slug just as wrong as before; and the fact it
  // carried is not lost, because the holding already states that axis.
  //
  // RUNS FIRST, BEFORE R7/R3/R9. Those rules tokenize on whitespace and match
  // on the whole string; a trailing "/ 499" defeats R8's `Ref$` anchor and
  // R9's variation-vocabulary lookup alike. Cleaning the field down to its
  // parallel words first is what lets the existing rules see the shape they
  // were written for.
  {
    name: "parallel_split_off_foreign_axes",
    apply(fields, changes) {
      const raw = fields.parallel;
      if (!raw || typeof raw !== "string") return fields;
      let work = ` ${raw} `;

      // ── print run ── "/ 499", "#/499", "1 of 1", "numbered to 25".
      // A BARE SERIAL IS NOT A PRINT RUN: "180/499" states WHICH copy this
      // is, and only the denominator is the run. Both spellings leave the
      // parallel; only the denominator is offered to `printRun`.
      let runFromParallel: number | null = null;
      const serialRe = /\s(\d{1,5})\s*\/\s*(\d{1,5})(?=\s)/;          // "180/499"
      const runRe = /\s#?\s*\/\s*(\d{1,5})(?=\s)/;                     // "/ 499", "#/499"
      const numberedToRe = /\s(?:numbered|serial(?:\s*#)?)\s*(?:to\s*)?\/?\s*(\d{1,5})(?=\s)/i;
      const oneOfOneRe = /\s1\s*of\s*1(?=\s)/i;                        // "1 of 1"
      let m: RegExpExecArray | null;
      if ((m = serialRe.exec(work))) {
        runFromParallel = Number(m[2]);
        work = work.replace(serialRe, " ");
      } else if ((m = runRe.exec(work))) {
        runFromParallel = Number(m[1]);
        work = work.replace(runRe, " ");
      } else if ((m = numberedToRe.exec(work))) {
        runFromParallel = Number(m[1]);
        work = work.replace(numberedToRe, " ");
      } else if (oneOfOneRe.test(work)) {
        runFromParallel = 1;
        work = work.replace(oneOfOneRe, " ");
      }

      // ── auto ── the signature words. "Autograph"/"Autographs" is ALSO the
      // Bowman subset name, and that subset is already carried by the CPA-/
      // BSPA- card number and by `isAuto`, so removing it here loses nothing
      // either way (feedback_isauto_boundary_is_cardnumber_not_text).
      const autoRe = /\s(?:auto|autos|autographed|autographs?|signed|signature)(?=\s)/i;
      const autoFromParallel = autoRe.test(work);
      if (autoFromParallel) work = work.replace(new RegExp(autoRe.source, "gi"), " ");

      // ── grade ── GRADER TOKEN ONLY, and the token must carry its number.
      // A bare "Gem Mint" mints nothing; a bare "Black Label" mints nothing.
      const gradeRe = /\s(psa|bgs|sgc|cgc|hga|csg|beckett)\s*\.?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?=\s)/i;
      const gm = gradeRe.exec(work);
      const companyFromParallel = gm ? gm[1].toUpperCase() : null;
      const gradeFromParallel = gm ? Number(gm[2]) : null;
      if (gm) work = work.replace(gradeRe, " ");

      // ── card number ── NOT STRIPPED, AND THE CORPUS IS WHY.
      //
      // The first cut of this rule removed any `#`-prefixed token, on the
      // reasoning that `cardNumber` is a required axis so a card number in the
      // parallel field fills nothing and is therefore noise. The sold_comps
      // census (2026-09-05, 16.7M rows carrying a parallel) refuted it: 85
      // rows spell a REAL parallel with a `#`, and the strip mangled nine of
      // the thirteen sampled shapes —
      //
      //   "#1 Prospect"            -> null            (a Bowman parallel, erased)
      //   "#1 Prospect - Yellow Back" -> "- Yellow Back"
      //   "Checklist #106-211"     -> "Checklist"     (which checklist? gone)
      //   "K. Mcreynolds #105"     -> "K. Mcreynolds"
      //   "Jersey #27 in Photo"    -> "Jersey in Photo"
      //
      // A `#` is not a card-number marker in this field; it is a hash, and
      // collectors use it for prospect ranks, checklist ranges and jersey
      // numbers. There is no shape here that a split would MOVE anywhere —
      // unlike a print run or an auto flag, a card number has no blank axis
      // waiting for it — so the rule leaves `#` alone entirely. Absent beats
      // wrong, and a strip that fills nothing has nothing to weigh against
      // the pools it fuses.

      // TIDY THE SEAM, NOT THE VALUE. Only the separators a removal can leave
      // dangling are trimmed, and `#` is NOT among them: "#1 Prospect" is a
      // real parallel whose leading hash is part of its name (see the census
      // note above), so trimming it here would undo the decision not to strip
      // hashes at all.
      const cleanedParallel = work
        .replace(/[\s\-–—/]+$/, "")
        .replace(/^[\s\-–—/]+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleanedParallel === raw.trim()) return fields;   // nothing foreign found

      const next: NormalizableHoldingFields = { ...fields };

      // WHAT IS LEFT MUST STILL BE A PARALLEL. If the split ate the whole
      // field the parallel becomes null — blank means unknown, never "Base"
      // (feedback_every_ingest_uses_the_one_checklist_format) — because a
      // field reading only "Auto / 499" never named a finish at all.
      next.parallel = cleanedParallel.length > 0 ? cleanedParallel : null;
      changes.push({ rule: "parallel_split_off_foreign_axes", field: "parallel", before: raw, after: next.parallel });

      // ── the destinations, each blank-or-leave ──
      if (runFromParallel !== null && runFromParallel > 0) {
        const stated = typeof fields.printRun === "number" ? fields.printRun : null;
        if (stated === null) {
          next.printRun = runFromParallel;
          changes.push({ rule: "parallel_split_off_foreign_axes", field: "printRun", before: null, after: String(runFromParallel) });
        }
        // stated !== null: the holding already says a run. It wins, whether it
        // agrees or not — an automatic pass does not correct a stated number.
      }

      if (autoFromParallel) {
        const stated = typeof fields.isAuto === "boolean" ? fields.isAuto : null;
        if (stated === null) {
          next.isAuto = true;
          changes.push({ rule: "parallel_split_off_foreign_axes", field: "isAuto", before: null, after: "true" });
        }
        // A STATED `false` IS NEVER FLIPPED. That asymmetry is the rule's
        // point: the auto flag's boundary is the card number, not text a
        // seller typed into a variety box.
      }

      if (companyFromParallel && gradeFromParallel !== null) {
        const statedGrade =
          fields.grade === null || fields.grade === undefined || String(fields.grade).trim() === ""
            ? null
            : Number(fields.grade);
        const statedCompany =
          fields.gradeCompany == null || String(fields.gradeCompany).trim() === ""
            ? null
            : String(fields.gradeCompany).trim().toUpperCase();
        if (statedGrade === null && statedCompany === null) {
          next.grade = gradeFromParallel;
          next.gradeCompany = companyFromParallel;
          changes.push({ rule: "parallel_split_off_foreign_axes", field: "grade", before: null, after: String(gradeFromParallel) });
          changes.push({ rule: "parallel_split_off_foreign_axes", field: "gradeCompany", before: null, after: companyFromParallel });
        }
      }

      return next;
    },
  },

  // ── R1 setName: strip year prefix ──────────────────────────────────
  // OBSERVED: setName "2026 Bowman" combined with cardYear=2026 → query
  // built "2026 2026 Bowman ..." (year doubled). Also "2025-26 Bowman"
  // (year-range prefix) with cardYear=2025.
  {
    name: "setName_strip_year_prefix",
    apply(fields, changes) {
      const set = fields.setName;
      const year = fields.cardYear;
      if (!set || typeof year !== "number") return fields;
      // Match leading year OR year-range (2025-26 / 2025-2026)
      const yearReSingle = new RegExp(`^\\s*${year}\\s+`);
      const yearReRange = new RegExp(`^\\s*${year}-(?:${(year % 100 + 1).toString().padStart(2, "0")}|${year + 1})\\s+`);
      let stripped = set;
      if (yearReRange.test(set)) stripped = set.replace(yearReRange, "").trim();
      else if (yearReSingle.test(set)) stripped = set.replace(yearReSingle, "").trim();
      if (stripped !== set && stripped.length > 0) {
        changes.push({ rule: "setName_strip_year_prefix", field: "setName", before: set, after: stripped });
        return { ...fields, setName: stripped };
      }
      return fields;
    },
  },

  // ── R2 setName: title-case normalization ───────────────────────────
  // OBSERVED: "bowman baseball" (all-lowercase from eBay title parser).
  // CH's set filter is case-sensitive on some paths; canonicalize to
  // Title Case so the wire form matches CH's catalog.
  {
    name: "setName_title_case",
    apply(fields, changes) {
      const set = fields.setName;
      if (!set) return fields;
      // Only touch when the string is entirely lowercase — mixed case is
      // intentional (e.g., "Bowman's Best" already correct).
      if (set !== set.toLowerCase()) return fields;
      const titled = set.replace(/\b\w/g, (c) => c.toUpperCase());
      if (titled !== set) {
        changes.push({ rule: "setName_title_case", field: "setName", before: set, after: titled });
        return { ...fields, setName: titled };
      }
      return fields;
    },
  },

  // ── R7 (runs before R3) parallel: strip garbled subset+auto prefix ─
  // CF-PARALLEL-DEGARBLE (Drew, 2026-07-23). Legacy holdings jammed
  // the subset+auto label into the parallel field with abbreviations.
  // MUST run BEFORE R3 — R3 tokenizes on whitespace only, so it can't
  // reach across the hyphen boundary that R7 uses. If R3 runs first
  // it pre-strips the leading noise words and leaves R7 unable to match
  // the compound prefix pattern (e.g. R3 turns "Chrome Prospect Auto-
  // Gold Ref" into "Auto-Gold Ref" and R7 requires ≥2 tokens before
  // the hyphen, so it declines).
  //
  // Pattern: ≥2 subset/auto tokens (space-separated) + hyphen + variant.
  //   "Chr Prospect Auto-Gold Ref"    → "Gold Ref"    (3 tokens)
  //   "Chrome Prospect Auto-Gold Ref" → "Gold Ref"    (3 tokens)
  //   "Prspct Au-Mini Diamond Ref"    → "Mini Diamond Ref" (2 tokens)
  //   "Chr Prospect Auto-Gum Ball"    → "Gum Ball"    (3 tokens)
  //
  // NOT stripped (guarded by the space-boundary after the first token —
  // if the first token is followed by a hyphen not a space, we bail):
  //   "Chrome-Image Variation" (Topps variant — "Chrome" is real)
  //   "Auto-Grade Refractor"   (hypothetical single-token compound)
  //
  // R8 (later) expands "Ref" → "Refractor" on the tail.
  {
    name: "parallel_strip_garbled_subset_prefix",
    apply(fields, changes) {
      const p = fields.parallel;
      if (!p) return fields;
      // First token MUST be followed by whitespace (not directly by
      // hyphen) — the space-boundary excludes "Chrome-Image Variation".
      // Then require ≥1 additional noise token, then a hyphen.
      const garbledRe = /^(?:chr|chrome|prospect|prospects|prspct|autograph|autographs)\s+(?:chr|chrome|prospect|prospects|prspct|auto|au|autograph|autographs)(?:\s+(?:chr|chrome|prospect|prospects|prspct|auto|au|autograph|autographs))*\s*-\s*/i;
      const stripped = p.replace(garbledRe, "").trim();
      if (stripped !== p && stripped.length > 0) {
        changes.push({ rule: "parallel_strip_garbled_subset_prefix", field: "parallel", before: p, after: stripped });
        return { ...fields, parallel: stripped };
      }
      return fields;
    },
  },

  // ── R3 parallel: strip subset-prefix words ─────────────────────────
  // OBSERVED: parallel="Chrome Refractor" → parallel should be
  // "Refractor" (Chrome is the set). parallel="Chrome Prospects
  // Refractor" → parallel should be "Refractor". parallel="Chrome" alone
  // → parallel should be null (no real parallel info).
  {
    name: "parallel_strip_subset_prefix",
    apply(fields, changes) {
      const p = fields.parallel;
      if (!p) return fields;
      // D22: "Chrome Variation" (Heritage) names its KIND with the word the
      // rule would strip; a variation keeps every word it has.
      if (/\b(?:variations?|var)\b/i.test(p)) return fields;
      // Split into tokens (whitespace + hyphen boundary), lowercase for
      // comparison against SUBSET_WORDS but keep original casing for the
      // rebuild.
      const tokens = p.split(/\s+/).filter((t) => t.length > 0);
      // Drop leading tokens that are subset noise.
      let i = 0;
      while (i < tokens.length && SUBSET_WORDS.includes(tokens[i].toLowerCase())) i++;
      const remaining = tokens.slice(i);
      if (i === 0) return fields;                    // no subset prefix found
      if (remaining.length === 0) {
        // Whole parallel was noise → null it out (per PARALLEL_NULL_ON_EMPTY).
        if (PARALLEL_NULL_ON_EMPTY) {
          changes.push({ rule: "parallel_strip_subset_prefix", field: "parallel", before: p, after: null });
          return { ...fields, parallel: null };
        }
        return fields;
      }
      const rebuilt = remaining.join(" ");
      changes.push({ rule: "parallel_strip_subset_prefix", field: "parallel", before: p, after: rebuilt });
      return { ...fields, parallel: rebuilt };
    },
  },

  // ── R4 playerName: strip leading subset/set/brand words ────────────
  // OBSERVED: playerName "Refractors Eric Hartman" — parallel word leak.
  // OBSERVED: playerName "Sapphire Owen Carey" — subset word leak.
  // Union of SUBSET_WORDS + PLAYERNAME_LEADING_NOISE_EXTRA covers both
  // parallel-word leaks (refractor, refractors) and set/brand leaks
  // (Sapphire, Sterling, Bowman, Topps, etc.).
  {
    name: "playerName_strip_leading_noise",
    apply(fields, changes) {
      const name = fields.playerName;
      if (!name) return fields;
      const noiseWords = new Set([...SUBSET_WORDS, ...PLAYERNAME_LEADING_NOISE_EXTRA]);
      const tokens = name.split(/\s+/).filter((t) => t.length > 0);
      let i = 0;
      while (i < tokens.length && noiseWords.has(tokens[i].toLowerCase())) i++;
      if (i === 0) return fields;
      const remaining = tokens.slice(i);
      if (remaining.length === 0) return fields;     // don't null the whole player
      const rebuilt = remaining.join(" ");
      changes.push({ rule: "playerName_strip_leading_noise", field: "playerName", before: name, after: rebuilt });
      return { ...fields, playerName: rebuilt };
    },
  },

  // ── R4b playerName: strip trailing action-word descriptors ─────────
  // CF-ACTION-WORD-SUFFIX (Drew, 2026-07-29). Vendor titles include
  // action descriptors like "Aaron Judge #169 Catching" — the pose /
  // action the photo shows, not part of the player's name. CH is
  // concatenating that descriptor into the player field. Strip any
  // number of trailing descriptors (and don't null the whole name).
  //
  // OBSERVED 2026-07-29 verify_queue:
  //   playerName "Aaron Judge Catching" (title "…Aaron Judge #169
  //   Catching Refractor…" — Catching is the photo pose).
  {
    name: "playerName_strip_trailing_action",
    apply(fields, changes) {
      const name = fields.playerName;
      if (!name) return fields;
      const trailingNoise = new Set([
        // Photo pose / action descriptors (Topps Chrome variation subsets)
        "catching", "pitching", "batting", "fielding", "sliding",
        "throwing", "running", "hitting", "swinging", "diving",
        "bunting", "sprinting", "dunking", "shooting", "passing",
        // Variation markers
        "variation", "sp", "ssp",
        // Team-designation trailing tokens that leak in occasionally
        "rc", "rookie",
        // CF-INSERT-TRAILING-NOISE (Drew, 2026-08-08). Insert subset
        // descriptors that vendors concatenate into playerName:
        //   "Shohei Ohtani Pitching Jersey"          (US1 uniform-swatch)
        //   "Shohei Ohtani Highlights Checklist"     (US189 checklist card)
        //   "Shohei Ohtani In The"                   (LITM-21 "In The Making")
        //   "Shohei Ohtani An International Affair"  (IA-23 subset)
        //   "Shohei Ohtani Low Pop"                  (holder-descriptor leak)
        //   "Shohei Ohtani All Star Celebration"     (ASG subset)
        // Loop-stripping so multi-word tails collapse cleanly.
        "jersey", "highlights", "checklist", "affair",
        "international", "national", "celebration", "making",
        "show", "story", "moments", "moment",
        "in", "the", "of", "an", "a", "for",  // conjunctions/articles that survive after descriptor strip
        "low", "pop",                          // pop-report leak
        "all", "star",                         // "All Star Celebration"
        // Set / brand words that leak into the tail of playerName from
        // vendor titles like "SHOHEI OHTANI 2018 Topps Update An Intl
        // Affair". These are the same words in PLAYERNAME_LEADING_NOISE_EXTRA
        // — safe to strip trailing too (no player's real name ends in
        // "Topps" or "Bowman").
        "topps", "bowman", "panini", "prizm", "chrome", "update",
        "select", "optic", "mosaic", "sapphire", "heritage", "sterling",
        "prospects", "prospect", "draft",
      ]);
      const tokens = name.split(/\s+/).filter((t) => t.length > 0);
      let j = tokens.length;
      while (j > 0 && trailingNoise.has(tokens[j - 1].toLowerCase())) j--;
      if (j === tokens.length) return fields;   // nothing to strip
      if (j === 0) return fields;               // don't null the whole name
      const rebuilt = tokens.slice(0, j).join(" ");
      changes.push({ rule: "playerName_strip_trailing_action", field: "playerName", before: name, after: rebuilt });
      return { ...fields, playerName: rebuilt };
    },
  },

  // ── R4c playerName: strip trailing 4-digit years ────────────────────
  // CF-YEAR-LEAK-IN-NAME (Drew, 2026-08-08). Vendor titles sometimes
  // duplicate the year: "SHOHEI OHTANI 2018 2018 Topps Update An
  // International Affair" → after subset strip playerName becomes
  // "SHOHEI OHTANI 2018 2018". Strip any trailing 1900-2100 year
  // tokens (loop so double-leak collapses).
  {
    name: "playerName_strip_trailing_year",
    apply(fields, changes) {
      const name = fields.playerName;
      if (!name) return fields;
      const tokens = name.split(/\s+/).filter((t) => t.length > 0);
      let j = tokens.length;
      while (j > 0) {
        const t = tokens[j - 1];
        if (!/^\d{4}$/.test(t)) break;
        const n = Number(t);
        if (n < 1900 || n > 2100) break;
        j--;
      }
      if (j === tokens.length) return fields;
      if (j === 0) return fields;
      const rebuilt = tokens.slice(0, j).join(" ");
      changes.push({ rule: "playerName_strip_trailing_year", field: "playerName", before: name, after: rebuilt });
      return { ...fields, playerName: rebuilt };
    },
  },

  // ── R4d playerName: title-case an ALL-CAPS name ─────────────────────
  // CF-ALLCAPS-PLAYERNAME (Drew, 2026-08-08). Vendors occasionally emit
  // "SHOHEI OHTANI" — canonical playerName is "Shohei Ohtani" per the
  // Cardsight / TCDB convention. Only title-case when the WHOLE name
  // is uppercase (mixed-case names like "Cal Ripken Jr" stay intact).
  {
    name: "playerName_title_case_all_caps",
    apply(fields, changes) {
      const name = fields.playerName;
      if (!name) return fields;
      // Only trigger when the name is entirely uppercase AND has at
      // least one lowercase-eligible letter (skip acronym-only names).
      const hasLetter = /[A-Z]/.test(name);
      const hasLower = /[a-z]/.test(name);
      if (!hasLetter || hasLower) return fields;
      const titled = name
        .split(/\s+/)
        .map((t) => t.length ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t)
        .join(" ");
      if (titled === name) return fields;
      changes.push({ rule: "playerName_title_case_all_caps", field: "playerName", before: name, after: titled });
      return { ...fields, playerName: titled };
    },
  },

  // ── R5 cardNumber: uppercase + trim ────────────────────────────────
  // OBSERVED: "cpa-eha" (lowercase). CH's catalog stores numbers uppercase.
  // Trivial fix, high impact when hit.
  {
    name: "cardNumber_uppercase_trim",
    apply(fields, changes) {
      const num = fields.cardNumber;
      if (!num) return fields;
      const cleaned = num.trim().toUpperCase();
      if (cleaned !== num) {
        changes.push({ rule: "cardNumber_uppercase_trim", field: "cardNumber", before: num, after: cleaned });
        return { ...fields, cardNumber: cleaned };
      }
      return fields;
    },
  },

  // ── R6 setName: fall back to product when setName is unset ─────────
  // CF-SETNAME-FROM-PRODUCT (Drew, 2026-07-23). Older manually-entered
  // holdings (Drew's inventory audit surfaced 8 of them) stored the
  // set name under `product` and left `setName` undefined. Copy across
  // when the target is empty AND the source is a non-empty string.
  //
  // OBSERVED:
  //   Piasentin: setName=undefined, product="Bowman Draft Chrome Prospect Autographs"
  //   Gage Wood: setName=undefined, product="Bowman Draft Chrome Prospect Autographs"
  //   Hank Aaron: setName=undefined, product="Topps"
  {
    name: "setName_fallback_from_product",
    apply(fields, changes) {
      const set = fields.setName;
      const product = fields.product;
      if (set != null && String(set).trim().length > 0) return fields;
      if (product == null || String(product).trim().length === 0) return fields;
      const filled = String(product).trim();
      changes.push({ rule: "setName_fallback_from_product", field: "setName", before: (set as string | null) ?? null, after: filled });
      return { ...fields, setName: filled };
    },
  },

  // ── R8 parallel: expand trailing "Ref" abbreviation ────────────────
  // CF-PARALLEL-EXPAND-REF (Drew, 2026-07-23). Legacy holdings truncated
  // "Refractor" to "Ref" on parallel strings. Downstream lookups need
  // the full word to match CH's catalog + our own parallel multipliers.
  // Only expands as a whole-word suffix — never in the middle (so
  // "Refractor" itself stays, "Reference" won't get touched).
  //
  // OBSERVED:
  //   "Gold Ref"           → "Gold Refractor"
  //   "Mini Diamond Ref"   → "Mini Diamond Refractor"
  //   "Blue Ref"           → "Blue Refractor"
  {
    name: "parallel_expand_ref_suffix",
    apply(fields, changes) {
      const p = fields.parallel;
      if (!p) return fields;
      const expanded = p.replace(/(\S)\s+Ref\s*$/i, "$1 Refractor").trim();
      if (expanded !== p) {
        changes.push({ rule: "parallel_expand_ref_suffix", field: "parallel", before: p, after: expanded });
        return { ...fields, parallel: expanded };
      }
      return fields;
    },
  },

  // ── R9 parallel: the variation vocabulary (D22) ─────────────────────
  // CF-A-VARIATION-IS-A-CARD. A holding's parallel field says "Photo
  // Variations", "Image Var", "SSP", "SP Variation", "Golden Mirror Image
  // Variation" — six spellings of two cards. One vocabulary
  // (variationVocabulary.ts) so the holding CAN be the variation, through the
  // field it already has. A bare "SP" is left alone: in Heritage it is the
  // short-printed base card, and only the catalog match can say.
  {
    name: "parallel_variation_vocabulary",
    apply(fields, changes) {
      const p = fields.parallel;
      if (!p) return fields;
      const canon = canonicalVariationName(p);
      if (canon && canon !== p) {
        changes.push({ rule: "parallel_variation_vocabulary", field: "parallel", before: p, after: canon });
        return { ...fields, parallel: canon };
      }
      return fields;
    },
  },

  // ── R11 setName: the Preview is the product, and the rung is not part of it ─
  //
  // CF-BOWMANS-BEST-PREVIEW-IS-ITS-OWN-PRODUCT (Drew, 2026-09-06). Measured on
  // Drew's own two withheld 1997 #BBP4 Jeter holdings, which is where this was
  // found: the eBay importer wrote the whole aspect string into setName.
  //
  //   setName "Bowmans Best Preview Atomic Refractor"   parallel "Atomic Refractor"
  //   setName "1997 Bowman's Best"                      parallel "Atomic Refractor"
  //
  // The first says the rung TWICE -- once in the field that holds the rung and
  // again inside the product name -- and normalizeSetKey has to read a product
  // out of a string that names a finish. The second does not name the Preview
  // at all. Both land on the same wrong key.
  //
  // THE RUNG COMES OFF, NOT THE PRODUCT. Only a trailing rung phrase this
  // product actually has (Refractor / Atomic Refractor) is stripped, and only
  // when the Preview is named, so no other setName is touched. What remains is
  // the canonical spelling of the product, which is a normalizeSetKey fixed
  // point -- so the field the holding already has can reach the ruled key.
  //
  // ONLY WHAT THE TEXT SAYS. A setName that never names a Preview is left
  // exactly as it is: this rule cannot invent the Preview from a bare
  // "Bowman's Best", because a holding of the parent product is a real thing
  // and guessing would move it off its own pool. The second holding above is
  // therefore NOT repaired here -- its title says Preview and its setName does
  // not, and a field-level normalizer does not read titles. It is repaired by
  // the ruling dispatch, which is the sanctioned path for a stored row.
  //
  // IDEMPOTENT: the output is already canonical, so a second pass is a no-op,
  // which normalizeHoldingFields promises and the pins assert.
  {
    name: "setName_bowmans_best_preview_is_the_product",
    apply(fields, changes) {
      const set = fields.setName;
      if (!set) return fields;
      if (!/bowman'?s\s+best\s+previews?/i.test(set)) return fields;
      // Everything up to and including the Preview name, with the rung phrase
      // that may follow it dropped. A year prefix is R1's job, not this rule's.
      const m = /^(.*?bowman'?s\s+best\s+previews?)(?:\s+(?:atomic\s+)?refractors?)?\s*$/i.exec(set.trim());
      if (!m) return fields;
      const head = m[1].replace(/bowman'?s\s+best\s+previews?/i, "Bowman's Best Preview").trim();
      if (!head || head === set) return fields;
      changes.push({ rule: "setName_bowmans_best_preview_is_the_product", field: "setName", before: set, after: head });
      return { ...fields, setName: head };
    },
  },

  // CF-A-TRAILING-COMMA-IS-NOT-PART-OF-A-NAME (Drew, 2026-08-25, on his own
  // holding reading "Marconi German,").
  //
  // eBay titles put the player's name next to a team, a grade or a set, and
  // the separator comes along with it. The slug survives -- slugify() drops
  // punctuation -- so this never broke pricing, which is exactly why it sat
  // there: it is visible on every card detail screen and in every player
  // lookup that compares strings rather than slugs.
  //
  // Trailing commas, semicolons, colons, hyphens and stray quotes are always
  // noise. A trailing PERIOD is not: "Ken Griffey Jr." and "A.J. Pierzynski"
  // are real, so a period is only removed when it stands alone after a space.
  {
    name: "playerName_strip_edge_punctuation",
    apply(fields, changes) {
      const raw = fields.playerName;
      if (!raw) return fields;
      const cleaned = String(raw)
        .replace(/\s+\.\s*$/, "")        // " Jac Caglianone ." but not "Jr."
        .replace(/[,;:\-–—"'`]+\s*$/, "")
        .replace(/^\s*[,;:\-–—"'`]+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned && cleaned !== raw) {
        changes.push({ rule: "playerName_strip_edge_punctuation", field: "playerName", before: raw, after: cleaned });
        return { ...fields, playerName: cleaned };
      }
      return fields;
    },
  },
];

/**
 * Apply every enabled rule in order, returning the cleaned fields plus
 * an audit trail of every change. Idempotent — normalize(normalize(x)) === normalize(x).
 */
export function normalizeHoldingFields(
  fields: NormalizableHoldingFields,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const skip = opts.skipRules ?? new Set<string>();
  const changes: NormalizeChange[] = [];
  let current = { ...fields };
  for (const rule of RULES) {
    if (skip.has(rule.name)) continue;
    current = rule.apply(current, changes);
  }
  return { fields: current, changes };
}

/** Testing helper — expose rule names so tests can pin the full set. */
export function _getRuleNames(): string[] {
  return RULES.map((r) => r.name);
}
