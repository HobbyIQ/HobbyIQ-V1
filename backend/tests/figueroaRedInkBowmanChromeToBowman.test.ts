import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * CF-IT-CAME-OUT-OF-BOWMAN, Red Ink product-key correction (2026-09-12).
 *
 * RULING (Drew, 2026-09-12 widget): Victor Figueroa's 2026 "Black & White Red
 * Ink" Chrome Prospect Autograph (CPA-VF) belongs to the 2026 BOWMAN (paper)
 * product, setKey `bowman`, not `bowman-chrome`. The 08-30 drew-ruling row
 * hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto (source
 * checklist-drew-ruling-2026-08-30-red-ink) was minted under the wrong
 * product key -- backend/data/checklists/scraped/2026-bowman-full.csv (setKey
 * `bowman`) lists CPA-VF (base auto + Gold Ink auto), while
 * backend/data/checklists/scraped/2026-bowman-chrome.csv (1,197 rows) lists
 * no CPA-VF row at all. This mirrors the CPA-MG defect #2060/#2064 already
 * fixed at the deriver: "Chrome Prospect Autographs" is a SECTION of the
 * paper Bowman product's own checklist, not evidence a card ships in Bowman
 * Chrome.
 *
 * PR #2062 (merged, and APPLIED per prod point-reads 2026-09-12) already
 * folded a self-derived key-spelling twin onto this ruling row, leaving it
 * with exactly ONE live sale (Drew's own $270 purchase) and zero self-derived
 * contamination. This PR corrects the ruling row's PRODUCT, not its player or
 * parallel identity.
 *
 * These pins hold: (1) the corrected checklist manifest, (2) the derived
 * catalog id the ingest will mint from it, (3) the pool relocation list
 * moving the one live sale, and (4) the catalog retire list removing the
 * superseded row -- each checked against the LANES' OWN validators, never a
 * re-implementation.
 */

const CHECKLIST_DIR = path.join(process.cwd(), "data", "checklists", "drew-rulings");
const MANIFEST_PATH = path.join(CHECKLIST_DIR, "2026-bowman-chrome-cpa-red-ink-baseball.manifest.json");
const CSV_PATH = path.join(CHECKLIST_DIR, "2026-bowman-chrome-cpa-red-ink-baseball.csv");

const POOL_DIR = path.join(process.cwd(), "data", "pool-relocations");
const POOL_FILE = "2026-09-12-figueroa-red-ink-bowman-chrome-to-bowman.json";
const CATALOG_DIR = path.join(process.cwd(), "data", "catalog-relocations");
const CATALOG_FILE = "2026-09-12-figueroa-red-ink-bowman-chrome-retire.json";

const SUPERSEDED_ID = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto";
const CORRECTED_ID = "hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto";

const loadPool = () => JSON.parse(readFileSync(path.join(POOL_DIR, POOL_FILE), "utf8"));
const loadCatalog = () => JSON.parse(readFileSync(path.join(CATALOG_DIR, CATALOG_FILE), "utf8"));

describe("the corrected drew-ruling checklist file mints the bowman address", () => {
  it("the manifest's setKey is now `bowman`, not `bowman-chrome`", () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(m.sport).toBe("baseball");
    expect(m.year).toBe(2026);
    expect(m.setKey).toBe("bowman");
    expect(m.setName).toBe("2026 Bowman");
    expect(m.parallelColumnAuthoritative).toBe(true);
  });

  it("still names a SOURCE the ingest will accept -- checklist class, unchanged by the correction", () => {
    const { catalogAuthorityOf } = require_("../dist/services/catalog/catalogAuthority.service.js");
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(m.source).toBe("checklist-drew-ruling-2026-08-30-red-ink");
    expect(catalogAuthorityOf(m.source)).toBe("checklist");
  });

  it("the header note cites the 2026-09-12 ruling and the checklist evidence", () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(m.note).toMatch(/2026-09-12/);
    expect(m.note).toMatch(/2026-bowman-full\.csv/);
    expect(m.note).toMatch(/2026-bowman-chrome\.csv/);
    expect(m.correctedAt).toBe("2026-09-12");
    expect(String(m.correctedBy)).toMatch(/bowman/);
  });

  it("the CSV row itself is untouched -- only the manifest's product key changed", () => {
    const lines = readFileSync(CSV_PATH, "utf8").trim().split(/\r?\n/);
    expect(lines[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player,rarity");
    expect(lines).toHaveLength(2);
    const [, cardNumber, parallel, isAuto, printRun, player] = lines[1].split(",");
    expect(cardNumber).toBe("CPA-VF");
    expect(parallel).toBe("Black & White Red Ink");
    expect(isAuto).toBe("true");
    expect(printRun).toBe("");
    expect(player).toBe("Victor Figueroa");
  });

  it("computeHobbyIqCardId, given authoritativeSetKey + the corrected manifest fields, mints the new id", () => {
    const { computeHobbyIqCardId } = require_("../dist/services/portfolioiq/hobbyIqCardId.service.js");
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const lines = readFileSync(CSV_PATH, "utf8").trim().split(/\r?\n/);
    const [, cardNumber, parallel, isAuto, printRun] = lines[1].split(",");
    const slug = computeHobbyIqCardId({
      sport: m.sport,
      year: m.year,
      setKey: m.setKey,
      cardNumber,
      parallel: parallel || "Base",
      isAuto: isAuto === "true",
      printRun: printRun ? Number(printRun) : null,
      authoritativeSetKey: true,
    });
    expect(slug).toBe(CORRECTED_ID);
  });

  it("the CHROME_PREFIX_OVERRIDE for bare CPA- is capped at maxYear 2022 -- a 2026 vendor-derived slug stays on bowman", () => {
    // CF-CPA-IS-AMBIGUOUS-FROM-2023 caps the bowman+CPA- -> bowman-chrome
    // override at maxYear 2022 (50+ colliding CPA- numbers from 2023 on).
    // So a 2026 slug computed WITHOUT authoritativeSetKey (the vendor/title
    // path) already stays on bare `bowman` for a CPA- number -- the manifest
    // correction and the checklist ingest's authoritativeSetKey flag are not
    // what keeps a 2026 vendor-derived CPA-VF slug off bowman-chrome; the
    // year cutoff already does that. What the manifest correction fixes is
    // the CHECKLIST-AUTHORED row itself, which is minted with
    // authoritativeSetKey regardless of year.
    const { computeHobbyIqCardId } = require_("../dist/services/portfolioiq/hobbyIqCardId.service.js");
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "bowman",
      cardNumber: "CPA-VF", parallel: "Black & White Red Ink", isAuto: true,
      printRun: null,
      // No authoritativeSetKey: true here -- the vendor path.
    });
    expect(slug).toBe(CORRECTED_ID);
  });

  it("title-derived setKey resolution now narrows CPA-VF back onto bowman -- the gap this test used to pin is the class #2064 generalized to close", () => {
    // Originally written (2026-09-12, #2069) as a MUTATION pinning a known
    // gap: computeHobbyIqCardId never sees a title, only whatever setKey its
    // caller already resolved, and CHROME_PREFIX_OVERRIDES only ever WIDENS
    // bare bowman toward bowman-chrome -- it never narrows bowman-chrome back
    // to bowman. At the time, applySiblingChecklistOverride (#2064) shipped
    // with exactly one entry (CPA-MG) and did not yet cover CPA-VF, so a
    // title parser that resolved "2026 Bowman Chrome ... CPA-VF" to
    // setKey=bowman-chrome would pass that wrong setKey straight through.
    //
    // #2064's integration commit (26c7921, "generalize the sibling-checklist
    // override to the full 2026 CPA- class") read this test's own finding as
    // proof the defect was a CLASS, not one holding, and generalized
    // SIBLING_CHECKLIST_OVERRIDES to every CPA- number present in exactly one
    // of the two 2026 checklists -- CPA-VF (Figueroa) is explicitly named in
    // that table's header comment and sits in CPA_2026_BOWMAN_ONLY. So the
    // gap this test pinned is now closed at the same seam, for the same
    // reason CPA-MG was: the checklist decides, not the title's own words.
    const { computeHobbyIqCardId } = require_("../dist/services/portfolioiq/hobbyIqCardId.service.js");
    const slugFromWrongTitleResolution = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "bowman-chrome",
      cardNumber: "CPA-VF", parallel: "Black & White Red Ink", isAuto: true,
      printRun: null,
    });
    expect(slugFromWrongTitleResolution).toBe(CORRECTED_ID);
  });
});

