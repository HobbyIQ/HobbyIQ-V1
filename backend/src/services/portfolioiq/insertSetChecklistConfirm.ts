/**
 * R66/R67/R70 review fix -- F3+F5 (2026-09-19), FIX 1 + FIX 2 (second
 * independent review, same day), FIX A + FIX B (third review, same day,
 * live-measured).
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
 * CONFIRMED by the insert's OWN checklist-authority rows in card_catalog. No
 * confirming row, or no checklist rows for the insert key at all -> do not
 * re-key; the caller parks with `insert-named-unconfirmed` (absent beats
 * wrong).
 *
 * FIX 1 (second review, high, proven). The original rule confirmed on card
 * NUMBER alone even when the sale's PLAYER was also known -- so a base sale
 * "Player A #5" with incidental "Downtown" text in its title could confirm
 * against an UNRELATED checklist row "Downtown #5, Player B", a false
 * re-key: the number matched, but the row is a different player's card.
 * THE RULE NOW: when BOTH the sale's card number AND its player are known,
 * BOTH must agree on the SAME checklist row (number match AND
 * playerIdentityKey match on that one row -- not "some row matches the
 * number, some OTHER row matches the player"). Number known, player not ->
 * number match on any row still suffices (nothing more to check against).
 * Player known, number not -> player match on any row still suffices.
 * Neither known -> never confirms (nothing to confirm against). Multi-player
 * rows ("Eddie Murray / Cal Ripken Jr.") are read as a LIST via
 * `catalogRowPlayerKeys` below -- the sale's player matches the row if it
 * matches ANY name listed on that row, the same "any listed player matches"
 * reading the repo's own D33 doc comment (cardCatalog.service.ts) describes
 * for multi-player catalog rows. Applied identically to both
 * `insertReKeyConfirmedByChecklist` (F3+F5) and `baseCardConfirmedBySale`
 * (F4 mirror) -- one comparison, not two.
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
 * FIX 2 (second review, design, measured live). The FIRST shipped version
 * fetched TOP 300 rows of the WHOLE (sport,year,setKey) cell and answered
 * UNKNOWN on a cap hit. Live measurement: 1,585 of 1,974 calls hit the cap
 * (panini-prizm / panini-phoenix 2025 carry thousands of catalog rows each),
 * so in production almost every base-confirmation came back UNKNOWN ->
 * park -- mass false parking of ordinary base sales carrying an incidental
 * word. THE FIX: make the query TARGETED, the same way
 * resolveChecklistNumberedIngest.ts already is -- add `c.cardNumber IN
 * (...)` (built from the shared `cardNumberVariants`'s own case/hyphen
 * variant set, the SAME tolerant number matching every other narrow query
 * in the repo already gets, plus this file's own local leading-zero fold --
 * see below) to the WHERE whenever the sale states a card number, which
 * narrows the candidate set from "the whole product" to "one card number's
 * rung", exactly like resolveChecklistNumberedIngest.ts's own query. `playerSlug`
 * was investigated as a possible query-time player filter and REJECTED: at
 * least three independent slugify implementations write it across the
 * catalog-mutation call sites, none identical to `playerIdentityKey`'s
 * algorithm (accent-folding, symbol transliteration, RC-marker cleaning),
 * so filtering SQL on it risks a false negative (a real match silently
 * missed) -- worse than the cap-hit problem this fix closes. The player-only
 * fallback path (no card number stated) therefore still scans the WHOLE
 * product cell, bounded by a smaller TOP (see CONFIRM_RESULT_CAP below) as a
 * guard; a cap hit there still answers UNKNOWN, never a wrong negative.
 * `catalogAuthorityOf`'s checklist classification stays JS-side (post-fetch)
 * -- it is an evolving multi-pattern regex classification, not a finite
 * literal list, and duplicating it into SQL would be exactly the "one
 * question asked in five different places" anti-pattern
 * catalogAuthority.service.ts's own header was written to eliminate.
 *
 * LEADING ZEROS ("05" ≡ "5") are handled LOCALLY, in this file's own
 * `withLeadingZeroFold` below, rather than inside the shared
 * `cardNumberVariants`/`cardNumberInClause` (hobbyIqCardId.service.ts).
 * That file is a DECLARED DERIVATION-STAMP INPUT
 * (scripts/lib/derivation-version.cjs) -- a change there, even a pure
 * addition to a variant LIST that changes no existing return value, moves
 * the I9 stamp (verified: it did, on a first attempt at this fix, and was
 * reverted). Every other production caller of `cardNumberVariants` (catalog
 * matcher, resolveChecklistNumberedIngest.ts, persistVendorSalesToPool.ts,
 * ...) would have inherited the wider variant set too, correctly and
 * safely (every caller only ever WIDENS a match), but "safe for callers"
 * and "safe for the stamp" are different questions, and this module answers
 * only the one it is allowed to. So the fold is applied here, over
 * `cardNumberVariants`'s own (unchanged) output, for this module's local
 * comparison only.
 *
 * The cache key now includes the number/player discriminator (previously
 * (sport,year,setKey) alone, which was safe only because every call fetched
 * the WHOLE product cell; a targeted query result is only valid for the
 * (number|player) it was fetched for). Cap hits are still never cached
 * (CF-A-CAP-HIT-IS-UNKNOWN-NOT-EMPTY).
 *
 * DO NOT INVENT A SECOND COSMOS ACCESS STYLE. Bounded query, sport+year+setKey
 * equality in the WHERE (a past incident, #2221, was a per-sale card_catalog
 * query with NO setKey filter fanning out cross-partition at ingest scale), a
 * result-cap-hit answers UNKNOWN not EMPTY (never caches a wrong negative), a
 * process-lifetime size-bounded TTL cache, and FAIL-OPEN on any error -- a
 * catalog blip must never block ingest, and here "fail open" means "answer
 * unconfirmed", i.e. park rather than guess, never the reverse. Both writers
 * pass persistVendorSalesToPool's own `narrowQuery` / `narrowBreakerIsOpen` /
 * `NARROW_QUERY_TIMEOUT_MS`, the SAME shared breaker
 * resolveChecklistNumberedIngest.ts already reuses -- one breaker for every
 * per-sale card_catalog narrow in this incident class, not a second one.
 *
 * ONLY CALLED ON THE ~4% OF SALES WITH A TITLE MATCH. insertSetNamedInTitle
 * is pure/free; this module's query only ever runs after that already-cheap
 * check finds something to confirm.
 *
 * FIX A (third review, live-measured, 2026-09-19). FIX 2's TARGETED query
 * (above) still fetched every ROW at the card number -- on a 2025 flagship
 * product one (setKey, cardNumber) carries ~382 rows (one per parallel), so
 * `TOP 50` still capped on 1,537 of 1,974 live calls (78%), UNKNOWN on
 * almost every call. THE FIX: the confirmation question only ever needs the
 * distinct (cardNumber, playerName, source) TRIPLES at that number, never
 * one row per parallel -- so the query is now a `SELECT DISTINCT` projection
 * over exactly those three fields, with a much higher cap (200 distinct
 * triples; a real card number's roster of distinct player/source
 * combinations is a handful, never hundreds) that the parallel count no
 * longer touches at all. Same shape for the player-only fallback:
 * `SELECT DISTINCT c.playerName, c.source`, cap raised to 2,000 distinct
 * players (a product roster is hundreds, and this query no longer pays for
 * one row per parallel either). Cosmos supports `SELECT DISTINCT` with a
 * projection; TOP is not combined with an ORDER BY here (there is none), so
 * the two are never mixed. Everything else about the query is unchanged:
 * same equality filters (sport/year/setKey[/cardNumber IN]), same
 * NOT IS_DEFINED(c.gradeTier), same parameterisation, same fail-open/
 * cap-hit-is-unknown/cache rules -- only the SELECT list and the cap moved.
 *
 * FIX B (third review, ruling on UNKNOWN, 2026-09-19). Before this fix,
 * `confirmedByChecklist` returned a bare boolean, and both writers treated
 * "not confirmed" as one bucket whether the checklist ACTIVELY DISAGREED
 * (a confirming row was fetched and none matched -- REFUTED) or the read
 * simply FAILED (cap hit, timeout, breaker open, no container -- UNKNOWN).
 * Both bucketed to "park". Since #2330, a parked row (`identityUnverified`)
 * is excluded from every FMV/trend/index/recent-sales reader -- so an
 * UNKNOWN-caused park now silently removes a real, legitimate comp from
 * pricing, not merely a re-key decision. THE RULING: the predicate returns a
 * TRI-STATE (`ConfirmVerdict`: "confirmed" | "refuted" | "unknown"), and a
 * failed/capped/timed-out/breaker-open read changes NOTHING --
 *   - Registered-insert path: CONFIRMED -> re-key. REFUTED (checklist rows
 *     exist for this cell/number but none match) -> park
 *     `insert-named-unconfirmed`, as before. UNKNOWN -> untouched: no
 *     re-key, no park, `insertConfirmUnknown` counter incremented, one log
 *     line per process per reason (see `logUnknownOnce` below).
 *   - Unregistered-root path (F4): base CONFIRMED -> untouched (word is
 *     incidental). Base REFUTED -> park `insert-named-no-key`, as before.
 *     Base UNKNOWN -> untouched, same counter/log discipline.
 * Rationale: never block or alter ingest on a read failure; status quo beats
 * a guess; parking now has a pricing consequence a stalled catalog read must
 * never cause. The reviewer's Downtown-#5-Player-B case is unaffected by
 * this ruling: that query DOES answer (the checklist has a #5 row, for a
 * different player) so it is REFUTED, not UNKNOWN, and still parks as
 * `insert-named-unconfirmed` -- FIX B only changes behaviour when the query
 * never got an answer at all.
 */

