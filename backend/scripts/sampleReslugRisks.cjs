// Verify suspicious rewrite patterns from reslugAllSoldComps dry-run
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");

  // Query 200 more rows and find the concerning shifts
  const q = `SELECT TOP 5000 c.id, c.hobbyiqCardId, c.sport, c.cardYear, c.setKey, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.title
             FROM c WHERE IS_STRING(c.hobbyiqCardId) AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.cardNumber)`;
  const { resources } = await sold.items.query({ query: q }, { maxItemCount: 500 }).fetchAll();

  const buckets = {
    "topps→bowman": [],
    "panini-donruss→donruss-studio": [],
    "topps-chrome→topps-pristine": [],
    "1948-leaf-baseball→leaf": [],
    "topps→topps-update": [],
    "1990-score-baseball→score": [],
  };
  for (const r of resources) {
    const inputSetKey = r.setKey || r.setName;
    if (!inputSetKey) continue;
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport, year: Number(r.cardYear), setKey: inputSetKey,
        cardNumber: String(r.cardNumber), parallel: r.parallel ?? "Base",
        isAuto: Boolean(r.isAuto), printRun: r.printRun ?? null,
      });
    } catch { continue; }
    if (newSlug === r.hobbyiqCardId) continue;
    const fromFam = r.hobbyiqCardId.split(":")[3];
    const toFam = newSlug.split(":")[3];
    const key = `${fromFam}→${toFam}`;
    if (buckets[key] && buckets[key].length < 3) {
      buckets[key].push({ old: r.hobbyiqCardId, new: newSlug, setName: r.setName, setKey: r.setKey, title: r.title, parallel: r.parallel, isAuto: r.isAuto });
    }
  }

  for (const [key, samples] of Object.entries(buckets)) {
    console.log(`\n=== ${key} ===`);
    if (samples.length === 0) { console.log("  (no samples this batch)"); continue; }
    for (const s of samples) {
      console.log(`  OLD: ${s.old}`);
      console.log(`  NEW: ${s.new}`);
      console.log(`  setName="${s.setName}" setKey="${s.setKey}" parallel="${s.parallel}" isAuto=${s.isAuto}`);
      console.log(`  title="${(s.title||"").slice(0,100)}"`);
      console.log("");
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
