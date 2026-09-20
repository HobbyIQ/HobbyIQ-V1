/**
 * CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). recent-sales previously ran
 * its OWN local dedup (CF-RECENT-SALES-DEDUP, 2026-08-06): same price + the
 * sale's CALENDAR DAY, folded with `parallel`, no grade key. That is looser
 * than — and could disagree with — the one rule every other sold_comps
 * reader (and the FMV path itself, unifiedPricing.service.ts) now shares:
 * same gradeKey, same price to the cent, within 60 MINUTES, keep earliest.
 * This pins that the route now runs through `dedupeSoldComps` directly, and
 * that its identity-based dedup (sourceExternalId / contentHash — a
 * different, stronger signal) still works alongside it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Container } from "@azure/cosmos";
import type { CatalogRowResolution } from "../src/services/catalog/catalogIdentityResolver.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
delete process.env.COSMOS_CONNECTION_STRING;

const CARD = "hiq:baseball:2018:bowman-chrome:1:base:no-auto";

const h = vi.hoisted(() => ({
  catalog: new Map<string, CatalogRowResolution>(),
  rows: [] as Array<Record<string, unknown>>,
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
    resolveIdentityToCatalogRow: vi.fn(async () => ({ requested: CARD, id: null, kind: "none", twins: [], poolTwin: null })),
  };
});

import app from "../src/app";
import { _setContainerForTests } from "../src/services/portfolioiq/soldCompsStore.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const baseSale = (over: Record<string, unknown> = {}) => ({
  id: `s-${Math.random()}`, cardId: CARD, hobbyiqCardId: CARD, source: "cardhedge",
  price: 100, soldAt: daysAgo(2), title: "2018 Bowman Chrome #1 Base",
  parallel: null, gradeCompany: null, gradeValue: null, cardYear: 2018, cardNumber: "1",
  isAuto: false, printRun: null, imageUrl: null, sellerHandle: null, contributorUserId: null, confidence: 0.9,
  ...over,
});

beforeAll(() => {
  _setContainerForTests({
    items: {
      query() {
        return { async fetchAll() { return { resources: h.rows }; } };
      },
    },
  } as unknown as Container);
});
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const H = { "x-session-id": "test-sess" };
const get = () => request(app).get(`/api/compiq/cards/${encodeURIComponent(CARD)}/recent-sales?tier=all&days=365&limit=50`).set(H);

describe("GET /cards/:cardId/recent-sales -- dedupeSoldComps, not the old local heuristic", () => {
  it("collapses a CardHedge dual-id twin: same price, minutes apart, same grade", async () => {
    const twinTime = new Date(NOW - 2 * 86_400_000);
    h.rows = [
      baseSale({ id: "a", soldAt: twinTime.toISOString(), price: 250.00 }),
      baseSale({ id: "b", soldAt: new Date(twinTime.getTime() + 4 * 60_000).toISOString(), price: 250.00 }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("KEEPS two genuinely distinct sales: same price, hours apart", async () => {
    h.rows = [
      baseSale({ id: "a", soldAt: daysAgo(2), price: 250.00 }),
      baseSale({ id: "b", soldAt: new Date(NOW - 2 * 86_400_000 + 5 * 3_600_000).toISOString(), price: 250.00 }),
    ];
    const res = await get();
    expect(res.body.count).toBe(2);
  });

  it("KEEPS two different grades at the same price and moment (never collapses across grades)", async () => {
    const sameMoment = daysAgo(2);
    h.rows = [
      baseSale({ id: "a", soldAt: sameMoment, price: 250.00, gradeCompany: null, gradeValue: null }),
      baseSale({ id: "b", soldAt: sameMoment, price: 250.00, gradeCompany: "PSA", gradeValue: 10 }),
    ];
    const res = await get();
    expect(res.body.count).toBe(2);
  });

  it("identity dedup (sourceExternalId) still removes an exact re-ingest even outside the 60m window", async () => {
    h.rows = [
      baseSale({ id: "a", soldAt: daysAgo(10), price: 250.00, sourceExternalId: "ebay-item-999" }),
      baseSale({ id: "b", soldAt: daysAgo(2), price: 999.00, sourceExternalId: "ebay-item-999" }),
    ];
    const res = await get();
    // Same sourceExternalId under the same source -> one record ingested
    // twice with different (wrong) prices/dates; identity dedup keeps the
    // first seen regardless of the 60-minute price-coincidence rule.
    expect(res.body.count).toBe(1);
  });

  it("counts change ONLY by the twin: three real sales in, three survive", async () => {
    h.rows = [
      baseSale({ id: "a", soldAt: daysAgo(30), price: 100 }),
      baseSale({ id: "b", soldAt: daysAgo(20), price: 150 }),
      baseSale({ id: "c", soldAt: daysAgo(10), price: 200 }),
    ];
    const res = await get();
    expect(res.body.count).toBe(3);
  });

  // CF-RECENT-SALES-DEDUP-PER-PARALLEL (2026-09-20, review fix). No
  // ?parallel= on this route's `get()` helper -> readCompsByCardId returns
  // every parallel sharing this cardId in one array. Without bucketing by
  // parallel BEFORE dedupe, a real Blue Refractor sale and a real base sale
  // at the same price within the hour would wrongly collapse (gradeKey|price
  // has no parallel component).
  it("KEEPS a real Blue Refractor sale and a real base sale at the same price/moment (different parallels never collapse)", async () => {
    const sameMoment = daysAgo(2);
    h.rows = [
      baseSale({ id: "a", soldAt: sameMoment, price: 250.00, parallel: null }),
      baseSale({ id: "b", soldAt: sameMoment, price: 250.00, parallel: "Blue Refractor" }),
    ];
    const res = await get();
    expect(res.body.count).toBe(2);
  });

  it("still collapses a twin WITHIN one parallel once cross-parallel buckets are separated", async () => {
    const twinTime = new Date(NOW - 2 * 86_400_000);
    h.rows = [
      // A twin pair inside "Blue Refractor" -- must collapse to 1.
      baseSale({ id: "a", soldAt: twinTime.toISOString(), price: 250.00, parallel: "Blue Refractor" }),
      baseSale({ id: "b", soldAt: new Date(twinTime.getTime() + 4 * 60_000).toISOString(), price: 250.00, parallel: "Blue Refractor" }),
      // A genuinely distinct base-card sale at the SAME price/moment as the
      // twin's cluster anchor -- must survive as its own row, in its own
      // parallel bucket.
      baseSale({ id: "c", soldAt: twinTime.toISOString(), price: 250.00, parallel: null }),
    ];
    const res = await get();
    expect(res.body.count).toBe(2); // 1 (collapsed twin) + 1 (base sale)
  });
});
