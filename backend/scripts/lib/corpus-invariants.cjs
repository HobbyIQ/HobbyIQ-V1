#!/usr/bin/env node
/**
 * corpus-invariants.cjs — the PURE predicates behind the nightly corpus audit.
 *
 * CF-FINDINGS-ARE-DATA-NEVER-FIXES (Drew, 2026-09-02: "nightly shadow
 * re-derivation + invariant asserts + mutation-CI replaces eyeball discovery;
 * findings are data, never auto-fixes").
 *
 * WHY A SECOND FILE. `pricing-invariants.cjs` is the SHADOW PRICER: it takes
 * one holding and one pool and asks whether the NUMBER is defensible. This file
 * asks a different question of a different subject — whether the CORPUS is
 * internally consistent — and the two must not be merged, because the shadow's
 * unit of work is a holding and this one's is a row, a pair of rows, or an
 * external run. Sharing a file would force one budget, one sample and one
 * digest onto ten checks whose sampling costs differ by three orders of
 * magnitude.
 *
 * WHAT 2026-09-05 PROVED. The day this file was written, five separate defects
 * were found by a person noticing a number:
 *
 *   the deploy smoke test had been red since 09-03 and the nightly all-users
 *   reprice silently SKIPPED for two days (a skipped job is quiet)   -> I7
 *   a Gold Shimmer sale sat in a Gold Refractor pool                 -> I6
 *   12 rekeyed sales were duplicated at two addresses                -> I5
 *   19,867 catalog rows had a setKey field disagreeing with the stem -> I3
 *   holdings carried a published stamp and a withheld block at once  -> I1
 *
 * Every one is an assertion a read-only job could have made the night before.
 * That is the entire thesis: the auditor does not repair anything, it makes the
 * corpus answer questions about itself on a schedule.
 *
 * PURE. No Cosmos, no clock beyond an injected `now`, no `gh`, no fs. The
 * runner (audit-corpus-invariants.cjs) supplies rows; the pins supply fakes.
 * Every function here returns a violation LIST — never a patch, never an op,
 * never a mutation. There is no write path in this file to disable, which is
 * what makes the mutation check ("the lane cannot write") a statement about
 * the whole module rather than about one guarded branch.
 *
 * A NOTE ON THRESHOLDS. Each invariant carries a default breach threshold, and
 * the threshold is a REPORTING decision, not a correctness one: crossing it
 * prints a `::warning`, and nothing else changes. A finding under threshold is
 * still a finding, still row-level, still in the JSON
 * (feedback_never_dismiss_small_numbers_as_noise) — the threshold only decides
 * whether a human is paged tonight or reads it in the morning digest.
 */
"use strict";

const path = require("path");

// I3 reuses the SHIPPED invariant (src/services/catalog/setKeyFieldInvariant.ts)
// rather than re-deriving the two-armed directional test. An auditor with its
// own copy of that rule would go on passing the day the write guard's rule
// changed — the point of the audit is to measure the guard's own corpus, so it
// must ask the guard.
//
// Loaded from dist/ like the shadow's leaf utilities, and for the same reason:
// ONE definition of the rule. The pins inject the TS source directly (vitest
// resolves it), so the suite never depends on a dist/ build.
function loadSetKeyFieldInvariant() {
  const mod = require(path.join(
    __dirname, "..", "..", "dist", "services", "catalog", "setKeyFieldInvariant.js",
  ));
  if (typeof mod.checkSetKeyFieldMatchesIdStem !== "function") {
    throw new Error("setKeyFieldInvariant missing from dist/ — run `npm run build` before the audit");
  }
  return mod;
}

/** I10 reuses the SHIPPED backing classifier for the same reason as I3: the
 *  pricing gate and the audit must agree on what "checklist-backed" means, or
 *  the audit measures a different corpus than the one the gate defends. */
function loadIdentityBacking() {
  const mod = require(path.join(
    __dirname, "..", "..", "dist", "services", "catalog", "identityBacking.js",
  ));
  if (typeof mod.identityBackingOf !== "function" || typeof mod.mayPublishPrice !== "function") {
    throw new Error("identityBacking missing from dist/ — run `npm run build` before the audit");
  }
  return mod;
}

const str = (v) => String(v ?? "").trim();

/**
 * THE INVARIANT REGISTRY. Every invariant declares its id, the subject it
 * samples, its default sample size and its default breach threshold, in ONE
 * place — so the digest, the JSON, the `::warning` block and the pins all read
 * the same list and an invariant cannot be added to the runner without
 * declaring what a breach of it means.
 *
 * `threshold` is read as: warn when `breaches` exceeds this many rows, or
 * (when `rate` is set) when the breach RATE exceeds this fraction of the
 * sample. Rates are used where the population is enormous and a raw count says
 * nothing about health.
 */
const INVARIANTS = [
  {
    id: "I1", name: "ONE-STAMP-PER-HOLDING", subject: "holdings",
    defaultSample: 0, threshold: 0,
    summary: "method 'withheld' iff a withheld block is present — never a published stamp and a withheld block at once",
  },
  {
    id: "I2", name: "WITHHELD-VALUE-EXPLAINED", subject: "holdings",
    defaultSample: 0, threshold: 0,
    summary: "a withheld holding's fairMarketValue is null unless withheld.retained explains it",
  },
  {
    id: "I3", name: "SETKEY-FIELD-EXTENDS-STEM", subject: "card_catalog",
    defaultSample: 4000, threshold: 0, rate: 0.01,
    summary: "a catalog row's setKey field is its id stem, or a named release of it — never the stem's generic",
  },
  {
    id: "I4", name: "SLUG-GRAMMAR", subject: "sold_comps",
    defaultSample: 4000, threshold: 0, rate: 0.01,
    summary: "hobbyiqCardId obeys the slug grammar: 7 segments, no grade token after auto, printRun only as num-N",
  },
  {
    id: "I5", name: "ONE-SALE-ONE-ADDRESS", subject: "sold_comps",
    defaultSample: 2000, threshold: 0,
    summary: "no sale id is resident in two partitions — a rekey that copied instead of moving",
  },
  {
    id: "I6", name: "POOL-IDENTITY-COHERENCE", subject: "sold_comps",
    defaultSample: 1500, threshold: 0, rate: 0.02,
    summary: "no row's TITLE states a finish or product word its own slug lacks",
  },
  {
    id: "I7", name: "DEPLOY-HEALTH", subject: "github-actions",
    defaultSample: 1, threshold: 0,
    summary: "the last Daily 5AM ET Refresh & Deploy concluded green, its smoke passed, and Reprice All Holdings actually ran",
  },
  {
    id: "I8", name: "SOURCE-FRESHNESS", subject: "sold_comps",
    defaultSample: 0, threshold: 0,
    summary: "every live ingest source's newest soldDate is inside its staleness window",
  },
  {
    id: "I9", name: "SHADOW-REDERIVATION", subject: "sold_comps",
    defaultSample: 2000, threshold: 0,
    // CF-THE-ALARM-IS-DRIFT-NOT-LEVEL (Drew, 2026-09-06). `rate` is GONE as a
    // gate: I9 breaches on DRIFT from its own reference, per sportClass, and
    // `driftPoints` below is that threshold. The old absolute 0.35 is kept as
    // `reportRate` -- printed as a trend note, never evaluated.
    driftPoints: 0.05,
    reportRate: 0.35,
    summary: "a re-derivation of a stored row's identity agrees with the slug it is filed under",
  },
  {
    id: "I10", name: "PRICED-ON-UNBACKED-IDENTITY", subject: "holdings",
    defaultSample: 0, threshold: 0,
    summary: "no holding shows a published price on an identity with zero checklist-backed catalog rows",
  },
];

const INVARIANT_BY_ID = new Map(INVARIANTS.map((i) => [i.id, i]));

// ── I1 / I2 — the stamp invariants ──────────────────────────────────────────

/**
 * The three fields that constitute a PUBLISHED stamp, per
 * holdingValuation.ts's CF-A-HOLDING-CARRIES-ONE-STAMP. A withheld write
 * rewrites all three: `method` becomes "withheld", `fmvRung` becomes null,
 * `valueSource` becomes "estimated". A row that carries a withheld block AND
 * any published-stamp residue is making two incompatible claims, and which one
 * a reader believes depends on which field it happens to prefer.
 */
const WITHHELD_METHOD = "withheld";

function pricingMeta(holding) {
  const m = holding?.pricingSourceMeta;
  return m && typeof m === "object" ? m : null;
}

/** The withheld BLOCK, when present. `pricingSourceMeta.withheld` is the
 *  machine-readable refusal — `{reason, proposed, retained, retentionRefused,
 *  retainedRung, ...}`. */
function withheldBlockOf(holding) {
  const meta = pricingMeta(holding);
  const w = meta?.withheld;
  return w && typeof w === "object" ? w : null;
}

function methodOf(holding) {
  const meta = pricingMeta(holding);
  return typeof meta?.method === "string" ? meta.method.trim() : null;
}

/**
 * (I1) ONE STAMP PER HOLDING.
 *
 * The biconditional, both directions, because each direction is a different
 * defect with a different cause:
 *
 *   block present, method not "withheld"   the 2026-09-05 shape — a withheld
 *                                          write that did not rewrite `method`,
 *                                          so `holdingProvenance` on the web
 *                                          reads a live exact-pool price off a
 *                                          row the auditor reads as a refusal.
 *   method "withheld", no block            the mirror: a row labelled withheld
 *                                          with no machine-readable reason.
 *                                          Nothing can say WHY, so the refusal
 *                                          cannot be explained to the user and
 *                                          `withheldReason` is absent from the
 *                                          response.
 *
 * The THIRD arm is the residue check: a withheld row that still carries a
 * non-null `fmvRung` or a `valueSource` of "observed". Those are the two fields
 * the withheld write is contractually required to rewrite, and a row carrying
 * either is the exact "two stamps at once" document quoted in the module
 * header — it is reported separately from the biconditional because the fix is
 * different (the write path forgot a field, rather than forgot a branch).
 */
