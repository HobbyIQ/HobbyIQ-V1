#!/usr/bin/env node
/**
 * CF-BACKFILL-THE-BROKEN-JOIN (Drew, 2026-08-17: "do it").
 *
 * Repairs the missing link between comps_staging and verify_queue for rows that
 * already exist. New rows are handled by CF-QUEUE-MUST-POINT-BACK; this is the
 * history.
 *
 * The state it fixes, measured:
 *
 *     pending queue entries WITH a stagingId        0 of 1,489,444
 *     awaiting-verify rows with NO anomaly    917,638 of   946,358  (97.0%)
 *
 * The staging row says "held" and names no reason; the queue entry names the
 * reason and points at nothing. Neither side can find the other, so a resolution
 * cannot return the sale to the pool — `pending` is the only status the promoter
 * reads. That is why awaiting-verify has no consumer.
 *
 * MATCH KEY. (cardId, price, soldAt-day) — the same composite
 * syncVerifyQueueWithStaging has been using as a workaround for this very gap, so
 * this introduces no new notion of identity. Day granularity because the two
 * sides store soldAt at different precisions.
 *
 * AMBIGUITY IS NOT GUESSED AT. When a key matches more than one queue entry the
 * row is SKIPPED, not assigned to the first candidate. A wrong reason stamped on
 * a staging row is worse than no reason: it is a well-formed lie that no later
 * sweep would question.
 *
 * INDEX-THEN-SCAN, one pass each. 917k cross-partition lookups would take hours;
 * verify_queue is read once into a Map (keyed as above) and the staging scan then
 * resolves in memory. Run with --max-old-space-size=4096.
 *
 * WRITES: reason + queue id onto the staging row (so it finally states why it is
 * held) and stagingId onto the queue row (so a resolution can find the sale).
 * It does NOT release, promote or re-drive anything — release-stale-verify-
 * anomalies.cjs is what acts on the reason once it is readable.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." NODE_OPTIONS=--max-old-space-size=4096 \
 *   node backend/scripts/backfill-verify-queue-stagingid.cjs [--apply] [--limit=N]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(n, d) { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; }
const has = (n) => process.argv.includes(`--${n}`);
const APPLY = has("apply");
const LIMIT = Number(arg("limit", "1000000"));
const POOL = Math.max(1, Number(arg("pool", "8")));

/** Same shape both sides, so a key built from staging matches one built from the
 *  queue. Price rounded to cents; soldAt truncated to the day. */
function matchKey(cardId, price, soldAt) {
  const p = Math.round(Number(price) * 100);
  const d = String(soldAt || "").slice(0, 10);
  if (!cardId || !Number.isFinite(p) || !d) return null;
  return `${cardId}||${p}||${d}`;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const vq = db.container("verify_queue");
  const staging = db.container("comps_staging");

  console.log(`[backfill-join] mode=${APPLY ? "APPLY" : "DRY-RUN"} limit=${LIMIT}\n`);

  // ---- pass 1: index the queue -------------------------------------------
  const index = new Map();      // key -> {id, reason} | "AMBIGUOUS"
  let qRows = 0, qKeyed = 0, ambiguous = 0;
  const qIter = vq.items.query({
    query: `SELECT c.id, c.reason, c.stagingId, c.input.cardId AS cardId,
                   c.input.price AS price, c.input.soldAt AS soldAt
            FROM c WHERE c.status = 'pending'`,
  }, { maxItemCount: 1000 });
  while (qIter.hasMoreResults()) {
    const { resources } = await qIter.fetchNext();
    for (const r of resources || []) {
      qRows++;
      const k = matchKey(r.cardId, r.price, r.soldAt);
      if (!k) continue;
      const prev = index.get(k);
      if (prev === undefined) { index.set(k, { id: r.id, reason: r.reason, hasLink: !!r.stagingId }); qKeyed++; }
      else if (prev !== "AMBIGUOUS") { index.set(k, "AMBIGUOUS"); ambiguous++; qKeyed--; }
    }
    if (qRows % 200000 === 0) process.stderr.write(`\r  indexing queue: ${qRows.toLocaleString()} rows, ${index.size.toLocaleString()} keys   `);
  }
  process.stderr.write("\n");
  console.log(`queue rows read      : ${qRows.toLocaleString()}`);
  console.log(`unique match keys    : ${qKeyed.toLocaleString()}`);
  console.log(`keys hitting 2+ rows : ${ambiguous.toLocaleString()}  (skipped — not guessed at)\n`);

  // ---- pass 2: scan staging, resolve in memory ----------------------------
  let scanned = 0, matched = 0, noKey = 0, unmatched = 0, amb = 0, written = 0, failed = 0;
  const byReason = {};
  const sIter = staging.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.clean, c.raw.vendorPayload.price AS price,
                   c.raw.vendorPayload.soldAt AS soldAt
            FROM c WHERE c.status = 'awaiting-verify'`,
  }, { maxItemCount: 500 });

  while (sIter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await sIter.fetchNext();
    if (!resources || resources.length === 0) continue;
    const work = [];
    for (const r of resources) {
      if (scanned >= LIMIT) break;
      scanned++;
      const slug = String(r.hobbyiqCardId || "");
      // Rows that already state their own reason need nothing from the queue.
      if (r.clean && Array.isArray(r.clean.anomalies) && r.clean.anomalies.length > 0) continue;
      const k = matchKey(slug, r.price, r.soldAt);
      if (!k) { noKey++; continue; }
      const hit = index.get(k);
      if (hit === undefined) { unmatched++; continue; }
      if (hit === "AMBIGUOUS") { amb++; continue; }
      matched++;
      byReason[hit.reason ?? "(none)"] = (byReason[hit.reason ?? "(none)"] || 0) + 1;
      work.push({ r, slug, hit });
    }
    if (APPLY && work.length) {
      let cur = 0;
      await Promise.all(Array.from({ length: POOL }, async () => {
        while (cur < work.length) {
          const { r, slug, hit } = work[cur++];
          try {
            await staging.item(r.id, slug).patch([
              { op: "add", path: "/heldReason", value: hit.reason ?? null },
              { op: "add", path: "/verifyQueueId", value: hit.id },
              { op: "add", path: "/joinBackfilledAt", value: new Date().toISOString() },
            ]);
            if (!hit.hasLink) {
              // verify_queue is partitioned on /reason.
              await vq.item(hit.id, hit.reason).patch([
                { op: "add", path: "/stagingId", value: r.id },
                { op: "add", path: "/stagingIdBackfilledAt", value: new Date().toISOString() },
              ]);
            }
            written++;
          } catch (e) {
            failed++;
            if (failed <= 3) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 70)}`);
          }
        }
      }));
    }
    process.stderr.write(`\r  staging: scanned=${scanned.toLocaleString()} matched=${matched.toLocaleString()} written=${written.toLocaleString()}   `);
  }
  process.stderr.write("\n");

  console.log(`\nstaging scanned        : ${scanned.toLocaleString()}`);
  console.log(`MATCHED to a queue row : ${matched.toLocaleString()}`);
  console.log(`no usable match key    : ${noKey.toLocaleString()}`);
  console.log(`no queue row found     : ${unmatched.toLocaleString()}`);
  console.log(`ambiguous (skipped)    : ${amb.toLocaleString()}`);
  console.log(`patched                : ${written.toLocaleString()}   failed: ${failed.toLocaleString()}`);
  console.log("\nreasons recovered:");
  Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));
  if (!APPLY) console.log("\nDRY-RUN — nothing written.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
