import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { productYearsOf, correctedYear } = require("../scripts/lib/product-year-from-set-name.cjs");

/**
 * CF-A-PUBLICATION-YEAR-IS-NOT-THE-PRODUCT-YEAR (2026-09-06).
 *
 * A hobbymonitor release URL can end in the year the PAGE was published rather
 * than the year the PRODUCT was issued, and the universe enumeration read that
 * trailing number as the product year. The result was 69,325 card_catalog rows
 * whose own setName contradicts their own year field (#1904 census, #1912).
 *
 * The table below is the pin. It carries BOTH directions deliberately:
 *
 *   POSITIVES  the URL's trailing number is a PUBLICATION year and the queued
 *              year is wrong. These must be corrected to the setName's year.
 *
 *   NEGATIVES  the trailing number IS the product year, or the label is a
 *              split season whose second year is legitimate (#1852). These
 *              must be left ALONE -- a rule that "fixes" them would collapse
 *              75,896 correctly-placed split-season rows onto the wrong end of
 *              their own label and CREATE the pool split it exists to prevent.
 */

describe("productYearsOf — what a setName legitimately admits", () => {
  it("a single-year label admits exactly its own year", () => {
    expect(productYearsOf("2024 Topps Finest Football")).toEqual([2024]);
    expect(productYearsOf("1933 Goudey Baseball")).toEqual([1933]);
  });

  it("a split-season label admits EITHER season year", () => {
    expect(productYearsOf("2024/25 Panini Select Basketball")).toEqual([2024, 2025]);
    expect(productYearsOf("2024-25 Panini Select Basketball")).toEqual([2024, 2025]);
    expect(productYearsOf("2022 23 upper deck clear cut hockey")).toEqual([2022, 2023]);
  });

  it("rolls the century rather than reading 1999/00 as 1900", () => {
    expect(productYearsOf("1999/00 Topps Basketball")).toEqual([1999, 2000]);
  });

  it("a non-consecutive pair is not a season, so only the leading year stands", () => {
    // A checklistcenter dual-season URL name ("2021-22-2022-23-...") must not
    // be read as admitting a year four apart from its lead.
    expect(productYearsOf("2022 26 Something")).toEqual([2022]);
  });

  it("states no year -> admits nothing, and the caller must not guess", () => {
    expect(productYearsOf("Topps Chrome")).toEqual([]);
    expect(productYearsOf("")).toEqual([]);
    expect(productYearsOf(null)).toEqual([]);
    expect(correctedYear("Topps Chrome", 2025)).toBeNull();
  });

  it("a null year is never invented", () => {
    expect(correctedYear("2024 Topps Finest Football", null)).toBeNull();
  });
});

describe("the 21 queue entries whose year was a publication year", () => {
  // POSITIVES: every one of these was queued a year late. Taken verbatim from
  // backend/data/ingest-universe.json as it stood before this fix.
  const POSITIVES: Array<[string, number, number]> = [
    ["2023/24 Panini Flawless Basketball", 2025, 2023],
    ["2023/24 Panini Immaculate Basketball", 2025, 2023],
    ["2023/24 Topps Three Basketball", 2025, 2023],
    ["2023/24 Topps Royalty Basketball", 2025, 2023],
    ["2024 Panini Clearly Donruss Football", 2025, 2024],
    ["2024 Panini Contenders Football", 2025, 2024],
    ["2024 Panini Flawless Baseball", 2025, 2024],
    ["2024 Panini Immaculate Football", 2025, 2024],
    ["2024 Panini Impeccable Football", 2025, 2024],
    ["2024 Panini National Treasures Baseball", 2025, 2024],
    ["2024 Panini Phoenix Football", 2025, 2024],
    ["2024 Panini Select Baseball", 2025, 2024],
    ["2024 Panini Select Football", 2025, 2024],
    ["2024 Topps Chrome Football", 2025, 2024],
    ["2024 Topps Dune Chrome", 2025, 2024],
    ["2024 Topps Finest Football", 2025, 2024],
    ["2024 Topps Resurgence Football", 2025, 2024],
    ["2025 Bowman Draft Sapphire Baseball", 2026, 2025],
    ["2025 Topps Chrome Update Series Sapphire Baseball", 2026, 2025],
    ["2025 Topps Disneyland 70th Anniversary", 2026, 2025],
    ["2022 23 upper deck clear cut hockey", 2021, 2022],
  ];

  it.each(POSITIVES)("%s queued as %i is corrected to %i", (setName, queued, want) => {
    expect(correctedYear(setName, queued)).toBe(want);
  });

  it("carries all 21", () => {
    expect(POSITIVES).toHaveLength(21);
  });
});

describe("negatives — the trailing number IS the product year, or the split is legitimate", () => {
  /**
   * THE SPLIT-SEASON NEGATIVES ARE THE LOAD-BEARING HALF. Each of these was
   * queued with the SECOND year of its own split label. #1912 measured the
   * corpus convention: 75,896 rows sit on the second season year and 0 on the
   * first. Correcting these to the leading year would move a product's cards
   * off the year the rest of the corpus uses -- a pool split, manufactured by
   * a rule meant to prevent one.
   */
  const SPLIT_LEGITIMATE: Array<[string, number]> = [
    ["2024/25 Panini Donruss Optic Basketball", 2025],
    ["2024/25 Panini Haunted Hoops Basketball", 2025],
    ["2024/25 Panini National Treasures Basketball", 2025],
    ["2024/25 Panini Noir Basketball", 2025],
    ["2024/25 Panini Origins Basketball", 2025],
    ["2024/25 Panini Revolution Basketball", 2025],
    ["2024/25 Panini Select Basketball", 2025],
    ["2024/25 Panini Silhouette Basketball", 2025],
    ["2024/25 Topps Finest Basketball", 2025],
    ["2024/25 Panini Eminence Basketball", 2025],
    ["2024/25 Panini Immaculate Basketball", 2025],
    ["2024/25 Panini One & One Basketball", 2025],
    ["2024/25 Panini Prizm Black Basketball", 2025],
    ["2024/25 Topps Chrome Basketball", 2025],
    ["2024/25 Topps Inception Basketball", 2025],
    ["2025/26 Panini Select Basketball", 2026],
    ["2025/26 Topps Cosmic Chrome Basketball", 2026],
  ];

  it.each(SPLIT_LEGITIMATE)("%s at %i is a season year, left alone", (setName, queued) => {
    expect(correctedYear(setName, queued)).toBeNull();
  });

  it("carries all 17 split-season negatives", () => {
    expect(SPLIT_LEGITIMATE).toHaveLength(17);
  });

  it.each([
    ["2026 Donruss Baseball", 2026],
    ["1933 Goudey Baseball", 1933],
    ["2024 Topps Chrome Baseball", 2024],
    ["2021 Bowman Chrome Baseball", 2021],
  ])("%s at %i already agrees and is untouched", (setName, queued) => {
    expect(correctedYear(setName, queued)).toBeNull();
  });
});

describe("the committed universe manifest carries no year that contradicts its own setName", () => {
  it("has zero residual disagreements", () => {
    const p = path.join(__dirname, "..", "data", "ingest-universe.json");
    const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
    const bad = (manifest.entries as Array<{ setName: string; year: number | null; id: string }>)
      .filter((e) => correctedYear(e.setName, e.year) != null)
      .map((e) => `${e.id} — setName "${e.setName}" vs year ${e.year}`);
    expect(bad).toEqual([]);
  });

  it("still carries every entry — a correction is never a drop", () => {
    const p = path.join(__dirname, "..", "data", "ingest-universe.json");
    const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(manifest.entries.length).toBe(18115);
  });
});
