#!/usr/bin/env node
/**
 * CF-SETKEY-PUNCTUATION (Drew, 2026-08-19: "Fix the setkeys to work").
 *
 * A setKey is a SLUG — lowercase, a-z 0-9 and single internal hyphens. 821
 * spellings in card_catalog break that rule, and every one of them is a
 * checklist row we own and cannot reach:
 *
 *     bowmans-best  83,583 rows   |  bowman's-best  2,353  |  bowman’s-best  96
 *     topps-allen-ginter 224,485  |  topps-allen-&-ginter  1,877
 *     topps 9,311,110             |  Topps  639
 *     2024-panini-donruss         |  "2024 Panini Donruss"  3,599
 *
 * WHY THIS IS CATALOG-ONLY, AND WHY THAT MATTERS. sold_comps was measured
 * first: 990 distinct normalizedSetKey values, ZERO not slug-clean, and a
 * 4,000-slug sample of segment 3 came back clean too. The comps are fine. So
 * this is a one-sided repair, and the harm is precisely that checklist evidence
 * we already own is unreachable from the comps that need it — a conformance
 * audit cannot see `bowman's-best` when the comps all say `bowmans-best`.
 *
 * Had the comps been dirty too, re-keying the catalog alone would have orphaned
 * them; that is why the comps were measured before anything was written.
 *
 * MAJORITY IS NOT AUTHORITY. The obvious rule — canonical = most common
 * spelling — elects `x's-and-o's` (352 vs 323), `all-out!`, `bbm-` and
 * `topps-baseball-(series-1)`, entrenching punctuation into every slug built
 * from them. The FORMAT decides: prefer the most common ALREADY-CLEAN spelling,
 * and only derive one when no clean spelling exists.
 *
 * APOSTROPHES AND COMMAS ARE DELETED, NOT HYPHENATED. Replacing every
 * non-alphanumeric with a hyphen produces `america-s-best-signatures` and
 * `1-000-yard-club`. The clean spelling that already existed for Bowman's Best
 * — `bowmans-best` — shows the intended behaviour, and the rule is chosen to
 * reproduce it rather than to look tidy in isolation.
 *
 * THREE FIELDS, NOT ONE. A dirty row carries the damage in its own slug and its
 * search tokens as well:
 *
 *     setKey        bowman's-best
 *     hobbyiqCardId hiq:baseball:2011:bowman's-best:bb19:base:no-auto
 *     searchTokens  ["tim","lincecum","bowman's","best",...]
 *
 * Fixing setKey alone would leave the row unreachable by slug AND unfindable by
 * search, which is most of what "work" means here.
 *
 * REVERSIBLE via /setKeyBefore. Partition key is /cardId, so this is a patch.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-setkey-punctuation.cjs \
 *     [--apply] [--pool=8] [--top=30]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "30"));

const isClean = (k) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k);
const strip = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
/** Apostrophes/commas/periods vanish; everything else collapses to a hyphen. */
const toClean = (k) => String(k).toLowerCase()
  .replace(/[‘’'`,.]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  console.log(`[repair-setkey-punctuation] mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // ── 1. Decide the canonical spelling for each punctuation cluster ─────────
  const { resources: keys } = await cat.items.query(
    `SELECT c.setKey AS k, COUNT(1) AS n FROM c WHERE IS_STRING(c.setKey) GROUP BY c.setKey`,
    { maxItemCount: 5000 },
  ).fetchAll();

  const byStrip = new Map();
  for (const x of keys) {
    const s = strip(x.k);
    if (!s) continue;
    if (!byStrip.has(s)) byStrip.set(s, []);
    byStrip.get(s).push([x.k, x.n]);
  }

  const canonOf = new Map();     // dirty spelling -> canonical
  let derived = 0, plannedRows = 0;
  for (const [, variants] of byStrip) {
    const sorted = variants.sort((a, b) => b[1] - a[1]);
    const clean = sorted.filter(([k]) => isClean(k));
    let canon;
    if (clean.length) canon = clean[0][0];
    else {
      canon = toClean(sorted[0][0]);
      // A derived name that is still not clean means the key was punctuation
      // all the way down; leave it rather than write something arbitrary.
      if (!isClean(canon)) continue;
      derived++;
    }
    for (const [k, n] of sorted) {
      if (k === canon) continue;
      canonOf.set(k, canon);
      plannedRows += n;
    }
  }

  console.log(`distinct setKeys              : ${keys.length.toLocaleString()}`);
  console.log(`non-canonical spellings       : ${canonOf.size.toLocaleString()}`);
  console.log(`catalog rows to re-key        : ${plannedRows.toLocaleString()}`);
  console.log(`canonical DERIVED (no clean spelling existed) : ${derived}\n`);
  if (!canonOf.size) { console.log("nothing to do."); return 0; }

  console.log("largest rewrites:");
  const ranked = [...canonOf.entries()]
    .map(([k, c]) => [k, c, keys.find((x) => x.k === k)?.n ?? 0])
    .sort((a, b) => b[2] - a[2]);
  for (const [f, t, n] of ranked.slice(0, TOP)) console.log(`   ${String(n).padStart(7)}  ${f}  ->  ${t}`);

  // ── 2. Rewrite setKey, the row's own slug, and its search tokens ─────────
  const work = [];
  {
    const iter = cat.items.query(
      `SELECT c.id, c.cardId, c.setKey, c.hobbyiqCardId, c.searchTokens FROM c WHERE IS_STRING(c.setKey)`,
      { maxItemCount: 2000 },
    );
    let n = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        n++;
        const canon = canonOf.get(r.setKey);
        if (!canon) continue;
        const patch = [
          { op: "add", path: "/setKeyBefore", value: r.setKey },
          { op: "set", path: "/setKey", value: canon },
        ];
        // The catalog row's OWN slug carries segment 3.
        if (typeof r.hobbyiqCardId === "string") {
          const parts = r.hobbyiqCardId.split(":");
          if (parts.length >= 4 && parts[3] === r.setKey) {
            parts[3] = canon;
            patch.push({ op: "set", path: "/hobbyiqCardId", value: parts.join(":") });
          }
        }
        // Tokens like "bowman's" never match a search for "bowmans".
        if (Array.isArray(r.searchTokens)) {
          const cleaned = r.searchTokens.map((t) => String(t).toLowerCase().replace(/[‘’'`,.]/g, ""));
          if (cleaned.some((t, i) => t !== r.searchTokens[i])) {
            patch.push({ op: "set", path: "/searchTokens", value: [...new Set(cleaned)] });
          }
        }
        work.push({ r, patch });
      }
      if (n % 500000 < 2000) process.stderr.write(`\r  catalog scanned=${n} matched=${work.length}   `);
    }
    process.stderr.write("\n");
  }

  console.log(`\nrows matched for repair: ${work.length.toLocaleString()}`);
  console.log("examples:");
  for (const w of work.slice(0, 5)) {
    console.log(`   ${w.r.setKey}  ->  ${w.patch.find((p) => p.path === "/setKey").value}`);
    const slug = w.patch.find((p) => p.path === "/hobbyiqCardId");
    if (slug) console.log(`      slug -> ${slug.value}`);
  }

  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await cat.item(w.r.id, w.r.cardId).patch(w.patch);
        done++;
        if (done % 2000 === 0) process.stderr.write(`\r  patched ${done}/${work.length}   `);
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.r.id}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }));

  console.log(`\n${APPLY ? "repaired" : "would repair"}=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
