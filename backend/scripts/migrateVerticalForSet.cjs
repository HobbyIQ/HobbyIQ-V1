#!/usr/bin/env node
// CF-VERTICAL-MIGRATION (Drew, 2026-08-13: "ok lets build it now").
//
// Redirects TCG sales that are wearing a SPORTS vertical onto the vertical they
// actually belong to, so they match the catalog rows we just ingested.
//
// WHY THIS IS AN IN-PLACE PATCH AND NOT A RE-SLUG. comps_staging partitions on
// /hobbyiqCardId, so changing the slug would mean delete + recreate — 30K
// destructive operations with a window where the sale does not exist. It is
// unnecessary: promotion does not reuse the staging slug, it calls
// recordSoldComp which RECOMPUTES the slug from clean.sport / setName /
// cardNumber / parallel. So patching `clean.sport` alone is enough to redirect
// where the sale lands, and the staging row's own partition key is untouched.
//
// sold_comps rows partition on /cardId, and hobbyiqCardId is an ordinary field,
// so already-promoted comps patch in place too.
//
// SCOPED BY SET on purpose. This is the first vertical migration and several
// assumptions have already turned over tonight, so it runs against one set with
// a fully-populated catalog behind it (swsh10-astral-radiance: 432 rows, 3 of 3
// distinct staged slugs matched) where the result is unambiguous.
//
// Everything is reversible: verticalMigratedFrom records the previous value.
//
//   node scripts/migrateVerticalForSet.cjs --set swsh10-astral-radiance
//   node scripts/migrateVerticalForSet.cjs --set swsh10-astral-radiance --apply

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { classifyTcg } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "tcgVertical.service.js"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SET = val("--set", "");
const MAX = Number(val("--max", "100000"));
const CONCURRENCY = Number(val("--concurrency", "16"));

if (!SET) { console.error("--set is required (e.g. swsh10-astral-radiance)"); process.exit(2); }

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const st = db.container("comps_staging");
const sold = db.container("sold_comps");

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = {
  staged: 0, stagedPatched: 0, stagedSkippedNotTcg: 0, stagedAlreadyRight: 0,
  reopenedAwaiting: 0, comps: 0, compsPatched: 0, errors: 0,
};

(async () => {
  console.log(`vertical migration — ${APPLY ? "APPLY" : "DRY RUN"}  set=${SET}\n`);

  // ---- 1. comps_staging: redirect where promotion will send the sale --------
  const iter = st.items.query({
    query: "SELECT c.id, c.hobbyiqCardId, c.status, c.clean.sport AS sport, " +
           "c.raw.vendorPayload.title AS title FROM c WHERE CONTAINS(c.hobbyiqCardId, @s)",
    parameters: [{ name: "@s", value: `:${SET}:` }],
  }, { maxItemCount: 1000 });

  while (iter.hasMoreResults() && stats.staged < MAX) {
    const { resources } = await iter.fetchNext();
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, async (row) => {
      stats.staged++;
      const tcg = classifyTcg({ sport: row.sport, title: row.title, hobbyiqCardId: row.hobbyiqCardId });
      if (!tcg.isTcg) { stats.stagedSkippedNotTcg++; return; }
      const target = tcg.vertical ?? "pokemon";
      if (row.sport === target) { stats.stagedAlreadyRight++; return; }
      if (!APPLY) { stats.stagedPatched++; return; }
      try {
        const ops = [
          { op: "set", path: "/clean/sport", value: target },
          { op: "set", path: "/verticalMigratedFrom", value: row.sport ?? null },
          { op: "set", path: "/verticalMigratedAt", value: new Date().toISOString() },
        ];
        // A row parked awaiting a catalog it can now match must go back into
        // the promotable set, or the migration changes nothing observable.
        if (row.status === "awaiting-catalog") {
          ops.push({ op: "set", path: "/status", value: "clean" });
          stats.reopenedAwaiting++;
        }
        await st.item(row.id, row.hobbyiqCardId).patch(ops);
        stats.stagedPatched++;
      } catch (e) {
        stats.errors++;
        if (stats.errors <= 3) console.error("  staging patch failed:", String(e.message).slice(0, 120));
      }
    });
  }

  // ---- 2. sold_comps: fix already-promoted rows in place -------------------
  const citer = sold.items.query({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE CONTAINS(c.hobbyiqCardId, @s)",
    parameters: [{ name: "@s", value: `:${SET}:` }],
  }, { maxItemCount: 1000 });

  while (citer.hasMoreResults()) {
    const { resources } = await citer.fetchNext();
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, async (row) => {
      stats.comps++;
      const cur = String(row.hobbyiqCardId ?? "");
      if (/^hiq:(pokemon|yugioh|anime-tcg|tcg-other|mtg|lorcana):/.test(cur)) return;
      const next = cur.replace(/^hiq:[a-z-]+:/, "hiq:pokemon:");
      if (next === cur) return;
      if (!APPLY) { stats.compsPatched++; return; }
      try {
        await sold.item(row.id, row.cardId).patch([
          { op: "set", path: "/hobbyiqCardId", value: next },
          { op: "set", path: "/verticalMigratedFrom", value: cur },
          { op: "set", path: "/verticalMigratedAt", value: new Date().toISOString() },
        ]);
        stats.compsPatched++;
      } catch (e) {
        stats.errors++;
        if (stats.errors <= 3) console.error("  comps patch failed:", String(e.message).slice(0, 120));
      }
    });
  }

  console.log(`staging rows seen        : ${stats.staged}`);
  console.log(`  ${APPLY ? "REDIRECTED to pokemon  " : "would redirect         "}: ${stats.stagedPatched}`);
  console.log(`  already correct        : ${stats.stagedAlreadyRight}`);
  console.log(`  not TCG (left alone)   : ${stats.stagedSkippedNotTcg}`);
  console.log(`  awaiting-catalog reopened: ${stats.reopenedAwaiting}`);
  console.log(`\nsold_comps rows seen     : ${stats.comps}`);
  console.log(`  ${APPLY ? "RE-SLUGGED             " : "would re-slug          "}: ${stats.compsPatched}`);
  console.log(`errors                   : ${stats.errors}`);
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  else console.log("\nNEXT: run promotion so the redirected rows land on the new catalog rows.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