import type { Container } from "@azure/cosmos";
import { cardNumberVariants } from "./hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "../catalog/catalogAuthority.service.js";
import { playerIdentityKey } from "../catalog/playerIdentityKey.js";

/**
 * One DISTINCT (cardNumber, playerName, source) triple as FIX A's projection
 * returns it -- never one row per parallel. No `id`: the confirmation
 * question never needed row identity, only these three fields, and dropping
 * `id` from the SELECT is what makes DISTINCT collapse the parallel ladder.
 */
interface CatalogConfirmRow {
  source?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
}

/**
 * FIX B: the confirmation predicate's tri-state answer. "confirmed" and
 * "refuted" both mean the query ANSWERED (checklist rows were fetched and
 * either one matched or none did); "unknown" means no answer was obtained at
 * all (cap hit, timeout, breaker open, no container, or a query error) --
 * status quo beats a guess, so callers must change NOTHING on "unknown".
 */
export type ConfirmVerdict = "confirmed" | "refuted" | "unknown";

const isChecklist = (source: string | null | undefined): boolean =>
  catalogAuthorityOf(source) === "checklist";

/**
 * LOCAL leading-zero fold, over `cardNumberVariants`'s own (unchanged)
 * output -- see this file's header on why it is not added to the shared
 * helper. "BD005" gains "BD5"/"BD-5"; a bare "005" gains "5". Only the STRIP
 * direction: padding a bare "5" would require guessing a width this
 * function has no authority to invent. Never strips a run down to nothing
 * ("000" keeps "0", not "").
 */