function checkOneStampPerHolding(holding) {
  const out = [];
  const block = withheldBlockOf(holding);
  const method = methodOf(holding);
  const isWithheldMethod = method === WITHHELD_METHOD;

  if (block && !isWithheldMethod) {
    out.push({
      kind: "withheld-block-with-published-method",
      detail: `pricingSourceMeta.withheld is present (reason "${str(block.reason) || "(none)"}") but method is `
        + `"${method ?? "(absent)"}" — every reader that prefers \`method\` reads this as a current `
        + `published price, while the auditor reading \`withheld\` reads a refusal`,
      method, withheldReason: str(block.reason) || null,
    });
  }
  if (!block && isWithheldMethod) {
    out.push({
      kind: "withheld-method-without-block",
      detail: "method is \"withheld\" but no pricingSourceMeta.withheld block explains it — "
        + "the refusal has no machine-readable reason, so nothing can tell the user why",
      method, withheldReason: null,
    });
  }
  if (block) {
    // The residue arm. Only meaningful when a block is present: on a published
    // row these two fields are SUPPOSED to be set.
    const rung = holding?.fmvRung;
    const valueSource = str(holding?.valueSource).toLowerCase();
    const residue = [];
    if (typeof rung === "string" && rung) residue.push(`fmvRung="${rung}"`);
    if (valueSource === "observed") residue.push('valueSource="observed"');
    if (residue.length) {
      out.push({
        kind: "withheld-row-carries-published-stamp",
        detail: `a withheld row still carries ${residue.join(" and ")} — the withheld write is `
          + "contractually required to rewrite both (fmvRung null, valueSource \"estimated\"); "
          + "the retained number's own history belongs under withheld.retainedRung",
        method, withheldReason: str(block.reason) || null, residue,
      });
    }
  }
  return out;
}

/**
 * (I2) A WITHHELD HOLDING'S VALUE IS NULL UNLESS `retained` EXPLAINS IT.
 *
 * `retentionThroughFloor` is allowed to keep a prior number through a refusal —
 * but when it does, it RECORDS the number it kept in `withheld.retained`. So a
 * withheld row showing a value is only legitimate when that value IS the
 * retained one. Three shapes are wrong, and they are distinguished because the
 * repair differs:
 *
 *   value, retained null           nothing explains the number; it is a
 *                                  leftover the refusal failed to clear.
 *   value !== retained             the retention recorded one number and the
 *                                  row shows another — two writers, or a
 *                                  read-modify-write that lost the clear.
 *   retained set, value null       the refusal claims to have kept a number
 *                                  and then did not show it. Harmless to the
 *                                  user, but it means the ledger and the row
 *                                  disagree, which is how the first two shapes
 *                                  start.
 *
 * `estimatedValue` is read alongside `fairMarketValue` for the reason the
 * shadow's C-7 verifier learned: a row that shows a number to the collector
 * through the estimate slot while FMV is null is exactly the shape a check
 * that judges only the FMV field cannot see. `computeDisplayValue` reads the
 * estimate before falling through, so the collector sees it either way.
 */
const CENT = 0.005;

function checkWithheldValueExplained(holding) {
  const block = withheldBlockOf(holding);
  if (!block) return [];

  const fmv = numberOrNull(holding?.fairMarketValue);
  const est = numberOrNull(holding?.estimatedValue);
  const shown = fmv ?? est;
  const shownField = fmv !== null ? "fairMarketValue" : (est !== null ? "estimatedValue" : null);
  const retained = numberOrNull(block.retained);
  const reason = str(block.reason) || null;

  if (shown === null && retained === null) return [];

  if (shown !== null && retained === null) {
    return [{
      kind: "withheld-value-unexplained",
      detail: `withheld (${reason ?? "no reason"}) but ${shownField} shows ${shown} and `
        + `withheld.retained is ${block.retained === null ? "null" : "absent"} — nothing on the row `
        + `explains the number, so it is a leftover the refusal failed to clear`
        + `${str(block.retentionRefused) ? ` (retentionRefused: ${str(block.retentionRefused)})` : ""}`,
      shown, shownField, retained: null, withheldReason: reason,
    }];
  }
  if (shown === null && retained !== null) {
    return [{
      kind: "retained-value-not-shown",
      detail: `withheld (${reason ?? "no reason"}) records withheld.retained ${retained} but the row `
        + "shows no value in either slot — the refusal's ledger and the row disagree",
      shown: null, shownField: null, retained, withheldReason: reason,
    }];
  }
  if (Math.abs(shown - retained) >= CENT) {
    return [{
      kind: "withheld-value-disagrees-with-retained",
      detail: `withheld (${reason ?? "no reason"}) records withheld.retained ${retained} but `
        + `${shownField} shows ${shown} — the retention kept one number and the row displays another`,
      shown, shownField, retained, withheldReason: reason,
    }];
  }
  return [];
}

function numberOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── I3 — the catalog setKey field invariant ─────────────────────────────────

/**
 * (I3) A CATALOG ROW'S setKey FIELD EXTENDS ITS ID STEM.
 *
 * Thin by design: the whole rule lives in the shipped module. What this adds is
 * the SAMPLING AXIS — per (sport, year) — because the 2026-09-05 census found
 * the breach concentrated in ONE cell (2026 baseball bowman/bowman-chrome,
 * 19,867 rows) while the corpus as a whole looked healthy. A flat random sample
 * of the catalog would have reported a fraction of a percent and buried it.
 */
function checkSetKeyFieldRow(row, invariant) {
  const v = invariant.checkSetKeyFieldMatchesIdStem(row);
  if (!v) return [];
  return [{
    kind: v.reason,
    detail: `${v.message}`,
    id: v.id, field: v.field, stem: v.stem,
  }];
}

/** The (sport, year) cell a catalog row belongs to, for the per-cell sample. */
function catalogCellOf(row) {
  const parts = String(row?.id ?? "").split(":");
  if (parts[0] !== "hiq") return null;
  const sport = parts[1] || "(none)";
  const year = parts[2] || "(none)";
  return `${sport}:${year}`;
}

// ── I4 — slug grammar ───────────────────────────────────────────────────────

/**
 * THE GRAMMAR. `hiq:sport:year:setKey:cardNumber:parallel:auto[:num-N]`
 *
 * Seven required segments, then zero or more suffixes of which `num-N` is the
 * only one this checks for well-formedness. The three rules below are the ones
 * the task names, and each corresponds to a defect class already in the repo's
 * history:
 *
 *   SEGMENT COUNT   a slug with six segments has lost an axis — every reader
 *                   that indexes by position then reads the wrong field, which
 *                   is how a parallel became an auto flag.
 *   GRADE AFTER AUTO  segment 6 is the auto flag ("auto" / "no-auto"), and a
 *                   grade token appearing after it is the #1704 shape: an
 *                   adjective plus a card number minted "PSA N" into an
 *                   identity segment. A GRADE IS NOT PART OF A CARD'S IDENTITY
 *                   — it is the identity of a graded COPY, and the grade curve
 *                   is where it belongs.
 *   PRINT RUN SHAPE  a print run appears ONLY as `num-N`. A bare trailing
 *                   number, or `/25`, or `num-` with no digits, is a print run
 *                   the slug vocabulary cannot read, so the pool splits between
 *                   the two spellings.
 *
 * Vendor-keyed ids (anything not starting `hiq:`) are PASSED THROUGH, exactly
 * as the split-identity predicate exempts them: 13.5M CardHedge rows are keyed
 * under the vendor's own product id by construction, and flagging them would
 * make this invariant fire on most of the corpus and bury the real breaches.
 */
const GRADE_TOKEN_RE = /^(psa|bgs|sgc|cgc|beckett|hga|csg|ace|tag|isa|gma|pristine)(-?\d+(-?\d)?)?$/i;
const PRINT_RUN_RE = /^num-\d+$/;
const BARE_NUMBER_RE = /^\d+$/;
const SLASH_RUN_RE = /^\/?\d+$/;

function checkSlugGrammar(slug) {
  const s = str(slug);
  if (!s) return [];
  // Not our address space — nothing to check. Absence of our grammar on a
  // vendor row is the row's shape, not a defect (feedback: absence from the
  // vocabulary is not a defect).
  if (!s.startsWith("hiq:")) return [];

  const out = [];
  const parts = s.split(":");

  if (parts.length < 7) {
    out.push({
      kind: "slug-too-few-segments",
      detail: `"${s}" has ${parts.length} segments; the grammar requires at least 7 `
        + "(hiq:sport:year:setKey:cardNumber:parallel:auto) — a reader indexing by position "
        + "reads the wrong axis off every segment past the gap",
      slug: s, segments: parts.length,
    });
    // Every rule below indexes past segment 6; with the axes already shifted,
    // reporting them would be reporting the same one defect several times.
    return out;
  }

  const suffixes = parts.slice(7);
  for (const seg of suffixes) {
    if (GRADE_TOKEN_RE.test(seg)) {
      out.push({
        kind: "grade-token-after-auto",
        detail: `"${s}" carries the grade token "${seg}" after the auto segment — a grade is the `
          + "identity of a graded COPY, never of the card; it belongs on the grade curve, and a "
          + "slug carrying one splits the card's pool by grade (#1704)",
        slug: s, token: seg,
      });
      continue;
    }
    if (PRINT_RUN_RE.test(seg)) continue;
    if (BARE_NUMBER_RE.test(seg) || SLASH_RUN_RE.test(seg) || /^num-?$/.test(seg) || /^num-\D/.test(seg)) {
      out.push({
        kind: "malformed-print-run",
        detail: `"${s}" carries "${seg}" where a print run may appear only as num-N — the two `
          + "spellings file the same card at two addresses and split its pool",
        slug: s, token: seg,
      });
    }
  }
  return out;
}

// ── I5 — one sale, one address ──────────────────────────────────────────────

