#!/usr/bin/env node
/**
 * CF-REMATCH-DIAGNOSTIC (Drew, 2026-08-19: "lets do the rematch or diagnostic
 * pass").
 *
 * Reports what a catalog-first rematch WOULD do, without doing any of it.
 *
 * WHY A DIAGNOSTIC FIRST. The plan is to stop reconstructing a card's parallel
 * and print run from seller text and start selecting them from the checklist
 * ladder. That is strictly better — free-text extraction is what read `2024` as
 * a print run 1,666 times and scored "Charlotte" as a lot. But a rematch is the
 * largest blast radius in this codebase, and the failure mode of the whole
 * session has been a right mechanism pointed the wrong way. So: measure the
 * change distribution, then decide.
 *
 * THE JOIN KEY IS THE WHOLE PROBLEM, AND IT IS NOT hobbyiqCardId.
 * card_catalog runs a deliberate grade explode — one row per (card, grade) —
 * so a card has ~12 rows whose slugs differ only in a trailing grade tier
 * (`:psa-10`, `:bgs-10-black`, `:raw`). Joining on hobbyiqCardId treats each as
 * a separate card and manufactures ORPHANs. Joining on parentSlug alone drops
 * every ungraded row, which is most of them. cardIdentityKey() resolves both,
 * and is imported rather than reimplemented — a second copy of a rule is how
 * several bugs in this effort were born.
 *
 * PRINT RUN IS IDENTITY, AND THAT IS THE INTERESTING CASE. A Gold /50 is a
 * different card from a Refractor /499, so the print run stays in the key. But
 * a comp whose slug LACKS a serial may still be that /50 — the vendor title
 * simply never said so. Where the catalog knows exactly ONE print run for that
 * card, the rematch can supply it from the checklist instead of a regex. That
 * is the enrichment this whole pivot is for, and it is counted separately from
 * cases where the catalog offers several and cannot choose.
 *
 * FILL-ONLY IS THE INTENDED SEMANTIC. Nothing here proposes overwriting a
 * populated segment. backfill-parallel-enrichment demonstrated the alternative:
 * its dry run re-derived whole slugs and pushed bowman:cpa-eha back to
 * bowman-chrome:cpa-eha, re-splitting a pool that had just been merged.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/diagnose-catalog-rematch.cjs \
 *     [--sport=baseball] [--family=bowman] [--years=2023-2026] [--top=20]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { cardIdentityKey } = require(path.join(backend, "dist/services/portfolioiq/cardIdentityKey.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const FAMILY = arg("family", "bowman");
const [Y0, Y1] = arg("years", "2023-2026").split("-").map(Number);
const TOP = Number(arg("top", "20"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(containerName, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(containerName);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
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
      if (legPages >= REFRESH_PAGES) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

/** Split an identity slug into its card part and its print-run segment. */
function splitPrintRun(slug) {
  const parts = String(slug).split(":");
  if (parts.length > 7 && parts[7].startsWith("num-")) {
    return { base: parts.slice(0, 7).join(":"), printRun: parts[7].slice(4) };
  }
  return { base: parts.slice(0, 7).join(":"), printRun: null };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[rematch-diagnostic] sport=${SPORT} family=${FAMILY} years=${Y0}-${Y1}\n`);

  // ── The catalog, collapsed to CARD identities ────────────────────────────
  const identities = new Set();          // full identity incl. print run
  const printRunsFor = new Map();        // card base -> Set(print run)
  let catRows = 0, gradeCollapsed = 0;
  await scanAll("card_catalog", {
    query: `SELECT c.hobbyiqCardId, c.parentSlug FROM c
             WHERE STARTSWITH(c.setKey, @f) AND c.year >= @y0 AND c.year <= @y1
               AND IS_DEFINED(c.hobbyiqCardId)`,
    parameters: [{ name: "@f", value: FAMILY }, { name: "@y0", value: Y0 }, { name: "@y1", value: Y1 }],
  }, (r) => {
    catRows++;
    const id = cardIdentityKey(r);
    if (!id) return;
    if (id !== r.hobbyiqCardId) gradeCollapsed++;
    identities.add(id);
    const { base, printRun } = splitPrintRun(id);
    if (printRun) {
      if (!printRunsFor.has(base)) printRunsFor.set(base, new Set());
      printRunsFor.get(base).add(printRun);
    }
  }, "catalog");

  console.log(`catalog rows            : ${catRows.toLocaleString()}`);
  console.log(`  collapsed by grade    : ${gradeCollapsed.toLocaleString()}  <- would be phantom cards on a naive join`);
  console.log(`distinct CARD identities: ${identities.size.toLocaleString()}`);
  console.log(`cards with a known print run: ${printRunsFor.size.toLocaleString()}\n`);

  // ── Judge every comp ─────────────────────────────────────────────────────
  const st = { comps: 0, exact: 0, fillable: 0, ambiguous: 0, noMatch: 0, conflict: 0 };
  const fillEx = [], noEx = [], confEx = [];
  const fillBy = new Map();
  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId FROM c
             WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
    parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
  }, (r) => {
    const slug = String(r.hobbyiqCardId || "");
    const parts = slug.split(":");
    if (parts.length < 7) return;
    const y = Number(parts[2]);
    if (!(y >= Y0 && y <= Y1)) return;
    st.comps++;

    if (identities.has(slug)) { st.exact++; return; }

    const { base, printRun } = splitPrintRun(slug);
    const known = printRunsFor.get(base);

    if (!printRun) {
      // Comp has NO serial. Can the checklist supply one unambiguously?
      if (known && known.size === 1) {
        st.fillable++;
        const only = [...known][0];
        fillBy.set(only, (fillBy.get(only) ?? 0) + 1);
        if (fillEx.length < TOP) fillEx.push(`${slug}\n        -> :num-${only}`);
      } else if (known && known.size > 1) {
        st.ambiguous++;
      } else if (identities.has(base)) {
        st.exact++;   // card exists with no serial; comp is correct as-is
      } else {
        st.noMatch++;
        if (noEx.length < 8) noEx.push(slug);
      }
    } else {
      // Comp CLAIMS a serial the catalog does not list for this card.
      if (known && !known.has(printRun)) {
        st.conflict++;
        if (confEx.length < 8) confEx.push(`${slug}   catalog knows: /${[...known].join(", /")}`);
      } else {
        st.noMatch++;
        if (noEx.length < 8) noEx.push(slug);
      }
    }
  }, "comps");

  const pc = (n) => `${((n / Math.max(st.comps, 1)) * 100).toFixed(1)}%`;
  console.log(`comps judged : ${st.comps.toLocaleString()}\n`);
  console.log(`  EXACT      already matches a catalog card : ${String(st.exact).padStart(8)}  ${pc(st.exact)}`);
  console.log(`  FILLABLE   no serial, checklist knows ONE : ${String(st.fillable).padStart(8)}  ${pc(st.fillable)}   <- the win`);
  console.log(`  AMBIGUOUS  no serial, several possible    : ${String(st.ambiguous).padStart(8)}  ${pc(st.ambiguous)}`);
  console.log(`  CONFLICT   serial the checklist denies    : ${String(st.conflict).padStart(8)}  ${pc(st.conflict)}`);
  console.log(`  NO MATCH   card not in the catalog        : ${String(st.noMatch).padStart(8)}  ${pc(st.noMatch)}\n`);

  if (fillBy.size) {
    console.log("fills by print run:");
    for (const [k, n] of [...fillBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`   ${String(n).padStart(7)}  /${k}`);
    }
  }
  console.log("\nFILLABLE examples:");
  for (const e of fillEx.slice(0, 6)) console.log(`   ${e}`);
  console.log("\nCONFLICT examples (never written — the checklist and the slug disagree):");
  for (const e of confEx) console.log(`   ${e}`);
  console.log("\nNO MATCH examples:");
  for (const e of noEx) console.log(`   ${e}`);
  console.log("\nREAD-ONLY. Nothing written. FILLABLE is the only class a fill-only");
  console.log("rematch would touch; AMBIGUOUS, CONFLICT and NO MATCH are left alone.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
