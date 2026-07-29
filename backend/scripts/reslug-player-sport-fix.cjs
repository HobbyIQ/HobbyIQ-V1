#!/usr/bin/env node
// CF-RESLUG-PLAYER-SPORT-FIX (Drew, 2026-07-29). Recover sport for
// rows whose title carries no team-name, no league keyword, no
// sport-obvious product line — only the player name. The player→sport
// lookup was added to inferSportFromTitle in this same PR.
//
// Example: Justin Herbert 2020 Panini Prizm rows landed at
// sport=baseball because the title says neither "football" nor
// "NFL" nor "Chargers" — but "Justin Herbert" is unambiguous.
//
// Scan strategy: iterate ONCE over each mis-sport partition and re-run
// inferSportFromTitle. If the newly-inferred sport differs from the
// current sport, patch /sport AND recompute /hobbyiqCardId (the slug
// carries sport in slot 1: hiq:{sport}:...).
//
// Guardrails:
//   - Only patch when inferSportFromTitle returns a DIFFERENT sport
//     than what's stored. (No-op if unchanged.)
//   - Only patch when the new sport comes from a player-name hint
//     (not from league keywords the parser has always caught — those
//     rows would already be correct). We enforce this by first
//     running inferSportFromTitle with fallback=CURRENT sport (returns
//     current when nothing changes) and separately calling
//     inferSportFromPlayer to confirm the player table drove it.
//   - Slug must recompute cleanly (safe-guardrail on computeHobbyIqCardId).
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches
//   RESLUG_SPORT=<sport>      — limit scan to rows CURRENTLY tagged
//                                as this sport (default: baseball, since
//                                that's the historical fallback)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
  inferSportFromPlayer,
} = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");
const CURRENT_SPORT = (process.env.RESLUG_SPORT || "baseball").toLowerCase();

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

  console.log(`[reslug-player-sport-fix]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  scanning rows currently tagged sport="${CURRENT_SPORT}"`);

  // Only scan rows with a title AND currently tagged as CURRENT_SPORT.
  // Player-name lookup is our new pass, so any row mis-classified into
  // baseball is a candidate.
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE c.sport = "${CURRENT_SPORT}"
      AND (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
  `;

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanning ${candidates.length}`);
  }
  console.log(`\r  ${candidates.length} rows tagged sport="${CURRENT_SPORT}"                `);

  const patches = [];
  const distributionByNewSport = {};
  const distributionByPlayer = {};
  let noTitle = 0, parseError = 0, sameSport = 0, computeFailed = 0, noImprovement = 0;

  for (const r of candidates) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) { noTitle++; continue; }

    // Fast filter: only proceed if the player table triggers.
    let playerSport;
    try {
      playerSport = inferSportFromPlayer(title);
    } catch { parseError++; continue; }
    if (!playerSport || playerSport === CURRENT_SPORT) { sameSport++; continue; }

    // Second pass: full inferSportFromTitle to ensure keyword/team
    // signals (which run BEFORE player) agree.
    const inferredSport = inferSportFromTitle(title, CURRENT_SPORT);
    if (inferredSport === CURRENT_SPORT) { sameSport++; continue; }
    if (inferredSport !== playerSport) {
      // Something upstream (team hint, league keyword) disagreed with
      // the player table. Trust the earlier pass — but this is a
      // player-sport script, so skip.
      continue;
    }

    // Recompute slug with the new sport.
    let parsedTitle, titleSet;
    try {
      parsedTitle = parseListingIdentity(title);
      titleSet = inferSetKeyFromTitle(title, parsedTitle.cardNumber ?? null);
    } catch { parseError++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: inferredSport,
        year: Number(r.cardYear),
        setKey: titleSet,
        cardNumber: parsedTitle.cardNumber || r.cardNumber || "",
        parallel: parsedTitle.parallel || r.parallel || "Base",
        isAuto: parsedTitle.isAuto ?? r.isAuto ?? false,
        printRun: parsedTitle.printRun ?? r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) {
      // Slug didn't change (which is odd since sport is in slot 1).
      // Guardrail catches degenerate cases.
      noImprovement++;
      continue;
    }
    // Verify slug carries the new sport in slot 1.
    if (!newSlug.startsWith(`hiq:${inferredSport}:`)) {
      noImprovement++;
      continue;
    }

    distributionByNewSport[inferredSport] = (distributionByNewSport[inferredSport] ?? 0) + 1;
    // Track player hint that drove this (approximate — take player-sport match)
    const matched = title.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
    if (matched) {
      const key = matched[1].toLowerCase();
      distributionByPlayer[key] = (distributionByPlayer[key] ?? 0) + 1;
    }
    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      oldSport: CURRENT_SPORT,
      newSport: inferredSport,
    });
  }

  console.log(`\n  No title:                ${noTitle}`);
  console.log(`  Parse error:             ${parseError}`);
  console.log(`  Compute failed:          ${computeFailed}`);
  console.log(`  Same sport (no change):  ${sameSport}`);
  console.log(`  No improvement:          ${noImprovement}`);
  console.log(`  Ready sport-fix:         ${patches.length}\n`);

  console.log(`  Distribution by new sport:`);
  Object.entries(distributionByNewSport)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${k.padEnd(12)} ${v}`));

  console.log(`\n  Top 20 player hints observed:`);
  Object.entries(distributionByPlayer)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([k, v]) => console.log(`    ${k.padEnd(30)} ${v}`));

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
      { op: "set", path: "/sport", value: p.newSport },
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
