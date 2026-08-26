/**
 * CF-GUARD-THE-CATALOG-WRITE-CONTRACT (Drew, 2026-08-26: "creation and repair
 * BUT equal").
 *
 * card_catalog has no agreed addressing contract, and that -- not any single
 * bug -- is what cost four days. Three live code paths each believed something
 * different:
 *
 *   catalogMatcher.service.ts   item(slug, slug)          canonical
 *   explodeCatalogGrades.cjs    cardId = parent.cardId    co-located ladder
 *   cardCatalog.service.ts      item(slug, SPORT)         stale; returned null
 *                                                         for every row in a
 *                                                         48M-row container
 *
 * Every repair was correct under one belief and wrong under another, which is
 * why fixes kept not sticking: the re-home moved rows the explode re-broke,
 * half-moved twins accumulated, and matching stayed poor no matter what was
 * normalised.
 *
 * THE CONTRACT: id === cardId === the hiq slug. Every row is its own
 * single-document partition, which is what makes the ~1 RU point read work and
 * what deriveCatalogEntry already does. upsertCatalogEntry is the write side.
 *
 * This asserts that a script writing card_catalog goes through that path. It
 * cannot check what a script does at RUNTIME -- only that it did not hand-roll
 * its own row shape, which is where every one of these defects came from.
 *
 * BYPASSING is a debt list, not an exemption list. It may shrink and must never
 * grow. This debt compounds unusually badly: each bypassing writer produces
 * rows a later sweep has to find and repair, and we have now watched that cycle
 * run for four days.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const CANONICAL = /deriveCatalogEntry|upsertCatalogEntry/;
const WRITES = /items\.upsert|items\.bulk|items\.create/;
const TOUCHES = /container\("card_catalog"\)/;

/** Writers that hand-roll their own catalog rows, as of 2026-08-26. */
const BYPASSING = new Set([
  "backend/scripts/attachImagesToCatalog.cjs",
  "backend/scripts/attest-unnumbered-by-player.cjs",
  "backend/scripts/auto-label-catalog-variants.cjs",
  "backend/scripts/backfill-canonicalize-chrome-slugs.cjs",
  "backend/scripts/backfill-catalog-cs-images.cjs",
  "backend/scripts/backfill-catalog-driven-canonicalize.cjs",
  "backend/scripts/backfill-catalog-from-sold-comps.cjs",
  "backend/scripts/backfill-cs-card-population.cjs",
  "backend/scripts/backfill-searchtokens-all-sports.cjs",
  "backend/scripts/backfill-stage2-title-parser.cjs",
  "backend/scripts/build-tree-nodes.ts",
  "backend/scripts/bulk-build-catalog.ts",
  "backend/scripts/catalog-sales-synth.cjs",
  "backend/scripts/comp-quality/backfill-search-fields.cjs",
  "backend/scripts/comp-quality/create-product-line-cards-from-base.cjs",
  "backend/scripts/comp-quality/create-tiffany-cards-from-base.cjs",
  "backend/scripts/dedupe-catalog-by-hobbyiq.cjs",
  "backend/scripts/dedupe-catalog-partition-shadows.cjs",
  "backend/scripts/dedupe-catalog-setkeys.ts",
  "backend/scripts/expand-catalog-from-cardsight.cjs",
  "backend/scripts/expand-catalog-from-sold-comps-gaps.cjs",
  "backend/scripts/expand-catalog-from-tcdb.cjs",
  "backend/scripts/expand-catalog-full-enumeration.cjs",
  "backend/scripts/fillCatalogFromChecklists.cjs",
  "backend/scripts/fix-catalog-parallel-as-player.cjs",
  "backend/scripts/fixGriffeyMissingHoldings.cjs",
  "backend/scripts/fixVladBCP150Catalog.cjs",
  "backend/scripts/import-bccp-to-catalog.ts",
  "backend/scripts/import-clc-to-catalog.ts",
  "backend/scripts/ingestBaseballAlmanac.cjs",
  "backend/scripts/ingestBaseballCardPedia.cjs",
  "backend/scripts/ingestBeckettChecklist.cjs",
  "backend/scripts/ingestBeckettChecklistDataDriven.cjs",
  "backend/scripts/ingestChecklistCenter.cjs",
  "backend/scripts/ingestChecklistCenterHtml.cjs",
  "backend/scripts/match-catalog-to-alt-sources.ts",
  "backend/scripts/match-catalog-to-bccp.ts",
  "backend/scripts/match-catalog-to-xlsx.ts",
  "backend/scripts/migrate-catalog-setkey.cjs",
  "backend/scripts/normalize-catalog-format.cjs",
  "backend/scripts/normalize-catalog-schema.cjs",
  "backend/scripts/normalizeVendorRows.cjs",
  "backend/scripts/priorityCatalogReslug.cjs",
  "backend/scripts/recoverCardsightStubs.cjs",
  "backend/scripts/recoverCardsightViaTca.cjs",
  "backend/scripts/rehome-catalog-rows-to-own-partition.cjs",
  "backend/scripts/repairMegaBoxAndInsertComps.cjs",
  "backend/scripts/reslugCatalogFromCurrent.cjs",
  "backend/scripts/resolve-sales-without-identity.cjs",
  "backend/scripts/resport-mistagged-pokemon.cjs",
  "backend/scripts/seedCatalogFromUnmatchedPool.cjs",
  "backend/scripts/tca-match-enricher.cjs",
  "backend/scripts/tcdbBatchFill.cjs",
  "backend/src/services/portfolioiq/catalogReview.service.ts",
  "backend/src/services/portfolioiq/checklistDiff.service.ts",
  "backend/src/services/portfolioiq/ebayAutoHolding.service.ts",
  "backend/src/services/portfolioiq/ebayReviewQueue.service.ts",
  "backend/src/services/portfolioiq/persistVendorSalesToPool.service.ts",]);

