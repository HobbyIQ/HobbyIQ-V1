/**
 * CF-AN-INGEST-TWIN-NEVER-OUTLIVES-ITS-FOLD (2026-09-19, revised after the
 * #2221/#2226 incident review).
 *
 * The fold lane (fold-checklist-numbered-twins.cjs, R1 --
 * CF-A-CHECKLIST-NUMBERED-ROW-IS-THE-IDENTITY) deletes the un-numbered twin
 * once its sales are re-pointed onto the checklist's `:num-NNN` row. But a
 * sale title usually does not STATE the print run, so the very next sale of
 * that same card derives the SAME short slug the fold just retired -- and one
 * of two things happens: `ensureCatalogRow`'s USER_SEED_SOURCES caller
 * re-mints the twin from scratch, or the sale sits on an id with no catalog
 * row. Measured: 10 of 22 "became not-clean" rows in a dated sample were
 * exactly this shape.
 *
 * WHY NOT `catalogIdentityResolver.resolveIdentityToCatalogRow` DIRECTLY. That
 * module resolves a LITERAL id via point read + STARTSWITH stem query. R1's
 * own docstring names the exact case that breaks it: the checklist row is
 * spelled `…:cpa-mh:base-refractor:auto:num-499` while a freshly derived slug
 * reads `…:cpa-mh:refractor:auto` -- the strings never meet. It is also unsafe
 * for "the title stated a disagreeing /N": when a caller's printRun names no
 * row it falls through to the stem lookup and can still adopt a DIFFERENT
 * print run's twin. So this module queries by identity FIELDS and hands the
 * rows to `identityKeyOf` / `pickChecklistNumberedTarget`
 * (foldTwinRuleChecklistNumbered.ts) -- the fold lane's own authority gate,
 * reused rather than reimplemented.
 *
 * ── THE #2221/#2226 LESSON, APPLIED HERE (2026-09-19 review) ────────────────
 *
 * #2221 measured the EXACT incident shape this module repeats if left
 * unbounded: `persistVendorSalesToPool`'s `checklistNarrow` issued TWO
 * card_catalog queries PER SALE, no `abortSignal`, no cap -- and one TCA
 * webhook request issued 3,820,650 of them over 370 minutes, 92% failing at
 * the SDK's 60 s default. `docs/cosmos-60s-callsites-2026-09-16.md` confirms
 * card_catalog partitions on `/cardId`; this module's query (sport, year,
 * cardNumber, isAuto) touches none of that key, so it is CROSS-PARTITION, the
 * same shape that saturated the container. Adding a second, independent
 * timeout/breaker here would be the "second implementation" CF-ONE-RULE
 * discipline exists to prevent -- and would leave #2221's breaker blind to
 * this module's own failures, since a container that stops answering
 * checklistNarrow stops answering this query too.
 *
 * So this module does NOT call `container.items.query(...).fetchAll()`
 * itself. It takes a `runQuery` from the caller -- `persistVendorSalesToPool`
 * wires in ITS OWN exported `narrowQuery` (the same function that feeds the
 * shared breaker `withNarrowBreaker` opens) plus the SAME
 * `NARROW_QUERY_TIMEOUT_MS` (8 s) `abortSignal`, and checks
 * `narrowBreakerIsOpen()` before ever calling in. One breaker, one timeout
 * constant, fed by every per-sale card_catalog narrow in this file's incident
 * class -- checklistNarrow's two queries and this module's one.
 *
 * `soldCompsStore.recordSoldComp` is not behind the webhook's detached batch
 * loop, but two of its OTHER callers are batch backfills
 * (chHistoricalBackfill.service.ts, historicalBackfill.service.ts) that can
 * loop over many rows exactly like the webhook did, so it wires in the SAME
 * `narrowQuery` / `narrowBreakerIsOpen` from persistVendorSalesToPool.service.ts
 * rather than a recordSoldComp-local copy -- one breaker shared by both
 * writers, matching "no second implementation."
 *
 * ── CACHING: MADE TO DO REAL WORK ────────────────────────────────────────────
 *
 * Keyed on the identity (sport|year|setKey|cardNumber|cleaned-parallel|auto),
 * via `identityKeyOf` -- the SAME key the fold script groups on, so two sales
 * of the same card always hit the same cache slot regardless of spelling
 * drift. NEGATIVE answers (null) are cached too: a batch of 500 sales across
 * 40 distinct cards issues at most 40 queries, not 500, whether the card is
 * numbered or not.
 *
 * `persistVendorSalesToPool` passes a batch-scoped cache (created once
 * outside its row loop, exactly like its own `productResolveCache` --
 * `persistVendorSalesToPool.service.ts:1072` -- "a batch is overwhelmingly
 * repeats, sharing the cache is what keeps this a few hundred indexed reads
 * instead of one per row"). `recordSoldComp` is not itself a batch loop (one
 * call = one sale), so it needs a cache that survives ACROSS calls to do any
 * real work; it uses a small module-level bounded cache with a TTL --
 * `ensureCatalogRow.service.ts`'s `KNOWN_SLUGS` (size-bounded, oldest-evict)
 * is the existing precedent for a module-level ingest-path cache in this
 * exact neighbourhood, and `priceSanityGate.service.ts`'s 15-min TTL is the
 * existing precedent for how long an ingest-path catalog answer is allowed to
 * go stale. This module borrows both shapes rather than inventing a third.
 *
 * ── SKIPPED ENTIRELY WHEN IT CANNOT HELP ─────────────────────────────────────
 *
 *   - the derived slug already carries `:num-N` (title/vendor stated a run --
 *     absent beats wrong, so a disagreeing checklist run never overrides it);
 *   - sport is "pokemon" (Pokemon numbering is checklist-width driven, a
 *     different mechanism entirely -- pokemonCardNumber.ts -- and this
 *     module's identity shape does not apply);
 *   - no cardNumber (nothing to query on);
 *   - setKey is the literal sentinel "unknown" (resolveSetKeyForSlug's
 *     fallback when the parser could not resolve a real product -- querying
 *     card_catalog for setKey "unknown" cards would match unrelated
 *     identity-collapsed rows across products, never a real narrowing).
 *
 * None of these gates cost a query; they run before the cache lookup, before
 * the breaker check, before anything that could touch Cosmos.
 *
 * BOUNDED, CACHED, FAILS OPEN throughout: any failure -- no connection
 * string, breaker open, a timeout, a malformed row -- returns null and the
 * caller's derived slug stands. This is an upgrade, never a gate the write
 * can fail behind.
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

/** Per-batch cache: one query per identity, shared by every call in a run.
 *  `undefined` = never asked; `null` = asked and negative (cached too, so a
 *  card with no checklist-numbered row is not re-queried on its next sale in
 *  the same batch). */
