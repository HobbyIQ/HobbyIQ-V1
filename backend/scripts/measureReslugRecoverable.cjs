#!/usr/bin/env node
// CF-RESLUG-RECOVERABILITY (Drew, 2026-08-14: "yes do it").
//
// Before re-slugging the parser-artifact rows, establish whether re-slugging
// would actually help. Those two things are NOT the same:
//
//   #1035/#1037 stop the parser producing a WRONG card number ("22/30" -> 2230)
//   they do not necessarily recover the RIGHT one ("OL")
//
// If the fixed parser returns null for these titles, re-slugging converts a
// wrong-cardNumber slug into an EMPTY-cardNumber slug. Both are unmatchable,
// so the whole exercise would move 35,093 rows between two flavours of stuck
// and report a large number while unblocking nothing.
//
// comps_staging partitions on /hobbyiqCardId, so a re-slug is delete+recreate,
// not a patch. That is far too destructive to run on a guess.
//
// This takes real artifact rows, re-parses their titles with the CURRENT
// compiled parser, and reports how many yield a usable card number.
//
//   node scripts/measureReslugRecoverable.cjs --sample 300

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { parseListingIdentity } = require(path.join(__dirname, "..", "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(val("--sample", "300"));
const CONCURRENCY = Number(val("--concurrency", "24"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const staging = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

function parse(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  return { cardNumber: p[4], printRun: p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null };
}
function isArtifact(c) {
  if (!c || !c.printRun || !/^\d+$/.test(c.cardNumber)) return false;
  if (!c.cardNumber.endsWith(c.printRun) || c.cardNumber.length <= c.printRun.length) return false;
  const head = c.cardNumber.slice(0, c.cardNumber.length - c.printRun.length);
  return /^\d+$/.test(head) && Number(head) <= Number(c.printRun);
}
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status='awaiting-catalog' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
  }).fetchAll();

  const flagged = resources.filter((r) => isArtifact(parse(r.slug))).sort((a, b) => b.n - a.n);
  const step = Math.max(1, Math.floor(flagged.length / SAMPLE));
  const picked = flagged.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  console.log(`artifact slugs: ${flagged.length.toLocaleString()}   sampling ${picked.length}\n`);

  const out = { recovered: 0, stillNull: 0, sameBad: 0, noTitle: 0 };
  const good = [], bad = [];
  await mapLimit(picked, CONCURRENCY, async (r) => {
    let title = "";
    try {
      const { resources: rows } = await staging.items.query({
        query: "SELECT TOP 1 c.raw.vendorPayload.title AS t FROM c WHERE c.status='awaiting-catalog'",
      }, { partitionKey: r.slug }).fetchAll();
      title = String(rows[0]?.t ?? "");
    } catch { /* fall through */ }
    if (!title) { out.noTitle++; return; }

    const p = parseListingIdentity(title);
    const cnum = p.cardNumber;
    const old = parse(r.slug).cardNumber;

    if (!cnum) {
      out.stillNull++;
      if (bad.length < 8) bad.push(`old=${old}  ->  null    ${title.slice(0, 76)}`);
    } else if (String(cnum).replace(/\//g, "") === old) {
      out.sameBad++;
    } else {
      out.recovered++;
      if (good.length < 8) good.push(`old=${old}  ->  ${cnum}    ${title.slice(0, 70)}`);
    }
  });

  const decided = out.recovered + out.stillNull + out.sameBad;
  console.log(`RECOVERED a different, usable cardNumber : ${out.recovered}`);
  console.log(`still null (no cardNumber in the title)  : ${out.stillNull}`);
  console.log(`unchanged (still the bad number)         : ${out.sameBad}`);
  console.log(`no title on the row                      : ${out.noTitle}`);
  if (decided) {
    const rate = out.recovered / decided;
    console.log(`\nrecovery rate: ${(100 * rate).toFixed(1)}% of decided`);
    console.log(`=> re-slugging ${flagged.length.toLocaleString()} artifact slugs would make ~${Math.round(flagged.length * rate).toLocaleString()} matchable`);
    console.log(`   the rest would move from a WRONG cardNumber to an EMPTY one — still unmatchable.`);
  }
  console.log("\nrecovered examples:");
  for (const s of good) console.log(`  ${s}`);
  console.log("\nstill-unmatchable examples:");
  for (const s of bad) console.log(`  ${s}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