function withLeadingZeroFold(variants: string[]): string[] {
  const out = new Set(variants);
  for (const v of variants) {
    const m = /^([A-Za-z]*)-?(0+\d+)$/.exec(v);
    if (!m) continue;
    const [, prefix, digits] = m;
    const stripped = digits.replace(/^0+(?=\d)/, "");
    if (!stripped || stripped === digits) continue;
    out.add(`${prefix}${stripped}`);
    out.add(`${prefix}${stripped}`.toLowerCase());
    if (prefix) {
      out.add(`${prefix}-${stripped}`);
      out.add(`${prefix}-${stripped}`.toLowerCase());
    }
  }
  return [...out];
}

/**
 * Multi-player catalog rows are one string with every name listed
 * ("Eddie Murray / Cal Ripken Jr.", the D33 shape documented in
 * cardCatalog.service.ts) -- never an array. "The sale's player matches
 * this row" therefore means matching ANY one of the row's listed names, not
 * reducing the whole string to one key (which would fuse "eddiemurray" and
 * "calripkenjr" into a single, unmatchable blob). Split on the documented
 * separator ("/") and the other common dual-player joiner ("&"); a
 * single-name row is a one-element list, so this subsumes the old
 * single-name comparison exactly.
 */
function catalogRowPlayerKeys(playerName: string | null | undefined): Set<string> {
  const raw = String(playerName ?? "");
  const keys = new Set<string>();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKey(part);
    if (k) keys.add(k);
  }
  return keys;
}

