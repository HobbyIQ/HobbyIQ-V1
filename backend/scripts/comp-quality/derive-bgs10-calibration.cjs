// Re-derive the BGS 10 grade ratio with Black Labels separated out, and
// measure the Black Label premium — both from OUR pool, matched by card.
//
// WHY. gradeQualifier is null on every BGS 10 row in sold_comps, so Black
// Labels — all four subgrades 10, a materially different card — have always
// been folded into BGS 10. Measured 2026-08-22 over 4,000 BGS 10 sales: 9.1%
// say "black label" in the title, at a 3.0x median price. That inflates the
// BGS 10 tile AND the stored BGS 10 ratio applied to every card in the family.
// Theo Gillen Blue Refractor /150 projected a BGS 10 of $5,904 against a $729
// raw — 8.1x — which is what prompted this.
//
// #1199 split the tier at read time. This is the other half: the stored ratio
// itself is still mixed, so it must be re-derived before the split can be
// trusted downstream.
//
// WHY IT IS SHAPED THIS WAY. The obvious query — every BGS 10 plus every raw
// sale over 540 days — times out at ten minutes. It is also the wrong shape:
// it drags the entire raw pool back to compare against a few thousand graded
// rows.
//
// Instead:
//   1. ONE query for BGS 10 rows. ~8k, bounded, cheap.
//   2. Collect only the slugs that actually have one.
//   3. Fetch raw sales for JUST those slugs, in IN() batches, paced.
//
// MATCHED BY CARD, not pooled. A corpus-wide median of graded over a
// corpus-wide median of raw compares two different card populations and mostly
// measures which cards happen to get graded. Per-card ratios then medianed is
// the matched-cohort form the calibration doctrine already requires.
//
// SAME-SALE TIES ARE DISCARDED. One sale reaches the pool more than once; when
// one copy's title says "black label" and its duplicate's does not, the
// identical price lands in both buckets and reports exactly 1.00x. That is the
// dedupe problem, not evidence about the premium.
//
// Read-only. Prints proposed ratios; writes nothing. Applying them to
// gradeCalibrationData.ts is a separate, reviewed step — see the doctrine that
// every calibration constant derives from sold_comps grouped by identity.
//
// Usage:
//   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
//     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
//     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
//     node scripts/comp-quality/derive-bgs10-calibration.cjs
//
//   WINDOW_DAYS=540    lookback (default 540)
//   BATCH=40           slugs per raw-sales query (default 40)
//   PACE_MS=400        delay between batches (default 400)
//   MIN_PAIRS=8        minimum matched pairs before a family is reported
const { CosmosClient } = require("@azure/cosmos");

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 540);
const BATCH = Number(process.env.BATCH || 40);
const PACE_MS = Number(process.env.PACE_MS || 400);
const MIN_PAIRS = Number(process.env.MIN_PAIRS || 8);

const BLACK_LABEL = /black\s*label/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  const s = a.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
};

/** Family from the slug's setKey segment. Mirrors classifyFamily's inputs;
 *  kept deliberately coarse — this reports per setKey and the caller maps to
 *  families, rather than duplicating the classifier and drifting from it. */
