#!/usr/bin/env node
/**
 * CF-FOR-AN-UNNUMBERED-CARD-THE-PLAYER-IS-THE-NUMBER (Drew, 2026-08-24:
 * "we can find those cards via the checklist!!").
 *
 * He was right that the checklist is the key — and the measurement showed the
 * key is already in hand. Of 303,093 sales carrying no identity, 38% have no
 * card number in their title, because the SET has no card numbers:
 *
 *   1950 Callahan Hall of Fame      61 unnumbered cards
 *   1955 Rodeo Meats                "Bill Wilson (Purple background)"
 *   1970 Topps Scratch-Offs         Hank Aaron
 *   1980 Topps Basketball           three-player panels, so titles name a player
 *
 * Sampled 1,664 of them: ZERO lack a playerName, and they collapse to 645
 * distinct (set, player) pairs at 2.6 sales each. For a set with no numbers the
 * PLAYER is the identity, so the catalog row can be built from the sales
 * themselves — no scrape required. That also sidesteps TCDB and PSA, which both
 * return 403 to automated fetches.
 *
 * CORROBORATION REQUIRED. One sale can be a mis-parse; two independent sales
 * agreeing on the same (sport, year, set, player) is a far stronger claim. Same
 * rule that made the numbered attest pass create 8,026 rows instead of 24,000.
 *
 * Rows land PROVISIONAL (verificationStatus "pending-review"): real cards, but
 * identified from vendor text rather than a checklist, so search surfaces them
 * as a fallback and never above a verified row.
 *
 *   BACKFILL_APPLY  "true" to write; anything else reports only
 *   MIN_SALES       corroboration threshold, default 2
 *   YEARS           optional comma list to scope a run
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { parseListingIdentity } = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { canonicalCardName } = require(path.join(ROOT, "dist/services/catalog/canonicalCardName.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const MIN_SALES = Number(process.env.MIN_SALES || 2);
const YEARS = String(process.env.YEARS || "").split(",").map(Number).filter(Boolean);
const STOP = new Set(["the", "a", "of", "and", "psa", "bgs", "sgc", "cgc", "raw", "rc", "hof",
  "set", "break", "lot", "card", "cards", "vintage", "graded"]);

const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The doubled-year producer is fixed (commit 0000f60) but 3.17M stored titles
// still carry it. Strip it so the parser sees a clean string.
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

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const yearFilter = YEARS.length
    ? " AND c.cardYear IN (" + YEARS.map((_, i) => "@y" + i).join(",") + ")"
    : "";
  const params = YEARS.map((y, i) => ({ name: "@y" + i, value: y }));

  const groups = new Map();
  let scanned = 0, numbered = 0, noPlayer = 0, noSet = 0;
  let token;

  do {
    const page = await sold.items.query(
      {
        query:
          "SELECT c.id, c.cardId, c.title, c.playerName, c.setName, c.cardYear, c.sport FROM c " +
          "WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')" +
          yearFilter,
        parameters: params,
      },
      { maxItemCount: 500, continuationToken: token },
    ).fetchNext();
    token = page.continuationToken;

    for (const r of page.resources) {
      scanned++;
      const year = Number(r.cardYear);
      if (!Number.isFinite(year)) continue;

      let parsed = {};
      try {
        parsed = parseListingIdentity(dedupeYear(r.title, year)) || {};
      } catch {
        // Parser is best-effort; a throw just means no number was found.
      }
      // Numbered sales belong to the canonicalize pass, which matches them
      // exactly at 0.98. This script owns only the numberless remainder.
      if (parsed.cardNumber) { numbered++; continue; }
      if (!r.playerName) { noPlayer++; continue; }

      const setKey = slugify(r.setName || "");
      if (!setKey || setKey === "unknown") { noSet++; continue; }

      const sport = slugify(r.sport || "") || "baseball";
      const key = [sport, year, setKey, slugify(r.playerName)].join("|");
      if (!groups.has(key)) {
        groups.set(key, { sport, year, setKey, setName: r.setName, player: r.playerName, sales: [] });
      }
      groups.get(key).sales.push({ id: r.id, cardId: r.cardId, title: r.title });
    }
    if (scanned % 20000 < 500) console.log("  scanned " + scanned + "  identities " + groups.size);
  } while (token);

  const attested = [...groups.values()].filter((g) => g.sales.length >= MIN_SALES);
  const heldBack = groups.size - attested.length;

  console.log("");
  console.log("scanned " + scanned + "   numbered(other pass) " + numbered +
              "   noPlayer " + noPlayer + "   noSetName " + noSet);
  console.log("identities " + groups.size + "   attested(>=" + MIN_SALES + ") " + attested.length +
              "   single-sale held back " + heldBack);
  for (const g of attested.slice().sort((a, b) => b.sales.length - a.sales.length).slice(0, 8)) {
    console.log("   " + String(g.sales.length).padStart(4) + "  " + g.year + " " + g.setKey + " " + slugify(g.player));
  }

  if (!APPLY) {
    console.log("");
    console.log("REPORT ONLY — nothing written.");
    return;
  }

  let rows = 0, moved = 0, failed = 0;
  for (const g of attested) {
    // The player slug occupies the card-number segment: in a set with no
    // numbers it is the only thing distinguishing one card from another.
    const id = "hiq:" + g.sport + ":" + g.year + ":" + g.setKey + ":" + slugify(g.player) + ":base:no-auto";
    const setName = g.setName || (g.year + " " + g.setKey);
    try {
      const doc = {
        id, cardId: id, hobbyiqCardId: id,
        sport: g.sport, year: g.year, cardYear: g.year,
        setKey: g.setKey, setName,
        cardNumber: null, isUnnumbered: true,
        playerName: g.player,
        parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null,
        source: "sales-attested-unnumbered",
        catalogBatch: "unnumbered-by-player-2026-08-24",
        verificationStatus: "pending-review",
        attestedBy: { sales: g.sales.length, firstTitle: String(g.sales[0].title || "").slice(0, 140) },
        builtAt: new Date().toISOString(),
      };
      doc.displayName = canonicalCardName(doc);
      doc.searchTokens = tokensFor([setName, g.setKey, g.player, String(g.year), g.sport, "base"]);
      doc.searchText = doc.searchTokens.join(" ");
      await cat.items.upsert(doc);
      rows++;

      for (const s of g.sales) {
        try {
          const d = (await sold.item(s.id, s.cardId ?? s.id).read()).resource;
          if (!d) continue;
          d.hobbyiqCardId = id;
          d.identityResolvedBy = {
            by: "unnumbered-by-player-2026-08-24",
            corroboratingSales: g.sales.length,
            at: new Date().toISOString(),
          };
          await sold.item(s.id, s.cardId ?? s.id).replace(d);
          moved++;
        } catch {
          failed++;
        }
      }
    } catch (e) {
      failed++;
      if (failed <= 3) console.error("   ERR " + String(e.message).slice(0, 70));
    }
  }
  console.log("");
  console.log("rows created " + rows + "   sales resolved " + moved + "   failed " + failed);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
