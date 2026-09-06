// CF-IMPORT-RESOLVES-TO-CHECKLIST (D12-b, 2026-08-29). The spreadsheet
// import's resolver.
//
// Until now every non-round-trip row went through catalogSource's
// resolveCardId -- a Wave-3b removal STUB that answers {cardId: null} for
// every input -- so the whole arbitrary-sheet population landed in
// `unresolved` under a message blaming a "Cardsight catalog entry" no code had
// asked for, while the round-trip lane persisted whatever string sat in the
// cardId cell as the holding's identity, unvalidated.
//
// This resolver asks OUR catalog, the way add-card and the eBay import do:
//   1. a round-trip `hiq:` slug is accepted only when it names a row we hold
//      (point read); any other cell content is a HINT, never an identity;
//   2. the row's fields go through holdingFieldNormalizer (the standard), the
//      print run is split out of the parallel / serial text, the sport is
//      taken from the sheet or inferred from the product;
//   3. the ONE derivation the eBay import runs (identityFromFields: a missing
//      number asked of the catalog by player, never an empty number, the
//      matcher asked with the parallel + print run + player) with source
//      "import" -- a source the matcher never seeds from, because a
//      spreadsheet is unverified text.
//
// Internal catalog only. Never a vendor call.

import type { CatalogMatchResult } from "../../catalog/catalogMatcher.service.js";
import {
  resolveIdentityFromFields as resolveIdentityFromFieldsReal,
  clearsIdentityBar,
  type IdentityFields,
  type IdentityFromFields,
} from "../identityFromFields.js";
import { getCatalogEntry as getCatalogEntryReal, type CardCatalogEntry } from "../cardCatalog.service.js";
import { normalizeHoldingFields } from "../holdingFieldNormalizer.service.js";
import { extractPrintRunFromTitle, inferSportFromContext } from "../soldCompsStore.service.js";
import { normalizeSportStrict } from "../slugGuard.service.js";
import { parseHobbyIqCardId } from "../hobbyIqCardId.service.js";

export interface ImportResolveInput {
  /** Explicit sport column (Card Ladder's "Category"). Optional. */
  sport?: string | null;
  cardYear?: number | null;
  product?: string | null;
  setName?: string | null;
  cardTitle?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  variation?: string | null;
  serialNumber?: string | null;
  isAuto?: boolean | null;
  playerName?: string | null;
  /** An `hiq:` slug from a round-trip cell (cardId / hobbyiqCardId). Anything
   *  that is not an `hiq:` slug must not be passed here -- it is a hint. */
  roundTripSlug?: string | null;
}

export type ImportMatchedBy = CatalogMatchResult["matchedBy"] | "round-trip";

export type ImportUnresolvedReason =
  | "no-year"
  | "no-set"
  | "no-card-number"
  | "card-number-ambiguous"
  | "sport-ambiguous"
  | "sport-unknown"
  | "not-in-catalog";

export interface ImportResolution {
  /** The canonical slug the row resolves to. When `found` is false this is
   *  the slug the row WOULD have (the acquisition-feed signal), or null when
   *  there was not enough identity to compute one. */
  slug: string | null;
  found: boolean;
  /** 0-1. A round-trip slug that exists in the catalog is 1. */
  confidence: number;
  matchedBy: ImportMatchedBy;
  /** Print run from the resolution: the matched slug's :num-N segment when
   *  present, else what the row's serial / parallel / title said. */
  printRun: number | null;
  sport: string | null;
  catalogId?: string;
  /** Set when the row could not be placed; says why. */
  reason?: ImportUnresolvedReason;
  /** Candidates when the catalog holds several answers and picking one would
   *  attach the holding to the wrong card. */
  ambiguous?: { cardNumbers?: string[]; sports?: string[] };
  /** A round-trip `hiq:` slug that named no catalog row. Refused as identity;
   *  the row was resolved from its fields instead. */
  rejectedRoundTrip?: string | null;
  /** Identity fields of the catalog row a round-trip slug named. */
  catalog?: {
    playerName: string | null;
    setKey: string | null;
    cardNumber: string | null;
    parallel: string | null;
    isAuto: boolean | null;
  };
}

export type ImportResolver = (input: ImportResolveInput) => Promise<ImportResolution>;

/** Injection seam for tests -- every I/O this resolver performs. */
export interface ImportResolverDeps {
  resolveIdentityFromFields: (f: IdentityFields) => Promise<IdentityFromFields>;
  getCatalogEntry: (slug: string) => Promise<CardCatalogEntry | null>;
}

