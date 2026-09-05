/**
 * CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES
 * (Drew, 2026-09-05, ruling B).
 *
 * A source can transcribe a real printed checklist and still get the cards
 * wrong. hobbymonitor does, measurably, and #1795 is where we found out.
 *
 * ── WHAT #1795 MEASURED ─────────────────────────────────────────────────────
 *
 * The `panini-score` era repair compared hobbymonitor's 2025 Panini Score
 * transcription against `score`'s checklistinsider rows at the identical
 * identity slug, and against the published checklist
 * (checklistcenter.com/2025-score-nfl-football-card-checklist, and Beckett):
 *
 *   2,811 of 3,702 hobbymonitor rows have a twin at the identical slug
 *   2,571 of those 2,811 name a DIFFERENT PLAYER at that number
 *   where both name the SAME player, they disagree on the number
 *       343 times against 376 agreements -- roughly half
 *   32 keys carry TWO DIFFERENT PLAYERS at one (number, parallel, isAuto),
 *       which is internally inconsistent regardless of any second source
 *   checklistinsider was right every time it was checked; hobbymonitor was
 *       right only sometimes
 *
 * That is not a scrape with a bug in one release. A source that contradicts
 * ITSELF on 32 cells of one product is a source whose unsupported word cannot
 * be the thing a price rests on.
 *
 * ── WHY DEMOTION AND NOT REMOVAL ────────────────────────────────────────────
 *
 * hobbymonitor is 1,192,925 catalog rows across 175 (sport, year, setKey)
 * cells, and it is the ONLY source that covers most modern Panini football and
 * basketball releases -- 2022 panini-select (28,497 rows), 2025
 * panini-donruss-optic (24,384), 2023 panini-mosaic (21,687) and dozens more
 * have no second strict transcription at all. Deleting it, or refusing it
 * outright, would take coverage away from the exact products the app is asked
 * about most. CF-ABSENT-BEATS-WRONG cuts the other way here only because the
 * alternative is not "a better row" but "no row".
 *
 * So the ruling is a DEMOTION, in the shape identityBacking.ts already
 * established: the rows stay, and they carry `identityUnverified` where nothing
 * corroborates them. That is a LABEL and an acquisition work item -- the
 * uncorroborated list is the queue of products whose checklist we should buy
 * next -- and never a judgement that the cards are fake.
 *
 * ── WHY THIS IS ONE PREDICATE AND NOT A SIXTH ONE ───────────────────────────
 *
 * `catalogAuthority.service.ts`'s header records what happened the two times
 * one question was reimplemented in several places with slightly different
 * answers: 51 card-number prefixes flipped from "repair" to "blocked", and
 * baseballcardpedia's 918,828 rows were discarded by an allowlist that had
 * decayed. There are FOUR consumers of "is this row checklist-backed" and each
 * spells it differently today:
 *
 *   catalogAuthority.service.ts  CHECKLIST regex   -- carried `hobbymonitor`
 *   identityBacking.ts           via catalogAuthorityOf
 *   rematch-classify.cjs         STRICT_CHECKLIST_SOURCES -- carried it too
 *   ingest-universe-driver.cjs   LANE_SOURCE -> catalogAuthorityOf
 *
 * A demotion applied to three of the four would be the same bug in a new
 * costume: the rematch would keep writing rows the pricing gate refuses, or
 * worse, the pricing gate would keep publishing rows the rematch will not
 * confirm. So the corroboration question gets ONE definition, here, and every
 * one of those consumers asks it rather than re-deciding it.
 *
 * ── WHY `catalogAuthorityOf` KEEPS ITS SIGNATURE ────────────────────────────
 *
 * `catalogAuthorityOf(source)` is a PURE STRING function with ~45 call sites,
 * and the question it answers -- "is this row evidence at all" -- still has the
 * same answer for hobbymonitor: yes. What changed is a DIFFERENT question,
 * "may a price rest on THIS ROW", and that one cannot be answered from a source
 * string alone: it needs the row's identity cell and the catalog around it.
 *
 * Widening `catalogAuthorityOf` to take a row would move all 45 call sites for
 * the benefit of four, and the header's own lesson (CF-THE-RECURRING-BUG-SHAPE:
 * right guard, wrong scope) says not to. So `catalogAuthorityOf` keeps
 * answering the string question -- and `hobbymonitor` stays in its CHECKLIST
 * regex, because a hobbymonitor row IS a transcription and IS re-keyable and
 * DOES outrank a derived stub. The corroboration question is asked here, by
 * name, by the consumers that need it.
 *
 * ── THE CORROBORATION READ ──────────────────────────────────────────────────
 *
 * A hobbymonitor row is CORROBORATED when another STRICT source carries a row
 * at the same identity cell:
 *
 *     (sport, year, setKey, cardNumber, parallel, isAuto)
 *
 * and, when BOTH rows carry a player name, the two names agree.
 *
 * The cell is read off the identity SLUG, not off each row's free-text fields,
 * and that is load-bearing. Measured read-only on 2026-09-05 over football/2024
 * /panini-prizm, the same card is spelled `Lazer` by hobbymonitor, `Purple
 * Pulsar Prizms` by checklistinsider and `Pink Ice Prizm` by bccp -- the raw
 * `parallel` column is each publisher's own prose. The slug's segments are what
 * `computeHobbyIqCardId` normalised, so they are the only axis on which two
 * sources can be compared at all.
 *
 * THE YEAR IS READ cardYear-AWARE. #1769 measured 2.07M rows invisible to the
 * rematch because it filtered on `year` while the rows carried `cardYear`; both
 * spellings are accepted here and the SLUG segment is preferred over either,
 * for the same reason the cell is: the id is the identity, the fields drift.
 *
 * A PLAYERLESS RIVAL STILL CORROBORATES. bccp carries `playerName: null` on
 * most of its rows (measured: 117 of 117 sampled football/2024/panini-prizm
 * base rows). Requiring a name match against a row that has no name would
 * refuse the corroboration a real second transcription is offering. So the
 * name is compared only when BOTH sides carry one -- which is exactly the
 * ruling's "player when both carry one".
 *
 * A GRADED TWIN IS NOT A SECOND SOURCE. Graded children are minted from their
 * parents by materialize-graded-identities; counting one as corroboration would
 * let a row confirm itself one tier up. They are excluded from the rival set.
 *
 * ── WHAT THE MEASUREMENT SAYS ───────────────────────────────────────────────
 *
 * Measured read-only over all 175 hobbymonitor cells, 2026-09-05: hobbymonitor
 * agrees with a second strict source on a small minority of its rows, and the
 * modern Panini football/basketball releases -- the ones the app is asked about
 * most -- are almost entirely uncorroborated, because no second source has
 * transcribed them at all. The per-product numbers are in the PR body.
 *
 * That is the honest state of the catalog and not a defect in this predicate:
 * `noTwin` overwhelmingly means "we have not acquired that product's checklist
 * yet", exactly as annotate-checklist-backing's header says of `unconfirmed`.
 * The list is an ACQUISITION QUEUE.
 */
