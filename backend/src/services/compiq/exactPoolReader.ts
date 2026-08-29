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
  windowDays: number;
  nowMs?: number;
}): Promise<ExactPoolRow[] | null> {
  const cont = getContainer();
  if (!cont) return null;
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - input.windowDays * 86400_000).toISOString();
  const parts: string[] = ["c.soldAt >= @cutoff", "c.price > 0", "(NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)"];
  const params: Array<{ name: string; value: string | number | boolean | null }> = [
    { name: "@cutoff", value: cutoff },
  ];
  // Union: match by cardId OR hobbyiqCardId (covers cross-vendor storage).
  parts.push("(c.cardId = @cid" + (input.hobbyiqCardId ? " OR c.hobbyiqCardId = @hiq" : "") + ")");
  params.push({ name: "@cid", value: input.cardId });
  if (input.hobbyiqCardId) params.push({ name: "@hiq", value: input.hobbyiqCardId });
  try {
    const { resources } = await cont.items.query<ExactPoolRow>({
      query: `SELECT c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.priceAnomaly, c.contributorUserId, c.source FROM c WHERE ${parts.join(" AND ")}`,
      parameters: params,
    }, { maxItemCount: 500 }).fetchAll();
    return resources || [];
  } catch { return []; }
}