function catalogWriters(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const dir of ["backend/src", "backend/scripts"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|cjs|js|mjs)$/.test(e.name)) continue;
        let src = "";
        try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (!TOUCHES.test(src) || !WRITES.test(src)) continue;
        out.push({ rel: path.relative(ROOT, p).split(path.sep).join("/"), src });
      }
    };
    walk(base);
  }
  return out;
}

describe("one way to build a catalog row", () => {
  it("finds the writers", () => {
    expect(catalogWriters().length).toBeGreaterThan(20);
  });

  it("no NEW writer may hand-roll a catalog row", () => {
    const rogue = catalogWriters()
      .filter((w) => !CANONICAL.test(w.src) && !BYPASSING.has(w.rel))
      .map((w) => w.rel);
    expect(rogue, `these write card_catalog without deriveCatalogEntry/upsertCatalogEntry:\n  ${rogue.join("\n  ")}`)
      .toEqual([]);
  });

  it("the debt list only names files that still bypass", () => {
    // Once converted, a name must come OUT, or the list stops meaning anything
    // and silently re-permits the next regression.
    const stale = [...BYPASSING].filter((rel) => {
      const p = path.join(ROOT, rel);
      return fs.existsSync(p) && CANONICAL.test(fs.readFileSync(p, "utf8"));
    });
    expect(stale, `converted but still listed as debt - remove from BYPASSING:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });

  it("the debt is measured, so it can be seen shrinking", () => {
    const all = catalogWriters();
    const ok = all.filter((w) => CANONICAL.test(w.src)).length;
    // eslint-disable-next-line no-console
    console.log(`catalog writers using the builder: ${ok}/${all.length}  (debt ${all.length - ok})`);
    // Measured floor, not an aspiration: 2 of the writers currently build
    // through the canonical path. This can only go up -- if it drops, a writer
    // was converted back to hand-rolling and that is a regression.
    expect(ok).toBeGreaterThanOrEqual(2);
  });
});
