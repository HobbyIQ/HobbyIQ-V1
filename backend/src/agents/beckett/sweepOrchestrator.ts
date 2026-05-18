/**
 * Checklist Sweep Orchestrator
 * ---------------------------------------------------------------------------
 * Phase A entry point. For each `(year, brand)` tuple in the configured
 * sweep matrix, this module:
 *
 *   1. Resolves the live checklist URL via source-specific discovery.
 *   2. Downloads the .xlsx via source-specific fetcher.
 *   3. Parses the workbook via source-specific parser.
 *   4. Normalizes parallel names against the 54-entry canonical table
 *      ({@link normalizeParallelName}), feeding unmatched names into the
 *      review queue.
 *   5. Deduplicates cards via {@link dedupCards}.
 *   6. Stages the result to `backend/data/{source}-sweep/{year}/{brand}.json`.
 *
 * At the end of the sweep it writes:
 *   - `SUMMARY.json`            (per-tuple roll-up for owner review)
 *   - `unmatchedParallels.json` (frequency-sorted unmatched-name queue)
 *   - `REPORT.md`               (markdown summary)
 *
 * Constraints enforced:
 *   - 500ms minimum delay between live S3 requests.
 *   - Resumable: skip a tuple if `{year}/{brand}.json` already exists, unless
 *     `--force` is passed.
 *   - Concurrency capped at 3 (process tuples in batches).
 *   - NO production writes. Everything lands under `backend/data/beckett-sweep/`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  discoverBeckettChecklistUrl,
  type DiscoveryAttempt,
} from "./beckettUrlDiscovery.js";
import { BeckettFetchError } from "./beckettChecklistFetcher.js";
import {
  parseBeckettChecklist,
  type BeckettChecklistParsed,
} from "./beckettChecklistParser.js";
import {
  discoverCardboardConnectionChecklistUrl,
  type CardboardConnectionDiscoveryAttempt,
} from "../cardboardConnection/cardboardConnectionUrlDiscovery.js";
import {
  fetchCardboardConnectionChecklist,
} from "../cardboardConnection/cardboardConnectionFetcher.js";
import {
  parseCardboardConnectionChecklist,
} from "../cardboardConnection/cardboardConnectionParser.js";
import {
  normalizeParallelName,
  UnmatchedParallelsAccumulator,
  type NormalizationResult,
} from "./parallelNameNormalizer.js";
import { dedupCards, type DedupedCard } from "./cardDedup.js";
import {
  getBrandEntry,
  isYearInBounds,
  type BrandFamily,
} from "./brandRegistry.js";

// ---------------------------------------------------------------------------
// Sweep matrix
// ---------------------------------------------------------------------------

export const DEFAULT_BRANDS: readonly string[] = Object.freeze([
  "Bowman",
  "Bowman Chrome",
  "Bowman Draft",
  "Bowman Sterling",
  "Bowman Platinum",
  "Bowman's Best",
  "Bowman Mega",
  "Bowman Inception",
  "Bowman Transcendent",
  "Bowman Heritage",
]);

export const DEFAULT_YEARS: readonly number[] = Object.freeze(
  Array.from({ length: 18 }, (_, i) => 2009 + i), // 2009 .. 2026
);

export type SweepSource = "beckett" | "cardboard-connection";

const MIN_REQUEST_SPACING_MS_BY_SOURCE: Record<SweepSource, number> = {
  beckett: 500,
  "cardboard-connection": 750,
};
const DEFAULT_CONCURRENCY = 2; // <= 3 cap per prompt
const SPORT = "Baseball";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface NormalizedParallel {
  rawName: string;
  printRun: number | null;
  isOneOfOne: boolean;
  note: string | null;
  normalization: NormalizationResult;
}

export interface SweepTupleResult {
  year: number;
  brand: string;
  /** True when the orchestrator produced staged output for this tuple. */
  ok: boolean;
  /** Reason for failure when `ok === false`. */
  reason?: string;
  /** Final matched S3 URL (or null on miss). */
  sourceUrl: string | null;
  /** Brand variant that matched (signals BRAND_VARIANTS may need tuning). */
  matchedBrandVariant: string | null;
  /** True when a non-primary brand variant was used. */
  matchedNonPrimaryVariant: boolean;
  /** Per-probe audit trail from URL discovery. */
  discoveryAttempts: Array<DiscoveryAttempt | CardboardConnectionDiscoveryAttempt>;
  /** Workbook-level parse counts. */
  rawCardCount: number;
  dedupedCardCount: number;
  parallelCount: number;
  unmatchedParallelCount: number;
  diagnosticsCount: number;
  /** Wall-clock duration for this tuple in ms. */
  durationMs: number;
}

