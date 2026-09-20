/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330).
 *
 * REVIEW FINDING addressed here: the other reader tests in this PR
 * (bowmanBaseRefractorRoots.test.ts, parkedRowsExcludedFromReaders.test.ts,
 * vw3IncidentFourPools.test.ts) mock `fetchAll` to return exactly the rows
 * a real Cosmos container "would have already filtered to" -- which proves
 * the query TEXT contains the right substrings, but can never prove those
 * substrings actually compute the right answer against a given row, because
 * the mock never evaluates the WHERE clause at all.
 *
 * This file closes that gap: it captures the REAL composed query text (and
 * its parameters) exactly as `exactPoolReader.readExactPoolRows` builds it,
 * then evaluates that captured WHERE clause against five fixture rows using
 * `evalCosmosQuery` (tests/support/cosmosWhereEvaluator.ts, a small real
 * Cosmos-SQL-subset evaluator, not a parser stand-in) -- proving the QUERY
 * ITSELF, not a mock of its result, admits or excludes each shape:
 *
 *   1. VW3 shape (neither-backed split, matched via hobbyiqCardId) -> ADMIT
 *   2. BOTH-sides-backed park (matched via hobbyiqCardId)           -> EXCLUDE
 *   3. Title-vertical-veto park (matched via hobbyiqCardId)         -> EXCLUDE
 *   4. duplicate-partition-copy park (matched via hobbyiqCardId)    -> EXCLUDE
 *   5. Unflagged row (no identityUnverified at all)                 -> ADMIT
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { evalCosmosQuery, type CosmosParam } from "./support/cosmosWhereEvaluator.js";

const TARGET_SLUG = "hiq:basketball:2023:topps:vw3:base:no-auto";

describe("R71: the COMPOSED exactPoolReader query, evaluated (not mocked) against five row shapes", () => {
  let captured: { query?: string; params?: CosmosParam[] };
  beforeEach(() => { captured = {}; vi.resetModules(); });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string; parameters: CosmosParam[] }) => {
                  captured.query = spec.query;
                  captured.params = spec.parameters;
                  return { fetchAll: async () => ({ resources: [] }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/exactPoolReader.js");
  }

  async function composedQueryFor(cardId: string, hobbyiqCardId: string | null) {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId, hobbyiqCardId, windowDays: 90 });
    if (!captured.query || !captured.params) throw new Error("no query captured");
    return { query: captured.query, params: captured.params };
  }

  // All five fixtures share the base fields every clause in the query
  // besides the identityUnverified one needs to pass, so only the
  // identityUnverified-relevant fields vary per case.
  const base = { soldAt: new Date().toISOString(), price: 25 };

  it("1. VW3 shape: neither-backed split, matched via hobbyiqCardId -> ADMITTED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
        + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
        + "without asserting which card it belongs to.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  it("2. BOTH-sides-backed park, matched via hobbyiqCardId -> EXCLUDED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), "
        + "so the catalog cannot say which card this sale is.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });

  it("3. Title-vertical-veto park, matched via hobbyiqCardId -> EXCLUDED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: "hiq:non-sport:2023:topps:vw3:base:no-auto",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
        + "\"non-sport\" but the only checklist-backed side is \"basketball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed). "
        + "identityUnverified keeps the row out of EVERY pool without asserting which card it belongs to.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });

  it("4. duplicate-partition-copy park, matched via hobbyiqCardId -> EXCLUDED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: "tca-ebay::287176471011",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason: "duplicate-partition-copy: PARK-NEITHER-QUALIFIES",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });

  it("5. Unflagged row (no identityUnverified at all) -> ADMITTED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: TARGET_SLUG,
      hobbyiqCardId: TARGET_SLUG,
    };
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  it("SANITY: the VW3 row (case 1), queried by the WRONG side (matched only via cardId), stays EXCLUDED", async () => {
    // Same row as case 1, but this time the caller queries the baseball
    // cardId directly with an hobbyiqCardId union param that names a
    // DIFFERENT card -- the row can only match via c.cardId = @cid, which
    // must never get the carve-out.
    const { query, params } = await composedQueryFor(
      "hiq:baseball:2023:topps:vw-3:base:no-auto",
      "hiq:baseball:2023:topps:vw-3:base:num-499",
    );
    const row = {
      ...base,
      cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
        + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
        + "without asserting which card it belongs to.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });
});
