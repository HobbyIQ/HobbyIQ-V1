#!/usr/bin/env node
// CF-RESPORT-POKEMON (Drew, 2026-08-05).
//
// Identifies card_catalog rows tagged `sport=baseball` whose setKey is
// unambiguously Pokemon (swsh-*, sm-*, xy-*, bw-*, champions-path,
// hidden-fates, vivid-voltage, etc.) and re-sports them to Pokemon.
//
// Cause: upstream sold_comps ingest mis-classified some Pokemon sales
// as baseball. Once auto-seeded into card_catalog they inherited the
// wrong sport, then the pool builder ran against them, producing null-
// bucket noise that no baseball data source can ever match.
//
// Read-only unless BACKFILL_APPLY=true. Prints per-setKey counts so
// the caller can eyeball the list before applying.

const { CosmosClient } = require("@azure/cosmos");

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(1);
}
const APPLY = process.env.BACKFILL_APPLY === "true";
const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

// Setkey patterns that are unambiguously Pokemon. Kept narrow to avoid
// false positives — every one of these is a Pokemon expansion prefix.
const POKEMON_PATTERNS = [
  /^swsh/,          // Sword & Shield era (swsh01..swsh12)
  /^sm-/,           // Sun & Moon era
  /^xy/,            // XY era
  /^bw/,            // Black & White era
  /^hidden-fates$/,
  /^champions-path$/,
  /^shining-fates$/,
  /^vivid-voltage$/,
  /^rebel-clash$/,
  /^darkness-ablaze$/,
  /^battle-styles$/,
  /^chilling-reign$/,
  /^evolving-skies$/,
  /^fusion-strike$/,
  /^brilliant-stars$/,
  /^astral-radiance$/,
  /^lost-origin$/,
  /^silver-tempest$/,
  /^crown-zenith$/,
  /^scarlet-violet$/,
  /^paldea-evolved$/,
  /^obsidian-flames$/,
  /^151$/,
  /^paradox-rift$/,
  /^paldean-fates$/,
  /^temporal-forces$/,
  /^twilight-masquerade$/,
];

function looksLikePokemon(setKey) {
  if (!setKey) return false;
  const s = String(setKey).toLowerCase();
  return POKEMON_PATTERNS.some((re) => re.test(s));
}

async function main() {
  console.log(`▸ Scanning card_catalog for sport=baseball rows with Pokemon setKeys...`);
  // CF-PK-CARDID (Drew, 2026-08-05). Container is partitioned by
  // /cardId. Auto-seeded `sales-derived:*` rows have cardId=undefined —
  // patch must send undefined as partitionKey to reach them.
  const q = { query: `SELECT c.id, c.cardId, c.setKey, c.year FROM c WHERE c.sport = "baseball"` };
  const it = cat.items.query(q, { maxItemCount: 1000 });
  const hits = [];
  const bySetKey = new Map();
  let scanned = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (looksLikePokemon(r.setKey)) {
        hits.push(r);
        bySetKey.set(r.setKey, (bySetKey.get(r.setKey) || 0) + 1);
      }
    }
    process.stdout.write(`  scanned ${scanned} · hits ${hits.length}\r`);
  }
  console.log(`\n▸ Found ${hits.length.toLocaleString()} mis-sported rows`);
  const bySort = [...bySetKey.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of bySort.slice(0, 25)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  if (!APPLY) { console.log(`\n(dry run — set BACKFILL_APPLY=true to write)`); return; }

  console.log(`\n▸ Patching sport → pokemon on ${hits.length.toLocaleString()} rows...`);
  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < hits.length; i += CHUNK) chunks.push(hits.slice(i, i + CHUNK));
  let patched = 0, errors = 0;
  const MAX_RETRIES = 12;
  for (const chunk of chunks) {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      // Container PK is /cardId. Auto-seeded `sales-derived:*` rows
      // have no cardId → PartitionKey.None (empty array) per Cosmos JS
      // SDK convention. Rows with cardId use it as the PK.
      const ops = pending.map((r) => ({
        operationType: "Patch",
        id: r.id,
        partitionKey: r.cardId ? r.cardId : [],
        resourceBody: {
          operations: [
            { op: "set", path: "/sport", value: "pokemon" },
            { op: "set", path: "/sportResportedFrom", value: "baseball" },
            { op: "set", path: "/sportResportedAt", value: new Date().toISOString() },
          ],
        },
      }));
      let results;
      try { results = await cat.items.bulk(ops); }
      catch { errors += pending.length; break; }
      const next = [];
      const errorStatuses = new Map();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.statusCode >= 200 && r.statusCode < 300) patched++;
        else if (r.statusCode === 429 || r.statusCode >= 500) next.push(pending[i]);
        else {
          errors++;
          errorStatuses.set(r.statusCode, (errorStatuses.get(r.statusCode) || 0) + 1);
          if (errors <= 5) console.error(`\n  ! id=${pending[i].id} status=${r.statusCode} body=${JSON.stringify(r).slice(0, 200)}`);
        }
      }
      if (errorStatuses.size > 0 && attempt === 0) {
        process.stderr.write(`\n  err breakdown: ${[...errorStatuses.entries()].map(([k,v])=>`${k}:${v}`).join(", ")}`);
      }
      pending = next;
      attempt++;
      if (pending.length > 0) await new Promise((r) => setTimeout(r, 500 * Math.min(4, attempt)));
    }
    if (pending.length > 0) errors += pending.length;
    process.stdout.write(`  patched ${patched}/${hits.length}  errors ${errors}\r`);
  }
  console.log(`\n▸ Done — patched=${patched} errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
