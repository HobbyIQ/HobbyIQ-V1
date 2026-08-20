#!/usr/bin/env node
/**
 * CF-CHECKLIST-RECONCILE (Drew, 2026-08-20: "lets get to work on the checklist").
 *
 * Compares print runs scraped from checklistinsider against what the catalog
 * already holds. WRITES NOTHING.
 *
 * THE QUESTION IS NOT "what did we scrape" BUT "what did we not already know".
 * A scrape that mostly restates the catalog is worth little; one that supplies
 * print runs we lack is worth a great deal. Only the diff separates them, and
 * only per-set — a source can be excellent for 2026 Topps and useless for 2022
 * hockey.
 *
 * PRINT RUN LIVES IN parallels[].numberedTo, NOT IN A printRun FIELD. Checked
 * against real rows on 2026-08-20: card_catalog documents carry
 * `parallels: [{ id, name, numberedTo }]` and have no top-level printRun at all.
 * An earlier draft of this script queried `c.printRun` and would have reported
 * every single row as FILLABLE — a 100% "win" that was pure schema error.
 *
 * FOUR OUTCOMES, kept apart because they call for different work:
 *
 *   KNOWN      we hold the parallel AND the same run     corroboration
 *   FILLABLE   we hold it with numberedTo null           the prize
 *   CONFLICT   we hold it with a DIFFERENT run           read before touching
 *   NEW        we do not hold the parallel at all        a catalog gap
 *
 * CONFLICT IS NOT AUTOMATICALLY OURS TO LOSE. A scraped page can be wrong, and
 * a checklist published pre-release is routinely revised. Conflicts are printed
 * for a human and never resolved by a rule. This source exists to stop us
 * INFERRING print runs from noisy text; silently overwriting on scrape would
 * reintroduce that in a new costume.
 *
 * SUBSET AND PARALLEL ARE DERIVED FROM THE WORKBOOK, NOT GUESSED. Column A
 * conflates them — "2021 Panini Impeccable Football - Canvas Creations Gold" is
 * a subset plus a parallel, with no delimiter between them. Rather than invent a
 * split rule, the product's own vocabulary decides it: a column-A value that
 * appears STANDALONE is a subset, and any value extending a standalone one is
 * that subset plus the remainder as its parallel. Verified on Impeccable, which
 * yields Gold / Platinum / Silver / Printing Plate Cyan and friends without a
 * single hand-written parallel name.
 *
 * A LEADING YEAR IN COLUMN A IS A CLAIM, NOT A FACT. "1997 Limited Exposure" is
 * a 2023 card using a 1997 design; "2021 Panini Impeccable Football" names a
 * prior-year product. The two are indistinguishable by shape, so rows whose
 * subset states a year different from the page are COUNTED AND FLAGGED rather
 * than assigned to either year.
 *
 * SET MATCHING REUSES normalizeSetKey. There is exactly one function that
 * decides what setKey a product name maps to. Re-deriving it here would create
 * the one-rule-two-implementations split that produced the setKey fragmentation
 * we spent this morning merging.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/reconcile-checklist-parallels.cjs \
 *     [--in=C:/tmp/ci-staging-all.jsonl,C:/tmp/ci-retry-all.jsonl] [--top=25]
 */

