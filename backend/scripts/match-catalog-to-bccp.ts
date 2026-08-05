#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-BCCP-MATCH (Drew, 2026-08-04).
 *
 * Joins pool-based canonical catalog rows to their authoritative
 * baseballcardpedia product-structure. Reads BCCP JSON from disk
 * (/tmp/bccp/{year}/{slug}.json — scraped by scrape-bccp-year.ts) and
 * card_catalog rows from Cosmos, then for each pool row:
 *
 *   1. Find the matching BCCP product by (year, setKey).
 *   2. Classify the card as base / parallel / insert / auto by looking
 *      at its parallel name + card-number prefix vs BCCP's enumeration.
 *   3. Look up the specific parallel entry — canonical name equality
 *      after canonicalizeParallelName() on both sides.
 *   4. Stamp fields on the catalog row:
 *        bccpProductPage:    "2024 Bowman Chrome"
 *        bccpMatchedAs:      "base" | "parallel" | "insert" | "auto"
 *        bccpParallelName:   "Gold Refractor" (when parallel)
 *        bccpPrintRun:       50               (from BCCP if present)
 *        bccpSubsetName:     "Prospect Autographs" (when insert/auto)
 *        bccpSubsetPrefix:   "CPA"
 *        bccpMatched:        true / false
 *        bccpMatchedAt:      ISO timestamp
 *
 * Rows with no matching BCCP product (product not scraped, or setKey
 * doesn't align) get bccpMatched=false + a reason field. Those become
 * follow-up work — either fix the setKey normalization or add the
 * product to the scrape list.
 *
 * Uses container.items.bulk() patch. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx backend/scripts/match-catalog-to-bccp.ts \
 *     --year YYYY --sport baseball [--indir /tmp/bccp] [--dry-run]
 */

import { CosmosClient } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  year?: number;
  sport?: string;
  indir?: string;
  clcIndir?: string;
  dryRun?: boolean;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball", indir: "c:/tmp/bccp", clcIndir: "c:/tmp/clc" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--indir") { args.indir = v; i++; }
    else if (f === "--clc-indir") { args.clcIndir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
  }
  return args;
}

interface BccpParallel { section: string; name: string; printRun: number | null }
interface BccpSubset { name: string; cardPrefix: string | null; parallelCount?: number }
interface BccpProduct {
  page: string;
  year: number;
  parallels: BccpParallel[];
  inserts: BccpSubset[];
  autos: BccpSubset[];
  gameUsed: BccpSubset[];
  gimmicks: BccpSubset[];
}

interface BccpIndex {
  bySetKey: Map<string, BccpProduct[]>;   // multiple products can share setKey (e.g. Chrome + Chrome Update)
  byPrefix: Map<string, { subset: BccpSubset; product: BccpProduct; subsetType: "insert" | "auto" | "gameUsed" | "gimmick" }>;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Build a fast lookup index from the scraped JSON files for a given year.
 *  CF-CLC-MERGE (2026-08-05): also folds in checklistcenter data from
 *  c:/tmp/clc/{year}/*.json — its products land in bySetKey alongside
 *  BCCP's so classify() naturally picks up parallels from either source. */
function buildBccpIndex(indir: string, year: number, clcIndir?: string): BccpIndex {
  const dir = join(indir, String(year));
  const bySetKey = new Map<string, BccpProduct[]>();
  const byPrefix = new Map<string, { subset: BccpSubset; product: BccpProduct; subsetType: "insert" | "auto" | "gameUsed" | "gimmick" }>();

  // BCCP first
  try {
    statSync(dir);
    const files = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "products.json");
    ingestFilesInto(dir, files, bySetKey, byPrefix, "bccp");
  } catch { /* no BCCP data for this year */ }

