// CF-EBAY-TITLE-VS-SET-ASPECT sweep (2026-08-22).
//
// Two mispriced holdings traced to the same root cause: eBay's structured
// `Set` item-aspect contradicted the listing TITLE, and identity resolution
// believed the aspect. Sellers pick the Set dropdown by hand and get it wrong;
// the title is what they actually typed about the card in front of them.
//
//   Jac Caglianone   title "2026 Topps Chrome ... Auto Refractor /499 #RA-JC"
//                    aspect Set "2024 Bowman Draft"  -> priced $9.66 vs $205.48 paid
//   Barry Bonds      title "1996 Fleer Heavy Metal #2"   (an INSERT)
//                    aspect Set "1996 Fleer Metal Universe" -> slugged base
//
// This measures how many eBay-imported holdings would change identity if the
// title won, BEFORE any precedence rule changes. Re-identifying a holding
// changes its slug, its comp pool and its displayed value, so the count is the
// thing that decides whether flipping precedence is safe this close to launch.
//
// Read-only. Reports, changes nothing.
const { CosmosClient } = require("@azure/cosmos");

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
  process.exit(1);
}
const c = new CosmosClient(cs).database("hobbyiq").container("portfolio");

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (s) => {
  const m = String(s ?? "").match(/\b(19[4-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : null;
};
// Brand tokens that identify a product line. Deliberately coarse: we are
// counting DISAGREEMENTS to size a risk, not resolving identity here.
const BRANDS = [
  "topps chrome", "topps finest", "topps heritage", "topps pristine", "topps update",
  "bowman chrome", "bowman draft", "bowman sterling", "bowman platinum", "bowman",
  "panini prizm", "panini select", "panini mosaic", "panini donruss", "panini immaculate",
  "panini obsidian", "panini phoenix", "fleer metal universe", "fleer ultra", "fleer",
  "upper deck", "donruss", "topps",
];
const brandOf = (s) => {
  const n = norm(s);
  for (const b of BRANDS) if (n.includes(b)) return b;
  return null;
};

(async () => {
  const { resources } = await c.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();
  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  let total = 0, fromEbay = 0, titled = 0, noTitle = 0;
  const yearMismatch = [], brandMismatch = [];

  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (!h) continue;
      total++;
      const isEbay = h.enrichedFromEbay === true || String(h.source ?? "").startsWith("ebay");
      if (!isEbay) continue;
      fromEbay++;

      // Prefer the seller's own words: short description, then card title.
      const titleText = h.ebayShortDescription || h.cardTitle || "";
      if (!titleText) { noTitle++; continue; }
      titled++;

      const storedSet = h.product || h.setName || "";
      const tYear = yearOf(titleText);
      const sYear = typeof h.cardYear === "number" ? h.cardYear : yearOf(storedSet);
      const tBrand = brandOf(titleText);
      const sBrand = brandOf(storedSet);

      const row = {
        userId: doc.userId, hid,
        player: h.playerName ?? "?",
        title: titleText,
        storedSet, storedYear: sYear,
        titleYear: tYear, titleBrand: tBrand, storedBrand: sBrand,
        fmv: h.fairMarketValue ?? null, cost: h.purchasePrice ?? null,
        slug: h.hobbyiqCardId ?? h.cardId ?? null,
        matchedBy: h.catalogMatchedBy ?? null,
        conf: h.catalogMatchConfidence ?? h.suggestionConfidence ?? null,
      };

      if (tYear !== null && sYear !== null && tYear !== sYear) yearMismatch.push(row);
      else if (tBrand && sBrand && tBrand !== sBrand) brandMismatch.push(row);
    }
  }

  if (!total) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  const show = (label, rows) => {
    console.log(`\n=== ${label}: ${rows.length} ===`);
    for (const r of rows.slice(0, 40)) {
      console.log(`  ${r.player}`);
      console.log(`      title  "${String(r.title).slice(0, 96)}"`);
      console.log(`      stored  ${r.storedYear} ${r.storedSet}   (matchedBy=${r.matchedBy} conf=${r.conf})`);
      console.log(`      title says year=${r.titleYear} brand=${r.titleBrand ?? "?"} | stored brand=${r.storedBrand ?? "?"}`);
      console.log(`      fmv=${r.fmv} cost=${r.cost}  slug=${r.slug}`);
      console.log(`      ${r.userId} / ${r.hid}`);
    }
    if (rows.length > 40) console.log(`  ... and ${rows.length - 40} more NOT shown`);
  };

  console.log(`holdings: ${total}   eBay-imported: ${fromEbay}   with title text: ${titled}   without: ${noTitle}`);
  show("A. TITLE YEAR disagrees with stored year", yearMismatch);
  show("B. TITLE BRAND disagrees with stored brand (same year)", brandMismatch);

  const affected = yearMismatch.length + brandMismatch.length;
  console.log(`\nSUMMARY  ebayImported=${fromEbay}  titled=${titled}  yearMismatch=${yearMismatch.length}  brandMismatch=${brandMismatch.length}  wouldReidentify=${affected}`);
  console.log(`\nBLAST RADIUS: flipping precedence to title-wins would re-identify ${affected} of ${titled} titled eBay holdings (${titled ? ((affected / titled) * 100).toFixed(1) : "0"}%).`);
  console.log("Each re-identification changes slug -> comp pool -> displayed value. Read the rows above before flipping anything.");
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
