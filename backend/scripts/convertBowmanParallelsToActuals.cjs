// CF-CONVERT-BOWMAN-PARALLELS (Drew, 2026-08-11). Take Drew's curated
// bowman-parallels.json (1,849 entries across 15 Bowman-family products,
// 2011-2026) and split it into per-product actuals files matching our
// hand-fetched schema. Feeds explodeCatalogParallels.cjs resolver.

const fs = require("fs");
const path = require("path");

const IN = path.resolve(__dirname, "..", "data", "bowman-parallels.json");
const OUT_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

// Product name → setKey mapping (matches hobbyIqCardId.service.ts canonicals)
const PRODUCT_MAP = {
  "Bowman": "bowman",
  "Bowman Chrome": "bowman-chrome",
  "Bowman Chrome Mega Box": "bowman-mega",
  "Bowman Chrome Sapphire": "bowman-chrome-sapphire",
  "Bowman Chrome Mini": "bowman-chrome-mini",
  "Bowman Draft": "bowman-draft",
  "Bowman Draft Picks & Prospects": "bowman-draft",
  "Bowman Draft Sapphire": "bowman-draft-sapphire",
  "Bowman Sterling": "bowman-sterling",
  "Bowman Platinum": "bowman-platinum",
  "Bowman Inception": "bowman-inception",
  "Bowman's Best": "bowmans-best",
  "Bowman High Tek": "bowman-high-tek",
  "Bowman Black": "bowman-black",
};

function classifyEntry(e) {
  if (e.auto) return "autoParallels";
  const cs = String(e.cardSet || "");
  if (/prospect/i.test(cs)) return "prospectParallels";
  return "baseParallels";
}

function mergeUnique(list, entry) {
  const existing = list.find(x => x.name === entry.name);
  if (!existing) { list.push(entry); return; }
  // Prefer entry with non-null printRun
  if (existing.printRun == null && entry.printRun != null) existing.printRun = entry.printRun;
}

function main() {
  const doc = JSON.parse(fs.readFileSync(IN, "utf8"));
  console.log(`▸ loading ${doc.entryCount} entries from ${IN}`);

  const buckets = new Map(); // key: `${year}-${setKey}` → { baseParallels, prospectParallels, autoParallels }
  let mapped = 0, unmapped = 0;

  for (const e of doc.entries) {
    const setKey = PRODUCT_MAP[e.product];
    if (!setKey) { unmapped++; continue; }
    mapped++;
    const key = `${e.year}-${setKey}`;
    if (!buckets.has(key)) buckets.set(key, {
      baseParallels: [], prospectParallels: [], autoParallels: [],
      sourceProducts: new Set(),
    });
    const b = buckets.get(key);
    b.sourceProducts.add(e.product);
    const cls = classifyEntry(e);
    mergeUnique(b[cls], { name: e.parallel, printRun: e.printRun });
  }

  console.log(`  entries mapped: ${mapped}  unmapped: ${unmapped}  distinct (year,setKey): ${buckets.size}`);

  // Emit one file per bucket
  let written = 0, skipped = 0;
  for (const [key, b] of buckets) {
    const [year, ...setKeyParts] = key.split("-");
    const setKey = setKeyParts.join("-");
    const filename = `parallels-${key}-baseball.json`;
    const outPath = path.join(OUT_DIR, filename);

    // Ensure Base is in baseParallels/prospectParallels
    if (b.baseParallels.length > 0 && !b.baseParallels.find(p => /^base$/i.test(p.name))) {
      b.baseParallels.unshift({ name: "Base", printRun: null });
    }
    if (b.prospectParallels.length > 0 && !b.prospectParallels.find(p => /^base$/i.test(p.name))) {
      b.prospectParallels.unshift({ name: "Base", printRun: null });
    }

    // Skip if empty (nothing to emit)
    if (b.baseParallels.length === 0 && b.prospectParallels.length === 0 && b.autoParallels.length === 0) {
      skipped++; continue;
    }

    const outDoc = {
      source: "drew-bowman-parallels-xlsx",
      sourceUrl: "internal: bowman parallels 2011 2026.xlsx",
      fetchedAt: doc.generatedAt,
      appliesTo: [`${year}-${setKey}-baseball`, `${year}-${setKey}`],
      note: `Auto-generated from bowman-parallels.json (${[...b.sourceProducts].join(", ")}). Do not edit by hand — re-run convertBowmanParallelsToActuals.cjs.`,
      baseParallels: b.baseParallels.length > 0 ? b.baseParallels : null,
      prospectParallels: b.prospectParallels.length > 0 ? b.prospectParallels : null,
      autoParallels: b.autoParallels.length > 0 ? b.autoParallels : null,
    };

    // Don't clobber hand-authored files (2025 bowman chrome was hand-fetched earlier this session)
    if (fs.existsSync(outPath)) {
      const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
      if (existing.source && existing.source !== "drew-bowman-parallels-xlsx") {
        console.log(`   preserve: ${filename} (hand-authored, source=${existing.source})`);
        skipped++; continue;
      }
    }

    fs.writeFileSync(outPath, JSON.stringify(outDoc, null, 2));
    written++;
  }

  console.log(`\n[done] wrote=${written} preserved-hand-authored=${skipped}`);
  console.log(`  files in ${OUT_DIR}`);
}
main();
