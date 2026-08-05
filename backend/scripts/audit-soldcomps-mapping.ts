#!/usr/bin/env -S npx tsx
/**
 * CF-AUDIT-SOLDCOMPS-MAPPING (Drew, 2026-08-05).
 *
 * Answers: does every sold_comp map to a valid Card in the tree?
 *
 * Walks sold_comps for a sport (and optionally year) and categorizes
 * each row by how well its hobbyiqCardId maps to a Card node in
 * card_catalog:
 *
 *   OK              — slug is well-formed AND matching Card doc exists
 *                     (kind = "card", id = "card::" + <trimmed slug>)
 *   NO_SLUG         — hobbyiqCardId missing / null / empty
 *   MALFORMED       — hobbyiqCardId contains "::" (empty segment)
 *   NO_CARD_NODE    — slug is well-formed but no Card doc exists yet
 *                     (tree not built for that year × sport)
 *   PARSE_FAIL      — slug can't be parsed into (year, setKey, cardNumber)
 *
 * Reports counts + samples per bucket + top offenders (year × setKey).
 * Read-only.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   AUDIT_SPORT               default: baseball
 *   AUDIT_YEAR                optional filter
 *   SAMPLE_SIZE               default: 8 per bucket
 *   MAX_ROWS                  optional cap for slice tests
 */

import { CosmosClient } from "@azure/cosmos";

const SPORT = process.env.AUDIT_SPORT || "baseball";
const YEAR = process.env.AUDIT_YEAR ? Number(process.env.AUDIT_YEAR) : null;
const SAMPLE_SIZE = Math.max(1, Number(process.env.SAMPLE_SIZE || 8));
const MAX_ROWS = process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : 0;

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const client = new CosmosClient(conn);
const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const soldComps = db.container("sold_comps");
const catalog = db.container("card_catalog");

interface SoldCompRow {
  id: string;
  hobbyiqCardId?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
  parallel?: string | null;
  source?: string | null;
}

type Bucket = "OK" | "NO_SLUG" | "MALFORMED" | "NO_CARD_NODE" | "PARSE_FAIL";

function cardIdFromSlug(slug: string): string | null {
  const parts = slug.split(":");
  if (parts.length < 6) return null;
  const [hiq, sport, year, setKey, cardNumber] = parts;
  if (hiq !== "hiq" || !sport || !year || !setKey || !cardNumber) return null;
  return `card::hiq:${sport}:${year}:${setKey}:${cardNumber}`;
}

// Memoize Card-node existence checks so we don't hammer Cosmos.
const cardNodeCache = new Map<string, boolean>();
async function cardNodeExists(cardDocId: string): Promise<boolean> {
  const cached = cardNodeCache.get(cardDocId);
  if (cached !== undefined) return cached;
  try {
    // point-read on partition key = cardId (the canonical, without card::)
    const cardId = cardDocId.startsWith("card::") ? cardDocId.slice(6) : cardDocId;
    await catalog.item(cardDocId, cardId).read();
    cardNodeCache.set(cardDocId, true);
    return true;
  } catch (err) {
    const status = (err as { code?: number })?.code;
    if (status === 404) {
      cardNodeCache.set(cardDocId, false);
      return false;
    }
    cardNodeCache.set(cardDocId, false);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`▸ Audit — sport=${SPORT}${YEAR ? ` year=${YEAR}` : ""}${MAX_ROWS ? ` cap=${MAX_ROWS}` : ""}`);
  const parts = ["c.sport = @sport"];
  const params: Array<{ name: string; value: string | number }> = [{ name: "@sport", value: SPORT }];
  if (YEAR) { parts.push("c.cardYear = @year"); params.push({ name: "@year", value: YEAR }); }
  const query = `SELECT c.id, c.hobbyiqCardId, c.cardYear, c.setName, c.cardNumber, c.playerName, c.parallel, c.source FROM c WHERE ${parts.join(" AND ")}`;
  const it = soldComps.items.query<SoldCompRow>({ query, parameters: params }, { maxItemCount: 500 });

  const counts: Record<Bucket, number> = { OK: 0, NO_SLUG: 0, MALFORMED: 0, NO_CARD_NODE: 0, PARSE_FAIL: 0 };
  const samples: Record<Bucket, SoldCompRow[]> = { OK: [], NO_SLUG: [], MALFORMED: [], NO_CARD_NODE: [], PARSE_FAIL: [] };
  const byYearSetKey: Record<Bucket, Map<string, number>> = { OK: new Map(), NO_SLUG: new Map(), MALFORMED: new Map(), NO_CARD_NODE: new Map(), PARSE_FAIL: new Map() };

  let scanned = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      let bucket: Bucket = "OK";
      if (!r.hobbyiqCardId) bucket = "NO_SLUG";
      else if (r.hobbyiqCardId.includes("::")) bucket = "MALFORMED";
      else {
        const cardDocId = cardIdFromSlug(r.hobbyiqCardId);
        if (!cardDocId) bucket = "PARSE_FAIL";
        else {
          const exists = await cardNodeExists(cardDocId);
          bucket = exists ? "OK" : "NO_CARD_NODE";
        }
      }
      counts[bucket]++;
      if (samples[bucket].length < SAMPLE_SIZE) samples[bucket].push(r);
      const bucketKey = `${r.cardYear ?? "?"}::${(r.setName ?? "?").slice(0, 40)}`;
      byYearSetKey[bucket].set(bucketKey, (byYearSetKey[bucket].get(bucketKey) ?? 0) + 1);
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned ${scanned} (${Math.round(scanned / elapsed)}/s) · OK=${counts.OK} NO_SLUG=${counts.NO_SLUG} MALFORMED=${counts.MALFORMED} NO_CARD_NODE=${counts.NO_CARD_NODE} PARSE_FAIL=${counts.PARSE_FAIL}\r`);
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
  }

  console.log(`\n\n▸ Results (${scanned.toLocaleString()} scanned)`);
  const total = scanned || 1;
  for (const b of ["OK", "NO_SLUG", "MALFORMED", "NO_CARD_NODE", "PARSE_FAIL"] as Bucket[]) {
    const n = counts[b];
    console.log(`  ${b.padEnd(14)} ${n.toLocaleString().padStart(10)}  (${(n / total * 100).toFixed(1)}%)`);
  }

  for (const b of ["NO_SLUG", "MALFORMED", "NO_CARD_NODE", "PARSE_FAIL"] as Bucket[]) {
    if (counts[b] === 0) continue;
    console.log(`\n▸ ${b} — top year×setKey offenders:`);
    const sorted = [...byYearSetKey[b].entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [key, n] of sorted) console.log(`  ${String(n).padStart(6)}  ${key}`);
    console.log(`\n  Sample rows:`);
    for (const r of samples[b]) {
      console.log(`    slug=${r.hobbyiqCardId ?? "(none)"}`);
      console.log(`      y=${r.cardYear}  set="${r.setName}"  #${r.cardNumber}  player="${r.playerName}"  parallel="${r.parallel}"  src=${r.source}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
