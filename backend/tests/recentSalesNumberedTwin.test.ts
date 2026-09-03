/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3): the card page
 * asks GET /api/compiq/cards/:cardId/recent-sales with the holding's id. For
 * hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto that answered count 0 while
 * …:num-499 — the only catalog row — had 35 sales. The route now resolves the id once,
 * reads under the id AND its one twin (the pool is keyed both ways until the D29
 * fleet re-keys it — …:cpa-sha:green:auto has 14 sales under the un-numbered key and
 * 0 under the twin; a swap read 0), and says so (additive fields; `sales` and
 * `byGrade` unchanged).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Container } from "@azure/cosmos";
import type { CatalogRowResolution } from "../src/services/catalog/catalogIdentityResolver.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
delete process.env.COSMOS_CONNECTION_STRING;

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const AMBIG = "hiq:baseball:2024:bowman-chrome:cpa-wj:refractor:auto";
const VENDOR = "1778814561816x835862652021336800";

const h = vi.hoisted(() => ({
  catalog: new Map<string, CatalogRowResolution>(),
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ query: string; parameters: Array<{ name: string; value: unknown }> }>,
}));

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user", email: "t@t", username: null, fullName: null,
      plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    resolveIdentityToCatalogRow: vi.fn(async (slug: string) =>
      h.catalog.get(slug) ?? { requested: slug, id: null, kind: "none", twins: [], poolTwin: null }),
  };
});

import app from "../src/app";
import { _setContainerForTests } from "../src/services/portfolioiq/soldCompsStore.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sale = (slug: string, i: number) => ({
  id: `tca-ebay::${slug}::${i}`, cardId: "ch-vendor-row", hobbyiqCardId: slug, source: "tca-ebay",
  price: 100 + i, soldAt: daysAgo(i + 1), title: `2025 Bowman Draft Max Williams Refractor Auto /499 #${i}`,
  parallel: "Refractor", gradeCompany: null, gradeValue: null, cardYear: 2025, cardNumber: "CPA-MWI",
  isAuto: true, printRun: 499, imageUrl: null, sellerHandle: null, contributorUserId: null, confidence: 0.9,
});

beforeAll(() => {
  _setContainerForTests({
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        h.queries.push(spec);
        const keys = spec.parameters.filter((p) => p.name === "@cid" || p.name === "@cid1").map((p) => p.value);
        return { async fetchAll() { return { resources: h.rows.filter((r) => keys.includes(r.hobbyiqCardId) || keys.includes(r.cardId)) }; } };
      },
    },
  } as unknown as Container);
});
beforeEach(() => {
  h.queries.length = 0;
  h.rows = Array.from({ length: 35 }, (_, i) => sale(MWI_499, i));
  h.catalog = new Map<string, CatalogRowResolution>([
    // The prod shape (read-only, 2026-08-30): the catalog holds …:num-499 and
    // NOT its stem, so poolTwin points the other way for each — the union is
    // the same two keys whichever form the card page is opened at.
    [MWI, { requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499], poolTwin: MWI_499 }],
    [MWI_499, { requested: MWI_499, id: MWI_499, kind: "exact", twins: [], poolTwin: MWI }],
    [AMBIG, { requested: AMBIG, id: null, kind: "ambiguous", twins: [`${AMBIG}:num-10`, `${AMBIG}:num-499`], poolTwin: null }],
  ]);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const H = { "x-session-id": "test-sess" };
const get = (id: string) => request(app).get(`/api/compiq/cards/${encodeURIComponent(id)}/recent-sales?tier=all&days=365&limit=50`).set(H);

describe("GET /cards/:cardId/recent-sales -- an un-numbered id reads itself AND its numbered twin", () => {
  it("count 35, requestedCardId = the un-numbered id, resolvedCardId = …:num-499, poolCardIds = both, identityKind numbered-twin", async () => {
    const res = await get(MWI);
    expect(res.status).toBe(200);
    // Mutation check: before, the read matched the id as given -> count 0.
    expect(res.body.count).toBe(35);
    expect(res.body.requestedCardId).toBe(MWI);
    expect(res.body.resolvedCardId).toBe(MWI_499);
    expect(res.body.poolCardIds).toEqual([MWI, MWI_499]);
    expect(res.body.identityKind).toBe("numbered-twin");
    // One read, keyed on both; the resolver was consulted by the route and handed down, not run twice.
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].parameters.find((p) => p.name === "@cid")?.value).toBe(MWI);
    expect(h.queries[0].parameters.find((p) => p.name === "@cid1")?.value).toBe(MWI_499);
    expect(h.queries[0].query).not.toMatch(/STARTSWITH/);
  });
  it("the un-numbered key's own sales are listed too: 14 under the id and 0 under the twin -> 14; both -> 49", async () => {
    const own = Array.from({ length: 14 }, (_, i) => ({ ...sale(MWI, i + 100), printRun: null }));
    h.rows = own;
    // Mutation check: the swap (read the twin only) answered count 0 here.
    expect((await get(MWI)).body.count).toBe(14);
    h.rows = [...own, ...Array.from({ length: 35 }, (_, i) => sale(MWI_499, i))];
    const res = await get(MWI);
    expect(res.body.count).toBe(49);
    expect(res.body.sales).toHaveLength(49);
    expect(res.body.poolCardIds).toEqual([MWI, MWI_499]);
  });
  it("the existing shapes are unchanged: a flat `sales` list and `byGrade` tiers", async () => {
    const res = await get(MWI);
    expect(res.body.windowDays).toBe(365);
    expect(Array.isArray(res.body.sales)).toBe(true);
    expect(res.body.sales).toHaveLength(35);
    // CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03) adds `isOwn` + `ownLabel`:
    // the viewer's own imported purchase is LISTED like any other sale and
    // says whose it is, instead of being filtered out of the list.
    expect(Object.keys(res.body.sales[0]).sort()).toEqual([
      "cardId", "cardNumber", "cardYear", "confidence", "confidenceBand", "confidenceExplain", "confidenceScore",
      "contributorUserId", "gradeCompany", "gradeValue", "id", "imageUrl", "isOwn", "ownLabel", "parallel", "price", "sellerHandle", "soldAt", "source", "title",
    ]);
    expect(res.body.byGrade).toMatchObject([{ grader: "Raw", count: 35 }]);
    expect(res.body.byGrade[0].sales).toHaveLength(35);
  });
  // REFUTED IN ROUND 2 and rewritten: this asserted the numbered id was read
  // ALONE (poolCardIds [MWI_499]). That is precisely the reverse-case drop —
  // the stem's sales went unlisted, and priceHoldingFromExactPool, which
  // unions both keys, then disagreed with this route. It reads BOTH.
  it("the numbered id itself answers the same 35 — identityKind exact, and the stem is unioned in", async () => {
    const res = await get(MWI_499);
    expect(res.body.count).toBe(35);
    expect(res.body.resolvedCardId).toBe(MWI_499);
    expect(res.body.poolCardIds).toEqual([MWI_499, MWI]);
    expect(res.body.identityKind).toBe("exact");
  });
});

