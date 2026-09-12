import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * CF-RED-INK-IS-ITS-OWN-CARD twin fold (2026-09-12).
 *
 * Drew's holding 9f082213 (2026 Bowman Chrome Black & White Red Ink, Victor
 * Figueroa, CPA-VF) prices off hiq:baseball:2026:bowman-chrome:cpa-vf:
 * black-white-red-ink-refractor:auto -- a SELF-DERIVED catalog row
 * (source user-verified) that is a key-spelling twin of the checklist-backed
 * row at ...cpa-vf:black-white-red-ink:auto (source
 * checklist-drew-ruling-2026-08-30-red-ink), per Drew's 2026-08-30 ruling
 * that Red Ink is the distinct SSP of the Black & White Shimmer auto
 * parallel (R22: key-spelling twins fold onto the checklist key).
 *
 * Measured read-only 2026-09-12 (an earlier "692 comps" figure was a stale
 * `pricingSourceMeta.blockingCount` on the holding, not a live pool -- the
 * checklist slug carries ZERO sold_comps rows and the self-derived twin
 * carries exactly TWO):
 *
 *   1. ebay-user-purchase::147344007201-10082410797719  $270  Drew's own
 *      verified purchase. Title: "2026 Bowman Chrome Black White Red Ink" --
 *      STATES Red Ink. Genuinely the card. RELOCATE onto the checklist slug.
 *
 *   2. cardhedge::1778540428361x447194681698603460::2026-08-24T17:51:13.000Z
 *      ::1900::Raw  $19. Title: "2026 Bowman Chrome Victor Figueroa 1st
 *      Prospect Auto #CPA-VF Orioles HOT - Raw" -- names NO finish at all.
 *      cardId 1778540428361x447194681698603460 is the CardHedge PRODUCT id
 *      that scripts/lib/ch-product-label.cjs and
 *      repair-ch-product-label-parallel.cjs already document as mislabelled
 *      "Black & White Red Ink" in CardHedge's own catalog -- the product's
 *      label became the sale's parallel. No checklist-backed base/no-parallel
 *      row exists for CPA-VF in 2026 bowman-chrome (9 catalog rows measured
 *      for this card number, all named parallels), so this row PARKS rather
 *      than being minted onto a guessed destination.
 *
 * A bounded scan of all 716 2026 CPA-VF sold_comps rows (cardYear=2026,
 * cardNumber CONTAINS 'cpa-vf' -- never an unfiltered title scan) found
 * exactly ONE row anywhere whose title states Red Ink: the one named above.
 * The other 714 rows all belong to the unrelated "2026 Bowman" (non-Chrome)
 * product and are out of scope.
 *
 * These pins hold the LIST SHAPE and run the lanes' OWN validators, so a list
 * these tests accept is a list the lanes can actually read and apply.
 */

const POOL_DIR = path.join(process.cwd(), "data", "pool-relocations");
const CATALOG_DIR = path.join(process.cwd(), "data", "catalog-relocations");
const POOL_FILE = "2026-09-12-figueroa-red-ink-twin-fold.json";
const CATALOG_FILE = "2026-09-12-figueroa-red-ink-twin-retire.json";

const loadPool = () => JSON.parse(readFileSync(path.join(POOL_DIR, POOL_FILE), "utf8"));
const loadCatalog = () => JSON.parse(readFileSync(path.join(CATALOG_DIR, CATALOG_FILE), "utf8"));

const CHECKLIST_REDINK = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto";
const SELF_DERIVED_REDINK = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto";
const KNOWN_CH_PRODUCT = "1778540428361x447194681698603460";

// A minimal fixture of the card_catalog rows this PR verified exist, in the
// exact shape the lane's own destination checks read. Never invented: these
// are the rows measured read-only 2026-09-12 (see the finding strings).
const CATALOG_FIXTURE: Record<string, { source: string; playerName: string; parallel: string }> = {
  [CHECKLIST_REDINK]: {
    source: "checklist-drew-ruling-2026-08-30-red-ink",
    playerName: "Victor Figueroa",
    parallel: "Black & White Red Ink",
  },
  [SELF_DERIVED_REDINK]: {
    source: "user-verified",
    playerName: "Victor Figueroa",
    parallel: "Black White Red Ink Refractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:gold-ink-variation:auto:num-15": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Gold Ink Variation",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:orange-x-fractor:auto:num-25": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Orange X Fractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:superfractor:auto:num-1": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Superfractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:mini-diamond-refractor:auto:num-100": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Mini Diamond Refractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:bowman-logofractor:auto:num-35": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Bowman Logofractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:packfractor:auto:num-89": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "PackFractor",
  },
  "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-shimmer:auto": {
    source: "checklist", playerName: "Victor Figueroa", parallel: "Black & White Shimmer",
  },
  // Explicitly NOT present: any base/no-parallel row for CPA-VF in 2026
  // bowman-chrome. Its absence is the load-bearing fact behind the PARK.
};

const isChecklistBacked = (slug: string): boolean => {
  const row = CATALOG_FIXTURE[slug];
  return !!row && /^checklist/.test(row.source);
};

