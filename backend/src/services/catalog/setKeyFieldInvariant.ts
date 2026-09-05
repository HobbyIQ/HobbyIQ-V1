/**
 * CF-A-ROWS-SETKEY-FIELD-IS-ITS-ID-STEM (Drew, 2026-09-05).
 *
 * A catalog row is addressed by its `id`, and segment 3 of that id is the
 * PRODUCT. The `setKey` FIELD is supposed to name the same product. When the
 * two disagree the row is filed at one address and labelled with another, and
 * every reader that trusts the field reaches a different card from every
 * reader that trusts the address.
 *
 * -- WHAT WENT WRONG, MEASURED ---------------------------------------------
 *
 * 2026 Bowman. `computeHobbyIqCardId` applies the CHROME PREFIX OVERRIDE --
 * `bowman` + a `CPA-`/`BCP-` cardNumber -> `bowman-chrome` -- unless the
 * caller passes `authoritativeSetKey`, which a published checklist does
 * because it KNOWS the product (CF-AUTHORITATIVE-SETKEY). A caller that mints
 * the slug WITHOUT the flag and then writes the field from its own spelling
 * gets both halves out of step in one document:
 *
 *     id      hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499
 *     setKey  bowman
 *
 * Census 2026-09-05 (backend/docs/reports/bowman-vs-bowman-chrome-2026-09-05.md):
 * 19,867 rows on `bowman-chrome`, 16,822 on `bowman-paper`, 208 on
 * `bowman-chrome-sapphire`. The 2026 `bowman-chrome` sale pool is, today,
 * 10,532 Bowman sales at a Chrome address -- and zero real Bowman Chrome
 * sales exist yet to argue with them.
 *
 * -- WHY THIS IS NOT "FIELD MUST EQUAL STEM" -------------------------------
 *
 * Drift runs in BOTH directions and only ONE of them is a defect. A read-only
 * probe of the last 7 days of mints (120,000 rows, 2026-09-05) found:
 *
 *     stem MORE specific than the field   4,702   <- THE DEFECT
 *                                                 field `bowman` over stem
 *                                                 `bowman-chrome` / `bowman-paper`
 *     field MORE specific than the stem   1,223   <- LEGITIMATE
 *                                                 field
 *                                                 `topps-baseball-japan-edition`
 *                                                 over stem `topps`
 *     unrelated                             667
 *
 * The SECOND group is a checklist naming a product the slug vocabulary does
 * not spell yet, and it is the better identity of the two -- `catalogRowOps`
 * already keeps it VERBATIM on a fold for exactly that reason, and
 * feedback_slug_recompute_only_improve says a field is rewritten only when the
 * replacement is strictly MORE specific. An invariant that demanded equality
 * would refuse ~1,200 good checklist rows a week and destroy the identity on
 * every one of them.
 *
 * So the rule is DIRECTIONAL, and it is the same two-armed test
 * `catalogRowOps.fieldExtendsStem` already applies:
 *
 *   field === stem                      OK  (the ordinary row)
 *   field EXTENDS stem                  OK  (a named release of the product)
 *   stem EXTENDS field                  REFUSED -- the field is stale-generic,
 *                                       which is the minting defect above
 *   unrelated                           REFUSED -- neither names the other
 *
 * -- IT REFUSES, IT NEVER REPAIRS ------------------------------------------
 *
 * A silent "fix" here would write a product name nobody chose: the correct
 * answer is sometimes to move the ROW (the checklist meant `bowman`, so the
 * slug is wrong) and sometimes to widen the FIELD (the vendor path was right).
 * This module cannot tell which -- only the caller knows whether it holds a
 * checklist -- so it names the fault and refuses the write. The repair lane
 * re-mints through `deriveCatalogEntry` with `authoritativeSetKey: true`,
 * which is a decision, not a guess.
 */
import { productAncestry } from "./productSetKeys.js";

/** Segment 3 of a `hiq:` slug -- the product the row is ADDRESSED at. */
export function idSetKeyStem(id: unknown): string {
  return String(id ?? "").split(":")[3] ?? "";
}

/**
 * Is the field a named release *of* the stem's product? Two arms, because the
 * catalog's products outrun `PRODUCT_SET_KEYS`: the LADDER (the table's own
 * notion of "extends") and the LEXICAL extension, which catches the products
 * the table does not spell yet and which are the bulk of the live traffic.
 *
 * Kept identical to `catalogRowOps.fieldExtendsStem` on purpose -- one
 * comparison, so the write guard and the move op cannot drift apart.
 */
export function setKeyFieldExtendsStem(field: string, stem: string): boolean {
  if (!field || !stem || field === stem) return false;
  if (productAncestry(field).includes(stem)) return true;
  return field.startsWith(`${stem}-`);
}

export type SetKeyFieldViolation = {
  /** The closed reason vocabulary -- consumers never parse prose. */
  reason: "stem-more-specific-than-field" | "field-unrelated-to-stem";
  id: string;
  field: string;
  stem: string;
  message: string;
};

/**
 * The invariant. Returns `null` when the row is well-formed, and a NAMED
 * violation when it is not. Pure: no I/O, no clock, no Cosmos.
 *
 * Rows this deliberately passes through untouched:
 *   - a non-`hiq:` id (vendor-keyed legacy rows have no stem to compare);
 *   - a row with no `setKey` field at all -- absent is not wrong, and a
 *     blank field is "unknown", never "Base"
 *     (feedback_every_ingest_uses_the_one_checklist_format).
 */
export function checkSetKeyFieldMatchesIdStem(row: {
  id?: unknown;
  setKey?: unknown;
}): SetKeyFieldViolation | null {
  const id = String(row?.id ?? "");
  if (!id.startsWith("hiq:")) return null;
  const field = String(row?.setKey ?? "").trim().toLowerCase();
  if (!field) return null;
  const stem = idSetKeyStem(id).trim().toLowerCase();
  if (!stem) return null;
  if (field === stem) return null;
  if (setKeyFieldExtendsStem(field, stem)) return null;

  const reason = setKeyFieldExtendsStem(stem, field)
    ? "stem-more-specific-than-field"
    : "field-unrelated-to-stem";
  const detail = reason === "stem-more-specific-than-field"
    ? `setKey field "${field}" is the GENERIC of id stem "${stem}" — the slug was minted with the `
      + "cardNumber-prefix repair (CHROME_PREFIX_OVERRIDES) while the field kept the caller's "
      + "spelling. A caller that KNOWS the product must pass authoritativeSetKey: true so both "
      + "halves move together; a caller that does not must take the slug's stem as its field."
    : `setKey field "${field}" and id stem "${stem}" name unrelated products.`;

  return {
    reason,
    id,
    field,
    stem,
    message: `card_catalog write refused: ${detail} (CF-A-ROWS-SETKEY-FIELD-IS-ITS-ID-STEM)`,
  };
}

/** Throwing form, for the write choke point. */
export function assertSetKeyFieldMatchesIdStem(row: { id?: unknown; setKey?: unknown }): void {
  const v = checkSetKeyFieldMatchesIdStem(row);
  if (v) {
    const err = new Error(v.message) as Error & { violation?: SetKeyFieldViolation };
    err.violation = v;
    throw err;
  }
}
