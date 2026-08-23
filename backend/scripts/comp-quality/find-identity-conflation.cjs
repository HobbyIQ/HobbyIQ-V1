// Find the next Maddux before a user does.
//
// THE SIGNATURE. Every instance of this bug class looks the same in the data:
// a word appears in the SALE TITLES that is absent from the SLUG those sales
// are filed under. The word names a distinct product, and the sales carrying it
// are worth materially more (or less) than the ones that don't — so the card's
// price is a blend of two different cards.
//
//   Tiffany       8,023 sales titled Tiffany on non-Tiffany slugs
//                 1987 #70T PSA 10: 28 Tiffany at $999.95 vs 320 base at $122.50
//   Topps Traded 20,678 sales numbered <n>T filed under the base set
//   Bowman Draft  7,255 sales on bowman-chrome slugs that were draft cards
//
// All three surfaced the same way — a user opened a card and the comps were
// wrong or missing. This looks for the shape directly.
//
// TWO NUMBERS, AND THE SECOND IS THE ONE THAT MATTERS.
//   REACH  how many sales carry the word but not the slug. Big reach with no
//          price gap is harmless: the word is decorative, not a product.
//   GAP    the price ratio between sales that carry the word and sales on the
//          same card that do not. A gap is what makes a blend wrong.
//
// Sorted by gap x reach, so the top of the list is where users are seeing bad
// prices right now.
//
// FALSE POSITIVES ARE EXPECTED AND ARE THE POINT OF THE REPORT. "tiffany" is
// also a person (Tiffany Stratton, 205 wrestling rows). "chrome", "update" and
// "refractor" appear in titles for reasons that are already correctly encoded.
// This ranks candidates for a human to judge; it never writes.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/find-identity-conflation.cjs
//     MIN_REACH=200    ignore words with fewer misfiled sales (default 200)
//     MIN_PAIRS=4      sales needed on BOTH sides of a card before it counts
//     TOP=14           how many words to price-check in depth
const { CosmosClient } = require("@azure/cosmos");

const MIN_REACH = Number(process.env.MIN_REACH || 200);
const MIN_PAIRS = Number(process.env.MIN_PAIRS || 4);
const TOP = Number(process.env.TOP || 14);

// Words that name a DISTINCT PRODUCT — a different card, not a description of
// the same one. Deliberately not every parallel colour: a colour usually IS in
// the slug already, and the interesting failures are whole product lines that
// the ingest collapsed into their parent.
const PRODUCT_WORDS = [
  "tiffany", "sapphire", "traded", "update", "glossy", "o-pee-chee", "opc",
  "chrome", "draft", "prospects", "mega box", "hta", "retail", "hobby",
  "superfractor", "refractor", "mini", "black label", "gold label",
  "first edition", "1st edition", "holiday", "heritage", "allen ginter",
  "gypsy queen", "stadium club", "finest", "bowman's best", "bowmans best",
];

const median = (a) => {
  const s = a.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const slugKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const sold = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq").container("sold_comps");

  console.log("STEP 1 — reach: sales whose title carries a product word their slug does not\n");
  const reach = [];
  for (const w of PRODUCT_WORDS) {
    const token = slugKey(w);
    const { resources } = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c
              WHERE CONTAINS(LOWER(c.title), @w)
                AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
                AND NOT CONTAINS(c.hobbyiqCardId, @t)`,
      parameters: [{ name: "@w", value: w }, { name: "@t", value: token }],
    }).fetchAll();
    const n = resources[0] || 0;
    if (n >= MIN_REACH) reach.push({ word: w, token, n });
    process.stdout.write(`   ${String(n).padStart(7)}  ${w}\n`);
  }
  reach.sort((a, b) => b.n - a.n);

  console.log(`\nSTEP 2 — gap: for the top ${TOP}, is the word worth money?\n`);
  console.log("   word              reach   cards   WITH word    WITHOUT     gap   impact");
  const findings = [];
  for (const r of reach.slice(0, TOP)) {
    // Pull the affected sales plus their card-mates, and compare within a card.
    const { resources: rows } = await sold.items.query({
      query: `SELECT c.hobbyiqCardId, c.price, c.title, c.gradeCompany, c.gradeValue FROM c
              WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
                AND NOT CONTAINS(c.hobbyiqCardId, @t)
                AND c.hobbyiqCardId IN (
                  SELECT VALUE x.hobbyiqCardId FROM x
                  WHERE CONTAINS(LOWER(x.title), @w) AND NOT CONTAINS(x.hobbyiqCardId, @t)
                )`,
      parameters: [{ name: "@w", value: r.word }, { name: "@t", value: r.token }],
    }).fetchAll().catch(() => ({ resources: [] }));

    // Compare like with like: same card AND same grade, else the gap is just
    // PSA 10s against raws.
    const buckets = new Map();
    for (const x of rows) {
      const g = `${x.gradeCompany || "raw"}${x.gradeValue ?? ""}`;
      const k = `${x.hobbyiqCardId}|${g}`;
      if (!buckets.has(k)) buckets.set(k, { with: [], without: [] });
      const hit = new RegExp(r.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(String(x.title || ""));
      buckets.get(k)[hit ? "with" : "without"].push(Number(x.price));
    }
    const ratios = [];
    let cards = 0, withAll = [], withoutAll = [];
    for (const [, v] of buckets) {
      if (v.with.length < MIN_PAIRS || v.without.length < MIN_PAIRS) continue;
      const a = median(v.with), b = median(v.without);
      if (!a || !b) continue;
      cards++;
      ratios.push(a / b);
      withAll.push(a);
      withoutAll.push(b);
    }
    if (!cards) { console.log(`   ${r.word.padEnd(16)} ${String(r.n).padStart(6)}   (no card has ${MIN_PAIRS}+ sales both ways)`); continue; }
    const gap = median(ratios);
    const mw = median(withAll), mo = median(withoutAll);
    const impact = Math.round(Math.abs(Math.log(gap)) * r.n);
    findings.push({ ...r, cards, gap, mw, mo, impact });
    console.log(
      `   ${r.word.padEnd(16)} ${String(r.n).padStart(6)}  ${String(cards).padStart(6)}   ${("$" + Math.round(mw)).padStart(9)}  ${("$" + Math.round(mo)).padStart(9)}  ${(gap.toFixed(2) + "x").padStart(7)}  ${String(impact).padStart(6)}`,
    );
  }

  console.log("\nRANKED BY IMPACT — where users are seeing wrong prices right now:\n");
  for (const f of findings.sort((a, b) => b.impact - a.impact)) {
    const dir = f.gap >= 1 ? "worth MORE" : "worth LESS";
    console.log(`   ${f.word}: ${f.n} sales misfiled across ${f.cards} cards, ${dir} at ${f.gap.toFixed(2)}x ($${Math.round(f.mw)} vs $${Math.round(f.mo)})`);
  }
  console.log("\nRead-only. Nothing was written. Each line is a candidate for a human");
  console.log("to judge — 'tiffany' is also a person, and some of these words are");
  console.log("already correctly encoded elsewhere in the slug.");
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