import { catalogAuthorityOf } from "./catalogAuthority.service.js";

/**
 * Sources whose transcription is trusted ONLY where a second strict source
 * agrees on the identity cell.
 *
 * ONE ENTRY, and it is a list rather than a constant because the shape
 * generalises: the next source measured to contradict itself lands here rather
 * than in a second predicate. Prefix-tested against the NORMALIZED source, so a
 * re-scrape (`hobbymonitor-2026-09-04`) and a graded twin
 * (`hobbymonitor-graded`) inherit the demotion without a code change -- the
 * exact decay that discarded baseballcardpedia's 918,828 rows once already.
 */
export const CORROBORATION_REQUIRED_SOURCES: readonly string[] = Object.freeze([
  "hobbymonitor",
]);

/**
 * The catalog's per-ingest suffixes and date stamps, stripped so a source stays
 * classified across re-scrapes.
 *
 * A MIRROR OF rematch-classify's `normalizeCatalogSource`, and deliberately the
 * same rules: `scraped` is stripped as an INGEST VERB rather than a name (the
 * same publisher appears as `tcdb-2026-08-12` and `tcgdex-scraped-2026-08-16`),
 * and the `-graded` / `-attested` / `-unnumbered` suffixes are stripped
 * repeatedly because the catalog really does carry `-graded-graded`.
 *
 * The CJS side imports the compiled build of THIS function rather than keeping
 * its own copy -- see `scripts/lib/source-corroboration.cjs`.
 */
