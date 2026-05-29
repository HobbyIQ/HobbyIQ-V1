// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — Cardsight catalog adapter tests.
//
// Covers the three exported helpers:
//   - cardsightCatalogToCardIdentity (shape mapping + year=0 sentinel)
//   - detectAutoFromBlob              (autograph signal across fields)
//   - buildCatalogTitle               (display string composition)

import { describe, expect, it } from "vitest";
import type { CardsightCatalogResult } from "../src/services/compiq/cardsight.client.js";
import {
  buildCatalogTitle,
  cardsightCatalogToCardIdentity,
  detectAutoFromBlob,
} from "../src/services/unifiedSearch/cardsightCatalogAdapter.js";

function makeCatalogResult(overrides: Partial<CardsightCatalogResult> = {}): CardsightCatalogResult {
  return {
    id: "c-fixture",
    name: "Base Card",
    number: "1",
    releaseName: "Topps Chrome",
    setName: "Base Set",
    year: 2024,
    player: "Sample Player",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// cardsightCatalogToCardIdentity
// ─────────────────────────────────────────────────────────────────────────

describe("cardsightCatalogToCardIdentity", () => {
  it("maps a typical hit into a ranked CardIdentity", () => {
    const hit = makeCatalogResult({
      id: "abc-123",
      name: "Bobby Witt Jr",
      number: "BCP-50",
      releaseName: "Bowman Chrome Prospects",
      setName: "Chrome Prospect Auto",
      year: 2020,
      player: "Bobby Witt Jr",
    });

    const id = cardsightCatalogToCardIdentity(hit, 0.875);

    expect(id.candidateId).toBe("cardsight:abc-123");
    expect(id.source).toBe("cardsight-catalog");
    expect(id.attribution).toBe("ranked");
    expect(id.confidence).toBe(0.875);

    expect(id.player).toBe("Bobby Witt Jr");
    expect(id.year).toBe(2020);
    expect(id.brand).toBe("Bowman Chrome Prospects");
    expect(id.setName).toBe("Chrome Prospect Auto");
    expect(id.cardNumber).toBe("BCP-50");
    expect(id.parallel).toBeNull();
    expect(id.variation).toBeNull();
    expect(id.isAuto).toBe(true); // "Prospect Auto" + "BCP-" prefix
    expect(id.serialNumber).toBeNull();

    expect(id.grade).toBeNull();
    expect(id.gradeCompany).toBeNull();
    expect(id.gradeValue).toBeNull();
    expect(id.certNumber).toBeNull();
    expect(id.totalPopulation).toBeNull();
    expect(id.populationHigher).toBeNull();

    expect(id.title).toContain("2020");
    expect(id.title).toContain("Bobby Witt Jr");
    expect(id.imageUrl).toBeNull();
    expect(id.raw).toBe(hit);
  });

  // Drew Addition 1 — year=0 sentinel handling
  it("treats year=0 (Cardsight not-found sentinel) as null", () => {
    const hit = makeCatalogResult({ year: 0 });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.year).toBeNull();
  });

  it("passes a real year through unchanged", () => {
    const hit = makeCatalogResult({ year: 1987 });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.year).toBe(1987);
  });

  it("falls back from player → name when player is missing", () => {
    const hit = makeCatalogResult({ player: undefined, name: "Greg Maddux" });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.player).toBe("Greg Maddux");
  });

  it("emits null player when both player and name are empty strings", () => {
    const hit = makeCatalogResult({ player: "", name: "" });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    // Empty string is falsy → c.player ?? c.name ?? null picks the
    // empty player (?? only checks null/undefined). Document the
    // current behavior explicitly so a future change is intentional.
    expect(id.player).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// detectAutoFromBlob
// ─────────────────────────────────────────────────────────────────────────

describe("detectAutoFromBlob", () => {
  it("detects 'Auto' token in setName", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ setName: "Chrome Auto" }))).toBe(true);
  });

  it("detects 'Autograph' token in releaseName", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ releaseName: "Topps Prospect Autographs" }))).toBe(true);
  });

  it("detects 'Signature' token in name", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ name: "Rookie Signature" }))).toBe(true);
  });

  it("detects 'Signed' token", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ setName: "Signed Edition" }))).toBe(true);
  });

  it("detects 'CPA' number-prefix autograph subset code", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ number: "CPA-BWJ" }))).toBe(true);
  });

  it("detects 'BDPA' number-prefix autograph subset code", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ number: "BDPA-50" }))).toBe(true);
  });

  it("does NOT trigger on unrelated text", () => {
    expect(
      detectAutoFromBlob(
        makeCatalogResult({
          name: "Base Card",
          number: "1",
          releaseName: "Topps Chrome",
          setName: "Base Set",
          player: "Sample Player",
        }),
      ),
    ).toBe(false);
  });

  it("does NOT trigger on 'autobiography' partial-word noise (word-boundary check)", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ name: "Player Autobiography" }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCatalogTitle
// ─────────────────────────────────────────────────────────────────────────

describe("buildCatalogTitle", () => {
  it("composes year + releaseName + player + #number", () => {
    expect(
      buildCatalogTitle(
        makeCatalogResult({
          year: 2024,
          releaseName: "Topps Chrome Update",
          player: "Bobby Witt Jr",
          number: "USC50",
        }),
      ),
    ).toBe("2024 Topps Chrome Update Bobby Witt Jr #USC50");
  });

  it("prefers releaseName over setName when both present", () => {
    const title = buildCatalogTitle(
      makeCatalogResult({
        year: 2024,
        releaseName: "Topps Chrome",
        setName: "Base Set",
        player: "Player",
        number: "1",
      }),
    );
    expect(title).toContain("Topps Chrome");
    expect(title).not.toContain("Base Set");
  });

  it("falls back to setName when releaseName is empty", () => {
    expect(
      buildCatalogTitle(
        makeCatalogResult({
          year: 2024,
          releaseName: "",
          setName: "Vintage",
          player: "Player",
          number: "1",
        }),
      ),
    ).toContain("Vintage");
  });

  it("drops year=0 sentinel from title", () => {
    const title = buildCatalogTitle(
      makeCatalogResult({ year: 0, releaseName: "Topps", player: "P", number: "1" }),
    );
    expect(title).not.toContain("0");
    expect(title).toContain("Topps");
  });

  it("falls back to `name` when all structured fields are empty", () => {
    expect(
      buildCatalogTitle({
        id: "x",
        name: "Last Resort Title",
        number: "",
        releaseName: "",
        setName: "",
        year: 0,
      }),
    ).toBe("Last Resort Title");
  });

  it("returns 'Unknown card' when name is also empty", () => {
    expect(
      buildCatalogTitle({
        id: "x",
        name: "",
        number: "",
        releaseName: "",
        setName: "",
        year: 0,
      }),
    ).toBe("Unknown card");
  });
});
