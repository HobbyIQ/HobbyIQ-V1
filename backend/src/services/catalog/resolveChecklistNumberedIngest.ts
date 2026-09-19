/**
 * CF-AN-INGEST-TWIN-NEVER-OUTLIVES-ITS-FOLD (2026-09-19).
 *
 * The fold lane (fold-checklist-numbered-twins.cjs, R1 --
 * CF-A-CHECKLIST-NUMBERED-ROW-IS-THE-IDENTITY) deletes the un-numbered twin
 * once its sales are re-pointed onto the checklist's `:num-NNN` row. But a
 * sale title usually does not STATE the print run, so the very next sale of
 * that same card derives the SAME short slug the fold just retired -- and one
 * of two things happens: `ensureCatalogRow`'s USER_SEED_SOURCES caller
 * re-mints the twin from scratch (a fresh row for a card the checklist
 * already names), or the sale sits on an id with no catalog row at all.
 * Measured: 10 of 22 "became not-clean" rows in a dated sample were exactly
 * this shape -- a fold with no ingest-side follow-through.
 *
 * `ensureCatalogRow` already has HALF the fix (CF-PREFER-THE-CHECKLIST-ROW-
 * OVER-MINTING): it asks `resolveIdentityToCatalogRow` before minting, so it
 * will not seed a SECOND row once the sale's own slug already resolves to a
 * numbered twin. What was missing is upstream of that: nothing upgraded the
 * SALE's own `hobbyiqCardId` from the short derived slug to the checklist's
 * numbered row in the first place, so the sale still writes short, still
 * mismatches the identity `ensureCatalogRow` declines to duplicate, and the
 * pool still splits.
 *
 * WHY NOT `catalogIdentityResolver.resolveIdentityToCatalogRow` DIRECTLY. That
 * module answers "which row does THIS LITERAL id resolve to" via a point read
 * plus a STARTSWITH stem query on the id STRING. R1's own docstring names the
 * exact case that breaks a literal-id lookup: the checklist row is spelled
 * `…:cpa-mh:base-refractor:auto:num-499` while the sale-minted twin (and a
 * freshly derived slug) reads `…:cpa-mh:refractor:auto` -- `base-refractor`
 * and `refractor` never meet as strings, so a STARTSWITH stem query for
 * `<derived>:num-` finds nothing even though the checklist HAS the card
 * numbered. `resolveIdentityToCatalogRow` is also unsafe here for a second
 * reason: when the caller passes a printRun that names no row, it falls
 * through to the stem lookup and can still resolve onto a DIFFERENT print
 * run's twin -- exactly the "title states a disagreeing /N" case this module
 * must leave alone.
 *
 * So this module queries by the identity FIELDS (sport, year, setKey,
 * cardNumber, isAuto) -- the same shape catalogMatcher's printRun/parallel
 * step and the fold script's pass 1 already use -- and hands the rows to
 * `identityKeyOf` / `pickChecklistNumberedTarget`
 * (foldTwinRuleChecklistNumbered.ts), the SAME functions the fold lane's own
 * authority gate is built from. One rule, read at fold time and at ingest
 * time, never a second copy.
 *
 * THE RULE, deliberately narrower than the fold's: this only ever ADDS a
 * `:num-N` the checklist states onto a slug that does not carry one of its
 * own.
 *   - the derived slug already carries `:num-N` (the title/vendor stated a
 *     print run) -> untouched, always. Absent beats wrong: a title that named
 *     a print run gets to keep the one it named even when it disagrees with
 *     the checklist's, because "wrong" is a worse failure than "unfolded".
 *   - the catalog holds no checklist-authority row on this exact identity
 *     with a print run -> untouched (`pickChecklistNumberedTarget` "no
 *     checklist-numbered").
 *   - two checklist rows disagree on the print run -> untouched ("ambiguous";
 *     a ruling, never a guess).
 *   - exactly one checklist-authority print run on this identity -> the sale
 *     adopts that row's id.
 *
 * BOUNDED, CACHED, FAILS OPEN. One query per (sport, year, setKey,
 * cardNumber, isAuto) per batch -- memoized in a Map the caller owns and
 * passes in, the same per-batch-cache shape resolveProductByChecklist.ts
 * uses (newResolveCache) and the R29 call site already threads through. Any
 * failure -- no connection string, a throttle, a malformed row -- returns
 * null and the caller's derived slug stands; this is an upgrade, never a
 * gate the write can fail behind.
 */

