#!/usr/bin/env node
// CF-SERIAL-PARSED-AS-CARDNUMBER (Drew, 2026-08-14: "we need to really work on
// the ingestion and matching to catch up and stay ahead").
//
// Reading the raw titles behind blocked sales turned up the same shape over and
// over:
//
//   "2025 Topps Cosmic - Auto Ian Happ CCA-IH Orange Refractor 02/25"
//     -> hiq:baseball:2025:topps:0225:orange-refractor:auto:num-25
//   "Topps 2025 Bowman David Bednar PRV-DBE Auto 018/150"
//     -> hiq:baseball:2025:topps:018150:base:auto:num-150
//
// The serial ("02/25") is being consumed as the CARD NUMBER with the slash
// dropped, while ALSO being read correctly as the print run. One token, used
// twice, and the real card number (CCA-IH, PRV-DBE) is discarded even though it
// is right there in the title.
//
// A slug like that can never match: no checklist contains card #0225. So these
// sales sit in awaiting-catalog forever and look like "we are missing a
// checklist" when the checklist is present and correct.
//
// This measures how big it is, over DISTINCT blocked slugs and the sales they
// carry. The test is deliberately narrow to avoid inflating the number:
//
//   cardNumber is all digits
//   AND the slug carries :num-N
//   AND cardNumber ENDS WITH N
//   AND cardNumber is longer than N        (so "25" + num-25 does not count)
//   AND the leading remainder parses as a number <= N   (a serial's index
//       cannot exceed its print run — this is what separates a real card
//       number that happens to end in the print run from a mangled serial)
//
//   node scripts/measureSerialAsCardNumber.cjs
//   node scripts/measureSerialAsCardNumber.cjs --status clean

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STATUS = val("--status", "awaiting-catalog");
const TOP = Number(val("--top", "20"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const staging = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

/** hiq:{vertical}:{year}:{setKey}:{cardNumber}:{parallel}:{auto}[:num-N] */
function parse(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  const printRun = p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null;
  return { vertical: p[1], year: p[2], setKey: p[3], cardNumber: p[4], printRun };
}

function looksLikeSerial(cardNumber, printRun) {
  if (!printRun) return false;
  if (!/^\d+$/.test(cardNumber)) return false;
  if (!cardNumber.endsWith(printRun)) return false;
  if (cardNumber.length <= printRun.length) return false;
  const head = cardNumber.slice(0, cardNumber.length - printRun.length);
  if (!/^\d+$/.test(head)) return false;
  // A serial's index cannot exceed its print run: 02/25 yes, 99/25 no.
  return Number(head) <= Number(printRun);
}

(async () => {
  console.log(`measuring serial-as-cardNumber among status='${STATUS}'\n`);

  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status = @s
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''
            GROUP BY c.hobbyiqCardId`,
    parameters: [{ name: "@s", value: STATUS }],
  }).fetchAll();

  let slugs = 0, rows = 0, badSlugs = 0, badRows = 0;
  const bySet = new Map();
  const examples = [];
  for (const r of resources) {
    const c = parse(r.slug);
    if (!c) continue;
    slugs++; rows += Number(r.n ?? 0);
    if (looksLikeSerial(c.cardNumber, c.printRun)) {
      badSlugs++; badRows += Number(r.n ?? 0);
      const k = `${c.vertical}:${c.year}:${c.setKey}`;
      bySet.set(k, (bySet.get(k) ?? 0) + Number(r.n ?? 0));
      if (examples.length < 12) examples.push(`${String(r.n).padStart(5)}  ${r.slug}`);
    }
  }

  const pctS = (100 * badSlugs / Math.max(slugs, 1)).toFixed(1);
  const pctR = (100 * badRows / Math.max(rows, 1)).toFixed(1);
  console.log(`distinct slugs            : ${slugs.toLocaleString()}`);
  console.log(`  serial-as-cardNumber    : ${badSlugs.toLocaleString()} (${pctS}%)`);
  console.log(`sales covered             : ${rows.toLocaleString()}`);
  console.log(`  serial-as-cardNumber    : ${badRows.toLocaleString()} (${pctR}%)\n`);

  console.log("examples:");
  for (const e of examples) console.log(`  ${e}`);

  const ranked = [...bySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  console.log(`\ntop ${ranked.length} affected sets:`);
  for (const [k, n] of ranked) console.log(`  ${String(n).padStart(6)}  ${k}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