export interface SweepSummary {
  source: SweepSource;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tuplesAttempted: number;
  tuplesOk: number;
  tuplesMissing: number;
  tuplesError: number;
  totalDedupedCards: number;
  totalParallels: number;
  totalUnmatchedParallels: number;
  totalDiagnostics: number;
  brands: readonly string[];
  years: readonly number[];
  results: SweepTupleResult[];
}

export interface SweepOptions {
  /** Checklist source. Default: "beckett". */
  source?: SweepSource;
  /** Year list override (default: 2009..2026). */
  years?: readonly number[];
  /** Brand list override (default: 10-brand Bowman family). */
  brands?: readonly string[];
  /** Force re-fetch even when staged file exists. Default false. */
  force?: boolean;
  /** Max parallel tuples (hard cap 3). Default 2. */
  concurrency?: number;
  /** Absolute output dir. Default `<repo>/backend/data/{source}-sweep`. */
  outDir?: string;
  /** Per-fetch timeout. Default 30s. */
  timeoutMs?: number;
  /**
   * Phase A.3 mode. When set:
   *  - Tuples are filtered by each brand's `firstYear/lastYear` registry bounds.
   *  - Per-tuple summary + report are written to `REPORT-A3.md` (in addition
   *    to merging the A.3 run into `SUMMARY.json`).
   *  - `SUMMARY.json` is written under a separate `SUMMARY-A3.json` filename
   *    so the frozen A.2 `SUMMARY.json` is preserved.
   */
  a3Mode?: boolean;
  /** Per-probe HEAD probe cap (forwarded to URL discovery). */
  maxProbes?: number;
  /** Limit input brands to this family (e.g. "Topps", "Panini"). */
  brandFamily?: BrandFamily;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runBeckettSweep(opts: SweepOptions = {}): Promise<SweepSummary> {
  const source = opts.source ?? "beckett";
  const brands = opts.brands ?? DEFAULT_BRANDS;
  const years = opts.years ?? DEFAULT_YEARS;
  const force = opts.force ?? false;
  const concurrency = Math.min(Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1), 3);
  const outDir = opts.outDir ?? defaultOutDir(source);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const a3Mode = opts.a3Mode ?? false;
  const maxProbes = opts.maxProbes;

  await fs.mkdir(outDir, { recursive: true });

  const tuples: Array<{ year: number; brand: string }> = [];
  for (const year of years) {
    for (const brand of brands) {
      // Year-bound filtering when registry knows the brand. This avoids
      // pointless probes against e.g. 2009 Donruss (Panini took the license
      // in 2014) or 2020+ Topps Sterling (discontinued).
      const entry = getBrandEntry(brand);
      if (entry && !isYearInBounds(entry, year)) continue;
      tuples.push({ year, brand });
    }
  }

  const startedAt = new Date();
  const startMs = startedAt.getTime();
  console.log(
    `[sweep] starting source=${source} year=${years.length} brand=${brands.length} ` +
      `tuples=${tuples.length} concurrency=${concurrency} force=${force}`,
  );

  // Shared rate-limit lock — source-specific minimum spacing.
  const limiter = new RequestSpacer(MIN_REQUEST_SPACING_MS_BY_SOURCE[source]);
  const unmatched = new UnmatchedParallelsAccumulator();

