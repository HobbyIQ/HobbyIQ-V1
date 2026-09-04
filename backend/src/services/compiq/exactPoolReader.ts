/**
 * CF-ONE-VALUATION-PATH (D16, 2026-08-30). The sold_comps read behind the
 * unified engine, in its own module for ONE reason: so a test can feed one
 * fixture pool to every route through the REAL engine (the way
 * soldCompsGradeReader is the observed curve's seam). Mocking "@azure/cosmos"
 * under the whole app hits every other Cosmos consumer in the graph; this
 * module owns only the query, so mocking it touches nothing else.
 *
 * The query is the one unifiedPricing always ran: the exact identity —
 * `cardId` OR `hobbyiqCardId` — within the window, priced, not anomalous.
 * Dedupe, the self-comp rule, grouping and every number stay in the engine.
 *
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): an un-numbered id and its
 * ONE numbered twin are one card whose pool is split across two keys until
 * the D29 fleet re-keys sold_comps (the fold re-keyed catalog rows only).
 * `hobbyiqCardIds` carries the twin so the union is read in the SAME query
 * the readers use (soldCompsStore reads the same two keys) — one more
 * equality on the indexed field, +1–3 RU measured, never a STARTSWITH.
 *
 * CF-AS-OF-IS-AN-UPPER-BOUND (#1651, the engine backtest, 2026-09-02). The
 * window was always a LOWER bound — `soldAt >= now - windowDays` — because in
 * production there is no such thing as a sale from the future. A BACKTEST
 * evaluates the engine as of a past instant, and there the future is sitting
 * right there in the container: every sale that happened after the evaluation
 * point, including THE ONE BEING PREDICTED.
 *
 * So `asOfMs` closes the window at the top, in the QUERY, not in a filter the
 * caller remembers to apply. That placement is the point. A lookahead leak in
 * a backtest is not a wrong number, it is a RIGHT-LOOKING number — the engine
 * "predicts" a sale it can see, the error goes to zero, and the published
 * accuracy figure is a lie that validates itself. Structural exclusion at the
 * one read every pool rung goes through is the only version of this that can
 * be trusted, and it is pinned by a test that puts a future-dated row in the
 * fixture and requires the answer not to move (asOfLookaheadIsolation.test.ts).
 *
 * `asOfMs` is undefined in production, where the bound is absent and the query
 * is byte-identical to the one that always ran.
 */
import { CosmosClient, type Container } from "@azure/cosmos";
import { asOfCutoffString, isBeforeAsOf } from "./asOfCutoff.js";
import { mayUnionIdentities, productIdentityOf } from "./identityUnionGuard.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SOLD_COMPS_CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";

