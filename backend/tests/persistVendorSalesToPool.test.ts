// CF-PERSIST-VENDOR-LOOKUPS smoke tests (issue #722). Focus on the
// feature flag + input filtering. Full Cosmos-integration tests belong
// in a downstream integration harness (mocking the CosmosClient here
// would double-implement the store's guards).

import { describe, it, expect } from "vitest";
import {
  isPersistVendorLookupsEnabled,
  persistVendorSalesToPool,
  persistVendorSalesInBackground,
} from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

describe("isPersistVendorLookupsEnabled — env flag gate", () => {
  it("returns false when PERSIST_VENDOR_LOOKUPS_ENABLED is unset", () => {
    const prev = process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
    delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
    expect(isPersistVendorLookupsEnabled()).toBe(false);
    if (prev !== undefined) process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = prev;
  });
  it("returns false when set to 'false'", () => {
    const prev = process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
    process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = "false";
    expect(isPersistVendorLookupsEnabled()).toBe(false);
    if (prev !== undefined) process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = prev; else delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
  });
  it("returns true when set to 'true'", () => {
    const prev = process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
    process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = "true";
    expect(isPersistVendorLookupsEnabled()).toBe(true);
    if (prev !== undefined) process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = prev; else delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
  });
});

describe("persistVendorSalesToPool — no-op when flag OFF (default)", () => {
  it("returns zero counts when flag is not set", async () => {
    delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
    const r = await persistVendorSalesToPool("cardsight", [
      { title: "2026 Bowman Chrome Eric Hartman Auto #CPA-EHA", price: 100, soldAt: "2026-07-19" },
    ], { playerName: "Eric Hartman", cardYear: 2026 });
    expect(r.inserted).toBe(0);
    expect(r.deduped).toBe(0);
    // Skipped stays 0 because we bail early on the flag before iterating.
    expect(r.skipped).toBe(0);
  });
});

describe("persistVendorSalesToPool — empty / bad input handling (flag ON)", () => {
  it("empty array → all zeros", async () => {
    process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = "true";
    const r = await persistVendorSalesToPool("cardsight", [], { playerName: "Eric Hartman", cardYear: 2026 });
    expect(r.inserted).toBe(0);
    expect(r.deduped).toBe(0);
    expect(r.skipped).toBe(0);
    delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
  });
});

describe("persistVendorSalesInBackground — fire-and-forget shape", () => {
  it("returns void synchronously; catches internal errors without throwing", () => {
    process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = "true";
    // Should NOT throw even if Cosmos isn't reachable
    expect(() => persistVendorSalesInBackground("cardsight", [], {})).not.toThrow();
    delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
  });
});
