#!/usr/bin/env node
/**
 * CF-SLUG-PLAYER-CONFLICT-AUDIT (Drew, 2026-08-17: "go back to checking our
 * sales index for wrongly attached cards to the catalog").
 *
 * READ-ONLY. Finds sales attached to the WRONG CARD.
 *
 * THE SIGNAL. A hobbyiqCardId is an identity — one product, one card number,
 * one parallel. So every sale under one slug should name the SAME person. When
 * a slug carries two materially different players, at least one of those sales
 * is attached to a card it is not. That is a stronger and cheaper test than
 * joining to the catalog, because it needs no catalog row to exist and it
 * catches the case where the catalog itself is wrong.
 *
 * This is the failure the 1995-96 Fleer work surfaced by hand:
 *
 *     hiq:basketball:1995:fleer:22:gold-medallion:no-auto  Michael Jordan
 *     hiq:basketball:1995:fleer:22:gold-medallion:no-auto  Alonzo Mourning
 *
 * where a Jordan Gold Medallion was catalogued as Mourning and could not be
 * found by anyone searching for it.
 *
 * WHY NAME NORMALISATION IS CONSERVATIVE. Vendor text writes one person a dozen
 * ways — "Ohtani", "Shohei Ohtani", "OHTANI, SHOHEI", "Shohei Ohtani RC". Those
 * are the SAME player and must not be reported as a conflict, or the report is
 * all noise. So names are compared on their surname plus first initial, and a
 * conflict is only claimed when those genuinely differ. This UNDER-reports on
 * purpose: a real conflict missed is better than a false one that sends someone
 * to repair data that was correct.
 *
 * MULTI-PLAYER CARDS ARE EXCLUDED. A card can legitimately depict two people
 * ("Mantle / Maris"), so any name carrying a separator is skipped rather than
 * counted as a disagreement with itself.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-slug-player-conflicts.cjs \
 *     [--scan=300000] [--top=25] [--sport=baseball] [--catalog]
 *
 *   --catalog  also read card_catalog for the worst offenders, to say which
 *              side is wrong rather than only that the two disagree.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const SCAN = Number(arg("scan", "300000"));
const TOP = Number(arg("top", "25"));
const SPORT = arg("sport", "");
const WITH_CATALOG = has("catalog");

/** Surname + first initial. Deliberately coarse — see the header. */
function nameKey(raw) {
  let s = String(raw ?? "").toLowerCase().trim();
  if (!s) return null;
  // Multi-player cards are legitimate; skip rather than call them a conflict.
  if (/[/&+]| and | vs\.? /.test(s)) return null;
  s = s.replace(/\b(jr|sr|ii|iii|iv|rc|rookie)\b/g, " ");
  s = s.replace(/[^a-z\s,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // "Ohtani, Shohei" → "shohei ohtani"
  if (s.includes(",")) {
    const [last, first] = s.split(",").map((x) => x.trim());
    s = `${first ?? ""} ${last}`.trim();
  }
  const parts = s.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const initial = parts.length > 1 ? parts[0][0] : "";
  // A bare surname matches any first initial, so it can never manufacture a
  // conflict on its own.
  return `${last}|${initial}`;
}

/** Two keys conflict only when both carry an initial and they differ, or the
 *  surnames differ outright. */
function conflicts(a, b) {
  const [lastA, iA] = a.split("|");
  const [lastB, iB] = b.split("|");
  if (lastA !== lastB) return true;
  if (!iA || !iB) return false;      // one side unqualified — not a conflict
  return iA !== iB;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");

  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)", "IS_DEFINED(c.playerName)"];
  if (SPORT) where.push(`c.sport = ${JSON.stringify(SPORT)}`);

  console.log(`[slug-player-conflicts] scanning up to ${SCAN.toLocaleString()} rows${SPORT ? ` (${SPORT})` : ""}\n`);

  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId, c.playerName, c.price FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 1000 },
  );

  /** slug -> Map<nameKey, {n, sample, value}> */
  const bySlug = new Map();
  let scanned = 0;

  while (iter.hasMoreResults() && scanned < SCAN) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      if (scanned >= SCAN) break;
      scanned++;
      const key = nameKey(r.playerName);
      if (!key) continue;
      const slug = String(r.hobbyiqCardId);
      let m = bySlug.get(slug);
      if (!m) { m = new Map(); bySlug.set(slug, m); }
      const cur = m.get(key) ?? { n: 0, sample: r.playerName, value: 0 };
      cur.n += 1;
      cur.value += Number(r.price) || 0;
      m.set(key, cur);
    }
    if (scanned % 50000 < 1000) process.stderr.write(`\r  scanned=${scanned}    `);
  }
  process.stderr.write("\n");

  // A slug is in conflict when any two of its name keys genuinely disagree.
  const offenders = [];
  let slugsWithConflict = 0, salesInConflict = 0;
  for (const [slug, names] of bySlug) {
    if (names.size < 2) continue;
    const keys = [...names.keys()];
    let bad = false;
    outer: for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (conflicts(keys[i], keys[j])) { bad = true; break outer; }
      }
    }
    if (!bad) continue;
    slugsWithConflict++;
    const total = [...names.values()].reduce((s, v) => s + v.n, 0);
    salesInConflict += total;
    offenders.push({
      slug, total,
      value: [...names.values()].reduce((s, v) => s + v.value, 0),
      names: [...names.values()].sort((a, b) => b.n - a.n),
    });
  }

  offenders.sort((a, b) => b.total - a.total);

  const pct = (x, of) => (of ? `${(x / of * 100).toFixed(2)}%` : "—");
  console.log(`rows scanned            : ${scanned.toLocaleString()}`);
  console.log(`distinct slugs          : ${bySlug.size.toLocaleString()}`);
  console.log(`slugs WITH a conflict   : ${slugsWithConflict.toLocaleString()}  ${pct(slugsWithConflict, bySlug.size)} of slugs`);
  console.log(`sales on those slugs    : ${salesInConflict.toLocaleString()}  ${pct(salesInConflict, scanned)} of scanned\n`);

  console.log(`WORST ${Math.min(TOP, offenders.length)} BY SALE COUNT`);
  console.log("-".repeat(96));

  const cat = WITH_CATALOG ? db.container("card_catalog") : null;
  for (const o of offenders.slice(0, TOP)) {
    console.log(`${o.slug}   ${o.total} sales`);
    for (const v of o.names.slice(0, 4)) {
      console.log(`      ${String(v.n).padStart(5)}  ${v.sample}`);
    }
    if (cat) {
      // The catalog is the tie-breaker: it says who the card actually depicts.
      try {
        const { resources } = await cat.items.query({
          query: "SELECT TOP 1 c.playerName, c.source FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: o.slug }],
        }).fetchAll();
        const row = resources[0];
        console.log(row
          ? `      catalog says: ${row.playerName}   [${row.source}]`
          : `      catalog says: (no row for this slug)`);
      } catch { /* non-fatal */ }
    }
  }

  console.log(`\nNOTE: name matching is surname + first initial and skips multi-player`);
  console.log(`cards, so this UNDER-reports. A missed conflict beats a false one.`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
