// One-off: flush ch:match:* keys from Redis cache.
// Post-PR-#16 deploy cleanup — pre-fix entries cached null sentinels for 6h.
const Redis = require("ioredis");

(async () => {
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT || 6380);
  const password = process.env.REDIS_KEY;
  const tls = process.env.REDIS_TLS !== "false";
  if (!host || !password) { console.error("Missing REDIS_HOST/REDIS_KEY"); process.exit(2); }
  const client = new Redis({
    host, port, password,
    tls: tls ? {} : undefined,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 8000,
    lazyConnect: true,
  });
  await client.connect();
  console.log(`[flush] connected to ${host}:${port}`);

  const pattern = process.argv[2] || "ch:match:*";
  let cursor = "0";
  let total = 0;
  let batches = 0;
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length > 0) {
      const deleted = await client.del(...keys);
      total += deleted;
      batches += 1;
      console.log(`[flush] batch ${batches}: deleted ${deleted} (cursor=${cursor})`);
    }
  } while (cursor !== "0");

  console.log(`[flush] DONE — pattern="${pattern}" deletedTotal=${total}`);
  await client.quit();
})().catch((err) => { console.error("[flush] ERROR", err); process.exit(1); });
