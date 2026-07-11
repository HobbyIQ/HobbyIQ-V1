#!/usr/bin/env node
/**
 * CF-COVERAGE-AUDIT (2026-07-11, Drew).
 *
 * Audits the reference-catalog container to find product/year gaps:
 *   1. What productKeys are missing entirely for each year they should exist
 *   2. Which productKeys have thin coverage (< 5 rows for a year they exist in)
 *   3. Cross-reference against a canonical list of known baseball products
 */

const { CosmosClient } = require("@azure/cosmos");
const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database("hobbyiq").container("reference-catalog");

// Canonical map: productKey -> years the product existed
const CANONICAL_PRODUCTS = {
  // Topps flagship & derivatives
  "topps-series-1": [[2010, 2026]],
  "topps-series-2": [[2010, 2026]],
  "topps-update": [[2006, 2026]],
  "topps-traded": [[1974, 2005]],
  "topps": [[1951, 2005]],
  "topps-tiffany": [[1984, 1991]],
  "topps-chrome": [[1996, 2026]],
  "topps-chrome-update": [[2008, 2026]],
  "topps-chrome-sapphire": [[2019, 2026]],
  "topps-chrome-black": [[2020, 2024]],
  "topps-chrome-platinum-anniversary": [[2021, 2021]],
  "topps-finest": [[1993, 2026]],
  "topps-heritage": [[2001, 2026]],
  "topps-heritage-high-number": [[2011, 2026]],
  "topps-archives": [[2001, 2026]],
  "topps-allen-ginter": [[2006, 2026]],
  "allen-ginter": [[2006, 2026]],
  "topps-gypsy-queen": [[2011, 2026]],
  "gypsy-queen": [[2011, 2026]],
  "topps-stadium-club": [[1991, 2026]],
  "stadium-club": [[1991, 2026]],
  "topps-big-league": [[2018, 2026]],
  "topps-fire": [[2016, 2026]],
  "topps-gold-label": [[1998, 2026]],
  "topps-museum-collection": [[2012, 2026]],
  "topps-tribute": [[2011, 2026]],
  "topps-triple-threads": [[2007, 2026]],
  "topps-five-star": [[2012, 2026]],
  "topps-definitive": [[2016, 2026]],
  "topps-dynasty": [[2013, 2026]],
  "topps-inception": [[2013, 2026]],
  "topps-tier-one": [[2011, 2026]],
  "topps-sterling": [[2006, 2015]],
  "topps-luminaries": [[2017, 2020]],
  "topps-clearly-authentic": [[2017, 2023]],
  "topps-cosmic-chrome": [[2022, 2026]],
  "topps-gallery": [[1996, 2019]],
  "topps-flagship-update": [[2020, 2026]],
  // Bowman family
  "bowman": [[1989, 2026]],
  "bowman-chrome": [[1997, 2026]],
  "bowman-draft": [[2010, 2026]],
  "bowman-draft-picks-prospects": [[1998, 2009]],
  "bowmans-best": [[1994, 2026]],
  "bowman-platinum": [[2010, 2020]],
  "bowman-sterling": [[2004, 2020]],
  "bowman-inception": [[2013, 2026]],
  "bowman-high-tek": [[2014, 2020]],
  "bowman-chrome-sapphire": [[2019, 2026]],
  "bowman-draft-sapphire": [[2019, 2026]],
  "bowman-chrome-mega-box": [[2018, 2026]],
  "bowman-chrome-mini": [[2013, 2015]],
  "bowman-black": [[2020, 2026]],
  // Panini
  "panini-prizm": [[2012, 2025]],
  "panini-donruss": [[2014, 2025]],
  "donruss-optic": [[2016, 2025]],
  "panini-select": [[2013, 2025]],
  "panini-flawless": [[2016, 2025]],
  "panini-immaculate": [[2015, 2025]],
  "panini-impeccable": [[2018, 2025]],
  "panini-national-treasures": [[2015, 2025]],
  "panini-diamond-kings": [[2015, 2025]],
  "panini-mosaic": [[2020, 2025]],
  "panini-chronicles": [[2018, 2025]],
  "panini-contenders": [[2012, 2020]],
  "panini-prizm-draft-picks": [[2020, 2025]],
  // Historic
  "fleer": [[1981, 2007]],
  "fleer-ultra": [[1991, 2007]],
  "fleer-ex": [[1997, 2003]],
  "score": [[1988, 2005]],
  "upper-deck": [[1989, 2013]],
  "upper-deck-sp": [[1993, 2006]],
  "ud-collectors-choice": [[1994, 1999]],
  "pinnacle": [[1992, 1998]],
  "donruss": [[1981, 2005]],
  "donruss-elite": [[1995, 2005]],
  "elite-extra-edition": [[2008, 2015]],
  "pacific": [[1993, 2004]],
  "sp-authentic": [[1998, 2013]],
  "leaf-metal-draft": [[2013, 2024]],
  "leaf-trinity": [[2015, 2024]],
  "tristar-obak": [[2009, 2012]],
  "tristar-prospects-plus": [[2010, 2020]],
  "onyx": [[2015, 2024]],
  "onyx-vintage": [[2020, 2024]],
  "flair-showcase": [[1996, 2005]],
  "select-certified": [[1995, 2000]],
  "pinnacle-brands": [[1994, 1998]],
  "upper-deck-sp": [[1993, 2006]],
  "upper-deck-portrait": [[1998, 2001]],
  "upper-deck-powerdeck": [[1999, 2000]],
};

