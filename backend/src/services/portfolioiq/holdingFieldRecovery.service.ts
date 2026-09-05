/**
 * CF-A-HOLDING-CARRIES-ITS-OWN-EVIDENCE (Drew, 2026-09-05) — the FIELD
 * RECOVERY lane the catalog-rebuild plan anticipated.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * `recheck-holding-identity MODE=rederive` asks the matcher a question built
 * from five stored fields — setName, cardNumber, parallel, isAuto, printRun.
 * When one of those fields is BLANK the question is unanswerable, and the pass
 * reports NO-MATCH about a card whose checklist row exists and whose own
 * listing states the missing fact in plain text:
 *
 *   6f4f079b  1999 Upper Deck Black Diamond #D24 Ken Griffey Jr. Stored
 *             `parallel: "Base"`, `printRun: 1500`. There is no such row —
 *             a base D24 is unnumbered — so the matcher returns not-found at
 *             0.3 and the holding prices off `...:d24:base:no-auto`, the
 *             UNNUMBERED base pool. The holding's own eBay aspects say
 *             `Insert Set: Diamond Dominance`, `Print Run: 1500`,
 *             `Features: Serial Numbered, Insert`, and its title reads
 *             "1999 Upper Deck Black Diamond Diamond Dominance Ken #D24".
 *             With the insert recovered the matcher returns
 *             `...:d24:diamond-dominance:no-auto:num-1500` — exact, 0.98.
 *
 *   277b05a3  1997 Metal Universe Cal Ripken Jr. Stores NO cardNumber, NO
 *             setName and NO product, so computeHobbyIqCardId THROWS
 *             ("cardNumber is unparsed") before the catalog is ever consulted.
 *             Its description reads "1997 Cal Ripken Jr - Metal Universe -
 *             Magnetic Field - PSA 8" and its vendor suggestion carries
 *             number "8". With those recovered the matcher returns
 *             `hiq:baseball:1997:metal-universe:8:magnetic-field:no-auto` —
 *             exact, 0.98, checklist-backed by sportscardchecklist.
 *
 * WHERE THE INSERT GOES, AND WHY IT IS NOT A THIRD AXIS
 *
 * `Diamond Dominance` is an INSERT SET, not a finish. The instinct is to give
 * it its own axis — the `:sub-` segment of the subset grammar
 * (subsetIdentity.ts). That would be wrong HERE, and the catalog is the thing
 * that says so: the row this holding must reach spells the insert in its
 * PARALLEL segment,
 *
 *     hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500
 *                                                    ^^^^^^^^^^^^^^^^^^
 *
 * with `parallel: "Diamond Dominance"`, `parallelSlug: "diamond-dominance"`
 * and no subsetName at all. `CatalogMatchInput` has no subset field either.
 * The `:sub-` grammar exists for the narrower case it documents — two subsets
 * sharing one rung — and this is not that. So recovery puts the insert on the
 * axis the destination row actually uses, which is `parallel`, and the pins
 * below assert the resulting slug rather than the mechanism.
 *
 * THE RULE THAT KEEPS THIS FROM BEING A DISASTER
 *
 * ONLY BLANKS ARE FILLED, and "blank" is measured, not guessed. Over all 131
 * holdings (2026-09-05), 31 carry an `Insert Set` aspect and only ONE of them
 * is an insert in the identity sense. The other 30 read
 *
 *     "Chrome Prospect Autographs", "Prospect Autographs",
 *     "Chrome Prospects Autograph", "Best of 2025 Autographs", ...
 *
 * — the AUTOGRAPH SUBSET, which the identity already carries through `isAuto`
 * and the CPA-/BSPA-/B25- card number. Promoting those into `parallel` would
 * overwrite "Gold Refractor" with "Chrome Prospect Autographs" on 25 holdings
 * that are already RIGHT, fusing correctly-separated pools — the exact harm
 * the rederive gates exist to prevent. So:
 *
 *   1. a field the holding already states is NEVER touched, and
 *   2. `parallel: "Base"` counts as stated UNLESS the holding's own evidence
 *      contradicts it (Features names an Insert, or a Print Run is stated),
 *      and
 *   3. every recovery is re-asked of the matcher; a recovery that does not
 *      land on a real catalog row is discarded and the original question
 *      stands. Absent beats wrong.
 *
 * USER-SET FIELDS WIN, ALWAYS. A holding whose identity a human ruled on
 * (`identityResolvedBy: "ruling:..."`, `identityVerifiedBy.source` naming a
 * person, or an explicit `userEdited*` marker) is REPORT-ONLY: recovery is
 * computed and reported so the ruling can be revisited, and never applied.
 * Seven of the 131 carry a Drew ruling today, D24 among them.
 *
 * ONE NORMALIZER, ONE PARSER. Text is read through
 * `parseListingIdentity` (the title parser) and cleaned through
 * `normalizeHoldingFields` (holdingFieldNormalizer, THE standard for messy
 * imports). This module adds no third parser — it decides WHICH stored or
 * observed string to hand those two, and records where each answer came from.
 *
 * Pure: no I/O, no Cosmos, no clock. The caller re-asks the matcher.
 */
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";
import { parseListingIdentity, inferSetKeyFromTitle } from "./parseTitleIdentity.service.js";

