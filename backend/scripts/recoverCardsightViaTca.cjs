// CF-CARDSIGHT-RECOVERY-VIA-TCA (Drew, 2026-08-08). Phase 2 batch
// backfill. For each cardsight stub (no cardNumber, no hobbyiqCardId),
// query the TCA catalog API for (player, year, setName). TCA has 15M
// cards including modern releases + parallels + subsets. If it returns
// a match, generate a catalog entry with the resolved cardNumber and
// hobbyiqCardId slug, flagged verificationStatus='pending-review' for
// admin approval via /app/admin/catalog-review.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   TCA_API_KEY                required
//   APPLY=true                 write catalog entries (else dry-run)
//   MAX_STUBS                  cap on scanned stubs (default unlimited)
//   MAX_MINUTES                default 60
//   BATCH_SIZE                 Cosmos page size (default 100)
//   CONCURRENCY                in-flight TCA lookups (default 4)
//   SPORT_DEFAULT              default "baseball"
//   THROTTLE_MS                delay between TCA calls to be polite

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY       = process.env.APPLY === "true";
const MAX_STUBS   = Number(process.env.MAX_STUBS || 0) || Infinity;
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE || 100));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));
const SPORT_DEFAULT = String(process.env.SPORT_DEFAULT || "baseball");
const THROTTLE_MS = Math.max(0, Number(process.env.THROTTLE_MS || 100));

function loadHelpers() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const slugP = path.join(distRoot, "services", "portfolioiq", "hobbyIqCardId.service.js");
  const tcaP  = path.join(distRoot, "services", "compiq", "tcaCatalog.client.js");
  if (!fs.existsSync(slugP)) throw new Error(`hobbyIqCardId helper not found at ${slugP} — run \`npm run build\` first`);
  if (!fs.existsSync(tcaP)) throw new Error(`tcaCatalog client not found at ${tcaP} — run \`npm run build\` first`);
  return {
    computeSlug: require(slugP).computeHobbyIqCardId,
    tcaNarrow: require(tcaP).tcaCatalogNarrow,
  };
}

function inferSetFamily(setName) {
  const s = String(setName ?? "").toLowerCase();
  if (/bowman.*chrome.*sapphire/.test(s)) return "bowman-chrome-sapphire";
  if (/bowman.*chrome/.test(s) || /chrome\s+prospect/.test(s)) return "bowman-chrome";
  if (/bowman.*draft/.test(s)) return "bowman-draft";
  if (/bowman/.test(s))       return "bowman";
  if (/transcendent/.test(s)) return "topps-transcendent";
  if (/topps.*chrome.*platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps.*chrome/.test(s)) return "topps-chrome";
  if (/topps.*finest/.test(s)) return "topps-finest";
  if (/topps.*heritage/.test(s)) return "topps-heritage";
  if (/topps/.test(s))         return "topps";
  if (/panini.*prizm/.test(s)) return "panini-prizm";
  if (/panini/.test(s))        return "panini";
  return null;
}