  // CLC as secondary source — augments BCCP for the same setKey, and
  // adds coverage for years BCCP doesn't have (e.g. 2026).
  if (clcIndir) {
    const clcDir = join(clcIndir, String(year));
    try {
      statSync(clcDir);
      const clcFiles = readdirSync(clcDir).filter((n) => n.endsWith(".json"));
      ingestFilesInto(clcDir, clcFiles, bySetKey, byPrefix, "clc");
    } catch { /* no CLC data for this year */ }
  }
  return { bySetKey, byPrefix };
}

/** Shared file → index ingestor. Both BCCP and CLC scrapes produce
 *  JSON with the same top-level shape (page/subsets vs parallels/inserts/
 *  autos), so we normalize on read. */
function ingestFilesInto(
  dir: string,
  files: string[],
  bySetKey: Map<string, BccpProduct[]>,
  byPrefix: Map<string, { subset: BccpSubset; product: BccpProduct; subsetType: "insert" | "auto" | "gameUsed" | "gimmick" }>,
  source: "bccp" | "clc",
): void {
  for (const f of files) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, f), "utf8")); }
    catch { continue; }

    let sp: BccpProduct;
    if (source === "bccp") {
      sp = raw as BccpProduct;
    } else {
      // CLC → BCCP shape adapter. CLC has subsets[] each with parallels[]
      // inside; flatten to top-level parallels[] tagged with subset title.
      const clc = raw as { url?: string; year?: number | null; sourceSlug?: string; productName?: string; subsets?: Array<{ title: string; cardCount: number | null; parallels: Array<{ name: string; printRun: number | null }> }> };
      const productPage = clc.productName ?? clc.sourceSlug ?? "unknown";
      sp = {
        page: productPage,
        year: clc.year ?? 0,
        parallels: (clc.subsets ?? []).flatMap((s) =>
          s.parallels.map((p) => ({ section: s.title, name: p.name, printRun: p.printRun }))
        ),
        inserts: [], autos: [], gameUsed: [], gimmicks: [],
      };
    }

    const withoutYear = (sp.page ?? "").toString().replace(/^\d{4}[_ -]/, "").replace(/_/g, " ");
    const setKey = normalizeSetKey(withoutYear);
    let arr = bySetKey.get(setKey);
    if (!arr) { arr = []; bySetKey.set(setKey, arr); }
    arr.push(sp);
    const stamp = (list: BccpSubset[], subsetType: "insert" | "auto" | "gameUsed" | "gimmick"): void => {
      for (const sub of list) {
        if (!sub.cardPrefix) continue;
        const key = `${sp.year}:${sub.cardPrefix.toUpperCase()}`;
        if (!byPrefix.has(key)) byPrefix.set(key, { subset: sub, product: sp, subsetType });
      }
    };
    stamp(sp.inserts, "insert");
    stamp(sp.autos, "auto");
    stamp(sp.gameUsed, "gameUsed");
    stamp(sp.gimmicks, "gimmick");
  }
}

/** Extract the leading alphanumeric prefix from a card number: "BCP-150" → "BCP". */
/** CF-SETKEY-RECOVERY (Drew, 2026-08-05). Ordered lookup chain for
 *  a pool row's setKey. Rescues rows whose setKey was baked from
 *  vendor-slug noise (e.g. "1990-score-baseball") or from a Canadian
 *  parallel-print family (o-pee-chee) that shares numbering with a
 *  known base product (topps). Order matters: literal first (never
 *  demote a real match), then stripped, then family-fallback. */