  const results: SweepTupleResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= tuples.length) return;
      const { year, brand } = tuples[idx]!;
      const r = await processTuple({
        source,
        year,
        brand,
        outDir,
        force,
        timeoutMs,
        limiter,
        unmatched,
        maxProbes,
      });
      results.push(r);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Stable result sort: year asc, brand asc
  results.sort((a, b) => (a.year !== b.year ? a.year - b.year : a.brand.localeCompare(b.brand)));

  const finishedAt = new Date();
  const summary: SweepSummary = {
    source,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startMs,
    tuplesAttempted: results.length,
    tuplesOk: results.filter((r) => r.ok).length,
    tuplesMissing: results.filter((r) => !r.ok && r.reason === "not-found").length,
    tuplesError: results.filter((r) => !r.ok && r.reason !== "not-found").length,
    totalDedupedCards: results.reduce((s, r) => s + r.dedupedCardCount, 0),
    totalParallels: results.reduce((s, r) => s + r.parallelCount, 0),
    totalUnmatchedParallels: unmatched.size(),
    totalDiagnostics: results.reduce((s, r) => s + r.diagnosticsCount, 0),
    brands,
    years,
    results,
  };

  const summaryFilename = a3Mode ? "SUMMARY-A3.json" : "SUMMARY.json";
  const unmatchedFilename = a3Mode ? "unmatchedParallels-A3.json" : "unmatchedParallels.json";
  const reportFilename = a3Mode ? "REPORT-A3.md" : "REPORT.md";

  await fs.writeFile(
    path.join(outDir, summaryFilename),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outDir, unmatchedFilename),
    JSON.stringify(unmatched.toJSON(), null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outDir, reportFilename),
    a3Mode ? buildReportA3(summary, unmatched) : buildReport(summary, unmatched),
    "utf-8",
  );

  console.log(
    `[sweep] done ok=${summary.tuplesOk}/${summary.tuplesAttempted} ` +
      `missing=${summary.tuplesMissing} err=${summary.tuplesError} ` +
      `cards=${summary.totalDedupedCards} parallels=${summary.totalParallels} ` +
      `unmatched=${summary.totalUnmatchedParallels} dur=${summary.durationMs}ms`,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Per-tuple processing
// ---------------------------------------------------------------------------

interface ProcessTupleArgs {
  source: SweepSource;
  year: number;
  brand: string;
  outDir: string;
  force: boolean;
  timeoutMs: number;
  limiter: RequestSpacer;
  unmatched: UnmatchedParallelsAccumulator;
  maxProbes?: number;
}

async function processTuple(args: ProcessTupleArgs): Promise<SweepTupleResult> {
  const { source, year, brand, outDir, force, timeoutMs, limiter, unmatched, maxProbes } = args;
  const tStart = Date.now();
  const stagedPath = path.join(outDir, String(year), `${brandFilename(brand)}.json`);

  // Resumability: skip when staged file already exists.
  if (!force) {
    try {
      await fs.access(stagedPath);
      console.log(`[sweep] skip year=${year} brand="${brand}" (already staged)`);
      // Re-read the cached result to roll into SUMMARY.
      const cached = JSON.parse(await fs.readFile(stagedPath, "utf-8")) as StagedFile;
      return {
        year,
        brand,
        ok: true,
        sourceUrl: cached.sourceUrl,
        matchedBrandVariant: cached.matchedBrandVariant,
        matchedNonPrimaryVariant: cached.matchedNonPrimaryVariant,
        discoveryAttempts: [],
        rawCardCount: cached.rawCardCount,
        dedupedCardCount: cached.cards.length,
        parallelCount: cached.parallels.length,
        unmatchedParallelCount: cached.parallels.filter(
          (p) => p.normalization.strategy === "unmatched",
        ).length,
        diagnosticsCount: cached.diagnosticsCount,
        durationMs: Date.now() - tStart,
      };
    } catch {
      /* not cached, proceed */
    }
  }

  let discoveredUrl: string | null = null;
  let matchedBrandVariant: string | null = null;
  let matchedNonPrimaryVariant = false;
  let discoveryAttempts: Array<DiscoveryAttempt | CardboardConnectionDiscoveryAttempt> = [];

  // 1. Discover URL (source-specific probe layer)
  if (source === "beckett") {
    await limiter.wait();
    const discovery = await discoverBeckettChecklistUrl({
      year,
      brand,
      sport: SPORT,
      timeoutMs,
      maxProbes,
    });
    discoveredUrl = discovery.url;
    matchedBrandVariant = discovery.matchedBrandVariant;
    matchedNonPrimaryVariant = discovery.matchedNonPrimaryVariant;
    discoveryAttempts = discovery.attempts;
  } else {
    const discovery = await discoverCardboardConnectionChecklistUrl({
      year,
      brand,
      sport: SPORT,
      timeoutMs,
      maxProbes,
    });
    discoveredUrl = discovery.url;
    discoveryAttempts = discovery.attempts;
  }

  if (!discoveredUrl) {
    console.log(`[sweep] miss year=${year} brand="${brand}" (no URL)`);
    return {
      year,
      brand,
      ok: false,
      reason: "not-found",
      sourceUrl: null,
      matchedBrandVariant: null,
      matchedNonPrimaryVariant: false,
      discoveryAttempts,
      rawCardCount: 0,
      dedupedCardCount: 0,
      parallelCount: 0,
      unmatchedParallelCount: 0,
      diagnosticsCount: 0,
      durationMs: Date.now() - tStart,
    };
  }

  // 2. Fetch via source-specific fetcher.
  let bytes: Uint8Array;
  try {
    if (source === "beckett") {
      await limiter.wait();
      bytes = await fetchByExactUrl(discoveredUrl, timeoutMs);
    } else {
      const fetched = await fetchCardboardConnectionChecklist({
        year,
        brand,
        sport: SPORT,
        timeoutMs,
        resolvedUrl: discoveredUrl,
      });
      bytes = fetched.bytes;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sweep] fetch error year=${year} brand="${brand}" msg=${msg}`);
    return {
      year,
      brand,
      ok: false,
      reason: `fetch-error: ${msg}`,
      sourceUrl: discoveredUrl,
      matchedBrandVariant,
      matchedNonPrimaryVariant,
      discoveryAttempts,
      rawCardCount: 0,
      dedupedCardCount: 0,
      parallelCount: 0,
      unmatchedParallelCount: 0,
      diagnosticsCount: 0,
      durationMs: Date.now() - tStart,
    };
  }

  // 3. Parse
  let parsed: BeckettChecklistParsed;
  try {
    parsed =
      source === "beckett"
        ? parseBeckettChecklist(bytes, { sourceLabel: discoveredUrl })
        : parseCardboardConnectionChecklist(bytes, { sourceLabel: discoveredUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sweep] parse error year=${year} brand="${brand}" msg=${msg}`);
    return {
      year,
      brand,
      ok: false,
      reason: `parse-error: ${msg}`,
      sourceUrl: discoveredUrl,
      matchedBrandVariant,
      matchedNonPrimaryVariant,
      discoveryAttempts,
      rawCardCount: 0,
      dedupedCardCount: 0,
      parallelCount: 0,
      unmatchedParallelCount: 0,
      diagnosticsCount: 0,
      durationMs: Date.now() - tStart,
    };
  }

  // 4. Normalize parallels
  const setLabel = `${year} ${brand} ${SPORT}`;
  const normalized: NormalizedParallel[] = parsed.parallels.map((p) => {
    const result = normalizeParallelName(p.name, { brand });
    if (result.strategy === "unmatched") {
      unmatched.record(p.name, setLabel, brand);
    }
    return {
      rawName: p.name,
      printRun: p.printRun,
      isOneOfOne: p.isOneOfOne,
      note: p.note,
      normalization: result,
    };
  });

  // 5. Dedup
  const deduped = dedupCards(parsed, { set: setLabel });

  // 6. Stage
  const staged: StagedFile = {
    schemaVersion: 1,
    source,
    year,
    brand,
    sport: SPORT,
    setLabel,
    sourceUrl: discoveredUrl,
    matchedBrandVariant,
    matchedNonPrimaryVariant,
    fetchedAt: new Date().toISOString(),
    rawCardCount: parsed.cards.length,
    diagnosticsCount: parsed.diagnostics.length,
    cards: deduped.cards,
    parallels: normalized,
    diagnostics: parsed.diagnostics,
  };
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.writeFile(stagedPath, JSON.stringify(staged, null, 2), "utf-8");

  console.log(
    `[sweep] ok year=${year} brand="${brand}" cards=${deduped.cards.length} ` +
      `parallels=${normalized.length} unmatched=${
        normalized.filter((n) => n.normalization.strategy === "unmatched").length
      }`,
  );

  return {
    year,
    brand,
    ok: true,
    sourceUrl: discoveredUrl,
    matchedBrandVariant,
    matchedNonPrimaryVariant,
    discoveryAttempts,
    rawCardCount: parsed.cards.length,
    dedupedCardCount: deduped.cards.length,
    parallelCount: normalized.length,
    unmatchedParallelCount: normalized.filter(
      (n) => n.normalization.strategy === "unmatched",
    ).length,
    diagnosticsCount: parsed.diagnostics.length,
    durationMs: Date.now() - tStart,
  };
}

