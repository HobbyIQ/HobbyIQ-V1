import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service";

const require_ = createRequire(import.meta.url);

/**
 * CF-B25-IS-BOWMANS-BEST-NOT-A-CPA-RUNG (2026-09-26, corrected 2026-09-26
 * after review). Supersedes closed PR #2425 ("fix(catalog): 2025 Bowman's
 * Best B25- rows re-keyed bowman → bowmans-best (297 rows)"), which was
 * rejected on adversarial review: it moved all 297
 * hiq:baseball:2025:bowman:b25-* rows verbatim to bowmans-best:, but 293/297
 * had no rung twin there because Refractor /499 and Purple Refractor /250
 * are NOT Bowman's Best print runs — they are the classic Bowman Chrome /
 * Bowman Draft "Chrome Prospect Autographs" (CPA-) rungs, confirmed against
 * checklistinsider's own 2025 Bowman Chrome page (Refractor /499, Purple
 * Refractor /250, Green Refractor /99) and absent from Bowman flagship and
 * Bowman Draft entirely for a B25- prefix.
 *
 * checklistinsider's 2025 Bowman's Best page confirms B25- is the "Best of
 * 2025 Autographs" insert's own prefix (131-card autograph insert), and the
 * player + cardNumber pool of these 297 rows matches that insert's checklist
 * exactly. 1,252 sold_comps sales at hobbyiqCardId hiq:baseball:2025:
 * bowman:b25-* carry CardHedge titles reading literally "2025 Bowman's Best
 * Baseball #B25-XXX <parallel>", corroborating the product independently of
 * the catalog rows. Re-deriving the correct RUNG (not just the correct
 * setKey) against 2,725 checklist-grade bowmans-best B25- auto rows finds an
 * exact-rung twin for 292 of the 297 rows once the print run is corrected
 * (Refractor unnumbered, Purple Refractor /75, Green Refractor /99, Base
 * Autograph un-numbered or per-player numbered).
 *
 * The remaining 5 excluded rows are ALL no-auto Base rows (source
 * ingest-auto-seed-graded, isAuto=false) — the SAME FIVE PLAYERS also have
 * their auto rows (Refractor, Purple Refractor, Base Autograph) correctly
 * retired below with valid checklist-grade twins; only these specific
 * no-auto ids are excluded, not the players:
 *   hiq:baseball:2025:bowman:b25-jg:base:no-auto:psa-10  (Josuar Gonzalez)
 *   hiq:baseball:2025:bowman:b25-al:base:no-auto:psa-9   (Arnaldo Lantigua)
 *   hiq:baseball:2025:bowman:b25-km:base:no-auto:psa-8   (Kevin McGonigle)
 *   hiq:baseball:2025:bowman:b25-jjw:base:no-auto:psa-9  (JJ Wetherholt)
 *   hiq:baseball:2025:bowman:b25-csi:base:no-auto:psa-10 (Chandler Simpson)
 * jg and km have no no-auto twin at all under setKey=bowmans-best. al, jjw
 * and csi have cardhedge-graded no-auto rows with setKey='bowmans-best' (a
 * live query confirms there is NO second setKey spelling for 2025 baseball —
 * CONTAINS(c.setKey, "'") returns 0 rows), but those specific rows' own `id`
 * strings carry a self-inconsistent literal apostrophe ("bowman's-best")
 * that does not match their setKey field — a pre-existing id/setKey mismatch
 * on those rows, not a second product, and not a safe fold target as-is. An
 * earlier draft of this list mis-described this as "a second setKey" and
 * mis-described all five players as parked; both are corrected here.
 *
 * 0/1,252 sold_comps sales match any of the 297 rows' exact ids (measured
 * 2026-09-26, unchanged by PR #2425's review and by this list) — this list
 * relocates no sales, only retires 292 phantom-rung catalog rows. An earlier
 * draft additionally claimed 80 of the 1,252 sales had an exact-id home
 * under bowmans-best; that figure did not reproduce on review and is dropped
 * rather than restated.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-26-b25-derived-under-bowman-retire.json"),
    "utf8",
  ),
);

type CatEntry = {
  id: string;
  action: string;
  to?: string;
  reason?: string;
  evidence?: string;
  salesAtRetireTime?: number;
  checkedAt?: string;
};
const entries = list.entries as CatEntry[];

const EXCLUDED_5 = [
  "hiq:baseball:2025:bowman:b25-jg:base:no-auto:psa-10",
  "hiq:baseball:2025:bowman:b25-al:base:no-auto:psa-9",
  "hiq:baseball:2025:bowman:b25-km:base:no-auto:psa-8",
  "hiq:baseball:2025:bowman:b25-jjw:base:no-auto:psa-9",
  "hiq:baseball:2025:bowman:b25-csi:base:no-auto:psa-10",
];

/** The setKey:cardNumber segment of a hiq slug, lowercased. */
function idParts(id: string): string[] {
  return id.split(":");
}

/** The setKey:cardNumber prefix (first 5 colon-segments) of a hiq slug. */
function cardStemOf(id: string): string {
  return idParts(id).slice(0, 5).join(":");
}

