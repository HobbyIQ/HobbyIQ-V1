// Debug: dump unified's gradeCurve for Ohtani 2018 BC RC to see what
// weightedMedian it computes per grade. Isolates whether the anchor
// collapse is in unified's math or in the overlay after.

const path = require("path");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const distRoot = path.resolve(__dirname, "..", "dist");
  const { computeUnifiedPrice } = require(path.join(distRoot, "services", "compiq", "unifiedPricing.service.js"));

  const CID = "hiq:baseball:2018:bowman-chrome:1:base:no-auto";
  const u = await computeUnifiedPrice(CID, { hobbyiqCardId: CID });
  console.log("=== unified for", CID, "===");
  console.log("totalSampleCount:", u.totalSampleCount);
  console.log("selectedWindow:", u.selectedWindow ?? "(unknown)");
  console.log("marketValue (top-level):", u.marketValue);
  console.log("");
  console.log("  grade         n     wMed     mv       predicted");
  console.log("  ------------  ----  ------   ------   ---------");
  for (const e of (u.gradeCurve || [])) {
    console.log("  "+String(e.grade).padEnd(13)+' '+String(e.sampleCount).padStart(4)+"   \$"+String(Math.round(e.weightedMedian)).padStart(5)+"   \$"+String(Math.round(e.marketValue||0)).padStart(5)+"    \$"+String(Math.round(e.predictedPrice||0)).padStart(5));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
