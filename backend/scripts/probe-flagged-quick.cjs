#!/usr/bin/env node
/** Read-only: bounded flagged-row probe. Streams pages with a wall clock so it
 *  reports what it measured instead of hanging on a full-corpus COUNT. */
const { CosmosClient } = require("@azure/cosmos");

const BUDGET_MS = Number(process.env.BUDGET_MS ?? "240000");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container("sold_comps");

  const t0 = Date.now();
  // Stream the flagged rows themselves (indexed equality on flaggedWrong),
  // which returns first page fast, rather than a blocking COUNT aggregate.
  const it = container.items.query(
    {
      query:
        "SELECT c.id, c.cardId, c.contentHash, c.source, c.flaggedReason FROM c WHERE c.flaggedWrong = true",
    },
    { maxItemCount: 1000, maxDegreeOfParallelism: 32 },
  );

  const rows = [];
  let ru = 0;
  let pages = 0;
  let exhausted = true;
  while (it.hasMoreResults()) {
    if (Date.now() - t0 > BUDGET_MS) { exhausted = false; break; }
    const page = await it.fetchNext();
    pages++;
    ru += page.requestCharge ?? 0;
    rows.push(...(page.resources ?? []));
    console.error(`[probe] page=${pages} rows=${rows.length} ru=${Math.round(ru)} ms=${Date.now() - t0}`);
  }

  const bySource = {};
  const byReason = {};
  for (const r of rows) {
    bySource[r.source ?? "(none)"] = (bySource[r.source ?? "(none)"] ?? 0) + 1;
    byReason[r.flaggedReason ?? "(none)"] = (byReason[r.flaggedReason ?? "(none)"] ?? 0) + 1;
  }
  console.log(JSON.stringify({
    phase: "flagged-population",
    exhausted,
    flaggedRows: rows.length,
    withContentHash: rows.filter((r) => r.contentHash).length,
    distinctPartitions: new Set(rows.map((r) => r.cardId)).size,
    bySource,
    byReason,
    ru: Math.round(ru),
    ms: Date.now() - t0,
  }, null, 2));

  // Collision set: per affected partition, does an UNflagged row share the hash?
  const byCard = new Map();
  for (const r of rows) {
    if (!r.cardId || !r.contentHash) continue;
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
    byCard.get(r.cardId).push(r);
  }
  let colliding = 0, affected = 0, scanned = 0;
  const samples = [];
  const t1 = Date.now();
  for (const [cardId, group] of byCard) {
    if (Date.now() - t1 > BUDGET_MS) break;
    scanned++;
    const hashes = [...new Set(group.map((r) => r.contentHash))];
    let live = [];
    try {
      const res = await container.items.query({
        query: "SELECT c.id, c.contentHash FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash) AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)",
        parameters: [{ name: "@h", value: hashes }],
      }, { partitionKey: cardId }).fetchAll();
      live = res.resources ?? [];
    } catch { continue; }
    if (!live.length) continue;
    const liveHashes = new Set(live.map((r) => r.contentHash));
    const hit = group.filter((r) => liveHashes.has(r.contentHash));
    if (!hit.length) continue;
    affected++;
    colliding += hit.length;
    if (samples.length < 5) samples.push({ cardId, flagged: hit.map((r) => r.id), reasons: [...new Set(hit.map((r) => r.flaggedReason))] });
  }
  console.log(JSON.stringify({
    phase: "collision-set",
    partitionsScanned: scanned,
    partitionsTotal: byCard.size,
    affectedPartitions: affected,
    collidingFlaggedRows: colliding,
    samples,
    ms: Date.now() - t1,
  }, null, 2));
}
main().catch((e) => { console.error(e?.message ?? String(e)); process.exit(1); });
