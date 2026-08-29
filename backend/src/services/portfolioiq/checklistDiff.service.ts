// CF-CHECKLIST-DIFF (Drew, 2026-08-08). Paste a product checklist and
// diff it against what's in card_catalog for that year+set. Powers the
// admin review surface's "confirm against product checklist" step per
// Drew's 2026-08-08 directive.
//
// Input: raw text (one line per card, formats flexible) + year + setKey.
// Parser accepts common formats:
//   "#BDP129 Justin Verlander"
//   "BDP129 Justin Verlander RC"
//   "BDP129, Justin Verlander"
//   "BDP129|Justin Verlander"
//   "129 Fred McGriff"
// Non-digit-optional card number followed by remainder = player name.
//
// Output:
//   inCatalog: [{ cardNumber, player, matchedSlug }]      — checklist rows that map to a catalog entry
//   missingFromCatalog: [{ cardNumber, player }]          — checklist rows with NO catalog match — these are the "seed me" candidates
//   extraInCatalog: [{ cardNumber, playerName, slug }]    — catalog entries for this year+setKey that AREN'T in the pasted checklist — likely spurious / non-canonical

import { CosmosClient, type Container } from "@azure/cosmos";
import { normalizeSetKey } from "./hobbyIqCardId.service.js";
import { deriveCatalogEntry, upsertCatalogEntry } from "./cardCatalog.service.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";

let _catalog: Container | null = null;
function getCatalog(): Container | null {
  if (_catalog) return _catalog;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _catalog = new CosmosClient(conn).database(COSMOS_DATABASE).container("card_catalog");
    return _catalog;
  } catch { return null; }
}

export interface ParsedChecklistRow {
  cardNumber: string;
  player: string;
}

/** Parse arbitrary pasted checklist text into (cardNumber, player) rows.
 *  Skips empty lines and comment lines starting with #. Lines that
 *  can't be parsed are dropped silently — caller can log if desired. */
export function parseChecklistText(raw: string): ParsedChecklistRow[] {
  const out: ParsedChecklistRow[] = [];
  if (!raw) return out;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip comment/header rows starting with `#` UNLESS the # is a
    // cardNumber prefix. Heuristic: if the first char is # AND the
    // rest starts with a digit or letter+digit combo, treat as a card
    // row (strip the #). Otherwise treat as comment.
    let work = trimmed;
    if (work.startsWith("#")) {
      const rest = work.slice(1).trim();
      if (/^[A-Za-z]{0,4}\d+/.test(rest)) work = rest;
      else continue;
    }
    // Split on the first run of whitespace, comma, pipe, or dash-with-spaces
    const parts = work.split(/[\s,|]+|\s+-\s+/);
    if (parts.length < 2) continue;
    // The card number is the FIRST token that looks like a card number:
    // optional letter prefix (BDP, CPA, US, etc.) + digits + optional dash + more chars
    let cardNumIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^[A-Za-z]{0,6}-?\d+[A-Za-z0-9-]*$/.test(parts[i])) {
        cardNumIdx = i;
        break;
      }
    }
    if (cardNumIdx < 0) continue;
    const cardNumber = parts[cardNumIdx];
    const remainder = parts.slice(0, cardNumIdx).concat(parts.slice(cardNumIdx + 1)).join(" ").trim();
    // Strip trailing tags like "RC", "SP", etc. from the player name
    const player = remainder.replace(/\b(RC|SP|SSP|CU|GU|RCA|RCG)\b/gi, "").replace(/\s+/g, " ").trim();
    if (!player) continue;
    out.push({ cardNumber: cardNumber.toUpperCase(), player });
  }
  return out;
}

export interface ChecklistDiffResult {
  parsed: number;
  inCatalog: Array<{ cardNumber: string; player: string; matchedSlug: string }>;
  missingFromCatalog: Array<{ cardNumber: string; player: string }>;
  extraInCatalog: Array<{ cardNumber: string; playerName: string | null; slug: string; verificationStatus?: string | null }>;
  setKey: string;
  year: number;
}

