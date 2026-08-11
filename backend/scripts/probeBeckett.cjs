// Probe Beckett direct product URLs + XHR endpoints for a known product
const https = require("https");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
function get(url) {
  return new Promise((res) => {
    const req = https.get(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8" } }, (r) => {
      let d = ""; r.on("data", c => d+=c); r.on("end", () => res({ status: r.statusCode, body: d }));
    });
    req.on("error", () => res({ status: "ERR" }));
    req.setTimeout(15000, () => { req.destroy(); res({ status: "TIMEOUT" }); });
  });
}
(async () => {
  const patterns = [
    // Cardboard Connection (SEO-heavy, has checklists in articles)
    "https://www.cardboardconnection.com/2019-20-panini-select-basketball-cards-checklist",
    "https://www.cardboardconnection.com/2019-20-panini-select-basketball-checklist",
    "https://www.cardboardconnection.com/2019-panini-select-basketball-cards",
    // Buysellcards
    "https://www.buysellcards.com/2019-Panini-Select-Basketball",
    "https://www.buysellcards.com/checklist/2019-panini-select-basketball",
    // Wikipedia
    "https://en.wikipedia.org/wiki/2019_Panini_Select",
    "https://en.wikipedia.org/wiki/2019%E2%80%9320_Panini_Select_Basketball",
    // sportlots.com (has checklist database)
    "https://www.sportlots.com/inv/PickBox.tpl?strYear=2019&strMFG=Panini&strSet=Select&strSport=BB",
    "https://www.sportlots.com/cust/checklist?year=2019&mfg=Panini&set=Select&sport=BB",
    // basketballcards.com
    "https://www.basketballcards.com/basketball-cards/2019-panini-select",
    // hobbydb.com — new cardhub
    "https://www.hobbydb.com/marketplaces/hobbydb/subjects?category=cards&subcategory=basketball&year=2019&brand=Panini%20Select",
    // Search google.com for "2019 Panini Select basketball checklist"
    "https://www.google.com/search?q=%222019+Panini+Select+basketball%22+checklist+card+list+site%3Abaseballcardpedia.com+OR+site%3Awikipedia.org",
  ];
  for (const url of patterns) {
    const r = await get(url);
    console.log(`  ${r.status}\t${r.body?.length ?? "-"}\t${url}`);
  }
  // Also try sitemap
  console.log(`\nsitemap probes:`);
  for (const s of ["https://www.beckett.com/sitemap.xml", "https://www.beckett.com/robots.txt", "https://www.beckett.com/api/checklists"]) {
    const r = await get(s);
    console.log(`  ${r.status}\t${r.body?.length ?? "-"}\t${s}`);
    if (r.body && r.body.length < 5000) console.log(`    "${r.body.slice(0, 500).replace(/\s+/g, " ")}"`);
  }
})();
