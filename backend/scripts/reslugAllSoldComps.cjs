// CF-RESLUG-ALL-SOLD-COMPS (Drew, 2026-08-10). Bring every sold_comps
// row's hobbyiqCardId in line with the current slug generator.
//
// Motivation: the slug generator is the doctrine. Any row whose stored
// slug doesn't equal what computeHobbyIqCardId() would produce today is
// wrong by definition. Drew: "we need them to be correct and match" —
// this closes the loop for every historical row across every rule
// (chrome-prefix override, base-is-refractor, subset collapse,
// parallel canonicalization, etc.).
//
// Strategy:
//   - Walk every sold_comps row with the fields the generator needs
//   - Recompute canonical slug via the compiled dist generator
//   - PATCH hobbyiqCardId when it differs
//   - Skip rows where inputs are insufficient (missing sport/year/#/...)
//   - Log every distinct rewrite pattern for audit
//   - 429-safe with retry
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   APPLY=true                   write (default dry-run)
//   CONCURRENCY=16               parallel patches
//   MAX_ROWS                     cap for smoke tests
//   SHARD_HEX="0,1,2,3"          contentHash first-char shard filter
//                                (16 shards; run 4 workers with disjoint sets)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const MAX_ROWS = Number(process.env.MAX_ROWS || 0);
const SHARD_HEX = (process.env.SHARD_HEX || "").split(",").map(s => s.trim()).filter(Boolean);

const distPath = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
if (!fs.existsSync(distPath)) { console.error(`missing dist at ${distPath} — run \`npx tsc\``); process.exit(2); }
const { computeHobbyIqCardId } = require(distPath);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  cap=${MAX_ROWS || "∞"}  shards=${SHARD_HEX.join(",") || "all"}`);

  const where = ["IS_STRING(c.hobbyiqCardId)", "IS_DEFINED(c.cardYear)", "IS_DEFINED(c.cardNumber)", "IS_DEFINED(c.sport)"];
  const params = [];
  if (SHARD_HEX.length > 0) {
    const inList = SHARD_HEX.map((_, i) => `@s${i}`).join(",");
    where.push(`SUBSTRING(c.contentHash, 0, 1) IN (${inList})`);
    for (let i = 0; i < SHARD_HEX.length; i++) params.push({ name: `@s${i}`, value: SHARD_HEX[i] });
  }
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setKey, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun
             FROM c WHERE ${where.join(" AND ")}`;
  const it = sold.items.query({ query: q, parameters: params }, { maxItemCount: 500 });

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

  async function patchWithRetry(r, newSlug, tries = 3) {
    // CF-RESLUG-ALSO-PARALLELSLUG (Drew, 2026-08-11). Extract the
    // parallel component from the new slug so downstream aggregators
    // (extract-cross-parallel-ratios, catalog matchers) that group by
    // parallelSlug see the canonical value. Slug layout:
    //   hiq:sport:year:setKey:cardNumber:parallelSlug:autoFlag[:printRunPart]
    //   0   1     2    3      4          5             6         7
    const parts = String(newSlug).split(":");
    const newParallelSlug = parts.length >= 6 ? parts[5] : null;

    for (let i = 0; i < tries; i++) {
      try {
        const ops = [
          { op: "set", path: "/hobbyiqCardId", value: newSlug },
          { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
          { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
          { op: "set", path: "/reslugedReason", value: "CF-RESLUG-ALL-SOLD-COMPS" },
        ];
        if (newParallelSlug) ops.push({ op: "set", path: "/parallelSlug", value: newParallelSlug });
        await sold.item(r.id, r.cardId).patch(ops);
        return true;
      } catch (err) {
        const code = err && err.code;
        if (code === 429) {
          const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  let scanned = 0, computed = 0, changed = 0, touched = 0, failed = 0, skipped = 0, demoted = 0;
  const startedAt = Date.now();
  const inflight = [];
  const rewriteCounts = new Map();
  const demoteCounts = new Map();

  while (it.hasMoreResults()) {
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
    const { resources } = await fetchNextWithRetry();
    for (const r of resources) {
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
      scanned++;
      // Skip when we can't build inputs (setKey OR setName required)
      const inputSetKey = r.setKey || r.setName;
      if (!inputSetKey) { skipped++; continue; }
      let newSlug;
      try {
        newSlug = computeHobbyIqCardId({
          sport: r.sport,
          year: Number(r.cardYear),
          setKey: inputSetKey,
          cardNumber: String(r.cardNumber),
          parallel: r.parallel ?? "Base",
          isAuto: Boolean(r.isAuto),
          printRun: r.printRun ?? null,
        });
      } catch (err) { skipped++; continue; }
      computed++;
      if (newSlug === r.hobbyiqCardId) { skipped++; continue; }

      // CF-RESLUG-NO-DEMOTE (Drew, 2026-08-12). Memory rule: re-canonicalize
      // only when the new slug is strictly MORE specific — never demote.
      // The 2026-08-12 dry-run surfaced rewrites like
      //   topps-chrome-sapphire -> topps
      // which throw away product specificity we already had. That happens
      // when the row's stored setKey is richer than what the generator can
      // recover from its setName input, so "recompute" would lose information.
      //
      // A demotion is when the stored setKey is a DESCENDANT of the new one
      // (stored starts with new + "-"): topps-chrome-sapphire vs topps,
      // bowman-chrome vs bowman. Lateral moves between different families
      // are left alone — those are real reclassifications, not information loss.
      const oldSet = String(r.hobbyiqCardId).split(":")[3] || "";
      const newSet = newSlug.split(":")[3] || "";
      if (oldSet && newSet && oldSet !== newSet && oldSet.startsWith(newSet + "-")) {
        demoted++;
        demoteCounts.set(`${oldSet}→${newSet}`, (demoteCounts.get(`${oldSet}→${newSet}`) || 0) + 1);
        skipped++;
        continue;
      }

      changed++;
      // Audit: bucket by (fromFamily, toFamily) style so we can see
      // what's actually shifting.
      const fromFam = (r.hobbyiqCardId.split(":")[3] || "?") + "→" + (newSlug.split(":")[3] || "?");
      rewriteCounts.set(fromFam, (rewriteCounts.get(fromFam)||0) + 1);

      if (!APPLY) { touched++; continue; }

      const p = patchWithRetry(r, newSlug)
        .then((ok) => { if (ok) touched++; else failed++; })
        .catch((err) => { console.warn(`fail ${r.id}: ${err.message||err}`); failed++; })
        .finally(() => {
          const idx = inflight.indexOf(p);
          if (idx >= 0) inflight.splice(idx, 1);
        });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

      if (changed % 1000 === 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  scanned=${scanned} changed=${changed} touched=${touched} failed=${failed}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned} computed=${computed} changed=${changed} touched=${touched} failed=${failed} skipped=${skipped} demoted-skipped=${demoted}`);
  if (demoted) {
    console.log(`\n  SKIPPED as demotions (only-improve rule):`);
    for (const [k, n] of [...demoteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${k}: ${n}`);
    }
  }
  console.log("\ntop rewrite patterns:");
  const top = [...rewriteCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30);
  for (const [k, v] of top) console.log(`  ${k}: ${v}`);
}
main().catch(e => { console.error(e); process.exit(1); });
