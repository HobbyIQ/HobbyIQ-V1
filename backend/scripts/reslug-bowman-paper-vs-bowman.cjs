#!/usr/bin/env node
// CF-RESLUG-BOWMAN-PAPER (Drew, 2026-07-29). Backfill for PR #934
// (Bowman Paper setKey). Existing sold_comps rows carrying ":bowman:"
// slug where the cardNumber is BPA-XX (paper prospect auto) or BDA-XX
// (paper draft auto) or the title carries "Paper Prospect" / "Paper
// Auto" tokens need to migrate to ":bowman-paper:" (or "bowman-draft-
// paper" for BDA) so paper-auto FMV pools stop blending with paper-base.
//
// Detection: row's slug contains ":bowman:" (exact bowman, not
// bowman-chrome / bowman-draft / etc — the regex :bowman: has anchoring
// colons that only match exact bowman) AND at least one of:
//   (a) cardNumber prefix in {BPA-, BDA-} — the auto card# prefix
//   (b) title contains "Paper Prospect" / "Paper Auto" / "Paper Autograph"
//   (c) title contains "1st Paper"
//
// Detection also decides which target setKey to use:
//   - BDA-XX or "Draft Paper" in title → "Bowman Draft Paper"
//   - Otherwise → "Bowman Paper"
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");

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

function detectPaperTarget(r) {
  const cn = String(r.cardNumber || "").toUpperCase();
  const title = String(r.title || r.rawTitle || "");
  const setName = String(r.setName || "");

  if (/^BDA-/.test(cn)) return { target: "Bowman Draft Paper", reason: "BDA-cardnum" };
  if (/^BPA-/.test(cn)) return { target: "Bowman Paper", reason: "BPA-cardnum" };
  if (/paper\s+prospect|paper\s+auto|paper\s+autograph|1st\s+paper/i.test(title)) {
    if (/draft/i.test(title) || /draft/i.test(setName)) {
      return { target: "Bowman Draft Paper", reason: "title-paper-draft" };
    }
    return { target: "Bowman Paper", reason: "title-paper" };
  }
  return null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  // Narrow the query to rows that ALREADY carry a paper signal, so we
  // don't load hundreds of thousands of legit-bowman rows into memory.
  // Filters upfront: exact ":bowman:" slug AND at least one paper hint
  // (BPA-/BDA- cardNumber OR title contains "paper").
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, ':bowman:')
      AND (
        STARTSWITH(UPPER(c.cardNumber), "BPA-") OR
        STARTSWITH(UPPER(c.cardNumber), "BDA-") OR
        CONTAINS(LOWER(c.title), 'paper') OR
        CONTAINS(LOWER(c.rawTitle), 'paper')
      )
  `;

  console.log(`[reslug-bowman-paper] scanning sold_comps for exact :bowman: slugs...`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows CONTAIN :bowman: (filtering to exact next)\n`);

  // Exact ":bowman:" — must have exactly bowman between the colons.
  // The Cosmos CONTAINS matched :bowman: substring, but :bowman-paper:
  // also contains :bowman... wait no it doesn't. :bowman-paper: has :b
  // then bowman-paper: — the substring :bowman: (with trailing colon)
  // only appears when setKey is exactly 'bowman'. So the query already
  // returned only exact bowman slugs. Confirming:
  const exactBowman = candidates.filter(r =>
    /:bowman:/.test(String(r.hobbyiqCardId ?? ""))
  );
  console.log(`  ${exactBowman.length} rows have setKey EXACTLY "bowman"\n`);

  const byReason = {};
  const patches = [];
  let notPaper = 0, alreadyCorrect = 0, computeFailed = 0, wouldDemote = 0;
  const byTarget = { "Bowman Paper": 0, "Bowman Draft Paper": 0 };

  for (const r of exactBowman) {
    const det = detectPaperTarget(r);
    if (!det) { notPaper++; continue; }
    byReason[det.reason] = (byReason[det.reason] ?? 0) + 1;

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: det.target,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { alreadyCorrect++; continue; }

    // Only-improve: must contain the target setKey
    const expectedSlugFragment = det.target === "Bowman Draft Paper" ? ":bowman-draft-paper:" : ":bowman-paper:";
    if (!newSlug.includes(expectedSlugFragment)) { wouldDemote++; continue; }

    byTarget[det.target]++;
    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      reason: det.reason,
      cardNumber: r.cardNumber,
    });
  }

  console.log(`Candidates by paper-signal:`);
  Object.entries(byReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`Target distribution:`);
  Object.entries(byTarget).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`Not paper:                   ${notPaper}`);
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