const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { normalizeSetKey, normalizeParallel } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const IN = arg("in", "C:/tmp/ci-staging-all.jsonl,C:/tmp/ci-retry-all.jsonl");
const TOP = Number(arg("top", "25"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e && e.code !== 429 && e.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, ((e && e.retryAfterInMs) || 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

/** "2026-topps-heritage-baseball" -> setKey via the ONE canonical function. */
function setKeyFromSlug(slug, yearPrefix, sport) {
  let s = String(slug);
  if (yearPrefix) s = s.slice(String(yearPrefix).length).replace(/^-/, "");
  if (sport) s = s.replace(new RegExp(`-${sport}$`), "");
  return normalizeSetKey(s.replace(/-/g, " "));
}

const YEAR_RE = /^((?:19|20)\d{2})\b\s*/;

/**
 * Split every column-A value in ONE product into (subset, parallel), using the
 * product's own vocabulary rather than a guessed delimiter.
 */
function deriveSplits(values) {
  const standalone = new Set(values);
  const out = new Map();
  for (const v of values) {
    let best = null;
    for (const s of standalone) {
      if (s === v) continue;
      if (v.startsWith(`${s} `) && (best === null || s.length > best.length)) best = s;
    }
    out.set(v, best ? { subset: best, parallel: v.slice(best.length).trim() } : { subset: v, parallel: null });
  }
  return out;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }

  // ── 1. Load every staging file. ─────────────────────────────────────────
  const files = IN.split(",").map((f) => f.trim()).filter(Boolean).filter((f) => {
    if (fs.existsSync(f)) return true;
    console.log(`  (skipping absent staging file ${f})`);
    return false;
  });
  if (!files.length) { console.error("FATAL: no staging files found"); process.exit(1); }

  // Later files WIN — a retry supersedes the run it is retrying.
  const bySlug = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      bySlug.set(r.slug, r);
    }
  }

  /** "year|setKey" -> Map(parallelSlug -> { name, printRun, cards:Set }) */
  const scraped = new Map();
  let pages = 0, stubs = 0, unparsed = 0, cardRows = 0, yearFlagged = 0, noSetKey = 0;
  for (const r of bySlug.values()) {
    pages++;
    if (r.isStub) { stubs++; continue; }
    if (r.bookUnparsed) unparsed++;
    const setKey = setKeyFromSlug(r.slug, r.yearPrefix, r.sport);
    if (!setKey) { noSetKey++; continue; }
    const k = `${r.year}|${setKey}`;
    let e = scraped.get(k);
    if (!e) scraped.set(k, (e = { slug: r.slug, sport: r.sport, year: r.year, setKey, parallels: new Map() }));

    // Product-level ladder from the HTML page.
    for (const p of r.parallels || []) {
      if (p.printRun == null) continue;
      const ps = normalizeParallel(p.parallel);
      if (!ps) continue;
      if (!e.parallels.has(ps)) e.parallels.set(ps, { name: p.parallel, printRun: p.printRun, from: "ladder", cards: 0 });
    }

    // Card-level runs from the workbook — the far richer source.
    const withRun = (r.cards || []).filter((c) => c.printRun && c.subset);
    const splits = deriveSplits([...new Set((r.cards || []).map((c) => c.subset).filter(Boolean))]);
    for (const c of withRun) {
      cardRows++;
      const raw = String(c.subset);
      // A subset stating a DIFFERENT year than the page is a claim we cannot
      // resolve: retro-design insert, or a genuine prior-year product? Counted,
      // not assigned.
      const ym = YEAR_RE.exec(raw);
      if (ym && Number(ym[1]) !== r.year) { yearFlagged++; continue; }
      const sp = splits.get(raw);
      if (!sp || !sp.parallel) continue;      // base cards carry no parallel
      const ps = normalizeParallel(sp.parallel);
      if (!ps) continue;
      const prev = e.parallels.get(ps);
      if (!prev) { e.parallels.set(ps, { name: sp.parallel, printRun: c.printRun, from: "workbook", cards: 1 }); continue; }
      prev.cards++;
      // Workbook beats ladder: it is per-card, so it can distinguish cards in
      // one parallel that are serialised differently.
      if (prev.from === "ladder" && c.printRun !== prev.printRun) {
        e.parallels.set(ps, { name: sp.parallel, printRun: c.printRun, from: "workbook", cards: prev.cards });
      }
    }
  }

  console.log(`[reconcile] staging files : ${files.length}`);
  console.log(`  products              : ${pages.toLocaleString()}`);
  console.log(`  stubs (no data)       : ${stubs.toLocaleString()}`);
  console.log(`  workbook unparsed     : ${unparsed.toLocaleString()}`);
  console.log(`  setKey underivable    : ${noSetKey.toLocaleString()}`);
  console.log(`  card rows with a run  : ${cardRows.toLocaleString()}`);
  console.log(`  YEAR-FLAGGED (skipped): ${yearFlagged.toLocaleString()}   subset names a different year than the page`);
  console.log(`  (year, setKey) products: ${scraped.size.toLocaleString()}`);
  console.log(`  distinct parallels     : ${[...scraped.values()].reduce((s, e) => s + e.parallels.size, 0).toLocaleString()}\n`);

  // ── 2. What does the catalog hold for those sets? ────────────────────────
  const have = new Map();   // "year|setKey" -> Map(parallelSlug -> Set(run|null))
  await scanAll("card_catalog", {
    query: `SELECT c.year, c.setKey, c.parallels FROM c
             WHERE IS_DEFINED(c.setKey) AND IS_DEFINED(c.year) AND IS_DEFINED(c.parallels)`,
    parameters: [],
  }, (r) => {
    const k = `${r.year}|${r.setKey}`;
    if (!scraped.has(k)) return;           // only the sets we scraped
    if (!Array.isArray(r.parallels)) return;
    let m = have.get(k);
    if (!m) have.set(k, (m = new Map()));
    for (const p of r.parallels) {
      const ps = normalizeParallel(p && p.name);
      if (!ps) continue;
      let s = m.get(ps);
      if (!s) m.set(ps, (s = new Set()));
      const n = Number(p.numberedTo);
      s.add(Number.isFinite(n) && n > 0 ? n : null);
    }
  }, "catalog");

  // ── 3. Diff. ─────────────────────────────────────────────────────────────
  let known = 0, fillable = 0, conflict = 0, isNew = 0, noSet = 0;
  const conflicts = [], news = [], fills = [], noSetEx = new Map();
  for (const [k, e] of scraped) {
    const mine = have.get(k);
    if (!mine) {
      noSet += e.parallels.size;
      if (noSetEx.size < TOP) noSetEx.set(k, `${e.year} ${e.setKey.padEnd(30)} <- ${e.slug}`);
      continue;
    }
    for (const [ps, p] of e.parallels) {
      const runs = mine.get(ps);
      if (!runs) { isNew++; if (news.length < TOP) news.push(`${e.year} ${String(e.setKey).padEnd(26)} ${String(p.name).slice(0, 28).padEnd(30)} /${p.printRun}`); continue; }
      if (runs.has(p.printRun)) { known++; continue; }
      if (runs.size === 1 && runs.has(null)) {
        fillable++;
        if (fills.length < TOP) fills.push(`${e.year} ${String(e.setKey).padEnd(26)} ${String(p.name).slice(0, 28).padEnd(30)} -> /${p.printRun}  (${p.from}${p.cards ? `, ${p.cards} cards` : ""})`);
        continue;
      }
      conflict++;
      if (conflicts.length < TOP) conflicts.push(`${e.year} ${String(e.setKey).padEnd(22)} ${String(p.name).slice(0, 24).padEnd(26)} ours=${[...runs].join(",")} theirs=/${p.printRun}`);
    }
  }

  const tot = known + fillable + conflict + isNew + noSet;
  const pc = (n) => `${((n / Math.max(tot, 1)) * 100).toFixed(1)}%`;
  console.log(`scraped parallels judged : ${tot.toLocaleString()}\n`);
  console.log(`  KNOWN    (same run)    : ${known.toLocaleString()}  ${pc(known)}   corroborates us`);
  console.log(`  FILLABLE (numberedTo null): ${fillable.toLocaleString()}  ${pc(fillable)}   <- the prize`);
  console.log(`  CONFLICT (run differs) : ${conflict.toLocaleString()}  ${pc(conflict)}   a human decides`);
  console.log(`  NEW      (not in cat)  : ${isNew.toLocaleString()}  ${pc(isNew)}   catalog gap`);
  console.log(`  set not matched        : ${noSet.toLocaleString()}  ${pc(noSet)}   setKey miss OR set unknown\n`);

  const show = (t, a) => { if (!a.length) return; console.log(t); for (const l of a) console.log(`   ${l}`); console.log(""); };
  show("FILLABLE - print runs we could adopt:", fills);
  show("CONFLICT - a human decides these:", conflicts);
  show("NEW - parallels absent from the catalog:", news);
  show("SET NOT MATCHED - check before trusting that number:", [...noSetEx.values()]);

  console.log("READ-ONLY. Nothing adopted. A scraped page is evidence, not authority -");
  console.log("pre-release checklists get revised, so CONFLICT is never auto-resolved.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
