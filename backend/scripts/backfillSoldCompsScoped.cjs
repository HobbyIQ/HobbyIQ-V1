// CF-BACKFILL-SCOPED (Drew, 2026-08-08). Narrow-scope re-clean for a
// specific card family. Validates the pattern before running the full
// pool backfill. Default scope: Ohtani US285 2018 (1656 rows across
// 7 fragmented slug buckets → all should collapse to the canonical
// hiq:baseball:2018:topps-update:us285:<parallel>:no-auto slug once
// playerName is normalized).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do writes (else dry-run)
//   SCOPE_YEAR                 default 2018
//   SCOPE_NUMBER               default "US285"
//   SCOPE_PLAYER_CONTAINS      default "ohtani"

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const APPLY = process.env.APPLY === "true";
const SCOPE_YEAR = Number(process.env.SCOPE_YEAR || 2018);
const SCOPE_NUMBER = (process.env.SCOPE_NUMBER || "US285").toUpperCase();
const SCOPE_PLAYER = (process.env.SCOPE_PLAYER_CONTAINS || "ohtani").toLowerCase();

function loadHelpers() {
  const normP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "holdingFieldNormalizer.service.js");
  const slugP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  return {
    normalizeHoldingFields: require(normP).normalizeHoldingFields,
    computeHobbyIqCardId: require(slugP).computeHobbyIqCardId,
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");
  const { normalizeHoldingFields, computeHobbyIqCardId } = loadHelpers();

  console.log(`[scoped-backfill] apply=${APPLY}  scope: year=${SCOPE_YEAR} cardNumber=${SCOPE_NUMBER} player~=${SCOPE_PLAYER}`);

  const { resources } = await sc.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport
            FROM c
            WHERE c.cardYear = @y AND c.cardNumber = @n AND CONTAINS(LOWER(c.playerName), @p)`,
    parameters: [
      { name: "@y", value: SCOPE_YEAR },
      { name: "@n", value: SCOPE_NUMBER },
      { name: "@p", value: SCOPE_PLAYER },
    ],
  }).fetchAll();
  console.log(`Found ${resources.length} rows in scope`);

  const stats = { unchanged: 0, playerNameChanged: 0, slugChanged: 0, patched: 0, errored: 0, samples: [] };
  const bySlugBefore = new Map(), bySlugAfter = new Map();

  const patches = [];
  for (const row of resources) {
    const before = row.playerName;
    if (!before) { stats.unchanged++; continue; }
    const result = normalizeHoldingFields({
      playerName: before,
      cardYear: row.cardYear,
      setName: row.setName,
      cardNumber: row.cardNumber,
      parallel: row.parallel,
      isAuto: row.isAuto ?? false,
      printRun: row.printRun ?? null,
      product: null,
    });
    const after = result.fields.playerName;
    let newSlug = row.hobbyiqCardId;
    if (row.sport && typeof row.cardYear === "number" && row.setName && row.cardNumber) {
      try {
        newSlug = computeHobbyIqCardId({
          sport: row.sport,
          year: row.cardYear,
          setKey: row.setName,
          cardNumber: row.cardNumber,
          parallel: row.parallel || "Base",
          isAuto: row.isAuto ?? false,
          printRun: row.printRun ?? null,
        });
      } catch { /* leave slug */ }
    }
    bySlugBefore.set(row.hobbyiqCardId || "(null)", (bySlugBefore.get(row.hobbyiqCardId || "(null)") || 0) + 1);
    bySlugAfter.set(newSlug || "(null)", (bySlugAfter.get(newSlug || "(null)") || 0) + 1);

    if (after === before && newSlug === row.hobbyiqCardId) { stats.unchanged++; continue; }
    if (after !== before) stats.playerNameChanged++;
    if (newSlug !== row.hobbyiqCardId) stats.slugChanged++;
    if (stats.samples.length < 3) stats.samples.push({ before, after, slugBefore: row.hobbyiqCardId, slugAfter: newSlug });
    if (APPLY) patches.push({ id: row.id, cardId: row.cardId, playerName: after, hobbyiqCardId: newSlug });
  }

  if (APPLY && patches.length > 0) {
    console.log(`Applying ${patches.length} patches...`);
    const CONC = 8;
    for (let i = 0; i < patches.length; i += CONC) {
      const chunk = patches.slice(i, i + CONC);
      const results = await Promise.allSettled(chunk.map(async (p) => {
        const pk = p.cardId || p.id;
        for (let a = 0; a < 5; a++) {
          try {
            const ops = [{ op: "add", path: "/playerName", value: p.playerName }];
            if (p.hobbyiqCardId) ops.push({ op: "add", path: "/hobbyiqCardId", value: p.hobbyiqCardId });
            await sc.item(p.id, pk).patch(ops);
            return;
          } catch (err) {
            const code = err?.code ?? err?.statusCode;
            if (code === 429 && a < 4) { await new Promise(r => setTimeout(r, Number(err?.retryAfterInMs ?? 200 * Math.pow(2, a)))); continue; }
            if (code === 404) return;
            throw err;
          }
        }
      }));
      for (const r of results) { if (r.status === "fulfilled") stats.patched++; else stats.errored++; }
      if ((i + chunk.length) % 200 === 0 || i + chunk.length >= patches.length) {
        console.log(`  ${stats.patched}/${patches.length} patched`);
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  scope rows:         ${resources.length}`);
  console.log(`  playerName changed: ${stats.playerNameChanged}`);
  console.log(`  slug changed:       ${stats.slugChanged}`);
  console.log(`  patched:            ${stats.patched}`);
  console.log(`  errored:            ${stats.errored}`);
  console.log(`\n  Slug distribution BEFORE:`);
  for (const [k, v] of [...bySlugBefore.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)} × ${k}`);
  console.log(`\n  Slug distribution AFTER (projected):`);
  for (const [k, v] of [...bySlugAfter.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)} × ${k}`);
  console.log(`\n  Sample changes:`);
  for (const s of stats.samples) {
    console.log(`    "${s.before}" → "${s.after}"`);
    if (s.slugBefore !== s.slugAfter) console.log(`      slug: ${s.slugBefore} → ${s.slugAfter}`);
  }
  if (!APPLY) console.log(`\n  [dry-run] Rerun with APPLY=true.`);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
