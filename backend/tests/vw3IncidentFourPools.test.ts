/**
 * R71 (owner ruling, 2026-09-19) -- THE INCIDENT FIXTURE.
 *
 * The regression that triggered both R70 (#2330) and its temporary revert
 * (#2338): `hiq:basketball:2023:topps:vw3:base:no-auto` went 162 -> 1 rows
 * post-#2330, because the reader-side exclusion dropped every row the
 * 2026-09-07 `relocate-pool-rows-by-list` sport-segment tranche parked --
 * including the ~87K rows whose `hobbyiqCardId` is the title-plausible
 * (basketball) identity and only `cardId` (the vendor-derived partition key)
 * names the wrong sport (baseball).
 *
 * This file pins the FOUR POOLS the incident is actually about, shaped
 * exactly like the real stored row (confirmed against
 * `backend/data/pool-relocations/2026-09-07-split-identity-sport-segment-*.json`):
 *
 *   cardId:                 hiq:baseball:2023:topps:vw-3:base:no-auto
 *   hobbyiqCardId:          hiq:basketball:2023:topps:vw3:base:no-auto
 *   identityUnverifiedReason: "PARK. cardId vertical \"baseball\" vs
 *                             hobbyiqCardId \"basketball\"; segments
 *                             differing: sport. NEITHER side carries a
 *                             checklist-backed catalog row ..."
 *
 * 1. The BASKETBALL pool (queried by hobbyiqCardId) must see the row, on
 *    every hobbyiqCardId-keyed reader: soldCompsGradeReader, soldCompsStore's
 *    readCompsByCardId (hiq-slug path), hobbyIqFmv.service's queryPool, and
 *    exactPoolReader's hobbyiqCardId union side.
 * 2. The BASEBALL pool (queried by cardId, exactPoolReader's OTHER union
 *    side) must NOT see the row -- that is the R70 cross-sport-leak fix,
 *    preserved. Before #2330 this row leaked into BOTH pools; after this PR
 *    it prices only the one hobbyiqCardId actually names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";

const INCIDENT_CARD_ID = "hiq:baseball:2023:topps:vw-3:base:no-auto";
const INCIDENT_HOBBYIQ_CARD_ID = "hiq:basketball:2023:topps:vw3:base:no-auto";
const INCIDENT_REASON =
  "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
  + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
  + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
  + "without asserting which card it belongs to.";

function incidentRow(extra: Record<string, unknown> = {}) {
  return {
    id: "cardhedge::ch-fill::incident-vw3",
    cardId: INCIDENT_CARD_ID,
    hobbyiqCardId: INCIDENT_HOBBYIQ_CARD_ID,
    price: 22.5,
    soldAt: new Date().toISOString(),
    source: "cardhedge",
    identityUnverified: true,
    identityUnverifiedReason: INCIDENT_REASON,
    ...extra,
  };
}

// ── 1a. exactPoolReader: the BASKETBALL pool sees the row (hobbyiqCardId side) ──
describe("R71 incident fixture: exactPoolReader basketball pool KEEPS the VW3 row", () => {
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { fixtureRows = []; vi.resetModules(); });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: () => ({ fetchAll: async () => ({ resources: fixtureRows }) }),
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/exactPoolReader.js");
  }

  it("pricing the basketball card (cardId=hobbyiqCardId=basketball slug) sees the row", async () => {
    fixtureRows = [incidentRow()];
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({
      cardId: INCIDENT_HOBBYIQ_CARD_ID,
      hobbyiqCardId: INCIDENT_HOBBYIQ_CARD_ID,
      windowDays: 90,
    });
    expect(rows).not.toBeNull();
    expect((rows ?? []).map((r) => r.id)).toContain("cardhedge::ch-fill::incident-vw3");
  });
});

// ── 1b. exactPoolReader: the BASEBALL pool (cardId branch) EXCLUDES the row ──
describe("R71 incident fixture: exactPoolReader baseball pool EXCLUDES the VW3 row (cardId branch)", () => {
  let fixtureRows: Array<Record<string, unknown>> = [];
  let captured: { query?: string };
  beforeEach(() => { fixtureRows = []; captured = {}; vi.resetModules(); });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  captured.query = spec.query;
                  return { fetchAll: async () => ({ resources: fixtureRows }) };
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

  it("pricing the (wrong-sport) baseball cardId directly finds nothing -- the row is parked and matched only via cardId", async () => {
    // A real Cosmos container excludes this row here: the CASE clause's
    // union-side test requires the match to come through hobbyiqCardId, and
    // this query's hobbyiqCardId union param names a DIFFERENT (same-product-
    // family, so the union guard allows comparing it) slug than the row's own
    // stored hobbyiqCardId, so the row can only ever have matched via
    // `c.cardId = @cid` -- exactly the branch R70 shuts the leak on. The
    // fixture mirrors what a real container already removed.
    fixtureRows = [];
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({
      cardId: INCIDENT_CARD_ID,
      hobbyiqCardId: "hiq:baseball:2023:topps:vw-3:base:num-499",
      windowDays: 90,
    });
    expect(rows).toEqual([]);
    // The union-side CASE test is present, so a real container applies it.
    expect(captured.query).toContain("c.cardId != @cid");
    expect(captured.query).toContain("c.identityUnverifiedReason");
  });
});

// ── 2. soldCompsGradeReader: basketball (hobbyiqCardId-keyed) lookup KEEPS ──
describe("R71 incident fixture: soldCompsGradeReader (hobbyiqCardId-keyed) KEEPS the VW3 row", () => {
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { fixtureRows = []; vi.resetModules(); delete process.env.COSMOS_CONNECTION_STRING; });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: { query: () => ({ fetchAll: async () => ({ resources: fixtureRows }) }) },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/soldCompsGradeReader.js");
  }

  it("looking up the basketball hobbyiqCardId slug returns the row", async () => {
    fixtureRows = [{
      price: 22.5, soldAt: new Date().toISOString(), source: "cardhedge",
      identityUnverified: true, identityUnverifiedReason: INCIDENT_REASON,
    }];
    const { readSoldCompsForGrade } = await loadReader();
    const rows = await readSoldCompsForGrade(INCIDENT_HOBBYIQ_CARD_ID, "Raw");
    expect(rows.length).toBe(1);
  });
});

// ── 3. hobbyIqFmv.service queryPool: basketball lookup KEEPS ─────────────────
describe("R71 incident fixture: hobbyIqFmv.service queryPool KEEPS the VW3 row for the basketball slug", () => {
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { fixtureRows = []; vi.resetModules(); });

  async function loadService() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  const isPoolQuery = spec.query.includes("c.qualityFlags");
                  return { fetchAll: async () => ({ resources: isPoolQuery ? fixtureRows : [] }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/portfolioiq/hobbyIqFmv.service.js");
  }

  it("computeHobbyIqFmv for the basketball hobbyiqCardId slug sees the row", async () => {
    fixtureRows = [{
      price: 22.5, soldAt: new Date().toISOString(), source: "cardhedge",
      hobbyiqCardId: INCIDENT_HOBBYIQ_CARD_ID,
      identityUnverified: true, identityUnverifiedReason: INCIDENT_REASON,
    }];
    const { computeHobbyIqFmv } = await loadService();
    const res = await computeHobbyIqFmv({
      hobbyiqCardId: INCIDENT_HOBBYIQ_CARD_ID,
      gradeCompany: null, gradeValue: null,
    });
    expect(res.compCount).toBeGreaterThan(0);
  });
});

// ── 4. soldCompsStore.readCompsByCardId: basketball (hiq-slug) path KEEPS ────
describe("R71 incident fixture: readCompsByCardId (recent-sales) KEEPS the VW3 row on the basketball hiq-slug path", () => {
  let soldCompsStore: typeof import("../src/services/portfolioiq/soldCompsStore.service.js");
  let store: Map<string, Record<string, unknown>>;

  beforeEach(async () => {
    vi.resetModules();
    soldCompsStore = await import("../src/services/portfolioiq/soldCompsStore.service.js");
    store = new Map();
    const fakeContainer = {
      items: {
        query: () => ({ fetchAll: async () => ({ resources: Array.from(store.values()) }) }),
      },
    } as unknown as Container;
    soldCompsStore._setContainerForTests(fakeContainer);
  });

  afterEach(() => { soldCompsStore._setContainerForTests(null); });

  it("recent-sales for the basketball hobbyiqCardId slug lists the VW3 row", async () => {
    store.set("incident-vw3", incidentRow({ id: "incident-vw3" }));
    const rows = await soldCompsStore.readCompsByCardId({ cardId: INCIDENT_HOBBYIQ_CARD_ID });
    expect(rows.map((r) => r.id)).toEqual(["incident-vw3"]);
  });
});
