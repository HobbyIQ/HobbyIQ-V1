// Parallels Reference Catalog — ingestion helpers (Phase 2b-i).
//
// Issue #33. See:
//   - backend/docs/parallels-reference-schema.md (authoritative schema)
//   - backend/docs/parallels-reference-cosmos-setup.md (Cosmos containers)
//
// Two containers in the `hobbyiq` database:
//   - parallel_attributes : owner-curated identity facts (PK /set)
//   - ch_card_index       : CH-derived card_id index (PK /set)
//
// This module is intentionally tiny: TS types matching the schema doc, a
// validator per container, and idempotent upsert helpers. Pagination, CH
// fetching, alias-matching, and reporting all live in the calling script.

import { CosmosClient, Container, type ItemResponse } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ─── Schema types (mirror backend/docs/parallels-reference-schema.md §2) ────

export type SourceCitation =
  | { type: "owner-knowledge"; date: string; note?: string }
  | { type: "ch-derived"; cardIdsSampled: string[]; date: string }
  | { type: "web-research"; url: string; siteName: string; date: string; note?: string }
  | { type: "manufacturer-spec"; document: string; date: string; note?: string }
  | { type: "manual-override"; note: string; date: string };

export interface ParallelAttributesRecord {
  id: string;
  set: string;
  parallelName: string;
  color: string | null;
  printRun: number | null;
  isAutograph: boolean;
  parentVariant: string | null;
  tierWithinSet: number;
  variantAliases?: string[];
  numberPrefixes?: string[];
  sourceCitation: SourceCitation;
  lastReviewedAt: string;
  reviewedBy: string;
  schemaVersion: number;
}

export type AttributeResolution =
  | "matched"
  | "unmatched-variant"
  | "unmatched-auto-prefix"
  | "manual-override";

export interface ChCardIndexRecord {
  id: string;
  cardId: string;
  set: string;
  setType: string;
  number: string;
  variantRaw: string;
  player: string;
  rookie?: boolean;
  attributeKey: string | null;
  attributeResolution: AttributeResolution;
  printRun: number | null;
  tierWithinSet: number | null;
  isAutograph: boolean | null;
  lastSeenAt: string;
  schemaVersion: number;
}

// ─── ID computation ─────────────────────────────────────────────────────────

export function parallelAttributesId(
  set: string,
  parallelName: string,
  isAutograph: boolean
): string {
  if (set.includes("|") || parallelName.includes("|")) {
    throw new Error(
      `[parallels-ingestion] reserved character '|' in set/parallelName: set='${set}', parallelName='${parallelName}'`
    );
  }
  return `${set}|${parallelName}|${isAutograph ? "auto" : "base"}`;
}

