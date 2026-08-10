#!/usr/bin/env node
/**
 * CF-CATALOG-DEFRAG (Drew, 2026-08-09). Materialize the intended
 * catalog shape into Cosmos: one row per (year, cardNumber, player,
 * parallelSlug, isAuto) tuple. The search-time dedup (78e594b8) does
 * this at read time; this script bakes it into storage so the row
 * count matches the "one card per parallel per player per year" model
 * and downstream consumers stop paying the fragmentation cost.
 *
 * Rules per tuple:
 *   Winner  = highest source priority (checklist > bccp > cardhedge >
 *             cardsight > checklist-batch-fill > tcdb-scrape >
 *             ingest-auto-seed > seed > bulk-build-from-pool >
 *             canonical > ch-catalog), tie-broken by
 *             (has :num-N suffix ? preferred), then (has setName ?
 *             preferred), then (highest _ts).
 *   Losers  = every other row in the tuple. Deleted.
 *
 * Universal deletes (regardless of tuple):
 *   - card::-prefixed ids                 (182K polluted rows)
 *   - source='tree-builder-v1'            (deprecated per memory)
 *   - cardNumber matches auto-prefix regex + isAuto=false (phantoms)
 *
 * Runbook:
 *   $env:COSMOS_CONNECTION_STRING = (az webapp config appsettings list \
 *       --name HobbyIQ3 -g rg-hobbyiq-dev \
 *       --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv).Trim()
 *   node backend/scripts/nukeCatalogFragmentation.cjs                 # dry-run, all catalog
 *   node backend/scripts/nukeCatalogFragmentation.cjs --scope=cpa-eha # dry-run, scoped
 *   node backend/scripts/nukeCatalogFragmentation.cjs --apply --scope=cpa-eha
 */

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.argv.includes("--apply");
const SCOPE = (process.argv.find((a) => a.startsWith("--scope=")) ?? "").replace("--scope=", "");

const AUTO_PREFIX_RE = /^(CPA|CPRA|CPAA|BSPA|CDA|CFA|BCPA)-/i;
const SOURCE_PRIORITY = [
  "checklist",
  "bccp-product-structure",
  "cardhedge",
  "cardsight",
  "checklist-batch-fill",
  "tcdb-scrape",
  "ingest-auto-seed",
  "seed",
  "bulk-build-from-pool",
  "canonical",
  "ch-catalog",
];
const sourceRank = (s) => {
  if (!s) return 100;
  const i = SOURCE_PRIORITY.indexOf(s);
  return i === -1 ? 99 : i;
};

const normParallel = (r) => {
  const raw = r.parallelSlug ?? r.parallel ?? "base";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "-");
};

const identityKey = (r) => [
  r.year ?? r.cardYear ?? "?",
  String(r.cardNumber ?? "").trim().toLowerCase(),
  String(r.playerName ?? "").trim().toLowerCase(),
  normParallel(r),
  r.isAuto === true ? "auto" : "no-auto",
].join("::");

const hasNumSuffix = (r) => {
  const s = r.hobbyiqCardId ?? r.id ?? "";
  return /:num-\d+$/.test(String(s));
};

