/**
 * CF-THE-TITLE-DECIDES fold, Jac Caglianone 2024 Bowman Draft 1st Bowman
 * Chrome Auto Refractor /499 (2026-09-12).
 *
 * Drew's holding 96f1a812-4aae-4dcd-9286-c96dad167caf prices off
 * hiq:baseball:2024:bowman-draft:cpa-jc:refractor:auto:num-499 — the
 * checklist-backed row (source checklistcenter-2026-08-29). Its own PSA 9
 * sale sat at hiq:baseball:2024:bowman-draft:b24-jce:refractor:auto:num-499,
 * a seller-code slug with no card_catalog row at that exact address.
 *
 * These pins hold the list shape and its scope discipline: exactly one
 * RELOCATE, and the sibling "Lot of (5)" listing at the same card-number
 * prefix is named as EXCLUDED evidence rather than silently absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const FILE = "2026-09-12-caglianone-2024-bowman-draft-cpa-jc-fold.json";
const DIR = join(process.cwd(), "data", "pool-relocations");

type Entry = { id: string; fromCardId: string; toCardId: string; price?: number; evidence?: string };
type List = {
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: Record<string, unknown>;
  entries: Entry[];
};

const doc = JSON.parse(readFileSync(join(DIR, FILE), "utf8")) as List;

const { planRelocatedIdentity } = require_("../scripts/relocate-pool-rows-by-list.cjs") as {
  planRelocatedIdentity: (a: { storedHobbyiqCardId: string | null; from: string; to: string }) => {
    hobbyiqCardId: string;
    thirdSlug: string | null;
  };
};

describe("the file names the correct lane and stays report-only", () => {
  it("targets relocate-pool-rows-by-list", () => {
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
  });

  it("carries no apply authorization", () => {
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("states CF-THE-TITLE-DECIDES and the checklistcenter provenance", () => {
    expect(doc.finding).toMatch(/CF-THE-TITLE-DECIDES/);
    expect(doc.finding).toMatch(/checklistcenter-2026-08-29/);
  });

  it("names the card-number-collision doctrine for BOTH prefixes involved", () => {
    // CPA-JC collides with 2026 Bowman Chrome's Johenssy Colome; B24-JCE
    // collides with 2024 Bowman's Best Caglianone autos and 2024 Bowman's own
    // non-auto Sky Blue parallel. Neither collision is identity.
    expect(doc.finding).toMatch(/Johenssy Colome/);
    expect(doc.finding).toMatch(/Bowman's Best|bowmans-best/);
  });
});

describe("every entry is a RELOCATE shape the lane accepts", () => {
  it("has exactly one entry", () => {
    expect(doc.entries.length).toBe(1);
  });

  it("every entry has id, fromCardId, toCardId, and fromCardId !== toCardId", () => {
    for (const e of doc.entries) {
      expect(e.id, "missing id").toBeTruthy();
      expect(e.fromCardId, `${e.id}: missing fromCardId`).toBeTruthy();
      expect(e.toCardId, `${e.id}: missing toCardId`).toBeTruthy();
      expect(e.toCardId).not.toBe(e.fromCardId);
    }
  });

  it("the fromCardId is the seller-code b24-jce address (the wrong slug)", () => {
    expect(doc.entries[0].fromCardId).toBe(
      "hiq:baseball:2024:bowman-draft:b24-jce:refractor:auto:num-499",
    );
  });

  it("the toCardId is the checklist-backed cpa-jc address", () => {
    expect(doc.entries[0].toCardId).toBe(
      "hiq:baseball:2024:bowman-draft:cpa-jc:refractor:auto:num-499",
    );
  });

  it("gives the entry an evidence line naming the title and the destination", () => {
    const e = doc.entries[0];
    expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
    expect(e.evidence).toContain(e.toCardId);
    // The title text itself is the evidence CF-THE-TITLE-DECIDES turns on.
    expect(e.evidence).toMatch(/1st Bowman/);
    expect(e.evidence).toMatch(/Auto/);
    expect(e.evidence).toMatch(/Refractor/);
    expect(e.evidence).toMatch(/499/);
  });

  it("carries the source row's own price and PSA 9 grade context", () => {
    expect(doc.entries[0].price).toBe(405);
    expect(doc.entries[0].evidence).toMatch(/PSA 9/);
  });
});

describe("planRelocatedIdentity (the lane's own function) lands the identity at `to`", () => {
  it("hobbyiqCardId lands at `to` even though the stored value is a third slug (no :num-499 suffix)", () => {
    const e = doc.entries[0];
    // The live row's stored hobbyiqCardId lacks the :num-499 suffix its own
    // cardId carries — a split-identity row, exactly the shape
    // planRelocatedIdentity exists to correct rather than skip.
    const storedHobbyiqCardId = "hiq:baseball:2024:bowman-draft:b24-jce:refractor:auto";
    const r = planRelocatedIdentity({ storedHobbyiqCardId, from: e.fromCardId, to: e.toCardId });
    expect(r.hobbyiqCardId).toBe(e.toCardId);
    // Reported as a third slug: it names neither `from` nor `to` exactly.
    expect(storedHobbyiqCardId).not.toBe(e.fromCardId);
    expect(storedHobbyiqCardId).not.toBe(e.toCardId);
    expect(r.thirdSlug).toBe(storedHobbyiqCardId);
  });

  it("a row already pointing at the target is left at the target, not flagged", () => {
    const e = doc.entries[0];
    const r = planRelocatedIdentity({ storedHobbyiqCardId: e.toCardId, from: e.fromCardId, to: e.toCardId });
    expect(r.hobbyiqCardId).toBe(e.toCardId);
    expect(r.thirdSlug).toBeNull();
  });
});

describe("scope discipline: no other parallel or print run is moved by this list", () => {
  it("the sibling 'Lot of (5)' listing at the same card-number prefix is NOT an entry", () => {
    expect(doc.entries.some((e) => e.id === "tca-ebay::366595029805")).toBe(false);
  });

  it("the finding explains why the lot listing is out of scope (no Auto, no print run stated)", () => {
    expect(doc.finding).toMatch(/Lot of \(5\)/);
  });

  it("names the census counts explicitly: one match, one out-of-scope sibling", () => {
    expect(doc.census.titleMatchesAllFourCriteria).toBe(1);
    expect(doc.census.relocate).toBe(1);
    expect(doc.census.outOfScopeLotListing).toBe(1);
  });
});
