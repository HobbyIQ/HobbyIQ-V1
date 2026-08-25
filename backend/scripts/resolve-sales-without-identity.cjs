#!/usr/bin/env node
/**
 * CF-A-SALE-WITH-NO-IDENTITY-IS-INVISIBLE (Drew, 2026-08-24).
 *
 * 303,093 rows in sold_comps carried no hobbyiqCardId. They are real completed
 * transactions -- 291k from CardHedge, 11k from TCA -- and with
 * CATALOG_MATCH_ONLY_ENABLED=true they are invisible to every price on the
 * platform: persistVendorSalesToPool drops an unmatched sale rather than filing
 * it, so these never reached a pool.
 *
 * They are not unidentifiable. Sampled: 100% carry title, playerName and
 * cardYear; 62% state a card number in the title. This pass owns that 62%; the
 * numberless remainder belongs to attest-unnumbered-by-player.cjs, where the
 * player is the identity.
 *
 * TWO FIXES over the first version, both from watching it run:
 *
 *  1. IT QUERIED THE WHOLE CONTAINER AT ONCE and ran out at 25,274 rows of
 *     ~303k. A cross-partition query that large stops returning continuations
 *     long before the data ends, and the script exited "successfully" having
 *     seen 8% of the work. Now it walks YEAR BY YEAR, so every query is small
 *     enough to finish and a year that fails is retried alone.
 *
 *  2. 15,545 CAME BACK not-found -- cards whose catalog row does not exist.
 *     Those were simply dropped. Now, when two or more sales independently
 *     compute the SAME identity, the row is attested and created, and the sales
 *     land on it. One sale can be a mis-parse; two agreeing is evidence. Same
 *     rule that made the numbered attest pass create 8,026 rows instead of
 *     24,000.
 *
 * Rows created here land PROVISIONAL: real cards, identified from vendor text
 * rather than a checklist, so search shows them below anything verified.
 *
 *   BACKFILL_APPLY   "true" to write; anything else reports only
 *   YEARS            comma list, or empty for every year present
 *   MIN_SALES        corroboration needed to CREATE a missing row (default 2)
 *   MIN_CONFIDENCE   accept a canonicalize match at or above this (default 0.72)
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { parseListingIdentity } = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { canonicalize } = require(path.join(ROOT, "dist/services/catalog/catalogMatcher.service.js"));
const { canonicalCardName } = require(path.join(ROOT, "dist/services/catalog/canonicalCardName.js"));
const { unparsedVariantReason } = require(path.join(ROOT, "dist/services/catalog/attestationGuard.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const MIN_CONF = Number(process.env.MIN_CONFIDENCE || 0.72);
const MIN_SALES = Number(process.env.MIN_SALES || 2);
const YEARS = String(process.env.YEARS || "").split(",").map(Number).filter(Boolean);
const SLOT = Number(process.env.SLOT || 0);
const SLOTS = Math.max(1, Number(process.env.SLOTS || 1));
const STOP = new Set(["the", "a", "of", "and", "psa", "bgs", "sgc", "cgc", "raw", "rc", "hof",
  "set", "break", "lot", "card", "cards", "vintage", "graded"]);

const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The doubled-year producer is fixed (0000f60) but ~1.8M stored titles still
// carry it; strip so the parser sees a clean string.
function dedupeYear(title, year) {
  const t = String(title ?? "");
  const y = String(year ?? "");
  return y && t.startsWith(y + " " + y + " ") ? t.slice(y.length + 1) : t;
}

function tokensFor(parts) {
  const out = new Set();
  for (const src of parts) {
    for (const w of String(src ?? "").toLowerCase().replace(/[^a-z0-9- ]/g, " ").split(/[\s-]+/)) {
      if (w && w.length > 1 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out];
}

async function yearsPresent(sold) {
  if (YEARS.length) return YEARS;
  const rows = (await sold.items.query({
    query: "SELECT c.cardYear AS y, COUNT(1) AS n FROM c " +
           "WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '') " +
           "AND IS_NUMBER(c.cardYear) GROUP BY c.cardYear",
  }).fetchAll()).resources;
  return rows.filter((r) => r.y >= 1900 && r.y <= 2030).sort((a, b) => b.n - a.n).map((r) => r.y);
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  // Round-robin over a count-descending list, so each worker gets a mix of
  // heavy and light years rather than one worker inheriting every big one.
  const allYears = await yearsPresent(sold);
  const years = allYears.filter((_, i) => i % SLOTS === SLOT);
  console.log("years with unidentified sales: " + allYears.length +
              "   this worker (slot " + SLOT + "/" + SLOTS + "): " + years.length);

  const total = { seen: 0, matched: 0, lowConf: 0, unmatched: 0, created: 0, wrote: 0, failed: 0, heldParallel: 0 };

  for (const year of years) {
    // Per-year so the query is small enough to actually finish. The first
    // version asked for the whole container and stopped at 8% of it.
    let token;
    const pending = new Map();   // computed slug -> sales that want it
    let seen = 0, matched = 0, lowConf = 0, wrote = 0, failed = 0, flattens = 0;
    const heldReasons = new Map();

    do {
      const page = await sold.items.query(
        { query: "SELECT c.id, c.cardId, c.title, c.playerName, c.setName, c.cardYear, c.sport FROM c " +
                 "WHERE c.cardYear = @y AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')",
          parameters: [{ name: "@y", value: year }] },
        { maxItemCount: 400, continuationToken: token },
      ).fetchNext();
      token = page.continuationToken;

      for (const r of page.resources) {
        seen++;
        const title = dedupeYear(r.title, year);
        let parsed = {};
        try { parsed = parseListingIdentity(title) || {}; } catch { /* best effort */ }
        if (!parsed.cardNumber) continue;   // attest-unnumbered-by-player owns these

        const sport = slugify(r.sport || "") || "baseball";
        let res = null;
        try {
          res = await canonicalize({
            sport, year,
            setName: r.setName ?? null,
            cardNumber: parsed.cardNumber,
            parallel: parsed.parallel ?? null,
            isAuto: parsed.isAuto ?? false,
            printRun: parsed.printRun ?? null,
            player: r.playerName ?? null,
            source: "ebay-title",
          });
        } catch { /* treat as unmatched */ }

        if (res && res.found && (res.confidence ?? 0) >= MIN_CONF) {
          matched++;
          if (!APPLY) continue;
          try {
            const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
            if (!d) continue;
            d.hobbyiqCardId = res.slug;
            d.identityResolvedBy = { by: "resolve-sales-without-identity", matchedBy: res.matchedBy, confidence: res.confidence, at: new Date().toISOString() };
            await sold.item(r.id, r.cardId ?? r.id).replace(d);
            wrote++;
          } catch { failed++; }
          continue;
        }
        if (res && res.found) { lowConf++; continue; }

        // No catalog row. Compute the identity the sale is claiming and hold it
        // -- if another sale claims the same one, that is corroboration.
        const setKey = slugify(r.setName || "");
        if (!setKey || setKey === "unknown") continue;
        // Attesting mints a row every future sale matches against, so it is
        // held to a stricter bar than matching: if the title names a variant the
        // parse does not carry, leave the sale unresolved rather than flatten it.
        const flatten = unparsedVariantReason({
          title: r.title, setName: r.setName, parsedParallel: parsed.parallel,
          parsedIsAuto: parsed.isAuto, parsedPrintRun: parsed.printRun,
        });
        if (flatten) { flattens++; heldReasons.set(flatten, (heldReasons.get(flatten) || 0) + 1); continue; }
        const par = slugify(parsed.parallel || "base") || "base";
        const auto = parsed.isAuto ? ":auto" : ":no-auto";
        const run = Number(parsed.printRun) > 0 ? ":num-" + Number(parsed.printRun) : "";
        const slug = "hiq:" + sport + ":" + year + ":" + setKey + ":" + slugify(parsed.cardNumber) + ":" + par + auto + run;
        if (!pending.has(slug)) {
          pending.set(slug, { sport, year, setKey, setName: r.setName, cardNumber: parsed.cardNumber,
            parallel: parsed.parallel || "Base", printRun: Number(parsed.printRun) > 0 ? Number(parsed.printRun) : null,
            isAuto: !!parsed.isAuto, player: r.playerName, sales: [] });
        }
        pending.get(slug).sales.push({ id: r.id, cardId: r.cardId, title: r.title });
      }
    } while (token);

    const attested = [...pending.entries()].filter(([, g]) => g.sales.length >= MIN_SALES);
    const unmatchedSales = [...pending.values()].reduce((a, g) => a + g.sales.length, 0);
    let created = 0;

    // In report mode, show what WOULD be created. A row that reads wrong here
    // is a parser bug, and it is far cheaper to see it now than to find it in
    // the catalog later.
    if (!APPLY && attested.length) {
      for (const [slug, g] of attested.slice().sort((a, b) => b[1].sales.length - a[1].sales.length).slice(0, 6)) {
        console.log("      x" + String(g.sales.length).padStart(3) + "  " + slug);
        console.log("            " + String(g.sales[0].title || "").slice(0, 96));
      }
    }

    if (APPLY) {
      for (const [slug, g] of attested) {
        try {
          const setName = g.setName || (g.year + " " + g.setKey);
          const doc = {
            id: slug, cardId: slug, hobbyiqCardId: slug,
            sport: g.sport, year: g.year, cardYear: g.year, setKey: g.setKey, setName,
            cardNumber: String(g.cardNumber).toUpperCase(), playerName: g.player ?? null,
            parallel: g.parallel, parallelSlug: slugify(g.parallel) || "base",
            isAuto: g.isAuto, printRun: g.printRun,
            source: "sales-attested", catalogBatch: "resolve-unidentified-2026-08-24",
            verificationStatus: "pending-review",
            attestedBy: { sales: g.sales.length, firstTitle: String(g.sales[0].title || "").slice(0, 140) },
            builtAt: new Date().toISOString(),
          };
          doc.displayName = canonicalCardName(doc);
          doc.searchTokens = tokensFor([setName, g.setKey, g.parallel, g.player, String(g.cardNumber), String(g.year), g.sport]);
          doc.searchText = doc.searchTokens.join(" ");
          await cat.items.upsert(doc);
          created++;
          for (const s of g.sales) {
            try {
              const d = (await sold.item(s.id, s.cardId ?? s.id).read()).resource;
              if (!d) continue;
              d.hobbyiqCardId = slug;
              d.identityResolvedBy = { by: "resolve-sales-without-identity", matchedBy: "attested", corroboratingSales: g.sales.length, at: new Date().toISOString() };
              await sold.item(s.id, s.cardId ?? s.id).replace(d);
              wrote++;
            } catch { failed++; }
          }
        } catch { failed++; }
      }
    }

    total.seen += seen; total.matched += matched; total.lowConf += lowConf;
    total.unmatched += unmatchedSales; total.created += created;
    total.wrote += wrote; total.failed += failed; total.heldParallel += flattens;
    console.log("  " + year + "  seen " + seen + "  matched " + matched +
                "  attestable " + attested.length + "  created " + created +
                "  wrote " + wrote + "  held " + flattens +
                (flattens ? " [" + [...heldReasons].map(([k, v]) => k + " " + v).join(", ") + "]" : ""));
  }

  console.log("");
  console.log("TOTAL " + JSON.stringify(total));
  if (!APPLY) console.log("REPORT ONLY - nothing written.");
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