// ─── Validators ─────────────────────────────────────────────────────────────

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[parallels-ingestion] '${field}' must be a non-empty string`);
  }
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(`[parallels-ingestion] '${field}' must be an ISO-8601 date string`);
  }
}

export function validateParallelAttributesRecord(r: ParallelAttributesRecord): void {
  assertNonEmpty(r.id, "id");
  assertNonEmpty(r.set, "set");
  assertNonEmpty(r.parallelName, "parallelName");
  if (typeof r.isAutograph !== "boolean") {
    throw new Error("[parallels-ingestion] 'isAutograph' must be a boolean");
  }
  if (r.printRun !== null && !(Number.isInteger(r.printRun) && r.printRun > 0)) {
    throw new Error("[parallels-ingestion] 'printRun' must be a positive integer or null");
  }
  if (r.parentVariant !== null && typeof r.parentVariant !== "string") {
    throw new Error("[parallels-ingestion] 'parentVariant' must be a string or null");
  }
  if (!(Number.isInteger(r.tierWithinSet) && r.tierWithinSet > 0)) {
    throw new Error("[parallels-ingestion] 'tierWithinSet' must be a positive integer");
  }
  if (r.color !== null && typeof r.color !== "string") {
    throw new Error("[parallels-ingestion] 'color' must be a string or null");
  }
  if (!r.sourceCitation || typeof r.sourceCitation !== "object" || !(r.sourceCitation as any).type) {
    throw new Error("[parallels-ingestion] 'sourceCitation.type' is required");
  }
  assertIsoDate((r.sourceCitation as any).date, "sourceCitation.date");
  assertIsoDate(r.lastReviewedAt, "lastReviewedAt");
  assertNonEmpty(r.reviewedBy, "reviewedBy");
  if (!(Number.isInteger(r.schemaVersion) && r.schemaVersion >= 1)) {
    throw new Error("[parallels-ingestion] 'schemaVersion' must be an integer >= 1");
  }
  const expectedId = parallelAttributesId(r.set, r.parallelName, r.isAutograph);
  if (r.id !== expectedId) {
    throw new Error(
      `[parallels-ingestion] 'id' must equal composite '${expectedId}', got '${r.id}'`
    );
  }
}

export function validateChCardIndexRecord(r: ChCardIndexRecord): void {
  assertNonEmpty(r.id, "id");
  assertNonEmpty(r.cardId, "cardId");
  if (r.id !== r.cardId) {
    throw new Error("[parallels-ingestion] 'id' must equal 'cardId'");
  }
  assertNonEmpty(r.set, "set");
  assertNonEmpty(r.setType, "setType");
  assertNonEmpty(r.number, "number");
  if (typeof r.variantRaw !== "string") {
    throw new Error("[parallels-ingestion] 'variantRaw' must be a string (may be empty)");
  }
  assertNonEmpty(r.player, "player");
  const allowed: AttributeResolution[] = [
    "matched",
    "unmatched-variant",
    "unmatched-auto-prefix",
    "manual-override",
  ];
  if (!allowed.includes(r.attributeResolution)) {
    throw new Error(
      `[parallels-ingestion] 'attributeResolution' must be one of ${allowed.join(", ")}`
    );
  }
  if (r.attributeResolution === "matched" && !r.attributeKey) {
    throw new Error("[parallels-ingestion] 'attributeKey' must be set when resolution is 'matched'");
  }
  if (r.printRun !== null && !(Number.isInteger(r.printRun) && r.printRun > 0)) {
    throw new Error("[parallels-ingestion] 'printRun' must be a positive integer or null");
  }
  if (r.tierWithinSet !== null && !(Number.isInteger(r.tierWithinSet) && r.tierWithinSet > 0)) {
    throw new Error("[parallels-ingestion] 'tierWithinSet' must be a positive integer or null");
  }
  assertIsoDate(r.lastSeenAt, "lastSeenAt");
  if (!(Number.isInteger(r.schemaVersion) && r.schemaVersion >= 1)) {
    throw new Error("[parallels-ingestion] 'schemaVersion' must be an integer >= 1");
  }
}

// ─── Cosmos client wiring (mirrors watchlist.service.ts pattern) ────────────

export interface ParallelsCosmosContainers {
  parallelAttributes: Container;
  chCardIndex: Container;
}

const DEFAULT_DB = "hobbyiq";
const DEFAULT_PARALLEL_ATTRIBUTES_CONTAINER = "parallel_attributes";
const DEFAULT_CH_CARD_INDEX_CONTAINER = "ch_card_index";

export function buildCosmosClient(): CosmosClient {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (connStr) return new CosmosClient(connStr);
  if (!endpoint) {
    throw new Error("[parallels-ingestion] COSMOS_ENDPOINT or COSMOS_CONNECTION_STRING must be set");
  }
  if (key) return new CosmosClient({ endpoint, key });
  return new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
}

export async function getParallelsContainers(
  client: CosmosClient = buildCosmosClient()
): Promise<ParallelsCosmosContainers> {
  const dbName = process.env.COSMOS_DATABASE ?? DEFAULT_DB;
  const db = client.database(dbName);
  return {
    parallelAttributes: db.container(
      process.env.COSMOS_PARALLEL_ATTRIBUTES_CONTAINER ?? DEFAULT_PARALLEL_ATTRIBUTES_CONTAINER
    ),
    chCardIndex: db.container(
      process.env.COSMOS_CH_CARD_INDEX_CONTAINER ?? DEFAULT_CH_CARD_INDEX_CONTAINER
    ),
  };
}

// ─── Upsert helpers (idempotent) ────────────────────────────────────────────

export async function upsertParallelAttributes(
  container: Container,
  record: ParallelAttributesRecord
): Promise<ItemResponse<ParallelAttributesRecord>> {
  validateParallelAttributesRecord(record);
  return container.items.upsert<ParallelAttributesRecord>(record);
}

export async function upsertChCardIndex(
  container: Container,
  record: ChCardIndexRecord
): Promise<ItemResponse<ChCardIndexRecord>> {
  validateChCardIndexRecord(record);
  return container.items.upsert<ChCardIndexRecord>(record);
}

// Backwards-friendly names per the Phase 2b-i prompt:
export const ingestParallelAttributesRecord = upsertParallelAttributes;
export const ingestChCardIndexRecord = upsertChCardIndex;