describe("GET /cards/:cardId/recent-sales -- no guess on two twins, no resolve for a vendor id", () => {
  it("an ambiguous id returns count 0 with identityKind ambiguous and resolvedCardId = the id as given", async () => {
    const res = await get(AMBIG);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.identityKind).toBe("ambiguous");
    expect(res.body.resolvedCardId).toBe(AMBIG);
    expect(res.body.poolCardIds).toEqual([AMBIG]);
    expect(h.queries[0].parameters.find((p) => p.name === "@cid")?.value).toBe(AMBIG);
    expect(h.queries[0].parameters.find((p) => p.name === "@cid1")).toBeUndefined();
  });
  it("an unresolved id (the catalog could not be asked) reads as given: identityKind unresolved, count from its own key", async () => {
    h.rows = Array.from({ length: 3 }, (_, i) => ({ ...sale(MWI, i), printRun: null }));
    h.catalog.set(MWI, { requested: MWI, id: null, kind: "unresolved", twins: [], error: "429", poolTwin: null });
    const res = await get(MWI);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.identityKind).toBe("unresolved");
    expect(res.body.resolvedCardId).toBe(MWI);
    expect(res.body.poolCardIds).toEqual([MWI]);
  });
  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, SYMMETRIC (round-2 refutation): the
  // card page opened at the NUMBERED form — what this branch's own writers
  // leave on a holding — lists the stem's sales too. Measured read-only,
  // 2025 bowman-draft: 8 of 200 numbered ids whose stem has no catalog row
  // carry rows under the stem, three of them with ZERO under the numbered id.
  it("REVERSE: the numbered form lists the stem's sales — same union, same count, both keys reported", async () => {
    h.rows = Array.from({ length: 14 }, (_, i) => sale(MWI, i));
    const res = await get(MWI_499);
    expect(res.status).toBe(200);
    // Mutation check: round 2 read …:num-499 alone here and answered count 0.
    expect(res.body.count).toBe(14);
    expect(res.body.requestedCardId).toBe(MWI_499);
    expect(res.body.resolvedCardId).toBe(MWI_499);
    expect(res.body.poolCardIds).toEqual([MWI_499, MWI]);
    expect(h.queries[0].parameters.find((p) => p.name === "@cid1")?.value).toBe(MWI);
    expect(h.queries[0].query).not.toMatch(/STARTSWITH/);
  });
  it("REVERSE: the two forms of one card list the SAME sales — an FMV can never cite more comps than are listed", async () => {
    h.rows = [...Array.from({ length: 14 }, (_, i) => sale(MWI, i)), ...Array.from({ length: 35 }, (_, i) => sale(MWI_499, i + 100))];
    const fromStem = await get(MWI);
    const fromNumbered = await get(MWI_499);
    expect(fromStem.body.count).toBe(49);
    expect(fromNumbered.body.count).toBe(49);
    expect([...fromStem.body.poolCardIds].sort()).toEqual([...fromNumbered.body.poolCardIds].sort());
  });
  it("a vendor id: identityKind null, resolvedCardId = the id, partition-scoped read as before", async () => {
    h.rows = [{ ...sale(MWI_499, 0), cardId: VENDOR, hobbyiqCardId: null }];
    const res = await get(VENDOR);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.identityKind).toBeNull();
    expect(res.body.requestedCardId).toBe(VENDOR);
    expect(res.body.resolvedCardId).toBe(VENDOR);
    expect(res.body.poolCardIds).toEqual([VENDOR]);
    expect(h.queries[0].query).toMatch(/c\.cardId = @cid/);
  });
});
