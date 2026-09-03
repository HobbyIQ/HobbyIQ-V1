/**
 * H-3 (audit 2026-09-03). One catalog-first identity resolution for the
 * free-text pricing routes, so `/search` and `/price` stop MINTING the slug
 * they price.
 *
 * WHAT THIS REPLACES
 * ------------------
 * `/price` computed its own slug from the parsed query with two invented
 * segments:
 *
 *     sport:    hardcoded "baseball"    ("highest pool coverage")
 *     parallel: parsed.parallel || "Base"
 *
 * and priced whatever pool that string collided with, behind nothing but a
 * 0.5 parser-confidence check. "2024 Bowman Chrome #1" names a real baseball
 * card and a real hockey card; the mint always picked baseball. And a query
 * that mentioned no parallel was recorded as a positive claim that the card
 * IS the base card — the blank-means-unknown rule, inverted.
 *
 * THE RULE THIS ENFORCES
 * ----------------------
 * An identity is something the CATALOG holds, not something a route derives
 * from a user's typing. So this asks the catalog for a row matching what the
 * user actually said, and takes the sport, the parallel and the slug FROM THE
 * ROW. When the catalog holds no such row — or holds several and cannot say
 * which — there is no identity, and the caller falls through to the estimate
 * ladder rather than pricing a guess.
 *
 * Ambiguity is a refusal, not a coin flip: a query matching more than
 * MAX_CANDIDATES rows has not been narrowed to a card, and confidently
 * pricing the wrong card is worse than returning nothing (the same rule the
 * cardNumber-less lookup already applies one block below).
 */
import { CosmosClient, type Container } from "@azure/cosmos";
import { normalizeSetKey } from "../portfolioiq/hobbyIqCardId.service.js";

/** More candidates than this means the query did not name one card. */
const MAX_CANDIDATES = 3;

export interface ResolvedSearchIdentity {
  /** The catalog row's own slug — never computed here. */
  slug: string;
  /** The row's OWN sport. Never guessed, never defaulted. */
  sport: string;
  /** The row's own parallel, as the catalog spells it. */
  parallel: string | null;
  year: number | null;
  setName: string | null;
  cardNumber: string | null;
  playerName: string | null;
  isAuto: boolean;
}

let _container: Container | null = null;
function catalog(): Container | null {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("card_catalog");
    return _container;
  } catch { return null; }
}

interface CatalogRow {
  id: string;
  cardId?: string | null;
  hobbyiqCardId?: string | null;
  playerName?: string | null;
  setName?: string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  sport?: string | null;
  year?: number | null;
  recentSaleCount?: number | null;
}

/**
 * The catalog's identity for a parsed free-text query, or null.
 *
 * Null is a legitimate and common answer — it means "the catalog does not
 * hold this card", which is exactly when a route must NOT price.
 */
export async function resolveSearchIdentity(input: {
  year: number | null | undefined;
  setSource: string | null | undefined;
  cardNumber: string | null | undefined;
  parallel: string | null | undefined;
  isAuto: boolean | null | undefined;
  playerName: string | null | undefined;
}): Promise<ResolvedSearchIdentity | null> {
  const cont = catalog();
  if (!cont) return null;
  const year = typeof input.year === "number" && Number.isFinite(input.year) ? input.year : null;
  const cardNumber = String(input.cardNumber ?? "").trim();
  const setSource = String(input.setSource ?? "").trim();
  if (year === null || !cardNumber || !setSource) return null;

  const setKey = normalizeSetKey(setSource);
  const setLower = setSource.toLowerCase();
  // The parallel is matched only when the user NAMED one. A query that says
  // nothing about a parallel must not be narrowed to "Base" — blank means
  // unknown. It is used to disambiguate below, never to invent.
  const parallelNamed = String(input.parallel ?? "").trim();

  let rows: CatalogRow[] = [];
  try {
    const { resources } = await cont.items.query<CatalogRow>({
      query: `SELECT TOP 40 c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.setName, c.setKey,
                     c.cardNumber, c.parallel, c.isAuto, c.sport, c.year, c.recentSaleCount
              FROM c
              WHERE c.year = @y
                AND LOWER(c.cardNumber) = @num
                AND (
                  (IS_DEFINED(c.setKey) AND (LOWER(c.setKey) = @sk OR CONTAINS(LOWER(c.setKey), @sk, true)))
                  OR (IS_DEFINED(c.setName) AND CONTAINS(LOWER(c.setName), @s, true))
                )`,
      parameters: [
        { name: "@y", value: year },
        { name: "@num", value: cardNumber.toLowerCase() },
        { name: "@sk", value: setKey },
        { name: "@s", value: setLower },
      ],
    }, { maxItemCount: 40 }).fetchAll();
    rows = resources || [];
  } catch { return null; }
  if (rows.length === 0) return null;

  // Narrow by what the user actually said — each of these is a filter only
  // when the query carried the field.
  let candidates = rows;
  if (parallelNamed) {
    const want = parallelNamed.toLowerCase();
    const hit = candidates.filter((r) => String(r.parallel ?? "").toLowerCase() === want);
    if (hit.length > 0) candidates = hit;
  }
  if (typeof input.isAuto === "boolean") {
    const hit = candidates.filter((r) => Boolean(r.isAuto) === input.isAuto);
    if (hit.length > 0) candidates = hit;
  }
  const player = String(input.playerName ?? "").trim().toLowerCase();
  if (player) {
    const hit = candidates.filter((r) => String(r.playerName ?? "").toLowerCase().includes(player));
    if (hit.length > 0) candidates = hit;
  }

  // A sport the rows disagree about is not a sport we know. Refuse rather
  // than pick — this is the exact failure the hardcoded "baseball" caused.
  const sports = new Set(
    candidates.map((r) => String(r.sport ?? "").trim().toLowerCase()).filter(Boolean),
  );
  if (sports.size !== 1) return null;

  if (candidates.length > MAX_CANDIDATES) return null;

  // Prefer the liquid row when a couple remain; they agree on sport by the
  // check above, so this only picks among parallels of one card.
  candidates.sort((a, b) => Number(b.recentSaleCount ?? 0) - Number(a.recentSaleCount ?? 0));
  const best = candidates[0];
  const slug = String(best.hobbyiqCardId ?? best.cardId ?? best.id ?? "").trim();
  if (!slug) return null;
  const sport = String(best.sport ?? "").trim();
  if (!sport) return null;

  return {
    slug,
    sport,
    parallel: best.parallel ?? null,
    year: best.year ?? year,
    setName: best.setName ?? null,
    cardNumber: best.cardNumber ?? cardNumber,
    playerName: best.playerName ?? null,
    isAuto: Boolean(best.isAuto),
  };
}
