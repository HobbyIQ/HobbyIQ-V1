#!/usr/bin/env node
// CF-RESLUG-CHROME-PROSPECTS-AND-WAVE (Drew, 2026-07-29). Two-fer:
//
//   1) chrome-prospects setKey → bowman-chrome. CH tags the BCP/CPA
//      subset with setName="Chrome Prospects" (or "Chrome Prospects
//      Autographs"), which slugifies to `chrome-prospects` and
//      fragments the FMV pool. All such rows are actually Bowman
//      Chrome subsets — unify to bowman-chrome. Newly-added rule in
//      normalizeSetKey handles all future ingests; this backfill
//      repairs the accumulated rows.
//
//   2) Wave Refractor recovery. Bare "Wave Refractor" (no color
//      modifier) was falling through to bare "Refractor" until this
//      PR added the fallback rule. Recover rows where title says
//      "wave refractor" but stored parallel is a superset (Base,
//      Refractor).
//
// Guardrails:
//   - chrome-prospects → bowman-chrome: strict re-slug via the current
//     compute; sport/year/cardNumber/parallel/isAuto preserved.
//   - Wave recovery: color-preservation (blue-refractor →
//     blue-wave-refractor OK, blue-refractor → wave-refractor NOT OK).
//   - isAuto: OR old + new so a known auto never gets demoted.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity, inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");
const COLORS = ["blue","red","green","gold","orange","purple","yellow","aqua","pink","black","silver"];

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

// ─── Pass 1: chrome-prospects setKey → bowman-chrome ──────────────────
async function chromeProspectsPass(sc) {
  console.log(`\n══ Pass 1: chrome-prospects → bowman-chrome ══`);
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, ":chrome-prospects:")
  `;
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\n  ${rows.length} rows with :chrome-prospects: in slug`);

  const patches = [];
  let noChange = 0, computeFailed = 0;
  const parallelDist = {};

  for (const r of rows) {
    // Guardrail: only touch rows where setKey slot IS exactly chrome-prospects
    const parts = String(r.hobbyiqCardId ?? "").split(":");
    if (parts[3] !== "chrome-prospects") continue;

    let newSlug;
    try {
      // Just re-run through computeHobbyIqCardId with "Chrome Prospects" as
      // setName so the new normalizeSetKey rule maps it to bowman-chrome.
      // Preserve everything else.
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey: "Chrome Prospects",
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { noChange++; continue; }
    if (!newSlug.includes(":bowman-chrome:")) { noChange++; continue; }

    parallelDist[parts[5]] = (parallelDist[parts[5]] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  Compute failed:  ${computeFailed}`);
  console.log(`  No change:       ${noChange}`);
  console.log(`  Ready patches:   ${patches.length}`);
  console.log(`\n  Old parallel distribution (top 10):`);
  Object.entries(parallelDist).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .forEach(([k,v]) => console.log(`    ${k.padEnd(28)} ${v}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
  }

  if (!APPLY || patches.length === 0) return { pass: "chrome-prospects", applied: 0, errors: 0, ready: patches.length };

  console.log(`\n  Applying ${patches.length} patches...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { pass: "chrome-prospects", applied: result.ok, errors: result.err, ready: patches.length };
}

// ─── Pass 2: wave-refractor recovery ──────────────────────────────────
async function waveRefractorPass(sc) {
  console.log(`\n══ Pass 2: wave-refractor recovery ══`);
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
      AND (CONTAINS(LOWER(c.title), "wave refractor") OR CONTAINS(LOWER(c.rawTitle), "wave refractor"))
  `;
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\n  ${rows.length} rows with 'wave refractor' in title`);

  const patches = [];
  let noChange = 0, parseError = 0, colorLost = 0, notWave = 0;
  const parallelDist = {};

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) continue;

    let parsedTitle;
    try {
      parsedTitle = parseListingIdentity(title);
    } catch { parseError++; continue; }

    // Only touch parallel in this pass. setKey unification is chrome-
    // prospects pass's job. Surgical slug rewrite: keep every other
    // slug slot, replace only parallelSlug (slot 5).
    const oldParts = String(r.hobbyiqCardId ?? "").split(":");
    if (oldParts.length < 7) continue;
    const newParallel = parsedTitle.parallel || "Base";
    // Only accept "wave" outputs (this is a Wave recovery).
    if (!/wave/i.test(newParallel)) { notWave++; continue; }
    // Slugify parallel the same way computeHobbyIqCardId does.
    const newParallelSlug = String(newParallel).toLowerCase()
      .replace(/[^\w\s-]/g, "").replace(/_/g, "-")
      .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!newParallelSlug || newParallelSlug === oldParts[5]) { noChange++; continue; }
    // Color preservation: if old parallel starts with a color, new must too.
    const oldColor = COLORS.find(c => oldParts[5].startsWith(`${c}-`));
    if (oldColor && !newParallelSlug.startsWith(`${oldColor}-`)) { colorLost++; continue; }
    // Refuse to downgrade: if old parallel already contains "wave" and
    // new doesn't ADD specificity, skip.
    if (oldParts[5].includes("wave") && !newParallelSlug.includes("wave")) { noChange++; continue; }

    const newParts = oldParts.slice();
    newParts[5] = newParallelSlug;
    const newSlug = newParts.join(":");

    parallelDist[newParallelSlug] = (parallelDist[newParallelSlug] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  Parse error:     ${parseError}`);
  console.log(`  Not wave:        ${notWave}`);
  console.log(`  No change:       ${noChange}`);
  console.log(`  Color lost:      ${colorLost}`);
  console.log(`  Ready patches:   ${patches.length}`);
  console.log(`\n  New parallel distribution:`);
  Object.entries(parallelDist).sort((a,b)=>b[1]-a[1]).slice(0,12)
    .forEach(([k,v]) => console.log(`    ${k.padEnd(28)} ${v}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
  }

  if (!APPLY || patches.length === 0) return { pass: "wave-refractor", applied: 0, errors: 0, ready: patches.length };

  console.log(`\n  Applying ${patches.length} patches...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { pass: "wave-refractor", applied: result.ok, errors: result.err, ready: patches.length };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-chrome-prospects-and-wave]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const s1 = await chromeProspectsPass(sc);
  const s2 = await waveRefractorPass(sc);

  console.log(`\n════════════════ GRAND SUMMARY ════════════════`);
  console.log(`  chrome-prospects: ready=${s1.ready} applied=${s1.applied} errors=${s1.errors}`);
  console.log(`  wave-refractor:   ready=${s2.ready} applied=${s2.applied} errors=${s2.errors}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set RESLUG_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
