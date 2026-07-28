// CF-CARD-CATALOG (Drew, 2026-07-28). Pinning tests for the derivation
// helper (pure, no Cosmos), plus surface tests that the module's
// silent-safe when Cosmos is absent.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  deriveCatalogEntry,
  getCatalogEntry,
  upsertCatalogEntry,
  countCatalogEntries,
} from "../src/services/portfolioiq/cardCatalog.service.js";

describe("cardCatalog — deriveCatalogEntry", () => {
  it("real Hartman Gold Refractor Auto /50 → canonical entry", () => {
    const e = deriveCatalogEntry({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman Chrome",
      cardNumber: "CPA-EHA",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
      playerName: "Eric Hartman",
      source: "seed",
      confidence: 0.9,
    });
    expect(e).not.toBeNull();
    expect(e!.id).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:gold-refractor:auto:num-50");
    expect(e!.sport).toBe("baseball");
    expect(e!.cardNumber).toBe("CPA-EHA");
    expect(e!.parallelSlug).toBe("gold-refractor");
    expect(e!.playerSlug).toBe("eric-hartman");
    expect(e!.printRun).toBe(50);
    expect(e!.vendorIds).toEqual({});
  });

  it("preserves vendorIds cross-reference", () => {
    const e = deriveCatalogEntry({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman Chrome",
      cardNumber: "CPA-EHA",
      parallel: "Blue Refractor",
      isAuto: true,
      printRun: 150,
      playerName: "Eric Hartman",
      source: "ch-catalog",
      confidence: 0.85,
      vendorIds: { cardhedge: "1778542140951x283396404010038530" },
    });
    expect(e!.vendorIds).toEqual({ cardhedge: "1778542140951x283396404010038530" });
    expect(e!.source).toBe("ch-catalog");
  });

  it("player name with punctuation slugifies cleanly", () => {
    const e = deriveCatalogEntry({
      sport: "baseball",
      year: 2025,
      setKey: "Topps",
      cardNumber: "1",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Ken Griffey Jr.",
      source: "seed",
      confidence: 0.8,
    });
    expect(e!.playerSlug).toBe("ken-griffey-jr");
  });

  it("insufficient identity → null (no phantom catalog entries)", () => {
    expect(deriveCatalogEntry({
      sport: "baseball",
      year: null,
      setKey: "Bowman",
      cardNumber: "1",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Test Player",
      source: "seed",
      confidence: 0.5,
    })).toBeNull();

    expect(deriveCatalogEntry({
      sport: "baseball",
      year: 2026,
      setKey: "",
      cardNumber: "1",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Test Player",
      source: "seed",
      confidence: 0.5,
    })).toBeNull();

    expect(deriveCatalogEntry({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Test Player",
      source: "seed",
      confidence: 0.5,
    })).toBeNull();

    expect(deriveCatalogEntry({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "1",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "",
      source: "seed",
      confidence: 0.5,
    })).toBeNull();
  });
});

describe("cardCatalog — silent-safe surface when Cosmos absent", () => {
  const restore = process.env.COSMOS_CONNECTION_STRING;
  beforeAll(() => { process.env.COSMOS_CONNECTION_STRING = ""; });
  afterAll(() => { process.env.COSMOS_CONNECTION_STRING = restore ?? ""; });

  it("getCatalogEntry returns null instead of throwing", async () => {
    expect(await getCatalogEntry("hiq:baseball:2026:bowman:1:base:no-auto")).toBeNull();
  });

  it("upsertCatalogEntry returns null instead of throwing", async () => {
    const result = await upsertCatalogEntry({
      id: "hiq:baseball:2026:bowman:1:base:no-auto",
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "1",
      parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null,
      playerName: "Test Player", playerSlug: "test-player",
      vendorIds: {}, source: "seed", confidence: 0.5,
    });
    expect(result).toBeNull();
  });

  it("countCatalogEntries returns 0", async () => {
    expect(await countCatalogEntries()).toBe(0);
  });

  it("getCatalogEntry rejects non-hiq slugs", async () => {
    expect(await getCatalogEntry("")).toBeNull();
    expect(await getCatalogEntry("cardhedge::123")).toBeNull();
  });
});
