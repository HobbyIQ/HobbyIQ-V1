// Redis SCAN+DEL of cs:pricing:* (or any cs:*) keys. Reads
// REDIS_HOST/REDIS_PORT/REDIS_KEY/REDIS_TLS from env (pull from
// Azure App Settings via az CLI before invoking).
//
// Usage:
//   node backend/scripts/flush-cs-pricing.cjs [pattern]
//
// pattern defaults to "cs:pricing:*". Other useful patterns:
//   "cs:detail:*"   — clear catalog detail cache (24h TTL)
//   "cs:catalog:*"  — clear catalog search cache (6h TTL)
//   "cs:*"          — clear all Cardsight cache (use with care)

const Redis = require("ioredis");

const PATTERN = process.argv[2] || "cs:pricing:*";

async function main() {
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT || 6380);
  const key = process.env.REDIS_KEY;
  const tls = process.env.REDIS_TLS !== "false";
  if (!host) {
    console.error("REDIS_HOST not set");
    process.exit(2);
  }
  const client = new Redis({
    host,
    port,
    password: key,
    tls: tls ? {} : undefined,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true,
  });
  await client.connect();
  console.log(JSON.stringify({ event: "connected", host, port, tls }));

  let cursor = "0";
  const allKeys = [];
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", PATTERN, "COUNT", 500);
    cursor = next;
    if (batch.length) allKeys.push(...batch);
  } while (cursor !== "0");

  console.log(JSON.stringify({ event: "scan_done", pattern: PATTERN, foundKeys: allKeys.length }));
  if (allKeys.length > 0) {
    console.log(JSON.stringify({ event: "sample_keys", first5: allKeys.slice(0, 5) }));
  }

  let deleted = 0;
  const CHUNK = 200;
  for (let i = 0; i < allKeys.length; i += CHUNK) {
    const chunk = allKeys.slice(i, i + CHUNK);
    deleted += await client.del(...chunk);
  }
  console.log(JSON.stringify({ event: "flush_complete", pattern: PATTERN, deletedKeys: deleted }));

  await client.quit();
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