export async function diffChecklistAgainstCatalog(opts: {
  checklistText: string;
  year: number;
  setName: string;
  sport?: string;
}): Promise<ChecklistDiffResult | null> {
  const cat = getCatalog();
  if (!cat) return null;

  const setKey = normalizeSetKey(opts.setName);
  const year = Math.trunc(Number(opts.year));
  const sport = (opts.sport ?? "").toLowerCase().trim();
  const rows = parseChecklistText(opts.checklistText);

  // Fetch all catalog entries for this year+setKey. Cross-partition —
  // capped at 1000 rows because a valid set checklist rarely exceeds
  // that; anything beyond is unusable in a UI anyway.
  const conds = ["(c.year = @y OR c.cardYear = @y)", "c.setKey = @sk"];
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@y", value: year },
    { name: "@sk", value: setKey },
  ];
  if (sport) { conds.push("c.sport = @sp"); params.push({ name: "@sp", value: sport }); }
  const { resources: catalogEntries } = await cat.items.query<{
    id: string; cardNumber?: string; number?: string; playerName?: string; player?: string;
    verificationStatus?: string;
  }>({
    query: `SELECT TOP 1000 c.id, c.cardNumber, c["number"] AS number, c.playerName, c.player, c.verificationStatus FROM c WHERE ${conds.join(" AND ")}`,
    parameters: params,
  }).fetchAll();

  const catalogByNumber = new Map<string, typeof catalogEntries[number]>();
  for (const e of catalogEntries) {
    const cn = String(e.cardNumber ?? e.number ?? "").toUpperCase();
    if (cn) catalogByNumber.set(cn, e);
  }

  const inCatalog: ChecklistDiffResult["inCatalog"] = [];
  const missingFromCatalog: ChecklistDiffResult["missingFromCatalog"] = [];
  const seenChecklistNumbers = new Set<string>();
  for (const row of rows) {
    seenChecklistNumbers.add(row.cardNumber);
    const hit = catalogByNumber.get(row.cardNumber);
    if (hit) {
      inCatalog.push({ cardNumber: row.cardNumber, player: row.player, matchedSlug: hit.id });
    } else {
      missingFromCatalog.push({ cardNumber: row.cardNumber, player: row.player });
    }
  }

  const extraInCatalog: ChecklistDiffResult["extraInCatalog"] = [];
  for (const e of catalogEntries) {
    const cn = String(e.cardNumber ?? e.number ?? "").toUpperCase();
    if (!cn || seenChecklistNumbers.has(cn)) continue;
    extraInCatalog.push({
      cardNumber: cn,
      playerName: e.playerName ?? e.player ?? null,
      slug: e.id,
      verificationStatus: e.verificationStatus ?? null,
    });
  }

  return {
    parsed: rows.length,
    inCatalog,
    missingFromCatalog,
    extraInCatalog,
    setKey,
    year,
  };
}

// CF-CHECKLIST-ADD-MISSING (Drew, 2026-08-08). Bulk-create catalog
// entries for every "missing from catalog" row identified by the
// checklist diff. Each entry lands with verificationStatus='pending-
// review' so admin still owns the final approval — this is a
// PROPOSAL mechanism, not a silent auto-add. Source is the pasted
// checklist (admin-curated by definition), so confidence starts high
// (0.85) but stays pending until explicit review.
export interface CreateFromChecklistInput {
  year: number;
  sport: string;
  setName: string;
  rows: Array<{ cardNumber: string; player: string }>;
}

export interface CreateFromChecklistResult {
  written: number;
  skipped: number;
  errored: number;
  writtenSlugs: string[];
}

// Autograph-prefix hints — if the cardNumber matches a known auto-set
// prefix, we mark isAuto=true so downstream slug + FMV logic route
// through the autograph tables.
const AUTO_CARD_NUMBER_PREFIX = /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV|TEK|CDA|BSPA|CPAR|CPALD|CPATWH)-/i;

export async function createCatalogEntriesFromChecklist(
  input: CreateFromChecklistInput,
): Promise<CreateFromChecklistResult | null> {
  // CF-ONE-WAY-TO-BUILD-A-CATALOG-ROW (catalog rebuild D5, PR 8, 2026-08-29).
  // This used to raw-upsert a hand-built document: it dropped parallelSlug /
  // playerSlug / searchTokens, skipped the authority contest, and so a later
  // lower-ranked writer could silently clobber a real checklist row. A pasted
  // checklist IS a checklist ("checklist-admin-add" ranks as one), so it goes
  // through the one writer every checklist row goes through.
  if (!getCatalog()) return null; // Cosmos configured?

  const setKey = normalizeSetKey(input.setName);
  const year = Math.trunc(Number(input.year));
  const sport = String(input.sport ?? "").toLowerCase().trim() || "baseball";
  const isAutoSet = /autograph/i.test(input.setName);

  const result: CreateFromChecklistResult = { written: 0, skipped: 0, errored: 0, writtenSlugs: [] };

  for (const row of input.rows) {
    const cardNumber = String(row.cardNumber ?? "").trim().toUpperCase();
    const player = String(row.player ?? "").trim();
    if (!cardNumber || !player) { result.skipped++; continue; }

    const isAuto = isAutoSet || AUTO_CARD_NUMBER_PREFIX.test(cardNumber);
    const derived = deriveCatalogEntry({
      sport, year, setKey, cardNumber,
      parallel: "Base",
      isAuto,
      printRun: null,
      playerName: player,
      source: "checklist-admin-add",
      // Pasted from an admin-sourced checklist -> high confidence base
      // but stays pending until explicit verification.
      confidence: 0.85,
      // the admin named the product; never the vendor-text prefix repair
      authoritativeSetKey: true,
    });
    if (!derived) { result.errored++; continue; }

    try {
      const entry = { ...derived, setName: input.setName, verificationStatus: "pending-review" };
      const written = await upsertCatalogEntry(entry);
      if (!written) { result.errored++; continue; }
      result.written++;
      if (result.writtenSlugs.length < 20) result.writtenSlugs.push(derived.id);
    } catch {
      result.errored++;
    }
  }

  return result;
}
