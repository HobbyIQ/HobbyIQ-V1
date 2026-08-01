#!/usr/bin/env node
// CF-BACKFILL-CANONICALIZE-CHROME-SLUGS (Drew, 2026-07-31).
//
// One-shot backfill to enforce the new chrome-subset canonicalization
// across sold_comps + card_catalog + portfolio holdings. Rewrites any
// slug whose set segment is:
//   - bowman-chrome-draft  → bowman-chrome
//   - topps-chrome-update  → topps-chrome
// Plus any row whose cardNumber prefix (CPA/BCPA/BDPA/BCDA/BCRA/FCA/
// CDA/BCP/... for Bowman; TCRA/TRA/TCU/TC... for Topps) implies a chrome
// stock but currently lives at a non-chrome set slug (bowman-draft,
// bowman, topps, etc.) — force to bowman-chrome / topps-chrome.
// Sapphire slugs are preserved.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_MODE              dry | apply  (default dry)
//   BACKFILL_CONTAINER         sold_comps | card_catalog | portfolio | all (default all)
//   BACKFILL_CONCURRENCY       upsert concurrency (default 8)
//   BACKFILL_LIMIT             cap rows examined per container (default: no cap)

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONTAINER = (process.env.BACKFILL_CONTAINER || "all").toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : Infinity;

// CF-CHROME-PREFIX-OVERRIDE-REMOVED (Drew, 2026-07-31). Cardnumber-prefix
// override was too broad — CPA-, FCA-, TC-, CU- all collide across product
// families (Bowman Chrome vs Topps Chrome Platinum, Bowman vs Donruss
// Champions, etc.). Keeping ONLY the safe set-string collapse.
function canonicalizeSetSegment(setSegment, _cardNumber) {
  let s = setSegment;
  if (s === "bowman-chrome-draft") s = "bowman-chrome";
  if (s === "topps-chrome-update") s = "topps-chrome";
  return s;
}

function canonicalizeSlug(slug, cardNumber) {
  if (typeof slug !== "string" || !slug.startsWith("hiq:")) return slug;
  const parts = slug.split(":");
  if (parts.length < 6) return slug;
  const newSet = canonicalizeSetSegment(parts[3], cardNumber || parts[4]);
  if (newSet === parts[3]) return slug;
  parts[3] = newSet;
  return parts.join(":");
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function processContainer(container, name, opts) {
  const { slugField, cardNumberField, showChanges = 6 } = opts;
  console.log(`\n=== ${name} · mode=${MODE} · slugField=${slugField} · cnField=${cardNumberField} ===`);
  const query = { query: `SELECT * FROM c WHERE STARTSWITH(c.${slugField}, 'hiq:')` };
  const it = container.items.query(query, { maxItemCount: 500 });

  let examined = 0, changed = 0, writeErrors = 0;
  const changeBucket = {};
  const inFlight = [];
  const changesSample = [];

  while (it.hasMoreResults && it.hasMoreResults()) {
    if (examined >= LIMIT) break;
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      if (examined >= LIMIT) break;
      const oldSlug = row[slugField];
      const cn = row[cardNumberField] || (oldSlug.split(":")[4] || "");
      const newSlug = canonicalizeSlug(oldSlug, cn);
      if (newSlug === oldSlug) continue;
      changed++;
      const oldSet = oldSlug.split(":")[3];
      const newSet = newSlug.split(":")[3];
      const key = `${oldSet}\t→ ${newSet}`;
      changeBucket[key] = (changeBucket[key] || 0) + 1;
      if (changesSample.length < showChanges) changesSample.push(`  ${oldSlug}\n  ${newSlug}`);
      if (MODE === "apply") {
        row[slugField] = newSlug;
        row.__canonicalizedChromeAt = new Date().toISOString();
        const p = withRetry(() => container.items.upsert(row))
          .catch(e => { writeErrors++; console.error("  upsert err:", e?.message?.slice(0,80)); });
        inFlight.push(p);
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          // remove settled
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 25000 === 0) console.log(`  examined=${examined}  changed=${changed}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\n  examined=${examined}  changed=${changed}  writeErrors=${writeErrors}`);
  console.log(`  changes by set-segment transition:`);
  Object.entries(changeBucket).sort((a,b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`    ${String(n).padStart(7)}  ${k}`);
  });
  if (changesSample.length) {
    console.log(`  sample changes (${changesSample.length}):`);
    changesSample.forEach(s => console.log(s));
  }
  return { examined, changed, writeErrors };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING required");
    process.exit(1);
  }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");

  console.log(`[backfill-canonicalize-chrome-slugs]`);
  console.log(`  mode=${MODE}  container=${CONTAINER}  concurrency=${CONCURRENCY}  limit=${LIMIT === Infinity ? "none" : LIMIT}`);

  const results = {};
  if (CONTAINER === "sold_comps" || CONTAINER === "all") {
    results.sold_comps = await processContainer(db.container("sold_comps"), "sold_comps", {
      slugField: "hobbyiqCardId", cardNumberField: "cardNumber",
    });
  }
  if (CONTAINER === "card_catalog" || CONTAINER === "all") {
    results.card_catalog = await processContainer(db.container("card_catalog"), "card_catalog", {
      slugField: "hobbyiqCardId", cardNumberField: "cardNumber",
    });
  }
  if (CONTAINER === "portfolio" || CONTAINER === "all") {
    // Portfolio is nested: doc.holdings[key].hobbyiqCardId. Handle specially.
    const container = db.container("portfolio");
    console.log(`\n=== portfolio · mode=${MODE} (nested holdings) ===`);
    const it = container.items.query({ query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 100 });
    let examined = 0, changedDocs = 0, changedHoldings = 0, errors = 0;
    while (it.hasMoreResults && it.hasMoreResults()) {
      const { resources } = await it.fetchNext();
      if (!Array.isArray(resources)) break;
      for (const doc of resources) {
        examined++;
        let docChanged = false;
        for (const [hk, h] of Object.entries(doc.holdings || {})) {
          const oldSlug = h.hobbyiqCardId;
          if (typeof oldSlug !== "string" || !oldSlug.startsWith("hiq:")) continue;
          const newSlug = canonicalizeSlug(oldSlug, h.cardNumber);
          if (newSlug !== oldSlug) {
            h.hobbyiqCardId = newSlug;
            changedHoldings++;
            docChanged = true;
          }
        }
        if (docChanged) {
          changedDocs++;
          if (MODE === "apply") {
            try { await withRetry(() => container.items.upsert(doc)); }
            catch (e) { errors++; console.error("  portfolio upsert err:", e?.message?.slice(0,80)); }
          }
        }
      }
    }
    console.log(`  portfolio docs examined=${examined}  changedDocs=${changedDocs}  changedHoldings=${changedHoldings}  errors=${errors}`);
    results.portfolio = { examined, changedHoldings, errors };
  }

  console.log(`\n[DONE] mode=${MODE}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
