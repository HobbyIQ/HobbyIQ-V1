#!/usr/bin/env node
/**
 * READ-ONLY. The judge's item 5: "2025 sales attributed to 2024 numbers"
 * (Treveyon Henderson #23 x39, Bo Nix #31 x36, Jaxson Dart #2 x36, Cam
 * Skattebo #5 x36). Checked directly, and widened to every plain numeric
 * Optic number whose top seller is a 2025-rookie-shaped name.
 *
 * Nothing is written.
 */
const { CosmosClient } = require("@azure/cosmos");
const SPORT = "football", ALIAS = "panini-optic", DEST = "donruss-optic";
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING is required"); process.exit(2); }
const db = new CosmosClient(conn).database("hobbyiq");
const pool = db.container("sold_comps");
const cat = db.container("card_catalog");

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};
async function all(c, spec, pageSize = 1000) {
  const out = []; let token;
  do {
    const p = await retry(() => c.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = p.continuationToken; for (const r of p.resources ?? []) out.push(r);
  } while (token);
  return out;
}
const pk = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const NAMED = ["Treveyon Henderson", "Bo Nix", "Jaxson Dart", "Cam Skattebo"];

(async () => {
  // Every Optic football sale, ANY year, for the four named players.
  const sales = await all(pool, {
    query: `SELECT c.playerName, c.cardNumber, c.cardYear, c.year, c.normalizedSetKey, c.title, c.hobbyiqCardId
            FROM c WHERE c.sport = @sp AND (c.normalizedSetKey = @a OR c.normalizedSetKey = @d)`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@a", value: ALIAS }, { name: "@d", value: DEST }],
  });
  console.log(`Optic football sales, all years: ${sales.length}`);
  const byYear = new Map();
  for (const s of sales) {
    const y = String(s.cardYear ?? s.year ?? "?");
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  console.log("  by year:", [...byYear.entries()].sort().map(([y, n]) => `${y}:${n}`).join("  "));

  console.log(`\nTHE FOUR NAMED PLAYERS -- where their Optic sales sit:`);
  let defectRows = 0;
  const examples = [];
  for (const name of NAMED) {
    const k = pk(name);
    const mine = sales.filter((s) => pk(s.playerName) === k);
    const cells = new Map();
    for (const s of mine) {
      const y = String(s.cardYear ?? s.year ?? "?");
      const n = String(s.cardNumber ?? "").trim();
      const key = `${y}|#${n}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    console.log(`  ${name.padEnd(22)} ${String(mine.length).padStart(4)} sales   ${[...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} x${n}`).join("  ")}`);
    // A DEFECT row: a 2025 rookie's sale filed under cardYear 2024.
    for (const s of mine) {
      const y = String(s.cardYear ?? s.year ?? "");
      if (y === "2024") {
        defectRows++;
        if (examples.length < 10) examples.push(`    ${name} @ 2024 #${String(s.cardNumber ?? "?")}  "${String(s.title ?? "").slice(0, 70)}"`);
      }
    }
  }
  console.log(`\n  2025-rookie sales filed under cardYear 2024: ${defectRows}`);
  for (const e of examples) console.log(e);

  // Does the 2024 catalog name any of them?
  const rows = await all(cat, {
    query: "SELECT c.id, c.playerName, c.source FROM c WHERE STARTSWITH(c.id, @a) OR STARTSWITH(c.id, @d)",
    parameters: [{ name: "@a", value: `hiq:${SPORT}:2024:${ALIAS}:` }, { name: "@d", value: `hiq:${SPORT}:2024:${DEST}:` }],
  });
  console.log(`\n  2024 catalog rows naming one of the four:`);
  for (const name of NAMED) {
    const k = pk(name);
    const hits = rows.filter((r) => pk(r.playerName) === k);
    console.log(`    ${name.padEnd(22)} ${hits.length}${hits.length ? "   e.g. " + hits.slice(0, 2).map((h) => `${h.id.slice(0, 58)} [${h.source}]`).join(" | ") : ""}`);
  }
  console.log(`\nREAD ONLY -- nothing written`);
})().catch((e) => { console.error("FAILED:", String(e?.message ?? e)); process.exit(1); });
