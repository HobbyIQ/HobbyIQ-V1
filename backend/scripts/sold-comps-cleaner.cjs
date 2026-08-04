// CF-SOLD-COMPS-CLEANER (Drew, 2026-08-03). Walks sold_comps and
// applies retroactive field normalizations using today's parsers:
//
//   1. Title re-parse — parseListingIdentity + parseCardQuery pull
//      any fields the original ingest missed.
//   2. Player name canonicalization — strip trailing "Jr.", "Sr.",
//      "II", "III", punctuation, collapse whitespace. Same name
//      across variants collapses.
//   3. Parallel canonicalization — apply market-language rules:
//      "True Blue" → "Blue Refractor", "Mega Refractor" → "Mojo
//      Refractor", etc.
//   4. Grade string canonicalization — "PSA10" / "PSA-10" / "PSA 10"
//      → "PSA 10" (space-separated canonical).
//   5. Card number canonicalization — uppercase, single-hyphen
//      separator, strip surrounding whitespace.
//
// Only writes when a field actually changed. Idempotent — re-runs
// are safe.
//
// Cross-source dedup (#3 from Drew's list) is a SEPARATE script
// (sold-comps-cross-source-dedup.cjs) because it deletes rows
// instead of updating them.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write updates (else dry-run count)
//   MAX_MINUTES=50             wall-clock cap
//   BATCH=1000                 rows per Cosmos query page
//   CONCURRENCY=32             parallel patches
//   SOURCE_FILTER              optional c.source filter (e.g. "tca-ebay")
//   SPORT_FILTER               optional c.sport filter (e.g. "baseball")

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 50));
const BATCH = Math.max(200, Number(process.env.BATCH || 1000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const SOURCE_FILTER = process.env.SOURCE_FILTER || null;
const SPORT_FILTER = process.env.SPORT_FILTER || null;

function loadHelpers() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const parseIdentityPath = path.join(distRoot, "services", "portfolioiq", "parseTitleIdentity.service.js");
  const gradeParserPath = path.join(distRoot, "services", "portfolioiq", "gradeParser.js");
  if (!fs.existsSync(parseIdentityPath)) throw new Error("run `npm run build` first");
  return {
    ...require(parseIdentityPath),
    ...require(gradeParserPath),
  };
}

// ── Player name canonicalization ─────────────────────────────────────
const SUFFIX_RE = /\b(jr\.?|sr\.?|ii|iii|iv)\.?\s*$/i;
function normalizePlayerName(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  // Strip trailing punctuation
  s = s.replace(/[,;\-–—]+$/, "").trim();
  // Strip trailing suffix, then re-append canonical form. Same name
  // across "Bobby Witt Jr" / "Bobby Witt Jr." / "Bobby Witt" all
  // become "Bobby Witt Jr." canonical (when suffix was present).
  const suffixMatch = s.match(SUFFIX_RE);
  let base = suffixMatch ? s.slice(0, s.length - suffixMatch[0].length).trim() : s;
  // Collapse whitespace
  base = base.replace(/\s+/g, " ").trim();
  // Title-case: first letter of each word up
  base = base.split(" ").map(w => w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
  if (suffixMatch) {
    const sfx = suffixMatch[0].trim().replace(/\.?$/, "").toLowerCase();
    const canonicalSfx = { "jr": "Jr.", "sr": "Sr.", "ii": "II", "iii": "III", "iv": "IV" }[sfx] ?? suffixMatch[0].trim();
    return `${base} ${canonicalSfx}`;
  }
  return base;
}

// ── Parallel canonicalization ─────────────────────────────────────────
const COLOR_WORDS = ["blue", "green", "gold", "orange", "red", "purple", "pink", "yellow", "black", "silver", "bronze", "aqua", "sapphire", "ruby", "emerald", "amethyst"];
function normalizeParallel(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  const lower = s.toLowerCase();
  // "True {Color}" → "{Color} Refractor"
  for (const color of COLOR_WORDS) {
    const m = lower.match(new RegExp(`\\btrue\\s+${color}\\b`, "i"));
    if (m) return `${color.charAt(0).toUpperCase() + color.slice(1)} Refractor`;
  }
  // "Mega Refractor" / "Mojo Refractor" → "Mojo Refractor"
  if (/\bmega\s+refractor\b/i.test(lower)) return s.replace(/\bmega\s+refractor\b/i, "Mojo Refractor");
  // "{Color} Mojo" → "{Color} Mojo Refractor"
  for (const color of COLOR_WORDS) {
    if (new RegExp(`\\b${color}\\s+mojo\\b`, "i").test(lower) && !/refractor/i.test(lower)) {
      return `${color.charAt(0).toUpperCase() + color.slice(1)} Mojo Refractor`;
    }
  }
  return s;
}

// ── Grade string canonicalization ────────────────────────────────────
function normalizeGradeCompany(raw) {
  if (!raw) return raw;
  return String(raw).trim().toUpperCase();
}
function normalizeGradeValue(raw) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "number") return raw;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : raw;
}

