#!/usr/bin/env node
// CF-RESLUG-SPECKLE-RECOVERY (Drew, 2026-07-29). Two-fer backfill for
// PR-in-flight (Speckle Refractor parser + chrome-implied setKey rule):
//
//   1) Rows where title mentions "speckle" but parallel landed as
//      "Base" (parser had no rule) — recover the proper Speckle
//      Refractor parallel.
//
//   2) Rows where title mentions a Chrome-exclusive parallel (Speckle,
//      Shimmer, Lava, Wave, Grass, X-Fractor, Mojo, Prism, Mini
//      Diamond, bare Refractor) but setKey is bare "bowman" (parser
//      fell through to the generic Bowman default when "Chrome" wasn't
//      explicitly in the title) — upgrade to bowman-chrome.
//
// Guardrails:
//   - Only patch when the re-computed slug differs and is a STRICT
//     improvement (parallel gains specificity OR setKey extends
//     bowman → bowman-chrome).
//   - Never demote: existing bowman-chrome / bowman-draft-chrome rows
//     are unaffected; existing colored refractor parallels don't
//     downgrade.
//   - No sport change; scope stays baseball-only for this pass.
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

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-speckle-recovery]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // Narrow the query: rows whose title mentions "speckle" OR whose
  // parallel is "base"/"refractor" with title carrying chrome-only
  // parallels + "bowman" setKey. Cosmos LOWER + CONTAINS keeps it
  // scannable. We still hydrate all fields so parser can re-derive.
  const query = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
      AND (
        CONTAINS(LOWER(c.title), "speckle")
        OR CONTAINS(LOWER(c.rawTitle), "speckle")
      )
  `;

  const it = sc.items.query({ query }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanning ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows with 'speckle' in title\n`);

  const patches = [];
  const distribution = { parallelOnly: 0, setKeyOnly: 0, both: 0 };
  const parallelDist = {};
  const setKeyBefore = {};
  const setKeyAfter = {};
  let noChange = 0, parseError = 0, computeFailed = 0;

  for (const r of candidates) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) continue;

    let parsedTitle, titleSet;
    try {
      parsedTitle = parseListingIdentity(title);
      titleSet = inferSetKeyFromTitle(title, parsedTitle.cardNumber ?? null);
    } catch { parseError++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey: titleSet,
        cardNumber: parsedTitle.cardNumber || r.cardNumber || "",
        parallel: parsedTitle.parallel || r.parallel || "Base",
        // Preserve auto status: if EITHER the current row OR the parsed
        // title says auto, treat as auto. Prevents this backfill from
        // demoting a known-auto row when the title text doesn't include
        // "auto" explicitly (some CPA-prefixed rows have terse titles).
        isAuto: (parsedTitle.isAuto === true) || (r.isAuto === true),
        // Same idea for printRun: prefer whichever is defined.
        printRun: parsedTitle.printRun ?? r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { noChange++; continue; }

    // Classify what changed.
    const oldParts = String(r.hobbyiqCardId ?? "").split(":");
    const newParts = newSlug.split(":");
    const parallelChanged = oldParts[5] !== newParts[5];
    const setKeyChanged = oldParts[3] !== newParts[3];

    // Only-improve guardrail: new parallel must include "speckle" if we
    // claim the parallel improved. New setKey must extend the old (or
    // be bowman-chrome vs bowman).
    //
    // COLOR PRESERVATION: if old parallel carries a color modifier
    // (blue/red/green/etc), new parallel MUST retain the SAME color.
    // Rejects "blue-refractor" → "speckle-refractor" (loses "blue")
    // as an ambiguous rewrite; accepts "blue-refractor" →
    // "blue-speckle-refractor" (strict improvement, keeps blue).
    if (parallelChanged) {
      if (!newParts[5].includes("speckle")) continue;
      const COLORS = ["blue","red","green","gold","orange","purple","yellow","aqua","pink","black","silver"];
      const oldColor = COLORS.find(c => oldParts[5].startsWith(`${c}-`));
      if (oldColor && !newParts[5].startsWith(`${oldColor}-`)) continue;
    }
    if (setKeyChanged) {
      // Accept only bowman → bowman-chrome (or bowman-draft → bowman-draft-chrome).
      if (!(oldParts[3] === "bowman" && newParts[3] === "bowman-chrome") &&
          !(oldParts[3] === "bowman-draft" && newParts[3] === "bowman-draft-chrome")) {
        continue;
      }
    }

    if (parallelChanged && setKeyChanged) distribution.both++;
    else if (parallelChanged) distribution.parallelOnly++;
    else if (setKeyChanged) distribution.setKeyOnly++;

    parallelDist[newParts[5]] = (parallelDist[newParts[5]] ?? 0) + 1;
    if (setKeyChanged) {
      setKeyBefore[oldParts[3]] = (setKeyBefore[oldParts[3]] ?? 0) + 1;
      setKeyAfter[newParts[3]] = (setKeyAfter[newParts[3]] ?? 0) + 1;
    }

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
    });
  }

  console.log(`  Parse error:              ${parseError}`);
  console.log(`  Compute failed:           ${computeFailed}`);
  console.log(`  No change:                ${noChange}`);
  console.log(`  Ready patches:            ${patches.length}\n`);
  console.log(`  Change type:`);
  console.log(`    parallel only:  ${distribution.parallelOnly}`);
  console.log(`    setKey only:    ${distribution.setKeyOnly}`);
  console.log(`    both:           ${distribution.both}`);
  console.log(`\n  New parallel distribution:`);
  Object.entries(parallelDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`    ${k.padEnd(32)} ${v}`));
  if (distribution.setKeyOnly || distribution.both) {
    console.log(`\n  setKey migration:`);
    console.log(`    before:`);
    Object.entries(setKeyBefore).forEach(([k, v]) => console.log(`      ${k.padEnd(20)} ${v}`));
    console.log(`    after:`);
    Object.entries(setKeyAfter).forEach(([k, v]) => console.log(`      ${k.padEnd(20)} ${v}`));
  }

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0, 5).forEach(p =>
      console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`)
    );
  }

  if (!APPLY || patches.length === 0) {
    if (!APPLY) console.log(`\n*** DRY-RUN. Set RESLUG_APPLY=true to write. ***`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
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
}

main().catch(e => { console.error(e); process.exit(1); });
