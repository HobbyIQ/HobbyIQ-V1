#!/usr/bin/env node
// Phase 2b-i — Skenes 5-parallel sample ingestion (issue #33).
//
// Validates the parallels reference ingestion pipeline against the Phase 1b
// schema by writing 5 owner-curated Skenes 2024 Bowman Chrome parallels
// (Base, Refractor, Blue Refractor /150, Gold Refractor /50, Red Refractor
// /5) and their corresponding ch_card_index entries.
//
// NOT a bulk ingester. NOT a pagination harness. Single-purpose sample.
//
// Run from repo root with:
//   $env:COSMOS_KEY = az cosmosdb keys list --name hobbyiq-comps `
//     --resource-group rg-hobbyiq-dev --query primaryMasterKey -o tsv
//   npx --yes tsx backend/scripts/parallels-2b-i-skenes-sample.ts
//
// Reads CARD_HEDGE_API_KEY and COSMOS_ENDPOINT from backend/.env.harness-local
// when present (so the dev account is the only target).

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
  buildCosmosClient,
  getParallelsContainers,
  parallelAttributesId,
  upsertChCardIndex,
  upsertParallelAttributes,
  validateChCardIndexRecord,
  validateParallelAttributesRecord,
  type ChCardIndexRecord,
  type ParallelAttributesRecord,
} from "../src/services/parallelsReference/ingestion.js";

// ─── Load .env.harness-local without adding a runtime dotenv dep ────────────

const here = path.dirname(url.fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env.harness-local");
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TARGET_SET = "2024 Bowman Chrome Baseball";
const TARGET_PLAYER = "Paul Skenes";
const REVIEW_DATE = "2026-05-16";
const REVIEWED_BY = "owner";
const SCHEMA_VERSION = 1;

// AUTO_NUMBER_PREFIXES copy (kept in sync with backend/src/services/compiq/cardhedge.client.ts).
// We replicate locally so the script is dependency-free of the heavy CH module.
const AUTO_NUMBER_PREFIXES = [
  "CPA",
  "BCP-A",
  "BCPA",
  "BPA",
  "PA",
  "CRA",
  "RA",
  "BCRA",
  "BSA",
  "BCA",
  "TCA",
  "USA",
  "AU",
  "BBA",
  "BSPA",
  "FA",
  "ROA",
];
const AUTO_PREFIX_RE = new RegExp(
  `(?:^|\\b)(?:${AUTO_NUMBER_PREFIXES.map((p) => p.toLowerCase()).join("|")})[- ]`,
  "i"
);

// ─── Owner-curated 5 records (from prompt) ──────────────────────────────────

interface OwnerRecord {
  parallelName: string;
  color: string | null;
  printRun: number | null;
  parentVariant: string | null;
  tierWithinSet: number;
  variantAliases: string[];
}

const OWNER_RECORDS: OwnerRecord[] = [
  {
    parallelName: "Base",
    color: null,
    printRun: null,
    parentVariant: null,
    tierWithinSet: 1,
    variantAliases: ["Base", "Base - Catching"],
  },
  {
    parallelName: "Refractor",
    color: null,
    printRun: 899,
    parentVariant: "Base",
    tierWithinSet: 2,
    variantAliases: ["Refractor"],
  },
  {
    parallelName: "Blue Refractor",
    color: "Blue",
    printRun: 150,
    parentVariant: "Refractor",
    tierWithinSet: 4,
    variantAliases: ["Blue Refractor", "Blue"],
  },
  {
    parallelName: "Gold Refractor",
    color: "Gold",
    printRun: 50,
    parentVariant: "Refractor",
    tierWithinSet: 6,
    variantAliases: ["Gold Refractor", "Gold"],
  },
  {
    parallelName: "Red Refractor",
    color: "Red",
    printRun: 5,
    parentVariant: "Refractor",
    tierWithinSet: 7,
    variantAliases: ["Red Refractor", "Red"],
  },
];

function buildParallelAttributesRecord(o: OwnerRecord): ParallelAttributesRecord {
  return {
    id: parallelAttributesId(TARGET_SET, o.parallelName, false),
    set: TARGET_SET,
    parallelName: o.parallelName,
    color: o.color,
    printRun: o.printRun,
    isAutograph: false,
    parentVariant: o.parentVariant,
    tierWithinSet: o.tierWithinSet,
    variantAliases: o.variantAliases,
    sourceCitation: {
      type: "owner-knowledge",
      date: REVIEW_DATE,
      note: "validated by owner for Phase 2b-i",
    },
    lastReviewedAt: `${REVIEW_DATE}T00:00:00Z`,
    reviewedBy: REVIEWED_BY,
    schemaVersion: SCHEMA_VERSION,
  };
}

// ─── CH search (paginated, no Redis caching layer) ──────────────────────────

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

async function cardHedgeSearch(query: string, page: number, pageSize = 50): Promise<ChSearchRow[]> {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) throw new Error("CARD_HEDGE_API_KEY missing");
  const res = await fetch("https://api.cardhedger.com/v1/cards/card-search", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      search: query,
      category: "Baseball",
      page,
      page_size: pageSize,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    throw new Error(`card-search HTTP ${res.status} on page ${page}`);
  }
  const body = (await res.json()) as { cards?: ChSearchRow[] };
  return Array.isArray(body.cards) ? body.cards : [];
}

