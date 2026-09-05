/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04, in those words).
 *
 * Every card identity the app PRICES or SHOWS must rest on a row transcribed
 * from a real checklist. A row the system minted from its own sales — or from
 * one user's own import — is not an identity; it is an observation wearing
 * one, and letting it be the thing a price rests on is how the catalog comes
 * to confirm itself.
 *
 * ── WHY THIS IS A NEW PREDICATE AND NOT A WIDENED OLD ONE ───────────────────
 *
 * `catalogAuthority.service.ts` already answers three questions, deliberately
 * differently, and its header records what happened the two times someone
 * unified them. This file adds a FOURTH question rather than editing any of
 * them (CF-THE-RECURRING-BUG-SHAPE: right guard, wrong scope):
 *
 *   catalogAuthorityOf     may this row DECIDE a fact?     user-verified -> vendor
 *   isDerived              did WE generate this row?       user-verified -> false
 *   catalogTier            may a USER SEE this row?        user-verified -> verified
 *   isSelfDerivedIdentity  may a PRICE rest on this row?   user-verified -> NO
 *
 * The divergence on `user-verified` is the whole point of the file, and it is
 * Drew's ruling rather than a reclassification of an existing answer. A user
 * confirming their own card is real evidence that THEY own it and excellent
 * evidence for the SALE; it is not a transcription of a printed checklist, so
 * it cannot be the identity a valuation rests on. Measured on the live
 * portfolio (2026-09-04, all 12 users, 131 holdings): the ONLY holdings whose
 * catalog row is self-derived are `user-verified` (11) and
 * `ebay-user-purchase` (7) rows — every single one minted through
 * soldCompsStore's USER_SEED_SOURCES lane. Classifying those as `vendor`, as
 * `catalogAuthorityOf` does, is correct for "may it adjudicate a setKey" and
 * wrong for "may it carry a price", which is why the question needed its own
 * name instead of an edit to that regex.
 *
 * ── THE CLASS IS NAMED BY WHAT MINTED IT, NOT BY WHAT IT SAYS ───────────────
 *
 * `derived-from-base-checklist-2026-08-23` contains the word "checklist" and
 * is synthesised from a base card; `sales-attested` names our own sales.
 * catalogAuthority's DERIVED regex already carries both stems and the reason
 * they were added (a synthetic row was ranking EQUAL to a real transcription),
 * so this file REUSES it rather than restating it — one more copy of that
 * regex is one more place for it to drift.
 *
 * What is added here is the USER-MINTED family, which catalogAuthority sends
 * to `vendor`:
 *
 *   user-verified          a user confirmed a suggestion for their holding
 *   ebay-user-purchase     an identity minted from one person's eBay import
 *   ebay-user-sale         the same, from the sell side
 *   manual-user-entry      typed by hand
 *   holding-seeded-*       seeded from a holding row
 *
 * That list is exactly soldCompsStore's `USER_SEED_SOURCES` plus the
 * `holding-seeded` sweep, because that lane is what writes them.
 *
 * ── ABSENT BEATS WRONG, BUT NEVER DELETE ────────────────────────────────────
 *
 * A self-derived row is frequently the ONLY row a card has — measured over a
 * 2,852-row keyed baseball sample on 2026-09-04, 35.7% of self-derived rows
 * have no checklist row for their card at ANY parallel. Those cards are real:
 * someone sold one. So this module supports a REFUSAL TO PRICE and a
 * RETIREMENT MARKER, and never a delete. `unconfirmed` overwhelmingly means we
 * have not acquired that product's checklist yet (annotate-checklist-backing's
 * header makes the same point at length), which makes the unbacked list an
 * ACQUISITION QUEUE, not a defect list.
 */
import { catalogAuthorityOf, isDerived } from "./catalogAuthority.service.js";
import {
  corroborationOf,
  requiresCorroboration,
  type CorroborationRow,
} from "./sourceCorroboration.js";

/**
 * Identities minted from a USER's own typing or import.
 *
 * `catalogAuthorityOf` calls these `vendor`, which is right for adjudication
 * and wrong for pricing — see the header. Prefix-tested because the sweeps
 * date their sources (`holding-seeded-2026-08-11`), and a Set would silently
 * stop matching on the next sweep exactly as catalogVisibility's stub list
 * would have.
 */
const USER_MINTED = /^(user-verified|ebay-user-purchase|ebay-user-sale|manual-user-entry|holding-seeded)/;

/**
 * True iff a price must NOT rest on this row.
 *
 * The union of catalogAuthority's DERIVED class (our own sales and inference)
 * and the user-minted family.
 *
 * A GRADED TWIN IS ITS PARENT'S PROVENANCE, and it needs no `-graded` strip
 * here to be: both families are PREFIX-anchored, so `user-verified-graded` and
 * `ingest-auto-seed-graded` match on their stems exactly as their parents do
 * (`isDerived` strips the suffix internally in any case). The strip was
 * written in out of symmetry with catalogAuthority and removing it changed no
 * answer — a line that cannot be observed is a line that will later be
 * "cleaned up" by someone who checks, so it is stated as reasoning instead of
 * kept as dead code. The graded cases are pinned in the test either way.
 */
export function isSelfDerivedIdentity(source: string | null | undefined): boolean {
  const s = String(source ?? "").toLowerCase().trim();
  if (!s || s === "undefined" || s === "null") return false;
  return isDerived(s) || USER_MINTED.test(s);
}

