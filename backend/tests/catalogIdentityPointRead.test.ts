/**
 * CF-A-POINT-READ-IS-NOT-A-SCAN (Fable, 2026-09-15).
 *
 * catalogMatcher.readCatalogIdentityBySlug filtered on c.id — which IS
 * card_catalog's partition key, since the container partitions on /cardId and
 * every checklist-minted row carries cardId === id — and then issued it as a
 * CROSS-PARTITION query anyway. oneValuationPath.resolveValuationIdentity
 * calls this once per identity priced, so every valuation fanned out across
 * every physical partition to fetch one document it could have addressed
 * directly.
 *
 * The fix walks the ladder cardCatalog.getCatalogEntry already walks for the
 * same container: point read at the row's own address, then at the None
 * partition key (rows minted with no cardId live there — user-verified, see
 * catalogRowOps.nonePartitionKey), and only then the scan, which is the sole
 * way to reach a row homed under a FOREIGN cardId.
 *
 * These pins hold all three rungs and, most importantly, that the RESULT SHAPE
 * did not change: the same identity fields come back whichever rung answers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SLUG = "hiq:baseball:2024:bowman-chrome:1:base:no-auto";

/** The row every rung returns, so the shape assertion is rung-independent. */
const ROW = {
  id: SLUG,
  playerName: "Shohei Ohtani",
  cardYear: 2024,
  year: 2024,
  setKey: "bowman-chrome",
  setName: "Bowman Chrome",
  cardNumber: "1",
  parallel: "Base",
  isAuto: false,
  sport: "baseball",
  printRun: 150,
  imageUrl: "https://example.invalid/a.jpg",
  source: "checklist",
  observedAt: "2026-08-27T00:00:00.000Z",
};

const itemRead = vi.fn();
const queryFetchAll = vi.fn();
const item = vi.fn(() => ({ read: itemRead }));
const query = vi.fn(() => ({ fetchAll: queryFetchAll }));

vi.mock("@azure/cosmos", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class FakeCosmosClient {
    database() { return { container: () => ({ item, items: { query } }) }; }
  }
  return { ...actual, CosmosClient: FakeCosmosClient };
});

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING
  ?? "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdC1rZXktbm90LWEtc2VjcmV0;";

const { readCatalogIdentityBySlug } =
  await import("../src/services/catalog/catalogMatcher.service.js");

/** The identity contract every rung must satisfy. */
function expectTheIdentity(result: unknown) {
  expect(result).toMatchObject({
    playerName: "Shohei Ohtani",
    year: 2024,
    setKey: "bowman-chrome",
    setName: "Bowman Chrome",
    cardNumber: "1",
    parallel: "Base",
    isAuto: false,
    sport: "baseball",
    printRun: 150,
    source: "checklist",
    observedAt: "2026-08-27T00:00:00.000Z",
  });
}

const notFound = () => {
  const err = new Error("Entity with the specified id does not exist in the system.");
  (err as { code?: number }).code = 404;
  throw err;
};

beforeEach(() => {
  itemRead.mockReset();
  queryFetchAll.mockReset();
  item.mockClear();
  query.mockClear();
});

