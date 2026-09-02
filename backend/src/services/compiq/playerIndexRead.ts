/**
 * CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02) — the read seam.
 *
 * "This is where speculation comes from." When a card's own pool has gone
 * cold, the price is not the last comp: it is that comp carried forward on
 * the PLAYER's market. To carry it we need the player's OTHER cards — the
 * liquid ones, the ones still trading — and their sales.
 *
 * This module owns ONLY the sold_comps query, for the same reason
 * exactPoolReader does (D16): a test can feed one fixture pool to the real
 * computation by mocking this module alone, without mocking "@azure/cosmos"
 * under the whole app.
 *
 * The query is deliberately narrow: one player, one sport, priced, not
 * anomalous, not flagged wrong, inside the basket window. It reads rows the
 * index math needs and nothing else — cardId (the identity a basket member
 * IS), price, soldAt, and the grade fields the tier filter needs.
 *
 * Cosmos not configured -> null (the caller declines the rung, exactly as
 * exactPoolReader's null makes the engine answer no-basis). A read error ->
 * [] (an empty basket, which fails the breadth floor and falls through).
 */
import { CosmosClient, type Container } from "@azure/cosmos";
import { isBeforeAsOf } from "./asOfCutoff.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SOLD_COMPS_CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";

export interface PlayerPoolRow {
  /** The canonical identity of the card that sold — a basket member key. */
  hobbyiqCardId: string | null;
  /** The vendor key, used only when a row carries no canonical slug. */
  cardId: string | null;
  price: number;
  soldAt: string;
  gradeCompany: string | null;
  gradeValue: number | null;
}

let _container: Container | null = null;
function getContainer(): Container | null {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn).database(COSMOS_DATABASE).container(SOLD_COMPS_CONTAINER);
    return _container;
  } catch { return null; }
}

/**
 * Every priced, non-anomalous sale of one player's cards since `fromIso`.
 *
 * `null` when Cosmos is not configured; `[]` when the query fails.
 *
 * LOWER(c.playerName) per row is the same anti-pattern concession
 * soldCompsStore.readCompsByPlayer already makes (the parameter is
 * pre-lowered at the client; there is no denormalized lowercase field yet).
 * TOP bounds the read: a basket needs breadth, not every sale ever.
 */
export async function readPlayerPoolRows(input: {
  playerName: string;
  sport?: string | null;
  fromIso: string;
  limit?: number;
  /** CF-AS-OF-IS-AN-UPPER-BOUND (#1651). Backtest only: no sale at or after
   *  this instant may enter the basket. The ceiling matters MORE here than on
   *  the exact pool — this rung's whole claim is "the player's market moved
   *  R× since this card last traded", and a basket that could see next week's
   *  sales would be reporting a move it had already been told the answer to.
   *  Undefined in production; the bound is then absent from the query. */
  asOfIso?: string | null;
}): Promise<PlayerPoolRow[] | null> {
  const container = getContainer();
  if (!container) return null;
  const player = String(input.playerName ?? "").trim().toLowerCase();
  if (!player) return [];
  const limit = Math.min(4000, Math.max(1, Math.trunc(input.limit ?? 2000)));
  const sport = String(input.sport ?? "").trim().toLowerCase();
  const asOf = typeof input.asOfIso === "string" && input.asOfIso ? input.asOfIso : null;

  const parameters: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@player", value: player },
    { name: "@from", value: input.fromIso },
  ];
  if (sport) parameters.push({ name: "@sport", value: sport });
  if (asOf) parameters.push({ name: "@asOf", value: asOf });

  // NOTE the interaction with TOP + ORDER BY soldAt DESC: without the ceiling
  // a backtest basket would fill its TOP N with the newest sales in the
  // container — which are the ones AFTER the evaluation point — and could
  // return a basket made entirely of the future. The bound is in the query for
  // that reason, not merely for tidiness.
  const query = `SELECT TOP @lim c.hobbyiqCardId, c.cardId, c.price, c.soldAt,
                        c.gradeCompany, c.gradeValue
                 FROM c
                 WHERE LOWER(c.playerName) = @player
                   AND c.soldAt >= @from
                   ${asOf ? "AND c.soldAt < @asOf" : ""}
                   AND c.price > 0
                   AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)
                   AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
                   ${sport ? "AND c.sport = @sport" : ""}
                 ORDER BY c.soldAt DESC`;

  try {
    const { resources } = await container.items.query<PlayerPoolRow>({ query, parameters }).fetchAll();
    const rows = resources ?? [];
    // Belt and braces behind the string bound — see asOfCutoff.ts. `soldAt` is
    // compared as a string and the pool holds three serializations of the same
    // instant, so the parsed re-check is what makes the ceiling independent of
    // which ingest wrote the row.
    if (!asOf) return rows;
    const asOfMs = Date.parse(asOf);
    return Number.isFinite(asOfMs) ? rows.filter((r) => isBeforeAsOf(r.soldAt, asOfMs)) : rows;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "player_index_pool_read_error",
      source: "playerIndexRead.readPlayerPoolRows",
      playerName: input.playerName,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}
