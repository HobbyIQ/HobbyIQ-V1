#!/usr/bin/env node
/**
 * CF-ULTRA-IS-NOT-FLEER repair (Drew, 2026-08-17).
 *
 * Re-derives the setKey segment of hobbyiqCardId from the row's own vendor
 * setName, for rows currently sitting on a given setKey.
 *
 * WHY. normalizeSetKey had no `ultra` rule, so "1995-96 Fleer Ultra" fell
 * through to the bare-fleer catch-all and every Ultra card filed as Fleer.
 * 55,373 of 352,825 sold_comps rows on a `fleer` setKey carry "Ultra" in their
 * own title or setName. Fleer and Ultra are different cards at the same
 * numbers — 1995-96 Fleer #25 is Will Perdue, Ultra #25 is Michael Jordan — so
 * the collapse pooled unrelated sales. The vocabulary is fixed; this moves the
 * rows it already mis-filed.
 *
 * DERIVED THROUGH THE SHIPPED RESOLVER. setKey comes from resolveSetKeyForSlug
 * out of dist/, the same function ingest uses, so a repaired row cannot
 * disagree with a freshly ingested one.
 *
 * ONLY-IMPROVE, ENFORCED. A row moves only when the re-derived key is
 * genuinely different and genuinely better — not year-prefixed, not a bare
 * manufacturer, not "unknown", and never an ANCESTOR of the key it already
 * has (see isDemotion). Rows whose setName is only "fleer" while the TITLE
 * says Ultra are LEFT ALONE on purpose: the title is untrusted parser input,
 * and guessing from it would move rows on evidence we would not accept at
 * ingest.
 *
 * The ancestor rule was MISSING until 2026-08-18, and this comment claimed
 * the guarantee anyway. `topps` and `bowman` are not bare manufacturers by
 * the isUseless test, so demoting topps-traded-tiffany -> topps was legal.
 * Do not trust a header over a test again.
 *
 * Only field 3 changes. Parallel, auto and serial segments carry across
 * untouched, so a row cannot lose specificity it already had, and
 * hobbyiqCardIdBefore records the original so the pass is reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/reslug-setkey-from-setname.cjs \
 *     --from=fleer [--to=ultra] [--apply] [--pool=12] [--limit=N]
 *
 *   --to  optional guard: only move rows that re-derive to exactly this key.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const {
  resolveSetKeyForSlug,
  deriveParentSetKey,
} = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const FROM = arg("from", "");
const TO = arg("to", "");
/**
 * CF-NO-CROSS-VERTICAL-FALLBACK (2026-08-17). Select by slug PREFIX instead of
 * by a single current setKey.
 *
 * The Pokemon contamination is spread across every sports key the old fallback
 * happened to match — panini-obsidian, panini-zenith, panini-origins, leaf,
 * ultra — so there is no one `--from` that reaches it. `--prefix=hiq:pokemon:`
 * takes the whole vertical and lets the resolver decide each row on its own
 * setName. Only-improve still applies, so a row already on the right key is a
 * no-op rather than a rewrite.
 */
const PREFIX = arg("prefix", "");
const POOL = Math.max(1, Number(arg("pool", "12")));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const APPLY = has("apply");

const BARE_MANUFACTURER = new Set(["panini", "fleer", "unknown", ""]);
const isYearPrefixed = (k) => /^(19|20)\d{2}-/.test(k);
const isUseless = (k) => BARE_MANUFACTURER.has(k) || isYearPrefixed(k);

/**
 * CF-RESLUG-NO-DEMOTION (Drew, 2026-08-18).
 *
 * The only-improve doctrine says re-canonicalize ONLY when the new key is
 * strictly more specific — never demote. Until now this script enforced no
 * such thing: the sole test was `next !== current` plus isUseless(next), and
 * isUseless only catches bare `panini`/`fleer`/`unknown`. `topps` and `bowman`
 * are NOT in that set, so a row correctly filed as topps-traded-tiffany whose
 * setName reads only "Topps" would happily demote to `topps` — collapsing a
 * $1,000-median Tiffany pool into a $105-median flagship one. In --prefix mode
 * there is not even a --from to bound the blast radius.
 *
 * A demotion is precisely "next is an ANCESTOR of current" in the product
 * family ladder, so ask the ladder rather than pattern-matching strings:
 * walk up from current and refuse if we meet next. Lateral moves (topps ->
 * fleer-update, a genuine mis-file correction) are NOT ancestors and stay
 * allowed — this blocks losing specificity, not changing branch.
 *
 * The `seen` set is a cycle guard: a future ladder edit that accidentally
 * makes two keys each other's parent must not hang a sweep over 3M rows.
 */
function isDemotion(current, next) {
  const seen = new Set([current]);
  let p = deriveParentSetKey(current);
  while (p && !seen.has(p)) {
    if (p === next) return true;
    seen.add(p);
    p = deriveParentSetKey(p);
  }
  return false;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!FROM && !PREFIX) { console.error("need --from=<current setKey> or --prefix=<slug prefix>"); process.exit(2); }

  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[reslug-setkey] from=${FROM}${TO ? ` to=${TO}` : ""} mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  const iter = sold.items.query(
    PREFIX
      ? {
          query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setName, c.sport
                  FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)`,
          parameters: [{ name: "@p", value: PREFIX }],
        }
      : {
          query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setName, c.sport
                  FROM c WHERE CONTAINS(c.hobbyiqCardId, @seg)`,
          parameters: [{ name: "@seg", value: `:${FROM}:` }],
        },
    { maxItemCount: 1000 },
  );

  let scanned = 0, moved = 0, noSetName = 0, notBetter = 0, demoted = 0, failed = 0;
  const destinations = new Map();

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    const work = [];
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      const parts = String(r.hobbyiqCardId).split(":");
      // hiq:sport:year:setKey:cardNumber:parallel:auto[:printRun]
      if (parts.length < 7) continue;
      // In --from mode the current key must match exactly. In --prefix mode
      // every key under the prefix is in scope and the resolver decides.
      if (FROM && parts[3] !== FROM) continue;
      if (!r.setName) { noSetName++; continue; }

      const year = Number(parts[2]) || 0;
      const next = resolveSetKeyForSlug(parts[1], String(r.setName), year);
      if (!next || next === parts[3] || isUseless(next)) { notBetter++; continue; }
      // Never trade a specific key for one of its own ancestors.
      if (isDemotion(parts[3], next)) { demoted++; continue; }
      if (TO && next !== TO) { notBetter++; continue; }

      parts[3] = next;
      work.push({ r, next: parts.join(":"), key: next });
    }

    let cursor = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (cursor < work.length) {
        const { r, next, key } = work[cursor++];
        destinations.set(key, (destinations.get(key) || 0) + 1);
        if (!APPLY) { moved++; continue; }
        try {
          await sold.item(r.id, r.cardId).patch([
            { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
            { op: "set", path: "/hobbyiqCardId", value: next },
          ]);
          moved++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 80)}`);
        }
      }
    }));
    if (scanned % 25000 < 1000) process.stderr.write(`\r  scanned=${scanned} moved=${moved}    `);
  }
  process.stderr.write("\n");

  console.log("\nwhere the rows went:");
  [...destinations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));
  console.log(`\nscanned=${scanned} moved=${moved} noSetName=${noSetName} leftAlone=${notBetter} demotionsBlocked=${demoted} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