const buildScopeQuery = () => {
  if (SCOPE === "cpa-eha") {
    return {
      query: "SELECT * FROM c WHERE c.cardNumber = 'CPA-EHA' AND c.year = 2026",
      parameters: [],
    };
  }
  if (!SCOPE) {
    return { query: "SELECT * FROM c", parameters: [] };
  }
  throw new Error(`Unknown --scope=${SCOPE}. Supported: cpa-eha`);
};

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  const q = buildScopeQuery();
  console.log(`[defrag] MODE=${APPLY ? "APPLY" : "DRY-RUN"}${SCOPE ? " SCOPE=" + SCOPE : " SCOPE=(all catalog)"}`);
  console.log(`[defrag] query: ${q.query}`);
  console.log("");

  const { resources: rows } = await cat.items.query(q).fetchAll();
  console.log(`[defrag] fetched ${rows.length} rows`);

  const toDelete = [];   // { id, partitionKey, reason }
  const survivors = [];  // for reporting

  // Universal deletes: card:: prefix
  for (const r of rows) {
    if (typeof r.id === "string" && r.id.startsWith("card::")) {
      toDelete.push({ id: r.id, partitionKey: r.cardId, reason: "card::-prefix polluted row" });
    }
  }
  // Universal deletes: tree-builder-v1
  for (const r of rows) {
    if (r.source === "tree-builder-v1") {
      toDelete.push({ id: r.id, partitionKey: r.cardId, reason: "tree-builder-v1 deprecated source" });
    }
  }
  // Universal deletes: no-auto phantom for auto-prefix card numbers.
  // Use `isAuto !== true` (not `=== false`) so undefined-isAuto rows
  // like the src=canonical BASE:no-auto row also get caught.
  for (const r of rows) {
    if (AUTO_PREFIX_RE.test(String(r.cardNumber ?? "")) && r.isAuto !== true) {
      toDelete.push({ id: r.id, partitionKey: r.cardId, reason: `no-auto phantom for auto-prefix ${r.cardNumber}` });
    }
  }
  // Polluted playerName warning — rows where the "player" field has
  // parallel descriptor words leaked in (e.g. "Eric Hartman Green Grass").
  // We DON'T auto-fix here — that's an upstream normalizer bug — but
  // surface them so the operator knows to backfill playerName.
  const pollutedNames = rows.filter((r) => {
    const p = String(r.playerName ?? "").toLowerCase();
    return /\b(refractor|shimmer|fractor|lava|prizm|wave|sparkle|shock|choice|true|kaleidoscopic)\b/.test(p);
  });
  const universallyDeletedIds = new Set(toDelete.map((d) => d.id));

  // Tuple-level dedup on survivors
  const remaining = rows.filter((r) => !universallyDeletedIds.has(r.id));
  const groups = new Map();
  for (const r of remaining) {
    const k = identityKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // For auto-prefix card numbers, force setKey to the canonical brand
  // family per prefix (CPA-* → bowman-chrome, BSPA-* → bowman-sterling
  // where the product is auto-only). Prevents winners from landing on
  // `setKey:bowman` for what's definitionally a Bowman Chrome card.
  const canonicalSetKeyForPrefix = (cardNumber) => {
    const cn = String(cardNumber ?? "").toUpperCase();
    if (/^CPA-/.test(cn)) return "bowman-chrome";
    if (/^CPRA-/.test(cn)) return "bowman-chrome";
    if (/^CPAA-/.test(cn)) return "bowman-chrome";
    if (/^BCPA-/.test(cn)) return "bowman-chrome";
    if (/^BSPA-/.test(cn)) return "bowman-sterling";
    return null;
  };

  const pickWinner = (group, canonicalSetKey) => {
    // Sort by: canonical setKey match (if applicable) desc, source
    // rank asc, has-num-suffix desc, has-setName desc, _ts desc.
    return [...group].sort((a, b) => {
      if (canonicalSetKey) {
        const kA = a.setKey === canonicalSetKey ? 1 : 0;
        const kB = b.setKey === canonicalSetKey ? 1 : 0;
        if (kA !== kB) return kB - kA;
      }
      const rA = sourceRank(a.source);
      const rB = sourceRank(b.source);
      if (rA !== rB) return rA - rB;
      const nA = hasNumSuffix(a) ? 1 : 0;
      const nB = hasNumSuffix(b) ? 1 : 0;
      if (nA !== nB) return nB - nA;
      const sA = typeof a.setName === "string" && a.setName.trim().length > 0 ? 1 : 0;
      const sB = typeof b.setName === "string" && b.setName.trim().length > 0 ? 1 : 0;
      if (sA !== sB) return sB - sA;
      return (b._ts ?? 0) - (a._ts ?? 0);
    })[0];
  };

  for (const [key, group] of groups.entries()) {
    const canonicalSetKey = canonicalSetKeyForPrefix(group[0].cardNumber);
    if (group.length === 1) { survivors.push({ key, winner: group[0], losers: [] }); continue; }
    const winner = pickWinner(group, canonicalSetKey);
    const losers = group.filter((r) => r.id !== winner.id);
    survivors.push({ key, winner, losers });
    for (const l of losers) {
      toDelete.push({ id: l.id, partitionKey: l.id, reason: `duplicate of ${winner.id} (src=${l.source})` });
    }
  }

  // Report
  console.log(`\n═══ DEFRAG SUMMARY ═══`);
  console.log(`Rows in scope:      ${rows.length}`);
  console.log(`Identity tuples:    ${groups.size}`);
  console.log(`Rows to delete:     ${toDelete.length}`);
  console.log(`  card::-prefix:    ${toDelete.filter((d) => d.reason.startsWith("card::")).length}`);
  console.log(`  tree-builder-v1:  ${toDelete.filter((d) => d.reason.startsWith("tree-builder-v1")).length}`);
  console.log(`  no-auto phantom:  ${toDelete.filter((d) => d.reason.startsWith("no-auto")).length}`);
  console.log(`  tuple dupes:      ${toDelete.filter((d) => d.reason.startsWith("duplicate")).length}`);
  console.log(`Rows surviving:     ${rows.length - toDelete.length}`);
  if (pollutedNames.length > 0) {
    console.log(`\n⚠ POLLUTED playerName rows (parallel words leaked into player, NOT auto-fixed):`);
    for (const p of pollutedNames) {
      console.log(`  ${p.id}`);
      console.log(`    playerName="${p.playerName}"  parallel="${p.parallel}"`);
    }
  }

  // Per-tuple diff (scoped runs only — too noisy for full catalog)
  if (SCOPE) {
    console.log(`\n═══ PER-TUPLE DIFF ═══`);
    const sortedGroups = [...survivors].sort((a, b) => a.key.localeCompare(b.key));
    for (const g of sortedGroups) {
      console.log(`\n[${g.key}]`);
      console.log(`  KEEP: ${g.winner.hobbyiqCardId ?? g.winner.id}`);
      console.log(`        src=${g.winner.source ?? "?"}  parallel=${g.winner.parallel ?? "NULL"}  auto=${g.winner.isAuto}`);
      for (const l of g.losers) {
        console.log(`  DROP: ${l.hobbyiqCardId ?? l.id}`);
        console.log(`        src=${l.source ?? "?"}  parallel=${l.parallel ?? "NULL"}  auto=${l.isAuto}`);
      }
    }
    console.log(`\n═══ UNIVERSAL DELETES ═══`);
    const universal = toDelete.filter((d) => !d.reason.startsWith("duplicate"));
    for (const d of universal) {
      console.log(`  DROP: ${d.id}`);
      console.log(`        reason: ${d.reason}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[defrag] DRY-RUN — no writes performed. Re-run with --apply to execute.`);
    return;
  }

  // APPLY: delete losers. Partition key on card_catalog is /id.
  console.log(`\n[defrag] APPLY — deleting ${toDelete.length} rows...`);
  let done = 0;
  let errors = 0;
  for (const d of toDelete) {
    try {
      // card_catalog partition key is `/cardId`. When a row has no
      // cardId field, the partition key value is "undefined" (Cosmos
      // empty-partition-key semantics) — pass literal undefined, NOT
      // null or empty string, or the delete resolves to a phantom
      // "not found" error.
      const pk = d.partitionKey === undefined || d.partitionKey === null || d.partitionKey === ""
        ? undefined
        : d.partitionKey;
      await cat.item(d.id, pk).delete();
      done++;
      if (done % 100 === 0) console.log(`[defrag]   ${done}/${toDelete.length}`);
    } catch (err) {
      errors++;
      console.warn(`[defrag]   FAIL ${d.id} — ${err.message}`);
    }
  }
  console.log(`\n[defrag] DONE — deleted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