import type { Container } from "@azure/cosmos";
import { cardNumberInClause } from "../portfolioiq/hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "./catalogAuthority.service.js";
import {
  identityKeyOf,
  pickChecklistNumberedTarget,
  DEFAULT_FORCE_AUTO_PREFIXES,
  type IdentityRow,
} from "./foldTwinRuleChecklistNumbered.js";

/** One catalog row as the identity query returns it. */
interface CatalogFieldRow {
  id: string;
  source?: string | null;
  setKey?: string | null;
  parallelSlug?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
}

/** Per-batch cache: one query per identity, shared by every call in a run. */
export type NumberedIngestCache = Map<string, string | null>;

export function newNumberedIngestCache(): NumberedIngestCache {
  return new Map();
}

const isChecklist = (source: string | null | undefined): boolean => catalogAuthorityOf(source) === "checklist";

export interface NumberedIngestUpgradeInput {
  /** The slug ingest just derived, before this upgrade. */
  slug: string;
  sport: string;
  year: number;
  /** The setKey FIELD candidate ids will be queried against -- the same
   *  resolved setKey the slug's own segment 3 carries (identityKeyOf reads
   *  the field, never the id segment, so this must be the field, too). */
  setKey: string;
  cardNumber: string;
  parallelSlug: string | null | undefined;
  isAuto: boolean;
  /** The print run the TITLE or vendor stated, if any. Non-null here means
   *  `slug` already carries `:num-N` of its own -- see the guard below. */
  printRun?: number | null;
}

/** True when `slug`'s own trailing segment is `:num-<digits>`. */
function slugHasPrintRun(slug: string): boolean {
  return /:num-\d+$/.test(String(slug ?? ""));
}

/**
 * Does the catalog hold exactly one checklist-numbered row for this card's
 * identity? Returns that row's id, or null when the slug should stand as
 * derived (no such row, an ambiguous ladder, or any failure).
 *
 * Never called when the derived slug already carries its own `:num-N` --
 * that is a title-stated print run, and a stated run beats a checklist run
 * it disagrees with (absent beats wrong). Callers gate on that before
 * calling this, and this function re-checks it itself as the belt to that
 * brace.
 */
export async function resolveChecklistNumberedIngestId(
  input: NumberedIngestUpgradeInput,
  opts: { container: Container | null; cache: NumberedIngestCache },
): Promise<string | null> {
  try {
    if (slugHasPrintRun(input.slug)) return null;
    const { container, cache } = opts;
    if (!container) return null;
    if (!input.sport || !input.year || !input.setKey || !input.cardNumber) return null;

    const derivedRow: IdentityRow = {
      id: input.slug,
      source: null,
      sport: input.sport,
      year: input.year,
      setKey: input.setKey,
      cardNumber: input.cardNumber,
      parallelSlug: input.parallelSlug ?? null,
      isAuto: input.isAuto,
      printRun: null,
    };
    const wantKey = identityKeyOf(derivedRow, DEFAULT_FORCE_AUTO_PREFIXES);

    const cached = cache.get(wantKey);
    if (cached !== undefined) return cached;

    const num = cardNumberInClause(input.cardNumber);
    const { resources } = await container.items
      .query<CatalogFieldRow>({
        query:
          `SELECT c.id, c.source, c.setKey, c.parallelSlug, c.isAuto, c.printRun FROM c ` +
          `WHERE c.sport = @s AND c.year = @y AND c.cardNumber IN (${num.sql}) AND c.isAuto = @a`,
        parameters: [
          { name: "@s", value: input.sport },
          { name: "@y", value: input.year },
          ...num.params,
          { name: "@a", value: input.isAuto },
        ],
      })
      .fetchAll();

    const rows: IdentityRow[] = (resources ?? [])
      .filter((r): r is CatalogFieldRow => typeof r?.id === "string" && r.id.startsWith("hiq:"))
      .map((r) => ({
        id: r.id,
        source: r.source ?? null,
        sport: input.sport,
        year: input.year,
        setKey: r.setKey ?? null,
        cardNumber: input.cardNumber,
        parallelSlug: r.parallelSlug ?? null,
        isAuto: r.isAuto ?? null,
        printRun: r.printRun ?? null,
      }))
      .filter((r) => identityKeyOf(r, DEFAULT_FORCE_AUTO_PREFIXES) === wantKey);

    const picked = pickChecklistNumberedTarget(rows, isChecklist);
    const resolvedId = "target" in picked ? picked.target.id : null;

    cache.set(wantKey, resolvedId);
    return resolvedId;
  } catch {
    // Fail open: the sale's derived slug stands, exactly as it would have
    // before this upgrade existed. A catalog blip must never block a write.
    return null;
  }
}
