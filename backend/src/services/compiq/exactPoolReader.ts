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
 */
import { CosmosClient, type Container } from "@azure/cosmos";

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
  // Union: match by cardId OR hobbyiqCardId (covers cross-vendor storage),
  // and by the identity's twin key when the caller names one.
  const hiqIds: string[] = [];
  for (const v of [input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])]) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !hiqIds.includes(s)) hiqIds.push(s);
  }
  const hiqClauses = hiqIds.map((_, i) => ` OR c.hobbyiqCardId = @hiq${i === 0 ? "" : i}`).join("");
  parts.push(`(c.cardId = @cid${hiqClauses})`);
  params.push({ name: "@cid", value: input.cardId });
  hiqIds.forEach((v, i) => params.push({ name: `@hiq${i === 0 ? "" : i}`, value: v }));
  try {
    const { resources } = await cont.items.query<ExactPoolRow>({
      query: `SELECT c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.priceAnomaly, c.contributorUserId, c.source FROM c WHERE ${parts.join(" AND ")}`,
      parameters: params,
    }, { maxItemCount: 500 }).fetchAll();
    return resources || [];
  } catch { return []; }
}