export interface ExactPoolRow {
  price: number;
  soldAt: string;
  gradeCompany: string | null;
  gradeValue: number | null;
  priceAnomaly?: boolean;
  contributorUserId?: string | null;
  /** The ingest source of the row, for the wire's comp list (D16). */
  source?: string | null;
  /** CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04). The seller behind
   *  the sale, when the ingest path could see one. Projected because the
   *  3-independent-seller threshold is evaluated on it; absent on the vast
   *  majority of rows, which is exactly what makes the basis `row-count`
   *  rather than a silent claim of independence. */
  sellerHandle?: string | null;
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
 * Every priced, non-anomalous sale of the identity in the window. `null`
 * when Cosmos is not configured (the engine answers no-basis, as before);
 * `[]` when the query fails (as before — a read error is an empty pool).
 */
export async function readExactPoolRows(input: {
  cardId: string;
  hobbyiqCardId: string | null;
  /** The identity's other slug key(s), matched on hobbyiqCardId in the same
   *  query: the un-numbered id beside its numbered twin (see the header).
   *  Duplicates of `hobbyiqCardId` are ignored. */
  hobbyiqCardIds?: readonly string[] | null;
  windowDays: number;
  nowMs?: number;
  /** CF-AS-OF-IS-AN-UPPER-BOUND (#1651). Backtest only: no sale at or after
   *  this instant may be read. Undefined in production — the bound is then
   *  absent from the query entirely. */
  asOfMs?: number | null;
}): Promise<ExactPoolRow[] | null> {
  const cont = getContainer();
  if (!cont) return null;
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - input.windowDays * 86400_000).toISOString();
  // POOL-1 (audit, 2026-09-03). An ADJUDICATED-WRONG row re-entered every live
  // pool through this reader. `flaggedWrong` / `excludedFromFmv` is the verdict
  // a human or a triage pass already recorded about a row -- soldCompsStore
  // writes BOTH flags together when a row is adjudicated, and every other read
  // path filters them (soldCompsGradeReader:104-105, soldCompsStore:1545,1664).
  // This reader, the one behind the unified engine, filtered neither: a row
  // flagged wrong and excluded from FMV was still read straight back into the
  // pool it had been removed from, so a repair that flagged a mis-filed
  // refractor row changed nothing about the price the engine published.
  //
  // The predicate is the store's (`!= true`, not `= false`): the flags are
  // absent on the overwhelming majority of rows, so the IS_DEFINED disjunct is
  // what keeps those rows in, and `!= true` additionally tolerates a row that
  // stored the flag as something other than a strict boolean.
  const parts: string[] = [
    "c.soldAt >= @cutoff",
    "c.price > 0",
    "(NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)",
    "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)",
    "(NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)",
  ];
  const params: Array<{ name: string; value: string | number | boolean | null }> = [
    { name: "@cutoff", value: cutoff },
  ];
  // The as-of ceiling. STRICTLY less than: a sale AT the evaluation instant is
  // the sale being predicted, so it is future data like any other.
  //
  // The cutoff is asOfCutoffString's second-truncated form, NOT toISOString():
  // `c.soldAt` is compared as a STRING and the pool stores the same instant as
  // "…+00:00", "…Z" and "….000Z", which sort in ordinal order rather than time
  // order. A `.000Z` ceiling admits the "+00:00" spelling of its own instant.
  // See asOfCutoff.ts — this was a live lookahead leak, not a hypothetical.
  const asOfMsIn = typeof input.asOfMs === "number" && Number.isFinite(input.asOfMs) ? input.asOfMs : null;
  if (asOfMsIn !== null) {
    parts.push("c.soldAt < @asOf");
    params.push({ name: "@asOf", value: asOfCutoffString(asOfMsIn) });
  }
  // Union: match by cardId OR hobbyiqCardId (covers cross-vendor storage),
  // and by the identity's twin key when the caller names one.
  //
  // H-4 (audit 2026-09-03). This OR is where the union physically happens, so
  // it is the last door the guard stands at. Callers above decide and record;
  // this is defense in depth for any caller the call graph has not reached —
  // an id that names a DIFFERENT PRODUCT from `cardId` is dropped from the
  // union here rather than silently welding two cards into one pool. A vendor
  // id names no product and is never dropped (that union is the point).
  const hiqIds: string[] = [];
  for (const v of [input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])]) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s || hiqIds.includes(s)) continue;
    if (s !== input.cardId && !mayUnionIdentities(input.cardId, s)) {
      console.warn(JSON.stringify({
        event: "identity_union_refused_cross_product",
        source: "exactPoolReader.readExactPoolRows",
        a: input.cardId, b: s,
        aProduct: productIdentityOf(input.cardId), bProduct: productIdentityOf(s),
        detail: "the halves of this union name different products; the read is single-sided",
      }));
      continue;
    }
    hiqIds.push(s);
  }
  const hiqClauses = hiqIds.map((_, i) => ` OR c.hobbyiqCardId = @hiq${i === 0 ? "" : i}`).join("");
  parts.push(`(c.cardId = @cid${hiqClauses})`);
  params.push({ name: "@cid", value: input.cardId });
  hiqIds.forEach((v, i) => params.push({ name: `@hiq${i === 0 ? "" : i}`, value: v }));
  try {
    const { resources } = await cont.items.query<ExactPoolRow>({
      query: `SELECT c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.priceAnomaly, c.contributorUserId, c.source, c.sellerHandle FROM c WHERE ${parts.join(" AND ")}`,
      parameters: params,
    }, { maxItemCount: 500 }).fetchAll();
    const rows = resources || [];
    // Belt and braces: re-check by PARSED time, so a row in some serialization
    // the string bound does not anticipate cannot reach the engine. No-op in
    // production (asOfMs null) and on every row the query already excluded.
    return asOfMsIn === null ? rows : rows.filter((r) => isBeforeAsOf(r.soldAt, asOfMsIn));
  } catch { return []; }
}