/** The axes recovery can fill. Deliberately the same five the rederive pass
 *  sends to `canonicalize`, minus the two it can always read (sport, year). */
export type RecoverableField = "cardNumber" | "setName" | "parallel" | "printRun";

/** Where one recovered value came from, named precisely enough to audit. */
export interface FieldProvenance {
  field: RecoverableField;
  value: string | number;
  /** The holding property the evidence was read out of. */
  source: string;
  /** How it was read: an eBay aspect verbatim, or a parse of free text. */
  via: "aspect" | "title-parse" | "description-parse" | "vendor-suggestion";
}

export interface RecoveryInput {
  /** The stored holding, read-only. */
  holding: Record<string, unknown>;
}

export interface RecoveryResult {
  /** The five-axis question to ask the matcher, recovered fields merged in. */
  fields: {
    setName: string;
    cardNumber: string;
    parallel: string | null;
    printRun: number | null;
  };
  /** What was filled, and from where. Empty when the holding was already
   *  complete — the caller then asks exactly the question it would have. */
  recovered: FieldProvenance[];
  /** True when a human ruled on this identity. The caller must REPORT and
   *  never apply. */
  userAuthored: boolean;
  /** Why, when userAuthored. */
  userAuthoredBy: string | null;
  /** Axes still blank after recovery, named. A caller reporting UNVERIFIED
   *  says which fact it could not find rather than "no match". */
  stillMissing: RecoverableField[];
}

/** Blank means unknown: null, undefined, or whitespace. Never "Base" — that
 *  is a claim, and `contradictsBase` decides when the holding's own evidence
 *  overrides it. */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

/**
 * CF-USER-SET-FIELDS-WIN. A human ruling on an identity outranks every
 * inference in this file. Recovery on such a holding is computed and REPORTED
 * so the ruling can be revisited with the evidence in hand; it is never
 * written.
 *
 * `identityVerified` is deliberately NOT a marker here: the eBay importer and
 * portfolioStore's add-card path both stamp it automatically
 * (ebayBuyerHistory.service.ts:484, portfolioStore.service.ts:6881), so 77 of
 * 131 holdings carry it and it says nothing about who chose the identity.
 * What DOES mark authorship is a named ruling or an explicit user edit.
 */