export type NumberedIngestCache = Map<string, string | null>;

export function newNumberedIngestCache(): NumberedIngestCache {
  return new Map();
}

// ── module-level bounded cache for callers that are NOT themselves a batch
// loop (recordSoldComp: one call = one sale). Same shape as
// ensureCatalogRow.service.ts's KNOWN_SLUGS (size-bounded, oldest-evict) +
// priceSanityGate.service.ts's 15-min TTL -- both existing ingest-path
// precedents, not a new pattern.
const PROCESS_CACHE_TTL_MS = 15 * 60_000;
const PROCESS_CACHE_MAX = 5_000;
const _processCache = new Map<string, { value: string | null; expiresAt: number }>();

function processCacheGet(key: string, now: number): string | null | undefined {
  const e = _processCache.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= now) { _processCache.delete(key); return undefined; }
  return e.value;
}

function processCacheSet(key: string, value: string | null, now: number): void {
  if (_processCache.has(key)) _processCache.delete(key);
  while (_processCache.size >= PROCESS_CACHE_MAX) {
    const oldest = _processCache.keys().next().value;
    if (oldest === undefined) break;
    _processCache.delete(oldest);
  }
  _processCache.set(key, { value, expiresAt: now + PROCESS_CACHE_TTL_MS });
}

export function _clearProcessCacheForTests(): void {
  _processCache.clear();
}

const isChecklist = (source: string | null | undefined): boolean => catalogAuthorityOf(source) === "checklist";

/** See the query's own comment at the call site for the full justification:
 *  the largest hardcoded ladder (parallelLadders.ts) is 26 rungs; this
 *  query's own filter shape (sport, year, setKey, cardNumber, isAuto) minus
 *  the grade axis has run at TOP 300 in catalogMatcher.service.ts since
 *  2026-08-14. 100 is comfortably above the real ladder while excluding
 *  graded children that query does not. Exported so a test can assert
 *  against it rather than a repeated literal. */
export const RESULT_CAP = 100;

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

