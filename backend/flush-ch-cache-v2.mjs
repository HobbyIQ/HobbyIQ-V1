// flush-ch-cache-v2.mjs — flush CH + compiq cache patterns after PR #28 deploy.
// Pulls Redis creds from env: REDIS_HOST, REDIS_PORT, REDIS_KEY, REDIS_TLS.
import Redis from "ioredis";

const host = process.env.REDIS_HOST;
const port = Number(process.env.REDIS_PORT ?? 6380);
const password = process.env.REDIS_KEY;
const tls = process.env.REDIS_TLS !== "false";

if (!host || !password) {
  console.error("REDIS_HOST or REDIS_KEY missing");
  process.exit(1);
}

const r = new Redis({
  host,
  port,
  password,
  tls: tls ? {} : undefined,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
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

async function delInBatches(keys) {
  let n = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    if (chunk.length) {
      await r.del(...chunk);
      n += chunk.length;
    }
  }
  return n;
}

const patterns = ["ch:match:*", "ch:search:*", "ch:comps:*", "compiq:search:*", "compiq:price:*", "compiq:search-list:*"];
const found = {};
let total = 0;

for (const p of patterns) {
  const k = await scanPattern(p);
  found[p] = k;
  total += k.length;
  console.log(`SCAN ${p}: ${k.length} keys${k.length ? `  sample: ${k.slice(0, 5).join(", ")}` : ""}`);
}

console.log(`\nAbout to delete ${total} total keys:`);
for (const p of patterns) console.log(`  ${p}: ${found[p].length}`);

let deleted = 0;
const deletedByPattern = {};
for (const p of patterns) {
  const n = await delInBatches(found[p]);
  deletedByPattern[p] = n;
  deleted += n;
}

console.log(`\nDeleted ${deleted} keys:`);
for (const p of patterns) console.log(`  ${p}: ${deletedByPattern[p]}`);

await r.quit();
process.exit(0);
