// CF-RESLUG-SETNAME-VERBATIM (Drew, 2026-08-10). Fix sold_comps rows
// whose setKey segment is a TCA/vendor setName leaked verbatim
// (year-prefixed shape like "1990-score-baseball") instead of the
// canonical short form ("score").
//
// Safe class: this script ONLY touches rows where the setKey segment
// in the slug starts with a 4-digit year — that's the unambiguous
// vendor-raw signal. Then runs the setKey through the generator's
// normalizeSetKey. Rewrites only when:
//   1. Sport stays the same (no cross-sport migration)
//   2. Sport is non-empty in the new slug (guard against sport-missing
//      rows producing hiq::YYYY:… — see 2011 Trout Heritage MiLB
//      regression discovered 2026-08-10)
//   3. Year, cardNumber, parallel, isAuto, printRun all stay identical
//   4. New setKey is a KNOWN canonical (matched a controlled-vocab
//      regex, not slugify fallback). Verified by ensuring the new
//      setKey doesn't equal the raw slugify of the input (only-improve
//      rule from feedback_slug_recompute_only_improve.md).
//
// Env: APPLY=true to write; default dry-run.

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const MAX_ROWS = Number(process.env.MAX_ROWS || 0);

const distPath = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
if (!fs.existsSync(distPath)) { console.error(`missing dist — run tsc`); process.exit(2); }
const { computeHobbyIqCardId, slugify } = require(distPath);

// Match sold_comps slug: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
const SLUG_RE = /^hiq:([^:]+):(\d+):([^:]+):([^:]+):([^:]+):([^:]+)((?::num-\d+)?)$/;

function extractParts(slug) {
  const m = SLUG_RE.exec(slug);
  if (!m) return null;
  return {
    sport: m[1],
    year: Number(m[2]),
    setKey: m[3],
    cardNumber: m[4],
    parallel: m[5],
    autoFlag: m[6],
    tail: m[7],
  };
}

async function patchWithRetry(sold, r, newSlug, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await sold.item(r.id, r.cardId).patch([
        { op: "set", path: "/hobbyiqCardId", value: newSlug },
        { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
        { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
        { op: "set", path: "/reslugedReason", value: "CF-RESLUG-SETNAME-VERBATIM" },
      ]);
      return true;
    } catch (err) {
      if (err && err.code === 429) {
        const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
        await new Promise(r => setTimeout(r, wait));
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
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  cap=${MAX_ROWS || "∞"}`);

  // Target: slugs whose setKey segment starts with a 4-digit year (the
  // vendor-raw-verbatim signal). Cosmos SQL doesn't have easy substring
  // regex, so match on the slug shape:
  //   hiq:<sport>:YYYY:<YYYY>-... (slugify of "2018 Bowman Baseball" produces "2018-bowman-baseball")
  // The double-YYYY pattern is the identifying shape.
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setName, c.setKey, c.cardNumber, c.parallel, c.isAuto, c.printRun
             FROM c
             WHERE IS_STRING(c.hobbyiqCardId)
               AND IS_STRING(c.setName)`;
  const it = sold.items.query({ query: q }, { maxItemCount: 500 });

  async function fetchNextWithRetry(tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { return await it.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("fetchNext retries exhausted");
  }

  let scanned = 0, matched = 0, touched = 0, failed = 0, skippedGuard = 0;
  const startedAt = Date.now();
  const inflight = [];
  const rewriteCounts = new Map();

  while (it.hasMoreResults()) {
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
    const { resources } = await fetchNextWithRetry();
    for (const r of resources) {
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
      scanned++;

      const parts = extractParts(r.hobbyiqCardId);
      if (!parts) continue;
      // Filter: only target setKey segments starting with YYYY-
      if (!/^\d{4}-/.test(parts.setKey)) continue;
      matched++;

      // Compute new slug via generator
      let newSlug;
      try {
        newSlug = computeHobbyIqCardId({
          sport: r.sport,
          year: Number(r.cardYear),
          setKey: r.setName,   // use setName (the raw vendor input)
          cardNumber: String(r.cardNumber),
          parallel: r.parallel ?? "Base",
          isAuto: Boolean(r.isAuto),
          printRun: r.printRun ?? null,
        });
      } catch { skippedGuard++; continue; }

      // Guard 1: no change
      if (newSlug === r.hobbyiqCardId) { skippedGuard++; continue; }

      const newParts = extractParts(newSlug);
      if (!newParts) { skippedGuard++; continue; }

      // Guard 2: sport must be non-empty and unchanged
      if (!newParts.sport || newParts.sport === "") { skippedGuard++; continue; }
      if (newParts.sport !== parts.sport) { skippedGuard++; continue; }

      // Guard 3: year, cardNumber, parallel, isAuto, printRun tail unchanged
      if (newParts.year !== parts.year) { skippedGuard++; continue; }
      if (newParts.cardNumber !== parts.cardNumber) { skippedGuard++; continue; }
      if (newParts.parallel !== parts.parallel) { skippedGuard++; continue; }
      if (newParts.autoFlag !== parts.autoFlag) { skippedGuard++; continue; }
      if (newParts.tail !== parts.tail) { skippedGuard++; continue; }

      // Guard 4: new setKey must be a KNOWN canonical (matched
      // controlled-vocab), not slugify fallback. Verify by checking:
      // slugify(setName) should NOT equal newParts.setKey — if it does,
      // no rule matched and we'd just be moving to another verbatim key.
      const raw = slugify(String(r.setName || ""));
      if (raw === newParts.setKey) { skippedGuard++; continue; }
      // Guard 5: new setKey should be SHORTER (more canonical) than old,
      // OR at least not equal to a bare-year form (which would defeat
      // the point).
      if (/^\d{4}-/.test(newParts.setKey)) { skippedGuard++; continue; }

      const bucket = `${parts.setKey}→${newParts.setKey}`;
      rewriteCounts.set(bucket, (rewriteCounts.get(bucket)||0)+1);

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

      if (touched > 0 && touched % 1000 === 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  scanned=${scanned} matched=${matched} touched=${touched} failed=${failed} skipped=${skippedGuard}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned} matched=${matched} touched=${touched} failed=${failed} skipped-guard=${skippedGuard}`);
  console.log("\ntop collapse patterns:");
  const top = [...rewriteCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 40);
  for (const [k, v] of top) console.log(`  ${v.toString().padStart(5)}  ${k}`);
}
main().catch(e => { console.error(e); process.exit(1); });
