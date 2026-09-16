/**
 * CF-A-GRADE-NAMES-ITS-SOURCE (R58 as amended, Drew 2026-09-15).
 *
 * WHERE A ROW'S GRADE CAME FROM, and what the basis says about it.
 *
 * THE DEFECT
 * ----------
 * Rivera 1992 Bowman #302 BGS 9, priced 2026-09-15: eight BGS 9 sales in
 * 90d, of which SIX carried the generic CardHedge product title
 *
 *     "1992 Bowman Baseball #302 Base"
 *
 * with no grader token anywhere in the sale's own text. Their `BGS 9` came
 * from the CardHedge PRODUCT record, not from the sale. Two of those six —
 * $67 and $31, a 2:1 price ratio — share an identical `soldAt` AND an
 * identical `parallelCanonicalizedAt`: one batch payload, every row stamped
 * with the product's headline grade.
 *
 * THE CENSUS, AND WHY THIS LABELS RATHER THAN DROPS
 * -------------------------------------------------
 * The first draft of R58 removed product-record grades from graded tiers.
 * The census (2026-09-15, 10,128 graded rows across 2,214 partitions) said
 * not to:
 *
 *     token in title                      9,393   92.7%
 *     no token, source cardhedge            596    5.9%   <- this class
 *     no token, other source                139    1.4%
 *
 *     of the 596: twin found                126   21.1%
 *                 twin AGREED               126    100%
 *                 twin disagreed              0       0
 *
 * Where a twin exists to check against, the CardHedge product grade was
 * right 126 times out of 126. Dropping the class would have removed 470
 * rows whose grades are, on the available evidence, correct — and would
 * have taken the Rivera pool from n=8 to n=2.
 *
 * So the amended ruling: PRODUCT-RECORD GRADES STAY IN GRADED TIERS AND ARE
 * LABELLED. A reader is told how many of the grades behind a number came
 * from a sale's own title and how many from a vendor's product record, and
 * decides what that is worth. Where a twin DOES carry a token, the twin's
 * token is the better evidence and it wins.
 *
 * WHY THE TWIN LOOKUP IS PARTITION-SCOPED
 * ---------------------------------------
 * The census's first pass searched every partition for twins and surfaced 3
 * "disagreements". All three were price/time coincidences between unrelated
 * cards — a 2026 Pokemon row matched an unrelated Pitch Black row because
 * both sold at the same price seconds apart. Rescoping to the row's OWN
 * partition or its paired partition (vendor cardId <-> hiq slug) eliminated
 * all three. An unscoped twin search does not find twins; it finds
 * collisions.
 *
 * NOTHING HERE IS PERSISTED. The stamp lives on the reader's own projection,
 * exactly as the R59 self-comp clone stamp does. A persisted `gradeSource`
 * belongs on the ingest path and is a separate PR.
 */

import type { ExactPoolRow, GradeSource } from "./exactPoolReader.js";

/**
 * A grader token in a sale title: company and number adjacent.
 *
 * The six companies are R58's list. ISA, and any other grader not named
 * here, deliberately does not match — an unrecognised grader is not
 * evidence this function may act on.
 *
 * The census noted this strict form misses titles that grade a card without
 * putting the number beside the company ("PSA GEM MINT 10", "Graded 8 Psa").
 * That is a known upper bound on the product-record count, and it is the
 * SAFE direction to err: a missed token labels a real grade as
 * product-record, which under the amended ruling costs nothing but a
 * sentence — it never removes a sale.
 */
const GRADER_TOKEN = /\b(PSA|BGS|SGC|CGC|CSG|HGA)\s*-?\s*(\d{1,2}(?:\.5)?)\b/i;

/** The grader token a title names, normalized, or null. */
export function graderTokenInTitle(
  title: string | null | undefined,
): { company: string; value: number } | null {
  if (typeof title !== "string" || title.trim() === "") return null;
  const m = GRADER_TOKEN.exec(title);
  if (!m) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  return { company: m[1].toUpperCase(), value };
}

/** Does a row currently claim a grade at all? Ungraded rows are out of
 *  scope — R58 only speaks about rows that assert a grade. */
export function rowIsGraded(r: Pick<ExactPoolRow, "gradeCompany" | "gradeValue">): boolean {
  return typeof r.gradeCompany === "string"
    && r.gradeCompany.trim() !== ""
    && typeof r.gradeValue === "number"
    && Number.isFinite(r.gradeValue);
}

/** "PSA 10" / "BGS 9.5", the engine's own tier spelling. */
function tierOf(company: string | null | undefined, value: number | null | undefined): string {
  return `${String(company ?? "").trim().toUpperCase()} ${value}`.trim();
}

/** The identity keys a row was found under, for partition scoping. */
function keysOf(r: ExactPoolRow): string[] {
  const keys: string[] = [];
  if (typeof r.cardId === "string" && r.cardId.trim()) keys.push(r.cardId.trim());
  if (typeof r.hobbyiqCardId === "string" && r.hobbyiqCardId.trim()) keys.push(r.hobbyiqCardId.trim());
  return keys;
}