describe("a slug this container partitions by is fetched, not scanned", () => {
  it("answers from a POINT READ and issues no query at all", async () => {
    itemRead.mockResolvedValueOnce({ resource: ROW });

    const result = await readCatalogIdentityBySlug(SLUG);

    expectTheIdentity(result);
    // MUTATION CHECK: pre-fix this was 1 — a cross-partition fan-out on every
    // valuation, for a document addressable by its own partition key.
    expect(query).not.toHaveBeenCalled();
    expect(item).toHaveBeenCalledWith(SLUG, SLUG);
  });

  it("falls back to the None partition key for a row minted without a cardId", async () => {
    itemRead.mockImplementationOnce(notFound);          // rung 1: own address
    itemRead.mockResolvedValueOnce({ resource: ROW });  // rung 2: None pk

    const result = await readCatalogIdentityBySlug(SLUG);

    expectTheIdentity(result);
    // Rows with no cardId live at Cosmos's None partition key, so rung 1
    // cannot see them. Without this rung the change would have hidden live
    // rows behind a 404 — the exact failure mode of pkOf = cardId ?? id.
    expect(item).toHaveBeenNthCalledWith(2, SLUG, expect.anything());
    expect(query).not.toHaveBeenCalled();
  });

  it("still scans for a row homed under a FOREIGN cardId", async () => {
    itemRead.mockImplementationOnce(notFound);  // rung 1
    itemRead.mockImplementationOnce(notFound);  // rung 2
    queryFetchAll.mockResolvedValueOnce({ resources: [ROW] });

    const result = await readCatalogIdentityBySlug(SLUG);

    expectTheIdentity(result);
    // The scan is the ONLY way to reach a row whose cardId is a vendor id
    // inherited from the grade explode. Dropping it would have made the
    // optimisation lose rows — which is the thing an optimisation may never do.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns null when no rung finds the row", async () => {
    itemRead.mockImplementationOnce(notFound);
    itemRead.mockImplementationOnce(notFound);
    queryFetchAll.mockResolvedValueOnce({ resources: [] });

    expect(await readCatalogIdentityBySlug(SLUG)).toBeNull();
  });

  it("refuses a non-hiq slug without touching Cosmos", async () => {
    expect(await readCatalogIdentityBySlug("1727053918585x")).toBeNull();
    expect(item).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

/**
 * THE EQUIVALENCE PROOF, on the rows measured in prod on 2026-09-15.
 *
 * card_catalog partitions on /cardId, NOT /id — read directly:
 *   resource.partitionKey -> { kind: Hash, paths: ["/cardId"] }
 *
 * So item(id, id) is only the right address when cardId === id, and a bare
 * point read would silently miss every row where it is not. Sampling prod with
 * "SELECT TOP 2000 c.id, c.cardId FROM c WHERE NOT IS_DEFINED(c.cardId) OR
 * c.cardId != c.id" returned 2,000 rows, of which exactly 14 are hiq: slugs
 * (the only population this function will answer about) and 0 had an absent
 * cardId. The other 1,986 are vendor-keyed ids this function refuses before
 * touching Cosmos.
 *
 * These are two of those fourteen, verbatim. Missing them would not be a slow
 * lookup — it would be a CHANGED CLASSIFICATION, and on the ingest path that
 * is a wrong write. This is the case that says the scan must stay.
 */
describe("a row homed under a foreign cardId is still found — verbatim prod rows", () => {
  const FOREIGN_CARDID_ROWS = [
    {
      id: "hiq:baseball:2022:panini-donruss:116:base:no-auto:bgs-10",
      cardId: "1685285255353x532412755023418400",
      what: "a graded child carrying its vendor parent's cardId",
    },
    {
      id: "hiq:baseball:2018:bowman-chrome:bcp150:base:no-auto",
      cardId: "hiq:baseball:2018:bowman-chrome-mega-box:bcp150:base:no-auto",
      what: "a mega-box twin carrying the other product's cardId",
    },
  ];

  for (const row of FOREIGN_CARDID_ROWS) {
    it("finds " + row.what, async () => {
      // Cosmos answers a point read at the WRONG partition with 404, which is
      // precisely what both point-read rungs get for these rows.
      itemRead.mockImplementationOnce(notFound);
      itemRead.mockImplementationOnce(notFound);
      queryFetchAll.mockResolvedValueOnce({
        resources: [{ ...ROW, id: row.id, cardId: row.cardId }],
      });

      const result = await readCatalogIdentityBySlug(row.id);

      // MUTATION CHECK: delete the scan rung and this is null — the row reads
      // as "no such card" and the caller classifies a real identity as absent.
      expect(result).not.toBeNull();
      expectTheIdentity(result);
      expect(query).toHaveBeenCalledTimes(1);
    });
  }

  it("the scan is unconditional whenever both point reads miss", async () => {
    itemRead.mockImplementation(notFound);
    queryFetchAll.mockResolvedValue({ resources: [] });

    await readCatalogIdentityBySlug("hiq:baseball:2024:topps:1:base:no-auto");

    // No short-circuit, no heuristic about which slugs "look like" they have a
    // foreign cardId. If the cheap rungs did not answer, the old query runs —
    // so this change can only ever make a lookup faster, never narrower.
    expect(query).toHaveBeenCalledTimes(1);
  });
});
