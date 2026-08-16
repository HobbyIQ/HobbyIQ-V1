#!/usr/bin/env node
/**
 * CF-CARDSIGHT-CATALOG-STUBS (Drew, 2026-08-15: "fix anything so it is
 * structurally sound").
 *
 * The 11,369 cardsight rows whose year was stored as a string (repaired in
 * #1068) are also structurally thin. What they actually carry, measured:
 *
 *     title, set, setName, year   11,369  (100%)
 *     playerName, sport           10,497  (92%)
 *     playerSlug                       0  (0%)
 *     cardNumber                      25  (0.2%)
 *
 * NOTE a correction: #1068 said playerName was null on these rows. That came
 * from a 3-row sample and was wrong — 92% carry it.
 *
 * Three repairs, each only where the data supports it:
 *
 *   playerName <- title      872 rows. Verified that `title` IS the player
 *                            name on these ("Leo De Vries", "Bo Bichette",
 *                            "Christian Yelich"), not a card description.
 *   playerSlug <- slugify    all rows. Zero were populated, so these rows
 *                            were invisible to every playerSlug lookup —
 *                            resolveSetKey queries by it.
 *   sport      <- inferred   ONLY where the parser is confident. It refuses
 *                            on 618 of 872, because a bare player name plus
 *                            a subset carries no sport signal. The dump is
 *                            mixed (9,363 baseball / 998 football / 136
 *                            basketball), so defaulting would be a guess.
 *                            Absent beats wrong: those 618 keep no sport.
 *
 * WHAT THIS CANNOT FIX, and why. cardNumber is absent on 99.8% and the `set`
 * values are SUBSETS ("Base Set", "Autographics", "Team Stickers"), not
 * product lines. Without a card number and a product there is no slug to
 * compute — slugGuard requires both — so these stay SEARCH-INDEX rows rather
 * than becoming match rows. That is a limit of what cardsight's catalog dump
 * provided, not something a repair can invent.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-cardsight-catalog-stubs.cjs [--apply] [--concurrency=16]
 *
 * Defaults to DRY-RUN.
 */
const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => process.argv.includes(`--${n}`);
const slugify = (s) => String(s ?? "").toLowerCase().normalize("NFKD")
  .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");

(async () => {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { inferSportFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  console.log(`[cardsight-stub-repair] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  const iter = cat.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.setName, c.year, c.sport, c.playerName, c.playerSlug
            FROM c WHERE IS_DEFINED(c.yearTypeRepairedAt)`,
  }, { maxItemCount: 500 });

  const tot = { scanned: 0, setPlayer: 0, setSlug: 0, setSport: 0, sportRefused: 0, noChange: 0, written: 0, failed: 0 };
  const inflight = new Set();
  const samples = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const ops = [];
      const player = row.playerName || row.title || null;

      if (!row.playerName && row.title) { ops.push({ op: "add", path: "/playerName", value: row.title }); tot.setPlayer++; }
      if (!row.playerSlug && player) { ops.push({ op: "add", path: "/playerSlug", value: slugify(player) }); tot.setSlug++; }
      if (!row.sport) {
        const text = [row.year, row.setName, row.title].filter(Boolean).join(" ");
        const s = inferSportFromTitle(text, "");
        if (s) { ops.push({ op: "add", path: "/sport", value: s }); tot.setSport++; }
        else tot.sportRefused++;   // left without a sport on purpose
      }

      if (ops.length === 0) { tot.noChange++; continue; }
      if (samples.length < 8) samples.push(`${ops.map((o) => o.path.slice(1)).join(",").padEnd(32)} ${String(player).slice(0, 24).padEnd(25)} ${String(row.setName).slice(0, 30)}`);
      if (!APPLY) continue;

      ops.push({ op: "add", path: "/stubRepairedAt", value: new Date().toISOString() });
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // card_catalog is partitioned by /cardId.
      const p = cat.item(row.id, row.cardId).patch(ops)
        .then(() => { tot.written++; })
        .catch((e) => { tot.failed++; if (tot.failed <= 5) console.warn(`  patch failed id=${row.id}: ${e.code ?? e.message}`); })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  rows scanned              ${tot.scanned}`);
  console.log(`    playerName <- title     ${tot.setPlayer}`);
  console.log(`    playerSlug filled       ${tot.setSlug}`);
  console.log(`    sport inferred          ${tot.setSport}`);
  console.log(`    sport refused (no guess)${String(tot.sportRefused).padStart(6)}`);
  console.log(`    already complete        ${tot.noChange}`);
  console.log(`  written                   ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  sample repairs (fields set | player | set):");
  for (const s of samples) console.log(`    ${s}`);
})().catch((e) => { console.error(e); process.exit(1); });
