import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * #1899 -- THE BCP SPLIT-CARD-LINE ROWS (measured read-only 2026-09-06).
 *
 * baseballcardpedia scraped some card lines at the wrong space, so the
 * player's GIVEN NAME became the cardNumber and the rest of the name plus the
 * line's trailing description became the playerName:
 *
 *     hiq:baseball:1998:sp-authentic:gary:base:no-auto
 *         cardNumber "Gary"   playerName "Sheffield 5 X 7 JSY 125"
 *
 * Every number pinned here was MEASURED against prod on the run that wrote the
 * list -- 162 (sport, year, setKey)-bounded slices, 390,883 catalog rows read,
 * each of the 721 damaged slugs point-counted in sold_comps on BOTH
 * c.hobbyiqCardId and c.cardId. A list edited without re-measuring fails here
 * rather than in an apply.
 *
 * WHAT THE MEASUREMENT OVERTURNED, stated because the pins encode it:
 *
 *   THE PREDICATE. "cardNumber has no digit" is NOT the class: it selects PM,
 *   KG, GS, AJ, RL -- SP Authentic's own initials numbering, all correct rows.
 *   A second attempt ("description junk in the number") matched 5,321 rows
 *   whose numbers were AW-15, HG-463, DK-20 -- ordinary insert numbering whose
 *   prefixes merely contain the letters SP/RC/BAT. Both were withdrawn.
 *
 *   THE TWIN. A player-only twin test proposed 223 retires, among them
 *   "Derek Jeter" onto a :refractor: row and "Alex Rodriguez" onto a :gold:
 *   one -- 167 rows retired onto a card they are not. A twin here must match
 *   set AND parallel AND isAuto AND grade segment, which leaves 56.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(path.join(dataDir, "catalog-relocations", "2026-09-06-bcp-damaged-numbers.json"), "utf8"),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
type Deferred = { id: string; proposedAction: string; class: string; reason?: string; evidence?: string };

const entries = list.entries as CatEntry[];
const deferred = list.deferred as Deferred[];

describe("#1899 bcp split-card-line rows: the catalog list", () => {
  it("is addressed to the catalog lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("every entry passes the LANE'S OWN classifier — not a second copy of it", () => {
    const lane = path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs");
    const L = require_(lane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };
    for (const e of entries) {
      const r = L.classifyEntry(e);
      expect(r.ok, `${e.id}: ${r.why ?? ""}`).toBe(true);
    }
  });

  it("acts ONLY where a strict twin exists: 56 retires out of 721 damaged rows", () => {
    expect(list.census.classRows).toBe(721);
    expect(list.census.retireWithStrictTwin).toBe(56);
    expect(entries).toHaveLength(56);
    expect(new Set(entries.map((e) => e.id)).size).toBe(56);
  });

  it("is a retire-only list — nothing is reslugged and nothing is minted", () => {
    // A reslug would move a damaged row onto an address whose number was never
    // read off the card; the number is exactly what this defect destroyed.
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
    }
  });

  it("every retired row names its well-formed twin in the evidence", () => {
    // The twin IS the justification for the delete: without it the row is the
    // only copy of that card and retiring it loses the card.
    for (const e of entries) {
      expect(e.evidence, e.id).toMatch(/WELL-FORMED TWIN: hiq:\S+/);
      const twin = /WELL-FORMED TWIN: (\S+)/.exec(e.evidence ?? "")?.[1] ?? "";
      expect(twin, e.id).not.toBe(e.id);
      // Same product: a twin in another set is not a twin.
      expect(twin.split(":").slice(0, 4).join(":")).toBe(e.id.split(":").slice(0, 4).join(":"));
    }
  });

  it("the 665 without a twin are DEFERRED, never actioned", () => {
    // The lane has no park action (classifyEntry accepts retire|reslug only),
    // and identityUnverified is a sold_comps field with no catalog equivalent.
    expect(list.census.deferredPark).toBe(665);
    expect(deferred).toHaveLength(665);
    for (const d of deferred) expect(d.proposedAction).toBe("park");
    expect(list.census.deferredPersonNoTwin).toBe(230);
    expect(list.census.deferredPageFurniture).toBe(435);
    expect(list.census.deferredPersonNoTwin + list.census.deferredPageFurniture).toBe(665);
  });

  it("no id is in both blocks — a row is retired or deferred, never both", () => {
    const ids = new Set(entries.map((e) => e.id));
    for (const d of deferred) expect(ids.has(d.id)).toBe(false);
    expect(new Set([...ids, ...deferred.map((d) => d.id)]).size).toBe(721);
  });

  it("the class is BCP-ONLY: no other source mints this shape", () => {
    // 468 + 253 = 721. If another source ever appears here the reading that
    // this is a bcp parser artifact is wrong, and this pin says so.
    expect(Object.keys(list.census.bySource).sort()).toEqual([
      "baseballcardpedia",
      "baseballcardpedia-graded",
    ]);
    expect(list.census.bySource["baseballcardpedia"]).toBe(468);
    expect(list.census.bySource["baseballcardpedia-graded"]).toBe(253);
  });

  it("the class is baseball-only — the probe that says so is recorded", () => {
    // baseballcardpedia is a BASEBALL wiki. 42 further slices of football,
    // basketball and hockey (36,746 rows) carry none of this shape, so the
    // baseball-only scope of the census is a measurement and not an omission.
    const probe = list.census.otherSportsProbe;
    expect(probe.hits).toBe(0);
    expect(probe.rowsScanned).toBeGreaterThan(30_000);
    expect(Object.keys(list.census.bySource).every((s) => s.startsWith("baseballcardpedia"))).toBe(true);
  });

  it("NO sale is at risk — the retire costs nothing, and that was measured", () => {
    // retireCatalogRow re-points nothing, so a retire normally hands the row's
    // sales to the rematch. Here there are none to hand over.
    expect(list.census.salesOnDamagedSlugs).toBe(0);
    expect(String(list.poolList)).toMatch(/^NONE/);
  });

  it("records that the scraper no longer mints this shape", () => {
    // Report-only lists are read long after the run. If a future change makes
    // the scraper mint split lines again, this pin is the thing that is wrong.
    expect(list.scraperStatus.stillMints).toBe(false);
    expect(list.scraperStatus.checked).toContain("backend/scripts/scrape-baseballcardpedia.cjs");
    expect(list.scraperStatus.checked).toContain("backend/scripts/scrape-bcp-ladders.cjs");
    // The residual (a line that LEADS with description) is named, not fixed.
    expect(String(list.scraperStatus.residualDefectNotFixedHere)).toMatch(/Separate PR/i);
  });

  it("the withdrawn over-firing predicates are recorded, not silently dropped", () => {
    const rulings = JSON.stringify(list.rulings);
    expect(rulings).toMatch(/NOT 'NO DIGIT'/);
    expect(rulings).toMatch(/AW-15|HG-463/);
    expect(rulings).toMatch(/A TWIN IS THE SAME CARD, NOT THE SAME PLAYER/);
    expect(rulings).toMatch(/RETIRE IS A DELETE/);
  });
});

