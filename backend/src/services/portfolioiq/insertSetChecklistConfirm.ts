/**
 * R66/R67/R70 review fix -- F3+F5 (2026-09-19).
 *
 * insertSetTitleReader.ts answers "does the TITLE name a known insert set of
 * its own product". That is vocabulary, not proof: the review found two
 * ways a title match alone re-keys a sale onto an ADDRESS NO CHECKLIST HAS.
 *
 *   F3 -- seller-boilerplate false positive. "...#150 PSA 10 - Ships from
 *   Downtown Toronto" and "(Downtown Sports Cards LLC)" both contain the
 *   literal token "downtown" -- Donruss Optic's own registered insert name --
 *   with zero connection to the card. A title match is evidence the WORD
 *   appears, never evidence the SALE is that card.
 *
 *   F5 -- no card-number consistency. Rewriting `setKey` to the insert's key
 *   while the sale's card NUMBER is still the one a title-parse read off the
 *   BASE card's checklist mints an address (insert setKey + base card number)
 *   that no checklist ever printed -- two players can occupy that number on
 *   two different products, so this is not a rounding error, it is a
 *   different card.
 *
 * THE RULING: the checklist decides. A title match may only re-key when
 * CONFIRMED by the insert's OWN checklist-authority rows in card_catalog:
 * (insert setKey, sport, year) has a checklist row whose cardNumber equals
 * the sale's card number, OR -- when the sale states no card number -- whose
 * player matches via the repo's existing normalised player comparison
 * (`playerIdentityKey`, catalog/playerIdentityKey.ts). No confirming row, or
 * no checklist rows for the insert key at all -> do not re-key; the caller
 * parks with `insert-named-unconfirmed` (absent beats wrong).
 *
 * F4 (unregistered root, ordinary English word incidental in a base-card
 * title) is judged with the SAME confirmation primitive from the other side:
 * `baseCardConfirmedBySale` asks whether the sale's BASE identity (the
 * product the title actually ships as, before any insert re-key) is itself
 * checklist-attested at this card number/player. When it is, the "insert"
 * word is incidental and the sale is left untouched -- the checklist already
 * vouches for the base card, so a stray English word in the title is not
 * grounds to park it.
 *
 * DO NOT INVENT A SECOND COSMOS ACCESS STYLE. This module is deliberately the
 * SAME shape as resolveChecklistNumberedIngest.ts, reused rather than
 * reimplemented: bounded TOP-N query with sport+year+setKey equality in the
 * WHERE clause (a past incident, #2221, was a per-sale card_catalog query
 * with NO setKey filter fanning out cross-partition at ingest scale), a
 * result-cap-hit answers UNKNOWN not EMPTY (never caches a wrong negative), a
 * process-lifetime size-bounded TTL cache keyed on (sport,year,setKey) so a
 * batch of sales against the same product costs one query, and FAIL-OPEN on
 * any error -- a catalog blip must never block ingest, and here "fail open"
 * means "answer unconfirmed", i.e. park rather than guess, never the reverse.
 * Both writers pass persistVendorSalesToPool's own `narrowQuery` /
 * `narrowBreakerIsOpen` / `NARROW_QUERY_TIMEOUT_MS`, the SAME shared breaker
 * resolveChecklistNumberedIngest.ts already reuses -- one breaker for every
 * per-sale card_catalog narrow in this incident class, not a second one.
 *
 * ONLY CALLED ON THE ~4% OF SALES WITH A TITLE MATCH. insertSetNamedInTitle
 * is pure/free; this module's query only ever runs after that already-cheap
 * check finds something to confirm.
 */

import type { Container } from "@azure/cosmos";
import { cardNumberInClause } from "./hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "../catalog/catalogAuthority.service.js";
import { playerIdentityKey } from "../catalog/playerIdentityKey.js";

/** One catalog row as the confirmation query returns it. */
interface CatalogConfirmRow {
  id: string;
  source?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
}

