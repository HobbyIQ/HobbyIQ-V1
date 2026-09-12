import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * CF-WITT-221-IMAGE-VARIATION-IS-SONIC pool relocation (2026-09-12).
 *
 * R23 (Drew, 2026-09-11): 2022 Topps Chrome #221 Bobby Witt Jr.'s image
 * variation is the Sonic tier -- a card line, address
 * hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto, source
 * cardpedia-drew-ruling-2026-09-11. Drew's holding 2b62a93f was re-derived
 * onto that slug at 23:43Z (verdict REDERIVE, matchedBy
 * tierless-variation-unique, 0.92), but the pool never followed: at 12:55Z
 * the holding read no-exact-pool -- zero sold_comps rows at the Sonic
 * partition -- while every sale sat on an old address.
 *
 * Census (read-only, both sold_comps identity fields, both address
 * families): 4 rows on hiq-slug-partitioned old addresses (Drew's own
 * holding, one phash-duplicate of it, and two tca-ebay rows mis-slugged onto
 * plain refractor by a parser that never read the variation word), plus 12
 * rows on the CardHedge product's own vendor-id partition (never touched a
 * hiq slug for the variation family at all). Of these 16, 12 titles state a
 * TIERLESS image/photo variation -- and Witt #221 has only the Sonic tier,
 * so a tierless claim resolves to Sonic (Ruling 24,
 * resolveTierlessVariationByUniqueness) -- and RELOCATE onto the ruled
 * address. 4 titles name a DIFFERENT tier (SP or SSP) the checklist does not
 * attest for #221 and PARK instead of being guessed onto Sonic.
 *
 * These pins hold the LIST SHAPE and the title-evidence classification, so a
 * list these tests accept is a list the lane can actually read and apply.
 */

const POOL_DIR = path.join(process.cwd(), "data", "pool-relocations");
const POOL_FILE = "2026-09-12-witt-221-image-variation-to-sonic.json";
const loadPool = () => JSON.parse(readFileSync(path.join(POOL_DIR, POOL_FILE), "utf8"));

const SONIC = "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto";
const CH_PRODUCT = "1664553883976x293772727399522100";
const DREW_HOLDING_ID = "ebay-user-purchase::holding::2b62a93f-f24c-454e-8d5f-1101eb417358";
const DREW_STALE_SLUG = "hiq:baseball:2022:topps-chrome-sonic-lite:221:image-variations:no-auto";

// A minimal fixture of the card_catalog rows this PR measured read-only
// 2026-09-12, in the exact shape the lane's own destination checks read.
// Never invented -- the Sonic row's source is the ruling PR itself; the
// stale slug row is the pre-ruling checklistcenter row Drew's holding was
// still parked on.
const CATALOG_FIXTURE: Record<string, { source: string; playerName: string; parallel: string }> = {
  [SONIC]: {
    source: "cardpedia-drew-ruling-2026-09-11",
    playerName: "Bobby Witt Jr.",
    parallel: "Image Variation Sonic",
  },
  [DREW_STALE_SLUG]: {
    source: "checklistcenter",
    playerName: "Bobby Witt Jr.",
    parallel: "Image Variations",
  },
  "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto": {
    source: "ingest-auto-seed", playerName: "Bobby Witt Jr.", parallel: "Refractor Image Variation",
  },
  "hiq:baseball:2022:topps-chrome:221:refractor:no-auto": {
    source: "beckett-scraped-2026-09-01", playerName: "Bobby Witt Jr.", parallel: "Refractor",
  },
  // Explicitly NOT present: any SP or SSP variation row addressed to #221.
  // Their absence is the load-bearing fact behind every PARK entry.
};

const isChecklistBacked = (slug: string): boolean =>
  !!CATALOG_FIXTURE[slug] && !/^(ingest-auto-seed|user-verified)/.test(CATALOG_FIXTURE[slug].source);

