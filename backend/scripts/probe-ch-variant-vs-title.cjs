#!/usr/bin/env node
/**
 * probe-ch-variant-vs-title.cjs -- READ ONLY, one focused question.
 *
 * chRowToSoldComp.ts:164 writes `parallel: row.variant || "Base"` -- the
 * CardHedge PRODUCT variant becomes the SALE's parallel, and recordSoldComp
 * (unlike persistVendorSalesToPool) never runs parallelTheTitleAllows. If that
 * is a real root and not a code-reading, cardhedge Bowman rows on refractor
 * slugs should show titles that name no finish at a materially higher rate
 * than the other sources do.
 *
 * A ROOT NAMED FROM CODE IS A HYPOTHESIS. This is the measurement that makes
 * it a finding: same predicate, per source, so the sources are compared
 * against each other rather than against an absolute the corpus cannot supply.
 *
 * Indexed equality on c.source, _ts range walk, no field-vs-field predicate.
 */
"use strict";

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
const SOURCES = (process.env.SOURCES || "cardhedge,cardsight,tca-ebay,ebay-user-purchase").split(",");
const PER_SOURCE = Number(process.env.PER_SOURCE || 30000);

const FINISH = /(?:^|[^a-z])(refractor|refractors|shimmer|wave|prizm|prism|mojo|x-?fractor|superfractor|lava|sapphire|foilboard|atomic|speckle|sparkle)(?:[^a-z]|$)/i;
const COLOUR = /(?:^|[^a-z])(green|gold|blue|orange|red|purple|black|silver|pink|yellow|teal|bronze|platinum|aqua|fuchsia)(?:[^a-z]|$)/i;
const TEAM_NOISE = [/\bred\s+sox\b/gi, /\bwhite\s+sox\b/gi, /\bblue\s+jays\b/gi, /\bblack\s*(?:&|and)\s*white\b/gi, /\bgreen\s+bay\b/gi, /\bcincinnati\s+reds\b/gi];
const clean = (t) => { let s = String(t || "").toLowerCase(); for (const r of TEAM_NOISE) s = s.replace(r, " "); return s; };

const slugParts = (id) => {
  const s = String(id || "");
  if (!s.startsWith("hiq:")) return null;
  const p = s.split(":");
  return p.length >= 7 ? { setKey: p[3], parallel: (p[5] || "").toLowerCase() } : null;
};
const isBowman = (k) => /^bowman(-|$)/.test(String(k || ""));
const BASE_SEG = new Set(["base", "", "no-parallel", "none"]);
const segClaimsFinish = (seg) => {
  if (BASE_SEG.has(seg)) return false;
  return FINISH.test(seg.replace(/-/g, " ")) || COLOUR.test(seg.replace(/-/g, " "));
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } })
    .database(DB_NAME).container(CONTAINER);

  const out = {};
  for (const src of SOURCES) {
    let seen = 0, bowman = 0, finishSlug = 0, silentTitle = 0, storedBaseToo = 0;
    const examples = [];
    const it = c.items.query({
      // indexed equality on source; ORDER BY _ts keeps the read on the index
      query: "SELECT c.hobbyiqCardId, c.cardId, c.title, c.parallel FROM c WHERE c.source = @s ORDER BY c._ts DESC",
      parameters: [{ name: "@s", value: src }],
    }, { maxItemCount: 1000 });
    while (it.hasMoreResults() && seen < PER_SOURCE) {
      let page;
      try { page = await it.fetchNext(); } catch (e) { console.error(`  ${src}: ${e?.message}`); break; }
      for (const r of (page.resources || [])) {
        seen++;
        const p = slugParts(r.hobbyiqCardId) || slugParts(r.cardId);
        if (!p || !isBowman(p.setKey)) continue;
        bowman++;
        if (!segClaimsFinish(p.parallel)) continue;
        finishSlug++;
        const t = clean(r.title);
        if (!FINISH.test(t) && !COLOUR.test(t)) {
          silentTitle++;
          const stored = String(r.parallel ?? "").trim().toLowerCase();
          if (stored === "" || stored === "base") storedBaseToo++;
          if (examples.length < 8) examples.push({ slugParallel: p.parallel, stored: r.parallel, title: String(r.title || "").slice(0, 110) });
        }
      }
    }
    out[src] = {
      scanned: seen, bowmanRows: bowman, onFinishSlug: finishSlug,
      titleNamesNoFinish: silentTitle,
      pctOfFinishSlugRowsSilent: finishSlug ? +(silentTitle / finishSlug * 100).toFixed(1) : null,
      alsoStoredBase: storedBaseToo,
      examples,
    };
    console.log(`${src.padEnd(20)} bowman ${String(bowman).padStart(7)}  finish-slug ${String(finishSlug).padStart(6)}  silent-title ${String(silentTitle).padStart(6)}  = ${out[src].pctOfFinishSlugRowsSilent}%`);
  }
  console.log("\n" + JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(9); });
