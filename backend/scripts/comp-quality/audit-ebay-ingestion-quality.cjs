// What did eBay ingestion actually produce? Shows the failure as a PATTERN
// rather than one card at a time.
//
// WHY THIS EXISTS. A single screenshot — "2025 Bowman Draft Gold Max Williams
// #CPA-MWI, VALUE $13.64, COST $301, -95.5%" — turned out to be the visible
// corner of a much larger problem. Sweeping every eBay-sourced holding on
// 2026-08-22 found 18 sports holdings with NO identity at all, carrying
// $2,117.19 of cost basis (23% of the portfolio), each still rendering a
// confident price borrowed from a fallback pool.
//
// The inputs explained it. Parallels arrived raw and unmatched-able:
//
//   "ChromeProspectAutographsBlueRefractor"   "ChromeProspectAutographRefractor"
//   "Chrome Prospects Mojo Black Refractor"   "[Base]"   "NONE"   "Logofractor"
//   "Gold Prizm Missing Serial Number"
//
// because holdingFieldNormalizer was applied to the eBay *aspect* only and
// never to the title-parsed parallel (fixed in #1179). One of those strings had
// already been baked into a slug:
//   hiq:baseball:2025:draft:cpa-dc:chromeprospectautographgoldrefractor:auto
//
// WHAT TO WATCH FOR when reading the output: a TITLE that disagrees with the
// stored set is NOT automatically a bug. Measured on the same day, flipping
// precedence to "title wins" would have re-identified 10 of 59 titled holdings
// (16.9%) while only 2 were genuine errors — the rest were the documented
// product-family ladder ("2026 Bowman Chrome" stored as "2026 Bowman", slug
// already correct). Section A (title YEAR disagrees) was the signal worth
// acting on at 2 of 59. Section B (brand specificity) mostly was not.
//
// Read-only. Reports, changes nothing.
const { CosmosClient } = require("@azure/cosmos");

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
  process.exit(1);
}
const c = new CosmosClient(cs).database("hobbyiq").container("portfolio");

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toFixed(2));
const PARALLEL_WORDS = [
  "gold", "orange", "red", "purple", "blue", "green", "black", "aqua", "yellow", "pink",
  "sapphire", "atomic", "superfractor", "shimmer", "mojo", "prizm", "x-fractor", "xfractor",
];

(async () => {
  const { resources } = await c.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();
  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  const rows = [];
  let totalHoldings = 0;
  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (!h) continue;
      totalHoldings++;
      const isEbay = h.enrichedFromEbay === true || String(h.source ?? "").startsWith("ebay");
      if (!isEbay) continue;
      const cost = Number(h.totalCostBasis ?? h.purchasePrice ?? 0) || 0;
      const fmv = Number.isFinite(Number(h.fairMarketValue)) ? Number(h.fairMarketValue) : null;
      rows.push({
        userId: doc.userId, hid,
        player: h.playerName ?? "?",
        title: h.ebayShortDescription || h.cardTitle || "",
        number: h.cardNumber ?? null,
        parallel: h.parallel ?? null,
        isAuto: h.isAuto === true,
        slug: h.hobbyiqCardId ?? h.cardId ?? null,
        matchedBy: h.catalogMatchedBy ?? null,
        conf: h.catalogMatchConfidence ?? h.suggestionConfidence ?? null,
        needsReview: h.needsReview === true,
        pokemon: JSON.stringify(h).toLowerCase().includes("pokemon"),
        fmv, cost,
      });
    }
  }

  if (!totalHoldings) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  // A raw parallel is one the normalizer would never have emitted: no spaces
  // across several concatenated words, bracket noise, or a literal "NONE".
  const looksRaw = (p) => {
    if (p == null) return false;
    const s = String(p).trim();
    if (s === "") return false;
    if (/^\[.*\]$/.test(s)) return true;
    if (/^none$/i.test(s)) return true;
    if (/^[A-Za-z]{18,}$/.test(s)) return true;                 // ChromeProspectAutographRefractor
    const words = s.split(/\s+/);
    if (words.length >= 4 && words.some((w) => PARALLEL_WORDS.includes(w.toLowerCase()))) return true;
    return false;
  };

  const unslugged = rows.filter((r) => !r.slug && !r.pokemon);
  const rawParallel = rows.filter((r) => looksRaw(r.parallel));
  const pricedNoIdentity = rows.filter((r) => !r.slug && r.fmv !== null && r.fmv > 0);
  const parked = rows.filter((r) => !r.slug && r.pokemon);

  const show = (label, list, note) => {
    console.log(`\n=== ${label}: ${list.length} ===`);
    if (note) console.log(`    ${note}`);
    for (const r of list.slice(0, 25)) {
      console.log(`  ${r.player}  ${money(r.fmv)} vs ${money(r.cost)}`);
      console.log(`      title "${String(r.title).slice(0, 88)}"`);
      console.log(`      #${r.number}  parallel=${JSON.stringify(r.parallel)}  needsReview=${r.needsReview}`);
      console.log(`      slug ${r.slug}  (matchedBy=${r.matchedBy} conf=${r.conf})`);
      console.log(`      ${r.userId} / ${r.hid}`);
    }
    if (list.length > 25) console.log(`  ... and ${list.length - 25} more NOT shown`);
  };

  console.log(`holdings=${totalHoldings}  ebay-sourced=${rows.length}  parked-vertical unslugged=${parked.length}`);
  show("A. no identity at all (sports)", unslugged);
  show("B. parallel string the normalizer would never emit", rawParallel,
    "#1179 stops new ones being written; these are pre-existing rows needing repair.");
  show("C. PRICED despite having no identity", pricedNoIdentity,
    "Should be empty since #1179. Anything here is a value the user sees with nothing behind it.");

  const stranded = unslugged.reduce((s, r) => s + r.cost, 0);
  console.log(`\nSUMMARY  ebay=${rows.length}  unslugged=${unslugged.length}  rawParallel=${rawParallel.length}  pricedNoIdentity=${pricedNoIdentity.length}`);
  console.log(`cost basis on holdings with no identity: $${stranded.toFixed(2)}`);
  const flagged = rows.filter((r) => r.needsReview).length;
  console.log(`needsReview set on ${flagged} of ${rows.length} eBay holdings`);
  if (pricedNoIdentity.length > 0) {
    console.log(`\n*** ${pricedNoIdentity.length} holdings are showing a price with no identity behind it.`);
    console.log(`    That regressed — CF-NO-IDENTITY-NO-PRICE (#1179) exists to make this zero. ***`);
    process.exit(6);
  }
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
