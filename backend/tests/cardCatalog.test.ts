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
    // CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT (#2064/#2069, 2026-09-12).
    // Eric Hartman's CPA-EHA is a genuine 2026 BOWMAN-only number
    // (2026-bowman-full.csv lists him; 2026-bowman-chrome.csv does not — the
    // same shape as Marconi German's CPA-MG and Owen Carey's CPA-OC), so a
    // seed carrying setKey "Bowman Chrome" now correctly derives bowman.
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
    expect(e!.id).toBe("hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50");
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

  // CF-DERIVE-DROPPED-PLAYERNAME (found via PR #2325). deriveCatalogEntry
  // validates playerName is non-empty at line ~531, then built the object it
  // handed computeHobbyIqCardId WITHOUT a playerName key. computeHobbyIqCardId
  // saw playerName: undefined, so unnumberedCardSegment(undefined, ...)
  // returned null for every nno-shaped cardNumber, and the unnumbered branch
  // threw "unnumbered card has no player to identify it" — even on rows with
  // a real player. Reproduced here directly against deriveCatalogEntry
  // (not just the mover, which is what #2325 hit in production).
  it("unnumbered (nno) cardNumber with a real player derives an entry instead of throwing", () => {
    // Before the fix, this threw synchronously inside deriveCatalogEntry.
    expect(() => deriveCatalogEntry({
      sport: "baseball",
      year: 1909,
      setKey: "T206",
      cardNumber: "NNO",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Honus Wagner",
      source: "seed",
      confidence: 0.9,
    })).not.toThrow();

    const e = deriveCatalogEntry({
      sport: "baseball",
      year: 1909,
      setKey: "T206",
      cardNumber: "NNO",
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: "Honus Wagner",
      source: "seed",
      confidence: 0.9,
    });
    expect(e).not.toBeNull();
    // Same `player-<slug>` shape the already-correct soldCompsStore.service.ts
    // caller mints (pinned in tests/playerIsTheNumber.test.ts as
    // "hiq:baseball:1909:t206:player-honus-wagner:base:no-auto") — the fix
    // must never invent a new id shape, only reach the existing one.
    expect(e!.id).toBe("hiq:baseball:1909:t206:player-honus-wagner:base:no-auto");
    expect(e!.cardId).toBe(e!.id);
    expect(e!.playerName).toBe("Honus Wagner");
    expect(e!.playerSlug).toBe("honus-wagner");
  });

  it("two different players on the same unnumbered set get distinct ids, not one shared pool", () => {
    const wagner = deriveCatalogEntry({
      sport: "baseball", year: 1909, setKey: "T206", cardNumber: "NNO",
      parallel: "Base", isAuto: false, printRun: null,
      playerName: "Honus Wagner", source: "seed", confidence: 0.9,
    });
    const cobb = deriveCatalogEntry({
      sport: "baseball", year: 1909, setKey: "T206", cardNumber: "NNO",
      parallel: "Base", isAuto: false, printRun: null,
      playerName: "Ty Cobb", source: "seed", confidence: 0.9,
    });
    expect(wagner!.id).not.toBe(cobb!.id);
    expect(cobb!.id).toBe("hiq:baseball:1909:t206:player-ty-cobb:base:no-auto");
  });

  // BLAST RADIUS: numbered rows must derive byte-identical ids before and
  // after this fix. playerName was already validated non-empty before
  // computeHobbyIqCardId was ever called (line ~531), so forwarding it now
  // changes nothing for the normalizeCardNumber branch (which never reads
  // playerName) — this pins that with the exact id from the first test above
  // plus another numbered shape.
  it("BLAST RADIUS: numbered-row ids are unchanged by threading playerName through", () => {
    const hartman = deriveCatalogEntry({
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
    expect(hartman!.id).toBe("hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50");

    const griffey = deriveCatalogEntry({
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
    expect(griffey!.id).toBe("hiq:baseball:2025:topps:1:base:no-auto");
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