// Additional products we're MISSING that should exist:
const MISSING_PRODUCTS_TO_ADD = [
  // Fleer/UD family
  { productKey: "fleer-tradition", years: [1998, 2006], notes: "Fleer flagship retro variant" },
  { productKey: "fleer-focus", years: [2001, 2003], notes: "" },
  { productKey: "fleer-genuine", years: [2001, 2005], notes: "" },
  { productKey: "fleer-showcase", years: [2003, 2005], notes: "" },
  { productKey: "upper-deck-spx", years: [1996, 2006], notes: "SPx premium" },
  { productKey: "upper-deck-ultimate", years: [1999, 2006], notes: "" },
  { productKey: "upper-deck-portrait", years: [1998, 2001], notes: "" },
  // Pacific line
  { productKey: "pacific-crown-royale", years: [1998, 2004], notes: "" },
  { productKey: "pacific-invincible", years: [1997, 2000], notes: "" },
  { productKey: "pacific-omega", years: [1998, 2000], notes: "" },
  { productKey: "pacific-paramount", years: [1998, 2000], notes: "" },
  // Skybox
  { productKey: "skybox-ex", years: [1997, 2001], notes: "" },
  { productKey: "skybox-metal", years: [1996, 2001], notes: "" },
  { productKey: "skybox-premium", years: [1996, 2001], notes: "" },
  { productKey: "skybox-e-x-2001", years: [1997, 2001], notes: "" },
  // Playoff / Leaf
  { productKey: "playoff-absolute", years: [1998, 2005], notes: "" },
  { productKey: "playoff-honors", years: [2001, 2005], notes: "" },
  { productKey: "leaf-signature-series", years: [1996, 2002], notes: "" },
  { productKey: "leaf-rookies-stars", years: [1998, 2004], notes: "" },
  { productKey: "leaf-metal", years: [2020, 2025], notes: "Leaf Metal base (not Draft)" },
  { productKey: "leaf-metal-universe", years: [1995, 2001], notes: "Fleer's metallic pre-Leaf" },
  { productKey: "studio", years: [1991, 2004], notes: "" },
  // Panini modern
  { productKey: "panini-origins", years: [2022, 2025], notes: "" },
  { productKey: "panini-absolute", years: [2020, 2025], notes: "" },
  { productKey: "panini-playbook", years: [2020, 2023], notes: "" },
  { productKey: "panini-three-and-two", years: [2024, 2025], notes: "" },
  { productKey: "panini-prospect-edition", years: [2024, 2025], notes: "" },
  { productKey: "panini-stars-stripes", years: [2020, 2024], notes: "USA Baseball" },
  // Sports Illustrated / other
  { productKey: "sage-hit", years: [2010, 2020], notes: "" },
  { productKey: "sage-autographed", years: [2010, 2020], notes: "" },
  { productKey: "grandstand", years: [2018, 2024], notes: "" },
  { productKey: "just-minors", years: [2005, 2015], notes: "" },
  // Vintage additions
  { productKey: "bowman-1949", years: [1949, 1949], notes: "Already have via vintage" },
  { productKey: "topps-baseball-1961", years: [1961, 1961], notes: "Already have via vintage" },
];

(async () => {
  console.log("[audit] querying Cosmos for coverage matrix...");
  const { resources: allDocs } = await c.items.query({
    query: "SELECT c.productKey, c.year, c.docType FROM c",
  }).fetchAll();

  const coverageByPk = new Map();
  const setDocKeys = new Set();
  for (const d of allDocs) {
    if (d.docType === "set") {
      setDocKeys.add(d.productKey);
      continue;
    }
    const bucket = coverageByPk.get(d.productKey) ?? new Map();
    bucket.set(d.year, (bucket.get(d.year) ?? 0) + 1);
    coverageByPk.set(d.productKey, bucket);
  }

  console.log(`\n[audit] parallel productKeys: ${coverageByPk.size}`);
  console.log(`[audit] set-only productKeys: ${setDocKeys.size}`);
  console.log(`[audit] canonical products: ${Object.keys(CANONICAL_PRODUCTS).length}`);
  console.log(`[audit] flagged missing products: ${MISSING_PRODUCTS_TO_ADD.length}`);

  const missingProductKeys = [];
  const yearGaps = [];
  for (const [pk, ranges] of Object.entries(CANONICAL_PRODUCTS)) {
    if (!coverageByPk.has(pk) && !setDocKeys.has(pk)) {
      missingProductKeys.push(pk);
      continue;
    }
    const bucket = coverageByPk.get(pk) ?? new Map();
    for (const [start, end] of ranges) {
      for (let y = start; y <= end; y++) {
        if (!bucket.has(y)) {
          yearGaps.push({ pk, year: y });
        }
      }
    }
  }

  console.log(`\n=== MISSING productKeys (should exist per canonical map) ===`);
  console.log(missingProductKeys.length === 0 ? "  (none)" : missingProductKeys.map(k => "  " + k).join("\n"));

  console.log(`\n=== YEAR GAPS in existing productKeys ===`);
  const byPk = {};
  for (const g of yearGaps) {
    (byPk[g.pk] = byPk[g.pk] ?? []).push(g.year);
  }
  const sortedGaps = Object.entries(byPk).sort((a, b) => b[1].length - a[1].length);
  for (const [pk, years] of sortedGaps.slice(0, 30)) {
    console.log(`  ${pk.padEnd(30)} missing ${years.length} year(s): ${years.slice(0, 10).join(", ")}${years.length > 10 ? " …" : ""}`);
  }

  console.log(`\n=== FLAGGED MISSING PRODUCTS (not in canonical but likely should exist) ===`);
  for (const p of MISSING_PRODUCTS_TO_ADD.slice(0, 30)) {
    const exists = coverageByPk.has(p.productKey) || setDocKeys.has(p.productKey);
    console.log(`  ${exists ? "✓" : "✗"} ${p.productKey.padEnd(28)} ${p.years[0]}-${p.years[1]}  ${p.notes}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
