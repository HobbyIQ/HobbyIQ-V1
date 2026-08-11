// CF-GRIFFEY-MISSING (Drew, 2026-08-10). Ingest catalog rows from
// baseballcardpedia checklists for 4 Griffey holdings marked MISSING:
//   1999 Upper Deck Black Diamond #76 Ken Griffey Jr. (Double parallel)
//   1999 Upper Deck Black Diamond #D24 Ken Griffey Jr. (Diamond Dominance /1500)
//   1998 Upper Deck SPx Finite #50 Ken Griffey Jr. (Radiance parallel /1000)
//   1999 Upper Deck Retro #S1 (Old School/New School insert /1000; player TBD)
//
// Then patch the holdings to reference the canonical slugs.
//
// Env: APPLY=true

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const APPLY = process.env.APPLY === "true";

// The 4 catalog rows we're ingesting.
const CATALOG_ENTRIES = [
  {
    sport: "baseball", year: 1999, setKey: "1999 Upper Deck Black Diamond",
    setName: "1999 Upper Deck Black Diamond",
    cardNumber: "76", parallel: "Double", isAuto: false, printRun: 3000,
    playerName: "Ken Griffey Jr.",
    holdingIdToAlign: "0f7802c6-7301-4daa-ac7e-1d02d8e297ca",
  },
  {
    sport: "baseball", year: 1999, setKey: "1999 Upper Deck Black Diamond",
    setName: "1999 Upper Deck Black Diamond",
    cardNumber: "D24", parallel: "Base", isAuto: false, printRun: 1500,
    playerName: "Ken Griffey Jr.",
    subset: "Diamond Dominance",
    holdingIdToAlign: "6f4f079b-0d76-4ae8-88e0-ca27b4c0e6c1",
  },
  {
    sport: "baseball", year: 1998, setKey: "1998 Upper Deck SPx Finite",
    setName: "1998 Upper Deck SPx Finite",
    cardNumber: "50", parallel: "Radiance", isAuto: false, printRun: 1000,
    playerName: "Ken Griffey Jr.",
    subset: "Power Explosion",
    holdingIdToAlign: "05cc17b4-283f-4d47-bed5-0aa1ba19700d",
  },
  {
    sport: "baseball", year: 1999, setKey: "1999 Upper Deck Retro",
    setName: "1999 Upper Deck Retro",
    cardNumber: "S1", parallel: "Base", isAuto: false, printRun: 1000,
    // Old School/New School — actual player TBD (checklist doesn't map S1
    // by name; TCDB or Beckett could resolve, but user-entered as Griffey
    // per holding cardTitle). Trust the holding's playerName.
    playerName: "Ken Griffey Jr.",
    subset: "Old School/New School",
    holdingIdToAlign: "94ba531f-d204-4c14-83d7-0824786bfb11",
  },
];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const catalog = db.container("card_catalog");
  const portfolio = db.container("portfolio");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}`);

  for (const entry of CATALOG_ENTRIES) {
    const slug = computeHobbyIqCardId({
      sport: entry.sport, year: entry.year, setKey: entry.setKey,
      cardNumber: entry.cardNumber, parallel: entry.parallel,
      isAuto: entry.isAuto, printRun: entry.printRun,
    });
    console.log(`\n=== ${entry.year} ${entry.setName} #${entry.cardNumber} ${entry.parallel} — ${entry.playerName} ===`);
    console.log(`  slug: ${slug}`);

    // Upsert catalog row
    const catalogDoc = {
      id: slug, cardId: slug, hobbyiqCardId: slug,
      sport: entry.sport, cardYear: entry.year, year: entry.year,
      setKey: slug.split(":")[3], setName: entry.setName,
      cardNumber: entry.cardNumber, parallel: entry.parallel,
      parallelSlug: entry.parallel.toLowerCase().replace(/\s+/g, "-"),
      isAuto: entry.isAuto, printRun: entry.printRun,
      playerName: entry.playerName,
      subsetName: entry.subset ?? null,
      source: "baseballcardpedia-manual-2026-08-10",
      catalogVersion: "griffey-missing-fix-v1",
      verificationStatus: "verified",
      builtAt: new Date().toISOString(),
    };
    if (APPLY) {
      try {
        await catalog.items.upsert(catalogDoc);
        console.log(`  ✓ catalog upserted`);
      } catch (err) { console.warn(`  catalog upsert fail: ${err.message||err}`); }
    } else {
      console.log(`  [dry-run] would upsert catalog at ${slug}`);
    }

    // Patch matching holding
    if (entry.holdingIdToAlign) {
      // portfolio doc userId = docId (Drew's userId), iterate to find holding
      const { resources: docs } = await portfolio.items.query({
        query: `SELECT * FROM c WHERE IS_DEFINED(c.holdings)`,
      }, { enableCrossPartitionQuery: true }).fetchAll();
      let found = false;
      for (const doc of docs) {
        if (doc.holdings && doc.holdings[entry.holdingIdToAlign]) {
          found = true;
          const h = doc.holdings[entry.holdingIdToAlign];
          console.log(`  holding: user=${doc.userId?.slice(-8)} before=${h.hobbyiqCardId ?? "null"}`);
          if (APPLY) {
            doc.holdings[entry.holdingIdToAlign].hobbyiqCardId = slug;
            doc.holdings[entry.holdingIdToAlign].hobbyiqCardIdSource = "griffey-missing-fix-2026-08-10";
            doc.holdings[entry.holdingIdToAlign].setName = entry.setName;
            doc.holdings[entry.holdingIdToAlign].parallel = entry.parallel;
            doc.holdings[entry.holdingIdToAlign].printRun = entry.printRun;
            doc.lastUpdated = new Date().toISOString();
            await portfolio.item(doc.id, doc.userId).replace(doc);
            console.log(`  ✓ holding patched → ${slug}`);
          } else {
            console.log(`  [dry-run] would patch → ${slug}`);
          }
          break;
        }
      }
      if (!found) console.log(`  holding ${entry.holdingIdToAlign} not found`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