/** True when the sale's player matches ANY name listed on the row. */
function playerMatchesRow(saleplayer: string | null | undefined, rowPlayer: string | null | undefined): boolean {
  const saleKey = playerIdentityKey(saleplayer ?? "");
  if (!saleKey) return false;
  return catalogRowPlayerKeys(rowPlayer).has(saleKey);
}

/** Result cap for the TARGETED (card-number-filtered) query, now counting
 *  DISTINCT (cardNumber, playerName, source) triples rather than rows
 *  (FIX A). With (sport,year,setKey,cardNumber) all pinned, the candidate
 *  set the OLD row-per-parallel query saw was one card's parallel/print-run
 *  ladder -- on a 2025 flagship product, ~382 rows for a single number, which
 *  is why the old 50-row cap hit on 78% of live calls. The distinct-triple
 *  set at one number is a handful (a card number names one player, printed
 *  by one-or-a-few sources) -- 200 is generous headroom, not a tight bound. */
export const CONFIRM_RESULT_CAP = 200;

/** Result cap for the UNTARGETED (player-only, no card number stated)
 *  fallback query, now counting DISTINCT (playerName, source) pairs
 *  (FIX A) -- this one still scans the whole (sport,year,setKey) cell, but a
 *  product roster is hundreds of distinct players, never thousands, so 2,000
 *  is headroom rather than a bound the parallel count could still touch. A
 *  cap hit here answers UNKNOWN exactly like the targeted query's cap hit
 *  does; it is simply hit far less often now that the common
 *  (card-number-known) case is targeted, and even less often now that
 *  neither query pays for one row per parallel. */
export const CONFIRM_PLAYER_ONLY_RESULT_CAP = 2000;

// ── process-lifetime cache, keyed on (sport,year,setKey,discriminator) --
// the discriminator is the card-number variant set (targeted query) or the
// literal string "player-only" (untargeted query), so a targeted result for
// one card number is never served as the answer for a different one. Same
// TTL/size-bounded shape as resolveChecklistNumberedIngest.ts's own
// module-level cache (that module's own precedent: ensureCatalogRow's
// KNOWN_SLUGS + priceSanityGate's 15-min TTL). undefined = never asked;
// null = asked, no checklist rows at all for this cell.
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 5_000;
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
 * DISTINCT (cardNumber, playerName, source) triples for (sport, year,
 * setKey), TARGETED by cardNumber when the sale states one (FIX 2), FIX A's
 * DISTINCT projection so a 382-parallel rung is one triple, not 382 rows.
 * `null` return means EITHER "the catalog holds no checklist rows here" (the
 * query answered, REFUTED territory) OR "no answer was obtained" (cap hit,
 * breaker, error, no container -- UNKNOWN territory); `checklistRowsFor`
 * itself does not need to distinguish those two, since either way its
 * caller has no rows to compare against -- `confirmedByChecklist` (below)
 * recovers the distinction via `queryAnswered`, the second value in the pair
 * this function actually returns.
 *
 * A TOP-cap hit is NOT cached (same CF-A-CAP-HIT-IS-UNKNOWN-NOT-EMPTY rule
 * resolveChecklistNumberedIngest uses): the true answer may extend past the
 * cap, and caching a truncated "these are all the rows" would freeze a wrong
 * negative for the TTL.
 *
 * `cardNumber` null/absent means the UNTARGETED (player-only) fallback --
 * see this file's own header on why a query-time player filter is not safe.
 */