describe("#1899: the damaged shape itself", () => {
  /** The word the split left in the cardNumber slot, as the slug carries it. */
  const numberSegment = (id: string) => id.split(":")[4] ?? "";

  it("every listed row's number segment is a bare word, never a card number", () => {
    // A real card number always carries a digit somewhere (12, BD-152, 4C).
    // These carry none: the segment is a word the parser took off a card line.
    for (const e of [...entries, ...deferred]) {
      const seg = numberSegment(e.id);
      expect(seg, e.id).not.toBe("");
      expect(seg, e.id).not.toMatch(/\d/);
      expect(seg, e.id).toMatch(/^[a-z]+$/);
    }
  });

  it("every listed row states the reconstructed identity the split destroyed", () => {
    // The evidence has to say what the row WAS, or a reviewer cannot tell a
    // lost card from a duplicate one.
    for (const e of [...entries, ...deferred]) {
      expect(e.evidence, e.id).toMatch(/reconstructed identity is/);
      expect(e.evidence, e.id).toMatch(/source baseballcardpedia/);
    }
  });

  it("the anchor row from the finding is present and deferred, not retired", () => {
    // 1998 SP Authentic "Gary" / "Sheffield 5 X 7 JSY 125" has no well-formed
    // twin, so it PARKS: retiring it would lose the card outright.
    const anchor = "hiq:baseball:1998:sp-authentic:gary:base:no-auto";
    expect(entries.some((e) => e.id === anchor)).toBe(false);
    const d = deferred.find((x) => x.id === anchor);
    expect(d, "anchor row must be in the deferred block").toBeTruthy();
    expect(d?.class).toBe("person-no-twin");
  });

  it("the wiki page footer is classified as furniture, not as a person", () => {
    // "This page was last edited on <date>" is the baseballcardpedia FOOTER.
    // 191 rows carry it. It is not a card and has no identity to re-key onto.
    const footers = deferred.filter((d) => /page was last edited/i.test(d.evidence ?? ""));
    expect(footers.length).toBe(191);
    for (const f of footers) expect(f.class).toBe("page-furniture");
  });

  it("a legitimate initials number is NOT in the list", () => {
    // PM = Paul Molitor, KG = Ken Griffey Jr. -- SP Authentic's own numbering.
    // These are the rows the withdrawn "no digit" predicate would have taken.
    const all = new Set([...entries.map((e) => e.id), ...deferred.map((d) => d.id)]);
    for (const id of [
      "hiq:baseball:1998:sp-authentic:pm:base:auto:psa-8",
      "hiq:baseball:1998:sp-authentic:kg:base:auto:psa-9",
      "hiq:baseball:1998:sp-authentic:gs:base:no-auto:psa-9",
    ]) {
      expect(all.has(id), `${id} is correct numbering and must not be listed`).toBe(false);
    }
  });
});
