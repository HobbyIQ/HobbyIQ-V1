#!/usr/bin/env node
// CF-SERIAL-VERIFY (Drew, 2026-08-14).
//
// measureSerialAsCardNumber flags slugs from their SHAPE, and its own output
// shows that shape is not proof: "hiq:baseball:1998:fleer:198:...:num-98" is
// equally consistent with a real card #198 carrying a /98 parallel. Counting
// those as bugs would inflate the number.
//
// The title settles it. If the listing text literally contains the serial
// "HEAD/PRINTRUN" — "02/25" for cardNumber 0225 + num-25 — then the card number
// was taken from the serial, because that is where those digits came from.
//
// Three outcomes, kept separate rather than collapsed:
//   CONFIRMED  title contains HEAD/PRINTRUN            -> the bug
//   REFUTED    title contains "#CARDNUMBER"            -> a real card number
//   UNKNOWN    neither pattern present                 -> not counted either way
//
//   node scripts/verifySerialAsCardNumber.cjs --sample 200

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(val("--sample", "200"));
const STATUS = val("--status", "awaiting-catalog");
const CONCURRENCY = Number(val("--concurrency", "24"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const staging = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

function parse(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  const printRun = p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null;
  return { cardNumber: p[4], printRun };
}
function looksLikeSerial(cardNumber, printRun) {
  if (!printRun || !/^\d+$/.test(cardNumber)) return false;
  if (!cardNumber.endsWith(printRun) || cardNumber.length <= printRun.length) return false;
  const head = cardNumber.slice(0, cardNumber.length - printRun.length);
  return /^\d+$/.test(head) && Number(head) <= Number(printRun);
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
            WHERE c.status = @s AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
    parameters: [{ name: "@s", value: STATUS }],
  }).fetchAll();

  const flagged = resources.filter((r) => {
    const c = parse(r.slug); return c && looksLikeSerial(c.cardNumber, c.printRun);
  });
  // Spread the sample across the ranked list instead of taking the head, so it
  // is not dominated by one set.
  flagged.sort((a, b) => b.n - a.n);
  const step = Math.max(1, Math.floor(flagged.length / SAMPLE));
  const picked = flagged.filter((_, i) => i % step === 0).slice(0, SAMPLE);

  console.log(`flagged slugs: ${flagged.length.toLocaleString()}   verifying ${picked.length}\n`);

  const out = { confirmed: 0, refuted: 0, unknown: 0 };
  const shown = { confirmed: [], refuted: [] };
  await mapLimit(picked, CONCURRENCY, async (r) => {
    const c = parse(r.slug);
    const head = c.cardNumber.slice(0, c.cardNumber.length - c.printRun.length);
    let title = "";
    try {
      const { resources: rows } = await staging.items.query({
        query: "SELECT TOP 1 c.raw.vendorPayload.title AS t FROM c WHERE c.status = @s",
        parameters: [{ name: "@s", value: STATUS }],
      }, { partitionKey: r.slug }).fetchAll();
      title = String(rows[0]?.t ?? "");
    } catch { /* leave blank -> unknown */ }
    if (!title) { out.unknown++; return; }

    // "02/25" — also accept the un-padded form "2/25".
    const bare = String(Number(head));
    const serialRe = new RegExp(`(^|[^\\d])(${head}|${bare})\\s*/\\s*${c.printRun}([^\\d]|$)`);
    const cardNumRe = new RegExp(`#\\s*${c.cardNumber}([^\\d]|$)`);

    if (serialRe.test(title)) {
      out.confirmed++;
      if (shown.confirmed.length < 8) shown.confirmed.push(`${c.cardNumber} +num-${c.printRun}  <-  ${title.slice(0, 84)}`);
    } else if (cardNumRe.test(title)) {
      out.refuted++;
      if (shown.refuted.length < 5) shown.refuted.push(`#${c.cardNumber} is real  <-  ${title.slice(0, 84)}`);
    } else out.unknown++;
  });

  const decided = out.confirmed + out.refuted;
  console.log(`CONFIRMED (title shows the serial) : ${out.confirmed}`);
  console.log(`REFUTED   (title shows #cardNumber): ${out.refuted}`);
  console.log(`UNKNOWN   (neither pattern)        : ${out.unknown}`);
  if (decided) {
    const rate = out.confirmed / decided;
    console.log(`\nof DECIDED cases, ${(100 * rate).toFixed(1)}% are the bug`);
    console.log(`=> flagged ${flagged.length.toLocaleString()} slugs x ${(100 * rate).toFixed(1)}% ~= ${Math.round(flagged.length * rate).toLocaleString()} genuinely mis-parsed`);
    console.log(`   (UNKNOWN excluded from the rate, not assumed either way)`);
  }
  console.log("\nconfirmed examples:");
  for (const s of shown.confirmed) console.log(`  ${s}`);
  console.log("\nrefuted examples (real card numbers, correctly NOT counted):");
  for (const s of shown.refuted) console.log(`  ${s}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
