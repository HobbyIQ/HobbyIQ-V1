#!/usr/bin/env node
// Phase 2b-iii-a — Bowman Chrome 2024 resumable pagination harness (issue #33).
//
// Builds the bulk ingester for the full 2024 Bowman Chrome card-search.
// This sub-phase (2b-iii-a) is HARD-CAPPED at MAX_PAGES_THIS_RUN below.
// Phase 2b-iii-b will lift the cap after owner cold-review of intermediate
// state.
//
// Resumable: the script stores a cursor doc in the ch_card_index container
// under partition set="__ingestion_state__". Re-running the script picks up
// at lastCompletedPage + 1.
//
// NOT a curator. Only writes ch_card_index. parallel_attributes container
// stays at the 5 Phase 2b-i records.
//
// Run from repo root:
//   $env:COSMOS_KEY = az cosmosdb keys list --name hobbyiq-comps `
//     --resource-group rg-hobbyiq-dev --query primaryMasterKey -o tsv
//   npx --yes tsx backend/scripts/parallels-2b-iii-bowman-chrome-2024-paginate.ts
//
// To force a fresh start (re-process page 1), delete the cursor doc first:
//   --reset on the CLI.

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
  buildCosmosClient,
  detectInsertStatus,
  getParallelsContainers,
  parallelAttributesId,
  upsertChCardIndex,
  validateChCardIndexRecord,
  type ChCardIndexRecord,
  type ParallelAttributesRecord,
} from "../src/services/parallelsReference/ingestion.js";
import type { Container } from "@azure/cosmos";

// ─── Load .env.harness-local ────────────────────────────────────────────────

