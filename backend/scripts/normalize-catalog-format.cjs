// FIELD NORMALISER — one worker over a year slice. Report-only unless APPLY=true.
//
// Drew: "without uniform consistency, searches and matches won't be clean" and
// "we need 16 workers".
//
// He is right, and it is a different point from the one I was arguing. A
// DISPLAY name can be computed per request and never drifts. But the MATCHER
// reads stored fields — setName, parallel, parallelSlug, searchTokens — and if
// those disagree across rows then search and matching are inconsistent no
// matter what the UI renders. Those have to be uniform at rest.
//
// So this normalises the inputs and stores displayName alongside them, using
// the same canonicalCardName the read path uses, so the two can never disagree.
//
// Partitioned by YEAR so N workers never touch the same document, which means
// no coordination and no lost updates.
const { CosmosClient } = require("@azure/cosmos");
const { canonicalCardName, canonicalSetName, titleCaseWords } = require(require("node:path").resolve(__dirname, "..", "dist/services/catalog/canonicalCardName.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// Work units come from partitions.json: {y, lo, hi} where lo/hi optionally
// bound setKey so a mega-year (2025 alone is 7.1M rows) can be split across
// workers. Balanced to 1.01x spread.
const SLOT = Number(process.env.SLOT ?? 0);
const SLOTS = Number(process.env.SLOTS ?? 16);
const MEGA_CUT = 1500000;
const RANGES = [["", "g"], ["g", "n"], ["n", "t"], ["t", "~"]];

// Partitions are computed from LIVE row counts at startup, not read from a
// file, so a slot cannot drift out of step with the data. Balanced by ROW
// COUNT: 2025 alone is 7.1M rows, roughly 400x a vintage year, so one-year-
// per-worker is hopeless. Years over the cut are split further by setKey
// letter range. Slots never overlap, so workers need no coordination.
async function buildUnits(cat) {
  const rows = (await cat.items.query({
    query: `SELECT c.year AS y, COUNT(1) AS n FROM c
            WHERE IS_NUMBER(c.year) AND STARTSWITH(c.id,'hiq:')
              AND (NOT IS_DEFINED(c.verificationStatus) OR c.verificationStatus != 'rejected')
            GROUP BY c.year`,
  }).fetchAll()).resources.filter((x) => x.y >= 1900 && x.y <= 2030).sort((a, b) => b.n - a.n);
  const units = [];
  for (const r of rows) {
    if (r.n > MEGA_CUT) for (const [lo, hi] of RANGES) units.push({ y: r.y, lo, hi, n: Math.round(r.n / RANGES.length) });
    else units.push({ y: r.y, lo: null, hi: null, n: r.n });
  }
  units.sort((a, b) => b.n - a.n);
  const bins = Array.from({ length: SLOTS }, () => ({ u: [], n: 0 }));
  for (const u of units) { bins.sort((a, b) => a.n - b.n); bins[0].u.push(u); bins[0].n += u.n; }
  return bins;
}
const CONC = Number(process.env.CONC || 48);
const BULK_CONC = Number(process.env.BACKFILL_CONCURRENCY || process.env.BULK_CONC || 6);
const TAG = process.env.TAG || `slot${process.env.SLOT ?? 0}`;
const STOP = new Set(["the","a","of","and","psa","bgs","sgc","cgc","raw","rc","hof","set","break","lot","card","cards","vintage","graded"]);

(async () => {
  const db = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const bins = await buildUnits(cat);
  const mine = bins[SLOT];
  if (!mine) { console.error(`FATAL: SLOT ${SLOT} out of range for SLOTS ${SLOTS}`); process.exit(1); }
  const UNITS = mine.u;
  console.log(`[${TAG}] slot ${SLOT}/${SLOTS}  APPLY=${APPLY}  units=${UNITS.length}  ~rows=${mine.n}`);

  let seen = 0, changed = 0, wrote = 0, failed = 0;

  for (const unit of UNITS) {
    const y = unit.y;
    const bounded = unit.lo !== null && unit.lo !== undefined;
    let token;
    do {
      const it = cat.items.query(
        { query: `SELECT * FROM c WHERE c.year=@y AND STARTSWITH(c.id,'hiq:')
                  AND (NOT IS_DEFINED(c.verificationStatus) OR c.verificationStatus != 'rejected')
                  ${bounded ? "AND c.setKey >= @lo AND c.setKey < @hi" : ""}`,
          parameters: bounded
            ? [{ name: "@y", value: y }, { name: "@lo", value: unit.lo }, { name: "@hi", value: unit.hi }]
            : [{ name: "@y", value: y }] },
        { maxItemCount: 1000, continuationToken: token },
      );
      const page = await it.fetchNext();
      token = page.continuationToken;
      const batch = [];
      for (const r of page.resources) {
        seen++;
        const setName = canonicalSetName(r);
        const parallel = titleCaseWords(r.parallel) || r.parallel || null;
        const dn = canonicalCardName({ ...r, setName, parallel });
        const toks = new Set();
        for (const src of [setName, r.setKey, parallel, r.parallelSlug, r.subsetName, r.playerName, String(r.cardNumber ?? ""), String(r.year ?? ""), r.sport]) {
          for (const w of String(src ?? "").toLowerCase().replace(/[^a-z0-9\- ]/g, " ").split(/[\s-]+/)) {
            if (w && w.length > 1 && !STOP.has(w)) toks.add(w);
          }
        }
        const cn = String(r.cardNumber ?? "").toLowerCase();
        if (cn) toks.add(cn);
        const tokens = [...toks];
        const same = r.setName === setName && r.parallel === parallel && r.displayName === dn
          && Array.isArray(r.searchTokens) && r.searchTokens.length === tokens.length
          && r.searchTokens.every((t, i) => t === tokens[i]);
        if (same) continue;
        changed++;
        if (!APPLY) continue;
        r.setName = setName;
        if (parallel) r.parallel = parallel;
        r.displayName = dn;
        r.searchTokens = tokens;
        r.searchText = tokens.join(" ");
        batch.push(r);
      }
      // BULK, not one round trip per row. Individual upserts ran at ~27k
      // rows/min across 16 workers with almost no throttling (33 errors), which
      // means the ceiling was client latency, not RU — every write was paying a
      // full round trip. items.bulk batches up to 100 operations per request.
      // Bulk calls were still issued one after another, so a worker sat idle
      // for a full round trip between batches. Fire BULK_CONC of them at once.
      const chunks = [];
      for (let i = 0; i < batch.length; i += 100) chunks.push(batch.slice(i, i + 100));
      for (let c = 0; c < chunks.length; c += BULK_CONC) {
        await Promise.all(chunks.slice(c, c + BULK_CONC).map(async (chunk) => {
        try {
          const res = await cat.items.bulk(chunk.map((d) => ({ operationType: "Upsert", resourceBody: d })));
          for (const r of res) {
            if (r.statusCode >= 200 && r.statusCode < 300) wrote++;
            else { failed++; if (failed <= 3) console.error(`[${TAG}] status ${r.statusCode}`); }
          }
        } catch (e) {
          failed += chunk.length;
          if (failed <= 300) console.error(`[${TAG}] BULK ERR ${String(e.message).slice(0, 70)}`);
        }
        }));
      }
      process.stderr.write(`\r[${TAG}] ${y}  seen ${seen}  changed ${changed}  wrote ${wrote}   `);
    } while (token);
  }
  process.stderr.write("\n");
  console.log(`[${TAG}] DONE units=${UNITS.length} seen=${seen} changed=${changed} wrote=${wrote} failed=${failed}`);
})().catch((e) => { console.error(`[${TAG}] FATAL:`, e?.message || String(e)); process.exit(3); });
