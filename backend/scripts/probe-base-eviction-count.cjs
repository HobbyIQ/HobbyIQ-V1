#!/usr/bin/env node
/**
 * probe-base-eviction-count.cjs -- READ ONLY. How many rows could the
 * BASE-EVICTION subclass ever touch?
 *
 * Answers the size question BEFORE a fleet runs, using the same three evidence
 * fields the classifier uses, so the number is the subclass's own and not a
 * proxy for it. There is no write path in this file.
 *
 * WHY THE NARROWING IS DONE IN SQL AND THE REST ON READ
 *
 * Two of the three evidence fields are indexable and are pushed into Cosmos as
 * a COUNT, so the corpus-wide number costs one aggregate rather than a scan of
 * 16.3M documents (which does not finish inside a sane budget):
 *
 *   1. the row's own parallel field is Base/blank          -- SQL
 *   2. the row sits on a slug carrying a finish child      -- SQL, as a
 *      CONTAINS over the parallel segment's known finishes
 *
 * The third -- the title names no finish -- is the classifier's own
 * `titleNamesFinish`, which is a closed word-exact vocabulary and cannot be
 * expressed as SQL without drifting from the code that decides. So it is
 * measured on a BOUNDED SAMPLE of the SQL-narrowed population and reported as
 * a rate, together with the fourth gate (a checklist-backed base destination),
 * which needs a card_catalog read per distinct destination.
 *
 * The headline number is therefore: SQL-narrowed count x title-pass rate x
 * destination-backed rate, with every factor printed so the arithmetic is
 * checkable rather than asserted.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      SAMPLE=1200   how many narrowed rows to title- and destination-check
 */
"use strict";
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const SAMPLE = Number(process.env.SAMPLE || 1200);
const f = (n) => Number(n ?? 0).toLocaleString();
const retry = async (fn, tries = 8) => { let w = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const m = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e; await new Promise((r) => setTimeout(r, w)); w = Math.min(w * 2, 15000); } } };

/** The parallel-field-is-blank predicate, shared by the count and the sample. */
const BLANK_PARALLEL = `(NOT IS_DEFINED(c.parallel) OR c.parallel = null OR c.parallel = "" OR LOWER(c.parallel) IN ("base", "[base]", "none", "unknown"))`;
/** The commonest finish children, as slug segments. A slug's parallel segment
 *  sits between the card number and the auto flag, so `:<finish>` with a
 *  trailing `:` is a tight enough probe for a SIZE question -- the classifier
 *  still reads the segment by POSITION when it decides. */
const SLUG_FINISHES = ["refractor", "prizm", "shimmer", "holo", "foil", "wave", "mojo", "sapphire", "optic", "mosaic", "lava", "disco", "pulsar", "laser", "atomic", "canvas", "velocity", "hyper", "sparkle", "x-fractor", "superfractor"];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn }).database("hobbyiq");
  const pool = db.container("sold_comps"), cat = db.container("card_catalog");

  const slugWhere = `(${SLUG_FINISHES.map((s, i) => `CONTAINS(c.cardId, @f${i})`).join(" OR ")})`;
  const slugParams = SLUG_FINISHES.map((s, i) => ({ name: `@f${i}`, value: `:${s}:` }));

  const scopes = [
    { name: "corpus-wide", where: "", params: [] },
    { name: "bowman-only", where: " AND CONTAINS(c.cardId, ':bowman')", params: [] },
  ];

  const CHECKLIST_SOURCE_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
  const destCache = new Map();

  for (const s of scopes) {
    // ── 1. the SQL-narrowed count (server-side aggregate) ──────────────────
    const countQ = {
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${BLANK_PARALLEL} AND ${slugWhere}${s.where}`,
      parameters: [...slugParams, ...s.params],
    };
    const { resources: cnt } = await retry(() => pool.items.query(countQ, { maxItemCount: 1 }).fetchAll());
    const narrowed = Number(cnt?.[0] ?? 0);

    // ── 2. the title + destination gates, on a bounded sample ──────────────
    const sampleQ = {
      query: `SELECT TOP @n c.id, c.cardId, c.title, c.parallel, c.source, c.verifiedByUser, c.drewRuling, c.handRelocated, c.rekeyedReason FROM c WHERE ${BLANK_PARALLEL} AND ${slugWhere}${s.where}`,
      parameters: [{ name: "@n", value: SAMPLE }, ...slugParams, ...s.params],
    };
    const { resources: rows } = await retry(() => pool.items.query(sampleQ, { maxItemCount: 500 }).fetchAll());

    let titlePass = 0, prot = 0, destChecked = 0, destBacked = 0;
    const examples = [];
    for (const r of rows) {
      // Re-assert the slug gate with the classifier's own positional reader --
      // the SQL CONTAINS is a coarse probe and may admit a set name.
      if (!K.slugNamesParallel(r.cardId)) continue;
      if (!r.title || K.titleNamesFinish(r.title)) continue;
      titlePass++;
      if (K.provenanceTier(r).tier === K.PROTECTED) { prot++; continue; }

      const parts = String(r.cardId).split(":");
      const rest = parts.slice(6).filter((p) => !/^num-\d+$/.test(p));
      const dest = [...parts.slice(0, 5), "base", ...rest].join(":");
      let ok = destCache.get(dest);
      if (ok === undefined) {
        ok = false;
        try {
          const { resource } = await retry(() => cat.item(dest, dest).read());
          if (resource) {
            const src = String(resource.source ?? resource.sourceSystem ?? "");
            const srcs = Array.isArray(resource.sources) ? resource.sources.join(",") : "";
            ok = CHECKLIST_SOURCE_RE.test(src) || CHECKLIST_SOURCE_RE.test(srcs) || resource.checklistBacked === true;
          }
        } catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
        destCache.set(dest, ok);
      }
      destChecked++;
      if (ok) { destBacked++; if (examples.length < 6) examples.push(`${r.cardId}  "${String(r.title).slice(0, 62)}"  ->  ${dest}`); }
    }

    const titleRate = rows.length ? titlePass / rows.length : 0;
    const destRate = destChecked ? destBacked / destChecked : 0;
    const protRate = titlePass ? prot / titlePass : 0;
    const est = Math.round(narrowed * titleRate * (1 - protRate) * destRate);

    console.log(`\n${s.name}`);
    console.log(`  parallel field Base/blank AND on a finish slug   ${f(narrowed)}   (SQL aggregate)`);
    console.log(`  sample                                           ${f(rows.length)} rows`);
    console.log(`    title names no finish                          ${f(titlePass)}  (${(titleRate * 100).toFixed(1)}%)`);
    console.log(`    of those, PROTECTED (never writable)           ${f(prot)}  (${(protRate * 100).toFixed(1)}%)`);
    console.log(`    checklist-backed base destination exists       ${f(destBacked)} of ${f(destChecked)}  (${(destRate * 100).toFixed(1)}%)`);
    console.log(`  ESTIMATED qualifying, writable                   ~${f(est)}`);
    if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(`    ${e}`); }
  }
  console.log(`\nREAD ONLY -- this probe writes nothing.`);
}
main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