const isChecklist = (source: string | null | undefined): boolean =>
  catalogAuthorityOf(source) === "checklist";

/** Result cap, same reasoning as resolveChecklistNumberedIngest.ts's own
 *  RESULT_CAP: with (sport, year, setKey) pinned, the candidate set is one
 *  product's checklist. 300 matches catalogMatcher.service.ts's own
 *  (sport, year, cardNumber, isAuto, setKey)-shaped query, already trusted in
 *  production for this identity-cell shape. */
export const CONFIRM_RESULT_CAP = 300;

// ── process-lifetime cache, keyed on (sport,year,setKey) -- NOT per card
// number, because the query itself fetches the whole product's checklist
// rows in one shot and every sale of that product in a batch/process reuses
// them. Same TTL/size-bounded shape as resolveChecklistNumberedIngest.ts's
// own module-level cache (that module's own precedent: ensureCatalogRow's
// KNOWN_SLUGS + priceSanityGate's 15-min TTL). undefined = never asked;
// null = asked, no checklist rows at all for this product.
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 2_000;
const _cache = new Map<string, { value: CatalogConfirmRow[] | null; expiresAt: number }>();

function cacheGet(key: string, now: number): CatalogConfirmRow[] | null | undefined {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= now) { _cache.delete(key); return undefined; }
  return e.value;
}