function deriveSetKeyLookupChain(rawSetKey: string): string[] {
  const chain: string[] = [];
  const push = (s: string | undefined | null) => {
    if (s && !chain.includes(s)) chain.push(s);
  };
  push(rawSetKey);
  if (!rawSetKey) return chain;
  // Strip leading "YYYY-" prefix (TCDB-style keys like "1990-score-baseball").
  let stripped = rawSetKey.replace(/^(?:19|20)\d{2}-/, "");
  // Strip trailing sport tag if any ("...-baseball", "...-basketball", ...).
  stripped = stripped.replace(/-(?:baseball|basketball|football|hockey|soccer)$/, "");
  push(stripped);
  // Canonical brand aliases for common vintage / low-coverage lines.
  // If BCCP has a modern equivalent product page under a bare brand
  // key, this lets pool rows land on it.
  const BRAND_ALIASES: Record<string, string> = {
    // O-Pee-Chee is Canadian-printed Topps with identical numbering.
    // Same-year Topps checklist is the authoritative BCCP product page.
    "o-pee-chee": "topps",
    // Score / Fleer / Leaf / Upper Deck vintage line collapses.
    "score": "score",
    "select-certified": "score-select",
    "metal-universe": "metal-universe",
    "skybox-premium": "skybox",
    "skybox-thunder": "skybox",
    "skybox-molten-metal": "skybox",
    "circa-thunder": "fleer-circa",
    "leaf": "leaf",
    "collectors-choice": "upper-deck-collectors-choice",
    "collectors-choice-se": "upper-deck-collectors-choice",
    "pacific-paramount": "pacific",
    "batter-up": "goudey",
    "play-ball": "gum-inc-play-ball",
    "r318-batter-up": "goudey",
    "base-set": "topps",
  };
  const alias = BRAND_ALIASES[stripped];
  push(alias);
  return chain;
}

function extractCardNumberPrefix(cardNumber: string | null | undefined): string | null {
  if (!cardNumber) return null;
  const m = String(cardNumber).match(/^([A-Za-z0-9]{2,6})-/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * CF-BCCP-PARALLEL-NORMALIZATION (Drew, 2026-08-05).
 *
 * Aggressive normalization applied to BOTH sides of the parallel-name
 * compare, on top of canonicalizeParallelName. Strips the noise we
 * confirmed drives the ~38% "parallel-not-in-BCCP" miss rate:
 *
 *   - trailing "/N" print-run tokens the scraper never stripped
 *     ("Gold Refractor /50" → "gold refractor")
 *   - written 1-of-1 markers ("SuperFractor 1-of-1", "one of one")
 *   - parenthetical qualifiers ("(SP)", "(HOB)", "(retail only)",
 *     "(hobby only)", "(mega box)", "(walmart)", "(target)", …)
 *   - Roman-numeral qualifiers ("XIV") if trailing
 *   - trailing serial-numbered blurbs left after the strict paren
 *     capture missed them (defensive)
 *   - ordering: "Refractor Blue" ↔ "Blue Refractor" (canonicalize
 *     already tries; we sort word bag as belt-and-suspenders)
 *   - whitespace + punctuation trim
 *
 * Returns the normalized key both sides compare with. Empty return
 * means "base" — caller should short-circuit to base match.
 */
function normalizeParallelForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  // Strip print-run trailing "/N" up to two occurrences (e.g. "/25" or "/25/25 case hits").
  s = s.replace(/\s*\/\s*\d[\d,]*\b/g, "");
  // Strip "serial-numbered to N copies" and its typos. Fixed 2026-08-05:
  // earlier version used [eir]{4} which doesn't match the `a` in "seri**a**l"
  // — every BCCP paren was slipping through. Now: s + any 4 of [eiral] + l.
  // Matches "serial", "seiral" (r/i transposed), "seiial" (typo). Also
  // strip freestanding "to N copies" (some entries have malformed parens).
  s = s.replace(/\(s[eiral]{4}l-numbered\s+to\s+(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)\s+copies?\)/gi, "");
  s = s.replace(/\(numbered\s+to\s+\d[\d,]*\s+copies?\)/gi, "");
  // Bare (no parens) trailing serial-numbered suffix — also seen in the wild.
  s = s.replace(/\bs[eiral]{4}l-numbered\s+to\s+(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)\s+copies?\b/gi, "");
  // Strip 1-of-1 / one-of-one markers
  s = s.replace(/\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/gi, "");
  s = s.replace(/\bone[-\s]of[-\s]one\b/gi, "");
  // Strip parenthetical distribution / short-print / venue qualifiers.
  // Retail vs Hobby is a real distinction for some products but breaks
  // matches for most; treat them as noise for now (better to over-match
  // and let downstream disambiguation refine).
  s = s.replace(/\(\s*(sp|ssp|hob|hobby|hobby[- ]only|ret|retail|retail[- ]only|mega|mega[- ]box|walmart|target|toys[- ]?r[- ]?us|hobby[- ]box|blaster|fat[- ]pack|jumbo|nscc|shp|super[- ]short[- ]print)\s*\)/gi, "");
  // Strip wiki-link brackets → text
  s = s.replace(/\[\[([^\|\]]+\|)?([^\]]+)\]\]/g, "$2");
  // Slugify: lowercase, non-alphanum → space, collapse spaces
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";
  // CF-BCCP-PLURAL-NORM (2026-08-05). BCCP often lists parallels as
  // plurals ("Refractors", "Gold Refractors", "Prizms"). Our pool uses
  // singular ("Refractor", "Gold Refractor", "Prizm"). Strip trailing 's'
  // on well-known parallel roots so they collapse to the same key. This
  // was the #1 miss driver — "Refractor" alone was 9,989 unmatched rows
  // solely because BCCP calls them "Refractors" and we called them
  // "Refractor". Only 8 known parallel-noun roots — safe list.
  const PLURAL_ROOTS = ["refractor", "prizm", "auto", "autograph", "mojo", "foil", "shimmer", "wave"];
  const singulars = s.split(" ").map((w) => {
    const stripped = w.endsWith("s") ? w.slice(0, -1) : w;
    return PLURAL_ROOTS.includes(stripped) ? stripped : w;
  });
  s = singulars.join(" ");
  // Order-insensitive: sort word bag so "refractor blue" ≡ "blue refractor".
  const words = s.split(" ").filter(Boolean);
  if (words.length >= 2 && words.length <= 5) {
    return words.slice().sort().join(" ");
  }
  return s;
}

