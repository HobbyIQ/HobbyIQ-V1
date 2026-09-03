// CF-GRADE-CURVE-TEST-SEAM (2026-08-16).
//
// The raw sold_comps read behind the observed grade curve, split into its own
// module for ONE reason: so it can be mocked.
//
// observedGradeCurve.service used to fetch through cardhedge.client's
// getCardSales, and its 35 tests mocked that. On 2026-08-14 the service moved
// to reading sold_comps directly (CF-OWN-THE-DATA) and nothing updated the
// tests, so every one of them fed a function nobody called and asserted
// against an unmocked Cosmos — all 35 saw zero sales ("expected +0 to be 3").
// That is a stale seam, not a product defect, and it is 39% of the suite's
// chronic failures.
//
// Mocking "@azure/cosmos" instead was tried and made things WORSE: the service
// imports it dynamically inside the function, so a module mock hits every other
// Cosmos consumer in the graph too. The suite went 89 -> 107 failures and 80s
// -> 1591s as those consumers retried against the fake. Hence a seam of our
// own, narrow enough that mocking it touches nothing else.
//
// This module owns ONLY the query. Title rejection, filtering and shaping stay
// in the service, so tests that mock this still exercise the real IP/TTM/bulk
// -lot rules rather than bypassing them.

export interface RawGradeSaleRow {
  price: number;
  soldAt: string;
  source?: string | null;
  title?: string | null;
  /**
   * CF-BIN-WEIGHT-FIELD-RENAME (2026-08-16). sold_comps records this as
   * `listingType` ("buy it now" / "auction"); CardHedge called it `sale_type`.
   * When the grade curve moved off CH it kept asking for the old name, found
   * nothing, and hardcoded saleType: null — so the BIN-vs-auction weighting in
   * computeWeightedMedian has been silently inert ever since, on 518,595 rows
   * that carry the field.
   */
  listingType?: string | null;
  /** CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). Who contributed the row,
   *  so the curve tier can disclose how many of its samples are the viewer's
   *  own purchases. Selected here because it is the only field that
   *  distinguishes YOUR imported purchase from another user's -- source alone
   *  does not: "ebay-user-purchase" is someone's own purchase, not necessarily
   *  yours. */
  contributorUserId?: string | null;
}

/**
 * Structural type for the one thing this module does. A static
 * `import type { Container }` clashes with the dynamic import's ESM type
 * ("separate declarations of a private property 'clientContext'"), and the
 * dynamic import is required so the client is only constructed when a
 * connection string exists.
 */
interface QueryableContainer {
  items: {
    query<T>(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }): {
      fetchAll(): Promise<{ resources: T[] }>;
    };
  };
}

let _container: QueryableContainer | null = null;

async function getContainer(): Promise<QueryableContainer | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const { CosmosClient } = await import("@azure/cosmos");
  _container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container("sold_comps") as unknown as QueryableContainer;
  return _container;
}

/**
 * Every sale in the window for one card at one grade.
 *
 * Grade string parse: "Raw" -> gradeCompany null; "PSA 10" -> company PSA,
 * value 10; "PSA 10 Black Label" keeps the numeric 10.
 */
export async function readSoldCompsForGrade(
  cardId: string,
  grade: string,
  opts: { windowDays?: number } = {},
): Promise<RawGradeSaleRow[]> {
  const container = await getContainer();
  if (!container) return [];

  const gradeParts = grade.trim().split(/\s+/);
  let wantCompany: string | null = null;
  let wantValue: number | null = null;
  if (gradeParts[0] && gradeParts[0].toLowerCase() !== "raw") {
    wantCompany = gradeParts[0].toUpperCase();
    const v = Number(gradeParts[1]);
    if (Number.isFinite(v)) wantValue = v;
  }

  const windowDays = opts.windowDays ?? 180;
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // CF-GRADE-CURVE-DROP-THE-OR (Drew, 2026-08-14: "they have to match").
  // Branching rather than ORing cardId with hobbyiqCardId: one side is the
  // partition key and the other is not, so an OR lets Cosmos target NEITHER
  // and fans out across every partition. The two cases are disjoint by input —
  // a "hiq:" slug is the canonical tag, and a vendor id never appears in
  // hobbyiqCardId.
  const looksLikeHiqSlug = typeof cardId === "string" && cardId.startsWith("hiq:");
  const clauses: string[] = [
    "c.soldAt >= @cut",
    "c.price > 0",
    "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)",
    "(NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv = false)",
    looksLikeHiqSlug ? "c.hobbyiqCardId = @cid" : "c.cardId = @cid",
  ];
  const params: Array<{ name: string; value: string | number | null | boolean }> = [
    { name: "@cut", value: cutoff },
    { name: "@cid", value: cardId },
  ];
  if (wantCompany === null) {
    clauses.push("(c.gradeCompany = null OR NOT IS_DEFINED(c.gradeCompany))");
  } else {
    clauses.push("UPPER(c.gradeCompany) = @gc");
    params.push({ name: "@gc", value: wantCompany });
    if (wantValue !== null) {
      // gradeValue landed as both number and string historically.
      clauses.push("(c.gradeValue = @gv OR c.gradeValue = @gvStr)");
      params.push({ name: "@gv", value: wantValue });
      params.push({ name: "@gvStr", value: String(wantValue) });
    }
  }

  try {
    const { resources } = await container.items.query<RawGradeSaleRow>({
      query: `SELECT TOP 500 c.price, c.soldAt, c.source, c.title, c.listingType, c.contributorUserId
              FROM c WHERE ${clauses.join(" AND ")}
              ORDER BY c.soldAt DESC`,
      parameters: params,
    }).fetchAll();
    return resources ?? [];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "observed_grade_curve_sold_comps_query_failed",
      cardId, grade, error: (err as Error).message,
    }));
    return [];
  }
}