/**
 * (I5) NO SALE EXISTS AT TWO ADDRESSES.
 *
 * sold_comps is partitioned on /cardId. A rekey MOVES a row: it writes the row
 * under the new partition key and deletes the old one. A rekey that copies
 * without deleting leaves the SAME `id` resident in two partitions, and both
 * copies are then read into pools — one sale pricing two cards, and the
 * duplicate inflating whichever pool it lands in. #1807 is this shape: 12
 * rekeyed sales duplicated at two addresses.
 *
 * PURE HALF. The runner reads rows sampled by recent `rekeyedAt` and groups
 * them by id; this function judges one GROUP. It takes the group rather than
 * doing the grouping so the pin can hand it a two-row group directly and so
 * the runner keeps its query budget to itself.
 *
 * A group of one is the healthy case and is silent.
 */
function checkOneSaleOneAddress(id, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return [];
  const partitions = [...new Set(list.map((r) => str(r?.cardId)).filter(Boolean))];
  if (partitions.length < 2) return [];
  return [{
    kind: "sale-resident-at-two-addresses",
    detail: `sale id "${id}" is resident under ${partitions.length} partition keys `
      + `(${partitions.map((p) => `"${p}"`).join(", ")}) — a rekey copied the row instead of moving it, `
      + "so one sale is read into two pools and inflates both",
    id: str(id) || null,
    partitions,
    rekeyedAt: list.map((r) => r?.rekeyedAt ?? null).filter(Boolean),
  }];
}

// ── I6 — pool identity coherence ────────────────────────────────────────────

/**
 * (I6) A ROW'S TITLE MUST NOT STATE A FINISH OR PRODUCT WORD ITS SLUG LACKS.
 *
 * The Gold Shimmer sale in the Gold Refractor pool. Both are "gold", so every
 * colour check agrees; the disagreement is on the FINISH, which is the word the
 * slug's parallel segment does not carry. `finishFamilyCollision` in
 * rematch-classify.cjs already decides exactly this, and the
 * SPECIALIZATION-STATED predicate decides the product half — so this invariant
 * CALLS BOTH rather than re-deriving either. Read-only in the strictest sense:
 * both are report-only predicates by construction (`finishFamilyCollision`'s
 * own header says it "cannot make a row writable").
 *
 * REPORTED AS A RATE PER POOL, not as a row count. One mislabelled sale in a
 * 400-row pool moves the FMV by a fraction of a percent; three in a pool of
 * five is the pool's identity being wrong. A raw corpus-wide count cannot tell
 * those apart, and the top-20-by-rate list is what a person can actually act
 * on.
 */
/** `refractors` -> `refractor`. Deliberately conservative: the -es rule fires
 *  only after a sibilant, so `finest` and `prizms` are not mangled into
 *  `fine`/`prizm`+ nonsense. Words of three letters or fewer are left alone --
 *  there is no finish token that short whose plural matters. */