/** Given a catalog row and BCCP index, decide what it matches. */
function classify(row: CatalogRow, index: BccpIndex): MatchResult {
  const prefix = extractCardNumberPrefix(row.cardNumber);
  // 1. If card number has a prefix that matches a known insert/auto/gu/gimmick subset for this year, that wins.
  if (prefix) {
    const hit = index.byPrefix.get(`${row.year}:${prefix}`);
    if (hit) {
      return {
        matched: true,
        matchedAs: hit.subsetType === "insert" ? "insert" : hit.subsetType === "auto" ? "auto" : hit.subsetType === "gameUsed" ? "gameUsed" : "gimmick",
        productPage: hit.product.page,
        subsetName: hit.subset.name,
        subsetPrefix: hit.subset.cardPrefix,
        parallelName: null,
        printRun: null,
      };
    }
  }
  // 2. Otherwise, look up the pool row's setKey in BCCP index. Try the
  //    literal setKey first, then a normalized variant (strip YYYY-
  //    prefix + trailing -baseball/-basketball/etc.), then a family
  //    fallback for O-Pee-Chee → Topps (same numbering, Canadian
  //    parallel print). CF-SETKEY-RECOVERY (Drew, 2026-08-05). The
  //    2026-08-05 baseball-null diagnostic showed ~3,500 rows with
  //    `1990-score-baseball`-style keys that never derived properly at
  //    pool-build time, plus ~2,473 O-Pee-Chee rows for which the same
  //    year's Topps checklist is authoritative.
  const setKeyCandidates = deriveSetKeyLookupChain(row.setKey);
  let products;
  let matchedVia = row.setKey;
  for (const candidate of setKeyCandidates) {
    const hit = index.bySetKey.get(candidate);
    if (hit && hit.length > 0) {
      products = hit;
      matchedVia = candidate;
      break;
    }
  }
  if (!products || products.length === 0) {
    return { matched: false, reason: `no-BCCP-product-for-setKey-${row.setKey}` };
  }
  // 3. If parallel is "Base" or empty, this is a base card. Pick the
  //    first product for productPage attribution.
  const parallelCanon = canonicalizeParallelName(row.parallel);
  const setKeyRecoveryNote = matchedVia !== row.setKey ? `via:${matchedVia}` : undefined;
  if (!parallelCanon || parallelCanon.toLowerCase() === "base") {
    return {
      matched: true,
      matchedAs: "base",
      productPage: products[0].page,
      subsetName: null,
      subsetPrefix: null,
      parallelName: null,
      printRun: null,
      reason: setKeyRecoveryNote,
    };
  }
  // 4. CF-MATCH-ALL-PRODUCTS (2026-08-05). Iterate EVERY product at this
  //    setKey — not just products[0]. Multiple BCCP pages collapse to
  //    the same setKey via product-family aliasing (e.g. Topps Chrome +
  //    Topps Chrome Update both → topps-chrome). Previously we only
  //    checked the first product, so ~14,500 pool rows with a plain
  //    "Refractor" parallel that belonged to Chrome Update rather than
  //    base Chrome were missing the match.
  //    Two-pass per product: canonicalizeParallelName strict equality
  //    first, aggressive normalizeParallelForMatch fallback second.
  const parallelCanonLower = parallelCanon.toLowerCase();
  const parallelAggressive = normalizeParallelForMatch(row.parallel);
  for (const product of products) {
    for (const p of product.parallels) {
      if (canonicalizeParallelName(p.name).toLowerCase() === parallelCanonLower) {
        return {
          matched: true, matchedAs: "parallel", productPage: product.page,
          subsetName: null, subsetPrefix: null,
          parallelName: p.name, printRun: p.printRun,
        };
      }
    }
  }
  if (parallelAggressive) {
    for (const product of products) {
      for (const p of product.parallels) {
        if (normalizeParallelForMatch(p.name) === parallelAggressive) {
          return {
            matched: true, matchedAs: "parallel", productPage: product.page,
            subsetName: null, subsetPrefix: null,
            parallelName: p.name, printRun: p.printRun,
          };
        }
      }
    }
  }
  // 5. Parallel not found in BCCP — still a parallel, but with no BCCP-verified name.
  return {
    matched: false,
    reason: `parallel-not-in-BCCP:${parallelCanon}`,
    matchedAs: "parallel-unverified",
    productPage: products[0].page,
  };
}