const DEFAULT_DEPS: ImportResolverDeps = {
  resolveIdentityFromFields: (f) => resolveIdentityFromFieldsReal(f),
  getCatalogEntry: getCatalogEntryReal,
};

/**
 * When neither the sheet nor the product names a sport, the slug namespace is
 * unknown and the catalog is asked once per major sport. Exactly one confident
 * hit is adopted; several is `ambiguous` (a Prizm #1 exists in more than one
 * sport, and only the person holding it knows which); none falls through to
 * the best available suggestion. The matcher caches these, so a sheet that
 * repeats a product pays for the probe once.
 */
const SPORT_PROBE_ORDER: ReadonlyArray<string> = ["baseball", "football", "basketball", "hockey"];

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

function toYear(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 1800 && n < 2200 ? Math.trunc(n) : null;
}

/** `hiq:` slugs only; anything else is not an identity. */
export function asHiqSlug(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.startsWith("hiq:") && parseHobbyIqCardId(s) !== null ? s : null;
}

/** "12/50", "12 of 50", "/50" -> 50. A bare number is a serial position or a
 *  print run and nobody can tell which, so it is left alone. */
export function printRunFromSerial(serial: unknown): number | null {
  const s = String(serial ?? "").trim();
  if (!s) return null;
  const numbered = s.match(/^(\d+)\s*(?:\/|of)\s*(\d{1,5})$/i);
  if (numbered) return numOrNull(Number(numbered[2]));
  const bare = s.match(/^\/\s*(\d{1,5})$/);
  if (bare) return numOrNull(Number(bare[1]));
  return null;
}

/** "Gold Refractor /50" -> { parallel: "Gold Refractor", printRun: 50 }. The
 *  slug generator would otherwise fold the "/50" INTO the parallel segment
 *  (gold-refractor-50) instead of the :num-50 segment. */
export function splitPrintRunFromParallel(parallel: unknown): { parallel: string | null; printRun: number | null } {
  const p = str(parallel);
  if (!p) return { parallel: null, printRun: null };
  const printRun = extractPrintRunFromTitle(p);
  if (printRun === null) return { parallel: p, printRun: null };
  const stripped = p.replace(/(^|[^0-9/])\/\s*\d{1,5}(?=[^0-9]|$)/, "$1").replace(/\s{2,}/g, " ").trim();
  return { parallel: stripped || null, printRun };
}

/** "#CPA-MG" / "No. 12" -> "CPA-MG" / "12". The matcher's queries compare the
 *  card number exactly (uppercased); a leading marker would never match. */
