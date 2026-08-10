#!/usr/bin/env node
/**
 * CF-SC-SETKEY-NORMALIZE (Drew, 2026-08-10). Tags every sold_comp
 * with a `normalizedSetKey` field so it maps cleanly to catalog v2
 * setKeys.
 *
 * Doctrine: sold_comps arrive with messy setName strings like:
 *   "2025 Topps Baseball"  (year prefix + sport suffix)
 *   "Topps Chrome"         (no year)
 *   "topps-chrome"         (already slug-like)
 *   "Bowman Chrome Prospects Autographs"
 *
 * The normalizer strips year+sport, lowercases+hyphenates, then
 * applies aliases + card-number-prefix routing to arrive at a
 * canonical setKey matching card_catalog.setKey.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/normalizeSoldCompSetKey.cjs \
 *     [--report-only]   # dry-run, just show coverage stats
 *     [--apply]         # tag sold_comps with normalizedSetKey
 */

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);

// 429 backoff wrapper. Original script counted 429s as errors and
// moved on, losing those rows permanently. When CH fanout or other
// heavy write jobs compete for sold_comps RUs, that lost ~99% of
// throughput. Now we retry with exponential backoff.
async function patchWithRetry(container, id, pk, ops, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await container.item(id, pk).patch(ops);
      return true;
    } catch (err) {
      const code = err && (err.code ?? err.statusCode);
      const msg = String((err && err.message) || "");
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxAttempts - 1) {
        const wait = Number((err && err.retryAfterInMs) ?? 500 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function fetchNextWithRetry(iter, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await iter.fetchNext(); }
    catch (err) {
      const code = err && (err.code ?? err.statusCode);
      const msg = String((err && err.message) || "");
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxAttempts - 1) {
        const wait = Number((err && err.retryAfterInMs) ?? 1000 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("exhausted retries");
}

// Card-number-prefix → definitive setKey (from prefixMapSoldCompsToCatalog).
const PREFIX_TO_SETKEY = {
  "BCP": "bowman-chrome", "BCPA": "bowman-chrome", "CPA": "bowman-chrome", "CPRA": "bowman-chrome",
  "BDC": "bowman-draft", "BDCP": "bowman-draft", "CDA": "bowman-draft",
  "BSPA": "bowman-sterling", "BSA": "bowman-sterling", "BSRA": "bowman-sterling",
  "US": "topps-update", "USR": "topps-update",
  "TF": "topps-finest", "FR": "topps-finest",
  "CTC": "topps-cosmic-chrome",
  "TPU": "topps-pristine",
};

// Alias table: normalized-setName-slug → canonical catalog setKey.
// Applied AFTER strip-year-and-sport + slugify.
const SETKEY_ALIASES = {
  // Topps family
  "topps": "topps-series-1",              // generic "topps" often = flagship = Series 1
  "topps-baseball": "topps-series-1",
  "topps-series-1": "topps-series-1",
  "topps-series-2": "topps-series-2",
  "topps-update": "topps-update-series",
  "topps-update-series": "topps-update-series",
  "topps-chrome": "topps-chrome",
  "topps-chrome-update": "topps-chrome-update",
  "topps-chrome-platinum": "topps-chrome-platinum-anniversary",
  "topps-chrome-platinum-anniversary": "topps-chrome-platinum-anniversary",
  "topps-heritage": "topps-heritage",
  "topps-finest": "topps-finest",
  "topps-pristine": "topps-pristine",
  "topps-tier-one": "topps-tier-one",
  "topps-tribute": "topps-tribute",
  "topps-cosmic-chrome": "topps-cosmic-chrome",
  "topps-stadium-club": "topps-stadium-club",
  "topps-inception": "topps-inception",
  "topps-archives": "topps-archives",
  "topps-museum-collection": "topps-museum-collection",
  "topps-206": "topps-206",
  "topps-allen-and-ginter": "topps-allen-ginter",
  "topps-allen-ginter": "topps-allen-ginter",
  "topps-big-league": "topps-big-league",
  "topps-gilded-collection": "topps-gilded-collection",
  "topps-pro-debut": "topps-pro-debut",
  "topps-sterling": "topps-sterling",
  "topps-black-and-white": "topps-black-white",
  "topps-black-white": "topps-black-white",
  "topps-diamond-icons": "topps-diamond-icons",
  "topps-five-star": "topps-five-star",
  "topps-luminaries": "topps-luminaries",
  "topps-definitive-collection": "topps-definitive-collection",
  "topps-dynasty": "topps-dynasty",
  "topps-transcendent": "topps-transcendent",
  "topps-brooklyn-collection": "topps-brooklyn-collection",
  "topps-holiday": "topps-holiday",
  "topps-now": "topps-now",
  "topps-japan-edition": "topps-japan",

  // Bowman family
  "bowman": "bowman",
  "bowman-baseball": "bowman",
  "bowman-chrome": "bowman-chrome",
  "bowman-chrome-baseball": "bowman-chrome",
  "bowman-chrome-mega-box": "bowman-chrome-mega-box",
  "bowman-mega-box": "bowman-mega-box",
  "bowman-draft": "bowman-draft",
  "bowman-draft-baseball": "bowman-draft",
  "bowman-draft-chrome": "bowman-draft",
  "bowman-chrome-sapphire": "bowman-chrome-sapphire",
  "bowman-sapphire": "bowman-sapphire",
  "bowman-draft-sapphire": "bowman-draft-sapphire",
  "bowman-sterling": "bowman-sterling",
  "bowmans-best": "bowmans-best",
  "bowman-best": "bowmans-best",
  "bowman-chrome-prospects": "bowman-chrome",
  "bowman-chrome-prospects-autographs": "bowman-chrome",
  "bowman-heritage": "bowman-heritage",
  "bowman-inception": "bowman-inception",
  "bowman-platinum": "bowman-platinum",

  // Panini family
  "panini-prizm": "panini-prizm",
  "panini-prizm-draft-picks": "panini-prizm-draft-picks",
  "panini-select": "panini-select",
  "panini-immaculate": "panini-immaculate",
  "panini-immaculate-collection": "panini-immaculate",
  "panini-flawless": "panini-flawless",
  "panini-national-treasures": "panini-national-treasures",
  "panini-chronicles": "panini-chronicles",
  "panini-donruss": "donruss",
  "panini-donruss-optic": "donruss-optic",
  "donruss": "donruss",
  "donruss-optic": "donruss-optic",
  "donruss-elite": "donruss-elite",

  // Leaf
  "leaf-metal": "leaf-metal",
  "leaf-metal-draft": "leaf-metal-draft",
  "leaf-trinity": "leaf-trinity",
  "leaf-vivid": "leaf-vivid",
  "leaf-electrum": "leaf-electrum",
};

function normalizeSetName(setName) {
  if (!setName) return null;
  let s = String(setName).trim().toLowerCase();
  // Strip year prefix
  s = s.replace(/^(19|20)\d{2}[\s\-]+/, "");
  // Strip trailing sport
  s = s.replace(/[\s\-]+(baseball|basketball|football|hockey|soccer|racing|wrestling)\s*$/, "");
  // Strip trailing "checklist", "cards", "set"
  s = s.replace(/[\s\-]+(checklist|cards|set)\s*$/, "");
  // Normalize: replace & with and, remove punctuation, hyphenate
  s = s.replace(/&/g, "and")
       .replace(/[^\w\s-]/g, "")
       .replace(/\s+/g, "-")
       .replace(/-+/g, "-")
       .replace(/^-|-$/g, "");
  return s;
}

function deriveSetKey(row) {
  // Priority 1: card-number-prefix override (e.g. BCP → bowman-chrome
  // regardless of setName). Most authoritative.
  const cn = String(row.cardNumber ?? "").trim().toUpperCase();
  const prefixMatch = /^([A-Z]{1,6})-/.exec(cn);
  if (prefixMatch && PREFIX_TO_SETKEY[prefixMatch[1]]) {
    return PREFIX_TO_SETKEY[prefixMatch[1]];
  }
  // Priority 2: alias-table lookup on normalized setName.
  const norm = normalizeSetName(row.setName);
  if (norm && SETKEY_ALIASES[norm]) return SETKEY_ALIASES[norm];
  // Priority 3: use the normalized string as-is (assume the site
  // already produced a valid slug like "topps-chrome").
  return norm;
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  console.log(`[sc-normalize] MODE=${APPLY ? "APPLY" : "REPORT-ONLY"}`);

  // Build catalog setKey lookup
  console.log(`[sc-normalize] loading catalog setKeys...`);
  const setKeysInCatalog = new Set();
  const iter = cat.items.query({
    query: "SELECT c.setKey FROM c WHERE c.catalogVersion = 2 AND IS_DEFINED(c.setKey) GROUP BY c.setKey"
  }, { maxItemCount: 5000 }).getAsyncIterator();
  for await (const page of iter) {
    for (const r of page.resources ?? []) {
      if (r.setKey) setKeysInCatalog.add(String(r.setKey).toLowerCase());
    }
  }
  console.log(`[sc-normalize] catalog distinct setKeys: ${setKeysInCatalog.size.toLocaleString()}`);

  console.log(`\n[sc-normalize] scanning sold_comps...`);
  const derivedCounts = new Map();
  const unmatched = new Map();
  let scanned = 0, matched = 0, updated = 0, errors = 0;
  const t0 = Date.now();
  const scIt = sc.items.query({
    query: "SELECT c.id, c.cardId, c.setName, c.cardNumber, c.cardYear, c.normalizedSetKey FROM c WHERE c.price > 0"
  }, { maxItemCount: 2000 });
  const updateQueue = [];
  while (scIt.hasMoreResults()) {
    const page = await fetchNextWithRetry(scIt);
    for (const r of page.resources ?? []) {
      scanned++;
      const derived = deriveSetKey(r);
      if (!derived) continue;
      if (setKeysInCatalog.has(derived)) {
        matched++;
        derivedCounts.set(derived, (derivedCounts.get(derived) ?? 0) + 1);
        if (APPLY && r.normalizedSetKey !== derived) {
          updateQueue.push({ id: r.id, cardId: r.cardId, normalizedSetKey: derived });
        }
      } else {
        unmatched.set(derived, (unmatched.get(derived) ?? 0) + 1);
      }
    }
    // Flush updates in batches
    if (APPLY && updateQueue.length >= 500) {
      const batch = updateQueue.splice(0);
      for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(async (u) => {
          try {
            const pk = typeof u.cardId === "string" && u.cardId.length > 0 ? u.cardId : undefined;
            await patchWithRetry(sc, u.id, pk, [{ op: "add", path: "/normalizedSetKey", value: u.normalizedSetKey }]);
            updated++;
          } catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${u.id}: ${err.message.slice(0,80)}`); }
        }));
      }
    }
    if (scanned % 50000 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  scanned ${scanned.toLocaleString()} · matched ${matched.toLocaleString()} · updated ${updated.toLocaleString()} · errors ${errors} · ${elapsed}s`);
    }
  }
  // Flush trailing updates
  if (APPLY && updateQueue.length > 0) {
    for (let i = 0; i < updateQueue.length; i += CONCURRENCY) {
      const chunk = updateQueue.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (u) => {
        try {
          const pk = typeof u.cardId === "string" && u.cardId.length > 0 ? u.cardId : undefined;
          await patchWithRetry(sc, u.id, pk, [{ op: "add", path: "/normalizedSetKey", value: u.normalizedSetKey }]);
          updated++;
        } catch (err) { errors++; }
      }));
    }
  }
  console.log(`\n\n╔═══ RESULT ═══`);
  console.log(`║ sold_comps scanned:   ${scanned.toLocaleString()}`);
  console.log(`║ Matched to catalog:   ${matched.toLocaleString()}  (${(matched*100/scanned).toFixed(1)}%)`);
  if (APPLY) {
    console.log(`║ normalizedSetKey set: ${updated.toLocaleString()}`);
    console.log(`║ Errors:               ${errors.toLocaleString()}`);
  }
  console.log(`╚═══`);

  console.log(`\nTop 15 unmatched normalized-set-names (candidates for alias-table additions):`);
  const unmatchedSorted = [...unmatched.entries()].sort((a,b) => b[1] - a[1]).slice(0, 15);
  for (const [k, n] of unmatchedSorted) console.log(`  ${k.padEnd(40)} ${n.toLocaleString()}`);
})().catch((e) => { console.error(e); process.exit(1); });
