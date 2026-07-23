// Smoke tests for the four vendor persistence pipelines (issue #722
// expansion). Focus on flag gating + no-op inputs. Full Cosmos-side
// integration is covered by observability once deployed.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isPersistVendorCatalogEnabled,
  persistVendorCatalog,
  persistVendorCatalogInBackground,
} from "../src/services/portfolioiq/persistVendorCatalog.service.js";
import {
  isPersistDailyPriceSeriesEnabled,
  persistDailyPriceSeries,
  persistDailyPriceSeriesInBackground,
} from "../src/services/portfolioiq/persistDailyPriceSeries.service.js";
import {
  isPersistActiveListingsEnabled,
  persistActiveListings,
  persistActiveListingsInBackground,
} from "../src/services/portfolioiq/persistActiveListings.service.js";
import {
  isPersistUserQuerySignalsEnabled,
  persistUserQuerySignals,
  persistUserQuerySignalsInBackground,
} from "../src/services/portfolioiq/persistUserQuerySignals.service.js";

beforeEach(() => {
  delete process.env.PERSIST_VENDOR_CATALOG_ENABLED;
  delete process.env.PERSIST_DAILY_PRICE_SERIES_ENABLED;
  delete process.env.PERSIST_ACTIVE_LISTINGS_ENABLED;
  delete process.env.PERSIST_USER_QUERY_SIGNALS_ENABLED;
});

describe("persistVendorCatalog — flag gate + empty input", () => {
  it("flag OFF → returns zero counts, no throw", async () => {
    expect(isPersistVendorCatalogEnabled()).toBe(false);
    const r = await persistVendorCatalog("cardhedge", [{ cardId: "abc", player: "Test" }]);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("flag ON + empty array → zeros", async () => {
    process.env.PERSIST_VENDOR_CATALOG_ENABLED = "true";
    expect(isPersistVendorCatalogEnabled()).toBe(true);
    const r = await persistVendorCatalog("cardhedge", []);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("background wrapper never throws", () => {
    process.env.PERSIST_VENDOR_CATALOG_ENABLED = "true";
    expect(() => persistVendorCatalogInBackground("cardhedge", [])).not.toThrow();
  });
});

describe("persistDailyPriceSeries — flag gate + empty input", () => {
  it("flag OFF → zeros", async () => {
    expect(isPersistDailyPriceSeriesEnabled()).toBe(false);
    const r = await persistDailyPriceSeries("cardhedge", "card-1", "Raw", [
      { closingDate: "2026-07-23", price: 100 },
    ]);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("flag ON + empty rows → zeros", async () => {
    process.env.PERSIST_DAILY_PRICE_SERIES_ENABLED = "true";
    const r = await persistDailyPriceSeries("cardhedge", "card-1", "Raw", []);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("background wrapper never throws", () => {
    process.env.PERSIST_DAILY_PRICE_SERIES_ENABLED = "true";
    expect(() => persistDailyPriceSeriesInBackground("cardhedge", "card-1", "Raw", [])).not.toThrow();
  });
});

describe("persistActiveListings — flag gate + empty input", () => {
  it("flag OFF → zeros", async () => {
    expect(isPersistActiveListingsEnabled()).toBe(false);
    const r = await persistActiveListings("ebay", []);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("background wrapper never throws", () => {
    process.env.PERSIST_ACTIVE_LISTINGS_ENABLED = "true";
    expect(() => persistActiveListingsInBackground("ebay", [])).not.toThrow();
  });
});

describe("persistUserQuerySignals — flag gate + anonymization", () => {
  it("flag OFF → zeros", async () => {
    expect(isPersistUserQuerySignalsEnabled()).toBe(false);
    const r = await persistUserQuerySignals([{ endpoint: "test", query: "test" }]);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("flag ON + empty array → zeros", async () => {
    process.env.PERSIST_USER_QUERY_SIGNALS_ENABLED = "true";
    const r = await persistUserQuerySignals([]);
    expect(r).toEqual({ inserted: 0, deduped: 0, skipped: 0 });
  });
  it("background wrapper never throws", () => {
    process.env.PERSIST_USER_QUERY_SIGNALS_ENABLED = "true";
    expect(() => persistUserQuerySignalsInBackground([{
      endpoint: "test", query: "test", userId: "user-123",
    }])).not.toThrow();
  });
});
