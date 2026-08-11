// CF-CHROME-AUTO-BASE-IS-REFRACTOR (Drew, 2026-08-10). After the source
// fix, existing sold_comps rows that carry :cpa-*:base:auto (or
// :tcpa-*:/:cra-*:base:auto) still need to be moved to :refractor:auto
// so they pool with their existing refractor siblings.
//
// Rule (mirrors the source): setKey = bowman-chrome (or topps-chrome for
// TCPA/CRA), cardNumber prefix matches, parallel = base, isAuto = true
// → rewrite to refractor.
//
// Env: APPLY=true to write.

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);

// slug pattern: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
const SLUG_RE = /^(hiq:[^:]+:\d+):([^:]+):([^:]+):([^:]+):([^:]+)((?::num-\d+)?)$/;

function rewriteSlug(slug) {
  const m = SLUG_RE.exec(slug);
  if (!m) return null;
  const [_, prefix, setKey, cardNumber, parallel, autoFlag, tail] = m;
  if (parallel !== "base") return null;
  if (autoFlag !== "auto") return null;
  const cn = cardNumber.toLowerCase();
  const isBowmanChromeAuto = setKey === "bowman-chrome" && /^cpa(?:-|\d)/.test(cn);
  const isToppsChromeAuto = setKey === "topps-chrome" && /^(?:tcpa|cra)(?:-|\d)/.test(cn);
  if (!isBowmanChromeAuto && !isToppsChromeAuto) return null;
  return `${prefix}:${setKey}:${cardNumber}:refractor:${autoFlag}${tail}`;
}

async function patchWithRetry(sold, r, newSlug, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await sold.item(r.id, r.cardId).patch([
        { op: "set", path: "/hobbyiqCardId", value: newSlug },
        { op: "set", path: "/parallel", value: "Refractor" },
        { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
        { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
        { op: "set", path: "/reslugedReason", value: "CF-CHROME-AUTO-BASE-IS-REFRACTOR" },
      ]);
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code === 429) {
        const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  return false;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}`);

  // Target rows: setKey=bowman-chrome|topps-chrome, cardNumber has
  // CPA-/TCPA-/CRA- prefix, parallel:auto in the slug at :base:auto.
  const query = `
    SELECT c.id, c.cardId, c.hobbyiqCardId
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND (
        CONTAINS(c.hobbyiqCardId, ':bowman-chrome:cpa') OR
        CONTAINS(c.hobbyiqCardId, ':topps-chrome:tcpa') OR
        CONTAINS(c.hobbyiqCardId, ':topps-chrome:cra')
      )
      AND CONTAINS(c.hobbyiqCardId, ':base:auto')
  `;
  const it = sold.items.query({ query }, { maxItemCount: 500 });

  let scanned = 0, touched = 0, failed = 0, skipped = 0;
  const startedAt = Date.now();
  const inflight = [];

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const newSlug = rewriteSlug(r.hobbyiqCardId);
      if (!newSlug || newSlug === r.hobbyiqCardId) { skipped++; continue; }

      if (!APPLY) { touched++; continue; }

      const p = patchWithRetry(sold, r, newSlug)
        .then((ok) => { if (ok) touched++; else failed++; })
        .catch((err) => { console.warn(`fail ${r.id}: ${err.message||err}`); failed++; })
        .finally(() => {
          const idx = inflight.indexOf(p);
          if (idx >= 0) inflight.splice(idx, 1);
        });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

      if ((touched + failed) % 500 === 0 && (touched + failed) > 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  progress: scanned=${scanned} touched=${touched} failed=${failed}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);
  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned} touched=${touched} failed=${failed} skipped=${skipped}`);
}
main().catch(e => { console.error(e); process.exit(1); });