async function checklistRowsFor(
  sport: string, year: number, setKey: string,
  cardNumber: string | null | undefined,
  opts: ConfirmQueryOpts,
): Promise<{ rows: CatalogConfirmRow[] | null; queryAnswered: boolean }> {
  const targeted = cardNumber != null && String(cardNumber).trim() !== "";
  // The SQL IN-clause params carry the LOCAL leading-zero fold too (see this
  // file's header) so the targeted query itself does not miss a checklist
  // row that differs from the sale's stated number only by zero-padding --
  // built locally rather than via cardNumberInClause directly, since that
  // helper's own variant set (hobbyIqCardId.service.ts, a derivation-stamp
  // input) is deliberately left unchanged.
  const numParams = targeted
    ? withLeadingZeroFold(cardNumberVariants(cardNumber)).map((v, i) => ({ name: `@n${i}`, value: v }))
    : null;
  // Cache key discriminates by the actual variant SET (not the raw input),
  // so "BCP-6" and "bcp6" -- which resolve to the identical variant set --
  // share one cache entry rather than issuing the same query twice.
  const discriminator = targeted ? [...new Set(numParams!.map((p) => p.value.toLowerCase()))].sort().join(",") : "player-only";
  const key = `${sport}|${year}|${setKey}|${discriminator}`;
  const cap = targeted ? CONFIRM_RESULT_CAP : CONFIRM_PLAYER_ONLY_RESULT_CAP;
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached !== undefined) return { rows: cached, queryAnswered: true };

  if (opts.breakerIsOpen?.()) {
    opts.recordSkip?.();
    return { rows: null, queryAnswered: false };
  }

  try {
    const container = opts.container;
    if (!container) return { rows: null, queryAnswered: false };
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
            //
            // FIX 2 targeted the WHERE by cardNumber; FIX A (this version)
            // changed the SELECT to DISTINCT over exactly the three fields
            // the confirmation predicate reads -- a 382-row parallel ladder
            // at one number collapses to the handful of distinct
            // (cardNumber, playerName, source) triples it actually contains,
            // which is what let the cap rise from a row-count bound to a
            // distinct-triple bound (CONFIRM_RESULT_CAP) without widening
            // what a hit means. No TOP+ORDER BY: there is no ORDER BY here.
            query: targeted
              ? `SELECT DISTINCT TOP ${cap} c.cardNumber, c.playerName, c.source FROM c ` +
                `WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND c.cardNumber IN (${numParams!.map((p) => p.name).join(", ")}) ` +
                `AND NOT IS_DEFINED(c.gradeTier)`
              : `SELECT DISTINCT TOP ${cap} c.playerName, c.source FROM c ` +
                `WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND NOT IS_DEFINED(c.gradeTier)`,
            parameters: [
              { name: "@s", value: sport },
              { name: "@y", value: year },
              { name: "@k", value: setKey },
              ...(targeted ? numParams! : []),
            ],
          },
          { maxItemCount: cap, ...opts.queryOptions },
        )
        .fetchAll(),
    );

    if ((resources ?? []).length >= cap) {
      console.warn(JSON.stringify({
        event: "insert_set_confirm_result_cap_hit",
        source: "insertSetChecklistConfirm",
        sport, year, setKey, targeted, cap,
        detail: "the distinct-triple candidate set may extend past TOP; answering UNKNOWN rather than a wrong negative -- not cached",
      }));
      return { rows: null, queryAnswered: false };
    }

    const rows = resources ?? [];
    const checklistRows = rows.filter((r) => isChecklist(r.source));
    const value = checklistRows.length > 0 ? checklistRows : null;
    cacheSet(key, value, now);
    return { rows: value, queryAnswered: true };
  } catch {
    // No answer obtained -- never a re-key, never a park, never a block on
    // ingest. Deliberately not cached: a timeout is unknown, not a genuine
    // absence of checklist rows (same distinction resolveChecklistNumberedIngest
    // draws for its own try/catch).
    return { rows: null, queryAnswered: false };
  }
}