async function fetchAllSkenesBowmanChromeRows(): Promise<ChSearchRow[]> {
  const query = `${TARGET_PLAYER} ${TARGET_SET}`;
  const collected: ChSearchRow[] = [];
  const PAGE_SIZE = 50;
  const MAX_PAGES = 10; // generous cap; CH usually paginates 1-3 pages for a player+set
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await cardHedgeSearch(query, page, PAGE_SIZE);
    if (rows.length === 0) break;
    collected.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return collected;
}

// ─── Matching: CH row → owner parallelName ──────────────────────────────────

function isAutoRow(row: ChSearchRow): boolean {
  const text = [row.variant, row.title, row.name].filter(Boolean).join(" ").toLowerCase();
  if (/(auto|autograph|signed|signature)/.test(text)) return true;
  const num = String(row.number ?? "").toLowerCase();
  return num.length > 0 && AUTO_PREFIX_RE.test(num);
}

function normaliseAlias(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

interface AliasIndex {
  // alias-lowercase → ownerRecord
  byAlias: Map<string, OwnerRecord>;
  // alias-lowercase ordering matters for "longest match wins"
  aliasOrder: string[];
}

function buildAliasIndex(): AliasIndex {
  const byAlias = new Map<string, OwnerRecord>();
  for (const o of OWNER_RECORDS) {
    // parallelName itself is an implicit alias
    const all = new Set<string>([o.parallelName, ...o.variantAliases]);
    for (const raw of all) {
      const k = normaliseAlias(raw);
      if (!byAlias.has(k)) byAlias.set(k, o);
    }
  }
  // longest first so "Blue Refractor" wins over "Blue"
  const aliasOrder = [...byAlias.keys()].sort((a, b) => b.length - a.length);
  return { byAlias, aliasOrder };
}

function matchRowToOwnerRecord(row: ChSearchRow, idx: AliasIndex): OwnerRecord | null {
  const variantRaw = String(row.variant ?? "");
  const variant = normaliseAlias(variantRaw);
  // Empty variant + non-auto number → Base
  if (variant === "") {
    const base = OWNER_RECORDS.find((o) => o.parallelName === "Base");
    return base ?? null;
  }
  // Exact alias match only. We do NOT fall back to substring matching:
  // "Pink Refractor".includes("Refractor") would incorrectly map Pink (its
  // own /250 parallel) onto the base Refractor record. Unknown variant text
  // becomes an unmatched row, which is correct per schema doc §5.4.
  return idx.byAlias.get(variant) ?? null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface WrittenParallelReport {
  id: string;
  record: ParallelAttributesRecord;
  upsertStatus: number;
  readBackOk: boolean;
}

interface WrittenChIndexReport {
  id: string;
  record: ChCardIndexRecord;
  upsertStatus: number;
  readBackOk: boolean;
}

async function main(): Promise<void> {
  console.log("[2b-i] Phase 2b-i — Skenes 5-parallel sample ingestion");
  console.log(`[2b-i] Target set: ${TARGET_SET}`);
  console.log(`[2b-i] Target player: ${TARGET_PLAYER}`);
  console.log(`[2b-i] Cosmos endpoint: ${process.env.COSMOS_ENDPOINT ?? "<missing>"}`);
  console.log("");

  if (!process.env.COSMOS_KEY && !process.env.COSMOS_CONNECTION_STRING) {
    throw new Error(
      "COSMOS_KEY (or COSMOS_CONNECTION_STRING) must be set in the environment before running this script."
    );
  }
  if (!process.env.CARD_HEDGE_API_KEY) {
    throw new Error("CARD_HEDGE_API_KEY must be available in the environment.");
  }

  const client = buildCosmosClient();
  const { parallelAttributes, chCardIndex } = await getParallelsContainers(client);

  // 1. Build + validate the 5 owner records first (fail fast on schema errors).
  const ownerRecords: ParallelAttributesRecord[] = OWNER_RECORDS.map(buildParallelAttributesRecord);
  for (const r of ownerRecords) validateParallelAttributesRecord(r);

  // 2. Write parallel_attributes via upsert + read-back.
  const writtenParallels: WrittenParallelReport[] = [];
  for (const rec of ownerRecords) {
    const res = await upsertParallelAttributes(parallelAttributes, rec);
    const readBack = await parallelAttributes.item(rec.id, rec.set).read<ParallelAttributesRecord>();
    const ok =
      readBack.resource != null &&
      readBack.resource.id === rec.id &&
      readBack.resource.parallelName === rec.parallelName &&
      readBack.resource.printRun === rec.printRun &&
      readBack.resource.tierWithinSet === rec.tierWithinSet;
    if (!ok) {
      throw new Error(
        `[2b-i] read-back verification failed for parallel_attributes id='${rec.id}'`
      );
    }
    writtenParallels.push({
      id: rec.id,
      record: rec,
      upsertStatus: res.statusCode,
      readBackOk: ok,
    });
    console.log(
      `[2b-i] parallel_attributes upsert ${res.statusCode} id='${rec.id}' (read-back OK)`
    );
  }

  // 3. Fetch CH rows.
  console.log("");
  console.log("[2b-i] Fetching CH /cards/card-search rows...");
  const rows = await fetchAllSkenesBowmanChromeRows();
  console.log(`[2b-i] CH returned ${rows.length} total search rows`);

  // 4. Filter to in-scope rows: target set, target player, non-auto.
  const inScopeRows: ChSearchRow[] = [];
  let droppedWrongSet = 0;
  let droppedWrongPlayer = 0;
  let droppedAuto = 0;
  for (const row of rows) {
    const setStr = String(row.set ?? "");
    if (setStr !== TARGET_SET) {
      droppedWrongSet += 1;
      continue;
    }
    const playerStr = String(row.player ?? "").toLowerCase();
    if (!playerStr.includes("skenes")) {
      droppedWrongPlayer += 1;
      continue;
    }
    if (isAutoRow(row)) {
      droppedAuto += 1;
      continue;
    }
    inScopeRows.push(row);
  }
  console.log(
    `[2b-i] In-scope rows: ${inScopeRows.length} ` +
      `(dropped wrong-set=${droppedWrongSet}, wrong-player=${droppedWrongPlayer}, auto=${droppedAuto})`
  );

  // 5. Match each in-scope row to one of the 5 owner records.
  const aliasIdx = buildAliasIndex();
  const matchedPairs: Array<{ row: ChSearchRow; owner: OwnerRecord }> = [];
  const unmatchedRows: ChSearchRow[] = [];
  for (const row of inScopeRows) {
    const owner = matchRowToOwnerRecord(row, aliasIdx);
    if (owner) matchedPairs.push({ row, owner });
    else unmatchedRows.push(row);
  }
  console.log(`[2b-i] Matched to one of the 5 parallels: ${matchedPairs.length}`);
  console.log(`[2b-i] Unmatched in-scope rows: ${unmatchedRows.length}`);
  if (unmatchedRows.length > 0) {
    const sample = unmatchedRows.slice(0, 5).map((r) => ({
      cardId: r.card_id,
      number: r.number,
      variantRaw: r.variant,
      title: r.title,
    }));
    console.log("[2b-i] Sample unmatched variantRaw values:");
    for (const s of sample) console.log("   ", JSON.stringify(s));
  }

  // 6. Build + upsert ch_card_index records for matched rows only.
  const writtenIndex: WrittenChIndexReport[] = [];
  for (const { row, owner } of matchedPairs) {
    const attributeKey = parallelAttributesId(TARGET_SET, owner.parallelName, false);
    const rec: ChCardIndexRecord = {
      id: String(row.card_id),
      cardId: String(row.card_id),
      set: TARGET_SET,
      setType: String(row.set_type ?? "Bowman Chrome Baseball"),
      number: String(row.number ?? ""),
      variantRaw: String(row.variant ?? ""),
      player: String(row.player ?? TARGET_PLAYER),
      rookie: typeof row.rookie === "boolean" ? row.rookie : undefined,
      attributeKey,
      attributeResolution: "matched",
      printRun: owner.printRun,
      tierWithinSet: owner.tierWithinSet,
      isAutograph: false,
      lastSeenAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
    };
    validateChCardIndexRecord(rec);
    const res = await upsertChCardIndex(chCardIndex, rec);
    const readBack = await chCardIndex.item(rec.id, rec.set).read<ChCardIndexRecord>();
    const ok =
      readBack.resource != null &&
      readBack.resource.cardId === rec.cardId &&
      readBack.resource.attributeKey === rec.attributeKey &&
      readBack.resource.printRun === rec.printRun;
    if (!ok) {
      throw new Error(
        `[2b-i] read-back verification failed for ch_card_index id='${rec.id}'`
      );
    }
    writtenIndex.push({
      id: rec.id,
      record: rec,
      upsertStatus: res.statusCode,
      readBackOk: ok,
    });
    console.log(
      `[2b-i] ch_card_index upsert ${res.statusCode} id='${rec.id}' ` +
        `variantRaw='${rec.variantRaw}' → parallelName='${owner.parallelName}'`
    );
  }

  // 7. Final report.
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("Phase 2b-i — final report");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("parallel_attributes records written (5 expected):");
  for (const r of writtenParallels) {
    console.log("");
    console.log(`  id: ${r.id}`);
    console.log(`  status: ${r.upsertStatus}    read-back: ${r.readBackOk ? "OK" : "FAIL"}`);
    console.log(`  ${JSON.stringify(r.record)}`);
  }
  console.log("");
  console.log(`ch_card_index records written (${writtenIndex.length}):`);
  for (const r of writtenIndex) {
    console.log("");
    console.log(`  id: ${r.id}`);
    console.log(`  status: ${r.upsertStatus}    read-back: ${r.readBackOk ? "OK" : "FAIL"}`);
    console.log(`  ${JSON.stringify(r.record)}`);
  }
  console.log("");
  console.log("Match statistics:");
  console.log(`  total CH rows fetched: ${rows.length}`);
  console.log(
    `  dropped: wrong-set=${droppedWrongSet}, wrong-player=${droppedWrongPlayer}, auto=${droppedAuto}`
  );
  console.log(`  in-scope rows: ${inScopeRows.length}`);
  console.log(`  matched to one of 5 parallels: ${matchedPairs.length}`);
  console.log(`  unmatched in-scope rows: ${unmatchedRows.length}`);
  console.log("");
  console.log("Done.");
}

main().catch((err) => {
  console.error("[2b-i] FATAL:", err?.stack ?? err);
  process.exit(1);
});
