#!/usr/bin/env node
// CF-RESLUG-CHROME-DRAFT (Drew, 2026-07-29). Backfill for the setKey
// collision fix (PR #930 / hobbyIqCardId.service.ts:93). Prior parser
// misrouted every "Bowman Draft Chrome" row to setKey "bowman-draft"
// (paper bucket) via a broken regex, colliding with real paper Bowman
// Draft rows. PR #930 fixed the routing forward; this script re-slugs
// historical rows that carry the buggy slug.
//
// Detection: row's slug contains ":bowman-draft:" AND at least one of:
//   (a) setName contains "Chrome" (case-insensitive), OR
//   (b) cardNumber starts with a KNOWN CHROME PREFIX (CPA-, BCPA-,
//       BCDA-, BDPA-, BCRA-, TCRA-)
//   (c) title contains "chrome" or "refractor"
//
// Per feedback_slug_recompute_only_improve: ONLY apply when the newly
// computed slug is strictly MORE SPECIFIC than the current one — never
// demote (e.g. Blue Refractor → Base). Chrome-draft → chrome-draft is
// strictly more specific than the buggy chrome-draft-mislabeled-as-paper.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write. Default: dry-run.
//   RESLUG_CONCURRENCY=16     — parallel patches.
//
// Usage:
//   node backend/scripts/reslug-chrome-draft-collision.cjs                     # dry-run
//   RESLUG_APPLY=true node backend/scripts/reslug-chrome-draft-collision.cjs   # apply

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");

const CHROME_CARDNUM_RE = /^(CPA|BCPA|BCDA|BDPA|BCRA|TCRA|BCP)-/i;

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch (e) { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function isChromeDraftRow(r) {
  const setName = String(r.setName || "");
  const cardNumber = String(r.cardNumber || "");
  const title = String(r.title || r.rawTitle || "");
  if (/chrome/i.test(setName)) return "setName-has-chrome";
  if (CHROME_CARDNUM_RE.test(cardNumber)) return "chrome-cardnumber-prefix";
  if (/chrome|refractor/i.test(title)) return "title-has-chrome-or-refractor";
  return null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  // Cast a wide net — every row that carries :bowman-draft: in the slug
  // is a candidate. Then apply the chrome-heuristic locally.
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, ':bowman-draft:')
  `;

  console.log(`[reslug-chrome-draft] scanning sold_comps for :bowman-draft: rows...`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows carry :bowman-draft: in slug\n`);

  const byReason = {};
  const patches = [];
  let alreadyCorrect = 0, notChromeDraft = 0, computeFailed = 0, wouldDemote = 0;

  for (const r of candidates) {
    const reason = isChromeDraftRow(r);
    if (!reason) { notChromeDraft++; continue; }
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    // Recompute with the fixed normalizer. Pass setName="Bowman Draft
    // Chrome" so the new regex catches it. Do NOT re-derive setName from
    // the current row — it may itself be mislabeled ("Bowman Draft" for
    // rows that are actually chrome).
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: "Bowman Draft Chrome",     // canonical for chrome-draft
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { alreadyCorrect++; continue; }

    // Sanity guardrail (only-improve): new slug MUST contain
    // ":bowman-chrome-draft:" and MUST differ from the current slug.
    if (!newSlug.includes(":bowman-chrome-draft:")) { wouldDemote++; continue; }

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      reason,
      cardNumber: r.cardNumber,
    });
  }

  console.log(`Candidates by chrome-signal:`);
  Object.entries(byReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`Not chrome-draft:            ${notChromeDraft}`);
  console.log(`Already-correct or no-op:    ${alreadyCorrect}`);
  console.log(`Compute failed:              ${computeFailed}`);
  console.log(`Would-demote (skipped):      ${wouldDemote}`);
  console.log(`Ready to re-slug:            ${patches.length}\n`);

  if (patches.length === 0) return;

  console.log("Sample 20 patches (old → new):");
  patches.slice(0, 20).forEach(p =>
    console.log(`  [${p.reason}] ${p.cardNumber}\n    ${p.oldSlug}\n    ${p.newSlug}`)
  );

  if (!APPLY) {
    console.log("\n*** DRY-RUN COMPLETE. Set RESLUG_APPLY=true to write. ***");
    return;
  }

  console.log(`\nApplying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
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
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
