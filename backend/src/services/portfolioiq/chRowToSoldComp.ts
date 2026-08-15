// CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14). Shared CH-row →
// RecordSoldCompInput mapping.
//
// Why this file exists: the identical mapping already lived inline in
// backend/scripts/bulk-import-ch-daily-to-sold-comps.cjs, which wrote
// ~4.2M of the current sold_comps rows. The historical CSV backfill
// needs the SAME mapping, and a second hand-rolled copy would drift —
// producing rows that disagree with the 4.2M already in the pool.
//
// Two invariants this module exists to hold:
//
//   1. sourceExternalId format `ch-daily::{price_history_id}` is shared
//      with the bulk-import script. That is what makes the CSV path and
//      the ch_daily_sales path idempotent AGAINST EACH OTHER — the same
//      CH sale reached by either route collapses onto one doc id.
//
//   2. isAuto / grade / sport derivation must match, or the same sale
//      lands in a different comp tier depending on which path saw it.
//
// The mapping is intentionally a pure function: no Cosmos, no network.
// recordSoldComp() does the identity + dedup + cleaning work downstream
// (preIngestClean runs there for every caller since CF-PRE-INGEST-CLEAN).

import type { CHDailySaleRow } from "../../types/chDailySales.types.js";
import type { RecordSoldCompInput } from "./soldCompsStore.service.js";

/** CH `group` → our canonical sport tag. Returns null for groups we
 *  don't carry (the caller decides whether that's a skip or an accept).
 *  Per CF-CH-INGEST-MULTI-SPORT: sport comes from the `group` field,
 *  NOT from card_set text — modern football/basketball set names often
 *  contain no sport word at all. */
export function normSport(chGroup: string | null | undefined): string | null {
  const g = String(chGroup ?? "").trim().toLowerCase();
  if (g === "baseball") return "baseball";
  if (g === "basketball") return "basketball";
  if (g === "football") return "football";
  if (g === "hockey") return "hockey";
  if (g === "soccer") return "soccer";
  return null;
}

/** CH grader string → canonical company, or null for raw/unknown. */
export function normGrader(grader: string | null | undefined): string | null {
  const g = String(grader ?? "").trim().toUpperCase();
  if (!g || g === "RAW" || g === "UNGRADED") return null;
  if (["PSA", "BGS", "SGC", "CGC", "BVG"].includes(g)) return g;
  return null;
}

/** CH grade string → numeric grade, or null. */
export function parseGrade(gradeStr: string | null | undefined): number | null {
  if (gradeStr === null || gradeStr === undefined) return null;
  const s = String(gradeStr).trim();
  if (!s || s.toLowerCase() === "raw") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null;
}

// Curated auto-prefix list. Per CF-ISAUTO-CARDNUMBER-BOUNDARY the
// cardNumber prefix IS the authoritative auto boundary.
const AUTO_PREFIXES =
  /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|CPALD|CPATWH|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CDA|CRA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|BA|PA|RA|FA|TA|AA|AP|WT)-/;

/**
 * Derive isAuto for a CH row.
 *
 * NOTE (deliberate, do not "fix" casually): this checks auto tokens in
 * variant + description IN ADDITION to the cardNumber prefix. The
 * cardNumber-prefix rule is the authoritative boundary, and the text
 * check is the weaker signal. It is preserved here verbatim from
 * bulk-import-ch-daily-to-sold-comps.cjs because ~4.2M sold_comps rows
 * were already written with exactly this behavior — tightening it in
 * this module alone would make new rows disagree with old ones for the
 * same card, which is worse than the looseness itself. If the text
 * signal is to be dropped, it must be dropped for the existing pool at
 * the same time (a re-derivation pass), not just going forward.
 */
export function inferIsAutoFromCH(row: Pick<CHDailySaleRow, "variant" | "description" | "number">): boolean {
  const combined = `${row.variant ?? ""} ${row.description ?? ""}`.toLowerCase();
  if (/\bauto(graph)?\b/.test(combined)) return true;
  if (/\bautographed\b/.test(combined)) return true;
  const num = String(row.number ?? "").toUpperCase();
  if (AUTO_PREFIXES.test(num)) return true;
  return false;
}

export interface MapOptions {
  /** Canonical sport tags to keep. null/empty = accept all sports. */
  sportFilter?: string[] | null;
}

export type MapSkipReason =
  | "sport-filtered"
  | "no-sport"
  | "no-player"
  | "no-price"
  | "no-card-id"
  | "no-sale-date";

export type MapResult =
  | { ok: true; input: RecordSoldCompInput }
  | { ok: false; skip: MapSkipReason };

/**
 * Map one CH daily-export row to a recordSoldComp input.
 *
 * Returns a discriminated result rather than throwing — a single
 * malformed row in a 78k-row file must never abort the day.
 */
export function mapChRowToSoldComp(row: CHDailySaleRow, opts: MapOptions = {}): MapResult {
  const cardId = String(row.card_id ?? "").trim();
  if (!cardId) return { ok: false, skip: "no-card-id" };

  const sport = normSport(row.group);
  const filter = opts.sportFilter && opts.sportFilter.length > 0 ? opts.sportFilter : null;
  if (filter) {
    if (!sport) return { ok: false, skip: "no-sport" };
    if (!filter.includes(sport)) return { ok: false, skip: "sport-filtered" };
  }

  const playerName = String(row.player ?? "").trim();
  if (!playerName) return { ok: false, skip: "no-player" };

  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, skip: "no-price" };

  const soldAt = String(row.sale_date ?? "").trim();
  if (!soldAt) return { ok: false, skip: "no-sale-date" };

  const year = Number(row.year);

  return {
    ok: true,
    input: {
      cardId,
      playerName,
      cardYear: Number.isFinite(year) && year > 0 ? year : null,
      setName: row.card_set || row.card_set_type || null,
      parallel: row.variant || "Base",
      cardNumber: row.number || null,
      isAuto: inferIsAutoFromCH(row),
      sport,
      gradeCompany: normGrader(row.grader),
      gradeValue: parseGrade(row.grade),
      price,
      soldAt,
      source: "cardhedge",
      // MUST match bulk-import-ch-daily-to-sold-comps.cjs — see header.
      sourceExternalId: `ch-daily::${row.price_history_id}`,
      contributorUserId: null,
      title: row.description || row.card_description || null,
      imageUrl: row.image_url || null,
      // Threaded for verify_queue triage only — recordSoldComp does not
      // write this to sold_comps and it is not part of the contentHash,
      // so populating it cannot diverge from the bulk-import rows.
      url: row.listing_url || null,
      sellerHandle: null,
      verifiedByUser: false,
      // CH-daily is authoritative for sale existence.
      confidence: 0.9,
    },
  };
}