export function normalizeCatalogSource(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s || s === "undefined" || s === "null") return "";
  const strip = (x: string) => x.replace(/-(graded|attested|unnumbered|scraped)$/, "");
  for (;;) { const next = strip(s); if (next === s) break; s = next; }
  s = s.replace(/-\d{4}-\d{2}-\d{2}(t[\d:.+-]*)?$/, "").replace(/-\d{8}$/, "");
  for (;;) { const next = strip(s); if (next === s) break; s = next; }
  return s;
}

/**
 * Does this source's word need a second source behind it?
 *
 * True for hobbymonitor and its dated / graded spellings; false for every other
 * source, including the ones that are not checklists at all -- a vendor row is
 * refused by `catalogAuthorityOf` long before this question is reached, and
 * answering "yes, it needs corroboration" for it would read as though
 * corroboration could rescue it.
 */
export function requiresCorroboration(source: string | null | undefined): boolean {
  const s = normalizeCatalogSource(source);
  if (!s) return false;
  return CORROBORATION_REQUIRED_SOURCES.some((n) => s === n || s.startsWith(`${n}-`));
}

/** The minimum a row must expose for the corroboration read to judge it. */
export interface CorroborationRow {
  id?: string | null;
  source?: string | null;
  /** The graded tier, when this row is a graded child. Such a row is minted
   *  from its parent and is never a second source. */
  gradeTier?: string | null;
  playerName?: string | null;
  /** Read only as a FALLBACK when the id is not a 7-segment identity slug. */
  sport?: string | null;
  cardYear?: number | string | null;
  year?: number | string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  parallelSlug?: string | null;
  isAuto?: boolean | null;
}

/**
 * The identity cell a row occupies: `sport|year|setKey|cardNumber|parallel|auto`.
 *
 * Read off the SLUG when the row has one -- `hiq:sport:year:setKey:number:
 * parallel:auto[:extras]` -- and off the fields only when it does not. The
 * trailing segments (a stated print run, `num-25`) are DROPPED: a source that
 * states a print run and one that does not are describing the same card, and
 * keeping the segment would make two spellings of one card look like two cards
 * and refuse a corroboration that exists.
 *
 * `cardYear` is preferred over `year` in the fallback for #1769's reason, and
 * both lose to the slug.
 */
export function identityCellOf(row: CorroborationRow | null | undefined): string | null {
  if (!row) return null;
  const id = String(row.id ?? "").trim();
  if (id.startsWith("hiq:")) {
    const p = id.split(":");
    // hiq : sport : year : setKey : number : parallel : auto  -> 7 segments
    if (p.length >= 7) return p.slice(1, 7).join("|").toLowerCase();
  }
  const sport = String(row.sport ?? "").trim().toLowerCase();
  const year = String(row.cardYear ?? row.year ?? "").trim();
  const setKey = String(row.setKey ?? "").trim().toLowerCase();
  const num = String(row.cardNumber ?? "").trim().toLowerCase();
  const par = String(row.parallelSlug ?? "").trim().toLowerCase() || "base";
  const auto = row.isAuto === true ? "auto" : "no-auto";
  if (!sport || !year || !setKey || !num) return null;
  return [sport, year, setKey, num, par, auto].join("|");
}

/** A player name reduced to the letters and digits that identify it, so
 *  "T.J. Hockenson" and "TJ Hockenson" are one person and a punctuation
 *  difference is never a disagreement. */
