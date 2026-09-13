/**
 * CF-THE-LEGACY-SHORTCUT-NEVER-ASKED (Fable, 2026-09-13).
 *
 * `valueHoldingThroughOneEntry` never publishes a price without asking
 * `mayPublishPrice(identityBackingOf(...))` first (CF-WE-DONT-WANT-SELF-
 * DERIVED, Drew 2026-09-04). But four `PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED`
 * sites in portfolioStore.service.ts — legacy, pre-D17 "unified early-exit"
 * shortcuts that fire only when the one entry could not resolve a holding
 * (a `no-slug` holding whose only identity is a raw `cardId`/`hobbyiqCardId`)
 * — call `priceHoldingFromExactPool` directly. That function reads
 * `sold_comps` by id and has no notion of `card_catalog` provenance at all,
 * so those four sites persisted `valueSource: "observed"` for ANY id with
 * >= 1 sale, checklist-backed or not.
 *
 * Measured read-only against prod on 2026-09-13 (139 holdings, 12 users): 9
 * of them carried exactly this shape — a live `fairMarketValue` under an
 * exact-pool rung (`exact-pool-last-sale` / `exact-pool-projection` /
 * `exact-pool-leading-edge`), `valueSource: "observed"`, and NO catalog row
 * backing the priced id at all. Holding 69eab153 (Chipper Jones 1997 Metal
 * Universe #31, cardId `hiq:baseball:1997:skybox-metal-universe:31:base:no-auto`,
 * `importSource: "cardhedge"`) is the real shape this file pins against: the
 * SAME holding #1781's cost-basis-floor doctrine comment used to illustrate a
 * DIFFERENT defect on this identity two rulings ago (the floor was fixed; the
 * identity underneath it never was).
 *
 * `mayPublishFromLegacyExactPoolShortcut` is the fix: the one predicate every
 * one of the four sites now asks, of the id the pool was actually read under,
 * before it is allowed to publish. This file pins the predicate directly
 * (no HTTP, no app bootstrap) so a regression here fails fast; the end-to-end
 * shape (the four call sites actually asking it, and a full reprice cycle
 * refusing the number) is pinned in oneValuationPath.pin.test.ts and
 * oneValuationPath.contract.test.ts's "a slug the catalog does not hold, with
 * sales under it" case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const catalog = new Map<string, { source: string | null }>();

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => {
      const row = catalog.get(slug);
      if (!row) return null;
      return {
        playerName: null, year: null, setKey: null, setName: null, cardNumber: null,
        parallel: null, isAuto: null, sport: null, printRun: null, imageUrl: null,
        observedAt: null,
        source: row.source,
      };
    }),
  };
});

describe("mayPublishFromLegacyExactPoolShortcut — CF-THE-LEGACY-SHORTCUT-NEVER-ASKED", () => {
  beforeEach(() => { catalog.clear(); });

  // Live shape, holding 69eab153 (Chipper Jones 1997 Metal Universe #31):
  // priced $2 under exact-pool-last-sale, cardId names no catalog row at all.
  const CHIPPER = "hiq:baseball:1997:skybox-metal-universe:31:base:no-auto";
  // Live shape, holding 8b38c810/c8dfad0d (Marek Houston 2026 Bowman Chrome):
  // the holding's OWN cardId is not even hiq:-shaped — a bare vendor id that
  // the pool priced anyway.
  const VENDOR_ID = "1778477531904x850967262057528600";

  it("refuses an id the catalog holds no row for at all (no-catalog-row) — the Chipper Jones shape", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    // catalog map has nothing for CHIPPER — readCatalogIdentityBySlug returns null.
    expect(await mayPublishFromLegacyExactPoolShortcut(CHIPPER)).toBe(false);
  });

  it("refuses a bare vendor id (no-slug shape) without even attempting a catalog read", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    expect(await mayPublishFromLegacyExactPoolShortcut(VENDOR_ID)).toBe(false);
  });

  it("refuses null/undefined/blank ids", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    expect(await mayPublishFromLegacyExactPoolShortcut(null)).toBe(false);
    expect(await mayPublishFromLegacyExactPoolShortcut(undefined)).toBe(false);
    expect(await mayPublishFromLegacyExactPoolShortcut("   ")).toBe(false);
  });

  it("refuses an id whose only catalog row is self-derived (CF-WE-DONT-WANT-SELF-DERIVED) — the SAME string family the identity gate refuses everywhere else", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    catalog.set(CHIPPER, { source: "catalog-explode-actuals-2026-08-12" });
    expect(await mayPublishFromLegacyExactPoolShortcut(CHIPPER)).toBe(false);
    catalog.set(CHIPPER, { source: "user-verified" });
    expect(await mayPublishFromLegacyExactPoolShortcut(CHIPPER)).toBe(false);
  });

  it("MUTATION CHECK: publishes only for a genuine checklist-backed row", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    catalog.set(CHIPPER, { source: "checklistcenter-2026-08-29" });
    expect(await mayPublishFromLegacyExactPoolShortcut(CHIPPER)).toBe(true);
  });

  it("fails CLOSED on a catalog read error — an optional legacy shortcut is not grounds to skip the one identity check standing between a holding and an unbacked publish", async () => {
    vi.resetModules();
    vi.doMock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
      const actual = await importActual<Record<string, unknown>>();
      return { ...actual, readCatalogIdentityBySlug: vi.fn(async () => { throw new Error("cosmos throttled"); }) };
    });
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    expect(await mayPublishFromLegacyExactPoolShortcut(CHIPPER)).toBe(false);
    vi.doUnmock("../src/services/catalog/catalogMatcher.service.js");
  });
});