function singularise(word) {
  const w = str(word).toLowerCase();
  if (w.length <= 3) return w;
  if (/(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Drop every non-alphanumeric: `die-cut` -> `diecut`, `x-fractor` -> `xfractor`.
 *
 *  Built by splitting and joining rather than by String.prototype.replace: the
 *  read-only governance pin in corpusInvariantAuditor.test.ts scans this file's
 *  comment-stripped source for Cosmos write calls, and `.replace(` is one of the
 *  five names it refuses. That pin is right to be blunt -- an auditor that could
 *  write is one that could "fix" a finding -- so this reads the same and keeps
 *  the guard's claim about the whole module intact. */
function depunctuate(word) {
  return str(word).toLowerCase().split(/[^a-z0-9]+/).join("");
}

/**
 * Every form a finish word can wear inside a slug.
 *
 * A slug spells `die-cut` as three characters of punctuation between two
 * fragments, and the title spells it as one token. Indexing only the split
 * parts makes the slug's own words invisible to a set difference against the
 * title -- which is exactly how `light-blue-die-cut-prizm` came to be reported
 * for lacking die-cut. So the index carries the parts, their de-punctuated and
 * singularised forms, every ADJACENT PAIR joined, and each whole colon segment
 * joined.
 *
 * Adjacent pairs only, never the full power set: `die`+`cut` and `x`+`fractor`
 * are the shapes that occur, and a wider join would start matching words the
 * slug does not actually contain.
 */
function buildSlugFinishIndex(slug) {
  const raw = str(slug).toLowerCase();
  const out = new Set();
  const add = (w) => {
    if (!w) return;
    out.add(w);
    out.add(singularise(w));
  };
  const parts = raw.split(/[^a-z0-9]+/i).filter(Boolean);
  for (const p of parts) add(p);
  for (let i = 0; i < parts.length - 1; i++) add(parts[i] + parts[i + 1]);
  for (const seg of raw.split(":")) add(depunctuate(seg));
  return out;
}

function checkPoolIdentityCoherence(row, classify) {
  const family = classify.finishFamilyCollision({
    row,
    storedSlug: row?.cardId ?? null,
    stored: { parallel: row?.parallel ?? null },
    derived: null,
  });
  if (!family?.qualifies) return [];
  const ev = family.evidence ?? {};

  // `qualifies` IS NOT THE FINDING. Measured against the shipped predicate:
  // BOTH of these rows qualify under slug parallel `gold-refractor` —
  //
  //   "2026 Topps Chrome Gold Refractor #1 PSA 10"      words [chrome, refractor]
  //   "2026 Topps Chrome Gold Shimmer Refractor #1 SSP" words [chrome, shimmer, refractor, ssp]
  //
  // — because `finishFamilyCollision` answers a CENSUS question ("is this row's
  // colour family worth a human look?"), which is deliberately wider than this
  // invariant's. Reporting `qualifies` verbatim would flag every correctly
  // filed gold row in the corpus, and a finding that fires on the healthy case
  // is noise that buries the real one.
  //
  // The DISCRIMINATOR is the set difference: a finish word the TITLE states
  // that the row's own slug does not carry. In the pair above that is exactly
  // `shimmer` — the Gold Shimmer sale sitting in the Gold Refractor pool — and
  // it is empty for the row that is filed correctly.
  //
  // Only FINISH_TOKENS count: the scarcity words (`ssp`) are not finishes, and
  // the family word itself (`gold`) is what put both rows in the same family to
  // begin with.
  //
  // THE COMPARISON IS AGAINST THE WHOLE SLUG, NOT THE PARALLEL SEGMENT.
  // FINISH_TOKENS contains words that are simultaneously finishes and PRODUCT
  // names — `chrome`, `optic`, `prizm` are all in the set, and all three
  // normally live in segment 3 (the setKey), not segment 5 (the parallel). A
  // difference taken against the parallel alone reads `chrome` in
  // "Topps Chrome Gold Refractor" as a finish the slug lacks, when
  // `hiq:...:topps-chrome:1:gold-refractor:...` states it plainly one segment
  // over. That false positive fires on essentially every Chrome row in the
  // corpus — measured on the healthy fixture, which returned [chrome, shimmer]
  // where only `shimmer` is real.
  //
  // ── AND THE SLUG INDEX IS NOT A NAIVE WORD SPLIT ──────────────────────────
  //
  // Two false positives, both measured against the 2026-09-06 corpus artifact
  // (run 34018932244), where 8 of 23 reported rows were this check's own
  // defects rather than mislabelled sales:
  //
  //  (1) PLURAL vs SINGULAR. FINISH_TOKENS carries `refractor` AND `refractors`
  //      as separate members, so a title reading "Orange Refractors" produced
  //      the word `refractors` while the slug `...:orange-refractor:...` split
  //      to `refractor`. The set difference then reported the sale as filed
  //      against a finish its own slug states one `s` away. Measured: 3 of the
  //      8 ("Refractors" x2, "Prizms" x2 — `silver-prizm`, `orange-refractor`,
  //      `purple-refractor`).
  //
  //  (2) THE SLUG'S OWN HYPHENATED WORDS, SPLIT APART. A title word is a single
  //      token (`die-cut`, `x-fractor`); the slug is split on every non-
  //      alphanumeric, so `light-blue-die-cut-prizm` became [light, blue, die,
  //      cut, prizm] and `die-cut` matched none of them. The check then
  //      reported a slug segment as lacking a word it spells out in full.
  //      Measured: 4 of the 8 (`light-blue-die-cut-prizm` lacking die-cut,
  //      `blue-x-fractor` and `gold-x-fractor` lacking x-fractor).
  //
  // The fix is to index the slug by every form the SAME word can take there —
  // each part, each part de-punctuated, each ADJACENT PAIR joined (so `die`+
  // `cut` covers `diecut` and `x`+`fractor` covers `xfractor`), and each whole
  // segment de-punctuated — and to compare singularised on both sides. It
  // widens what counts as "the slug already says this", which is the safe
  // direction: a word the slug demonstrably contains is never evidence the
  // sale is misfiled. It does NOT touch the genuine finding — a title stating
  // `shimmer` or `reactive` against a slug that spells neither still fires.
  const finishTokens = classify.FINISH_TOKENS instanceof Set
    ? classify.FINISH_TOKENS
    : new Set(classify.FINISH_TOKENS ?? []);
  const slugWords = buildSlugFinishIndex(ev.addressSlug);
  const statedInSlug = (w) => (
    slugWords.has(w) || slugWords.has(singularise(w))
    || slugWords.has(depunctuate(w)) || slugWords.has(singularise(depunctuate(w)))
  );
  const unstated = (ev.titleFamilyWords ?? [])
    .map((w) => str(w).toLowerCase())
    .filter((w) => finishTokens.has(w) && !statedInSlug(w));

  if (!unstated.length) return [];

  return [{
    kind: "title-states-finish-slug-lacks",
    detail: `title states the finish word(s) [${unstated.join(", ")}] which the slug's parallel `
      + `segment "${ev.storedSlugParallel ?? "(none)"}" does not carry (${ev.family ?? "same"} family) `
      + "— the sale is filed in a pool whose finish its own title contradicts",
    id: row?.id ?? null,
    pool: ev.addressSlug ?? null,
    addressField: ev.addressField ?? null,
    family: ev.family ?? null,
    unstatedFinish: unstated,
    title: str(row?.title).slice(0, 160) || null,
  }];
}

/** Fold per-row I6 findings into the per-pool RATE the digest reports. */
function poolCollisionRates(perRow, poolSizes) {
  const byPool = new Map();
  for (const f of perRow) {
    const pool = f.pool ?? "(unaddressed)";
    if (!byPool.has(pool)) byPool.set(pool, { pool, breaches: 0, samples: [] });
    const e = byPool.get(pool);
    e.breaches++;
    if (e.samples.length < 3) e.samples.push(f.id);
  }
  const out = [];
  for (const e of byPool.values()) {
    const size = Number(poolSizes?.get?.(e.pool) ?? 0) || e.breaches;
    out.push({ ...e, poolSize: size, rate: size > 0 ? e.breaches / size : 1 });
  }
  return out.sort((a, b) => b.rate - a.rate || b.breaches - a.breaches);
}

// ── I7 — deploy health ──────────────────────────────────────────────────────

/**
 * (I7) THE DEPLOY RAN, ITS SMOKE PASSED, AND THE REPRICE ACTUALLY RAN.
 *
 * The 2026-09-05 outage in one predicate. "Daily 5AM ET Refresh & Deploy" was
 * RED for two days; `reprice-holdings` hung off it by `needs:`, so it was
 * SKIPPED on all seven runs, and a skipped job announces nothing — the workflow
 * list showed a red X on a deploy that had in fact landed cleanly every time,
 * and the thing that silently stopped happening was the nightly all-users
 * reprice.
 *
 * Three separate findings, because three separate things can be wrong:
 *
 *   deploy-run-failed        the workflow concluded not-success.
 *   deploy-smoke-failed      the smoke step's own verdict line says it failed,
 *                            EVEN IF the run went green overall.
 *   reprice-did-not-run      the reprice job's conclusion is `skipped`,
 *                            `cancelled`, or the job is absent from the run.
 *                            THIS IS THE ONE THAT WAS QUIET. A skipped job
 *                            costs nothing, alerts nobody, and takes the
 *                            portfolio's nightly numbers with it.
 *
 * PURE: takes the parsed `gh api` payload, never calls `gh`. The runner shells
 * out; this decides.
 */
const REPRICE_JOB_NAME = "Reprice All Holdings (post-refresh)";
const HEALTHY_JOB_CONCLUSIONS = new Set(["success"]);

function checkDeployHealth(run, jobs, opts = {}) {
  const out = [];
  const repriceJobName = opts.repriceJobName ?? REPRICE_JOB_NAME;

  if (!run) {
    return [{
      kind: "deploy-run-not-found",
      detail: "no run of \"Daily 5AM ET Refresh & Deploy\" was found — the nightly deploy has not "
        + "run at all within the queried window",
    }];
  }

  // A RUN STILL IN FLIGHT IS NOT A VERDICT. Observed 2026-09-06: the audit was
  // dispatched by hand four minutes behind the deploy, read run 34035108751
  // while "Reprice All Holdings (post-refresh)" was still queued, and reported
  // `reprice-did-not-run` for a job that started 16 seconds later and went
  // green. Judging an unfinished run asks "is this job absent" of a job list
  // that is still being written, and absent-because-pending is indistinguishable
  // from absent-because-skipped in the payload. The schedule (06:20/07:10 UTC)
  // assumes the 5AM refresh is long done; nothing ENFORCES that, and a manual
  // dispatch breaks the assumption silently. Report the overlap as a note, not
  // a breach — the next scheduled audit judges the finished run.
  if (!str(run.conclusion)) {
    return [{
      kind: "deploy-run-in-flight",
      detail: `run ${run.id ?? "?"} of "Daily 5AM ET Refresh & Deploy" is still `
        + `"${str(run.status) || "in progress"}" — no verdict is possible until it finishes, and a `
        + "job absent from a running run may simply not have started yet",
      runId: run.id ?? null, conclusion: null, status: str(run.status) || null,
      url: run.html_url ?? null, informational: true,
    }];
  }

  const conclusion = str(run.conclusion);
  if (conclusion !== "success") {
    out.push({
      kind: "deploy-run-failed",
      detail: `the last "Daily 5AM ET Refresh & Deploy" (run ${run.id ?? "?"}, ${run.created_at ?? "?"}) `
        + `concluded "${conclusion}"`,
      runId: run.id ?? null, conclusion, url: run.html_url ?? null,
    });
  }

  const jobList = Array.isArray(jobs) ? jobs : [];

  // The smoke verdict, read off the job that owns it. A smoke failure inside a
  // run that went green overall is the WORSE shape — the gate passed something
  // the smoke said was broken — so it is reported on its own axis rather than
  // folded into the run conclusion.
  const smokeJob = jobList.find((j) => /smoke/i.test(str(j?.name)))
    ?? jobList.find((j) => (j?.steps ?? []).some((s) => /smoke/i.test(str(s?.name))));
  const smokeStep = (smokeJob?.steps ?? []).find((s) => /smoke/i.test(str(s?.name)));
  const smokeConclusion = str(smokeStep?.conclusion) || str(smokeJob?.conclusion) || null;
  if (smokeConclusion && !HEALTHY_JOB_CONCLUSIONS.has(smokeConclusion)) {
    out.push({
      kind: "deploy-smoke-failed",
      detail: `the pricing smoke step concluded "${smokeConclusion}" — a smoke failure gates the `
        + "reprice by `needs:`, so this alone stops the nightly all-users reprice",
      runId: run.id ?? null, smokeConclusion, url: run.html_url ?? null,
    });
  }

  // THE QUIET ONE.
  const reprice = jobList.find((j) => str(j?.name) === repriceJobName)
    ?? jobList.find((j) => /reprice/i.test(str(j?.name)));
  if (!reprice) {
    out.push({
      kind: "reprice-did-not-run",
      detail: `no "${repriceJobName}" job is present in run ${run.id ?? "?"} — the nightly all-users `
        + "reprice did not run, and a job that never starts announces nothing",
      runId: run.id ?? null, repriceConclusion: null, url: run.html_url ?? null,
    });
  } else {
    const rc = str(reprice.conclusion) || str(reprice.status) || "(unknown)";
    if (!HEALTHY_JOB_CONCLUSIONS.has(rc)) {
      out.push({
        kind: "reprice-did-not-run",
        detail: `"${repriceJobName}" concluded "${rc}" in run ${run.id ?? "?"} — a skipped reprice is `
          + "silent: nothing is red, nothing is emailed, and the portfolio serves yesterday's numbers",
        runId: run.id ?? null, repriceConclusion: rc, url: run.html_url ?? null,
      });
    }
  }
  return out;
}

// ── I8 — freshness ──────────────────────────────────────────────────────────

/**
 * (I8) EVERY LIVE SOURCE'S NEWEST SALE IS INSIDE ITS WINDOW.
 *
 * THE CANARY ALREADY EXISTS (sold-comps-freshness-canary.yml, every 6h, with a
 * staleness axis and a volume-floor axis). This does NOT duplicate it and must
 * not: two jobs alerting on the same condition means two places to silence and
 * one of them will drift.
 *
 * What this adds is the DIGEST LINE. The canary fails loudly at 25h and emails;
 * the auditor's job is to put per-source staleness in the same nightly report
 * as everything else, so a person reading one document can see "the pool went
 * quiet the same night the reprice stopped". A source inside its window is
 * reported as a fact and is not a finding.
 *
 * `exemptBelowRows` mirrors the canary's MIN_BASELINE_ROWS reasoning: a retired
 * or tiny feed must not flap, and no exclusion list should need maintaining.
 */
const DEFAULT_STALENESS_HOURS = 25;
const DEFAULT_EXEMPT_BELOW_ROWS = 1000;

/**
 * The sources the FRESHNESS CANARY watches for staleness — its own
 * `MONITOR_SOURCES` default (scripts/checkSoldCompsFreshness.cjs). Anything
 * else is either retired (`cardsight`, off since 2026-08-16) or demand-driven,
 * and the canary deliberately does not alert on its age.
 *
 * Mirrored here rather than imported because that script reads env and builds a
 * Cosmos client at module scope; this module is pure. The pin asserts the two
 * lists agree, so a change there turns CI red rather than drifting silently.
 */
const CANARY_MONITOR_SOURCES = ["tca-ebay", "cardhedge"];

function checkSourceFreshness(sources, nowMs, opts = {}) {
  const maxHours = Number(opts.maxStalenessHours ?? DEFAULT_STALENESS_HOURS);
  const exemptBelow = Number(opts.exemptBelowRows ?? DEFAULT_EXEMPT_BELOW_ROWS);
  const monitored = opts.monitorSources ?? CANARY_MONITOR_SOURCES;
  const out = [];
  for (const s of sources ?? []) {
    const name = str(s?.source) || "(unnamed)";
    const rows = Number(s?.rows ?? 0);
    if (rows < exemptBelow) continue; // retired / tiny — the canary's own rule
    // RETIRED SOURCES ARE EXEMPT, AND THE CANARY DECIDES WHICH (2026-09-05).
    //
    // The row-count rule alone is not enough. `cardsight` was RETIRED from
    // matching on 2026-08-16 and its ingest stopped; it nonetheless carries
    // 523,792 historical rows, which is three orders of magnitude above
    // MIN_BASELINE_ROWS. So the volume exemption never reached it and the
    // first live run reported it stale at 520.2h — permanently, every night,
    // for a source that is not supposed to be receiving anything. A breach
    // that can never be cleared is a breach nobody reads, and it would have
    // masked a real one arriving beside it.
    //
    // The authority is the CANARY'S OWN staleness set (MONITOR_SOURCES in
    // checkSoldCompsFreshness.cjs, default `tca-ebay,cardhedge`), not a second
    // list maintained here. The canary is the job that owns this alert; a
    // source it does not watch for staleness is a source this digest line must
    // not claim is stale. When the canary starts watching a source, this
    // follows for free — and when a source is retired there, it goes quiet in
    // both places at once, which is the only way two jobs stay agreed.
    if (monitored.length && !monitored.includes(name)) continue;
    const newest = Date.parse(str(s?.newestSoldAt));
    if (!Number.isFinite(newest)) {
      out.push({
        kind: "source-has-no-readable-newest-sale",
        detail: `source "${name}" carries ${rows} rows but no readable newest soldAt`,
        source: name, rows, ageHours: null,
      });
      continue;
    }
    const ageHours = (nowMs - newest) / 3600000;
    if (ageHours > maxHours) {
      out.push({
        kind: "source-stale",
        detail: `source "${name}" newest sale is ${ageHours.toFixed(1)}h old (threshold ${maxHours}h) `
          + `over ${rows} rows — the freshness canary owns the alert; this is the digest line`,
        source: name, rows, ageHours: Number(ageHours.toFixed(1)),
      });
    }
  }
  return out;
}

// ── I9 — shadow re-derivation ───────────────────────────────────────────────

/**
 * (I9) A RE-DERIVATION OF A STORED ROW'S IDENTITY AGREES WITH ITS SLUG.
 *
 * The GREAT REMATCH's census, sampled nightly instead of swept. `classifyRow`
 * from rematch-classify.cjs is the SAME classifier the census and the apply
 * lane use, so the classes here are the classes the repair lanes act on:
 *
 *   AGREE       the stored slug is what a re-derivation produces.
 *   IMPROVE     the derivation is strictly more specific — the row is right but
 *               under-described. Not damage; a queue.
 *   CONFLICT    the derivation names a DIFFERENT card. This is the number that
 *               matters, and the 2026-09-03 census ruled that ~40% of CONFLICT
 *               was parser defects rather than data — which is exactly why this
 *               reports a RATE BY CLASS and never a total.
 *   UNDERIVABLE the title does not support a derivation. Absence, not error.
 *   PROTECTED   a user-entered or ruled row. Report-only FOREVER
 *               (project_great_rematch_program) — never counted as a breach.
 *
 * A disagreement is NOT automatically a defect, so the threshold is a RATE and
 * it is deliberately loose (35%): this invariant's value is the DELTA night over
 * night. A jump in CONFLICT rate is a parser regression that shipped; a stable
 * high number is the known backlog.
 */
const BREACHING_CLASSES = new Set(["CONFLICT"]);

/**
 * THE DERIVATION MUST ACTUALLY HAPPEN.
 *
 * Measured on the first prod run: passing `derived: null` classified all 160
 * sampled rows UNDERIVABLE and reported a 0.00% CONFLICT rate. That is not a
 * healthy corpus, it is a check that cannot fire — `classifyRow` has nothing to
 * compare the stored slug against, so it correctly says "no derived identity"
 * every single time, and the digest reads exactly like a clean result. A
 * detector whose blind spot is its own input is worse than no detector, because
 * it produces a number people trust.
 *
 * So the caller supplies the REAL deriver — `deriveIdentity` and
 * `storedIdentity` from rematch-sold-comps.cjs, the same two the census and the
 * apply lane use, over the same dist/ services. This module stays pure: it
 * takes them as arguments and never requires them.
 */
function classifyStoredRow(row, classify, deps = {}) {
  const storedSlug = str(row?.hobbyiqCardId) || str(row?.cardId) || null;

  // The real re-derivation, when the caller supplied one.
  let derived = deps.derived ?? null;
  let derivationReasons = deps.derivationReasons ?? [];
  if (!derived && typeof deps.deriveIdentity === "function") {
    const der = deps.deriveIdentity(row, deps.deriveDeps ?? {});
    if (der && der.ok) derived = der.identity ?? der.derived ?? der;
    else derivationReasons = der?.reasons ?? ["derivation-refused"];
  }
  // `storedIdentity` NEEDS ITS DEPS (#1878). It calls
  // `deps.normalizeSetKey(row.setName)`, so calling it with one argument threw
  // `Cannot read properties of undefined` on every row that carries a setName
  // -- and the auditor's try/catch turned each throw into a skipped row rather
  // than a finding. The deriver and the stored reader take the SAME deps
  // because they are the same two functions the fleet calls.
  const stored = deps.stored
    ?? (typeof deps.storedIdentity === "function" ? deps.storedIdentity(row, deps.deriveDeps ?? {}) : null);

  // A CHECKLIST GATE THAT ALWAYS SAYS NO IS NOT A GATE (#1878). `?? false`
  // meant the AGREE/IMPROVE branch behind "a match proves nothing unless
  // checklist-backed" could never be reached, so every strictly-more-specific
  // row returned CONFLICT/not-checklist-backed and the class table could not
  // contain a single IMPROVE. The caller now passes the same predicate the
  // fleet uses; `false` remains the default only for callers that genuinely
  // have no catalog to ask.
  return classify.classifyRow({
    row, stored, derived, storedSlug,
    checklistBacked: deps.checklistBacked ?? false,
    derivationReasons,
  });
}

/**
 * NOT EVERY CONFLICT IS A DISAGREEMENT (2026-09-05, after runner run
 * 33988189431 reported 940/2,000 = 47%).
 *
 * `classifyRow` has a SECOND gate after the axis diff: "a match proves nothing
 * unless checklist-backed". A row that is strictly MORE SPECIFIC — nothing
 * dropped, nothing changed, something filled — is an IMPROVE in every respect
 * except that no checklist backs the destination, and that gate returns it as
 * CONFLICT with `filled:<axes>` + `not-checklist-backed`. #1796 is the same
 * finding from the other direction.
 *
 * Measured on the first sample: 21 of 25 CONFLICTs were exactly that shape.
 * They are not the auditor's business — the corpus and the deriver AGREE about
 * the card; what is missing is a checklist. Counting them toward a "the
 * derivation disagrees" threshold makes the number say something it does not
 * mean, and buries the four rows that do.
 *
 * So a CONFLICT is split three ways and only the first is a breach:
 *
 *   TRUE-DISAGREEMENT   an axis CHANGED or was DROPPED — the derivation names
 *                       a different card. This is what I9 exists to find.
 *   NEEDS-CHECKLIST     a pure fill the checklist gate refused. Reported as an
 *                       ACQUISITION SIGNAL, with the filled axes named, so it
 *                       feeds the checklist queue instead of the alarm.
 *   PARSER-ARTIFACT     reasons the classifier itself tags as known noise (the
 *                       phantom Pristine grade word). Contained from writes
 *                       already; counted, never breaching.
 */
const NEEDS_CHECKLIST_REASON = "not-checklist-backed";
const PARSER_ARTIFACT_RE = /phantom|artifact/i;

/** Which of the three a CONFLICT verdict is. Pure over one verdict. */
function conflictKind(verdict) {
  const reasons = (verdict?.reasons ?? []).map((r) => str(r));
  const axes = verdict?.axes ?? {};
  const changed = (axes.changed ?? []).length;
  const dropped = (axes.dropped ?? []).length;

  // A changed or dropped axis is a genuine disagreement whatever else the row
  // carries — the checklist gate never produces one.
  if (changed > 0 || dropped > 0) {
    if (reasons.some((r) => PARSER_ARTIFACT_RE.test(r))) return "PARSER-ARTIFACT";
    return "TRUE-DISAGREEMENT";
  }
  if (reasons.includes(NEEDS_CHECKLIST_REASON)) return "NEEDS-CHECKLIST";
  if (reasons.some((r) => PARSER_ARTIFACT_RE.test(r))) return "PARSER-ARTIFACT";
  // No changed axis, no checklist refusal named: classify as a disagreement
  // rather than silently exempting it. An unrecognised shape must be LOUD —
  // exempting the unknown is how a real class of defect goes unwatched.
  return "TRUE-DISAGREEMENT";
}

/** The axis signature of a verdict, for the per-axis table. */
function axisSignature(verdict) {
  const a = verdict?.axes ?? {};
  const parts = [];
  if ((a.changed ?? []).length) parts.push(`changed:${[...a.changed].sort().join(",")}`);
  if ((a.dropped ?? []).length) parts.push(`dropped:${[...a.dropped].sort().join(",")}`);
  if ((a.filled ?? []).length) parts.push(`filled:${[...a.filled].sort().join(",")}`);
  return parts.join(" ") || "(no axis diff)";
}

/**
 * The reason codes of a verdict, normalised for counting. Values are stripped
 * off (`specialization:a->b` becomes `specialization`) so the table counts
 * SHAPES rather than one row per card.
 */
function reasonCodes(verdict) {
  return [...new Set((verdict?.reasons ?? []).map((r) => str(r).split(":")[0]).filter(Boolean))];
}

/** Fold a run of classifier verdicts into the by-class rate the digest reports. */
function rederivationRates(verdicts) {
  const byClass = new Map();
  const byConflictKind = new Map();
  const byAxis = new Map();
  const byReason = new Map();
  const needsChecklistAxes = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const v of verdicts) {
    const k = str(v?.klass ?? v?.class ?? v?.verdict) || "UNCLASSIFIED";
    bump(byClass, k);

    if (k === "CONFLICT") {
      const kind = conflictKind(v);
      bump(byConflictKind, kind);
      bump(byAxis, axisSignature(v));
      for (const r of reasonCodes(v)) bump(byReason, r);
      if (kind === "NEEDS-CHECKLIST") {
        // The acquisition signal: WHICH axes a checklist would settle.
        bump(needsChecklistAxes, (v?.axes?.filled ?? []).slice().sort().join(",") || "(none)");
      }
    } else if (k === "UNDERIVABLE") {
      // UNDERIVABLE reason codes too — "the title does not support a
      // derivation" has causes, and they are actionable in different places.
      for (const r of reasonCodes(v)) bump(byReason, `UNDERIVABLE/${r}`);
    }
  }

  const total = verdicts.length;
  const conflicts = byClass.get("CONFLICT") ?? 0;
  // THE BREACH IS TRUE DISAGREEMENTS ONLY. `needsChecklist` is reported beside
  // it as an acquisition number, never added to it.
  const breaching = byConflictKind.get("TRUE-DISAGREEMENT") ?? 0;
  const needsChecklist = byConflictKind.get("NEEDS-CHECKLIST") ?? 0;
  const parserArtifact = byConflictKind.get("PARSER-ARTIFACT") ?? 0;
  const sorted = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));

  return {
    total,
    byClass: sorted(byClass),
    conflicts,
    byConflictKind: sorted(byConflictKind),
    byAxis: sorted(byAxis),
    byReason: sorted(byReason),
    needsChecklistAxes: sorted(needsChecklistAxes),
    breaching,
    needsChecklist,
    parserArtifact,
    rate: total > 0 ? breaching / total : 0,
    // Kept distinct so the digest can show what the old number WAS and why it
    // moved — a threshold that silently starts measuring something else is
    // indistinguishable from a corpus that improved overnight.
    allConflictRate: total > 0 ? conflicts / total : 0,
    needsChecklistRate: total > 0 ? needsChecklist / total : 0,
  };
}