function playerKey(row: CorroborationRow | null | undefined): string {
  return String(row?.playerName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * May `candidate` serve as the SECOND source behind a row that needs one?
 *
 * A rival must be a checklist by `catalogAuthorityOf`, must not itself require
 * corroboration (two hobbymonitor rows are one source twice, not two sources),
 * and must not be a graded child.
 */
export function isCorroboratingSource(row: CorroborationRow | null | undefined): boolean {
  if (!row) return false;
  if (String(row.gradeTier ?? "").trim()) return false;
  const source = row.source;
  if (requiresCorroboration(source)) return false;
  return catalogAuthorityOf(source) === "checklist";
}

/** Why a corroboration read answered the way it did. The vocabulary is CLOSED
 *  and it is what the census and the retire lane report, so a reader is never
 *  left inferring the reason from a boolean. */
export type CorroborationVerdict =
  /** The source's word stands on its own; no second source was needed. */
  | "not-required"
  /** A second strict source names this identity cell, and the players agree
   *  (or at least one side carries no name). */
  | "corroborated"
  /** No other strict source names this identity cell at all. Overwhelmingly
   *  "we have not acquired that checklist yet" -- an acquisition work item. */
  | "no-second-source"
  /** A second strict source names this cell and names a DIFFERENT PLAYER.
   *  The #1795 shape: 2,571 of 2,811 panini-score twins. */
  | "player-disagrees";

export interface CorroborationResult {
  verdict: CorroborationVerdict;
  /** True iff a price may rest on this row's identity. */
  checklistBacked: boolean;
  /** The cell that was read, for the log line. */
  cell: string | null;
  /** The normalized source of the rival that corroborated, when one did. */
  corroboratedBy?: string;
}

/**
 * THE ONE CORROBORATION READ. Every consumer calls this and none re-decides it.
 *
 * `rivals` is the set of catalog rows the caller already holds for the same
 * identity cell -- from a point read of the slug's neighbours, from a cell
 * index, or from the product scan a census is already doing. The caller does
 * the I/O because the callers differ wildly in what they have already loaded
 * (the rematch holds a whole product; the pricing gate holds one slug), and
 * CF-DO-NOT-LOOK-TWICE says the predicate must not re-fetch what its caller has.
 *
 * A row from a source that does NOT require corroboration returns
 * `not-required` / backed, whatever `rivals` says -- this function is the
 * demotion, not a second opinion on sources that were never demoted.
 */
export function corroborationOf(
  row: CorroborationRow | null | undefined,
  rivals: readonly CorroborationRow[] | null | undefined,
): CorroborationResult {
  const cell = identityCellOf(row);
  if (!requiresCorroboration(row?.source)) {
    return { verdict: "not-required", checklistBacked: catalogAuthorityOf(row?.source) === "checklist", cell };
  }
  const list = (rivals ?? []).filter(isCorroboratingSource);
  const sameCell = cell === null ? [] : list.filter((r) => identityCellOf(r) === cell);
  if (sameCell.length === 0) return { verdict: "no-second-source", checklistBacked: false, cell };
  const mine = playerKey(row);
  // Both sides must carry a name for a name to decide anything.
  const agreeing = sameCell.find((r) => {
    const theirs = playerKey(r);
    return !mine || !theirs || theirs === mine;
  });
  if (!agreeing) return { verdict: "player-disagrees", checklistBacked: false, cell };
  return {
    verdict: "corroborated",
    checklistBacked: true,
    cell,
    corroboratedBy: normalizeCatalogSource(agreeing.source),
  };
}

/**
 * The consumers' shared shorthand: may a price rest on this row's identity?
 *
 * This is `isChecklistBackedIdentity` with the corroboration requirement
 * applied, and it is what identityBacking, the rematch, the driver and the
 * catalog-verify boost all call. Passing no rivals is the conservative read for
 * a caller that could not look -- an uncorroborated hobbymonitor row is not
 * backed, and a caller who did not check is not entitled to assume it is.
 */
export function isChecklistBackedWithCorroboration(
  row: CorroborationRow | null | undefined,
  rivals: readonly CorroborationRow[] | null | undefined,
): boolean {
  return corroborationOf(row, rivals).checklistBacked;
}
