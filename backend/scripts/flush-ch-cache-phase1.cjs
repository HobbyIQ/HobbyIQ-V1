// PR #30 / Issue #25 Phase 1 deploy — flush ch:match:* and ch:search:* only.
// ch:comps:* is intentionally preserved (classifier is additive — comp shape
// unchanged — flushing would waste CH API budget).
//
// Reads connection details from REDIS_HOST / REDIS_PORT / REDIS_KEY / REDIS_TLS.

const Redis = require("ioredis");

const host = process.env.REDIS_HOST;
const port = Number(process.env.REDIS_PORT || 6380);
const password = process.env.REDIS_KEY;
const useTls = (process.env.REDIS_TLS ?? "true").toLowerCase() !== "false";

if (!host || !password) {
  console.error("Missing REDIS_HOST / REDIS_KEY env vars");
  process.exit(1);
}

const client = new Redis({
  host,
  port,
  password,
  tls: useTls ? { servername: host } : undefined,
  maxRetriesPerRequest: 3,
});

async function scanAll(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (batch.length) keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function delInBatches(keys, batchSize = 200) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += batchSize) {
    const chunk = keys.slice(i, i + batchSize);
    deleted += await client.del(...chunk);
  }
  return deleted;
}

(async () => {
  try {
    const matchKeys = await scanAll("ch:match:*");
    const searchKeys = await scanAll("ch:search:*");

    console.log(`ch:match:*  count=${matchKeys.length}  sample=${matchKeys.slice(0, 5).join(", ")}`);
    console.log(`ch:search:* count=${searchKeys.length} sample=${searchKeys.slice(0, 5).join(", ")}`);

    const total = matchKeys.length + searchKeys.length;
    console.log(
      `About to delete ${total} total keys (${matchKeys.length} match + ${searchKeys.length} search) — ch:comps:* preserved per PR #30 scope`,
    );

    const matchDel = await delInBatches(matchKeys);
    const searchDel = await delInBatches(searchKeys);

    console.log(`DELETED ch:match:*  ${matchDel}`);
    console.log(`DELETED ch:search:* ${searchDel}`);
    console.log(`DELETED total       ${matchDel + searchDel}`);
    console.log("ch:comps:* preserved (not scanned, not deleted).");
  } catch (err) {
    console.error("FLUSH FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    await client.quit();
  }
})();