interface StagedFile {
  schemaVersion: 1;
  source: SweepSource;
  year: number;
  brand: string;
  sport: string;
  setLabel: string;
  sourceUrl: string;
  matchedBrandVariant: string | null;
  matchedNonPrimaryVariant: boolean;
  fetchedAt: string;
  rawCardCount: number;
  diagnosticsCount: number;
  cards: DedupedCard[];
  parallels: NormalizedParallel[];
  diagnostics: BeckettChecklistParsed["diagnostics"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class RequestSpacer {
  private last = 0;
  constructor(private readonly minSpacingMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const wait = this.last + this.minSpacingMs - now;
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchByExactUrl(url: string, timeoutMs: number): Promise<Uint8Array> {
  // Bypass the fetcher's matrix walk — we already know the exact URL.
  // We still validate magic bytes here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new BeckettFetchError(`HTTP ${res.status} for ${url}`, []);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (
      buf.byteLength < 4 ||
      buf[0] !== 0x50 ||
      buf[1] !== 0x4b ||
      buf[2] !== 0x03 ||
      buf[3] !== 0x04
    ) {
      throw new BeckettFetchError(`Magic-byte check failed for ${url}`, []);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function brandFilename(brand: string): string {
  return brand.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function defaultOutDir(source: SweepSource): string {
  // Resolve relative to the compiled/transpiled file location. Whether we run
  // from src/agents/beckett/ (tsx) or dist/agents/beckett/ (compiled), walking
  // up three levels reaches "backend/".
  return path.resolve(__dirname, "..", "..", "..", "data", `${source}-sweep`);
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function buildReport(
  summary: SweepSummary,
  unmatched: UnmatchedParallelsAccumulator,
): string {
  const lines: string[] = [];
  lines.push(
    summary.source === "beckett"
      ? `# Beckett Sweep Report`
      : `# Checklist Sweep Report (${summary.source})`,
  );
  lines.push("");
  lines.push(`- Started: \`${summary.startedAt}\``);
  lines.push(`- Finished: \`${summary.finishedAt}\``);
  lines.push(`- Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Tuples attempted: **${summary.tuplesAttempted}**`);
  lines.push(`- Tuples OK: **${summary.tuplesOk}**`);
  lines.push(`- Tuples not found (404 family): ${summary.tuplesMissing}`);
  lines.push(`- Tuples error: ${summary.tuplesError}`);
  lines.push(`- Total deduped cards: **${summary.totalDedupedCards}**`);
  lines.push(`- Total parallels: ${summary.totalParallels}`);
  lines.push(`- Total unmatched parallel names (owner review): **${summary.totalUnmatchedParallels}**`);
  lines.push(`- Total parser diagnostics: ${summary.totalDiagnostics}`);
  lines.push("");
  lines.push(`## Found tuples`);
  lines.push("");
  lines.push(`| Year | Brand | Cards | Parallels | Unmatched | Variant | URL |`);
  lines.push(`|------|-------|-------|-----------|-----------|---------|-----|`);
  for (const r of summary.results) {
    if (!r.ok) continue;
    const variant = r.matchedNonPrimaryVariant ? `${r.matchedBrandVariant} ⚠` : r.matchedBrandVariant ?? "";
    lines.push(
      `| ${r.year} | ${r.brand} | ${r.dedupedCardCount} | ${r.parallelCount} | ${r.unmatchedParallelCount} | ${variant} | ${r.sourceUrl ?? ""} |`,
    );
  }
  lines.push("");
  lines.push(`## Missing tuples`);
  lines.push("");
  const missing = summary.results.filter((r) => !r.ok && r.reason === "not-found");
  if (missing.length === 0) {
    lines.push(`_None — every (year, brand) tuple matched a Beckett S3 file._`);
  } else {
    lines.push(`| Year | Brand | Candidates probed |`);
    lines.push(`|------|-------|-------------------|`);
    for (const r of missing) {
      lines.push(`| ${r.year} | ${r.brand} | ${r.discoveryAttempts.length} |`);
    }
  }
  lines.push("");
  lines.push(`## Errors`);
  lines.push("");
  const errors = summary.results.filter((r) => !r.ok && r.reason !== "not-found");
  if (errors.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| Year | Brand | Reason |`);
    lines.push(`|------|-------|--------|`);
    for (const r of errors) {
      lines.push(`| ${r.year} | ${r.brand} | ${r.reason} |`);
    }
  }
  lines.push("");
  lines.push(`## Unmatched parallel names — owner review queue`);
  lines.push("");
  const unmatchedRows = unmatched.toJSON();
  if (unmatchedRows.length === 0) {
    lines.push(`_None — every parallel name resolved to the canonical table._`);
  } else {
    lines.push(`See \`unmatchedParallels.json\` for the full list (${unmatchedRows.length} entries).`);
    lines.push("");
    lines.push(`Top 25 by frequency:`);
    lines.push("");
    lines.push(`| Frequency | Raw name | Sample sets |`);
    lines.push(`|-----------|----------|-------------|`);
    for (const u of unmatchedRows.slice(0, 25)) {
      lines.push(`| ${u.frequency} | \`${u.rawInput}\` | ${u.samples.slice(0, 2).join("; ")} |`);
    }
  }
  lines.push("");
  lines.push(`## Notes for Phase B`);
  lines.push("");
  lines.push(`- All output is **staged only** — nothing was written to Cosmos.`);
  lines.push(`- Cards / parallels referenced by an unmatched name are NOT eligible for Phase B until owner reviews \`unmatchedParallels.json\`.`);
  lines.push(`- Tuples flagged with ⚠ used a non-primary brand variant. Consider promoting the variant in \`BRAND_VARIANTS\` after review.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase A.3 markdown report
// ---------------------------------------------------------------------------

function buildReportA3(
  summary: SweepSummary,
  unmatched: UnmatchedParallelsAccumulator,
): string {
  const lines: string[] = [];
  lines.push(`# Beckett Sweep Report — Phase A.3 (non-Bowman)`);
  lines.push("");
  lines.push(`- Started: \`${summary.startedAt}\``);
  lines.push(`- Finished: \`${summary.finishedAt}\``);
  lines.push(`- Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Tuples attempted: **${summary.tuplesAttempted}**`);
  lines.push(`- Tuples OK: **${summary.tuplesOk}**`);
  lines.push(`- Tuples not found (404 family): ${summary.tuplesMissing}`);
  lines.push(`- Tuples error: ${summary.tuplesError}`);
  lines.push(`- Total deduped cards: **${summary.totalDedupedCards}**`);
  lines.push(`- Total parallels: ${summary.totalParallels}`);
  lines.push(`- Total unmatched parallel names (owner review): **${summary.totalUnmatchedParallels}**`);
  lines.push(`- Total parser diagnostics: ${summary.totalDiagnostics}`);
  lines.push("");

  // -------------------------------------------------------------------------
  // Family-level coverage roll-up
  // -------------------------------------------------------------------------
  const familyOf = (brand: string): BrandFamily => {
    const e = getBrandEntry(brand);
    return e ? e.family : "Other";
  };
  type FamilyStats = {
    tuples: number;
    ok: number;
    missing: number;
    err: number;
    cards: number;
    parallels: number;
    unmatched: number;
  };
  const families: Record<string, FamilyStats> = {};
  for (const r of summary.results) {
    const fam = familyOf(r.brand);
    const s = families[fam] ?? {
      tuples: 0,
      ok: 0,
      missing: 0,
      err: 0,
      cards: 0,
      parallels: 0,
      unmatched: 0,
    };
    s.tuples += 1;
    if (r.ok) s.ok += 1;
    else if (r.reason === "not-found") s.missing += 1;
    else s.err += 1;
    s.cards += r.dedupedCardCount;
    s.parallels += r.parallelCount;
    s.unmatched += r.unmatchedParallelCount;
    families[fam] = s;
  }
  lines.push(`## Family coverage roll-up`);
  lines.push("");
  lines.push(`| Family | Tuples | OK | Missing | Errors | Cards | Parallels | Unmatched |`);
  lines.push(`|--------|--------|----|---------|--------|-------|-----------|-----------|`);
  for (const fam of Object.keys(families).sort()) {
    const s = families[fam]!;
    lines.push(
      `| ${fam} | ${s.tuples} | ${s.ok} | ${s.missing} | ${s.err} | ${s.cards} | ${s.parallels} | ${s.unmatched} |`,
    );
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Per-brand coverage (only brands with at least one attempted tuple)
  // -------------------------------------------------------------------------
  type BrandStats = { tuples: number; ok: number; missing: number; err: number; cards: number };
  const brandStats: Record<string, BrandStats> = {};
  for (const r of summary.results) {
    const s = brandStats[r.brand] ?? { tuples: 0, ok: 0, missing: 0, err: 0, cards: 0 };
    s.tuples += 1;
    if (r.ok) s.ok += 1;
    else if (r.reason === "not-found") s.missing += 1;
    else s.err += 1;
    s.cards += r.dedupedCardCount;
    brandStats[r.brand] = s;
  }
  lines.push(`## Brand coverage`);
  lines.push("");
  lines.push(`| Brand | Family | Tuples | OK | Missing | Errors | Cards |`);
  lines.push(`|-------|--------|--------|----|---------|--------|-------|`);
  for (const brand of Object.keys(brandStats).sort()) {
    const s = brandStats[brand]!;
    lines.push(
      `| ${brand} | ${familyOf(brand)} | ${s.tuples} | ${s.ok} | ${s.missing} | ${s.err} | ${s.cards} |`,
    );
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Found tuples
  // -------------------------------------------------------------------------
  lines.push(`## Found tuples`);
  lines.push("");
  lines.push(`| Year | Brand | Cards | Parallels | Unmatched | Variant | URL |`);
  lines.push(`|------|-------|-------|-----------|-----------|---------|-----|`);
  for (const r of summary.results) {
    if (!r.ok) continue;
    const variant = r.matchedNonPrimaryVariant
      ? `${r.matchedBrandVariant} ⚠`
      : r.matchedBrandVariant ?? "";
    lines.push(
      `| ${r.year} | ${r.brand} | ${r.dedupedCardCount} | ${r.parallelCount} | ${r.unmatchedParallelCount} | ${variant} | ${r.sourceUrl ?? ""} |`,
    );
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Missing brand-year tuples for owner manual review
  // -------------------------------------------------------------------------
  const missing = summary.results.filter((r) => !r.ok && r.reason === "not-found");
  lines.push(`## Missing tuples (for owner manual review)`);
  lines.push("");
  if (missing.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| Year | Brand | Candidates probed |`);
    lines.push(`|------|-------|-------------------|`);
    for (const r of missing) {
      lines.push(`| ${r.year} | ${r.brand} | ${r.discoveryAttempts.length} |`);
    }
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  const errors = summary.results.filter((r) => !r.ok && r.reason !== "not-found");
  lines.push(`## Errors`);
  lines.push("");
  if (errors.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| Year | Brand | Reason |`);
    lines.push(`|------|-------|--------|`);
    for (const r of errors) {
      lines.push(`| ${r.year} | ${r.brand} | ${r.reason} |`);
    }
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // URL variant tuning candidates (variants that won > 5% of OK tuples)
  // -------------------------------------------------------------------------
  const variantWins = new Map<string, number>();
  let okCount = 0;
  for (const r of summary.results) {
    if (!r.ok || !r.matchedBrandVariant) continue;
    okCount += 1;
    const key = `${r.brand} :: ${r.matchedBrandVariant}${r.matchedNonPrimaryVariant ? " (non-primary)" : ""}`;
    variantWins.set(key, (variantWins.get(key) ?? 0) + 1);
  }
  lines.push(`## URL variant tuning candidates`);
  lines.push("");
  if (okCount === 0) {
    lines.push(`_No successful tuples; nothing to tune._`);
  } else {
    const threshold = Math.max(1, Math.floor(okCount * 0.05));
    const tuning = Array.from(variantWins.entries())
      .filter(([k, count]) => count >= threshold && k.includes("(non-primary)"))
      .sort((a, b) => b[1] - a[1]);
    if (tuning.length === 0) {
      lines.push(
        `_No non-primary variant won \u2265 5% of OK tuples (${okCount} total). Primary variants are well-tuned._`,
      );
    } else {
      lines.push(`Non-primary variants that won \u2265 5% of OK tuples \u2014 consider promoting:`);
      lines.push("");
      lines.push(`| Brand :: Variant | Wins |`);
      lines.push(`|------------------|------|`);
      for (const [k, count] of tuning) {
        lines.push(`| ${k} | ${count} |`);
      }
    }
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Unmatched parallels (top 25 per family)
  // -------------------------------------------------------------------------
  lines.push(`## Unmatched parallel names — owner review queue`);
  lines.push("");
  const unmatchedRows = unmatched.toJSON();
  if (unmatchedRows.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`Full list: \`unmatchedParallels-A3.json\` (${unmatchedRows.length} entries).`);
    lines.push("");
    // Bucket by family of the brand the unmatched entry was recorded under.
    const byFamily = new Map<string, typeof unmatchedRows>();
    for (const u of unmatchedRows) {
      const fam = familyOf(u.brand);
      const arr = byFamily.get(fam) ?? [];
      arr.push(u);
      byFamily.set(fam, arr);
    }
    for (const fam of Array.from(byFamily.keys()).sort()) {
      const rows = byFamily.get(fam)!;
      lines.push(`### ${fam} — top 25 unmatched`);
      lines.push("");
      lines.push(`| Frequency | Brand | Raw name | Sample set |`);
      lines.push(`|-----------|-------|----------|------------|`);
      for (const u of rows.slice(0, 25)) {
        lines.push(
          `| ${u.frequency} | ${u.brand} | \`${u.rawInput}\` | ${u.samples[0] ?? ""} |`,
        );
      }
      lines.push("");
    }
  }

  // -------------------------------------------------------------------------
  // Deferred items (documented per Phase A.3 prompt: Path B pragmatic scope)
  // -------------------------------------------------------------------------
  lines.push(`## Deferred items (follow-up PRs)`);
  lines.push("");
  lines.push(
    `- **Brand-scoped canonical tables for non-Bowman families.** Every non-Bowman ` +
      `parallel resolves to \`unmatched\` until the owner curates canonical entries. ` +
      `Use the per-family unmatched tables above as the curation input.`,
  );
  lines.push(
    `- **Engine-side guard in \`compiqEstimate.service.ts\`.** No cross-parallel ` +
      `synthesis branch currently exists, so the brand-aware short-circuit is deferred ` +
      `until Phase 3 wiring lands.`,
  );
  lines.push(
    `- **Breaking-signature normalizer migration.** \`normalizeParallelName(brand, raw)\` ` +
      `was implemented as an optional second argument (backward-compatible) so existing ` +
      `tests pass. A future PR can flip the signature to mandatory once all call sites ` +
      `(and tests) are updated.`,
  );
  return lines.join("\n");
}

