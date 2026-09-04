/**
 * CF-THE-SLUG'S-YEAR-IS-THE-IDENTITY-YEAR (Drew, 2026-09-04).
 *
 * THE ROW THAT MOTIVATED IT. The GREAT REMATCH's per-product catalog read
 * reported, for the 1987 Tiffany Maddux:
 *
 *     topps-traded-tiffany | total 39 | strict-checklist 0 | has 70T: 0
 *
 * so the 22 Tiffany-titled 1987 Topps Traded Maddux #70T rows stayed CONFLICT.
 * The catalog was NOT missing the card. Measured read-only, point-read:
 *
 *     hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto
 *       { year: 1987, cardYear: ABSENT, source: "sportscardchecklist-2026-09-04" }
 *
 * -- a STRICT checklist source, present, correct, and invisible, because every
 * product-level lookup filtered `c.cardYear = @y` and this row has no cardYear.
 *
 * `cardYear` is a MIRROR of `year`, never a second fact. The identity year is
 * the one IN THE SLUG. So the fix is at both ends and both are pinned here:
 *
 *   1. THE READER accepts either name. A row shaped like the real Maddux row
 *      (year set, cardYear absent) is checklist-backed.
 *   2. THE WRITER dual-writes, so the field is never absent again -- both in
 *      the checklist ingest that mints these rows, and in the merge that
 *      re-ingests over rows already stored without it.
 *
 * MUTATION PIN: revert the reader to `c.cardYear = @y` alone and the Maddux
 * row goes invisible again. Asserted below on the query TEXT, because the
 * query is the thing that was wrong -- a test that only exercised a JS filter
 * would have passed against the defect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mergeCatalogEntries, deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const REMATCH = read("../scripts/rematch-sold-comps.cjs");
const INGEST = read("../scripts/ingest-checklist-csv-to-catalog.cjs");

/** The real row, point-read from prod 2026-09-04. `cardYear` is ABSENT --
 *  not null, not 0. Absent is what a `c.cardYear = @y` filter cannot see. */
const MADDUX_TIFFANY_ROW = {
  id: "hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto",
  year: 1987,
  source: "sportscardchecklist-2026-09-04",
  setKey: "topps-traded-tiffany",
  cardNumber: "70T",
  playerName: "Greg Maddux",
  isAuto: false,
} as const;

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");

/**
 * THE SECOND DEFECT, found while proving the first. Fixing the year filter
 * widened the 1987 topps-traded-tiffany read from 39 rows to 171 -- and STRICT
 * was still 0, because `sportscardchecklist` was missing from the strict
 * allowlist. Both had to be fixed; either alone leaves the Maddux in CONFLICT.
 *
 * Measured against prod, read-only, 2026-09-04:
 *   before both fixes  total  39 | strict   0 | has 70T: false
 *   year fix only      total 171 | strict   0 | has 70T: false
 *   both fixes         total 171 | strict 132 | has 70T: TRUE
 */
describe("sportscardchecklist is a strict checklist source", () => {
  it("the loose and strict predicates agree about a sportscardchecklist row", () => {
    // The LOOSE gate always matched it (the regex sees "checklist"), so the two
    // predicates disagreed about the same row -- the split this list prevents.
    expect(K.isStrictChecklistSource("sportscardchecklist-2026-09-04")).toBe(true);
    expect(K.isStrictChecklistSource("sportscardchecklist")).toBe(true);
  });
  it("MUTATION PIN: the Maddux destination row's own source is strict", () => {
    expect(K.isStrictChecklistSource(MADDUX_TIFFANY_ROW.source)).toBe(true);
  });
  it("still refuses a source that is not a checklist publisher", () => {
    expect(K.isStrictChecklistSource("ebay-scrape")).toBe(false);
    expect(K.isStrictChecklistSource("derived-from-base-checklist-2026-08-30")).toBe(false);
    expect(K.isStrictChecklistSource("")).toBe(false);
  });
});