/**
 * True iff a price MAY rest on this row's SOURCE STRING alone.
 *
 * Deliberately the `checklist` class and nothing else — not "anything not
 * self-derived". A vendor row (cardhedge's product fields) and an untagged
 * legacy row are both non-checklist, and doctrine is already that a vendor's
 * product classification never names identity. `unknown` is excluded for the
 * same reason absence is not evidence: 133,568 rows carry no source at all,
 * and reading a missing field as a checklist would let the largest untagged
 * block in the catalog price cards on nothing.
 *
 * ── THIS IS NO LONGER THE WHOLE ANSWER ──────────────────────────────────────
 *
 * CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
 * 2026-09-05). Some sources transcribe a real checklist and still get the cards
 * wrong — hobbymonitor's 2025 Panini Score names a different player at the
 * number on 2,571 of 2,811 checkable rows (#1795). Those rows are backed only
 * where a second strict source agrees on the identity cell, and THAT question
 * needs the row and its neighbours, not a string.
 *
 * So this function keeps answering the string question and `identityBackingOf`
 * — which HAS the rows — asks the corroborated one through
 * `sourceCorroboration.corroborationOf`. A caller holding only a source string
 * and no rows cannot answer the demotion, and this function's name says
 * `Identity`, not `Corroborated`, so it is left honest rather than made to
 * guess. Every caller that has rows should call `identityBackingOf`.
 */
export function isChecklistBackedIdentity(source: string | null | undefined): boolean {
  return catalogAuthorityOf(source) === "checklist";
}

/** How a holding's identity stands, once its catalog rows are known. */
export type IdentityBacking =
  /** At least one checklist row carries this identity. Prices normally. */
  | "checklist-backed"
  /** Rows exist, but every one is self-derived. Priced from a row we minted. */
  | "self-derived-only"
  /** Rows exist and are neither — vendor product fields, or untagged. */
  | "unbacked"
  /** The slug names no catalog row at all. */
  | "no-catalog-row"
  /** The holding names no canonical slug. */
  | "no-slug";

/** The minimum a row must expose for `identityBackingOf` to judge it.
 *
 *  Widened to `CorroborationRow` for the demotion: judging a hobbymonitor row
 *  needs its identity cell (from the id, or the fields when there is no id) and
 *  its player name, not only its source. Every field is optional, so a caller
 *  passing `{ source }` as before still type-checks — it simply cannot
 *  corroborate anything, which is the conservative answer and the honest one. */
export type SourcedCatalogRow = CorroborationRow;

/**
 * Classify an identity from the catalog rows found at its slug.
 *
 * ONE checklist row is enough. A card whose identity a checklist confirms does
 * not become doubtful because a stub for the same slug also exists — the stub
 * is the thing being retired, and lane (a) is what removes it. This ordering
 * is what makes the retire lane and the pricing gate agree by construction:
 * retiring a self-derived twin can never change a holding's verdict.
 *
 * ── THE CORROBORATION PASS (Drew, 2026-09-05) ───────────────────────────────
 *
 * A row from a source that requires corroboration counts as checklist-backed
 * only when ANOTHER strict source in `rows` names the same identity cell and
 * agrees on the player. The rivals come from the same list the caller already
 * passed — no second read — so a caller that hands over one slug's rows gets
 * exactly the answer that slug's rows support.
 *
 * A demoted row that nothing corroborates falls to `unbacked` rather than
 * `self-derived-only`: it was NOT minted from our own sales, and the two
 * verdicts are kept distinct precisely because they send a reader to different
 * work — `self-derived-only` means fix a matcher, `unbacked` means acquire a
 * checklist. An uncorroborated hobbymonitor row is the second kind.
 */
export function identityBackingOf(
  slug: string | null | undefined,
  rows: readonly SourcedCatalogRow[] | null | undefined,
): IdentityBacking {
  if (!String(slug ?? "").trim()) return "no-slug";
  const list = rows ?? [];
  if (list.length === 0) return "no-catalog-row";
  // A row whose source needs no second opinion backs the identity on its own.
  if (list.some((r) => !requiresCorroboration(r.source) && isChecklistBackedIdentity(r.source))) {
    return "checklist-backed";
  }
  // Otherwise a demoted row must find its second source among the same rows.
  if (list.some((r) => requiresCorroboration(r.source) && corroborationOf(r, list).checklistBacked)) {
    return "checklist-backed";
  }
  if (list.some((r) => isSelfDerivedIdentity(r.source))) return "self-derived-only";
  return "unbacked";
}

/**
 * May the valuation path publish a number for an identity with this backing?
 *
 * Only `checklist-backed`. The other four are the refusal, and they are kept
 * DISTINCT rather than collapsed to a boolean because the reason is what tells
 * a reader (and the acquisition queue) which of two very different things to
 * do: acquire a checklist, or fix a matcher.
 */
export function mayPublishPrice(backing: IdentityBacking): boolean {
  return backing === "checklist-backed";
}

/** The withheld-reason vocabulary for a refusal on identity grounds. It is
 *  CLOSED, and it is the same string on the holding, the response and the
 *  telemetry — a consumer never infers the reason from prose. */
export const NO_CHECKLIST_MATCH = "no-checklist-match" as const;

/** Marker written by lane (a) onto a self-derived row a checklist twin
 *  replaces. Never a delete: sold_comps rows reference these ids, and a
 *  delete would orphan real sales with no way back (the same reasoning that
 *  made CF-RETIRE-CARDHEDGE-ROWS an exclusion rather than a purge). */
export const RETIRED_SUPERSEDED_BY_CHECKLIST = "superseded-by-checklist" as const;

/** Marker written by lane (b) onto a self-derived row with NO checklist twin.
 *  This is a LABEL and an acquisition work item, never a judgement that the
 *  card is fake. */
export const IDENTITY_UNVERIFIED = "identityUnverified" as const;