export function userAuthoredIdentity(
  holding: Record<string, unknown>,
): { authored: boolean; by: string | null } {
  const resolvedBy = String(holding.identityResolvedBy ?? "").trim();
  if (/^ruling:/i.test(resolvedBy)) return { authored: true, by: resolvedBy };
  const verifiedBy = holding.identityVerifiedBy as Record<string, unknown> | string | null | undefined;
  if (verifiedBy && typeof verifiedBy === "object") {
    const via = String((verifiedBy as Record<string, unknown>).via ?? "");
    if (/^ruling:/i.test(via)) return { authored: true, by: via };
    const src = String((verifiedBy as Record<string, unknown>).source ?? "");
    if (/^user\b|^manual\b/i.test(src)) return { authored: true, by: src };
  } else if (typeof verifiedBy === "string" && /^user\b|^manual\b/i.test(verifiedBy)) {
    return { authored: true, by: verifiedBy };
  }
  if (holding.userEditedFields || holding.userEditedAt) {
    return { authored: true, by: "userEditedFields" };
  }
  return { authored: false, by: null };
}

/** Read an eBay aspect by any of several spellings, case-insensitively.
 *  eBay's aspect names are seller-chosen from a category vocabulary and drift
 *  ("Print Run" / "Printing Run"), so the lookup is tolerant of the NAME while
 *  taking the VALUE verbatim. */
function aspect(holding: Record<string, unknown>, ...names: string[]): { value: string; key: string } | null {
  const asp = holding.ebayItemAspects as Record<string, unknown> | undefined;
  if (!asp || typeof asp !== "object") return null;
  const lowered = new Map<string, [string, unknown]>();
  for (const [k, v] of Object.entries(asp)) lowered.set(k.trim().toLowerCase(), [k, v]);
  for (const n of names) {
    const hit = lowered.get(n.trim().toLowerCase());
    if (!hit) continue;
    const raw = String(hit[1] ?? "").trim();
    if (raw) return { value: raw, key: hit[0] };
  }
  return null;
}

/**
 * Does the holding's own evidence say this card is an INSERT, contradicting a
 * stored `parallel: "Base"`?
 *
 * Two independent witnesses, and either alone is enough because they are
 * seller-entered structured fields rather than inferences:
 *   - `Features` naming "Insert" (D24: "Serial Numbered, Insert"), or
 *   - a stated `Print Run` on a product whose base card is unnumbered.
 *
 * Deliberately NOT "the holding has an Insert Set aspect": 30 of the 31
 * holdings carrying that aspect use it for the autograph subset, and reading
 * it as a contradiction would unseat 25 correct parallels.
 */
export function evidenceContradictsBase(holding: Record<string, unknown>): boolean {
  const features = aspect(holding, "Features");
  if (features && /\binserts?\b/i.test(features.value)) return true;
  const printRun = aspect(holding, "Print Run", "Printing Run");
  if (printRun && Number(String(printRun.value).replace(/[^0-9]/g, "")) > 0) return true;
  return false;
}

/** Free text this holding carries about itself, most authoritative first.
 *  The purchase listing title is the seller's own words about the physical
 *  card; the short description repeats them at length. */
function evidenceText(holding: Record<string, unknown>): Array<{ text: string; source: string }> {
  const out: Array<{ text: string; source: string }> = [];
  for (const key of ["cardTitle", "purchaseTitle", "listingTitle", "ebayShortDescription", "notes"]) {
    const v = holding[key];
    if (typeof v === "string" && v.trim()) out.push({ text: v.trim(), source: key });
  }
  return out;
}

/**
 * Recover the blank axes of one holding's identity question from its own
 * evidence.
 *
 * Returns the question to ask, plus provenance for every value it filled.
 * Never mutates `holding`, never fills a field the holding already states
 * (except a `Base` parallel its own Features/Print Run contradict), and never
 * invents a value no evidence names.
 */