export function cleanCardNumber(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.replace(/^(?:#|no\.?\s*)\s*/i, "").trim() || null;
}

export async function resolveImportRow(
  input: ImportResolveInput,
  deps: ImportResolverDeps = DEFAULT_DEPS,
): Promise<ImportResolution> {
  // ── 1. Round-trip slug: an identity only when the catalog holds it ─────
  const roundTrip = asHiqSlug(input.roundTripSlug);
  let rejectedRoundTrip: string | null = null;
  if (roundTrip) {
    const row = await deps.getCatalogEntry(roundTrip);
    if (row) {
      const parsed = parseHobbyIqCardId(roundTrip);
      return {
        slug: roundTrip,
        found: true,
        confidence: 1,
        matchedBy: "round-trip",
        printRun: numOrNull(row.printRun) ?? parsed?.printRun ?? null,
        sport: str(row.sport) ?? parsed?.sport ?? null,
        catalogId: row.id,
        catalog: {
          playerName: str(row.playerName),
          setKey: str(row.setKey),
          cardNumber: str(row.cardNumber),
          parallel: str(row.parallel),
          isAuto: typeof row.isAuto === "boolean" ? row.isAuto : null,
        },
      };
    }
    rejectedRoundTrip = roundTrip;
  }

  // ── 2. The row's fields, through the one cleaning standard ─────────────
  const norm = normalizeHoldingFields({
    playerName: input.playerName ?? null,
    cardYear: input.cardYear ?? null,
    setName: str(input.setName) ?? str(input.product),
    product: input.product ?? null,
    parallel: str(input.parallel) ?? str(input.variation),
    cardNumber: input.cardNumber ?? null,
    isAuto: input.isAuto ?? null,
  }).fields;

  const year = toYear(norm.cardYear);
  const setName = str(norm.setName) ?? str(norm.product);
  const player = str(norm.playerName);
  const isAuto = norm.isAuto === true;
  // THE NORMALIZER ALREADY SPLIT THIS, so read its answer rather than redoing
  // the work (CF-A-PARALLEL-FIELD-HOLDS-ONLY-THE-PARALLEL, 2026-09-05).
  // `normalizeHoldingFields` moves a "/50" out of the parallel and onto
  // `printRun` for every caller, which is what makes the split ONE rule
  // instead of one-per-importer. `splitPrintRunFromParallel` stays as the
  // fallback for the shapes the normalizer declines — a bare serial the
  // normalizer leaves whole, say — and for callers that reach it directly.
  const split = splitPrintRunFromParallel(norm.parallel);
  const parallel = split.parallel;
  const printRun =
    printRunFromSerial(input.serialNumber)
    ?? (typeof norm.printRun === "number" ? norm.printRun : null)
    ?? split.printRun
    ?? extractPrintRunFromTitle(input.cardTitle);
  const cardNumber = cleanCardNumber(norm.cardNumber);
  const explicitSport = normalizeSportStrict(input.sport);
  const sport = explicitSport ?? inferSportFromContext(setName, input.cardTitle, year);

  const unresolved = (reason: ImportUnresolvedReason, extra: Partial<ImportResolution> = {}): ImportResolution => ({
    slug: null,
    found: false,
    confidence: 0,
    matchedBy: "not-found",
    printRun,
    sport,
    reason,
    rejectedRoundTrip,
    ...extra,
  });

  const fieldsFor = (s: string): IdentityFields => ({
    sport: s,
    year,
    setName,
    player,
    cardNumber,
    parallel,
    isAuto,
    printRun,
    source: "import",
  });

  // ── 3. The one derivation, read back as a resolution ───────────────────
  const fromDerivation = (d: IdentityFromFields, s: string): ImportResolution => {
    if (!d.match) {
      if (d.skippedReason === "no-card-number" && d.cardNumberCandidates.length > 1) {
        return unresolved("card-number-ambiguous", { ambiguous: { cardNumbers: d.cardNumberCandidates } });
      }
      return unresolved(d.skippedReason ?? "not-in-catalog");
    }
    const r = d.match;
    return {
      slug: r.slug ?? null,
      found: r.found,
      confidence: r.confidence ?? 0,
      matchedBy: r.matchedBy,
      // The matched row's print run is the resolution's; the row's text is
      // the fallback when the slug carries none.
      printRun: (r.found ? parseHobbyIqCardId(r.slug)?.printRun : null) ?? printRun,
      sport: s,
      ...(r.catalogId ? { catalogId: r.catalogId } : {}),
      ...(r.found ? {} : { reason: "not-in-catalog" as const }),
      rejectedRoundTrip,
    };
  };

  if (sport) return fromDerivation(await deps.resolveIdentityFromFields(fieldsFor(sport)), sport);

  // ── 4. Sport unknown: probe, require exactly one confident answer ──────
  const firstSport = SPORT_PROBE_ORDER[0]!;
  const first = await deps.resolveIdentityFromFields(fieldsFor(firstSport));
  // A skipped derivation (no number / year / set) is the same in every sport.
  if (!first.match) return fromDerivation(first, firstSport);
  const rest = await Promise.all(SPORT_PROBE_ORDER.slice(1).map(async (s) => ({
    s,
    // The number is settled by the first probe; the other namespaces are
    // asked with it rather than repeating the by-player lookup.
    d: await deps.resolveIdentityFromFields({ ...fieldsFor(s), cardNumber: first.cardNumber }),
  })));
  const probes = [{ s: firstSport, d: first }, ...rest].filter((p) => p.d.match !== null);
  const confident = probes.filter((p) => clearsIdentityBar(p.d.match));
  if (confident.length === 1) return fromDerivation(confident[0]!.d, confident[0]!.s);
  if (confident.length > 1) {
    return unresolved("sport-ambiguous", { ambiguous: { sports: confident.map((p) => p.s) } });
  }
  const best = probes
    .filter((p) => p.d.match!.found)
    .sort((a, b) => (b.d.match!.confidence ?? 0) - (a.d.match!.confidence ?? 0))[0];
  if (best) return fromDerivation(best.d, best.s);
  return unresolved("sport-unknown");
}