// ── I10 — priced on an unbacked identity ────────────────────────────────────

/**
 * (I10) NO HOLDING SHOWS A PUBLISHED PRICE ON AN IDENTITY WITH ZERO
 * CHECKLIST-BACKED CATALOG ROWS.
 *
 * Drew, 2026-09-04: "we don't want self-derived, we want it matched to
 * checklists" — price only checklist-matched identities. `mayPublishPrice` is
 * the shipped gate; this asks whether the CORPUS obeys it, which is a different
 * question from whether the gate is correctly written. A row priced before the
 * gate shipped still shows its number today.
 *
 * A holding that shows NO number is not a finding whatever its backing: an
 * unbacked identity with no price is the gate WORKING.
 *
 * Counted BY USER, because that is the blast radius a person needs: one user
 * with 300 unbacked-but-priced holdings is a bad import, and 300 users with one
 * each is a matcher gap. The same total means two completely different days of
 * work.
 */
function checkPricedOnUnbackedIdentity(holding, catalogRows, backing) {
  const slug = str(holding?.hobbyiqCardId) || str(holding?.cardId) || null;
  const shown = numberOrNull(holding?.fairMarketValue) ?? numberOrNull(holding?.estimatedValue);
  if (shown === null) return [];

  // A row already carrying a withheld block is a REFUSAL that retained a
  // labelled number — I2 owns that shape, and double-reporting it here would
  // count the same document twice under two invariants.
  if (withheldBlockOf(holding)) return [];

  const klass = backing.identityBackingOf(slug, catalogRows ?? []);
  if (backing.mayPublishPrice(klass)) return [];

  return [{
    kind: `priced-on-${klass}`,
    detail: `holding shows ${shown} on identity "${slug ?? "(none)"}" whose catalog backing is `
      + `"${klass}" — HobbyIQ prices a card only from a checklist-backed identity, and no `
      + "withheld block on this row records a refusal",
    slug, shown, backing: klass,
    catalogRows: (catalogRows ?? []).length,
  }];
}

