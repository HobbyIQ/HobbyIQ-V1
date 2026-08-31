/**
 * CF-MATERIALIZE-UNGRADED-PARENTS (Drew, 2026-08-31).
 *
 * The inverse job: mint the ungraded parent where only graded children exist,
 * so a raw holding can resolve. What has to stay true:
 *
 *   - the parent is minted from the child, carrying its fields MINUS grade
 *   - a row that already exists is never overwritten
 *   - the source classifies DERIVED, so it can never adjudicate or outvote
 *   - the grade suffix is parsed by the canonical positional parser
 */
import { describe, expect, it } from "vitest";
import {
  catalogAuthorityOf,
  canAdjudicate,
  isDerived,
  authorityRank,
} from "../src/services/catalog/catalogAuthority.service";
import { cardIdentityKey } from "../src/services/portfolioiq/cardIdentityKey.service";
import { mergeCatalogEntries } from "../src/services/portfolioiq/cardCatalog.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildParentRow, PARENT_SOURCE } = require("../scripts/materialize-ungraded-parents.cjs");

const child = (over: Record<string, unknown> = {}) => ({
  id: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  cardId: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  hobbyiqCardId: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  parentSlug: "hiq:basketball:1993:topps-finest:110:base:no-auto",
  sport: "basketball",
  year: 1993,
  setKey: "topps-finest",
  cardNumber: "110",
  parallel: "Base",
  playerName: "Michael Jordan",
  displayName: "1993 Topps Finest #110 Michael Jordan",
  subsetName: "Main Set",
  imageUrl: "https://example.test/110.jpg",
  gradeCompany: "PSA",
  gradeValue: 10,
  gradeQualifier: null,
  gradeTier: "psa-10",
  source: "ingest-auto-seed-graded",
  confidence: 0.85,
  verificationStatus: "verified",
  searchTokens: ["jordan", "topps-finest", "psa-10", "psa", "10"],
  _rid: "x", _self: "y", _etag: "z", _ts: 1,
  ...over,
});

describe("the parent is the child minus its grade", () => {
  it("mints the parent at the parent slug", () => {
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    expect(row.id).toBe("hiq:basketball:1993:topps-finest:110:base:no-auto");
    expect(row.cardId).toBe(row.id);
    expect(row.hobbyiqCardId).toBe(row.id);
  });

  it("carries the identity fields the checklist knew", () => {
    // The graded builder once hand-listed fields and silently dropped
    // subsetName/displayName/imageUrl from every row. Spread, don't list.
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    expect(row.playerName).toBe("Michael Jordan");
    expect(row.subsetName).toBe("Main Set");
    expect(row.displayName).toBe("1993 Topps Finest #110 Michael Jordan");
    expect(row.imageUrl).toBe("https://example.test/110.jpg");
    expect(row.cardNumber).toBe("110");
    expect(row.parallel).toBe("Base");
  });

  it("drops every trace of the grade dimension", () => {
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    for (const k of ["gradeCompany", "gradeValue", "gradeQualifier", "gradeTier", "parentSlug"]) {
      expect(row[k], `${k} must not survive onto an ungraded parent`).toBeUndefined();
    }
  });

  it("strips grade tokens from searchTokens so the parent is not findable as a graded card", () => {
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    expect(row.searchTokens).toContain("jordan");
    expect(row.searchTokens).not.toContain("psa-10");
    expect(row.searchTokens).not.toContain("psa");
  });

  it("does not inherit the child's Cosmos metadata", () => {
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    for (const k of ["_rid", "_self", "_etag", "_ts"]) expect(row[k]).toBeUndefined();
  });

  it("records which child attested it", () => {
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    expect(row.derivedFromGradedChild).toBe("hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10");
  });

  it("refuses when the parent slug is the child's own slug", () => {
    expect(buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10")).toBeNull();
    expect(buildParentRow(child(), "")).toBeNull();
  });
});

describe("the source classifies DERIVED, and that is load-bearing", () => {
  it("is derived — not unknown", () => {
    // The whole reason the name extends `ingest-auto-seed`: catalogAuthorityOf
    // matches DERIVED by prefix, so a plain descriptive name falls through to
    // `unknown`, which ranks BELOW derived and is skipped by isDerived sweeps.
    expect(catalogAuthorityOf(PARENT_SOURCE)).toBe("derived");
    expect(isDerived(PARENT_SOURCE)).toBe(true);
  });

  it("guards the naming trap that would have shipped", () => {
    // Pinned as a decision on record: this is why the source is not called
    // `graded-attested`. The prod rows named `sales-attested` show the same bug.
    expect(catalogAuthorityOf("graded-attested")).toBe("unknown");
    expect(catalogAuthorityOf("sales-attested")).toBe("unknown");
    expect(authorityRank(PARENT_SOURCE)).toBeGreaterThan(authorityRank("graded-attested"));
  });

  it("can never adjudicate a setKey, and is never VERIFIED-able by provenance", () => {
    expect(canAdjudicate(PARENT_SOURCE)).toBe(false);
    expect(catalogAuthorityOf(PARENT_SOURCE)).not.toBe("checklist");
    const row = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    // Even though the CHILD was stamped "verified", the parent is not.
    expect(row.verificationStatus).toBe("provisional");
    expect(row.source).toBe(PARENT_SOURCE);
  });

  it("never outvotes a checklist row on the write path", () => {
    const derivedParent = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    const checklistRow = {
      id: derivedParent.id,
      source: "checklistcenter",
      confidence: 0.4,          // deliberately LOWER than the derived row's
      playerName: "Michael Jordan",
      vendorIds: {},
    } as never;
    const { winnerIsIncoming } = mergeCatalogEntries(derivedParent as never, checklistRow, new Date().toISOString());
    expect(winnerIsIncoming, "a derived parent must lose to a checklist row").toBe(false);
  });
});

describe("an existing parent is never overwritten", () => {
  it("loses to an existing checklist parent even at higher confidence", () => {
    const incoming = buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto");
    incoming.confidence = 0.99;
    const existing = {
      id: incoming.id, source: "beckett-scraped-2026-08-19", confidence: 0.5,
      playerName: "Michael Jordan", vendorIds: {},
    } as never;
    const { merged, winnerIsIncoming } = mergeCatalogEntries(incoming as never, existing, new Date().toISOString());
    expect(winnerIsIncoming).toBe(false);
    expect((merged as { source: string }).source).toBe("beckett-scraped-2026-08-19");
  });
});

describe("the grade suffix is parsed by the canonical parser", () => {
  it("matches the graded-identity convention: parent + ':' + tier", () => {
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:psa-9-5" }))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10" }))
      .toBe("hiq:basketball:1993:topps-finest:110:base:no-auto");
  });

  it("does NOT mistake a card number beginning psa- for a grade", () => {
    // The 221-false-positive trap: `psa-th2` is a CARD NUMBER in segment 4.
    // A non-positional regex would strip it and mint a garbage parent.
    const slug = "hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499";
    expect(cardIdentityKey({ hobbyiqCardId: slug })).toBe(slug);
  });

  it("preserves a print run — that is identity, not grade", () => {
    const slug = "hiq:baseball:2026:bowman:bp-102:gold:no-auto:num-50";
    expect(cardIdentityKey({ hobbyiqCardId: slug })).toBe(slug);
  });
});
