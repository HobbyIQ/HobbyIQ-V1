#!/usr/bin/env node
/**
 * CF-A-MANIFEST-BUILT-BY-THE-DROPPING-FILTER-INHERITS-THE-DROP (2026-09-07).
 *
 * `data/ingest-universe.json` holds 180 `tcgdexja` entries and tcgdex serves
 * 184 Japanese sets. The four missing ones are `neo1`..`neo4` -- 323 cards --
 * and they are missing for exactly the reason #1971 fixed in the LANES:
 *
 *   "Both tcgdex staging lanes carried the generator's exclusion in their own
 *    spelling, `ja.filter((s) => !enIds.has(s.id))`."
 *
 * The ENUMERATION that seeded this manifest carried it too. `neo1`..`neo4` are
 * the only JA ids tcgdex spells LOWERCASE in both markets, so `enIds.has(s.id)`
 * matched them exactly and the enumeration never wrote a row. Every other
 * shared-code JA set (`SM10`, `XY7`, `SV10`) is uppercase in JA, dodged the
 * filter, and IS in the manifest -- which is why the gap is four entries and
 * not nineteen, and why nobody noticed it: the driver cannot dispatch what the
 * manifest does not list, so those 323 cards were unreachable by any run.
 *
 * #1971 stated this plainly and declined to fix it there: "Regenerating it is a
 * separate manifest change, not something to smuggle into an apply." This is
 * that change.
 *
 * -- WHY A GENERATOR AND NOT A HAND-EDIT ------------------------------------
 *
 * The committed manifest is 18,115 entries. A hand-typed row is a fact nobody
 * measured, and every field on these rows is READ FROM THE SOURCE:
 * `estimatedCards` and `year` come from tcgdex's own set document, and `id`,
 * `lane` and `sourceRef` are built by the same string rule the seeding
 * enumeration used. The one field this script does NOT read is `seededStatus`,
 * which stays `missing` -- the live status is the driver's to write, and this
 * script has ingested nothing.
 *
 * -- THE SAME THREE INVARIANTS AS THE MODERN EXTENDER ------------------------
 *
 * This is `extend-universe-tcgdexja-modern.cjs`'s shape, and it keeps that
 * script's hard-won rules verbatim, because they were each paid for:
 *
 *   IDENTITY IS NEVER REWRITTEN. An entry's `id`/`lane`/`sourceRef` are the
 *   key the driver's `crawl_state` verdicts hang on; a reshape strands them.
 *   An id already present is REPORTED and left exactly as it stands.
 *
 *   ORDER IS LEFT ALONE. The committed file is not id-sorted, and re-sorting
 *   rewrote all 7,755 entries once -- an 85,000-line diff hiding 52 real
 *   changes. New entries are appended.
 *
 *   THE FILE'S OWN FORMATTING is preserved, for the same reason -- but it is
 *   MEASURED here rather than asserted. See `formatOf`: the modern extender's
 *   "TWO-space" comment is stale, the manifest is committed at one space and
 *   with CRLF, and trusting the comment cost a 219,301-line diff.
 *
 * Usage:
 *   node backend/scripts/extend-universe-tcgdexja-vintage.cjs [--apply]
 *   node backend/scripts/extend-universe-tcgdexja-vintage.cjs --sets=neo1,neo2
 *
 * Without --apply it prints the diff and writes nothing.
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const MANIFEST = arg("manifest", path.join(__dirname, "..", "data", "ingest-universe.json"));
const DELAY = Number(arg("delayMs", "150"));
const ONLY = arg("sets", "").split(",").map((s) => s.trim()).filter(Boolean);
const APPLY = process.argv.includes("--apply");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (attempt < 3) { await sleep(2000 * (attempt + 1)); return get(url, attempt + 1); }
    console.error(`  fetch failed ${url}: ${String(e.message).slice(0, 60)}`);
    return null;
  }
}

/** The id rule the seeding enumeration used. Kept identical on purpose. */
const sourceRefFor = (setId) => `https://api.tcgdex.net/v2/ja/sets/${setId}`;
const entryIdFor = (setId) => `tcgdexja::${sourceRefFor(setId)}`;

/**
 * THE FILE'S OWN FORMATTING, MEASURED -- NEVER ASSUMED.
 *
 * A four-entry addition must be a four-entry diff. Two formatting details
 * decide whether it is, and BOTH were got wrong on the first try here:
 *
 *   LINE ENDING  the file is committed CRLF; `JSON.stringify` emits LF.
 *   INDENT       the file is committed at ONE space. The modern extender's
 *                header says "TWO-space, matching the committed file exactly"
 *                and that comment is now STALE -- the manifest has been
 *                re-minted since, and `build-ingest-universe-manifest.cjs`
 *                itself writes `JSON.stringify(manifest, null, 2)`. Trusting
 *                the comment produced a **219,301-line** diff for four added
 *                entries.
 *
 * Which is the same lesson the modern extender learned from re-sorting ("an
 * 85,000-line diff hiding 52 real changes"), arriving by a different door. So
 * neither is hardcoded and neither is inherited from a comment: both are read
 * off the committed bytes, and the script is correct on a checkout in any
 * shape.
 */