export function recoverHoldingFields({ holding }: RecoveryInput): RecoveryResult {
  const recovered: FieldProvenance[] = [];
  const authored = userAuthoredIdentity(holding);

  // ---- setName -----------------------------------------------------------
  // Production's precedence, unchanged: setName, then product
  // (CF-THE-REDERIVE-PASS-MUST-ASK-THE-WAY-PRODUCTION-ASKS).
  let setName = String(holding.setName ?? holding.product ?? "").trim();
  if (!setName) {
    const setAspect = aspect(holding, "Set", "Set Name");
    if (setAspect) {
      setName = setAspect.value;
      recovered.push({ field: "setName", value: setName, source: `ebayItemAspects["${setAspect.key}"]`, via: "aspect" });
    }
  }
  if (!setName) {
    // THE ONE VOCABULARY, AND ITS HONEST LIMIT. `inferSetKeyFromTitle` is the
    // repo's only reader of a product out of free text, so it is what recovery
    // asks — never a regex written here, which is how a second parser gets
    // born (feedback: holdingFieldNormalizer is THE standard).
    //
    // It returns "Unknown" when the text names no product it knows, and that
    // answer is TAKEN AS A REFUSAL rather than routed around. 277b05a3 is the
    // case that settles it: its description reads "...1997 Cal Ripken Jr -
    // Metal Universe - Magnetic Field - PSA 8", and the vocabulary reads that
    // as "Fleer Metal" — a real product, but not the `metal-universe` setKey
    // its checklist row is filed under. A recovery that guessed here would
    // pick a set name for a card it cannot identify.
    for (const { text, source } of evidenceText(holding)) {
      const inferred = String(inferSetKeyFromTitle(text, (holding.cardNumber as string) ?? null) ?? "").trim();
      if (inferred && !/^unknown$/i.test(inferred)) {
        setName = inferred;
        recovered.push({ field: "setName", value: setName, source, via: source === "ebayShortDescription" ? "description-parse" : "title-parse" });
        break;
      }
    }
  }
  // A VENDOR'S GUESS IS NOT EVIDENCE ABOUT THE CARD, and 277b05a3 is why this
  // is stated rather than assumed. Its `suggestionCandidate` reads
  // `{ set: "1997 Metal Universe Baseball", number: "8", variant: "Base" }`,
  // and consulting it for setName resolved the holding onto
  // `hiq:baseball:1997:metal-universe:8:base:no-auto` at exact/0.98 — the
  // seven-row pool #1774 proved is FOUR different cards, and the identity this
  // holding is being re-derived AWAY from. The suggestion is the vendor match
  // that mispriced the card; feeding it back in launders a wrong answer into a
  // confident one. So the vendor suggestion is never a witness for setName or
  // parallel — the axes that decide WHICH card this is.
  //
  // `suggestionCandidate.number` is different in kind and is consulted below:
  // a card number is a fact transcribed off the slab, not a judgement about
  // which product the card belongs to, and it is still gated by the catalog
  // read-back like every other recovered value.

  // ---- cardNumber --------------------------------------------------------
  let cardNumber = String(holding.cardNumber ?? "").trim();
  if (!cardNumber) {
    const cnAspect = aspect(holding, "Card Number", "Card #");
    if (cnAspect) {
      cardNumber = cnAspect.value;
      recovered.push({ field: "cardNumber", value: cardNumber, source: `ebayItemAspects["${cnAspect.key}"]`, via: "aspect" });
    }
  }
  if (!cardNumber) {
    // THE ONE PARSER. parseListingIdentity is what production reads titles
    // with; it knows the vertical rules that make `8/102` a Pokemon serial
    // and not a card number.
    for (const { text, source } of evidenceText(holding)) {
      const parsed = parseListingIdentity(text, undefined, {
        vertical: (holding.sport as string) ?? null,
        hobbyiqCardId: (holding.hobbyiqCardId as string) ?? null,
      });
      if (parsed.cardNumber) {
        cardNumber = parsed.cardNumber;
        recovered.push({ field: "cardNumber", value: cardNumber, source, via: source === "ebayShortDescription" ? "description-parse" : "title-parse" });
        break;
      }
    }
  }
  if (!cardNumber) {
    const cand = holding.suggestionCandidate as Record<string, unknown> | undefined;
    const candNum = cand && typeof cand === "object" ? String(cand.number ?? "").trim() : "";
    if (candNum) {
      cardNumber = candNum;
      recovered.push({ field: "cardNumber", value: cardNumber, source: "suggestionCandidate.number", via: "vendor-suggestion" });
    }
  }

  // ---- parallel ----------------------------------------------------------
  // The stored value wins unless it is blank, or it is "Base" and the
  // holding's OWN structured evidence says the card is a serial-numbered
  // insert. Nothing else unseats a stored parallel.
  const storedParallel = holding.parallel;
  let parallel: string | null = isBlank(storedParallel) ? null : String(storedParallel).trim();
  const parallelIsBase = parallel !== null && /^\[?base\]?$/i.test(parallel);
  if (parallel === null || (parallelIsBase && evidenceContradictsBase(holding))) {
    const insert = aspect(holding, "Insert Set", "Insert");
    if (insert) {
      parallel = insert.value;
      recovered.push({ field: "parallel", value: parallel, source: `ebayItemAspects["${insert.key}"]`, via: "aspect" });
    } else {
      // No aspect names it — read the seller's text through the one parser.
      // It returns "Base" when the title names no finish, which is not a
      // recovery, so only a non-Base answer is taken.
      for (const { text, source } of evidenceText(holding)) {
        const parsed = parseListingIdentity(text, undefined, {
          vertical: (holding.sport as string) ?? null,
          hobbyiqCardId: (holding.hobbyiqCardId as string) ?? null,
        });
        if (parsed.parallel && !/^base$/i.test(parsed.parallel)) {
          parallel = parsed.parallel;
          recovered.push({ field: "parallel", value: parallel, source, via: source === "ebayShortDescription" ? "description-parse" : "title-parse" });
          break;
        }
      }
    }
  }

  // ---- printRun ----------------------------------------------------------
  let printRun: number | null = typeof holding.printRun === "number" ? holding.printRun : null;
  if (printRun === null) {
    const prAspect = aspect(holding, "Print Run", "Printing Run");
    const n = prAspect ? Number(String(prAspect.value).replace(/[^0-9]/g, "")) : NaN;
    if (Number.isFinite(n) && n > 0) {
      printRun = n;
      recovered.push({ field: "printRun", value: n, source: `ebayItemAspects["${prAspect!.key}"]`, via: "aspect" });
    }
  }
  if (printRun === null) {
    for (const { text, source } of evidenceText(holding)) {
      const parsed = parseListingIdentity(text, undefined, {
        vertical: (holding.sport as string) ?? null,
        hobbyiqCardId: (holding.hobbyiqCardId as string) ?? null,
      });
      if (typeof parsed.printRun === "number" && parsed.printRun > 0) {
        printRun = parsed.printRun;
        recovered.push({ field: "printRun", value: printRun, source, via: source === "ebayShortDescription" ? "description-parse" : "title-parse" });
        break;
      }
    }
  }

  // ---- through THE normalizer -------------------------------------------
  // holdingFieldNormalizer is the standard for messy-import cleaning
  // (feedback_use_normalized_fields_for_ref_lookups). Recovered strings are
  // exactly as messy as imported ones — "1999 Upper Deck Black Diamond"
  // carries a duplicated year — so they go through it before the matcher, and
  // so do the stored ones, which is what production already does.
  const normalized = normalizeHoldingFields({
    playerName: (holding.playerName as string) ?? null,
    cardYear: (holding.cardYear as number) ?? null,
    setName: setName || null,
    parallel,
    cardNumber: cardNumber || null,
    isAuto: (holding.isAuto as boolean) ?? null,
    product: (holding.product as string) ?? null,
  });

  const finalSetName = String(normalized.fields.setName ?? setName ?? "").trim();
  const finalCardNumber = String(normalized.fields.cardNumber ?? cardNumber ?? "").trim();
  const finalParallel = isBlank(normalized.fields.parallel) ? null : String(normalized.fields.parallel).trim();

  const stillMissing: RecoverableField[] = [];
  if (!finalSetName) stillMissing.push("setName");
  if (!finalCardNumber) stillMissing.push("cardNumber");

  return {
    fields: { setName: finalSetName, cardNumber: finalCardNumber, parallel: finalParallel, printRun },
    recovered,
    userAuthored: authored.authored,
    userAuthoredBy: authored.by,
    stillMissing,
  };
}
