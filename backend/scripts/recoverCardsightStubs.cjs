// CF-CARDSIGHT-STUB-RECOVERY (Drew, 2026-08-08). Phase 1 of the
// aggressive recovery: for cardsight search-hint stubs (year+set+player
// with no cardNumber and no hobbyiqCardId), try three fixups in order:
//
//   Step 1  Cross-reference: query card_catalog for existing entries
//           with matching (year, playerName) that have a real
//           cardNumber. If unique winner found, USE that cardNumber and
//           derive the parallel from the stub's setName.
//   Step 2  Naming rule for autograph sets: setName matches a known
//           auto-set family (Chrome Prospect Autographs, etc.) → build
//           cardNumber as `<prefix>-<initials>`.
//   Step 3  Skip (residual — needs external web search API, Phase 2).
//
// For every successful match, write a new catalog entry with the
// canonical hobbyiqCardId slug + verificationStatus='pending-review' so
// admin can approve via /app/admin/catalog-review before it's trusted.
// The original cardsight stub is left in place (harmless — it doesn't
// carry hobbyiqCardId so it never joins pricing queries).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do the writes (else dry-run count)
//   MAX_MINUTES                default 60
//   BATCH_SIZE                 default 200
//   CONCURRENCY                default 8

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY       = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE || 200));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const MAX_STUBS   = Number(process.env.MAX_STUBS || 0) || Infinity;

function loadComputeSlug() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

// Autograph set → cardNumber prefix (naming rule Step 2).
const AUTO_SET_PREFIX = [
  { rx: /bowman\s+chrome\s+prospects?\s+autograph/i, prefix: "BCPA" },
  { rx: /chrome\s+prospects?\s+autograph/i,          prefix: "CPA" },
  { rx: /bowman\s+draft\s+prospects?\s+autograph/i,  prefix: "BDPA" },
  { rx: /bowman\s+chrome\s+draft\s+autograph/i,      prefix: "BCDA" },
  { rx: /bowman\s+sterling\s+prospects?\s+autograph/i, prefix: "BSPA" },
  { rx: /bowman\s+prospects?\s+autograph/i,          prefix: "BPA" },
  { rx: /bowman\s+draft\s+autograph/i,               prefix: "BDA" },
  { rx: /topps\s+chrome\s+rookie\s+autograph/i,      prefix: "TCRA" },
  { rx: /bowman\s+chrome\s+rookie\s+autograph/i,     prefix: "BCRA" },
  { rx: /finest\s+rookie\s+autograph/i,              prefix: "FRA" },
];

// Parallel derivation from setName suffixes. Very conservative — only
// fires when the suffix is a well-known parallel + everything else looks
// like a Base card. Otherwise falls through and lets computeHobbyIqCardId
// receive the parallel field unchanged.
const PARALLEL_SUFFIX_RULES = [
  { rx: /mojo\s+refractor$/i,     parallel: "Mojo Refractor" },
  { rx: /mojo$/i,                 parallel: "Mojo Refractor" },
  { rx: /mega\s+refractor$/i,     parallel: "Mojo Refractor" },
  { rx: /sapphire$/i,             parallel: "Sapphire" },
  { rx: /gold\s+refractor$/i,     parallel: "Gold Refractor" },
  { rx: /gold$/i,                 parallel: "Gold Refractor" },
  { rx: /blue\s+refractor$/i,     parallel: "Blue Refractor" },
  { rx: /orange\s+refractor$/i,   parallel: "Orange Refractor" },
  { rx: /red\s+refractor$/i,      parallel: "Red Refractor" },
  { rx: /green\s+refractor$/i,    parallel: "Green Refractor" },
  { rx: /purple\s+refractor$/i,   parallel: "Purple Refractor" },
  { rx: /black\s+refractor$/i,    parallel: "Black Refractor" },
  { rx: /shimmer\s+refractor$/i,  parallel: "Shimmer Refractor" },
  { rx: /wave\s+refractor$/i,     parallel: "Wave Refractor" },
  { rx: /(refractor|refractors)$/i, parallel: "Refractor" },
  { rx: /base\s+set$/i,           parallel: "Base" },
];

