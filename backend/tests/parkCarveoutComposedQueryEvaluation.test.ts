/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330), OWNER RULING round 2.
 *
 * REVIEW FINDING addressed here (round 1): the other reader tests in this PR
 * (bowmanBaseRefractorRoots.test.ts, parkedRowsExcludedFromReaders.test.ts,
 * vw3IncidentFourPools.test.ts) mock `fetchAll` to return exactly the rows
 * a real Cosmos container "would have already filtered to" -- which proves
 * the query TEXT contains the right substrings, but can never prove those
 * substrings actually compute the right answer against a given row, because
 * the mock never evaluates the WHERE clause at all.
 *
 * This file closes that gap: it captures the REAL composed query text (and
 * its parameters) exactly as `exactPoolReader.readExactPoolRows` builds it,
 * then evaluates that captured WHERE clause against fixture rows using
 * `evalCosmosQuery` (tests/support/cosmosWhereEvaluator.ts, a small real
 * Cosmos-SQL-subset evaluator, not a parser stand-in) -- proving the QUERY
 * ITSELF, not a mock of its result, admits or excludes each shape.
 *
 * OWNER RULING (round 2): a live production-shape check found two more
 * incident pools (2023 Topps #472 and #271 basketball) whose park reason is
 * BOTH-sides-backed, not neither-backed -- yet hobbyiqCardId is still the
 * right pricing id and the row must still recover. Cases 2 and 6-7 below
 * pin that directly: a Wembanyama-#472-shaped BOTH-sides row is ADMITTED via
 * hobbyiqCardId and EXCLUDED via the cardId branch, and a title-vertical-
 * veto row is admitted or excluded depending on whether the STATED vertical
 * agrees with hobbyiqCardId's own sport (the owner's one exception).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { evalCosmosQuery, type CosmosParam } from "./support/cosmosWhereEvaluator.js";

const TARGET_SLUG = "hiq:basketball:2023:topps:vw3:base:no-auto";
// The #472 incident shape: same product family, different card number, so
// mayUnionIdentities still allows the hiq-union param.
const HIQ_472 = "hiq:basketball:2023:topps:472:base:no-auto";
const CARDID_472_BASEBALL = "hiq:baseball:2023:topps:472:base:no-auto";

describe("R71: the COMPOSED exactPoolReader query, evaluated (not mocked) against real row shapes", () => {
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
        + "so RELOCATE would mint an identity from a sale.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  // OWNER RULING round 2: the #472/#271 incident shape. BOTH sides carry a
  // checklist-backed catalog row -- yet hobbyiqCardId (basketball) is still
  // the right pricing id, and the owner's rule admits it.
  it("2. BOTH-sides-backed park (the #472/#271 incident shape), matched via hobbyiqCardId -> ADMITTED", async () => {
    const { query, params } = await composedQueryFor(HIQ_472, HIQ_472);
    const row = {
      ...base,
      cardId: CARDID_472_BASEBALL,
      hobbyiqCardId: HIQ_472,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), "
        + "so the catalog cannot say which card this sale is.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  it("3. Title-vertical-veto park where the STATED vertical equals hobbyiqCardId's own sport -> ADMITTED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: TARGET_SLUG,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
        + "\"basketball\" but the only checklist-backed side is \"baseball\" (cardId=checklist-backed, hobbyiqCardId=no-catalog-row).",
    };
    // The title says basketball -- hobbyiqCardId's own sport -- so the
    // title does NOT contradict the pricing id, and the owner's rule admits.
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  it("4. Title-vertical-veto park where the STATED vertical equals cardId's (wrong) sport -> EXCLUDED", async () => {
    const nonSportTarget = "hiq:baseball:2024:topps:sho-5:base:no-auto";
    const { query, params } = await composedQueryFor(nonSportTarget, nonSportTarget);
    const row = {
      ...base,
      cardId: "hiq:non-sport:2024:topps:sho-5:base:no-auto",
      hobbyiqCardId: nonSportTarget,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
        + "\"non-sport\" but the only checklist-backed side is \"baseball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed).",
    };
    // The title says "non-sport" -- cardId's (wrong) side, not baseball
    // (hobbyiqCardId's own sport) -- the sale's own title contradicts the
    // pricing id, the owner's one exception, so it stays excluded.
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });

  it("5. duplicate-partition-copy park, matched via hobbyiqCardId -> EXCLUDED", async () => {
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

  it("6. Unflagged row (no identityUnverified at all) -> ADMITTED", async () => {
    const { query, params } = await composedQueryFor(TARGET_SLUG, TARGET_SLUG);
    const row = {
      ...base,
      cardId: TARGET_SLUG,
      hobbyiqCardId: TARGET_SLUG,
    };
    expect(evalCosmosQuery(query, row, params)).toBe(true);
  });

  it("7. The #472 BOTH-sides row, queried by its WRONG (cardId/baseball) side -> EXCLUDED", async () => {
    // Same row as case 2, but this time the caller queries the baseball
    // cardId directly with an hobbyiqCardId union param that names a
    // DIFFERENT card -- the row can only match via c.cardId = @cid, which
    // must never get the carve-out, regardless of how permissive the
    // reason-class predicate is.
    const { query, params } = await composedQueryFor(
      CARDID_472_BASEBALL,
      "hiq:baseball:2023:topps:472:base:num-499",
    );
    const row = {
      ...base,
      cardId: CARDID_472_BASEBALL,
      hobbyiqCardId: HIQ_472,
      identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), "
        + "so the catalog cannot say which card this sale is.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });

  it("8. SANITY: the VW3 row (case 1), queried by the WRONG side (matched only via cardId), stays EXCLUDED", async () => {
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
        + "so RELOCATE would mint an identity from a sale.",
    };
    expect(evalCosmosQuery(query, row, params)).toBe(false);
  });
});
