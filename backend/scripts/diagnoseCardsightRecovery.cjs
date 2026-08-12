// CF-CARDSIGHT-STUB-RECOVERY-DIAG (Drew, 2026-08-08). Aggressive
// recovery diagnostic on cardsight search-hint stubs (year+set+player,
// no cardNumber). Per stub:
//
//   Step 1  Cross-reference: query card_catalog for existing entries
//           with matching (year, normalized setName, playerName). If
//           unique cardNumber found → copy.
//   Step 2  Naming rules: parse setName for autograph-set prefix
//           (Chrome Prospect Autographs → CPA-, etc.) then form
//           cardNumber = <prefix><playerInitials>.
//   Step 3  LLM inference: parseTitleWithAi with an augmented prompt
//           carrying setName + player + variant hints.
//
// Reports the % recovered at each step so we know real-world yield.
// No writes — pure diagnostic.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AZURE_OPENAI_*             required for Step 3 (set by caller)
//   SAMPLE_SIZE                default 200
//   ENABLE_LLM                 default true
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const SAMPLE_SIZE = Math.max(10, Number(process.env.SAMPLE_SIZE || 200));
const ENABLE_LLM  = process.env.ENABLE_LLM !== "false";

function loadParseTitleWithAi() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "titleParserAi.service.js");
  if (!fs.existsSync(p)) throw new Error(`titleParserAi helper not found at ${p} — run \`npm run build\` first`);
  return require(p).parseTitleWithAi;
}

// Autograph set → cardNumber prefix. From parseTitleIdentity.service.ts vocab.
const AUTO_SET_PREFIX = [
  { rx: /chrome\s+prospects?\s+autograph/i,       prefix: "CPA" },
  { rx: /bowman\s+chrome\s+prospects?\s+autograph/i, prefix: "BCPA" },
  { rx: /bowman\s+draft\s+prospects?\s+autograph/i, prefix: "BDPA" },
  { rx: /bowman\s+chrome\s+draft\s+autograph/i,   prefix: "BCDA" },
  { rx: /bowman\s+sterling\s+prospects?\s+autograph/i, prefix: "BSPA" },
  { rx: /bowman\s+prospects?\s+autograph/i,       prefix: "BPA" },
  { rx: /bowman\s+draft\s+autograph/i,            prefix: "BDA" },
  { rx: /topps\s+chrome\s+rookie\s+autograph/i,   prefix: "TCRA" },
  { rx: /bowman\s+chrome\s+rookie\s+autograph/i,  prefix: "BCRA" },
  { rx: /finest\s+rookie\s+autograph/i,           prefix: "FRA" },
];