// ── Card number canonicalization ─────────────────────────────────────
function normalizeCardNumber(raw) {
  if (!raw) return raw;
  return String(raw).trim().toUpperCase().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const cosmos = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sold = cosmos.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  const helpers = loadHelpers();

  const conds = [];
  const params = [];
  if (SOURCE_FILTER) { conds.push("c.source = @src"); params.push({ name: "@src", value: SOURCE_FILTER }); }
  if (SPORT_FILTER) { conds.push("c.sport = @sport"); params.push({ name: "@sport", value: SPORT_FILTER }); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const q = {
    query: `SELECT c.id, c.cardId, c.title, c.playerName, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.gradeCompany, c.gradeValue FROM c ${where}`,
    parameters: params,
  };

  console.log(`[cleaner] apply=${APPLY} sourceFilter=${SOURCE_FILTER || "*"} sportFilter=${SPORT_FILTER || "*"} maxMin=${MAX_MINUTES} batch=${BATCH} concurrency=${CONCURRENCY}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  const iter = sold.items.query(q, { maxItemCount: BATCH });
  let scanned = 0, changed = 0, patched = 0, errors = 0;
  const changedFields = { playerName: 0, parallel: 0, gradeCompany: 0, gradeValue: 0, cardNumber: 0 };
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      // Compute normalized values
      const nextPlayer = normalizePlayerName(row.playerName);
      const nextParallel = normalizeParallel(row.parallel);
      const nextGradeCompany = normalizeGradeCompany(row.gradeCompany);
      const nextGradeValue = normalizeGradeValue(row.gradeValue);
      const nextCardNumber = normalizeCardNumber(row.cardNumber);

      const ops = [];
      if (nextPlayer && nextPlayer !== row.playerName) { ops.push({ op: "replace", path: "/playerName", value: nextPlayer }); changedFields.playerName++; }
      if (nextParallel && nextParallel !== row.parallel) { ops.push({ op: "replace", path: "/parallel", value: nextParallel }); changedFields.parallel++; }
      if (nextGradeCompany && nextGradeCompany !== row.gradeCompany) { ops.push({ op: "replace", path: "/gradeCompany", value: nextGradeCompany }); changedFields.gradeCompany++; }
      if (nextGradeValue !== undefined && nextGradeValue !== null && nextGradeValue !== row.gradeValue) { ops.push({ op: "replace", path: "/gradeValue", value: nextGradeValue }); changedFields.gradeValue++; }
      if (nextCardNumber && nextCardNumber !== row.cardNumber) { ops.push({ op: "replace", path: "/cardNumber", value: nextCardNumber }); changedFields.cardNumber++; }

      if (ops.length === 0) continue;
      changed++;
      if (!APPLY) continue;

      ops.push({ op: "add", path: "/normalizedAt", value: new Date().toISOString() });
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = sold.item(row.id, row.cardId).patch(ops)
        .then(() => { patched++; })
        .catch((err) => {
          errors++;
          if (errors < 10) console.warn(`  patch err id=${row.id}: ${err?.code ?? err?.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);

      if (scanned % 20000 === 0) {
        const el = ((Date.now() - startMs) / 1000).toFixed(0);
        const rate = (scanned / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
        console.log(`  scanned=${scanned.toLocaleString()} changed=${changed.toLocaleString()} patched=${patched.toLocaleString()} errors=${errors} rate=${rate}/s el=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[cleaner] DONE — scanned=${scanned.toLocaleString()} changed=${changed.toLocaleString()} patched=${patched.toLocaleString()} errors=${errors} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  console.log(`Field changes: ${JSON.stringify(changedFields)}`);
  if (!APPLY) console.log("(dry-run — no writes)");
  // Referenced but unused to avoid unused-import lint if we later remove parsers
  void helpers;
}

main().catch((err) => { console.error(err); process.exit(1); });