function cacheSet(key: string, value: CatalogConfirmRow[] | null, now: number): void {
  if (_cache.has(key)) _cache.delete(key);
  while (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

export function _clearInsertSetConfirmCacheForTests(): void {
  _cache.clear();
}

export interface ConfirmQueryOpts {
  container: Container | null;
  /** Same shared narrow as resolveChecklistNumberedIngest.ts -- both writers
   *  pass persistVendorSalesToPool's exported `narrowQuery`. Defaults to a
   *  plain call, for test callers only. */
  runQuery?: <T>(run: () => Promise<T>) => Promise<T>;
  queryOptions?: { abortSignal?: AbortSignal; maxItemCount?: number };
  breakerIsOpen?: () => boolean;
  recordSkip?: () => void;
}

/**
 * Every checklist-authority row for (sport, year, setKey), or null when the
 * catalog holds none, or undefined-shaped "unknown" is folded into null
 * (fail open == unconfirmed, never a guess). A TOP-cap hit is NOT cached
 * (same CF-A-CAP-HIT-IS-UNKNOWN-NOT-EMPTY rule resolveChecklistNumberedIngest
 * uses): the true answer may extend past the cap, and caching a truncated
 * "these are all the rows" would freeze a wrong negative for the TTL.
 */
async function checklistRowsFor(
  sport: string, year: number, setKey: string, opts: ConfirmQueryOpts,
): Promise<CatalogConfirmRow[] | null> {
  const key = `${sport}|${year}|${setKey}`;
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached !== undefined) return cached;

  if (opts.breakerIsOpen?.()) {
    opts.recordSkip?.();
    return null;
  }

  try {
    const container = opts.container;
    if (!container) return null;
    const runQuery = opts.runQuery ?? ((run: () => Promise<{ resources: CatalogConfirmRow[] }>) => run());
    const { resources } = await runQuery(() =>
      container.items
        .query<CatalogConfirmRow>(
          {
            // setKey IS in the WHERE, deliberately -- see this file's header
            // and resolveChecklistNumberedIngest.ts's own CF-A-CAP-BELOW-
            // THE-LADDER-IS-A-SILENT-MISS: without it "card #1, 2024,
            // football" fans out across every product that ever printed a
            // #1, cross-partition, at ingest scale (#2221's incident shape).
            query:
              `SELECT TOP ${CONFIRM_RESULT_CAP} c.id, c.source, c.cardNumber, c.playerName FROM c ` +
              `WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND NOT IS_DEFINED(c.gradeTier)`,
            parameters: [
              { name: "@s", value: sport },
              { name: "@y", value: year },
              { name: "@k", value: setKey },
            ],
          },
          { maxItemCount: CONFIRM_RESULT_CAP, ...opts.queryOptions },
        )
        .fetchAll(),
    );

    if ((resources ?? []).length >= CONFIRM_RESULT_CAP) {
      console.warn(JSON.stringify({
        event: "insert_set_confirm_result_cap_hit",
        source: "insertSetChecklistConfirm",
        sport, year, setKey, cap: CONFIRM_RESULT_CAP,
        detail: "the candidate set may extend past TOP; answering UNKNOWN (unconfirmed) rather than a wrong negative -- not cached",
      }));
      return null;
    }

    const rows = (resources ?? []).filter((r): r is CatalogConfirmRow => typeof r?.id === "string");
    const checklistRows = rows.filter((r) => isChecklist(r.source));
    const value = checklistRows.length > 0 ? checklistRows : null;
    cacheSet(key, value, now);
    return value;
  } catch {
    // Fail open onto "unconfirmed" -- never a re-key, never a block on
    // ingest. Deliberately not cached: a timeout is unknown, not a genuine
    // absence of checklist rows (same distinction resolveChecklistNumberedIngest
    // draws for its own try/catch).
    return null;
  }
}

const normNumber = (n: string | null | undefined): string => String(n ?? "").trim().toLowerCase();

/**
 * F3+F5: does the INSERT's own checklist attest this sale at (cardNumber) or,
 * absent a card number, at (player)? True only on a positive confirming row;
 * false for "no checklist rows for this product at all" and for "checklist
 * rows exist but none confirm this sale" alike -- both mean "do not re-key".
 */
export async function insertReKeyConfirmedByChecklist(
  input: {
    sport: string; year: number; insertSetKey: string;
    cardNumber: string | null | undefined; playerName: string | null | undefined;
  },
  opts: ConfirmQueryOpts,
): Promise<boolean> {
  const sport = String(input.sport ?? "").trim().toLowerCase();
  const setKey = String(input.insertSetKey ?? "").trim().toLowerCase();
  if (!sport || !setKey || !input.year) return false;

  const rows = await checklistRowsFor(sport, input.year, setKey, opts);
  if (!rows) return false;

  const cardNumber = normNumber(input.cardNumber);
  if (cardNumber) {
    // cardNumberInClause's variant-expansion is the repo's own tolerant
    // number comparison (hyphen/case/leading-zero forms); reused here rather
    // than a bare string equality so "BCP-6" vs "bcp6" still confirms.
    const variants = new Set(cardNumberInClause(input.cardNumber).params.map((p) => p.value.toLowerCase()));
    return rows.some((r) => variants.has(normNumber(r.cardNumber)));
  }

  const playerKey = playerIdentityKey(input.playerName ?? "");
  if (!playerKey) return false;
  return rows.some((r) => playerIdentityKey(r.playerName ?? "") === playerKey);
}

/**
 * F4: is the sale's BASE product (the one the title actually ships as, before
 * any insert re-key is even considered) itself checklist-confirmed at this
 * card's identity? When yes, an unregistered insert ROOT appearing incidentally
 * in the title (an ordinary English word like "fireworks", "prime") is not
 * grounds to park -- the checklist already vouches for this exact base card.
 * Same confirmation primitive as the re-key check, run against the BASE
 * setKey instead of the insert's.
 */
export async function baseCardConfirmedBySale(
  input: {
    sport: string; year: number; baseSetKey: string;
    cardNumber: string | null | undefined; playerName: string | null | undefined;
  },
  opts: ConfirmQueryOpts,
): Promise<boolean> {
  return insertReKeyConfirmedByChecklist(
    { sport: input.sport, year: input.year, insertSetKey: input.baseSetKey, cardNumber: input.cardNumber, playerName: input.playerName },
    opts,
  );
}