function setKeyOf(slug) {
  const p = String(slug || "").split(":");
  return p[0] === "hiq" && p.length > 3 ? p[3] : null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const c = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // ── 1. BGS 10 rows ────────────────────────────────────────────────────
  const { resources: graded } = await c.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.title FROM c
            WHERE c.gradeCompany = "BGS" AND c.gradeValue = 10 AND c.soldAt > @from
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null`,
    parameters: [{ name: "@from", value: from }],
  }).fetchAll();
  const gradedRows = graded.filter((r) => Number(r.price) > 0);
  if (gradedRows.length === 0) {
    console.error("FATAL: zero BGS 10 rows in the window. Nothing was measured.");
    process.exit(2);
  }

  const bySlug = new Map();
  for (const r of gradedRows) {
    const k = r.hobbyiqCardId;
    if (!bySlug.has(k)) bySlug.set(k, { bl: [], pristine: [] });
    (BLACK_LABEL.test(String(r.title || "")) ? bySlug.get(k).bl : bySlug.get(k).pristine)
      .push(Number(r.price));
  }
  const slugs = [...bySlug.keys()];
  console.log(`BGS 10 rows: ${gradedRows.length}   distinct cards: ${slugs.length}   window: ${WINDOW_DAYS}d`);

  // ── 2. Raw sales for JUST those cards, batched and paced ──────────────
  const rawBySlug = new Map();
  let batches = 0;
  for (let i = 0; i < slugs.length; i += BATCH) {
    const chunk = slugs.slice(i, i + BATCH);
    const params = chunk.map((s, n) => ({ name: `@s${n}`, value: s }));
    const inList = params.map((p) => p.name).join(", ");
    try {
      const { resources } = await c.items.query({
        query: `SELECT c.hobbyiqCardId, c.price FROM c
                WHERE c.hobbyiqCardId IN (${inList}) AND c.soldAt > @from
                  AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null)`,
        parameters: [...params, { name: "@from", value: from }],
      }).fetchAll();
      for (const r of resources) {
        const p = Number(r.price);
        if (!Number.isFinite(p) || p <= 0) continue;
        if (!rawBySlug.has(r.hobbyiqCardId)) rawBySlug.set(r.hobbyiqCardId, []);
        rawBySlug.get(r.hobbyiqCardId).push(p);
      }
    } catch (e) {
      console.warn(`  batch ${batches} failed (${e.message}) — continuing`);
    }
    batches++;
    if (batches % 10 === 0) process.stdout.write(`  ...${i + chunk.length}/${slugs.length}\r`);
    await sleep(PACE_MS);
  }
  console.log(`raw-sale batches: ${batches}   cards with raw comps: ${rawBySlug.size}\n`);

  // ── 3. Matched ratios ─────────────────────────────────────────────────
  const perSetKey = new Map();
  let ties = 0;
  const blPremiums = [];

  for (const [slug, g] of bySlug) {
    const sk = setKeyOf(slug);
    const rawMed = median(rawBySlug.get(slug) || []);
    const prisMed = median(g.pristine);
    const blMed = median(g.bl);

    if (prisMed && blMed) {
      if (Math.abs(prisMed - blMed) < 0.01) ties++;
      else blPremiums.push(blMed / prisMed);
    }
    if (!sk || !rawMed) continue;
    if (!perSetKey.has(sk)) perSetKey.set(sk, { mixed: [], pristine: [] });
    const mixedMed = median([...g.pristine, ...g.bl]);
    if (mixedMed) perSetKey.get(sk).mixed.push(mixedMed / rawMed);
    if (prisMed) perSetKey.get(sk).pristine.push(prisMed / rawMed);
  }

  console.log("BGS 10 premium over Raw, matched by card, by setKey");
  console.log("(only setKeys with enough pairs to mean anything)\n");
  console.log("  setKey                  n     MIXED(today)   PRISTINE(proposed)   change");
  const rows = [...perSetKey.entries()]
    .filter(([, v]) => v.pristine.length >= MIN_PAIRS)
    .sort((a, b) => b[1].pristine.length - a[1].pristine.length);
  for (const [sk, v] of rows) {
    const m = median(v.mixed), p = median(v.pristine);
    if (!m || !p) continue;
    const delta = ((p - m) / m) * 100;
    console.log(
      `  ${sk.padEnd(22)} ${String(v.pristine.length).padStart(4)}   ${String(m.toFixed(2) + "x").padStart(11)}   ${String(p.toFixed(2) + "x").padStart(17)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
    );
  }
  if (rows.length === 0) console.log(`  (no setKey reached MIN_PAIRS=${MIN_PAIRS})`);

  console.log(`\nBLACK LABEL premium over Pristine 10, matched by card`);
  if (blPremiums.length) {
    console.log(`  n=${blPremiums.length}  (discarded ${ties} same-sale ties)`);
    console.log(`  p25=${pct(blPremiums, 0.25).toFixed(2)}x  MEDIAN=${median(blPremiums).toFixed(2)}x  p75=${pct(blPremiums, 0.75).toFixed(2)}x`);
    console.log(`  below 1.0x (implausible, likely mislabelled): ${blPremiums.filter((r) => r < 1).length}`);
  } else {
    console.log("  no cards sold both ways in this window.");
  }

  console.log("\nNothing was written. Applying these to gradeCalibrationData.ts is a");
  console.log("separate reviewed step — every calibration constant has to trace to this.");
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