describe("the pool fold list is shaped the way relocate-pool-rows-by-list requires", () => {
  const doc = loadPool();

  it("is an object addressed to the pool lane, never a bare array", () => {
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("names exactly the two rows the census measured", () => {
    expect(doc.entries).toHaveLength(2);
    expect(doc.census.checklistRedInkSlugRows).toBe(0);
    expect(doc.census.selfDerivedRedInkSlugRows).toBe(2);
    expect(doc.census.relocate).toBe(1);
    expect(doc.census.park).toBe(1);
  });

  it("every entry names a fromCardId and an id, and exactly one shape", () => {
    for (const e of doc.entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      const shapes = [e.toCardId && e.toCardId !== e.fromCardId, e.repointHobbyiqCardId, e.retireSupersededBy, e.parkIdentityUnverified === true]
        .filter(Boolean);
      expect(shapes.length, `entry ${e.id} names ${shapes.length} shapes`).toBe(1);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
    }
  });

  it("the RELOCATE entry moves Drew's purchase off the twin onto the checklist row", () => {
    const relocate = doc.entries.find((e: any) => e.toCardId);
    expect(relocate.id).toBe("ebay-user-purchase::147344007201-10082410797719");
    expect(relocate.fromCardId).toBe(SELF_DERIVED_REDINK);
    expect(relocate.toCardId).toBe(CHECKLIST_REDINK);
    expect(relocate.price).toBe(270);
    // Destination is checklist-backed -- never a mint onto a self-derived row.
    expect(isChecklistBacked(relocate.toCardId)).toBe(true);
  });

  it("the PARK entry names the mislabelled CH product, with no invented destination", () => {
    const park = doc.entries.find((e: any) => e.parkIdentityUnverified === true);
    expect(park.id).toContain(KNOWN_CH_PRODUCT);
    expect(park.fromCardId).toBe(KNOWN_CH_PRODUCT);
    expect(park.price).toBe(19);
    expect(park.toCardId).toBeUndefined();
    expect(park.repointHobbyiqCardId).toBeUndefined();
  });

  it("NO title stating Red Ink is ever moved out of the pool by a PARK or a non-Red-Ink RELOCATE", () => {
    // The one entry whose evidence says the title states Red Ink must be the
    // RELOCATE entry, and it must relocate TO the Red Ink checklist slug --
    // never park, never move to any other slug.
    for (const e of doc.entries) {
      const statesRedInk = /title states red ink|states red ink in full/i.test(String(e.evidence ?? ""));
      if (statesRedInk) {
        expect(e.toCardId, `Red-Ink-titled entry ${e.id} must RELOCATE`).toBe(CHECKLIST_REDINK);
        expect(e.parkIdentityUnverified).toBeUndefined();
        expect(e.retireSupersededBy).toBeUndefined();
      }
    }
  });

  it("the PARK entry's own evidence states its title names no finish", () => {
    const park = doc.entries.find((e: any) => e.parkIdentityUnverified === true);
    expect(String(park.evidence)).toMatch(/names NO finish/i);
    expect(String(park.evidence)).not.toMatch(/title states red ink/i);
  });
});

describe("the catalog retire list is shaped the way relocate-catalog-rows-by-list requires", () => {
  const { classifyEntry } = require_("../scripts/relocate-catalog-rows-by-list.cjs");
  const doc = loadCatalog();

  it("is an object addressed to the catalog lane, never a bare array", () => {
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("runs AFTER the pool fold -- applyOrder says so explicitly", () => {
    expect(String(doc.applyOrder)).toMatch(/2 of 2/);
    expect(String(doc.applyOrder)).toContain(POOL_FILE);
  });

  it("names exactly one entry: retiring the self-derived twin", () => {
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].id).toBe(SELF_DERIVED_REDINK);
  });

  it("classifyEntry (the lane's own validator) accepts the entry as a retire with no destination", () => {
    const e = doc.entries[0];
    const v = classifyEntry(e);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("retire");
    expect(e.to).toBeUndefined();
  });

  it("retires ONLY a row that has a checklist-backed twin", () => {
    // The retire is justified by the twin's existence, and the twin the list
    // names is in fact checklist-backed.
    expect(String(doc.finding)).toContain(CHECKLIST_REDINK);
    expect(isChecklistBacked(CHECKLIST_REDINK)).toBe(true);
    // And the row BEING retired is emphatically NOT itself checklist-backed --
    // retiring a checklist row here would be the doctrine violation this list
    // exists to avoid.
    expect(isChecklistBacked(SELF_DERIVED_REDINK)).toBe(false);
  });

  it("the reason and evidence name the twin, the ruling, and the pre-retire sale count", () => {
    const e = doc.entries[0];
    expect(String(e.reason)).toMatch(/R22/);
    expect(String(e.reason)).toContain(CHECKLIST_REDINK);
    expect(String(e.evidence)).toMatch(/Pre-retire sold_comps count.*2/i);
  });
});

describe("no destination in either list is minted from a sale", () => {
  it("every catalog row this PR treats as a destination is present in the fixture and checklist-backed, except the twin being retired", () => {
    const pool = loadPool();
    for (const e of pool.entries) {
      if (!e.toCardId) continue; // PARK entries name no destination
      expect(CATALOG_FIXTURE[e.toCardId], `${e.toCardId} must exist in card_catalog`).toBeDefined();
      expect(isChecklistBacked(e.toCardId)).toBe(true);
    }
  });

  it("the base/no-parallel CPA-VF row does NOT exist -- confirming the PARK was correct, not a shortcut", () => {
    expect(CATALOG_FIXTURE["hiq:baseball:2026:bowman-chrome:cpa-vf:base:auto"]).toBeUndefined();
  });
});