const normNumber = (n: string | null | undefined): string => String(n ?? "").trim().toLowerCase();

/**
 * THE confirmation predicate, shared by both exported functions below (FIX 1
 * requires the SAME rule on both sides of F3+F5/F4, never two).
 *
 *   number known AND player known  -> a SINGLE row must match BOTH
 *                                      (number match AND player match on
 *                                      that same row).
 *   number known, player unknown   -> any row matching the number suffices.
 *   number unknown, player known   -> any row matching the player suffices.
 *   neither known                  -> never confirms (REFUTED: nothing to
 *                                      confirm against, and no read failed).
 *
 * "Player known" reads the sale's own resolved player through
 * `playerIdentityKey`; an empty/unreducible name counts as unknown, exactly
 * like an empty card number does.
 *
 * FIX B: returns the TRI-STATE `ConfirmVerdict`, not a boolean. "unknown" is
 * ONLY the no-answer case (`checklistRowsFor`'s `queryAnswered === false`) --
 * a cap hit, a timeout, an open breaker, no container, or a query error.
 * Every case where the query DID answer -- including "no checklist rows for
 * this cell at all" and "rows exist but none match this number/player" --
 * is "refuted", never "unknown": the read succeeded and the checklist simply
 * does not attest this sale, which is exactly the case the caller must still
 * be free to park on.
 */
async function confirmedByChecklist(
  sport: string, year: number, setKey: string,
  cardNumber: string | null | undefined, playerName: string | null | undefined,
  opts: ConfirmQueryOpts,
): Promise<ConfirmVerdict> {
  const num = normNumber(cardNumber);
  const playerKey = playerIdentityKey(playerName ?? "");
  if (!num && !playerKey) return "refuted";

  const { rows, queryAnswered } = await checklistRowsFor(sport, year, setKey, num || null, opts);
  if (!queryAnswered) return "unknown";
  if (!rows) return "refuted";

  const variants = num
    ? new Set(withLeadingZeroFold(cardNumberVariants(cardNumber)).map((v) => v.toLowerCase()))
    : null;

  let matched: boolean;
  if (num && playerKey) {
    // BOTH known: one row must confirm BOTH, together -- FIX 1. A number
    // match on one row and a player match on an UNRELATED row is exactly
    // the false-positive the second review found (Downtown #5 Player B
    // confirming a sale of Player A #5): the number and the player must
    // agree on the SAME checklist row.
    matched = rows.some((r) => variants!.has(normNumber(r.cardNumber)) && playerMatchesRow(playerName, r.playerName));
  } else if (num) {
    matched = rows.some((r) => variants!.has(normNumber(r.cardNumber)));
  } else {
    // player-only fallback.
    matched = rows.some((r) => playerMatchesRow(playerName, r.playerName));
  }
  return matched ? "confirmed" : "refuted";
}

// FIX B telemetry: a process-lifetime counter plus a one-line-per-reason log
// guard, so an UNKNOWN storm (a catalog outage, an open breaker) produces one
// log line per process per reason rather than one per sale. `reason` is a
// short caller-supplied tag ("insert-rekey" / "base-confirm") so the two call
// sites are distinguishable in the counter without a second counter.
let insertConfirmUnknownCount = 0;
const _loggedUnknownReasons = new Set<string>();

