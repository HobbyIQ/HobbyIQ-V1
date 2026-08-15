#!/usr/bin/env node
/**
 * CF-HOLDING-CATALOG-MATCH (Drew, 2026-08-15). Resolve user holdings that
 * carry no canonical identity onto their real card_catalog row.
 *
 * WHY. A holding priced off a vendor id is priced off whatever that vendor
 * thinks the card is. Canonical FMV is computed from OUR pool grouped by
 * hiq: slug, so a holding without a slug cannot be priced from our own
 * data — it is dependent on a vendor mapping we do not control.
 *
 * Measured 2026-08-15 across all 10 portfolios (56 holdings):
 *     40  canonical hiq: slug
 *      9  cardsight uuid only
 *      2  cardhedge bubble id only
 *      5  no card id at all
 *
 * READ THE SLUG FROM EITHER FIELD. 12 holdings carry it in
 * hobbyiqCardId, 4 in cardId, 24 in both. Checking one field alone
 * misreports matched holdings as unmatched — that is how a first pass
 * counted 20 unmatched instead of 16.
 *
 * NORMALIZE BEFORE MATCHING. holdingFieldNormalizer is the standard for
 * messy imported fields, and the catalog must be queried with cleaned
 * values, never the raw vendor string. Real examples in this data:
 * playerName "Bobby Witt Jr. Royals" (team appended) and setName
 * "2022-23 Panini Select FIFA - [Base] - Gold Prizm Missing Serial N"
 * (a truncated eBay title).
 *
 * PROPOSES ONLY. This writes nothing without --apply, and even then only
 * where the matcher reports found:true. A holding is a user's record of
 * something they own; a confidently wrong match silently reprices their
 * asset, which is worse than leaving it unmatched.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/match-holdings-to-catalog.cjs [--apply] [--min-confidence=0.7]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

const isSlug = (v) => typeof v === "string" && v.startsWith("hiq:");

/**
 * The catalog's setKey is the PRODUCT LINE, and on these holdings that is
 * `product`, not `setName`. `setName` holds the SUBSET.
 *
 *   set="Prospects Autographs"  product="Bowman Chrome"  -> bowman-chrome
 *   set="Base Set"              product="Topps Update"   -> topps-update
 *
 * Verified against card_catalog: 2024 #CPA-LD exists only under setKey
 * bowman-chrome, and 2011 #US175 only under topps-update. Feeding
 * `setName` first produced slugs like
 * hiq:baseball:2024:prospects-autographs:cpa-ld:... which match nothing —
 * a confident-looking slug for a set that does not exist.
 */