function playerInitials(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return null;
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function deriveParallel(setName) {
  const s = String(setName ?? "").trim();
  for (const rule of PARALLEL_SUFFIX_RULES) {
    if (rule.rx.test(s)) return rule.parallel;
  }
  return "Base";
}

// Map cardsight setName to canonical setKey for base-cardNumber matching.
// Rough — the goal is to find OWEN CAREY BCP-69 whether the base entry
// is labeled "Bowman Chrome" or "Bowman Chrome Prospects" or "2026
// Bowman Chrome Baseball". We normalize both sides to just the family
// slug (bowman-chrome) and match on that.
function inferSetFamily(setName) {
  const s = String(setName ?? "").toLowerCase();
  if (/bowman.*chrome.*sapphire/.test(s)) return "bowman-chrome-sapphire";
  if (/bowman.*chrome/.test(s) || /chrome\s+prospect/.test(s)) return "bowman-chrome";
  if (/bowman.*draft/.test(s)) return "bowman-draft";
  if (/bowman/.test(s))       return "bowman";
  if (/topps.*chrome.*platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps.*chrome/.test(s)) return "topps-chrome";
  if (/topps.*finest/.test(s)) return "topps-finest";
  if (/topps.*heritage/.test(s)) return "topps-heritage";
  if (/topps.*transcendent/.test(s)) return "topps-transcendent";
  if (/topps/.test(s))         return "topps";
  if (/panini.*prizm/.test(s)) return "panini-prizm";
  if (/panini/.test(s))        return "panini";
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const computeSlug = loadComputeSlug();

  console.log(`[recover] apply=${APPLY} conc=${CONCURRENCY} maxStubs=${MAX_STUBS === Infinity ? "unlimited" : MAX_STUBS}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Iterate all cardsight stubs with player + year + set. Skip ones
  // that already have hobbyiqCardId (already resolved).
  const iter = cat.items.query({
    query: `SELECT c.id, c.title, c.setName, c.year, c.cardYear, c.searchText
            FROM c
            WHERE STARTSWITH(c.id, 'cardsight::')
              AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null)
              AND (NOT IS_DEFINED(c.cardNumber) OR c.cardNumber = null)`,
  }, { maxItemCount: BATCH_SIZE });

  let scanned = 0, recovered_xref = 0, recovered_naming = 0, unresolved = 0, missingPlayer = 0, written = 0, errored = 0;
  const inflight = new Set();
  // Per-(year,player) cross-ref cache — avoid re-querying same player
  const xrefCache = new Map();

  async function resolvePlayerBase(year, playerName, targetFamily) {
    const key = `${year}|${playerName.toLowerCase()}|${targetFamily}`;
    if (xrefCache.has(key)) return xrefCache.get(key);
    try {
      const { resources } = await cat.items.query({
        query: `SELECT TOP 3 c.cardNumber
                FROM c
                WHERE (c.year = @y OR c.cardYear = @y)
                  AND (LOWER(c.playerName) = @p OR LOWER(c.player) = @p OR LOWER(c.title) = @p)
                  AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ''
                  AND (c.setKey = @sk OR CONTAINS(LOWER(c.setName ?? ''), @sn))`,
        parameters: [
          { name: "@y", value: year },
          { name: "@p", value: playerName.toLowerCase() },
          { name: "@sk", value: targetFamily },
          { name: "@sn", value: targetFamily.replace(/-/g, " ") },
        ],
      }).fetchAll();
      const cardNumber = resources.length > 0 ? String(resources[0].cardNumber).trim() : null;
      xrefCache.set(key, cardNumber);
      return cardNumber;
    } catch { xrefCache.set(key, null); return null; }
  }

  while (iter.hasMoreResults()) {
    if (scanned >= MAX_STUBS) break;
    if (Date.now() - startMs > budgetMs) { console.warn(`[recover] time cap`); break; }
    const { resources } = await iter.fetchNext();
    for (const doc of resources) {
      scanned++;
      if (scanned >= MAX_STUBS) break;

      const player = String(doc.title ?? "").trim();
      if (!player) { missingPlayer++; continue; }
      const setName = String(doc.setName ?? "").trim();
      const year = Number(doc.year ?? doc.cardYear ?? 0);
      if (!setName || !year) { unresolved++; continue; }

      let cardNumber = null;
      let recoveredVia = null;

      // Step 2 (naming rule) — try first because it's cheap
      for (const rule of AUTO_SET_PREFIX) {
        if (rule.rx.test(setName)) {
          const initials = playerInitials(player);
          if (initials) { cardNumber = `${rule.prefix}-${initials}`; recoveredVia = "naming"; break; }
        }
      }

      // Step 1 (cross-ref) — for non-auto sets
      if (!cardNumber) {
        const family = inferSetFamily(setName);
        if (family) {
          const found = await resolvePlayerBase(year, player, family);
          if (found) { cardNumber = found; recoveredVia = "xref"; }
        }
      }

      if (!cardNumber) { unresolved++; continue; }

      const parallel = deriveParallel(setName);
      const isAuto = /autograph/i.test(setName);
      const familyKey = inferSetFamily(setName) || setName;
      let slug;
      try {
        slug = computeSlug({
          sport: "baseball", // cardsight docs sampled were all baseball; TODO: extend if others
          year,
          setKey: familyKey,
          cardNumber,
          parallel,
          isAuto,
          printRun: null,
        });
      } catch {
        unresolved++; continue;
      }

      if (recoveredVia === "naming") recovered_naming++;
      else if (recoveredVia === "xref") recovered_xref++;

      if (!APPLY) { written++; continue; }

      // Write new catalog entry pending review.
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const doc2 = {
        id: slug,
        cardId: slug,
        hobbyiqCardId: slug,
        sport: "baseball",
        year,
        cardYear: year,
        setKey: familyKey,
        setName,
        cardNumber,
        parallel,
        isAuto,
        playerName: player,
        source: "cardsight-stub-recovery",
        confidence: 0.6,
        verificationStatus: "pending-review",
        recoveredVia,
        recoveredFromCardsightId: doc.id,
        observedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      const p = cat.items.upsert(doc2)
        .then(() => { written++; })
        .catch((err) => {
          errored++;
          if (errored < 10) console.warn(`upsert failed ${slug}: ${err?.code ?? err?.message ?? err}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (scanned % 5000 === 0) console.log(`  [progress] scanned=${scanned} xref=${recovered_xref} naming=${recovered_naming} unresolved=${unresolved} written=${written}`);
  }

  while (inflight.size > 0) await Promise.race([...inflight]);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== RECOVERY SUMMARY ===");
  console.log(`apply           : ${APPLY}`);
  console.log(`scanned stubs   : ${scanned}`);
  console.log(`recovered xref  : ${recovered_xref}`);
  console.log(`recovered naming: ${recovered_naming}`);
  console.log(`total recovered : ${recovered_xref + recovered_naming}`);
  console.log(`unresolved      : ${unresolved}`);
  console.log(`missing player  : ${missingPlayer}`);
  console.log(`written         : ${written}`);
  console.log(`errored         : ${errored}`);
  console.log(`elapsed         : ${elapsed}s`);
  console.log(`xref cache size : ${xrefCache.size}`);
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