describe("the pool relocation list is shaped the way relocate-pool-rows-by-list requires", () => {
  const doc = loadPool();

  it("is an object addressed to the pool lane, never a bare array", () => {
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("names exactly the one live sale, and no others", () => {
    expect(doc.entries).toHaveLength(1);
    expect(doc.census.supersededAddressSoldCompsRows).toBe(1);
    expect(doc.census.relocated).toBe(1);
  });

  it("the entry names a fromCardId and a toCardId, and exactly one shape", () => {
    for (const e of doc.entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      const shapes = [e.toCardId && e.toCardId !== e.fromCardId, e.repointHobbyiqCardId, e.retireSupersededBy, e.parkIdentityUnverified === true]
        .filter(Boolean);
      expect(shapes.length, `entry ${e.id} names ${shapes.length} shapes`).toBe(1);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
    }
  });

  it("relocates Drew's purchase from the superseded bowman-chrome address to the corrected bowman address", () => {
    const relocate = doc.entries[0];
    expect(relocate.id).toBe("ebay-user-purchase::147344007201-10082410797719");
    expect(relocate.fromCardId).toBe(SUPERSEDED_ID);
    expect(relocate.toCardId).toBe(CORRECTED_ID);
    expect(relocate.price).toBe(270);
  });

  it("the PARKed CardHedge row is explicitly named as OUT OF SCOPE, not silently omitted", () => {
    expect(String(doc.finding) + JSON.stringify(doc.rulings)).toMatch(/PARKED CARDHEDGE ROW DOES NOT MOVE/);
    expect(String(doc.finding) + JSON.stringify(doc.rulings)).toMatch(/identityUnverified/);
    // And it never appears as an entry in this list.
    expect(doc.entries.some((e: any) => String(e.id ?? "").includes("1778540428361x447194681698603460"))).toBe(false);
  });

  it("states the destination must already exist -- the ingest runs BEFORE this list", () => {
    expect(JSON.stringify(doc.rulings)).toMatch(/destination MUST already exist/i);
    expect(JSON.stringify(doc.rulings) + doc.finding).toMatch(/ingest-checklist-csv-to-catalog/);
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

  it("runs LAST -- applyOrder says so explicitly, after the ingest and the pool list", () => {
    expect(String(doc.applyOrder)).toMatch(/2 of 2/);
    expect(String(doc.applyOrder)).toContain(POOL_FILE);
    expect(String(doc.applyOrder)).toMatch(/ingest-checklist-csv-to-catalog/);
  });

  it("names exactly one entry: retiring the superseded bowman-chrome ruling row", () => {
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].id).toBe(SUPERSEDED_ID);
  });

  it("classifyEntry (the lane's own validator) accepts the entry as a retire with no destination", () => {
    const e = doc.entries[0];
    const v = classifyEntry(e);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("retire");
    expect(e.to).toBeUndefined();
  });

  it("explains why this is retire+re-mint rather than a reslug", () => {
    expect(JSON.stringify(doc.rulings)).toMatch(/RESLUG was considered and rejected/i);
    expect(JSON.stringify(doc.rulings)).toMatch(/occupied/i);
  });

  it("the reason and evidence name the corrected row and the pre-retire sale count", () => {
    const e = doc.entries[0];
    expect(String(e.reason)).toContain(CORRECTED_ID);
    expect(String(e.evidence)).toMatch(/Pre-retire sold_comps count.*1/i);
  });

  it("does not touch the CPA-BA sibling row -- it is mentioned only as an explicit out-of-scope note, never as an entry", () => {
    const ids = doc.entries.map((e: any) => String(e.id ?? ""));
    expect(ids.some((id: string) => id.includes("cpa-ba"))).toBe(false);
    expect(JSON.stringify(doc.rulings)).toMatch(/does not touch the CPA-BA sibling row/i);
  });
});

describe("execution order is stated consistently across both lists and the manifest", () => {
  it("both lists agree: ingest, then pool relocate, then catalog retire", () => {
    const pool = loadPool();
    const cat = loadCatalog();
    expect(String(pool.finding)).toMatch(/ingest.*mint/i);
    expect(String(cat.applyOrder)).toMatch(/ingest-checklist-csv-to-catalog.*mints/i);
    expect(String(cat.applyOrder)).toMatch(new RegExp(POOL_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("no title stating Red Ink for CPA-VF is ever moved anywhere but the corrected bowman address", () => {
    const pool = loadPool();
    for (const e of pool.entries) {
      const statesRedInk = /title states? red ink|black white red ink/i.test(String(e.evidence ?? "")) || /black white red ink/i.test(String(e.evidence ?? ""));
      if (statesRedInk && e.toCardId) {
        expect(e.toCardId).toBe(CORRECTED_ID);
      }
    }
  });
});