const here = path.dirname(url.fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env.harness-local");
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const JOB_NAME = "bowman-chrome-2024";
const TARGET_SET = "2024 Bowman Chrome Baseball";
const SEARCH_QUERY = "2024 Bowman Chrome Baseball";
const PAGE_SIZE = 50;
const MAX_PAGES_THIS_RUN = 50; // hard cap for sub-phase 2b-iii-a
const PROGRESS_EVERY_N_PAGES = 10;
const MAX_CONSECUTIVE_PAGE_FAILURES = 5;
const SCHEMA_VERSION = 1;
const STATE_PARTITION = "__ingestion_state__";
const CURSOR_ID = `ingestion_state|${JOB_NAME}`;

// Auto-prefix list (mirror of Phase 2b-i script for parity).
const AUTO_NUMBER_PREFIXES = [
  "CPA", "BCP-A", "BCPA", "BPA", "PA", "CRA", "RA", "BCRA",
  "BSA", "BCA", "TCA", "USA", "AU", "BBA", "BSPA", "FA", "ROA",
];
const AUTO_PREFIX_RE = new RegExp(
  `(?:^|\\b)(?:${AUTO_NUMBER_PREFIXES.map((p) => p.toLowerCase()).join("|")})[- ]`,
  "i"
);

// ─── CH search ──────────────────────────────────────────────────────────────

interface ChSearchRow {
  card_id: string;
  player?: string;
  set?: string;
  set_type?: string;
  year?: number | string;
  number?: string;
  variant?: string;
  title?: string;
  name?: string;
  rookie?: boolean;
  [k: string]: unknown;
}

interface CardSearchResponse {
  cards?: ChSearchRow[];
  total_pages?: number;
  total_results?: number;
  page?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function cardHedgeSearch(page: number): Promise<CardSearchResponse> {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) throw new Error("CARD_HEDGE_API_KEY missing");
  const res = await fetch("https://api.cardhedger.com/v1/cards/card-search", {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      search: SEARCH_QUERY,
      category: "Baseball",
      page,
      page_size: PAGE_SIZE,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 429) {
    const err = new Error(`card-search 429 rate-limited on page ${page}`) as Error & { code?: string };
    err.code = "RATE_LIMIT";
    throw err;
  }
  if (!res.ok) {
    throw new Error(`card-search HTTP ${res.status} on page ${page}`);
  }
  return (await res.json()) as CardSearchResponse;
}

async function fetchPageWithRetry(page: number): Promise<CardSearchResponse> {
  const backoffsMs = [1000, 2000, 4000, 8000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
    try {
      return await cardHedgeSearch(page);
    } catch (e: any) {
      lastErr = e;
      if (attempt === backoffsMs.length) break;
      // Only back off on rate limit / 5xx / network. For other 4xx, fail fast.
      const isRate = e?.code === "RATE_LIMIT";
      const msg = String(e?.message ?? "");
      const is5xx = /HTTP 5\d\d/.test(msg);
      const isNetwork = /timeout|fetch failed|ECONN/i.test(msg);
      if (!isRate && !is5xx && !isNetwork) break;
      const wait = backoffsMs[attempt];
      console.log(`[2b-iii-a] page ${page} attempt ${attempt + 1} failed (${msg}); backing off ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ─── Cursor doc ─────────────────────────────────────────────────────────────

interface CursorDoc {
  id: string;
  set: string; // partition key = STATE_PARTITION
  jobName: string;
  lastCompletedPage: number;
  totalPagesAttempted: number;
  totalRecordsWritten: number;
  errors: Array<{ page: number; message: string; at: string }>;
  startedAt: string;
  lastUpdatedAt: string;
  schemaVersion: number;
}

function makeFreshCursor(): CursorDoc {
  const now = new Date().toISOString();
  return {
    id: CURSOR_ID,
    set: STATE_PARTITION,
    jobName: JOB_NAME,
    lastCompletedPage: 0,
    totalPagesAttempted: 0,
    totalRecordsWritten: 0,
    errors: [],
    startedAt: now,
    lastUpdatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
}

async function readCursor(container: Container): Promise<CursorDoc | null> {
  try {
    const res = await container.item(CURSOR_ID, STATE_PARTITION).read<CursorDoc>();
    return res.resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function writeCursor(container: Container, doc: CursorDoc): Promise<void> {
  doc.lastUpdatedAt = new Date().toISOString();
  // Skip the validator; cursor is not a ChCardIndexRecord.
  await container.items.upsert(doc as unknown as Record<string, unknown>);
}

// ─── Alias matching (loaded from parallel_attributes) ───────────────────────

interface OwnerAttr {
  parallelName: string;
  attributeKey: string;
  printRun: number | null;
  tierWithinSet: number;
  variantAliases: string[];
}

interface AliasIndex {
  byAlias: Map<string, OwnerAttr>;
}

function normaliseAlias(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

async function loadAliasIndex(parallelAttributesContainer: Container): Promise<AliasIndex> {
  const q = {
    query: `SELECT c.parallelName, c.id, c.printRun, c.tierWithinSet, c.variantAliases, c.isAutograph FROM c WHERE c["set"] = @set`,
    parameters: [{ name: "@set", value: TARGET_SET }],
  };
  const { resources } = await parallelAttributesContainer.items
    .query<ParallelAttributesRecord>(q, { partitionKey: TARGET_SET })
    .fetchAll();
  const byAlias = new Map<string, OwnerAttr>();
  for (const r of resources) {
    if (r.isAutograph) continue; // Phase 2b-iii-a: non-auto only
    const owner: OwnerAttr = {
      parallelName: r.parallelName,
      attributeKey: r.id,
      printRun: r.printRun,
      tierWithinSet: r.tierWithinSet,
      variantAliases: r.variantAliases ?? [],
    };
    const all = new Set<string>([r.parallelName, ...(r.variantAliases ?? [])]);
    for (const a of all) {
      const k = normaliseAlias(a);
      if (!byAlias.has(k)) byAlias.set(k, owner);
    }
  }
  return { byAlias };
}

function matchRowToOwner(row: ChSearchRow, idx: AliasIndex): OwnerAttr | null {
  const variant = normaliseAlias(String(row.variant ?? ""));
  if (variant === "") {
    return idx.byAlias.get("base") ?? null;
  }
  return idx.byAlias.get(variant) ?? null;
}

function isAutoRow(row: ChSearchRow): boolean {
  const text = [row.variant, row.title, row.name].filter(Boolean).join(" ").toLowerCase();
  if (/(auto|autograph|signed|signature)/.test(text)) return true;
  const num = String(row.number ?? "").toLowerCase();
  return num.length > 0 && AUTO_PREFIX_RE.test(num);
}

// ─── Page processor ─────────────────────────────────────────────────────────

interface PageStats {
  fetched: number;
  inScope: number;
  matched: number;
  quarantined: number;
  unmatchedVariant: number;
  droppedWrongSet: number;
  droppedAuto: number;
  droppedMissingPlayer: number;
  ruConsumed: number;
}

interface RunAccumulator {
  pageStats: PageStats[];
  playersSeen: Set<string>;
  insertPrefixesSeen: Map<string, number>;
  unmatchedVariantSamples: Array<{ cardId: string; number: string; variantRaw: string; player: string }>;
  unexpectedNumberFormats: Array<{ cardId: string; number: string; player: string }>;
  totalRu: number;
}

async function processPage(
  pageRes: CardSearchResponse,
  pageNum: number,
  chCardIndex: Container,
  aliasIdx: AliasIndex,
  acc: RunAccumulator
): Promise<PageStats> {
  const rows = pageRes.cards ?? [];
  const stats: PageStats = {
    fetched: rows.length,
    inScope: 0,
    matched: 0,
    quarantined: 0,
    unmatchedVariant: 0,
    droppedWrongSet: 0,
    droppedAuto: 0,
    droppedMissingPlayer: 0,
    ruConsumed: 0,
  };

  for (const row of rows) {
    const setStr = String(row.set ?? "");
    if (setStr !== TARGET_SET) {
      stats.droppedWrongSet += 1;
      continue;
    }
    const playerStr = String(row.player ?? "").trim();
    if (playerStr === "") {
      stats.droppedMissingPlayer += 1;
      continue;
    }
    if (isAutoRow(row)) {
      stats.droppedAuto += 1;
      continue;
    }
    stats.inScope += 1;
    acc.playersSeen.add(playerStr);

    const insertStatus = detectInsertStatus({ set: row.set, number: row.number });
    let rec: ChCardIndexRecord;
    if (insertStatus.isInsert) {
      stats.quarantined += 1;
      const prefix = insertStatus.insertPrefix ?? "<none>";
      acc.insertPrefixesSeen.set(prefix, (acc.insertPrefixesSeen.get(prefix) ?? 0) + 1);
      rec = {
        id: String(row.card_id),
        cardId: String(row.card_id),
        set: TARGET_SET,
        setType: String(row.set_type ?? "Bowman Chrome Baseball"),
        number: String(row.number ?? ""),
        variantRaw: String(row.variant ?? ""),
        player: playerStr,
        rookie: typeof row.rookie === "boolean" ? row.rookie : undefined,
        attributeKey: null,
        attributeResolution: "unmatched_pending_insert_curation",
        printRun: null,
        tierWithinSet: null,
        isAutograph: false,
        detectedInsertPrefix: insertStatus.insertPrefix,
        lastSeenAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
      };
      // Track unexpected number formats: empty numbers, or numbers with leading
      // digit + hyphen patterns (defensive quarantines, not insert-prefix matches).
      const numStr = String(row.number ?? "").trim();
      if (numStr === "" || (insertStatus.insertPrefix === null && numStr !== "")) {
        if (acc.unexpectedNumberFormats.length < 50) {
          acc.unexpectedNumberFormats.push({ cardId: rec.id, number: rec.number, player: rec.player });
        }
      }
    } else {
      const owner = matchRowToOwner(row, aliasIdx);
      if (!owner) {
        stats.unmatchedVariant += 1;
        // unmatched-variant rows are NOT written to ch_card_index (parity with Phase 2b-i).
        if (acc.unmatchedVariantSamples.length < 100) {
          acc.unmatchedVariantSamples.push({
            cardId: String(row.card_id),
            number: String(row.number ?? ""),
            variantRaw: String(row.variant ?? ""),
            player: playerStr,
          });
        }
        continue;
      }
      stats.matched += 1;
      rec = {
        id: String(row.card_id),
        cardId: String(row.card_id),
        set: TARGET_SET,
        setType: String(row.set_type ?? "Bowman Chrome Baseball"),
        number: String(row.number ?? ""),
        variantRaw: String(row.variant ?? ""),
        player: playerStr,
        rookie: typeof row.rookie === "boolean" ? row.rookie : undefined,
        attributeKey: owner.attributeKey,
        attributeResolution: "matched",
        printRun: owner.printRun,
        tierWithinSet: owner.tierWithinSet,
        isAutograph: false,
        detectedInsertPrefix: null,
        lastSeenAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
      };
    }

    try {
      validateChCardIndexRecord(rec);
      const res = await upsertChCardIndex(chCardIndex, rec);
      stats.ruConsumed += res.requestCharge ?? 0;
    } catch (e: any) {
      // Skip records that fail validation/upsert; surface for review but
      // don't fail the whole page.
      console.log(`[2b-iii-a] page ${pageNum} record ${rec.id} upsert/validate error: ${e?.message ?? e}`);
    }
  }

  acc.totalRu += stats.ruConsumed;
  return stats;
}

// ─── Validation summary helpers (post-run, read from Cosmos) ────────────────

async function runValidationSummary(chCardIndex: Container, parallelAttributesContainer: Container) {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("Phase 2b-iii-a — Cosmos validation summary");
  console.log("════════════════════════════════════════════════════════════════════");

  const counts: Record<string, number> = {};
  const playersInDb = new Set<string>();
  const insertPrefixesInDb = new Map<string, number>();
  const variantRawSamples: Array<{ id: string; number: string; variantRaw: string; player: string }> = [];

  const iter = chCardIndex.items
    .query<{
      id: string;
      attributeResolution: string;
      player: string;
      detectedInsertPrefix?: string | null;
      number: string;
      variantRaw: string;
    }>({
      query: `SELECT c.id, c.attributeResolution, c.player, c.detectedInsertPrefix, c.number, c.variantRaw FROM c WHERE c["set"] = @set`,
      parameters: [{ name: "@set", value: TARGET_SET }],
    }, { partitionKey: TARGET_SET, maxItemCount: 200 });

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      counts[r.attributeResolution] = (counts[r.attributeResolution] ?? 0) + 1;
      if (r.player) playersInDb.add(r.player);
      if (r.attributeResolution === "unmatched_pending_insert_curation") {
        const p = r.detectedInsertPrefix ?? "<none>";
        insertPrefixesInDb.set(p, (insertPrefixesInDb.get(p) ?? 0) + 1);
      }
      // Note: unmatched_variant rows are NOT in ch_card_index. We sample only
      // from the run accumulator for that.
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Total ch_card_index records in '${TARGET_SET}' partition: ${total}`);
  console.log(`By attributeResolution:`);
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);

  console.log(`Unique players in ch_card_index: ${playersInDb.size}`);
  const playerSample = [...playersInDb].slice(0, 10);
  for (const p of playerSample) console.log(`  - ${p}`);

  console.log(`Unique detectedInsertPrefix values: ${insertPrefixesInDb.size}`);
  const prefixSorted = [...insertPrefixesInDb.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pref, n] of prefixSorted) console.log(`  ${pref}: ${n}`);

  // Spot-check: 3 random matched records → confirm attributeKey resolves
  const { resources: matchedSamples } = await chCardIndex.items
    .query<{ id: string; cardId: string; player: string; number: string; variantRaw: string; attributeKey: string }>({
      query: `SELECT TOP 3 c.id, c.cardId, c.player, c.number, c.variantRaw, c.attributeKey FROM c WHERE c["set"] = @set AND c.attributeResolution = "matched" ORDER BY c.id`,
      parameters: [{ name: "@set", value: TARGET_SET }],
    }, { partitionKey: TARGET_SET })
    .fetchAll();

  // Get parallel_attributes
  const { resources: allParallels } = await parallelAttributesContainer.items
    .query<ParallelAttributesRecord>({
      query: `SELECT c.id, c.parallelName, c.printRun, c.tierWithinSet FROM c WHERE c["set"] = @set`,
      parameters: [{ name: "@set", value: TARGET_SET }],
    }, { partitionKey: TARGET_SET })
    .fetchAll();
  const attrById = new Map(allParallels.map((a: any) => [a.id, a]));

  console.log("");
  console.log("Spot-check (3 matched records → attributeKey lineage):");
  for (const m of matchedSamples) {
    const attr = attrById.get(m.attributeKey);
    console.log(`  cardId=${m.cardId} player='${m.player}' number='${m.number}' variantRaw='${m.variantRaw}'`);
    console.log(`    → attributeKey='${m.attributeKey}'`);
    if (attr) {
      console.log(`    → parallel_attributes EXISTS: parallelName='${(attr as any).parallelName}', /${(attr as any).printRun}, tier=${(attr as any).tierWithinSet}`);
    } else {
      console.log(`    → parallel_attributes MISSING — INTEGRITY VIOLATION`);
    }
  }

  return { total, counts, playerCount: playersInDb.size, playerSample, insertPrefixesInDb };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const resetCursor = argv.has("--reset");

  console.log("[2b-iii-a] Phase 2b-iii-a — Bowman Chrome 2024 paginate harness");
  console.log(`[2b-iii-a] Target set:    ${TARGET_SET}`);
  console.log(`[2b-iii-a] Search query:  "${SEARCH_QUERY}"`);
  console.log(`[2b-iii-a] Page size:     ${PAGE_SIZE}`);
  console.log(`[2b-iii-a] MAX pages this run: ${MAX_PAGES_THIS_RUN} (hard cap for sub-phase 2b-iii-a)`);
  console.log(`[2b-iii-a] Reset cursor:  ${resetCursor}`);
  console.log(`[2b-iii-a] Cosmos endpoint: ${process.env.COSMOS_ENDPOINT ?? "<missing>"}`);
  console.log("");

  if (!process.env.COSMOS_KEY && !process.env.COSMOS_CONNECTION_STRING) {
    throw new Error("COSMOS_KEY (or COSMOS_CONNECTION_STRING) must be set.");
  }
  if (!process.env.CARD_HEDGE_API_KEY) {
    throw new Error("CARD_HEDGE_API_KEY must be set.");
  }

  const client = buildCosmosClient();
  const { parallelAttributes, chCardIndex } = await getParallelsContainers(client);

  // 1. Load alias index from parallel_attributes (5 Skenes-curated records).
  const aliasIdx = await loadAliasIndex(parallelAttributes);
  console.log(`[2b-iii-a] Loaded alias index: ${aliasIdx.byAlias.size} alias keys covering parallel_attributes`);

  // 2. Load or initialize cursor.
  let cursor: CursorDoc;
  if (resetCursor) {
    cursor = makeFreshCursor();
    console.log("[2b-iii-a] --reset: starting fresh from page 1");
  } else {
    const existing = await readCursor(chCardIndex);
    if (existing) {
      cursor = existing;
      console.log(`[2b-iii-a] Resuming from cursor: lastCompletedPage=${cursor.lastCompletedPage}, totalRecordsWritten=${cursor.totalRecordsWritten}, errors=${cursor.errors.length}`);
    } else {
      cursor = makeFreshCursor();
      console.log("[2b-iii-a] No prior cursor; starting fresh from page 1");
    }
  }

  const startPage = cursor.lastCompletedPage + 1;
  // Hard cap for sub-phase 2b-iii-a: never exceed page 50, even if cursor allows.
  const endPage = Math.min(MAX_PAGES_THIS_RUN, startPage + MAX_PAGES_THIS_RUN - 1);
  if (cursor.lastCompletedPage >= MAX_PAGES_THIS_RUN) {
    console.log(`[2b-iii-a] Cursor already at page ${cursor.lastCompletedPage}; hard cap is ${MAX_PAGES_THIS_RUN}. Nothing to do.`);
    await runValidationSummary(chCardIndex, parallelAttributes);
    return;
  }
  console.log(`[2b-iii-a] Will process pages ${startPage}..${MAX_PAGES_THIS_RUN}`);
  console.log("");

  const acc: RunAccumulator = {
    pageStats: [],
    playersSeen: new Set(),
    insertPrefixesSeen: new Map(),
    unmatchedVariantSamples: [],
    unexpectedNumberFormats: [],
    totalRu: 0,
  };

  const runStartedAt = Date.now();
  let consecutiveFailures = 0;
  let chReportedTotalPages: number | undefined = undefined;
  let chReportedTotalResults: number | undefined = undefined;

  for (let page = startPage; page <= MAX_PAGES_THIS_RUN; page += 1) {
    const pageStartedAt = Date.now();
    cursor.totalPagesAttempted += 1;
    let pageRes: CardSearchResponse;
    try {
      pageRes = await fetchPageWithRetry(page);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.log(`[2b-iii-a] page ${page} UNRECOVERABLE: ${msg}`);
      cursor.errors.push({ page, message: msg, at: new Date().toISOString() });
      await writeCursor(chCardIndex, cursor);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
        console.log(`[2b-iii-a] STOP: ${MAX_CONSECUTIVE_PAGE_FAILURES} consecutive page failures. Owner review required.`);
        break;
      }
      continue;
    }

    if (chReportedTotalPages == null && typeof pageRes.total_pages === "number") {
      chReportedTotalPages = pageRes.total_pages;
      chReportedTotalResults = pageRes.total_results;
      console.log(`[2b-iii-a] CH reports total_pages=${chReportedTotalPages}, total_results=${chReportedTotalResults}`);
    }

    const stats = await processPage(pageRes, page, chCardIndex, aliasIdx, acc);
    acc.pageStats.push(stats);
    cursor.lastCompletedPage = page;
    cursor.totalRecordsWritten += stats.matched + stats.quarantined;
    consecutiveFailures = 0;

    // Persist cursor after each successful page.
    await writeCursor(chCardIndex, cursor);

    const pageMs = Date.now() - pageStartedAt;
    if (page % PROGRESS_EVERY_N_PAGES === 0 || page === MAX_PAGES_THIS_RUN) {
      const elapsedMs = Date.now() - runStartedAt;
      const pagesDoneThisRun = page - startPage + 1;
      const pagesLeftThisRun = MAX_PAGES_THIS_RUN - page;
      const avgMs = elapsedMs / pagesDoneThisRun;
      const etaMs = pagesLeftThisRun * avgMs;
      console.log(
        `[2b-iii-a] page ${page} done in ${pageMs}ms ` +
          `(fetched=${stats.fetched} inScope=${stats.inScope} matched=${stats.matched} quar=${stats.quarantined} unmV=${stats.unmatchedVariant} drop_set=${stats.droppedWrongSet} drop_auto=${stats.droppedAuto} drop_noPlayer=${stats.droppedMissingPlayer} RU=${stats.ruConsumed.toFixed(0)}) ` +
          `| elapsed=${(elapsedMs / 1000).toFixed(1)}s avgPage=${avgMs.toFixed(0)}ms ETA-this-run=${(etaMs / 1000).toFixed(1)}s`
      );
    }

    // If CH returns fewer rows than page_size, we've reached the end.
    if (stats.fetched < PAGE_SIZE) {
      console.log(`[2b-iii-a] page ${page} returned ${stats.fetched} < ${PAGE_SIZE}: end of CH results.`);
      break;
    }
  }

  const totalElapsedMs = Date.now() - runStartedAt;

  // ─── Final report ─────────────────────────────────────────────────────────
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("Phase 2b-iii-a — run report");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(`Pages processed this run:     ${acc.pageStats.length}`);
  console.log(`Cursor lastCompletedPage:     ${cursor.lastCompletedPage}`);
  console.log(`Cursor totalPagesAttempted:   ${cursor.totalPagesAttempted}`);
  console.log(`Cursor totalRecordsWritten:   ${cursor.totalRecordsWritten}`);
  console.log(`Cursor errors:                ${cursor.errors.length}`);
  if (chReportedTotalPages != null) {
    console.log(`CH total_pages (set query):   ${chReportedTotalPages}`);
    console.log(`CH total_results (set query): ${chReportedTotalResults}`);
  }
  const sumMatched = acc.pageStats.reduce((a, p) => a + p.matched, 0);
  const sumQuar = acc.pageStats.reduce((a, p) => a + p.quarantined, 0);
  const sumUnmV = acc.pageStats.reduce((a, p) => a + p.unmatchedVariant, 0);
  const sumInScope = acc.pageStats.reduce((a, p) => a + p.inScope, 0);
  const sumFetched = acc.pageStats.reduce((a, p) => a + p.fetched, 0);
  console.log(`Run totals: fetched=${sumFetched} inScope=${sumInScope} matched=${sumMatched} quarantined=${sumQuar} unmatched-variant=${sumUnmV}`);
  console.log(`Run totals: players-seen=${acc.playersSeen.size}, insertPrefixes-seen=${acc.insertPrefixesSeen.size}, RU=${acc.totalRu.toFixed(0)}`);
  console.log(`Run total time: ${(totalElapsedMs / 1000).toFixed(1)}s (avg ${(totalElapsedMs / Math.max(1, acc.pageStats.length)).toFixed(0)}ms/page)`);

  if (acc.unmatchedVariantSamples.length > 0) {
    console.log("");
    console.log(`Sample unmatched-variant rows (NOT written to ch_card_index), up to 20:`);
    for (const s of acc.unmatchedVariantSamples.slice(0, 20)) {
      console.log(`  ${JSON.stringify(s)}`);
    }
  }
  if (acc.unexpectedNumberFormats.length > 0) {
    console.log("");
    console.log(`Unexpected number formats (detectInsertStatus prefix=null, sample up to 20):`);
    for (const s of acc.unexpectedNumberFormats.slice(0, 20)) {
      console.log(`  ${JSON.stringify(s)}`);
    }
  }
  // Sanity check on matched proportion (alarm if very low and we had real volume).
  const inScopeMainSet = sumMatched + sumUnmV;
  if (inScopeMainSet >= 50) {
    const matchPct = (sumMatched / inScopeMainSet) * 100;
    if (matchPct < 50) {
      console.log("");
      console.log(`[2b-iii-a] WARNING: matched fraction = ${matchPct.toFixed(1)}% of main-set in-scope rows.`);
      console.log("           Variant alias coverage may not generalize beyond Skenes. STOP and review before 2b-iii-b.");
    }
  }

  // ─── Validation summary (Cosmos read-back) ────────────────────────────────
  await runValidationSummary(chCardIndex, parallelAttributes);

  console.log("");
  console.log("Done.");
}

main().catch((err) => {
  console.error("[2b-iii-a] FATAL:", err?.stack ?? err);
  process.exit(1);
});