/** Exported read-only for callers/telemetry dashboards that want the count
 *  without reaching into module state; tests reset it via the clear below. */
export function insertConfirmUnknownTotal(): number {
  return insertConfirmUnknownCount;
}

export function _resetInsertConfirmUnknownCounterForTests(): void {
  insertConfirmUnknownCount = 0;
  _loggedUnknownReasons.clear();
}

function recordUnknown(reason: "insert-rekey" | "base-confirm", detail: Record<string, unknown>): void {
  insertConfirmUnknownCount++;
  if (_loggedUnknownReasons.has(reason)) return;
  _loggedUnknownReasons.add(reason);
  console.warn(JSON.stringify({
    event: "insertConfirmUnknown",
    source: "insertSetChecklistConfirm",
    reason,
    detail: "confirmation query returned UNKNOWN (cap hit / timeout / breaker open / no container / error) -- "
      + "leaving the sale untouched, no re-key, no park (FIX B: a read failure must never change what a sale is)",
    ...detail,
  }));
}

/**
 * F3+F5 (+ FIX 1, FIX B): does the INSERT's own checklist attest this sale?
 * Tri-state -- "confirmed" only on a positive confirming row under the rule
 * `confirmedByChecklist` states above; "refuted" for "no checklist rows for
 * this product at all" and for "checklist rows exist but none confirm this
 * sale" alike (both mean "do not re-key", and the caller parks
 * `insert-named-unconfirmed`); "unknown" when no answer was obtained at all
 * (the caller must leave the sale untouched, per FIX B's ruling).
 */
export async function insertReKeyConfirmedByChecklist(
  input: {
    sport: string; year: number; insertSetKey: string;
    cardNumber: string | null | undefined; playerName: string | null | undefined;
  },
  opts: ConfirmQueryOpts,
): Promise<ConfirmVerdict> {
  const sport = String(input.sport ?? "").trim().toLowerCase();
  const setKey = String(input.insertSetKey ?? "").trim().toLowerCase();
  if (!sport || !setKey || !input.year) return "refuted";
  const verdict = await confirmedByChecklist(sport, input.year, setKey, input.cardNumber, input.playerName, opts);
  if (verdict === "unknown") {
    recordUnknown("insert-rekey", { sport, year: input.year, insertSetKey: setKey });
  }
  return verdict;
}

/**
 * F4 (+ FIX 1 mirror, FIX B): is the sale's BASE product (the one the title
 * actually ships as, before any insert re-key is even considered) itself
 * checklist-confirmed at this card's identity, under the SAME both-must-agree
 * rule? "confirmed" -> an unregistered insert ROOT appearing incidentally in
 * the title (an ordinary English word like "fireworks", "prime") is not
 * grounds to park -- the checklist already vouches for this exact base card.
 * "refuted" -> the caller parks `insert-named-no-key`. "unknown" -> the
 * caller must leave the sale untouched (FIX B). Same confirmation primitive
 * as the re-key check, run against the BASE setKey instead of the insert's.
 */
export async function baseCardConfirmedBySale(
  input: {
    sport: string; year: number; baseSetKey: string;
    cardNumber: string | null | undefined; playerName: string | null | undefined;
  },
  opts: ConfirmQueryOpts,
): Promise<ConfirmVerdict> {
  const sport = String(input.sport ?? "").trim().toLowerCase();
  const setKey = String(input.baseSetKey ?? "").trim().toLowerCase();
  if (!sport || !setKey || !input.year) return "refuted";
  const verdict = await confirmedByChecklist(sport, input.year, setKey, input.cardNumber, input.playerName, opts);
  if (verdict === "unknown") {
    recordUnknown("base-confirm", { sport, year: input.year, baseSetKey: setKey });
  }
  return verdict;
}
