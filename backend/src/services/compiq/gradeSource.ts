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
  //
  // An UNGRADED row is normally out of scope — R58 speaks about rows that
  // assert a grade — with ONE exception, which is the defect the twin census
  // (2026-09-16) actually found. All 42 twins that survived the 60-minute
  // dedupe were `ch-daily = RAW` against a `ch-fill` twin whose title said
  // PSA 9/10: the vendor product record had no grade for that sale, so the
  // row entered the RAW TIER AT A GRADED PRICE (Rivera's raw tier spanning
  // $0.99-$800; Ohtani 2018 Leaf PR-02 raw reading $7.95-$136.19 against a
  // true clearing price near $13.50).
  //
  // Such a row is exactly a product-record row whose product record happened
  // to say "no grade". It is admitted to the twin pass so its twin's title
  // can correct it — and ONLY when its own title names no grader, so a
  // genuinely raw sale that says so is never touched. A raw row whose twin
  // is also raw simply finds nothing and keeps `gradeSource` unset, which is
  // what `countGradeSources` already ignores.
  const needsTwin: ExactPoolRow[] = [];
  for (const r of rows) {
    const graded = rowIsGraded(r);
    if (graded && graderTokenInTitle(r.title)) {
      r.gradeSource = "sale-title";
      continue;
    }
    if (!graded) {
      // No grade asserted and no token of its own: eligible for correction,
      // but carries no gradeSource unless a twin actually supplies one.
      if (!graderTokenInTitle(r.title)) needsTwin.push(r);
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

      // An ungraded row's "stored tier" is RAW — which is precisely the
      // claim the twin is about to refute, so it must be spelled and
      // recorded, not left blank.
      const storedTier = rowIsGraded(row) ? tierOf(row.gradeCompany, row.gradeValue) : "RAW";
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
  // ── CF-A-RECONCILED-TWIN-IS-ONE-SALE (R58, the twin census 2026-09-16) ──
  //
  // How many vendor copies were reconciled to their sale title and then
  // collapsed away by the existing 60-minute dedupe — one sale that used to
  // be counted twice, at two different grades.
  //
  // The census measured why this number is not zero. Across 926 vendor<->slug
  // pairs (1,846 partitions, 59,536 rows) there were 645 exact ch-daily /
  // ch-fill twins. `dedupeSoldComps` already collapsed 603 of them (93.5%) —
  // it buckets by (gradeKey, price), so twins that AGREE on the grade meet in
  // one bucket and the earliest wins. The 42 that survived (6.5%) survived
  // precisely BECAUSE they disagreed about the grade: a RAW copy and a PSA 10
  // copy hash to different buckets and are never compared.
  //
  // Every one of those 42 was the same shape — ch-daily said RAW, the
  // ch-fill twin's title said PSA 9 or PSA 10 — and the token asymmetry was
  // perfectly one-directional: 58 twins where only ch-fill carried a grader
  // token, ZERO the other way. So the RAW-labelled copy was landing in the
  // RAW TIER AT A GRADED PRICE. Measured on Ohtani 2018 Leaf PR-02: the raw
  // tier read $7.95-$136.19 with 15 rows over $100 and a mean of $21.81,
  // against a true raw clearing price near $13.50. On Rivera 1992 Bowman
  // #302: $0.99-$800, the $800 being a PSA 10 whose title is
  // "1992 Bowman Baseball #302 Base".
  //
  // `stampGradeSources` restamps that copy from its twin's title, which both
  // removes it from the raw tier AND puts it in the same dedupe bucket as its
  // twin — so the dedupe that already runs then collapses the pair. No new
  // dedupe pass exists or is needed. This counter is the LABEL on that: it
  // says how many rows the reconciliation removed, so a reader is told the
  // pool was repaired rather than silently seeing a smaller `n`.
  "twins-collapsed": number;
}

/** A zero GradeSourceCounts. */
export function emptyGradeSourceCounts(): GradeSourceCounts {
  return { "sale-title": 0, "product-record": 0, "twin-title": 0, "twins-collapsed": 0 };
}

/**
 * How many rows the twin reconciliation removed: rows `stampGradeSources`
 * restamped from a twin's title (`gradeOverriddenFrom` set) that the
 * subsequent dedupe then collapsed away.
 *
 * Measured ACROSS the two steps, because that is what actually happened —
 * the stamp alone changes a grade, and only the dedupe behind it turns two
 * rows into one. Counting the overrides that SURVIVE and subtracting is the
 * only way to tell "reconciled and merged" from "reconciled and kept" (a
 * twin whose partner fell outside the 60-minute dedupe window).
 *
 * Pure; both arrays are the caller's, `after` being a subset of `before`.
 */
export function countTwinsCollapsed(
  before: ReadonlyArray<ExactPoolRow>,
  after: ReadonlyArray<ExactPoolRow>,
): number {
  const overridden = before.filter((r) => typeof r.gradeOverriddenFrom === "string");
  if (overridden.length === 0) return 0;
  const survivors = new Set<ExactPoolRow>(after);

  // Count the rows the merge REMOVED from each reconciled cluster — not the
  // overridden rows themselves.
  //
  // Which of a pair survives is not the question and must not be assumed:
  // `dedupeSoldComps` keeps the EARLIEST row of a cluster, and the vendor
  // `ch-daily` copy is usually the earlier one, so the row that gets
  // restamped is typically the row that STAYS while its title-bearing twin
  // is the one dropped. An earlier draft of this counter asked "was the
  // overridden row removed?" and answered 0 on exactly the Rivera pair it
  // exists to describe.
  //
  // A cluster is (grade after reconciliation, price) — the same key the
  // dedupe buckets on, which is the point: reconciliation MOVES a row into
  // its twin's bucket, and the merge that follows is what removes a row.
  const clusterKey = (r: ExactPoolRow): string => {
    const company = typeof r.gradeCompany === "string" && r.gradeCompany.trim()
      ? r.gradeCompany.trim().toUpperCase()
      : "RAW";
    const value = typeof r.gradeValue === "number" && Number.isFinite(r.gradeValue) ? String(r.gradeValue) : "";
    return `${company}:${value}|${Number(r.price).toFixed(2)}`;
  };
  const reconciledClusters = new Set(overridden.map(clusterKey));
  let removed = 0;
  for (const r of before) {
    if (survivors.has(r)) continue;
    if (reconciledClusters.has(clusterKey(r))) removed += 1;
  }
  return removed;
}

/** How many of a pool's graded rows got their grade from where.
 *
 *  `twinsCollapsed` is not derivable from the surviving rows — the rows it
 *  counts are gone by then — so the caller passes it in from
 *  `countTwinsCollapsed`, measured across the stamp/dedupe boundary. */
export function countGradeSources(
  rows: ReadonlyArray<Pick<ExactPoolRow, "gradeSource" | "gradeCompany" | "gradeValue">>,
  twinsCollapsed = 0,
): GradeSourceCounts {
  const counts = emptyGradeSourceCounts();
  for (const r of rows) {
    if (!rowIsGraded(r)) continue;
    const s: GradeSource = r.gradeSource ?? "product-record";
    counts[s] += 1;
  }
  counts["twins-collapsed"] = Number.isFinite(twinsCollapsed) && twinsCollapsed > 0 ? twinsCollapsed : 0;
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
  const collapsed = counts["twins-collapsed"];
  // Either fact is worth stating on its own: grades that trace to a vendor
  // record, or vendor copies this read reconciled and merged. A pool with
  // neither says nothing.
  if (productRecord <= 0 && collapsed <= 0) return null;
  const segments: string[] = [];
  if (productRecord > 0) {
    const fromTitles = counts["sale-title"] + counts["twin-title"];
    const parts: string[] = [];
    if (fromTitles > 0) parts.push(`${fromTitles} from sale title${fromTitles === 1 ? "" : "s"}`);
    parts.push(`${productRecord} from the vendor product record`);
    segments.push(`grades: ${parts.join(", ")}`);
  }
  if (collapsed > 0) {
    // Say what was done and why the count moved, so a smaller `n` reads as a
    // repair rather than missing evidence.
    segments.push(
      `${collapsed} vendor cop${collapsed === 1 ? "y" : "ies"} reconciled to ${collapsed === 1 ? "its sale title" : "their sale titles"} and merged`,
    );
  }
  return segments.join("; ");
}