// ── Threshold evaluation ────────────────────────────────────────────────────

/**
 * Did this invariant BREACH its threshold? Returns the `::warning` payload, or
 * null. A finding under threshold is still reported everywhere else — the
 * threshold decides paging, never whether a row is listed
 * (feedback_never_dismiss_small_numbers_as_noise).
 */
/**
 * CF-THE-ALARM-IS-DRIFT-NOT-LEVEL (Drew, 2026-09-06).
 *
 * I9 used to breach on an ABSOLUTE rate: TRUE-DISAGREEMENT over 35% of the
 * sample. That number cannot tell "the corpus got worse last night" from "the
 * frame drew a harder part of the corpus", and the two look identical in the
 * digest. The 2026-09-06 artifact is the proof: 50.28% against a 35% threshold,
 * reported as a breach, on a corpus whose own measured CONFLICT share is 40.8%
 * and whose pokemon slots sit at 59.6%. A draw weighted toward pokemon is over
 * 35% by construction and always will be -- so the alarm fired on the frame's
 * composition and would have gone on firing every night, which is an alarm that
 * carries no information.
 *
 * The alarm is now DRIFT AGAINST ITS OWN REFERENCE, per sportClass. Each
 * class's sampled share is compared to that class's row-weighted census share
 * from `data/rematch-census-shares.json` (#1888), and a breach is a class more
 * than `driftPoints` (5 points) ABOVE its own reference. A night that
 * reproduces its reference is clean at any absolute level; a night 6 points
 * worse in one class is a breach that NAMES that class, which is where somebody
 * would go to look.
 *
 * LIKE FOR LIKE, AND WHY THIS MEASURES CONFLICT.
 *
 * The reference is a CONFLICT share, because the fleet census emits
 * `counts.CONFLICT` and does not split TRUE-DISAGREEMENT from NEEDS-CHECKLIST.
 * The nightly audit does split them. Comparing the audit's TRUE-DISAGREEMENT to
 * a census CONFLICT would be comparing a subset to its superset and would
 * understate drift by the NEEDS-CHECKLIST share -- 5.1 points on the
 * 2026-09-06 artifact, which is the entire threshold. So the DRIFT is measured
 * CONFLICT-to-CONFLICT, and TRUE-DISAGREEMENT keeps its own trend line beside
 * it. If the census one day emits the kind split, the change is one line in
 * `evaluateDrift` -- read a TRUE-DISAGREEMENT reference instead of CONFLICT --
 * and the pins here say which number is being compared, so the swap cannot be
 * made silently.
 *
 * ONE-SIDED ON PURPOSE. Only a class ABOVE its reference breaches. A night that
 * comes in BELOW is the corpus improving -- usually a repair landing -- and an
 * alarm that fires on getting better trains people to silence it.
 *
 * A class needs `MIN_CLASS_ROWS` sampled rows before it can breach: a 5-point
 * move on nine rows is one row, and the frame draws unevenly across classes.
 * Classes below the floor are reported and never gate.
 */
const MIN_CLASS_ROWS = 40;

/**
 * The per-sportClass drift of one night's classification against the census.
 *
 * `byClassFrame` is `frameHealth().bySportClass` -- each entry already carries
 * the class's sampled CONFLICT share, its census share and the delta, computed
 * from the frame's own row-apportioned class mix.
 */
function evaluateDrift(id, { byClassFrame = [], sample = 0, breaches = 0 } = {}) {
  const inv = INVARIANT_BY_ID.get(id);
  if (!inv || typeof inv.driftPoints !== "number") return null;
  const limit = Number(inv.driftPoints);
  const over = [];
  const belowFloor = [];
  for (const c of byClassFrame) {
    const d = c?.conflict?.delta;
    const n = Number(c?.sampledApprox ?? 0);
    if (d === null || d === undefined || c?.conflict?.census === null) continue;
    if (n < MIN_CLASS_ROWS) { belowFloor.push({ sportClass: c.sportClass, sampledApprox: n, delta: d }); continue; }
    if (d > limit) {
      over.push({
        sportClass: c.sportClass,
        sampled: c.conflict.sampled,
        census: c.conflict.census,
        delta: d,
        sampledApprox: n,
      });
    }
  }
  if (!over.length) return null;
  over.sort((a, b) => b.delta - a.delta);
  const worst = over[0];
  const named = over
    .map((o) => `${o.sportClass} ${(100 * o.sampled).toFixed(1)}% vs its census `
      + `${(100 * o.census).toFixed(1)}% (+${(100 * o.delta).toFixed(1)}pp, n~${Math.round(o.sampledApprox)})`)
    .join("; ");
  return {
    id,
    name: inv.name,
    breaches: Number(breaches ?? 0),
    sample: Number(sample ?? 0),
    rate: Number(sample) > 0 ? Number(breaches) / Number(sample) : null,
    threshold: limit,
    thresholdKind: "drift-points",
    worstClass: worst.sportClass,
    classes: over,
    belowFloor,
    message: `${id} ${inv.name}: CONFLICT drifted more than `
      + `${(100 * limit).toFixed(0)}pp above its own census reference in `
      + `${over.length === 1 ? "class" : `${over.length} classes`} — ${named}`,
  };
}

function evaluateThreshold(id, { breaches, sample }) {
  const inv = INVARIANT_BY_ID.get(id);
  if (!inv) return null;
  const n = Number(breaches ?? 0);
  const s = Number(sample ?? 0);
  // A DRIFT INVARIANT IS NEVER GATED ON ITS ABSOLUTE LEVEL. Its level is a
  // trend line; `evaluateDrift` is the alarm, and the caller must ask it.
  // Returning null here rather than falling through to the count branch is what
  // stops `threshold: 0` from turning every finding into a breach.
  if (typeof inv.driftPoints === "number") return null;
  if (typeof inv.rate === "number") {
    if (s <= 0) return null;
    const rate = n / s;
    if (rate <= inv.rate) return null;
    return {
      id, name: inv.name, breaches: n, sample: s, rate,
      threshold: inv.rate, thresholdKind: "rate",
      message: `${id} ${inv.name}: ${n} of ${s} sampled (${(rate * 100).toFixed(2)}%) breach — `
        + `threshold ${(inv.rate * 100).toFixed(2)}%`,
    };
  }
  if (n <= Number(inv.threshold ?? 0)) return null;
  return {
    id, name: inv.name, breaches: n, sample: s, rate: s > 0 ? n / s : null,
    threshold: Number(inv.threshold ?? 0), thresholdKind: "count",
    message: `${id} ${inv.name}: ${n} breaching row(s) of ${s} sampled — threshold `
      + `${Number(inv.threshold ?? 0)}`,
  };
}