describe("the Witt #221 Sonic pool list is shaped the way relocate-pool-rows-by-list requires", () => {
  const doc = loadPool();

  it("is an object addressed to the pool lane, never a bare array", () => {
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.lane).toBe("relocate-pool-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("names exactly the sixteen rows the census measured", () => {
    expect(doc.entries).toHaveLength(16);
    expect(doc.census.relocate).toBe(12);
    expect(doc.census.park).toBe(4);
    expect(doc.census.relocate + doc.census.park).toBe(doc.entries.length);
  });

  it("every entry names an id and a fromCardId, and exactly one shape", () => {
    for (const e of doc.entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId,
        e.repointHobbyiqCardId,
        e.retireSupersededBy,
        e.parkIdentityUnverified === true,
      ].filter(Boolean);
      expect(shapes.length, `entry ${e.id} names ${shapes.length} shapes`).toBe(1);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
    }
  });

  it("uses RELOCATE exclusively -- never REPOINT -- so the Sonic cardId partition itself holds every row", () => {
    for (const e of doc.entries) {
      expect(e.repointHobbyiqCardId).toBeUndefined();
      if (e.toCardId) expect(e.toCardId).toBe(SONIC);
    }
  });

  it("every RELOCATE entry's destination is the ruled Sonic address, and it is checklist-backed", () => {
    const relocates = doc.entries.filter((e: any) => e.toCardId);
    expect(relocates).toHaveLength(12);
    for (const e of relocates) {
      expect(e.toCardId).toBe(SONIC);
      expect(isChecklistBacked(e.toCardId)).toBe(true);
    }
  });

  it("Drew's own holding relocates off its STORED (stale) cardId, not off its hobbyiqCardId", () => {
    const drew = doc.entries.find((e: any) => e.id === DREW_HOLDING_ID);
    expect(drew).toBeDefined();
    expect(drew.fromCardId).toBe(DREW_STALE_SLUG);
    expect(drew.toCardId).toBe(SONIC);
    // The stale slug is a REAL, different catalog row (not the target) --
    // proving fromCardId was read off the stored document, never assumed
    // from the ruling's own destination.
    expect(CATALOG_FIXTURE[DREW_STALE_SLUG]).toBeDefined();
    expect(drew.fromCardId).not.toBe(SONIC);
  });

  it("vendor-partitioned CardHedge entries use the CH product id as fromCardId, never a hiq slug", () => {
    const chEntries = doc.entries.filter((e: any) => e.fromCardId === CH_PRODUCT);
    expect(chEntries.length).toBe(12);
    // 8 relocate, 4 park -- all twelve CH-sourced rows named in this list
    // share the one product id.
    expect(chEntries.filter((e: any) => e.toCardId).length).toBe(8);
    expect(chEntries.filter((e: any) => e.parkIdentityUnverified).length).toBe(4);
  });

  it("every PARK entry's evidence names the specific OTHER tier the title states, never a bare 'ambiguous'", () => {
    const parks = doc.entries.filter((e: any) => e.parkIdentityUnverified === true);
    expect(parks).toHaveLength(4);
    for (const e of parks) {
      expect(String(e.evidence)).toMatch(/\b(SP|SSP)\b/);
      expect(e.toCardId).toBeUndefined();
    }
  });

  it("no PARK entry is ever also a RELOCATE, and no numbered/other-tier title reaches Sonic", () => {
    for (const e of doc.entries) {
      if (e.parkIdentityUnverified === true) {
        expect(e.toCardId).toBeUndefined();
        continue;
      }
      // Every non-park entry is a relocate onto Sonic in this list, and its
      // own evidence must NOT claim a different named tier or a print run --
      // a title stating SP/SSP (as a variation tier, not a numbered-parallel
      // descriptor already excluded from scope) has no business relocating.
      expect(String(e.evidence)).not.toMatch(/states the compound 'Image Variation (SP|SSP)'/i);
      expect(String(e.evidence)).not.toMatch(/states 'SSP Variation'/i);
    }
  });

  it("uniqueness holds on (id, fromCardId)", () => {
    const seen = new Set<string>();
    for (const e of doc.entries) {
      const key = `${e.id}::${e.fromCardId}`;
      expect(seen.has(key), `duplicate entry ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe("no destination in this list is minted from a sale", () => {
  it("the target row exists in card_catalog and is checklist-backed (source cardpedia-drew-ruling-2026-09-11)", () => {
    expect(CATALOG_FIXTURE[SONIC]).toBeDefined();
    expect(CATALOG_FIXTURE[SONIC].source).toBe("cardpedia-drew-ruling-2026-09-11");
    expect(isChecklistBacked(SONIC)).toBe(true);
  });

  it("no SP or SSP variation row exists for #221 -- confirming every PARK was correct, not a shortcut", () => {
    expect(CATALOG_FIXTURE["hiq:baseball:2022:topps-chrome:221:image-variation:no-auto"]).toBeUndefined();
    expect(CATALOG_FIXTURE["hiq:baseball:2022:topps-chrome:221:image-variation-ssp:no-auto"]).toBeUndefined();
  });
});
