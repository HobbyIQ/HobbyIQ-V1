#!/usr/bin/env node
/**
 * CF-VENDOR-NORMALIZE (Drew, 2026-08-10). Reshapes vendor-sourced
 * catalog rows (bccp, cardhedge, cardsight) into our canonical
 * schema. Preserves the source marker so provenance is intact, but
 * adds catalogVersion=2 + catalogBatch + populates all canonical
 * fields (playerName, year, setKey, cardNumber, parallel, isAuto,
 * printRun, hobbyiqCardId, searchTokens).
 *
 * Doctrine per Drew 2026-08-10: "vendor rows aren't duplicates — 90%
 * are unique cards. Normalize them into clean format, don't delete."
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/normalizeVendorRows.cjs \
 *     --source=bccp [--apply] [--limit=1000]
 *
 * Sources supported: bccp, cardhedge, cardsight
 */

const { CosmosClient } = require("@azure/cosmos");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const SOURCE = argOf("source");
const LIMIT = Number(argOf("limit", "0"));
const CONCURRENCY = 64;

if (!SOURCE || !["bccp", "cardhedge", "cardsight"].includes(SOURCE)) {
  console.error("Missing/invalid --source=bccp|cardhedge|cardsight");
  process.exit(1);
}

function sanitizeSlug(s) {
  return String(s || "").toLowerCase().replace(/[\/\\#?]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Extract year from a set name like "2025 Bowman Chrome Baseball" → 2025
function extractYear(setName) {
  const m = /(19|20)\d{2}/.exec(String(setName || ""));
  return m ? Number(m[0]) : null;
}

// Extract setKey from set name like "2025 Bowman Chrome Baseball" → "bowman-chrome"
function extractSetKey(setName) {
  if (!setName) return null;
  const s = String(setName)
    .replace(/^\d{4}\s+/, "")
    .replace(/\s+(baseball|basketball|football|hockey|soccer)\s*$/i, "")
    .trim();
  return sanitizeSlug(s);
}

// Auto detection from parallel/variant text or from cardNumber prefix
const AUTO_PREFIX_RE = /^(CPA|CPRA|CPAA|BSPA|BCPA|CDA|CFA)-/i;
function detectIsAuto(variant, cardNumber, setName) {
  if (/\b(auto|autograph|signature)\b/i.test(String(variant || ""))) return true;
  if (/\b(auto|autograph|signature)\b/i.test(String(setName || ""))) return true;
  if (AUTO_PREFIX_RE.test(String(cardNumber || ""))) return true;
  return false;
}

function extractPrintRun(variant) {
  const m = /\/(\d+)/.exec(String(variant || ""));
  return m ? Number(m[1]) : null;
}

// Normalize per-source. Returns { ok: true, doc } or { ok: false, reason }.
function normalizeCardhedge(row) {
  const setName = row.setName ?? row.set;
  const year = row.year ? Number(row.year) : extractYear(setName);
  const setKey = extractSetKey(setName);
  const cardNumber = row.cardNumber ?? row.number;
  const playerName = row.playerName ?? row.player;
  const variant = row.variant ?? "Base";
  if (!year || !setKey || !cardNumber || !playerName) return { ok: false, reason: "missing-required" };
  const parallelSlug = sanitizeSlug(variant);
  const isAuto = detectIsAuto(variant, cardNumber, setName);
  const printRun = extractPrintRun(variant);
  const cardNumSlug = sanitizeSlug(cardNumber);
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = printRun ? `:num-${printRun}` : "";
  const slug = `hiq:baseball:${year}:${setKey}:${cardNumSlug}:${parallelSlug || "base"}${autoSuffix}${printRunSuffix}`;
  const searchTokens = new Set([
    ...String(playerName).toLowerCase().split(/\s+/).filter(Boolean),
    ...setKey.split("-").filter(Boolean),
    cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallelSlug, ...(parallelSlug || "").split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));
  return {
    ok: true,
    doc: {
      // Keep the ORIGINAL id so upsert overwrites the same doc — no dupes.
      id: row.id,
      cardId: row.cardId,   // keep original partition key value
      hobbyiqCardId: slug,
      sport: "baseball",
      year, setKey,
      setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      cardNumber, playerName,
      parallel: variant, parallelSlug: parallelSlug || "base",
      isAuto, printRun,
      source: "cardhedge",   // keep provenance
      catalogVersion: 2,
      catalogBatch: "vendor-normalize-2026-08-10",
      verificationStatus: "verified",
      normalizedAt: "2026-08-10T00:00:00.000Z",
      imageUrl: row.imageUrl ?? null,
      searchTokens: [...searchTokens],
    },
  };
}

function normalizeBccp(row) {
  // bccp has canonicalCardId + parallel + isAuto + printRun.
  // Missing: year, playerName, setKey, cardNumber.
  // The canonicalCardId slug has this info: hiq:baseball:2018:topps-chrome:htm47
  const cid = String(row.canonicalCardId ?? row.cardId ?? "");
  const parts = cid.split(":");
  if (parts.length < 5 || parts[0] !== "hiq") return { ok: false, reason: "unparseable-canonicalCardId" };
  const sport = parts[1];
  const year = Number(parts[2]);
  const setKey = parts[3];
  const cardNumber = parts[4].toUpperCase();
  if (!year || !setKey || !cardNumber) return { ok: false, reason: "missing-parts" };
  const parallelSlug = row.parallelSlug ?? sanitizeSlug(row.parallel ?? "base");
  const isAuto = row.isAuto === true;
  const printRun = typeof row.printRun === "number" ? row.printRun : null;
  const cardNumSlug = sanitizeSlug(cardNumber);
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = printRun ? `:num-${printRun}` : "";
  const slug = `hiq:${sport}:${year}:${setKey}:${cardNumSlug}:${parallelSlug}${autoSuffix}${printRunSuffix}`;
  // bccp doesn't carry playerName — we don't have it here. Best-effort: leave null.
  const searchTokens = new Set([
    ...setKey.split("-").filter(Boolean),
    cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallelSlug, ...parallelSlug.split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));
  return {
    ok: true,
    doc: {
      id: row.id,
      cardId: row.cardId,
      hobbyiqCardId: slug,
      sport, year, setKey,
      setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      cardNumber, playerName: row.playerName ?? null,
      parallel: row.parallel ?? "Base", parallelSlug,
      isAuto, printRun,
      source: "bccp",
      catalogVersion: 2,
      catalogBatch: "vendor-normalize-2026-08-10",
      verificationStatus: "verified",
      normalizedAt: "2026-08-10T00:00:00.000Z",
      searchTokens: [...searchTokens],
    },
  };
}

function normalizeCardsight(row) {
  const title = row.title ?? row.player;
  const setName = row.setName ?? row.set;
  const year = row.year ? Number(row.year) : extractYear(setName);
  const setKey = extractSetKey(setName);
  const cardNumber = row.cardNumber ?? row.number;
  // Cardsight often has title="Player Name" and player=null
  const playerName = row.playerName || (title && !/set|checklist/i.test(title) ? title : null);
  if (!year || !setKey || !playerName) return { ok: false, reason: "missing-required" };
  if (!cardNumber) return { ok: false, reason: "missing-cardNumber" };
  const variant = row.variant ?? "Base";
  const parallelSlug = sanitizeSlug(variant);
  const isAuto = detectIsAuto(variant, cardNumber, setName);
  const printRun = extractPrintRun(variant);
  const cardNumSlug = sanitizeSlug(cardNumber);
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = printRun ? `:num-${printRun}` : "";
  const slug = `hiq:baseball:${year}:${setKey}:${cardNumSlug}:${parallelSlug || "base"}${autoSuffix}${printRunSuffix}`;
  const searchTokens = new Set([
    ...String(playerName).toLowerCase().split(/\s+/).filter(Boolean),
    ...setKey.split("-").filter(Boolean),
    cardNumSlug, ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallelSlug, ...(parallelSlug || "").split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));
  return {
    ok: true,
    doc: {
      id: row.id,
      cardId: row.cardId,
      hobbyiqCardId: slug,
      sport: "baseball",
      year, setKey,
      setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      cardNumber, playerName,
      parallel: variant, parallelSlug: parallelSlug || "base",
      isAuto, printRun,
      source: "cardsight",
      catalogVersion: 2,
      catalogBatch: "vendor-normalize-2026-08-10",
      verificationStatus: "verified",
      normalizedAt: "2026-08-10T00:00:00.000Z",
      imageUrl: row.imageUrl ?? null,
      searchTokens: [...searchTokens],
    },
  };
}

const NORMALIZERS = { bccp: normalizeBccp, cardhedge: normalizeCardhedge, cardsight: normalizeCardsight };

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  console.log(`[normalize] MODE=${APPLY ? "APPLY" : "DRY-RUN"} source=${SOURCE} limit=${LIMIT || "unlimited"}`);
  const normalizer = NORMALIZERS[SOURCE];
  // Skip already-normalized rows (catalogVersion=2) so re-runs are fast.
  const q = `SELECT * FROM c WHERE c.source = '${SOURCE}' AND (NOT IS_DEFINED(c.catalogVersion) OR c.catalogVersion != 2)${LIMIT > 0 ? ` OFFSET 0 LIMIT ${LIMIT}` : ""}`;
  const iter = cat.items.query({ query: q }, { maxItemCount: 1000 }).getAsyncIterator();

  let seen = 0, ok = 0, skipped = 0, updated = 0, errors = 0;
  const reasons = new Map();
  for await (const page of iter) {
    const rows = page.resources ?? [];
    if (rows.length === 0) continue;
    // Normalize all in this page
    const normalized = [];
    for (const row of rows) {
      seen++;
      const result = normalizer(row);
      if (!result.ok) {
        skipped++;
        reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
        continue;
      }
      ok++;
      normalized.push(result.doc);
    }
    if (!APPLY) {
      if (seen <= 5000 && normalized.length > 0 && ok <= 3) {
        console.log("SAMPLE:", JSON.stringify(normalized[0], null, 2).slice(0, 800));
      }
      if (seen % 20000 === 0) process.stdout.write(`\r  seen: ${seen} ok: ${ok} skipped: ${skipped}`);
      continue;
    }
    // APPLY: upsert normalized docs
    const workers = Array.from({ length: CONCURRENCY }, () => Promise.resolve());
    for (let i = 0; i < normalized.length; i++) {
      const d = normalized[i];
      workers[i % CONCURRENCY] = workers[i % CONCURRENCY].then(async () => {
        try { await cat.items.upsert(d); updated++; }
        catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${d.id}: ${err.message.slice(0,80)}`); }
      });
    }
    await Promise.all(workers);
    if (updated % 5000 === 0 || updated === ok) {
      process.stdout.write(`\r  seen ${seen} · ok ${ok} · updated ${updated} · errors ${errors} · skipped ${skipped}`);
    }
  }
  console.log(`\n\n═══ RESULT ═══`);
  console.log(`Seen:    ${seen.toLocaleString()}`);
  console.log(`OK:      ${ok.toLocaleString()}  (normalizable)`);
  console.log(`Skipped: ${skipped.toLocaleString()}  (unrescuable)`);
  if (skipped > 0) {
    console.log(`  reasons:`);
    for (const [r, n] of [...reasons.entries()].sort((a,b) => b[1] - a[1])) {
      console.log(`    ${r}: ${n.toLocaleString()}`);
    }
  }
  console.log(`Updated: ${updated.toLocaleString()}`);
  console.log(`Errors:  ${errors.toLocaleString()}`);
})().catch((e) => { console.error(e); process.exit(1); });