function formatOf(text) {
  const head = text.slice(0, 8192);
  const eol = /\r\n/.test(head) ? "\r\n" : "\n";
  // The first indented line after the opening brace states the unit.
  const m = /[\r\n]+([ \t]+)"/.exec(head);
  return { eol, indent: m ? m[1] : "  " };
}

async function main() {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  const { eol: EOL, indent: INDENT } = formatOf(raw);
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.entries)) { console.error("FATAL: manifest carries no entries[]"); process.exit(1); }

  const ja = await get("https://api.tcgdex.net/v2/ja/sets");
  if (!Array.isArray(ja) || !ja.length) { console.error("FATAL: tcgdex ja set index unreachable"); process.exit(1); }

  const present = new Set(doc.entries.filter((e) => e.lane === "tcgdexja").map((e) => e.id));
  let scope = ja.filter((s) => !present.has(entryIdFor(s.id)));
  if (ONLY.length) scope = scope.filter((s) => ONLY.includes(s.id));

  console.log(`[universe] ${doc.entries.length} entries, ${present.size} tcgdexja`);
  console.log(`[tcgdex]   ${ja.length} ja sets served`);
  console.log(`[missing]  ${scope.length}${ONLY.length ? ` (scoped to ${ONLY.join(",")})` : ""}\n`);

  if (!scope.length) { console.log("Nothing missing — the manifest already lists every JA set tcgdex serves."); return; }

  const before = doc.entries.length;
  const added = [];
  const refused = [];

  for (const s of scope) {
    const d = await get(sourceRefFor(s.id));
    await sleep(DELAY);
    // EVERY FIELD IS READ, OR THE ROW IS REFUSED. A set the source will not
    // describe is reported and left out: an entry carrying a guessed year is
    // worse than an absent one, because the driver would dispatch on it.
    if (!d) { refused.push(`${s.id} (set document unreachable)`); continue; }
    const year = Number(String(d.releaseDate ?? "").slice(0, 4));
    if (!year) { refused.push(`${s.id} (no releaseDate served — year would be a guess)`); continue; }
    const cards = Number(d.cardCount && d.cardCount.total) || (Array.isArray(d.cards) ? d.cards.length : 0) || null;

    added.push({
      id: entryIdFor(s.id),
      lane: "tcgdexja",
      sourceRef: sourceRefFor(s.id),
      sport: "pokemon",
      year,
      // The seeding enumeration's own shape: `<id> <the source's set name>`.
      setName: `${s.id} ${d.name ?? s.id}`,
      estimatedCards: cards,
      // NOT a verdict. The driver re-reads Cosmos per entry and writes its own.
      seededStatus: "missing",
      seededNote: `ja set sharing an English set code, absent from the seeding enumeration because it case-folds onto the English id; ${cards ?? "?"} cards stated by source`,
    });
  }

  console.log(`manifest entries  ${before} -> ${before + added.length}  (+${added.length} new)`);
  if (refused.length) console.log(`refused           ${refused.length}\n  ${refused.join("\n  ")}`);
  console.log("");
  for (const e of added) console.log(`  + ${e.year}  ${e.sourceRef.split("/").pop().padEnd(7)}  ${String(e.estimatedCards).padStart(4)} cards  ${e.setName}`);

  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); return; }

  // Appended, never sorted in. See the header.
  for (const e of added) doc.entries.push(e);

  // `totals` is a REPORT OF THE SEEDING RUN. This script adds entries the
  // seeding run never saw, so the per-lane count is updated to stay true --
  // and `seeded.missing` with it, since that is the status every new row
  // carries. The SHAPE is preserved exactly; rewriting it to a bare number
  // (which an earlier pass on the modern extender did) destroys what the
  // builder emits.
  if (doc.totals && doc.totals.byLane && doc.totals.byLane.tcgdexja) {
    const lane = doc.totals.byLane.tcgdexja;
    lane.total += added.length;
    lane.seeded = lane.seeded || {};
    lane.seeded.missing = (lane.seeded.missing || 0) + added.length;
  }
  if (doc.totals && typeof doc.totals.entries === "number") doc.totals.entries += added.length;

  const out = (JSON.stringify(doc, null, INDENT) + "\n").replace(/\r?\n/g, EOL);
  fs.writeFileSync(MANIFEST, out);
  console.log(`\nWROTE ${MANIFEST}  (${EOL === "\r\n" ? "CRLF" : "LF"}, indent ${JSON.stringify(INDENT)} — the file's own)`);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(1); });