describe("the catalog's identity year is `year`; `cardYear` is its mirror", () => {
  it("the Maddux Tiffany row really is shaped this way: year set, cardYear ABSENT", () => {
    expect(MADDUX_TIFFANY_ROW.year).toBe(1987);
    expect("cardYear" in MADDUX_TIFFANY_ROW).toBe(false);
  });

  it("MUTATION PIN: no product-level catalog read filters on cardYear alone", () => {
    // Every catalog query in the rematch that constrains a year must accept
    // BOTH names. `c.cardYear = @y` on its own is the defect, verbatim.
    const catalogQueries = REMATCH.split("\n").filter((l) =>
      /FROM c WHERE c\.setKey = @sk/.test(l));
    expect(catalogQueries.length).toBeGreaterThanOrEqual(4);
    for (const q of catalogQueries) {
      expect(q).toMatch(/\$\{yearMatch\("c"\)\}/);
      expect(q).not.toMatch(/c\.cardYear = @y(?!\d)/);
      expect(q).not.toMatch(/AND c\.year = @y(?!\d)/);
    }
  });

  it("the year predicate matches a row that has ONLY `year`, and one that has only `cardYear`", () => {
    const m = REMATCH.match(/const yearMatch = \(alias\) => `([^`]+)`/);
    expect(m).toBeTruthy();
    const sql = m![1].replace(/\$\{alias\}/g, "c");
    expect(sql).toContain("c.cardYear = @y");
    expect(sql).toContain("c.year = @y");
    expect(sql.trim().startsWith("(")).toBe(true); // OR must be parenthesised,
    expect(sql.trim().endsWith(")")).toBe(true);   // or it swallows the AND
  });

  it("the checklist ingest dual-writes cardYear alongside year", () => {
    // This lane hand-rolls its doc instead of going through
    // deriveCatalogEntry, which is how it shipped `year` alone.
    expect(INGEST).toMatch(/cardYear: product\.year/);
    const doc = INGEST.slice(INGEST.indexOf("await upsertCatalogEntry({"));
    expect(doc.slice(0, 2000)).toMatch(/year: product\.year/);
  });

  it("deriveCatalogEntry -- the canonical constructor -- already writes both", () => {
    const e = deriveCatalogEntry({
      sport: "baseball", year: 1987, setKey: "topps-traded-tiffany", cardNumber: "70T",
      parallel: "Base", isAuto: false, printRun: null, playerName: "Greg Maddux",
      source: "sportscardchecklist-2026-09-04" as never, confidence: 0.95,
    }) as unknown as Record<string, unknown>;
    expect(e).toBeTruthy();
    expect(e.year).toBe(1987);
    expect(e.cardYear).toBe(1987);
    expect(e.id).toBe(MADDUX_TIFFANY_ROW.id);
  });

  it("re-ingesting over a stored row that LACKS cardYear fills it in, even when the incoming row loses", () => {
    const incoming = deriveCatalogEntry({
      sport: "baseball", year: 1987, setKey: "topps-traded-tiffany", cardNumber: "70T",
      parallel: "Base", isAuto: false, printRun: null, playerName: "Greg Maddux",
      source: "sportscardchecklist-2026-09-04" as never, confidence: 0.95,
    })!;
    // The stored row outranks nothing -- it is the SAME source at a HIGHER
    // confidence, so the incoming row loses and the existing row is kept
    // wholesale. cardYear must still be backfilled: it asserts nothing.
    const existing = { ...MADDUX_TIFFANY_ROW, confidence: 0.99, vendorIds: {} } as never;
    const { merged, winnerIsIncoming } = mergeCatalogEntries(incoming, existing, "2026-09-04T00:00:00Z");
    expect(winnerIsIncoming).toBe(false);
    expect((merged as unknown as Record<string, unknown>).cardYear).toBe(1987);
    // ...and it did not overwrite anything the existing row asserts.
    expect(merged.playerName).toBe("Greg Maddux");
    expect(merged.source).toBe("sportscardchecklist-2026-09-04");
  });

  it("backfill never OVERWRITES a cardYear the stored row already states", () => {
    const incoming = deriveCatalogEntry({
      sport: "baseball", year: 1987, setKey: "topps-traded-tiffany", cardNumber: "70T",
      parallel: "Base", isAuto: false, printRun: null, playerName: "Greg Maddux",
      source: "sportscardchecklist-2026-09-04" as never, confidence: 0.95,
    })!;
    const existing = { ...MADDUX_TIFFANY_ROW, cardYear: 1987, confidence: 0.99, vendorIds: {} } as never;
    const { merged } = mergeCatalogEntries(incoming, existing, "2026-09-04T00:00:00Z");
    expect((merged as unknown as Record<string, unknown>).cardYear).toBe(1987);
  });
});
