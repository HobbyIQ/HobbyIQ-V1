#!/usr/bin/env node
/**
 * census-player-pseudo-number.cjs -- READ-ONLY. What is actually under the
 * 89,138 pool rows whose cardNumber segment is the `player-<name>` pseudo-number?
 *
 * CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). CF-PLAYER-IS-THE-NUMBER
 * minted that shape for cards that GENUINELY have no number -- T206, Magic
 * Alpha, Leaf Signature Series -- where the player is how collectors identify
 * the card. That population is real and those rows are correct.
 *
 * But `isUnnumberedCardNumber` returned true on an EMPTY string, so a
 * cardNumber the parser simply failed to read fell into the same branch. A 1987
 * Topps Traded Tiffany Greg Maddux PSA 10 whose title states `#70T` is filed at
 * `hiq:baseball:1987:topps:player-todd-worrell:base:no-auto`: the number was
 * there in the title, discarded, and replaced with a player TCA mis-attributed.
 *
 * This script does not repair anything and writes nothing. It re-derives each
 * row's identity with TODAY'S deriver (post-#1715, post-this-PR) and sorts the
 * population into the three answers that decide what a repair would even be:
 *
 *   REPARSE      the title states a real card number -- the row was never
 *                unnumbered, it was UNPARSED, and a re-derivation gives it a
 *                numbered identity. This is the defect's own population.
 *   UNNUMBERED   the card genuinely carries no number: the row's own fields say
 *                so (`nno`/`unnumbered`), or the product is one of the known
 *                unnumbered families. The pseudo-number is the right answer and
 *                the row stays exactly where it is.
 *   UNDERIVABLE  neither. No number to read and nothing asserting there is none.
 *                Absent beats wrong: report it, never key it.
 *
 * The rows are NOT re-keyed here even for REPARSE. The GREAT REMATCH classifier
 * owns that decision (`player-` -> numbered is IMPROVE only when the title
 * states the number AND the numbered identity is checklist-backed), and this
 * census is the measurement that says how big that lane is.
 *
 * USAGE (read-only; no APPLY flag exists on purpose)
 *   COSMOS_CONNECTION_STRING=... node scripts/census-player-pseudo-number.cjs [--limit N] [--out FILE]
 */
"use strict";

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const CLASSIFY = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(argOf("--limit", "0")) || 0;
const OUT = argOf("--out", "");

/**
 * The unnumbered families named in CF-PLAYER-IS-THE-NUMBER's own measurement.
 * A setKey matching one of these is a product that never carried card numbers,
 * so a blank number on it is an ANSWER and not a parse failure -- the same fact
 * a checklist would supply, sourced from the ruling that minted the shape.
 */
const UNNUMBERED_FAMILY_RE = /(^|-)(t206|t205|t207|alpha|beta|unlimited|arabian-nights|antiquities|the-dark|legends|signature-series|stand-up|rub-offs|leaf-signature|donruss-signature)(-|$)/i;

/** The row's own fields ASSERT the card has no number. */
const ASSERTED = new Set(["nno", "no number", "no-number", "nonumber", "n/a", "na", "none", "unnumbered"]);

const str = (v) => String(v ?? "").trim();

function verdictFor(row) {
  const title = str(row.title);
  const stored = str(row.cardNumber).toLowerCase();
  const setKey = str(row.setKey) || segOf(row, 3);

  // 1. The title states a number the deriver can read. The row was UNPARSED.
  if (CLASSIFY.titleStatesCardNumber(title)) return "reparse";

  // 2. The source asserted there is no number, or the product is one that
  //    never had them. The pseudo-number is correct.
  if (ASSERTED.has(stored)) return "unnumbered";
  if (UNNUMBERED_FAMILY_RE.test(setKey)) return "unnumbered";

  // 3. Nothing to read and nothing asserting there is nothing. Absent > wrong.
  return "underivable";
}

/** Segment N of a hiq: slug, or "". */
function segOf(row, n) {
  const id = str(row.hobbyiqCardId) || str(row.cardId);
  if (!id.startsWith("hiq:")) return "";
  const p = id.split(":");
  return p[n] ?? "";
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING is required (read-only)."); process.exit(2); }
  const client = new CosmosClient(conn);
  const container = client.database("hobbyiq").container("sold_comps");

  const counts = { reparse: 0, unnumbered: 0, underivable: 0 };
  const byKey = new Map();   // "year|setKey" -> {reparse,unnumbered,underivable,total}
  const samples = { reparse: [], unnumbered: [], underivable: [] };
  let scanned = 0;

  const query = {
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName, c.cardNumber, c.setName, c.setKey, c.cardYear, c.parallel, c.source FROM c WHERE CONTAINS(c.hobbyiqCardId, ':player-') OR CONTAINS(c.cardId, ':player-')",
  };
  const iter = container.items.query(query, { maxItemCount: 1000, maxDegreeOfParallelism: 8 });

  let ru = 0;
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    ru += page.requestCharge ?? 0;
    for (const row of page.resources ?? []) {
      scanned++;
      const v = verdictFor(row);
      counts[v]++;
      const year = str(row.cardYear) || segOf(row, 2);
      const setKey = str(row.setKey) || segOf(row, 3);
      const k = `${year}|${setKey}`;
      const b = byKey.get(k) ?? { year, setKey, reparse: 0, unnumbered: 0, underivable: 0, total: 0 };
      b[v]++; b.total++;
      byKey.set(k, b);
      if (samples[v].length < 8) {
        samples[v].push({ id: row.id, slug: str(row.hobbyiqCardId) || str(row.cardId), title: str(row.title), storedCardNumber: row.cardNumber ?? null, playerName: row.playerName ?? null });
      }
    }
    if (scanned % 10000 < 1000) console.error(`  ... scanned ${scanned} (RU ${Math.round(ru)})`);
    if (LIMIT && scanned >= LIMIT) break;
  }

  const top = [...byKey.values()].sort((a, b) => b.total - a.total).slice(0, 20);
  const report = { scanned, counts, requestCharge: Math.round(ru), top, samples };
  const json = JSON.stringify(report, null, 2);
  if (OUT) { require("fs").writeFileSync(OUT, json); console.error(`wrote ${OUT}`); }
  console.log(json);
})().catch((e) => { console.error("census failed:", e.message); process.exit(1); });
