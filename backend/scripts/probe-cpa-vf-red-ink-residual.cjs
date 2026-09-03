#!/usr/bin/env node
/**
 * probe-cpa-vf-red-ink-residual.cjs -- READ ONLY, one card, one question.
 *
 * historicalBackfill.service.ts documents the CPA-VF Red Ink defect as FIXED
 * on 2026-08-31: 50 vendor sales whose CH variant field said "Base" were
 * relabelled "Black & White Red Ink" and written onto
 * hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto,
 * dropping the holding's FMV to $9.38. The fix wired parallelTheTitleAllows
 * into THAT path.
 *
 * The per-source probe found cardhedge rows still sitting on that exact slug
 * with titles that name no finish. So the question this settles is narrow and
 * falsifiable: is the pool STILL carrying title-silent rows on the Red Ink
 * slug, and if so, what does the pool look like split by title evidence?
 *
 * A FIX ON ONE PATH IS NOT A FIX ON THE POOL. Two things can both be true:
 * the write path was repaired, and the rows it wrote before the repair are
 * still being read into the live pool -- and that is exactly what POOL-1
 * (readExactPoolRows applies no flaggedWrong/excludedFromFmv filter) would
 * let happen even for rows that were later adjudicated wrong.
 *
 * Partition-scoped equality on the slug. No writes.
 */
"use strict";

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
const SLUG = process.env.SLUG || "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto";
const BASE_SLUG = process.env.BASE_SLUG || "hiq:baseball:2026:bowman-chrome:cpa-vf:base:auto";

const FINISH = /(?:^|[^a-z])(refractor|shimmer|wave|prizm|mojo|x-?fractor|red ink|ink)(?:[^a-z]|$)/i;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient({ connectionString: conn }).database(DB_NAME).container(CONTAINER);

  for (const slug of [SLUG, BASE_SLUG]) {
    const { resources } = await c.items.query({
      query: "SELECT c.id, c.source, c.title, c.parallel, c.price, c.soldAt, c.flaggedWrong, c.excludedFromFmv, c.gradeCompany, c.gradeValue FROM c WHERE c.hobbyiqCardId = @s OR c.cardId = @s",
      parameters: [{ name: "@s", value: slug }],
    }, { maxItemCount: 1000 }).fetchAll();

    const rows = resources || [];
    const silent = rows.filter((r) => !FINISH.test(String(r.title || "")));
    const flagged = rows.filter((r) => r.flaggedWrong === true || r.excludedFromFmv === true);
    const live = rows.filter((r) => r.flaggedWrong !== true && r.excludedFromFmv !== true);
    const silentLive = live.filter((r) => !FINISH.test(String(r.title || "")));
    const px = (a) => a.length ? { n: a.length, min: Math.min(...a.map((r) => r.price)), max: Math.max(...a.map((r) => r.price)), med: a.map((r) => r.price).sort((x, y) => x - y)[Math.floor(a.length / 2)] } : { n: 0 };

    console.log(`\n=== ${slug}`);
    console.log(`  rows ${rows.length}   title-silent ${silent.length}   adjudicated(flaggedWrong|excludedFromFmv) ${flagged.length}`);
    console.log(`  LIVE (what readExactPoolRows returns): ${live.length}   of which title-silent: ${silentLive.length}`);
    console.log(`  price all   ${JSON.stringify(px(rows))}`);
    console.log(`  price silent${JSON.stringify(px(silentLive))}`);
    console.log(`  price named ${JSON.stringify(px(live.filter((r) => FINISH.test(String(r.title || "")))))}`);
    const bySrc = {};
    for (const r of silentLive) bySrc[r.source || "?"] = (bySrc[r.source || "?"] || 0) + 1;
    console.log(`  silent-live by source ${JSON.stringify(bySrc)}`);
    silentLive.slice(0, 6).forEach((r) => console.log(`    $${r.price} ${r.soldAt?.slice(0, 10)} [${r.source}] par=${JSON.stringify(r.parallel)} :: ${String(r.title || "").slice(0, 95)}`));
  }
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(9); });