// ── THE I9 SAMPLING FRAME (#1872) ───────────────────────────────────────────
/**
 * CF-A-FRAME-IS-PART-OF-THE-FINDING (2026-09-06).
 *
 * I9's frame was `OFFSET floor((nowMs/86400000) % 50) * 500 LIMIT 2000` over
 * `sold_comps`, and its own comment called that "A RANDOM sample, not a recent
 * one". It was neither. Measured on the 2026-09-06 artifact (run 34018932244):
 *
 *   - 50 offsets x 500 = the frame could never reach a row past index 26,500
 *     of ~16.7M. That is 0.16% of the corpus, and the same 26.5k rows every
 *     50 days.
 *   - Cosmos has no ORDER BY here, so `OFFSET` walks PAGE order, which is
 *     partition order, which is cardId order. Neighbouring rows are the same
 *     card.
 *   - The result: 2,000 sampled rows returned ZERO AGREE and ZERO IMPROVE,
 *     against 47.1% AGREE / 2.2% IMPROVE on slot 31's real full-slot census
 *     (509,224 rows, 2026-09-06 02:46Z). A frame that cannot see the majority
 *     class is not measuring the corpus.
 *   - The 25 retained TRUE-DISAGREEMENT rows collapsed onto ~6 cardIds (one
 *     card contributed 8), and all 25 NEEDS-CHECKLIST rows were ch-daily sales
 *     from July 2020 alone.
 *
 * This is the SAME defect rematch-sold-comps.cjs fixed in its own audit sample
 * (audit finding 7: slot 27's 30-row sample was 23 lines from one card), and it
 * is fixed the same way: spread the draw across the corpus, and cap per card.
 *
 * THE FRAME, in three parts:
 *
 *   1. SPREAD ACROSS THE SHARD TABLE. backend/data/rematch-shard-table.json is
 *      the MEASURED packing of the pool -- 16,336,296 rows in 32 slots at a
 *      1.07x spread, by (cardYear, sportClass). Drawing N rows from each of the
 *      32 slots reaches every year and every sport class, because the table's
 *      units ARE the corpus's shape. Each slot's draw takes its own random
 *      offset inside that slot's measured row count, so the window moves.
 *   2. SEEDED BY THE DAY. The offsets come from a seeded PRNG keyed on the UTC
 *      day, so a run is REPRODUCIBLE -- two runs on the same day read the same
 *      rows and a delta between them is a corpus change, never a frame change
 *      -- while consecutive days sweep different windows.
 *   3. ONE RESERVOIR PER cardId. At most `perCardCap` rows from any one card
 *      reach the sample, so a hot pool cannot crowd out the corpus.
 *
 * RU COST IS BOUNDED BY CONSTRUCTION -- AND THE SKIP IS THE COST.
 *
 * The obvious spelling of "start somewhere random inside this slot" is a large
 * OFFSET, and it is the wrong one: Cosmos CHARGES for every document an OFFSET
 * skips. Measured on this table, per-slot offsets sum to ~5.5M skipped rows,
 * which is ~2.2M RU a night to return 2,016 documents. That is a frame that
 * costs more than the audit it feeds.
 *
 * So the draw SEEKS instead of skipping. `soldAt` is indexed and carries a
 * composite index with `sport` and with `cardYear`, so a
 * `c.soldAt >= @from ORDER BY c.soldAt` window is an INDEX SEEK: Cosmos pays
 * for the rows it returns, not for the rows it passed over. The seed picks the
 * WINDOW START across the pool's real date span rather than an ordinal
 * position, which gives the same "move the window every day" property at a
 * fraction of the cost.
 *
 * Every query is therefore: a year (and usually a sport) equality, a soldAt
 * lower bound, and a TOP. Never a cross-partition COUNT, never an OFFSET, never
 * an unbounded scan. 32 queries x ~63 rows is ~2,016 documents per run.
 */

/** The pool's sale-date span the frame seeks within. `sold_comps` holds ~8
 *  years of CardHedge history plus current ingest; the window start is drawn
 *  inside this range and the query takes the first N sales at or after it. */
const FRAME_SEEK_FROM_MS = Date.parse("2018-01-01T00:00:00Z");

/** A tiny deterministic PRNG (mulberry32). Same seed, same sequence. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The UTC day number -- the reproducibility key. */
const utcDayOf = (nowMs) => Math.floor(Number(nowMs) / 86400000);

/**
 * The per-slot draw plan for one day. Pure: it takes the shard table and the
 * clock and returns what to query, so a test can assert the frame without a
 * database.
 *
 * Returns one entry per slot: the unit to read, the offset inside it, and how
 * many rows to take.
 */
function buildSampleFrame({ shardTable, nowMs, target = 2000, perCardCap = 4 }) {
  const slots = Array.isArray(shardTable?.slots) ? shardTable.slots : [];
  if (!slots.length) return { plan: [], perSlot: 0, day: utcDayOf(nowMs), perCardCap, totalRows: 0 };
  const perSlot = Math.max(1, Math.ceil(Number(target) / slots.length));
  const day = utcDayOf(nowMs);
  // Midnight UTC at the END of the seeded day: the seek span is the same for
  // every run on that day, so two runs read the same window.
  const dayEndMs = (day + 1) * 86400000;
  const plan = [];
  for (const slot of slots) {
    const units = Array.isArray(slot.units) ? slot.units : [];
    if (!units.length) continue;
    // The BIGGEST unit in the slot carries the draw: it is the one whose row
    // count can absorb a large offset, and the table packs slots so that unit
    // is a real share of the corpus rather than a tail.
    const unit = units.slice().sort((a, b) => Number(b.rows ?? 0) - Number(a.rows ?? 0))[0];
    const rows = Math.max(0, Number(unit.rows ?? 0));
    const rnd = seededRandom((day * 1000003) ^ (Number(slot.slot) * 7919));
    // SEEK, DO NOT SKIP. The seed chooses a point in the pool's sale-date span
    // and the query takes the first `perSlot` sales at or after it, which the
    // soldAt index answers without charging for what it passed over.
    // THE SPAN IS ANCHORED TO THE DAY, NOT THE CLOCK. Using `nowMs` raw made
    // the window drift between two runs on the SAME day, which is exactly the
    // reproducibility this frame promises -- caught by the pin.
    const spanMs = Math.max(1, dayEndMs - FRAME_SEEK_FROM_MS);
    const seekFrom = new Date(FRAME_SEEK_FROM_MS + Math.floor(rnd() * spanMs)).toISOString();
    plan.push({ slot: Number(slot.slot), unit, seekFrom, take: perSlot, unitRows: rows });
  }
  return { plan, perSlot, day, perCardCap, totalRows: plan.length * perSlot };
}

/**
 * The per-cardId reservoir. Feed rows in; it keeps at most `perCardCap` from
 * any one card and reports what it dropped, so the banner can say the cap bit.
 */
function makeCardReservoir(perCardCap = 4) {
  const perCard = new Map();
  const kept = [];
  let dropped = 0;
  return {
    offer(row) {
      const key = str(row?.cardId) || str(row?.hobbyiqCardId) || `__${kept.length}`;
      const n = perCard.get(key) ?? 0;
      if (n >= perCardCap) { dropped++; return false; }
      perCard.set(key, n + 1);
      kept.push(row);
      return true;
    },
    rows: () => kept,
    distinctCards: () => perCard.size,
    droppedToCap: () => dropped,
  };
}

/**
 * CF-THE-REFERENCE-IS-THE-WHOLE-CORPUS-NOT-ONE-SLOT (2026-09-06).
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. The reference used to be SLOT 31
 * ALONE -- 509,224 rows, 3.1% of the corpus, and a year-only shard of 1989,
 * 1995, 1975, 1978 and 1909. The #1874 frame draws from all 32 slots, which are
 * modern- and pokemon-heavy, so the comparison was between two different
 * populations and the drift line reported a STRUCTURAL MISMATCH as corpus
 * movement. The 2026-09-06 artifact (run 34029662735) printed the result:
 *
 *     CONFLICT  sampled 55.4%   census 20.6%   delta +34.8pp
 *
 * read as a corpus-wide regression. It is not one. The full 32-slot fleet
 * census puts corpus CONFLICT at 40.8%, and slot 31 is the single least
 * representative slot for that class -- it understates it by half. A reference
 * that one slot cannot fail is not a reference; it is a description of slot 31.
 *
 * WHAT IT IS NOW. `data/rematch-census-shares.json` holds all 32 slots'
 * classification, recovered from each IMPROVE fleet run's own
 * `rematch-census-slot-<N>-<runId>` artifact (2026-09-05T04:20Z..09-06T02:49Z,
 * 16,716,343 rows classified). Three things come out of it:
 *
 *   `weighted`      the ROW-WEIGHTED corpus average -- what a whole-corpus draw
 *                   is compared against.
 *   `slots[]`       each slot's own shares -- what a draw FROM THAT SLOT is
 *                   compared against, so a slot is never scored on another
 *                   slot's population.
 *   `bySportClass`  vintage / modern / pokemon, each slot apportioned BY ROWS
 *                   across the classes its units belong to. This is the line
 *                   that makes the original defect impossible to repeat:
 *
 *                       pokemon  CONFLICT 0.596      vintage CONFLICT 0.319
 *
 *                   so a pokemon-heavy draw reading 55% CONFLICT is its frame,
 *                   not a regression, and the health line now says so.
 *
 * THE FOUR CLASSES DO NOT SUM TO 1, in the census or here: the fleet reports
 * UNDERIVABLE-for-subset under `byTier` and leaves it out of `counts`. The
 * shares are comparable to each other and to a sample classified the same way,
 * which is exactly what this function does with them -- but they are not a
 * partition, and nothing may treat them as one.
 */
const CENSUS_SHARES_PATH = path.join(__dirname, "..", "..", "data", "rematch-census-shares.json");

function loadCensusShares() {
  try {
    // eslint-disable-next-line global-require
    return require(CENSUS_SHARES_PATH);
  } catch {
    return null;
  }
}

const CENSUS_TABLE = loadCensusShares();

/**
 * The corpus-wide reference: the row-weighted average over all 32 slots.
 *
 * Kept under its original name because every caller and pin reads it, but it is
 * no longer one slot's numbers. When the table cannot be loaded this falls back
 * to the fleet's published weighted average rather than to a single slot, so a
 * missing file degrades to the RIGHT shape of answer.
 */