function productLine(h) {
  const product = typeof h.product === "string" ? h.product.trim() : "";
  const setName = typeof h.setName === "string" ? h.setName.trim() : "";
  return product || setName || null;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const APPLY = has("apply");
  const MIN_CONF = Number(arg("min-confidence", "0.7"));

  const { normalizeHoldingFields } = require(path.join(backend, "dist/services/portfolioiq/holdingFieldNormalizer.service.js"));
  const { canonicalize } = require(path.join(backend, "dist/services/catalog/catalogMatcher.service.js"));

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const portfolio = db.container("portfolio");

  console.log(`[holding-match] mode=${APPLY ? "APPLY" : "DRY-RUN"} minConfidence=${MIN_CONF}\n`);

  const { resources: docs } = await portfolio.items
    .query("SELECT c.id, c.userId, c.holdings FROM c").fetchAll();

  const tot = { total: 0, alreadyCanonical: 0, attempted: 0, matched: 0, unmatched: 0, lowConf: 0, written: 0, failed: 0 };
  const proposals = [];

  for (const doc of docs) {
    const holdings = doc.holdings && typeof doc.holdings === "object" ? doc.holdings : {};
    const patch = {};

    for (const [hid, h] of Object.entries(holdings)) {
      tot.total++;
      if (isSlug(h.hobbyiqCardId) || isSlug(h.cardId)) { tot.alreadyCanonical++; continue; }
      tot.attempted++;

      // Clean the imported strings before they reach a catalog query.
      let clean = { ...h };
      try {
        clean = normalizeHoldingFields({
          playerName: h.playerName ?? null,
          setName: productLine(h),
          cardNumber: h.cardNumber ?? null,
          parallel: h.parallel ?? null,
          cardYear: h.cardYear ?? null,
        }).fields;
      } catch { /* fall back to raw on normalizer failure */ }

      const setName = clean.setName ?? productLine(h) ?? "";
      const cardNumber = clean.cardNumber ?? h.cardNumber ?? "";
      const year = Number(clean.cardYear ?? h.cardYear);
      const label = `${String(clean.playerName ?? h.playerName ?? "?").slice(0, 22).padEnd(22)} ${year} ${String(cardNumber || "-").padEnd(9)} ${String(setName).slice(0, 26)}`;

      if (!year || !cardNumber || !setName) {
        tot.unmatched++;
        proposals.push({ hid, label, verdict: "SKIP — missing year/number/set", slug: null });
        continue;
      }

      let res;
      try {
        res = await canonicalize({
          sport: h.sport ?? "baseball",
          year,
          setName,
          cardNumber: String(cardNumber),
          parallel: clean.parallel ?? h.parallel ?? "Base",
          isAuto: h.isAuto === true,
          printRun: h.printRun ?? null,
          player: clean.playerName ?? h.playerName ?? null,
          // Read-only intent: this source must not seed new catalog rows.
          source: "ebay-title",
          sourceExternalId: null,
        });
      } catch (e) {
        tot.unmatched++;
        proposals.push({ hid, label, verdict: `ERROR ${e.message?.slice(0, 40)}`, slug: null });
        continue;
      }

      if (!res?.found) {
        tot.unmatched++;
        proposals.push({ hid, label, verdict: "no catalog match", slug: res?.slug ?? null });
        continue;
      }
      if ((res.confidence ?? 0) < MIN_CONF) {
        tot.lowConf++;
        proposals.push({ hid, label, verdict: `LOW CONF ${res.confidence}`, slug: res.slug });
        continue;
      }

      tot.matched++;
      proposals.push({ hid, label, verdict: `match conf=${res.confidence}`, slug: res.slug });
      // Keep the vendor id. It is the only record of which Cardsight /
      // CardHedge row this holding came from, and overwriting cardId in
      // place would erase that provenance with no way to reconstruct it.
      patch[hid] = { slug: res.slug, priorCardId: typeof h.cardId === "string" ? h.cardId : null };
    }

    if (APPLY && Object.keys(patch).length) {
      for (const [hid, { slug, priorCardId }] of Object.entries(patch)) {
        try {
          const ops = [
            { op: "add", path: `/holdings/${hid}/hobbyiqCardId`, value: slug },
            { op: "add", path: `/holdings/${hid}/cardId`, value: slug },
            { op: "add", path: `/holdings/${hid}/catalogMatchedAt`, value: new Date().toISOString() },
          ];
          if (priorCardId) ops.push({ op: "add", path: `/holdings/${hid}/vendorCardId`, value: priorCardId });
          await portfolio.item(doc.id, doc.userId).patch(ops);
          tot.written++;
        } catch (e) {
          tot.failed++;
          console.warn(`  patch failed user=${doc.userId} holding=${hid}: ${e.code ?? e.message}`);
        }
      }
    }
  }

  console.log("  holding                                                              verdict");
  console.log("  " + "-".repeat(110));
  for (const p of proposals) {
    console.log(`  ${p.label}  ${p.verdict}`);
    if (p.slug) console.log(`  ${" ".repeat(62)}-> ${p.slug}`);
  }

  console.log(`\n  total holdings        ${tot.total}`);
  console.log(`  already canonical     ${tot.alreadyCanonical}`);
  console.log(`  attempted             ${tot.attempted}`);
  console.log(`  matched (>=${MIN_CONF})      ${tot.matched}${APPLY ? ` (written ${tot.written}, failed ${tot.failed})` : " (dry-run)"}`);
  console.log(`  low confidence        ${tot.lowConf}   <- left alone, needs a human`);
  console.log(`  no match              ${tot.unmatched}  <- left alone`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