export interface NumberedIngestUpgradeOpts {
  container: Container | null;
  /** Per-batch cache (persistVendorSalesToPool) OR omit to use the
   *  module-level bounded/TTL cache (recordSoldComp -- see header). */
  cache?: NumberedIngestCache;
  /**
   * Runs the query with THIS caller's own bound. `persistVendorSalesToPool`
   * and `recordSoldComp` both pass persistVendorSalesToPool's exported
   * `narrowQuery`, which feeds the ONE shared card_catalog narrow breaker
   * (#2221) rather than a second implementation. Defaults to a plain
   * `fetchAll()` with no bound, which only test callers should rely on.
   */
  runQuery?: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * The FeedOptions merged onto the actual `.query()` call -- this is what
   * carries the `abortSignal` to the Cosmos SDK itself (a `runQuery` wrapper
   * alone only races a promise; the underlying HTTP call keeps running and
   * keeps holding a connection against a container that is already under
   * pressure, which is the exact defect #2221 fixed by putting the signal on
   * the SDK call, not around it). Both writers pass
   * `{ abortSignal: AbortSignal.timeout(NARROW_QUERY_TIMEOUT_MS) }` --
   * persistVendorSalesToPool's own exported constant, so this module's
   * queries time out on the SAME clock as checklistNarrow's. */
  queryOptions?: { abortSignal?: AbortSignal; maxItemCount?: number };
  /** True when the shared breaker is already open -- checked BEFORE issuing
   *  anything, so an open breaker costs this module exactly zero queries,
   *  same as it costs checklistNarrow zero. Defaults to "never open" for
   *  callers (tests) that have no breaker at all. */
  breakerIsOpen?: () => boolean;
  /** Bumps the shared breaker's skip counter when this module declines a
   *  query because the breaker was open, so `withNarrowBreaker`'s own
   *  summary log reflects every caller that honoured it. No-op by default. */
  recordSkip?: () => void;
}

/** True when `slug`'s own trailing segment is `:num-<digits>`. */
function slugHasPrintRun(slug: string): boolean {
  return /:num-\d+$/.test(String(slug ?? ""));
}

/**
 * Does the catalog hold exactly one checklist-numbered row for this card's
 * identity? Returns that row's id, or null when the slug should stand as
 * derived (no such row, an ambiguous ladder, a skip gate, an open breaker, a
 * timeout, or any other failure).
 */
