// CF-BD-FROM-UPPER-DECK (Drew, 2026-08-10). Move sold_comps rows that
// belong to 1999 Upper Deck Black Diamond but are living under bare
// `upper-deck` setKey. Two distinguishing signals:
//   1. parallel = Double / Triple / Quadruple  → BD-only foil parallel
//   2. cardNumber starts with D                → BD Diamond Dominance insert
//   3. cardNumber starts with M                → BD Mystery Numbers insert
//
// Safe because these parallel names + prefixes are UNIQUE to BD; no
// 1999 UD main-set card uses Double/Triple/Quadruple parallel or
// D-/M-prefix cardNumber.
//
// Env: APPLY=true

const { CosmosClient } = require("@azure/cosmos");
const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

// Slug shape: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
const SLUG_RE = /^(hiq:[^:]+:\d+):([^:]+):([^:]+):([^:]+):([^:]+)((?::num-\d+)?)$/;

// BD-only parallel print runs (short set / debut / insert cases)
const BD_PARALLEL_PRINT_RUNS = {
  double: 3000,     // Double Diamond (short set base)
  triple: 1500,     // Triple Diamond
  quadruple: 150,   // Quadruple Diamond
};

function rewrite(slug) {
  const m = SLUG_RE.exec(slug);
  if (!m) return null;
  const [_, prefix, setKey, cardNumber, parallel, autoFlag, tail] = m;
  if (setKey !== "upper-deck") return null;
  const cn = cardNumber.toLowerCase();
  const par = parallel.toLowerCase();

  // Rule 1: BD-only parallel
  if (par in BD_PARALLEL_PRINT_RUNS) {
    const targetRun = BD_PARALLEL_PRINT_RUNS[par];
    const newTail = tail || `:num-${targetRun}`;
    return `${prefix}:upper-deck-black-diamond:${cardNumber}:${parallel}:${autoFlag}${newTail}`;
  }

  // Rule 2: D-prefix cardNumber = Diamond Dominance insert (BD-only, /1500)
  if (/^d\d/.test(cn)) {
    const newTail = tail || ":num-1500";
    return `${prefix}:upper-deck-black-diamond:${cardNumber}:${parallel}:${autoFlag}${newTail}`;
  }

  // Rule 3: M-prefix cardNumber = Mystery Numbers insert (BD-only, variable /100-3000)
  if (/^m\d/.test(cn)) {
    return `${prefix}:upper-deck-black-diamond:${cardNumber}:${parallel}:${autoFlag}${tail}`;
  }

  return null;
}

async function patchWithRetry(sold, r, newSlug, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await sold.item(r.id, r.cardId).patch([
        { op: "set", path: "/hobbyiqCardId", value: newSlug },
        { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
        { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
        { op: "set", path: "/reslugedReason", value: "CF-BD-FROM-UPPER-DECK" },
      ]);
      return true;
    } catch (err) {
      if (err && err.code === 429) {
        const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
        await new Promise(r => setTimeout(r, wait)); continue;
      }
      throw err;
    }
  }
  return false;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}`);

  // Cosmos SQL: find candidates with year 1999, upper-deck setKey, and
  // BD-distinguishing shape (parallel or cardNumber-prefix signal)
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId FROM c
             WHERE IS_STRING(c.hobbyiqCardId)
               AND STARTSWITH(c.hobbyiqCardId, 'hiq:baseball:1999:upper-deck:')`;
  const it = sold.items.query({ query: q }, { maxItemCount: 500 });

  let scanned = 0, changed = 0, touched = 0, failed = 0, skipped = 0;
  const inflight = [];
  const bucket = new Map();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const newSlug = rewrite(r.hobbyiqCardId);
      if (!newSlug || newSlug === r.hobbyiqCardId) { skipped++; continue; }
      changed++;
      bucket.set(r.hobbyiqCardId + " → " + newSlug, (bucket.get(r.hobbyiqCardId + " → " + newSlug)||0)+1);

      if (!APPLY) { touched++; continue; }
      const p = patchWithRetry(sold, r, newSlug)
        .then((ok) => { if (ok) touched++; else failed++; })
        .catch((err) => { console.warn(`fail ${r.id}: ${err.message||err}`); failed++; })
        .finally(() => { const idx = inflight.indexOf(p); if (idx >= 0) inflight.splice(idx, 1); });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);
    }
  }
  await Promise.all(inflight);
  console.log(`\n[done] scanned=${scanned} changed=${changed} touched=${touched} failed=${failed} skipped=${skipped}`);
  console.log("\nrewrite patterns:");
  for (const [k, v] of [...bucket.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 40)) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
