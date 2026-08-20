#!/usr/bin/env node
/**
 * CF-ONE-SLUG-DERIVATION repair pass (Drew, 2026-08-17).
 *
 * Stamps hobbyiqCardId onto sold_comps rows that have none.
 *
 * WHY THEY EXIST. soldCompsStore fed the slug guard `normalizeSetKey(setName)`
 * while computeHobbyIqCardId — the function being guarded — resolves Pokemon
 * through POKEMON_SET_ALIASES first. The guard rejected the leading year that
 * the alias table removes, so it refused rows the computation would have keyed.
 * Measured 2026-08-17: of 860,462 null-slug Pokemon comps the guard accepted
 * exactly 1, and 615,140 (71.5%) resolve cleanly. The ingest defect is fixed
 * (CF-ONE-SETKEY-RESOLVER); this repairs what it already wrote.
 *
 * ONE IMPLEMENTATION. The slug is derived by calling the SHIPPED
 * deriveHobbyIqSlug out of dist/ — not a re-implementation. A backfill that
 * re-derives "carefully" is a second implementation, and its drift is
 * invisible: it writes well-formed slugs that merely disagree with the ones
 * ingest writes. That class of bug is what this whole change set is about.
 *
 * REFUSAL IS PRESERVED. A row whose inputs the guard rejects is LEFT ALONE. An
 * unkeyed row is visibly incomplete and can be repaired later; a confidently
 * wrong slug corrupts a comp pool and looks healthy forever. ~203K Japanese
 * Pokemon rows land here on purpose — the alias table is generated from
 * tcgdex's English endpoint and holds zero Japanese keys.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/backfill-null-slugs.cjs [--apply] [--pool=12] [--limit=N] [--sport=pokemon]
 *
 * Requires a build: the derivation is read from dist/.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { deriveHobbyIqSlug } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const POOL = Math.max(1, Number(arg("pool", "12")));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const SPORT = arg("sport", "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const APPLY = has("apply");
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-null-slugs] mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}` +
    `${SPORT ? ` sport=${SPORT}` : ""}${LIMIT === Infinity ? "" : ` limit=${LIMIT}`}\n`);

  const where = ["(NOT IS_DEFINED(c.hobbyiqCardId) OR IS_NULL(c.hobbyiqCardId))"];
  if (SPORT) where.push(`c.sport = ${JSON.stringify(SPORT)}`);
  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.setName, c.title,
                   c.cardYear, c.cardNumber, c.parallel, c.isAuto
            FROM c WHERE ${where.join(" AND ")}`,
  }, { maxItemCount: 1000 });

  let scanned = 0, keyed = 0, refused = 0, failed = 0, skippedHasSlug = 0;
  const destinations = new Map();
  const reasons = new Map();

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    if (!resources || resources.length === 0) continue;

    const work = [];
    for (const r of resources) {
      if (scanned >= LIMIT) break;
      scanned++;
      // Defensive: the query filters these out, but never overwrite a slug.
      if (r.hobbyiqCardId) { skippedHasSlug++; continue; }

      const d = deriveHobbyIqSlug({
        sport: r.sport ?? null,
        setName: r.setName ?? null,
        title: r.title ?? null,
        cardYear: typeof r.cardYear === "number" ? r.cardYear : null,
        cardNumber: r.cardNumber ?? null,
        parallel: r.parallel ?? null,
        isAuto: r.isAuto ?? false,
      });

      if (!d.slug) {
        refused++;
        for (const reason of d.guard.reasons) reasons.set(reason, (reasons.get(reason) || 0) + 1);
        continue;
      }
      const setKey = d.slug.split(":")[3];
      destinations.set(setKey, (destinations.get(setKey) || 0) + 1);
      work.push({ r, slug: d.slug });
    }

    let cursor = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (cursor < work.length) {
        const { r, slug } = work[cursor++];
        if (!APPLY) { keyed++; continue; }
        try {
          await sold.item(r.id, r.cardId).patch([
            { op: "set", path: "/hobbyiqCardId", value: slug },
            { op: "add", path: "/hobbyiqCardIdBackfilledAt", value: new Date().toISOString() },
          ]);
          keyed++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 90)}`);
        }
      }
    }));

    if (scanned % 50000 < 1000) {
      process.stderr.write(`\r  scanned=${scanned} keyed=${keyed} refused=${refused}    `);
    }
  }
  process.stderr.write("\n");

  console.log("\ntop destination setKeys:");
  [...destinations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));

  console.log("\nrefusal reasons (rows LEFT ALONE, by design):");
  [...reasons.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));

  const pct = (x) => (scanned ? `${(x / scanned * 100).toFixed(1)}%` : "—");
  console.log(`\nscanned=${scanned} keyed=${keyed} (${pct(keyed)}) refused=${refused} (${pct(refused)}) ` +
    `alreadyKeyed=${skippedHasSlug} failed=${failed}`);
  console.log(`distinct destination setKeys: ${destinations.size}`);
  if (!APPLY) console.log("\nDRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