export async function resolveChecklistNumberedIngestId(
  input: NumberedIngestUpgradeInput,
  opts: NumberedIngestUpgradeOpts,
): Promise<string | null> {
  // ── skip gates: cost ZERO queries, checked before the cache and the
  // breaker so an unresolvable case never even reaches Cosmos. ─────────────
  if (slugHasPrintRun(input.slug)) return null;
  if (String(input.sport ?? "").trim().toLowerCase() === "pokemon") return null;
  if (!input.cardNumber || !String(input.cardNumber).trim()) return null;
  const setKey = String(input.setKey ?? "").trim();
  if (!setKey || setKey.toLowerCase() === "unknown") return null;
  if (!input.sport || !input.year) return null;

  const derivedRow: IdentityRow = {
    id: input.slug,
    source: null,
    sport: input.sport,
    year: input.year,
    setKey,
    cardNumber: input.cardNumber,
    parallelSlug: input.parallelSlug ?? null,
    isAuto: input.isAuto,
    printRun: null,
  };
  const wantKey = identityKeyOf(derivedRow, DEFAULT_FORCE_AUTO_PREFIXES);

  const now = Date.now();
  const batchCache = opts.cache;
  if (batchCache) {
    const cached = batchCache.get(wantKey);
    if (cached !== undefined) return cached;
  } else {
    const cached = processCacheGet(wantKey, now);
    if (cached !== undefined) return cached;
  }

  const setCached = (value: string | null): void => {
    if (batchCache) batchCache.set(wantKey, value);
    else processCacheSet(wantKey, value, now);
  };

  // The shared breaker (#2221): open means the container is not answering
  // this file's per-sale card_catalog narrows AT ALL, and this module shares
  // that verdict rather than probing independently. Costs no query.
  if (opts.breakerIsOpen?.()) {
    opts.recordSkip?.();
    return null;
  }

  try {
    const container = opts.container;
    if (!container) return null;

    const num = cardNumberInClause(input.cardNumber);
    const runQuery = opts.runQuery ?? ((run: () => Promise<{ resources: CatalogFieldRow[] }>) => run());
    const { resources } = await runQuery(() =>
      container.items
        .query<CatalogFieldRow>(
          {
            // CF-A-CAP-BELOW-THE-LADDER-IS-A-SILENT-MISS (2026-09-19 review).
            // c.setKey IS IN THE WHERE, deliberately, unlike an earlier
            // revision of this query: without it, "card #1, 2024, baseball"
            // fans out across every product that ever printed a #1 -- dozens
            // of products x dozens of parallels each -- and a TOP far larger
            // than any one product's ladder would still truncate before the
            // target product's own rows and silently answer "no numbered
            // row". identityKeyOf already groups on the setKey FIELD (not the
            // id segment, mid-rename-safe -- see its own header), so filtering
            // SQL on the same field loses nothing the in-memory identity
            // filter below would have kept anyway.
            //
            // c.parallelSlug is NOT filtered in SQL, on purpose: identityKeyOf
            // compares the CLEANED parallel (`cleanParallelSlug` strips
            // `base-`/`base-cards-` and lowercases -- this module's own
            // header opens with the exact case a raw equality would miss,
            // `base-refractor` vs `refractor`). A SQL `c.parallelSlug = @p`
            // would exclude the checklist row this module exists to find.
            // The identity filter below is what actually narrows to the
            // parallel; SQL only narrows to (sport, year, setKey, cardNumber,
            // isAuto), same as catalogMatcher.service.ts's own
            // (sport, year, cardNumber, isAuto, setKey) query at :1356.
            //
            // NOT IS_DEFINED(c.gradeTier) excludes graded-child rows -- same
            // scope fold-checklist-numbered-twins.cjs's own pass 1 uses
            // (":179") -- so this counts identities, not (identity x grade
            // tier) explosions.
            //
            // TOP 100: with setKey pinned, the candidate set is one card
            // number's parallel ladder on ONE product. The largest hardcoded
            // ladder in parallelLadders.ts is 26 rungs (2026 Bowman Chrome
            // Prospect Autographs); catalogMatcher.service.ts's own
            // (sport, year, cardNumber, isAuto, setKey) query -- the same
            // filter shape, MINUS the grade exclusion this query adds -- has
            // used TOP 300 since 2026-08-14 on the stated grounds that "a
            // card has far fewer than 300 parallels". 100 sits comfortably
            // above the real ladder (room for pre-consolidation spelling
            // duplicates of the same rung) while excluding the grade axis
            // that query does not, so it is tighter without being narrower
            // than what is already trusted in production for this exact
            // shape.
            query:
              `SELECT TOP ${RESULT_CAP} c.id, c.source, c.setKey, c.parallelSlug, c.isAuto, c.printRun FROM c ` +
              `WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND c.cardNumber IN (${num.sql}) AND c.isAuto = @a ` +
              `AND NOT IS_DEFINED(c.gradeTier)`,
            parameters: [
              { name: "@s", value: input.sport },
              { name: "@y", value: input.year },
              { name: "@k", value: setKey },
              ...num.params,
              { name: "@a", value: input.isAuto },
            ],
          },
          // The abortSignal lands HERE, on the SDK call -- see queryOptions's
          // own doc for why that is load-bearing, not cosmetic.
          { maxItemCount: RESULT_CAP, ...opts.queryOptions },
        )
        .fetchAll(),
    );

    // CF-A-CAP-HIT-IS-UNKNOWN-NOT-EMPTY. Hitting TOP exactly means the real
    // candidate set may extend past what was fetched -- the checklist's
    // numbered row could be sitting just past the cut. Answering "no numbered
    // row" here would be a WRONG negative, worse than no answer, and caching
    // it would freeze that wrong answer for the rest of the TTL. So this
    // returns null WITHOUT caching, and counts the event so the true rate is
    // visible rather than silently absorbed into "unnumbered-twin, none
    // found".
    if ((resources ?? []).length >= RESULT_CAP) {
      console.warn(JSON.stringify({
        event: "checklist_numbered_ingest_result_cap_hit",
        source: "resolveChecklistNumberedIngest",
        sport: input.sport,
        year: input.year,
        setKey,
        cardNumber: input.cardNumber,
        cap: RESULT_CAP,
        detail: "the candidate set may extend past TOP; answering UNKNOWN rather than a wrong negative -- not cached",
      }));
      return null;
    }

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

    setCached(resolvedId);
    return resolvedId;
  } catch {
    // Fail open: the sale's derived slug stands, exactly as it would have
    // before this upgrade existed. A catalog blip -- including the runQuery
    // wrapper's own timeout -- must never block a write. Deliberately NOT
    // cached: a timeout is "unknown", not "no such row" (CF-A-DEDUP-TIMEOUT-
    // IS-NOT-A-MISS's same distinction), and caching it would freeze a
    // transient failure into a wrong negative answer for the rest of the TTL.
    return null;
  }
}