/**
 * Same partition, or the PAIRED partition (vendor cardId <-> hiq slug).
 *
 * Two rows are in scope for each other when they share any identity key —
 * a vendor-partition row carries the slug on `hobbyiqCardId`, which is
 * exactly the pairing, and how the engine's own cross-partition OR found
 * both in one query. A row with no keys projected cannot refute the
 * pairing, so it is allowed through (the fixture case).
 */
function sharesPartitionScope(a: ExactPoolRow, b: ExactPoolRow): boolean {
  const ka = keysOf(a);
  const kb = keysOf(b);
  if (ka.length === 0 || kb.length === 0) return true;
  return ka.some((k) => kb.includes(k));
}

/** Sales this close together, same price, are one sale reported twice. */
const TWIN_WINDOW_MS = 60_000;

/**
 * Stamp `gradeSource` on every graded row, IN PLACE, and return the rows.
 *
 * MUST run on the RAW rows, before `dedupeSoldComps`. Dedupe buckets by
 * (gradeKey, price) and keeps only the first row of a cluster — so a
 * ch-daily row and its ch-fill twin that agree on the grade collapse to
 * one, and the twin whose title carries the token is exactly the copy that
 * gets dropped. Classify first, then dedupe: the surviving row then carries
 * the evidence its twin brought.
 *
 * Pure apart from the stamp it is asked to make; no Cosmos read, no write.
 */
export function stampGradeSources(rows: ExactPoolRow[]): ExactPoolRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows ?? [];

  // Pass 1: a row whose OWN title names a grader is settled on its own
  // evidence and never consults a twin.
  const needsTwin: ExactPoolRow[] = [];
  for (const r of rows) {
    if (!rowIsGraded(r)) continue;
    if (graderTokenInTitle(r.title)) {
      r.gradeSource = "sale-title";
      continue;
    }
    r.gradeSource = "product-record";
    needsTwin.push(r);
  }
  if (needsTwin.length === 0) return rows;

  // Pass 2: for each product-record row, look for a twin that carries a
  // token — same price, within 60s, a DIFFERENT row, in scope.
  for (const row of needsTwin) {
    const price = Number(row.price);
    const t = Date.parse(String(row.soldAt ?? ""));
    if (!Number.isFinite(price) || !Number.isFinite(t)) continue;
    for (const cand of rows) {
      if (cand === row) continue;
      // A twin is a different ROW. Identity by `id` when both carry one,
      // so two distinct rows that happen to share an object shape still
      // compare correctly.
      if (typeof cand.id === "string" && typeof row.id === "string" && cand.id === row.id) continue;
      const token = graderTokenInTitle(cand.title);
      if (!token) continue;
      if (Number(cand.price) !== price) continue;
      const ct = Date.parse(String(cand.soldAt ?? ""));
      if (!Number.isFinite(ct) || Math.abs(ct - t) > TWIN_WINDOW_MS) continue;
      if (!sharesPartitionScope(row, cand)) continue;

      const storedTier = tierOf(row.gradeCompany, row.gradeValue);
      const twinTier = tierOf(token.company, token.value);
      row.gradeSource = "twin-title";
      if (storedTier !== twinTier) {
        // THE TWIN WINS. Its title is evidence from the sale itself; the
        // stored grade is the vendor's product record. What was replaced is
        // recorded so the override is auditable.
        row.gradeOverriddenFrom = storedTier;
        row.gradeCompany = token.company;
        row.gradeValue = token.value;
        console.log(JSON.stringify({
          event: "grade_source_twin_override",
          from: storedTier,
          to: twinTier,
          price,
          soldAt: row.soldAt,
          rowId: row.id ?? null,
          twinId: cand.id ?? null,
          detail: "the twin's title names a grader and the product record disagreed — the twin's grade stands",
        }));
      }
      break;
    }
  }
  return rows;
}

export interface GradeSourceCounts {
  "sale-title": number;
  "product-record": number;
  "twin-title": number;
}

/** How many of a pool's graded rows got their grade from where. */
export function countGradeSources(
  rows: ReadonlyArray<Pick<ExactPoolRow, "gradeSource" | "gradeCompany" | "gradeValue">>,
): GradeSourceCounts {
  const counts: GradeSourceCounts = { "sale-title": 0, "product-record": 0, "twin-title": 0 };
  for (const r of rows) {
    if (!rowIsGraded(r)) continue;
    const s: GradeSource = r.gradeSource ?? "product-record";
    counts[s] += 1;
  }
  return counts;
}

/**
 * The basis sentence, per R58 item 3. Emitted ONLY when at least one grade
 * behind the number came from a vendor product record — a pool whose grades
 * all trace to sale titles says nothing, because there is nothing to
 * caveat.
 *
 * `twin-title` rows count as sale-title evidence in the sentence: the token
 * came from the sale, just from the other copy of it.
 */
export function gradeSourceNote(counts: GradeSourceCounts): string | null {
  const productRecord = counts["product-record"];
  if (productRecord <= 0) return null;
  const fromTitles = counts["sale-title"] + counts["twin-title"];
  const parts: string[] = [];
  if (fromTitles > 0) parts.push(`${fromTitles} from sale title${fromTitles === 1 ? "" : "s"}`);
  parts.push(`${productRecord} from the vendor product record`);
  return `grades: ${parts.join(", ")}`;
}
