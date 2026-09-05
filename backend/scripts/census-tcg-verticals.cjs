#!/usr/bin/env node
/**
 * READ-ONLY, per-vertical volume for the TCG verticals: rows, dollars, 90-day
 * velocity, and the unknown-setKey share of each.
 *
 * WHY IT EXISTS. Drew's ask (2026-09-05) is explicit that One Piece / Yu-Gi-Oh /
 * Lorcana / Magic get NO vocabulary in this pass -- CF-POKEMON-TCG-EXPANSION-
 * PARKED parks the vertical behind the sport->vertical refactor. What they get
 * is a MEASUREMENT, so that refactor can be costed against real money rather
 * than a hunch.
 *
 * TWO QUERY SHAPES WERE TRIED, AND THE FIRST IS RECORDED BECAUSE IT FAILED.
 *
 *   1. `SELECT c.sport, COUNT(1), SUM(c.price) FROM c GROUP BY c.sport` -- one
 *      cross-partition aggregate over a 20M-row container. Abandoned: it did
 *      not return in ten minutes, the same shape #1796 reported when its
 *      product-level query (`WHERE c.setKey=@sk AND c.cardYear=@y`) did not
 *      return in four.
 *   2. one targeted COUNT/SUM per vertical -- this script. Same answer for the
 *      rows we care about, and each vertical is its own bounded query, so a
 *      slow one cannot hide the others' results.
 *
 * Even shape 2 ran >50 minutes without completing on 2026-09-05. It is
 * committed ready to run rather than quoted, because a number presented as
 * measured had better be measured (CF-NEVER-DISMISS-SMALL-NUMBERS-AS-NOISE
 * cuts both ways). Give it a job-length budget, or a cheaper access path.
 *
 * ALSO RECORDED: `SELECT VALUE { n: COUNT(1), dollars: SUM(c.price) }` -- the
 * obvious one-round-trip form -- is REFUSED by this SDK with "One of the input
 * values is invalid". Each aggregate is therefore its own query. Two valid
 * reads beat one invalid one.
 *
 * NO WRITES. No --apply, no APPLY env read, no write path.
 *
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
 *     --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *   node backend/scripts/census-tcg-verticals.cjs --json=/tmp/tcg-verticals.json
 */
const path = require("path");
const fs = require("fs");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) { console.error("missing COSMOS_CONNECTION_STRING"); process.exit(1); }
const pool = new CosmosClient(cs).database("hobbyiq").container("sold_comps");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = val("--json", "");
const since90 = new Date(Date.now() - 90 * 864e5).toISOString();

const one = async (query, parameters) => {
  const { resources } = await pool.items.query({ query, parameters }, { maxItemCount: -1 }).fetchAll();
  return resources[0];
};

/** Cosmos refuses `SELECT VALUE { n: COUNT(1), dollars: SUM(...) }` in this SDK
 *  ("One of the input values is invalid"), so each aggregate is its own query.
 *  Two bounded reads beat one invalid one. */
const agg = async (expr, where, parameters) => {
  const r = await one(`SELECT VALUE ${expr} FROM c WHERE ${where}`, parameters);
  return r ?? 0;
};

const VERTICALS = ["pokemon", "anime-tcg", "yugioh", "mtg", "lorcana", "tcg-other"];

(async () => {
  const out = [];
  for (const s of VERTICALS) {
    const t0 = Date.now();
    try {
      const P = [{ name: "@s", value: s }];
      const P90 = [{ name: "@s", value: s }, { name: "@d", value: since90 }];
      const totN = await agg("COUNT(1)", "c.sport = @s", P);
      const totD = await agg("SUM(c.price)", "c.sport = @s", P);
      const velN = await agg("COUNT(1)", "c.sport = @s AND c.soldAt >= @d", P90);
      const velD = await agg("SUM(c.price)", "c.sport = @s AND c.soldAt >= @d", P90);
      const unk = await agg("COUNT(1)", "c.sport = @s AND CONTAINS(c.cardId, \":unknown:\")", P);
      const tot = { n: totN, dollars: totD };
      const vel = { n: velN, dollars: velD };
      const rec = {
        sport: s,
        rows: tot?.n ?? 0,
        dollars: Math.round(tot?.dollars ?? 0),
        rows90d: vel?.n ?? 0,
        dollars90d: Math.round(vel?.dollars ?? 0),
        unknownKey: unk ?? 0,
        unknownPct: tot?.n ? +(100 * (unk ?? 0) / tot.n).toFixed(1) : 0,
        secs: +((Date.now() - t0) / 1000).toFixed(0),
      };
      out.push(rec);
      console.log(`${s.padEnd(12)} rows=${String(rec.rows).padStart(8)} $${String(rec.dollars).padStart(12)}  90d: ${String(rec.rows90d).padStart(7)} rows $${String(rec.dollars90d).padStart(11)}  unknownKey=${rec.unknownPct}%  (${rec.secs}s)`);
    } catch (e) {
      console.log(`${s.padEnd(12)} ERR ${e.message}`);
      out.push({ sport: s, error: e.message });
    }
  }
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log("wrote " + OUT);
  }
})().catch((e) => { console.error("ERR", e.stack || e.message); process.exit(1); });