// Given a TCA card + our stub's setName, guess the parallel. TCA often
// returns the base card_number even for parallels; the setName field
// tells us which parallel it is.
function deriveParallel(setName, tcaCard) {
  const s = String(setName ?? "").toLowerCase();
  const RULES = [
    { rx: /mojo\s+refractor/, parallel: "Mojo Refractor" },
    { rx: /mega\s+refractor/, parallel: "Mojo Refractor" },
    { rx: /\bmojo\b/,         parallel: "Mojo Refractor" },
    { rx: /sapphire/,         parallel: "Sapphire" },
    { rx: /gold\s+refractor/, parallel: "Gold Refractor" },
    { rx: /\bgold\b/,         parallel: "Gold Refractor" },
    { rx: /blue\s+refractor/, parallel: "Blue Refractor" },
    { rx: /orange\s+refractor/, parallel: "Orange Refractor" },
    { rx: /red\s+refractor/,  parallel: "Red Refractor" },
    { rx: /green\s+refractor/, parallel: "Green Refractor" },
    { rx: /purple\s+refractor/, parallel: "Purple Refractor" },
    { rx: /black\s+refractor/, parallel: "Black Refractor" },
    { rx: /shimmer/,          parallel: "Shimmer Refractor" },
    { rx: /\bwave\b/,          parallel: "Wave Refractor" },
    { rx: /\brefractor\b/,     parallel: "Refractor" },
    { rx: /1\s*of\s*1/,        parallel: "1/1" },
    { rx: /platinum/,          parallel: "Platinum" },
  ];
  for (const rule of RULES) if (rule.rx.test(s)) return rule.parallel;
  // Fallbacks
  if (tcaCard?.rarity && tcaCard.rarity.toLowerCase() !== "base") return String(tcaCard.rarity);
  return "Base";
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  if (!process.env.TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(2); }

  const { computeSlug, tcaNarrow } = loadHelpers();
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[recover-via-tca] apply=${APPLY} maxStubs=${MAX_STUBS === Infinity ? "unlimited" : MAX_STUBS} conc=${CONCURRENCY} throttleMs=${THROTTLE_MS}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Iterate cardsight stubs with no cardNumber and no hobbyiqCardId
  const iter = cat.items.query({
    query: `SELECT c.id, c.title, c.setName, c.year, c.cardYear, c.searchText
            FROM c
            WHERE STARTSWITH(c.id, 'cardsight::')
              AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null)
              AND (NOT IS_DEFINED(c.cardNumber) OR c.cardNumber = null)`,
  }, { maxItemCount: BATCH_SIZE });

  let scanned = 0, tcaHits = 0, tcaMisses = 0, malformed = 0, written = 0, errored = 0, missingPlayer = 0;
  const inflight = new Set();
  const sampleHits = [];
  const sampleMisses = [];

  while (iter.hasMoreResults()) {
    if (scanned >= MAX_STUBS) break;
    if (Date.now() - startMs > budgetMs) { console.warn(`[recover] time cap`); break; }
    const { resources } = await iter.fetchNext();
    for (const doc of resources) {
      scanned++;
      if (scanned >= MAX_STUBS) break;
      const player = String(doc.title ?? "").trim();
      const setName = String(doc.setName ?? "").trim();
      const year = Number(doc.year ?? doc.cardYear ?? 0);
      if (!player) { missingPlayer++; continue; }
      if (!setName || !year) { malformed++; continue; }

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const task = (async () => {
        try {
          const cards = await tcaNarrow(player, year, setName, SPORT_DEFAULT);
          if (!cards || cards.length === 0) {
            tcaMisses++;
            if (sampleMisses.length < 8) sampleMisses.push({ player, year, setName });
            return;
          }
          // Pick the first card (TCA sorts by relevance; for parallels this
          // is usually the base card). Future improvement: rank against
          // is_auto match, print-run match, etc.
          const card = cards[0];
          const cardNumber = String(card.card_number ?? "").trim();
          if (!cardNumber) { malformed++; return; }
          const family = inferSetFamily(setName) || SPORT_DEFAULT;
          const parallel = deriveParallel(setName, card);
          const isAuto = card.is_auto === true || /autograph/i.test(setName);
          let slug;
          try {
            slug = computeSlug({
              sport: SPORT_DEFAULT,
              year,
              setKey: family,
              cardNumber,
              parallel,
              isAuto,
              printRun: card.print_run ?? null,
            });
          } catch { malformed++; return; }
          tcaHits++;
          if (sampleHits.length < 8) sampleHits.push({ stub: `${player} · ${setName} · ${year}`, resolvedCardNumber: cardNumber, resolvedParallel: parallel, isAuto, slug });
          if (!APPLY) { written++; return; }
          try {
            await cat.items.upsert({
              id: slug,
              cardId: slug,
              hobbyiqCardId: slug,
              sport: SPORT_DEFAULT,
              year,
              cardYear: year,
              setKey: family,
              setName,
              cardNumber,
              parallel,
              isAuto,
              printRun: card.print_run ?? null,
              playerName: player,
              tcaCardId: card.id,
              tcaSetId: card.set_id,
              source: "cardsight-recovery-via-tca",
              confidence: 0.75,
              verificationStatus: "pending-review",
              recoveredFromCardsightId: doc.id,
              observedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            });
            written++;
          } catch (err) {
            errored++;
            if (errored < 10) console.warn(`upsert failed ${slug}: ${err?.code ?? err?.message ?? err}`);
          }
        } catch (err) {
          errored++;
          if (errored < 10) console.warn(`tca lookup failed for "${player}/${setName}/${year}": ${err?.message ?? err}`);
        } finally {
          if (THROTTLE_MS > 0) await new Promise((res) => setTimeout(res, THROTTLE_MS));
        }
      })().finally(() => inflight.delete(task));
      inflight.add(task);
    }
    if (scanned % 500 === 0) console.log(`  [progress] scanned=${scanned} hits=${tcaHits} misses=${tcaMisses} written=${written} inflight=${inflight.size}`);
  }
  while (inflight.size > 0) await Promise.race([...inflight]);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== TCA RECOVERY SUMMARY ===");
  console.log(`apply         : ${APPLY}`);
  console.log(`scanned stubs : ${scanned}`);
  console.log(`tca hits      : ${tcaHits}  (${((tcaHits/scanned)*100).toFixed(1)}%)`);
  console.log(`tca misses    : ${tcaMisses}`);
  console.log(`missing player: ${missingPlayer}`);
  console.log(`malformed     : ${malformed}`);
  console.log(`written       : ${written}`);
  console.log(`errored       : ${errored}`);
  console.log(`elapsed       : ${elapsed}s`);
  if (sampleHits.length > 0) { console.log(`\nSample hits:`); for (const h of sampleHits) console.log(` ${JSON.stringify(h)}`); }
  if (sampleMisses.length > 0) { console.log(`\nSample misses:`); for (const m of sampleMisses) console.log(` ${JSON.stringify(m)}`); }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
