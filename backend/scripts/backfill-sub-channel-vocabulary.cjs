#!/usr/bin/env node
// CF-BACKFILL-SUB-CHANNEL-VOCAB (Drew, 2026-08-01).
//
// Populates __subChannel on historical sold_comps rows by detecting
// retail-channel vocabulary (Mega Box, Blaster, HTA, etc.) in the
// setName + title. Pools stay collapsed at slug level; this only
// adds the LANGUAGE tag so downstream views can surface + filter by
// channel.
//
// SAFE: only writes __subChannel + __subChannelBackfilledAt.

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

const SUB_CHANNEL_PATTERNS = [
  [/\bmega\s*box\b/i,  "mega-box"],
  [/\bblaster\b/i,     "blaster"],
  [/\bhta\s+choice\b/i, "hta-choice"],
  [/\bhta\b/i,         "hta"],
  [/\bhanger\b/i,      "hanger"],
  [/\bfat\s*pack\b/i,  "fat-pack"],
  [/\bcello\b/i,       "cello"],
  [/\bjumbo\b/i,       "jumbo"],
  [/\bhobby\b/i,       "hobby"],
  [/\bretail\b/i,      "retail"],
];

function extractSubChannel(setName, title) {
  const combined = `${setName ?? ""} ${title ?? ""}`;
  for (const [re, tag] of SUB_CHANNEL_PATTERNS) {
    if (re.test(combined)) return tag;
  }
  return null;
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[backfill-sub-channel-vocab]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE (NOT IS_DEFINED(c.__subChannel)) AND (IS_DEFINED(c.setName) OR IS_DEFINED(c.title))`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  const byChannel = {};
  const inFlight = [];
  const at = new Date().toISOString();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const channel = extractSubChannel(row.setName, row.title);
      if (!channel) continue;
      wouldChange++;
      byChannel[channel] = (byChannel[channel] || 0) + 1;
      if (MODE === "apply") {
        row.__subChannel = channel;
        row.__subChannelBackfilledAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
  console.log(`\nBy channel:`);
  Object.entries(byChannel).sort((a,b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
}

main().catch(e => { console.error(e); process.exit(1); });
