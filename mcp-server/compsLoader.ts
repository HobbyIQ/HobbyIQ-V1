// Blob-backed comp loader for the MCP server.
//
// The MCP server NEVER calls Card Hedge live at prediction time. It reads
// `compiq-signals/{player-slug}/cardhedge.json` (written nightly by
// `fn-cardhedge-comps`) and projects the cached `raw_sales` into the
// `CardComp[]` shape that pricing.ts expects.

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import type { CardComp } from "./pricing.js";

const CONTAINER = "compiq-signals";
const CONN = process.env.AZURE_BLOB_CONNECTION_STRING ?? "";

let client: BlobServiceClient | null = null;

function getClient(): BlobServiceClient | null {
  if (client) return client;
  if (!CONN) return null;
  try {
    client = BlobServiceClient.fromConnectionString(CONN);
    return client;
  } catch {
    return null;
  }
}

export function playerSlug(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

interface CachedSale {
  price: number;
  date: string;
  grade?: string;
  source?: string;
  title?: string;
  url?: string;
}

interface CachedCardHedgePayload {
  player?: string;
  raw_sales?: CachedSale[];
  card_hedge_id?: string;
  updated_at?: string;
}

async function readBlobJson<T>(path: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const container = c.getContainerClient(CONTAINER);
    const blob = container.getBlockBlobClient(path);
    const exists = await blob.exists();
    if (!exists) return null;
    const dl = await blob.downloadToBuffer();
    return JSON.parse(dl.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function fetchPlayerComps(
  playerName: string,
  preferredGrade?: string
): Promise<CardComp[]> {
  const slug = playerSlug(playerName);
  const payload = await readBlobJson<CachedCardHedgePayload>(
    `${slug}/cardhedge.json`
  );
  if (!payload?.raw_sales?.length) return [];

  const sales = payload.raw_sales
    .filter((s) => Number.isFinite(Number(s.price)) && Number(s.price) > 0)
    .map<CardComp>((s) => ({
      price: Number(s.price),
      date: s.date,
      grade: s.grade ?? preferredGrade ?? "Raw",
      source: s.source ?? "card_hedge",
      title: s.title,
    }));

  // Sort newest first; pricing.ts already filters by 21/30 day windows.
  sales.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  return sales;
}
