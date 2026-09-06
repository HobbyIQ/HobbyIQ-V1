#!/usr/bin/env node
/**
 * READ-ONLY. Two questions the fold arbitration turns on:
 *
 *  (a) WHAT IS ACTUALLY AT THE DESTINATION. The 2026-09-05 judgment measured
 *      1,846 dest rows, 100% hobbymonitor, and concluded "there is no
 *      checklistinsider transcription at the destination at all". Re-measure
 *      the source mix and the graded/identity split.
 *
 *  (b) THE YEAR DEFECT. Sales at a 2024 Optic card number whose top-selling
 *      player is a player NEITHER catalog names at that number -- the judge's
 *      11 NEITHER cases. Counted, with the rookie-year evidence.
 *
 * Nothing is written.
 */
const { CosmosClient } = require("@azure/cosmos");

const SPORT = "football", YEAR = 2024, ALIAS = "panini-optic", DEST = "donruss-optic";
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING is required"); process.exit(2); }
const db = new CosmosClient(conn).database("hobbyiq");
const cat = db.container("card_catalog");
const pool = db.container("sold_comps");

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
const numOf = (id) => String(id ?? "").split(":")[4] ?? "";
function isIdentity(id) {
  const p = String(id ?? "").split(":");
  if (p[0] !== "hiq") return false;
  if (p.length !== 7 && p.length !== 8) return false;
  if (p.length === 8 && !p[7].startsWith("num-")) return false;
  return p[6] === "auto" || p[6] === "no-auto";
}
const norm = (s) => String(s ?? "").trim().toLowerCase()
  .replace(/-(graded|attested|unnumbered|scraped)$/, "")
  .replace(/-\d{4}-\d{2}-\d{2}(t[\d:.+-]*)?$/, "").replace(/-\d{8}$/, "")
  .replace(/-(graded|attested|unnumbered|scraped)$/, "");

(async () => {
  const sel = "SELECT c.id, c.source, c.playerName, c.parallel, c.gradeTier, c.cardNumber FROM c WHERE STARTSWITH(c.id, @p)";
  const [aliasRows, destRows] = await Promise.all([
    all(cat, { query: sel, parameters: [{ name: "@p", value: `hiq:${SPORT}:${YEAR}:${ALIAS}:` }] }),
    all(cat, { query: sel, parameters: [{ name: "@p", value: `hiq:${SPORT}:${YEAR}:${DEST}:` }] }),
  ]);

  function mix(rows, label) {
    const bySource = new Map(), graded = { yes: 0, no: 0 };
    for (const r of rows) {
      const s = norm(r.source) || "(blank)";
      bySource.set(s, (bySource.get(s) ?? 0) + 1);
      if (r.gradeTier) graded.yes++; else graded.no++;
    }
    console.log(`\n${label}: ${rows.length} rows  (identity ${graded.no}, graded ${graded.yes})`);
    for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(7)}  ${s}`);
    }
  }
  mix(aliasRows, `ALIAS ${ALIAS}`);
  mix(destRows, `DEST  ${DEST}`);

  // ── the year defect ───────────────────────────────────────────────────────
  const sales = await all(pool, {
    query: `SELECT c.playerName, c.cardNumber, c.hobbyiqCardId, c.title FROM c
            WHERE c.sport = @sp AND (c.cardYear = @y OR c.year = @y)
              AND (c.normalizedSetKey = @a OR c.normalizedSetKey = @d)`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@y", value: YEAR }, { name: "@a", value: ALIAS }, { name: "@d", value: DEST }],
  });
  const known = new Map();
  for (const r of [...aliasRows, ...destRows]) {
    if (!isIdentity(r.id)) continue;
    const n = numOf(r.id);
    if (!known.has(n)) known.set(n, new Set());
    if (r.playerName) known.get(n).add(pk(r.playerName));
  }
  const byNum = new Map();
  for (const s of sales) {
    const n = String(s.cardNumber ?? numOf(s.hobbyiqCardId) ?? "").trim().toLowerCase();
    const p = String(s.playerName ?? "").trim();
    if (!n || !p) continue;
    if (!byNum.has(n)) byNum.set(n, new Map());
    const m = byNum.get(n), k = pk(p);
    const cur = m.get(k) ?? { name: p, n: 0 }; cur.n++; m.set(k, cur);
  }
  const defect = [];
  let defectRows = 0;
  for (const [n, m] of byNum) {
    const sorted = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    const [k, top] = sorted[0];
    const kn = known.get(n);
    if (kn && kn.has(k)) continue;           // the catalog names the top seller
    defect.push({ number: n, player: top.name, sales: top.n, catalogNames: kn ? [...kn].length : 0 });
    defectRows += top.n;
  }
  defect.sort((a, b) => b.sales - a.sales);
  console.log(`\nYEAR/NUMBER DEFECT -- the top-selling player at the number is named by NEITHER catalog`);
  console.log(`  card numbers affected   ${defect.length}`);
  console.log(`  sale rows on those top sellers   ${defectRows}`);
  for (const d of defect.slice(0, 25)) {
    console.log(`    #${String(d.number).padEnd(5)} ${d.player.padEnd(24)} x${String(d.sales).padStart(3)}   (catalog names ${d.catalogNames} players here)`);
  }
  console.log(`\nREAD ONLY -- nothing written`);
})().catch((e) => { console.error("FAILED:", String(e?.message ?? e)); process.exit(1); });