function playerInitials(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return null;
  // First initial + last initial (e.g. "Owen Carey" → "OC"). Handles
  // 3+ word names (middle name) by taking first + last only.
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function normalizeSet(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\b(baseball|basketball|football|hockey|soccer|golf)\b/g, "")
    .replace(/^\d{4}\s+/, "")
    .trim();
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");
  const parseAi = ENABLE_LLM ? loadParseTitleWithAi() : null;

  console.log(`[recovery-diag] sample=${SAMPLE_SIZE} llm=${ENABLE_LLM}`);

  // Fetch a sample of no-cardNumber cardsight docs
  const { resources: sample } = await cat.items.query({
    query: `SELECT TOP @n c.id, c.title, c.setName, c.year, c.cardYear, c.searchText
            FROM c
            WHERE STARTSWITH(c.id, 'cardsight::')
              AND (NOT IS_DEFINED(c.cardNumber) OR c.cardNumber = null)
              AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null)`,
    parameters: [{ name: "@n", value: SAMPLE_SIZE }],
  }, { maxItemCount: 25 }).fetchAll();

  console.log(`Sample fetched: ${sample.length}\n`);

  const results = {
    recoveredStep1_crossref: 0,
    recoveredStep2_naming: 0,
    recoveredStep3_llm: 0,
    unrecovered: 0,
    stubMissingPlayer: 0,
    llmErrors: 0,
  };
  const examples = { crossref: [], naming: [], llm: [], unrecovered: [] };

  for (const doc of sample) {
    const setName = String(doc.setName ?? "").trim();
    const year = Number(doc.year ?? doc.cardYear ?? 0);
    // Player usually only in title (not the player field); parse from title
    const player = String(doc.title ?? "").trim();
    if (!player) { results.stubMissingPlayer++; continue; }

    // Step 1: cross-reference
    const setNorm = normalizeSet(setName);
    try {
      const { resources: xref } = await cat.items.query({
        query: `SELECT TOP 3 c.cardNumber, c.hobbyiqCardId
                FROM c
                WHERE (c.cardYear = @y OR c.year = @y)
                  AND (LOWER(c.playerName) = @p OR LOWER(c.player) = @p OR LOWER(c.title) = @p)
                  AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null
                  AND CONTAINS(LOWER(c.setName ?? c.setKey ?? ''), @s)`,
        parameters: [
          { name: "@y", value: year },
          { name: "@p", value: player.toLowerCase() },
          { name: "@s", value: setNorm.slice(0, 20) },
        ],
      }).fetchAll();
      if (xref.length === 1 && xref[0].cardNumber) {
        results.recoveredStep1_crossref++;
        if (examples.crossref.length < 3) examples.crossref.push({ stub: `${player} #? ${setName}`, recovered: xref[0].cardNumber, slug: xref[0].hobbyiqCardId });
        continue;
      }
    } catch { /* ignore, fall through */ }

    // Step 2: naming rule
    let namingRecovered = null;
    for (const rule of AUTO_SET_PREFIX) {
      if (rule.rx.test(setName)) {
        const initials = playerInitials(player);
        if (initials) { namingRecovered = `${rule.prefix}-${initials}`; break; }
      }
    }
    if (namingRecovered) {
      results.recoveredStep2_naming++;
      if (examples.naming.length < 3) examples.naming.push({ stub: `${player} · ${setName}`, recovered: namingRecovered });
      continue;
    }

    // Step 3: LLM inference
    if (parseAi) {
      try {
        const context = `${year} ${setName} ${player}${doc.searchText ? " (raw: " + doc.searchText + ")" : ""}`;
        const llmResult = await parseAi(context.slice(0, 400));
        if (llmResult?.cardNumber) {
          results.recoveredStep3_llm++;
          if (examples.llm.length < 3) examples.llm.push({ stub: context.slice(0, 80), recovered: llmResult.cardNumber });
          continue;
        }
      } catch { results.llmErrors++; }
    }

    results.unrecovered++;
    if (examples.unrecovered.length < 5) examples.unrecovered.push({ player, setName, year });
  }

  console.log("=== DIAGNOSTIC SUMMARY ===");
  const total = sample.length;
  const pct = (n) => ((n / total) * 100).toFixed(1) + "%";
  console.log(`total sampled                : ${total}`);
  console.log(`  step 1 cross-ref recovered : ${results.recoveredStep1_crossref}  (${pct(results.recoveredStep1_crossref)})`);
  console.log(`  step 2 naming rule         : ${results.recoveredStep2_naming}  (${pct(results.recoveredStep2_naming)})`);
  console.log(`  step 3 LLM                 : ${results.recoveredStep3_llm}  (${pct(results.recoveredStep3_llm)})`);
  console.log(`  unrecovered                : ${results.unrecovered}  (${pct(results.unrecovered)})`);
  console.log(`  stub missing player        : ${results.stubMissingPlayer}`);
  console.log(`  llm errors                 : ${results.llmErrors}`);
  const rec = total - results.unrecovered - results.stubMissingPlayer;
  console.log(`  TOTAL RECOVERED            : ${rec}  (${pct(rec)})`);

  console.log("\n=== Examples ===");
  for (const [k, exs] of Object.entries(examples)) {
    console.log(`\n  ${k}:`);
    for (const e of exs) console.log(`    ${JSON.stringify(e)}`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