describe("2026-09-26 B25- derived rows under bowman: the catalog retire list", () => {
  it("is addressed to the catalog lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("has a checkedAt header", () => {
    expect(list.checkedAt).toBeTruthy();
    expect(() => new Date(list.checkedAt).toISOString()).not.toThrow();
  });

  it("every entry passes the LANE'S OWN classifier — not a second copy of it", () => {
    const lane = path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs");
    const L = require_(lane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };
    for (const e of entries) {
      const r = L.classifyEntry(e);
      expect(r.ok, `${e.id}: ${r.why ?? ""}`).toBe(true);
    }
  });

  it("is exactly 292 retires, all unique ids, in stable sorted order", () => {
    expect(list.census.totalRetires).toBe(292);
    expect(entries).toHaveLength(292);
    expect(new Set(entries.map((e) => e.id)).size).toBe(292);
    const ids = entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("is a retire-only list — nothing is reslugged, nothing is minted", () => {
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
      expect(e.reason, e.id).toBeTruthy();
      expect(e.evidence, e.id).toBeTruthy();
    }
  });

  it("every entry carries a structured salesAtRetireTime of 0 and a checkedAt", () => {
    for (const e of entries) {
      expect(e.salesAtRetireTime, e.id).toBe(0);
      expect(e.checkedAt, e.id).toBe(list.checkedAt);
    }
  });

  it("every entry is setKey bowman, cardYear 2025, cardNumber B25-*", () => {
    for (const e of entries) {
      const parts = idParts(e.id);
      expect(parts[0], e.id).toBe("hiq");
      expect(parts[1], e.id).toBe("baseball");
      expect(parts[2], e.id).toBe("2025");
      expect(parts[3], e.id).toBe("bowman");
      expect(parts[4]?.toUpperCase().startsWith("B25-"), e.id).toBe(true);
    }
  });

  it("every entry names a checklist-grade twin under bowmans-best via catalogAuthorityOf", () => {
    for (const e of entries) {
      const twinMatch = String(e.evidence ?? "").match(
        /Checklist-grade twin (hiq:baseball:2025:bowmans-best:[^,]+), source=([^,]+),/,
      );
      expect(twinMatch, `${e.id} evidence must cite a bowmans-best twin with a source`).not.toBeNull();
      const [, twinId, twinSource] = twinMatch as RegExpMatchArray;
      expect(twinId.startsWith("hiq:baseball:2025:bowmans-best:"), e.id).toBe(true);
      expect(catalogAuthorityOf(twinSource), `${e.id} twin source ${twinSource} must be checklist-grade`).toBe(
        "checklist",
      );
    }
  });

  it("every entry's evidence states 0 sold_comps sales at the source id", () => {
    for (const e of entries) {
      expect(String(e.evidence ?? "")).toMatch(/sold_comps rows pointing at the source id.*:\s*0\.$/);
    }
  });

  it("names exactly the 5 excluded ids, and none of them appear in the entries", () => {
    expect(list.census.candidatesMeasured).toBe(297);
    expect(list.census.checklistGradeTwinAtCorrectedRungSameSetKey).toBe(292);
    expect(list.census.excludedCount).toBe(5);
    expect(list.census.excludedIds).toEqual(EXCLUDED_5);
    expect(list.census.checklistGradeTwinAtCorrectedRungSameSetKey + list.census.excludedCount).toBe(297);

    const ids = new Set(entries.map((e) => e.id));
    for (const excludedId of EXCLUDED_5) {
      expect(ids.has(excludedId), `${excludedId} must be ABSENT from entries`).toBe(false);
    }
  });

  it("keeps the 5 excluded players' OTHER (auto) rows in the retire list — the row is excluded, not the player", () => {
    const excludedStems = new Set(EXCLUDED_5.map(cardStemOf));
    for (const stem of excludedStems) {
      const sameStemEntries = entries.filter((e) => cardStemOf(e.id) === stem);
      expect(sameStemEntries.length, `${stem} should have 3 auto retires (Refractor, Purple Refractor, Base Autograph)`).toBe(3);
      for (const e of sameStemEntries) {
        expect(e.id, e.id).not.toBe(EXCLUDED_5.find((x) => cardStemOf(x) === stem));
      }
    }
  });

  it("attributes the exclusion breakdown correctly: 2 with no twin, 3 with an id/setKey mismatch on the twin candidate", () => {
    expect(list.census.excludedReasonBreakdown.noTwinAtAll).toBe(2);
    expect(list.census.excludedReasonBreakdown.twinIdInconsistentWithOwnSetKey).toBe(3);
    expect(
      list.census.excludedReasonBreakdown.noTwinAtAll + list.census.excludedReasonBreakdown.twinIdInconsistentWithOwnSetKey,
    ).toBe(5);
  });

  it("does not claim a second setKey spelling exists — the finding names it as an id/setKey mismatch, not a split product", () => {
    expect(String(list.finding)).not.toMatch(/split-identity setKey/i);
    expect(String(list.finding)).toMatch(/not a second product or a second setKey/i);
    expect(String(list.finding)).toMatch(/id\/setKey mismatch|inconsistent/i);
  });

  it("does not restate the unreproduced 80-sales figure", () => {
    expect(list.census.salesWithExactIdHomeUnderBowmansBest).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/80 with an exact-id home/);
  });

  it("names the sales-repoint report: 1,252 total, 0 exact-id matches to the 297 rows", () => {
    expect(list.census.salesAtBowmanB25Total).toBe(1252);
    expect(list.census.salesMatchingAnyOf297RowIdsExactly).toBe(0);
  });

  it("records the supersession of closed PR #2425 by name", () => {
    expect(String(list.finding)).toMatch(/#2425/);
    expect(String(list.finding)).toMatch(/Refractor \/499/);
    expect(String(list.finding)).toMatch(/Purple Refractor \/250/);
  });

  it("touches only the phantom-rung parallels the incident named (Refractor, Purple Refractor, Green Refractor, Base Autograph)", () => {
    const parallels = new Set(Object.keys(list.census.byParallel));
    expect(parallels).toEqual(new Set(["Refractor", "Base Autograph", "Purple Refractor", "Green Refractor"]));
    const total = Object.values(list.census.byParallel as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(292);
  });
});
