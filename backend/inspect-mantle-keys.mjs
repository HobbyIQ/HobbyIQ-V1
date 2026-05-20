// inspect-mantle-keys.mjs — read-only SCAN for cached Mantle/1956 Topps keys.
import Redis from "ioredis";

const r = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6380),
  password: process.env.REDIS_KEY,
  tls: process.env.REDIS_TLS !== "false" ? {} : undefined,
  maxRetriesPerRequest: 3,
});

async function scanPattern(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (batch && batch.length) keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

const broadPatterns = ["ch:match:*", "ch:search:*", "ch:comps:*", "compiq:search:*", "compiq:price:*", "compiq:search-list:*"];
const needles = ["mantle", "1956", "topps"];

for (const p of broadPatterns) {
  const keys = await scanPattern(p);
  const matching = keys.filter(k => needles.some(n => k.toLowerCase().includes(n)));
  console.log(`${p}: total=${keys.length}  mantle/1956/topps-matching=${matching.length}`);
  if (matching.length) for (const k of matching.slice(0, 20)) console.log(`  ${k}`);
}

await r.quit();
process.exit(0);