interface CatalogRow { id: string; cardId: string; year: number; setKey: string; cardNumber?: string; parallel?: string; isAuto?: boolean }
interface MatchResult {
  matched: boolean;
  matchedAs?: "base" | "parallel" | "insert" | "auto" | "gameUsed" | "gimmick" | "parallel-unverified";
  productPage?: string;
  subsetName?: string | null;
  subsetPrefix?: string | null;
  parallelName?: string | null;
  printRun?: number | null;
  reason?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) { console.error("Usage: match-catalog-to-bccp.ts --year YYYY --sport <sport> [--dry-run]"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const indir = args.indir ?? "c:/tmp/bccp";
  const clcIndir = args.clcIndir ?? "c:/tmp/clc";
  console.log(`\n▸ Building index from BCCP=${indir}/${args.year} + CLC=${clcIndir}/${args.year}...`);
  const index = buildBccpIndex(indir, args.year, clcIndir);
  console.log(`  ${index.bySetKey.size} distinct setKeys (BCCP+CLC), ${index.byPrefix.size} insert/auto prefixes`);
  if (index.bySetKey.size === 0) { console.error("  ! No data for this year from either source."); process.exit(1); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n▸ Scanning card_catalog for pool-based rows (year=${args.year}, sport=${args.sport}, source=bulk-build-from-pool)...`);
  const iterator = cat.items.query<CatalogRow>({
    query: "SELECT c.id, c.cardId, c.year, c.setKey, c.cardNumber, c.parallel, c.isAuto FROM c WHERE c.sport = @sport AND c.year = @year AND c.source = 'bulk-build-from-pool'",
    parameters: [{ name: "@sport", value: args.sport }, { name: "@year", value: args.year }],
  }, { maxItemCount: 500 });
  const rows: CatalogRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  scanned ${rows.length}\r`);
  }
  console.log(`\n  ✓ ${rows.length} rows to match`);
  if (rows.length === 0) process.exit(0);

  // Classify all rows.
  const classifications = new Map<string, MatchResult>();
  const stats = { base: 0, parallel: 0, insert: 0, auto: 0, gameUsed: 0, gimmick: 0, "parallel-unverified": 0, unmatched: 0 };
  for (const row of rows) {
    const result = classify(row, index);
    classifications.set(row.id, result);
    if (result.matched) stats[result.matchedAs as keyof typeof stats]++;
    else if (result.matchedAs) stats[result.matchedAs as keyof typeof stats]++;
    else stats.unmatched++;
  }
  console.log(`\n▸ Classification totals:`);
  for (const [k, v] of Object.entries(stats)) console.log(`   ${k.padEnd(22)} ${v}`);

  if (args.dryRun) { console.log("\n▸ DRY RUN — no writes."); process.exit(0); }

  console.log(`\n▸ Patching card_catalog...`);
  const startedAt = Date.now();
  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  let patched = 0, errors = 0, done = 0;
  const total = rows.length;
  const chunks: CatalogRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  async function runChunk(chunk: CatalogRow[]): Promise<void> {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const now = new Date().toISOString();
      const ops = pending.map((row) => {
        const m = classifications.get(row.id)!;
        const setOps: Array<{ op: "set" | "add"; path: string; value: unknown }> = [
          { op: "set", path: "/bccpMatched", value: m.matched },
          { op: "set", path: "/bccpMatchedAt", value: now },
        ];
        if (m.matchedAs) setOps.push({ op: "set", path: "/bccpMatchedAs", value: m.matchedAs });
        if (m.productPage) setOps.push({ op: "set", path: "/bccpProductPage", value: m.productPage });
        if (m.parallelName) setOps.push({ op: "set", path: "/bccpParallelName", value: m.parallelName });
        if (m.printRun !== null && m.printRun !== undefined) setOps.push({ op: "set", path: "/bccpPrintRun", value: m.printRun });
        if (m.subsetName) setOps.push({ op: "set", path: "/bccpSubsetName", value: m.subsetName });
        if (m.subsetPrefix) setOps.push({ op: "set", path: "/bccpSubsetPrefix", value: m.subsetPrefix });
        if (m.reason) setOps.push({ op: "set", path: "/bccpNotMatchedReason", value: m.reason });
        return { operationType: "Patch" as const, id: row.id, partitionKey: row.id, resourceBody: { operations: setOps } };
      });
      try {
        const results = await cat.items.bulk(ops);
        const next: CatalogRow[] = [];
        let maxRetryAfterMs = 0;
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.statusCode >= 200 && r.statusCode < 300) { patched++; done++; }
          else if (r.statusCode === 429) {
            next.push(pending[j]);
            const ra = (r as { retryAfterMilliseconds?: number }).retryAfterMilliseconds;
            if (typeof ra === "number" && ra > maxRetryAfterMs) maxRetryAfterMs = ra;
          } else { errors++; done++; }
        }
        pending = next;
        if (pending.length > 0) {
          attempt++;
          const wait = Math.max(maxRetryAfterMs, 200 * Math.pow(2, Math.min(attempt, 6)));
          await new Promise((r) => setTimeout(r, wait));
        }
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/request rate is too large/i.test(msg) && attempt < MAX_RETRIES) {
          attempt++;
          const wait = 200 * Math.pow(2, Math.min(attempt, 6));
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        errors += pending.length; done += pending.length;
        return;
      }
    }
    if (pending.length > 0) { errors += pending.length; done += pending.length; }
  }

  for (let i = 0; i < chunks.length; i += PARALLEL_BULKS) {
    const batch = chunks.slice(i, i + PARALLEL_BULKS);
    await Promise.all(batch.map(runChunk));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(1, elapsedSec);
    process.stdout.write(`  ...patched ${patched}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s\r`);
  }
  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s: patched=${patched}, errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
