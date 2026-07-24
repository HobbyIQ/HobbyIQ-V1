// CF-CS-BULK-CATALOG-CRAWL (Drew, 2026-07-23).
// Shared helpers for the Cardsight bulk crawl scripts (Phases A-E).
//
// - Rate-limited fetch (default 8 rps, tunable via CS_BULK_RPS)
// - 429/5xx retry with exponential backoff + honoring Retry-After
// - Supports GET + POST (batch pricing endpoint)
// - Cosmos container getter (lazy, cached)
// - Structured progress logger
//
// Env inputs (source via `az webapp config appsettings list`, pipe direct
// into the process env — never write to disk):
//   CARDSIGHT_API_KEY        — X-API-Key header
//   COSMOS_CONNECTION_STRING — Cosmos DB connection
//   COSMOS_DATABASE          — defaults to "hobbyiq"

const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const CS_BASE = "https://api.cardsight.ai/v1";
const DEFAULT_RPS = Number(process.env.CS_BULK_RPS || "8");
const MAX_RETRIES = 5;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

function csKey() { return requireEnv("CARDSIGHT_API_KEY"); }

// Cosmos ─────────────────────────────────────────────────────────────────
const containerCache = new Map();
async function getContainer(name, partitionKey = "/cardId") {
  const cacheK = `${name}::${partitionKey}`;
  if (containerCache.has(cacheK)) return containerCache.get(cacheK);
  const conn = requireEnv("COSMOS_CONNECTION_STRING");
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const { container } = await db.containers.createIfNotExists({
    id: name,
    partitionKey: { paths: [partitionKey] },
  });
  containerCache.set(cacheK, container);
  return container;
}

// Rate limiter ───────────────────────────────────────────────────────────
class RateLimiter {
  constructor(rps) {
    this.intervalMs = Math.max(1, Math.floor(1000 / rps));
    this.nextAllowed = 0;
  }
  async wait() {
    const now = Date.now();
    if (now < this.nextAllowed) {
      await new Promise((r) => setTimeout(r, this.nextAllowed - now));
    }
    this.nextAllowed = Math.max(now, this.nextAllowed) + this.intervalMs;
  }
}
const globalLimiter = new RateLimiter(DEFAULT_RPS);

async function csFetch(pathAndQuery, opts = {}) {
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${CS_BASE}${pathAndQuery}`;
  const key = csKey();
  const timeout = opts.timeoutMs || 20_000;
  const method = opts.method || "GET";
  const body = opts.body;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await globalLimiter.wait();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = { "X-API-Key": key, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0
          ? ra * 1000
          : Math.min(30_000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        console.warn(`[cs-bulk] ${res.status} on ${method} ${pathAndQuery} — backoff ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`CS ${res.status} ${method} ${url} :: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      if (attempt === MAX_RETRIES) throw err;
      const backoff = Math.min(30_000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
      console.warn(`[cs-bulk] fetch error ${method} ${pathAndQuery} — retry ${backoff}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error("unreachable");
}

// Paginate any GET endpoint returning { <listKey>, total_count, skip, take }
async function paginateAll(pathBase, listKey, extraQs = {}, perPage = 100) {
  const all = [];
  let skip = 0;
  const startedAt = Date.now();
  for (;;) {
    const qs = new URLSearchParams({ ...extraQs, take: String(perPage), skip: String(skip) });
    const body = await csFetch(`${pathBase}?${qs}`);
    const chunk = Array.isArray(body?.[listKey]) ? body[listKey] : [];
    all.push(...chunk);
    const total = Number(body?.total_count ?? all.length);
    if (all.length >= total || chunk.length === 0) break;
    skip += perPage;
    if (skip % (perPage * 5) === 0) {
      const rate = all.length / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(`  [paginate ${listKey}] ${all.length}/${total} (${rate.toFixed(1)}/s)`);
    }
  }
  return all;
}

function contentHashOf(...parts) {
  return crypto.createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 32);
}

function nowIso() { return new Date().toISOString(); }

// Chunk an array into groups of N
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Cosmos write concurrency — biggest single throughput lever. From a
// same-region Azure host (Cloud Shell / ACI / App Service) every upsert
// is ~2-5ms round-trip, so 20 concurrent workers = ~4-10k writes/s.
// From a home network it's ~30-50ms, so 20 workers = ~400-700 writes/s.
const WRITE_CONCURRENCY = Number(process.env.CS_BULK_WRITE_CONCURRENCY || "16");

/** Run `worker(item, index)` on every item with up to `concurrency`
 *  workers in flight. Returns { ok, err } counts. Never throws — each
 *  worker error is counted, not propagated. */
async function runInParallel(items, worker, concurrency = WRITE_CONCURRENCY) {
  const result = { ok: 0, err: 0 };
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await worker(items[idx], idx);
        if (r === false) result.err++;
        else result.ok++;
      } catch { result.err++; }
    }
  });
  await Promise.all(workers);
  return result;
}

// Progress state helpers (JSON files under .state/)
const path = require("path");
const fs = require("fs");
const STATE_DIR = path.join(__dirname, ".state");

function stateFile(name) { return path.join(STATE_DIR, name); }
function readState(name, fallback = null) {
  try { return JSON.parse(fs.readFileSync(stateFile(name), "utf8")); }
  catch { return fallback; }
}
function writeState(name, obj) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(name), JSON.stringify(obj, null, 2));
}

module.exports = {
  CS_BASE,
  csFetch,
  paginateAll,
  getContainer,
  contentHashOf,
  requireEnv,
  nowIso,
  chunk,
  readState,
  writeState,
  stateFile,
  runInParallel,
  WRITE_CONCURRENCY,
};
