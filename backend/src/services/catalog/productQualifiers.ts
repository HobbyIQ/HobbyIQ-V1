/**
 * CF-A-PRODUCT-QUALIFIER-IS-IDENTITY (D22, Drew 2026-08-30: "bobby witt came
 * out of bowman draft … first edition is another bowman set"; Bowman Draft ≠
 * Bowman Draft 1st Edition; bowman vs bowman-chrome vs sapphire are different
 * cards too).
 *
 * Holding 3fe98abe — 2020 Bowman Draft Bobby Witt Jr. #BD152. Its only pool
 * row was a $4 sale titled "2020 Bowman Draft 1st Edition - Bobby Witt Jr
 * #BD-152 (RC)", filed under the plain Draft slug: the vendor's product tag
 * said "1st Edition" and the slug grammar collapsed it (normalizeSetKey
 * "2020 Bowman Draft 1st Edition Baseball" → bowman-draft). A product
 * qualifier in a title — "1st Edition", "Sapphire", "Chrome" (paper vs chrome
 * Bowman), "Update" — is identity, not noise: a sale whose title says one of
 * them must not be pooled under the plain product's slug.
 *
 * The table is small and explicit. Two moves are REFUSED on purpose and
 * reported, never made by a bot:
 *   bowman → bowman-chrome     Bowman's own Chrome Prospects (BCP-, CPA-)
 *                              say "Chrome" in every title; the family
 *                              ladder refuses bowman ↔ bowman-chrome (the
 *                              bcp-125 NEEDS DREW ruling).
 *   topps-chrome → (Update)    the grammar collapses Topps Chrome Update into
 *                              topps-chrome (CF-CHROME-SUBSET-COLLAPSE) while
 *                              the checklist holds topps-chrome-update-series
 *                              — a vocabulary ruling.
 * Used by the ingest seam (persistVendorSalesToPool) and by
 * repair-parallel-from-title MODE=product (through dist).
 */
import { normalizeSetKey } from "../portfolioiq/hobbyIqCardId.service.js";

export interface QualifierRule {
  qualifier: string;
  re: RegExp;
  /** plain setKey → qualified setKey */
  moves: Readonly<Record<string, string>>;
  /** plain setKey → why the move is a ruling, not a bot move */
  refuse?: Readonly<Record<string, string>>;
}

export const PRODUCT_QUALIFIERS: ReadonlyArray<QualifierRule> = [
  {
    qualifier: "1st Edition",
    re: /\b(?:1st|first)\s+edition\b/i,
    moves: { "bowman-draft": "bowman-draft-1st-edition", "bowman": "bowman-1st-edition" },
  },
  {
    qualifier: "Sapphire",
    re: /\bsapphire\b/i,
    moves: {
      "bowman": "bowman-chrome-sapphire",
      "bowman-chrome": "bowman-chrome-sapphire",
      "bowman-draft": "bowman-draft-sapphire",
      "topps-chrome": "topps-chrome-sapphire",
      "topps-update": "topps-update-sapphire",
    },
  },
  {
    qualifier: "Update",
    re: /\bupdate\b/i,
    moves: { "topps": "topps-update" },
    refuse: { "topps-chrome": "vocabulary: the slug grammar collapses Topps Chrome Update into topps-chrome (CF-CHROME-SUBSET-COLLAPSE) while the checklist holds topps-chrome-update-series — a ruling, not a bot move" },
  },
  {
    qualifier: "Chrome",
    re: /\bchrome\b/i,
    moves: { "topps": "topps-chrome" },
    refuse: { "bowman": "family-ruling: Bowman's own Chrome Prospects (BCP-/CPA-) say Chrome in every title; bowman ↔ bowman-chrome is refused (NEEDS DREW, bcp-125)" },
  },
];

export interface QualifierDecision {
  /** The canonical setKey to use (the plain one when nothing applied). */
  setKey: string;
  /** The plain setKey the title was measured against. */
  from: string;
  /** Qualifiers the title names that moved the product, in order. */
  applied: string[];
  /** Qualifiers the title names whose move is refused, with the ruling. */
  refused: Array<{ qualifier: string; reason: string }>;
}

/** Does the setKey already carry this qualifier's spelling? */
function alreadyQualified(setKey: string, rule: QualifierRule): boolean {
  return Object.values(rule.moves).includes(setKey) || (rule.qualifier === "Sapphire" && /sapphire/.test(setKey))
    || (rule.qualifier === "1st Edition" && /1st-edition/.test(setKey))
    || (rule.qualifier === "Update" && /update/.test(setKey))
    || (rule.qualifier === "Chrome" && /chrome/.test(setKey));
}

/**
 * The qualified setKey a title asks for. `setKeyText` may be a vendor's
 * setName or a canonical setKey; it is normalised first. Qualifiers apply
 * in table order and iterate (a "Topps Chrome Sapphire" title under `topps`
 * moves to topps-chrome, then to topps-chrome-sapphire). Pure.
 */
export function qualifiedSetKeyFromTitle(setKeyText: string | null | undefined, title: string | null | undefined): QualifierDecision {
  const from = normalizeSetKey(String(setKeyText ?? ""));
  const t = String(title ?? "");
  const out: QualifierDecision = { setKey: from, from, applied: [], refused: [] };
  if (!from || !t) return out;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const rule of PRODUCT_QUALIFIERS) {
      if (!rule.re.test(t) || alreadyQualified(out.setKey, rule)) continue;
      const to = rule.moves[out.setKey];
      if (to) { out.setKey = to; out.applied.push(rule.qualifier); moved = true; continue; }
      const why = rule.refuse?.[out.setKey];
      if (why && !out.refused.some((r) => r.qualifier === rule.qualifier)) out.refused.push({ qualifier: rule.qualifier, reason: why });
    }
    if (!moved) break;
  }
  return out;
}

/** The setKey segment of an hiq slug. */
export function setKeyOfSlug(slug: string): string | null {
  const parts = String(slug ?? "").split(":");
  return parts.length >= 7 && parts[0] === "hiq" ? parts[3] : null;
}

/** The same slug with its setKey segment replaced. */
export function withSetKey(slug: string, setKey: string): string {
  const parts = String(slug).split(":");
  parts[3] = setKey;
  return parts.join(":");
}