const CENSUS_REFERENCE_SHARES = Object.freeze({
  source: CENSUS_TABLE
    ? `${CENSUS_TABLE.source} (${CENSUS_TABLE.slotCount} slots, `
      + `${CENSUS_TABLE.classifiedTotal} rows classified)`
    : "rematch IMPROVE fleet census, 32 slots, 2026-09-05/06 (table not loaded)",
  slots: CENSUS_TABLE?.slotCount ?? 32,
  ...(CENSUS_TABLE?.weighted ?? { AGREE: 0.423947, IMPROVE: 0.034467, CONFLICT: 0.407827, UNDERIVABLE: 0.082341 }),
});

/** One slot's own census shares, or null when the table lacks it. */
function censusSharesForSlot(slot) {
  if (!CENSUS_TABLE || slot === null || slot === undefined) return null;
  const n = Number(slot);
  const row = (CENSUS_TABLE.slots ?? []).find((r) => Number(r.slot) === n);
  return row ? row.shares : null;
}

/** The sportClass mix of a slot -- `{ vintage: 0.93, pokemon: 0.07 }` -- or null. */
function censusClassMixForSlot(slot) {
  if (!CENSUS_TABLE || slot === null || slot === undefined) return null;
  const n = Number(slot);
  const row = (CENSUS_TABLE.slots ?? []).find((r) => Number(r.slot) === n);
  return row ? (row.classMix ?? null) : null;
}

/** The census shares for one sportClass frame (vintage / modern / pokemon). */
function censusSharesForClass(cls) {
  const b = CENSUS_TABLE?.bySportClass?.[String(cls)];
  return b ? b.shares : null;
}

/** Below this many distinct cards, the sample is a pool and not a corpus. */
const FRAME_MIN_DISTINCT_CARDS = 100;

/**
 * FRAME HEALTH -- is this sample about the corpus, or about itself?
 *
 * Two hard flags, both learned from the 2026-09-06 artifact:
 *   zero-AGREE          the corpus is ~47% AGREE. A sample with none of it
 *                       cannot be a sample of the corpus.
 *   too-few-cards       fewer than 100 distinct cards means one pool's rows
 *                       are standing in for 16.7M.
 * Plus a per-class drift note against the census reference, which is a NOTE and
 * never a breach: the corpus legitimately moves, and this line exists so the
 * movement is visible rather than assumed.
 */
const DRIFT_CLASSES = ["AGREE", "IMPROVE", "CONFLICT", "UNDERIVABLE"];

/** Count a list of verdicts into a `{ AGREE, IMPROVE, ... }` tally. */
function tallyClasses(verdicts) {
  const out = {};
  for (const v of verdicts) {
    const k = String(v?.klass ?? "");
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** The per-class drift of one tally against one reference. */
function driftOf(byClass, total, reference) {
  const drift = {};
  for (const k of DRIFT_CLASSES) {
    const got = total > 0 ? Number(byClass[k] ?? 0) / total : 0;
    const ref = reference?.[k];
    drift[k] = {
      sampled: Number(got.toFixed(6)),
      census: ref ?? null,
      delta: ref === null || ref === undefined ? null : Number((got - ref).toFixed(6)),
    };
  }
  return drift;
}

function frameHealth({
  byClass = {}, distinctCards = 0, sampled = 0, reference = CENSUS_REFERENCE_SHARES,
  verdicts = null,
}) {
  const flags = [];
  const total = Number(sampled) || Object.values(byClass).reduce((a, b) => a + Number(b || 0), 0);
  const agree = Number(byClass.AGREE ?? 0);
  if (total > 0 && agree === 0) {
    flags.push(`zero-AGREE: 0 of ${total} sampled rows AGREE, against a census share of `
      + `${(reference.AGREE * 100).toFixed(1)}% -- the frame is not reaching the corpus`);
  }
  if (total > 0 && Number(distinctCards) < FRAME_MIN_DISTINCT_CARDS) {
    flags.push(`too-few-cards: ${distinctCards} distinct card(s) across ${total} sampled rows `
      + `(floor ${FRAME_MIN_DISTINCT_CARDS}) -- one pool is standing in for the corpus`);
  }
  const drift = driftOf(byClass, total, reference);

  // -- PER-SLOT: EACH SLOT'S DRAW AGAINST ITS OWN CENSUS --------------------
  //
  // The corpus average is the right reference only for a draw shaped like the
  // corpus. A slot's draw is shaped like THAT SLOT, and the slots differ
  // enormously -- slot 7 is 3.3% AGREE, slot 6 is 63.6%. Comparing each slot to
  // itself turns "the sample disagrees with the corpus" into "slot N moved",
  // which is a finding a person can act on.
  const bySlot = [];
  if (Array.isArray(verdicts) && verdicts.length) {
    const groups = new Map();
    for (const v of verdicts) {
      const slot = v?.__frameSlot;
      if (slot === null || slot === undefined) continue;
      const key = Number(slot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    for (const [slot, rows] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const ref = censusSharesForSlot(slot);
      const tally = tallyClasses(rows);
      bySlot.push({
        slot,
        sampled: rows.length,
        byClass: tally,
        census: ref,
        drift: ref ? driftOf(tally, rows.length, ref) : null,
      });
    }
  }

  // -- PER-CLASS: FRAME HEALTH BY SPORTCLASS -------------------------------
  //
  // THE LINE THAT MAKES THE ORIGINAL DEFECT UNREPEATABLE. A draw's class mix is
  // its own composition, and the classes have wildly different CONFLICT rates
  // (pokemon 0.596, modern 0.418, vintage 0.319). Without this, a draw that
  // happens to be pokemon-heavy reads as a corpus-wide regression -- which is
  // precisely what "CONFLICT 55% vs 20.6%" was. Each slot's rows are
  // apportioned across the classes its shard units belong to, so the expected
  // share is the mix's own blend rather than any one class's number.
  const byClassFrame = {};
  const expected = {};
  const mixWeights = {};
  let mixTotal = 0;
  for (const entry of bySlot) {
    const mix = censusClassMixForSlot(entry.slot);
    if (!mix) continue;
    for (const [cls, w] of Object.entries(mix)) {
      const n = entry.sampled * Number(w || 0);
      mixWeights[cls] = (mixWeights[cls] ?? 0) + n;
      mixTotal += n;
      const b = byClassFrame[cls] ?? (byClassFrame[cls] = { sampledApprox: 0, byClass: {} });
      b.sampledApprox += n;
      for (const k of DRIFT_CLASSES) {
        b.byClass[k] = (b.byClass[k] ?? 0) + Number(entry.byClass[k] ?? 0) * Number(w || 0);
      }
    }
  }
  const classHealth = [];
  for (const [cls, b] of Object.entries(byClassFrame)) {
    const ref = censusSharesForClass(cls);
    const n = b.sampledApprox;
    if (!(n > 0)) continue;
    const got = Number(b.byClass.CONFLICT ?? 0) / n;
    classHealth.push({
      sportClass: cls,
      sampledApprox: Number(n.toFixed(1)),
      shareOfFrame: mixTotal > 0 ? Number((n / mixTotal).toFixed(4)) : null,
      conflict: {
        sampled: Number(got.toFixed(6)),
        census: ref?.CONFLICT ?? null,
        delta: ref ? Number((got - ref.CONFLICT).toFixed(6)) : null,
      },
    });
  }
  classHealth.sort((a, b) => (b.sampledApprox ?? 0) - (a.sampledApprox ?? 0));

  // THE FRAME'S OWN EXPECTED SHARES, blended from its actual class mix. A draw
  // is comparable to `weighted` only when its mix matches the corpus's; when it
  // does not, this is the number it should have produced, and the gap between
  // the two is the structural half that used to be read as drift.
  if (mixTotal > 0) {
    for (const k of DRIFT_CLASSES) {
      let acc = 0;
      let seen = 0;
      for (const [cls, w] of Object.entries(mixWeights)) {
        const ref = censusSharesForClass(cls);
        if (!ref) continue;
        acc += ref[k] * w;
        seen += w;
      }
      if (seen > 0) expected[k] = Number((acc / seen).toFixed(6));
    }
  }

  return {
    healthy: flags.length === 0,
    flags,
    drift,
    expectedForThisMix: Object.keys(expected).length ? expected : null,
    bySlot,
    bySportClass: classHealth,
    referenceSlots: CENSUS_REFERENCE_SHARES.slots ?? null,
    distinctCards: Number(distinctCards),
    sampled: total,
  };
}

module.exports = {
  INVARIANTS, INVARIANT_BY_ID,
  loadSetKeyFieldInvariant, loadIdentityBacking,
  // I1 / I2
  WITHHELD_METHOD, withheldBlockOf, methodOf,
  checkOneStampPerHolding, checkWithheldValueExplained,
  // I3
  checkSetKeyFieldRow, catalogCellOf,
  // I4
  checkSlugGrammar, GRADE_TOKEN_RE, PRINT_RUN_RE,
  // I5
  checkOneSaleOneAddress,
  // I6
  checkPoolIdentityCoherence, poolCollisionRates,
  // exported for the mutation pins: reverting either of these restores one of
  // the two false positives measured on run 34018932244.
  singularise, buildSlugFinishIndex,
  // I7
  checkDeployHealth, REPRICE_JOB_NAME,
  // I8
  checkSourceFreshness, DEFAULT_STALENESS_HOURS, DEFAULT_EXEMPT_BELOW_ROWS,
  CANARY_MONITOR_SOURCES,
  // I9
  classifyStoredRow, rederivationRates, BREACHING_CLASSES,
  conflictKind, axisSignature, reasonCodes, NEEDS_CHECKLIST_REASON,
  // I9 sampling frame (#1872)
  buildSampleFrame, makeCardReservoir, frameHealth, seededRandom, utcDayOf,
  CENSUS_REFERENCE_SHARES, FRAME_MIN_DISTINCT_CARDS,
  CENSUS_TABLE, CENSUS_SHARES_PATH,
  censusSharesForSlot, censusSharesForClass, censusClassMixForSlot,
  // I10
  checkPricedOnUnbackedIdentity,
  // thresholds
  evaluateThreshold, evaluateDrift, MIN_CLASS_ROWS,
};
