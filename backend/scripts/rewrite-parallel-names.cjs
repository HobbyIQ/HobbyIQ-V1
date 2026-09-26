#!/usr/bin/env node
/**
 * rewrite-parallel-names.cjs -- a note is not a rung.
 *
 * CF-A-NOTE-IS-NOT-A-RUNG (2026-09-26). Tonight's census
 * (C:/tmp/spellcensus_2152/RESULT.md) measured card_catalog, Topps/Bowman
 * flagship family, baseball 2024-2026: 2,903,159 checklist-grade rows, and
 * 251,043 of them carry a leaked retailer/print-run/odds/SKU note glued
 * inside `parallel` -- box-channel words (100,380), an inline print-run
 * count (97,610), "exclusive" (71,852), a parenthetical (28,772), pack odds
 * (12,097), a SKU (4,992). Separately, ~89,159 rows split one real rung
 * across two exact spellings (RayWave vs Raywave, apostrophe/case pairs).
 *
 * Doctrine, unchanged by this lane: the checklist is the authority; a stated
 * rung is carried VERBATIM; a print run lives in `printRun` (the id's
 * `:num-N` segment), never inside the name; notes/odds/channel words never
 * enter the name; one card, one row, one pool; this lane never mints a
 * SECOND spelling of a rung that already has a row.
 *
 * WHAT THIS LANE DOES NOT DO. It does not invent a rule. Every strip or
 * alias it applies comes from a REVIEWED rules file under
 * backend/data/parallel-name-rules/ -- see the schema below -- and a rule
 * missing `ruling`, `rulingDate` or `sources` is refused at load, before any
 * row is even read. This is the "reviewed rules, at scale" lane, not a
 * general-purpose text stripper.
 *
 * THE DERIVATION IS THE SAME ONE MOVECATALOGROW USES, NEVER A STRING HACK.
 * `newId` comes from `computeHobbyIqCardId` fed the row's own fields with
 * `parallel` replaced by the rule's output -- exactly the check PR #2431's
 * `rungChangeFields` runs before trusting a list's stated destination. If
 * that computed id equals the row's own id, the row is already at the
 * canonical address and nothing moves (LEFT). Otherwise the id names where
 * the clean rung actually lives, and this lane reads that address before
 * deciding MOVE, RETIRE-source-as-duplicate or HOLD.
 *
 * CF-A-RENAME-NEVER-CHANGES-THE-PRODUCT (run 36227642297, exit 4, review
 * 2026-09-26). `computeHobbyIqCardId({ ..., setKey: row.setKey,
 * authoritativeSetKey: true })` does NOT keep a refinement-family setKey
 * verbatim: `authoritativeSetKey` only skips the CHROME-PREFIX override
 * applied AFTER `resolveSetKeyForSlug` has already run, and that earlier
 * step folds a refinement like "topps-series-2" to its flagship "topps" --
 * the exact same normalization a vendor-facing (non-checklist) caller
 * relies on. Feeding it a row's OWN already-canonical setKey therefore
 * silently re-addresses the row onto a DIFFERENT product's numbering. At
 * APPLY, moveCatalogRow's own cross-product guard (catalogRowOps.service.ts,
 * "a cross-product move is not a move") refused every one of the 12,155 rows
 * this produced -- but REPORT never calls moveCatalogRow at all, so it showed
 * them as clean moves nobody could see would fail before dispatch.
 *
 * THE FIX: `computeNewIdPreservingSetKey` below builds `newId` by parsing the
 * row's OWN id (grade-aware, via lib/graded-id.cjs) to recover its setKey
 * SEGMENT exactly as spelled -- never re-derived, never normalized -- then
 * asks computeHobbyIqCardId to reproduce that same segment verbatim. When it
 * cannot (an alias whose destination genuinely names a different product),
 * the shared `preflight()` refuses with `refused: "cross-product"` in BOTH
 * REPORT and APPLY, identically -- REPORT now runs every guard APPLY runs,
 * so a clean REPORT is never a false promise.
 *
 * THE FOUR OUTCOMES AT A NEW ADDRESS, PER ENTRY:
 *
 *   LEFT             newId === id: the slug already carries the clean name;
 *                    nothing to do (the row's `parallel` text itself may
 *                    still need healing in place -- see HEAL below).
 *
 *   HEAL             newId === id but the row's own `parallel` FIELD still
 *                    carries the leaked text (the slug happened to already
 *                    fold to the clean form, e.g. via a prior slugify pass).
 *                    Patched in place via patchCatalogRowFields, derived
 *                    fields rebuilt -- never a raw patch (#1614).
 *
 *   MOVE             newId is absent. moveCatalogRow with
 *                    `changedFields.parallel` set to the clean name (the
 *                    #2431 pattern) -- copy, re-point sales, retire graded
 *                    children of the old slug, delete old.
 *
 *   RETIRE (dup)      newId is occupied by a CHECKLIST-GRADE twin: the source
 *                    row is a duplicate of a rung that already has its own
 *                    row. Legal ONLY when `sold_comps` rows at the source id
 *                    are ZERO (paginated equality count, never COUNT/
 *                    GROUP BY -- FeedOptions maxItemCount:500). Any sale at
 *                    all -> HOLD "sales present" with the count, never a
 *                    silent retire that orphans a real sale.
 *
 *   HOLD (derived)    newId is occupied by a DERIVED (non-checklist) twin.
 *                    Overwriting a derived occupant's text/identity is the
 *                    relocate lane's call, not this one's -- reported, never
 *                    written, "owner decides".
 *
 * PRINTRUNFROMNAME IS THE ONE CASE THAT TOUCHES printRun, AND ONLY THAT
 * FIELD. A rule may say `printRunFromName: true` when the note it strips is
 * itself a print-run count the checklist states for this exact rung. It
 * fires only when (a) the row has NO printRun yet, and (b) a checklist-grade
 * row exists SOMEWHERE in the same setKey/year carrying this parallel name
 * WITH that printRun already attested -- i.e. some other card in the same
 * product already has a confirmed `<name>:num-N` row. Absent that attestation
 * the entry HOLDS rather than mints an unconfirmed run. isAuto is never
 * touched by any rule in this lane, matching #2431's own refusal to let a
 * curated fold arbitrate an autograph.
 *
 * SCAN SHAPE. Paginated per (setKey, year) named by a rule's `scope`, with
 * FeedOptions {maxItemCount:500, maxDegreeOfParallelism:-1} and
 * `while (iter.hasMoreResults())` -- never COUNT, never GROUP BY, never
 * maxItemCount:-1. Sharded by SLOT/SLOTS (hash of id) when the dispatcher
 * opts in via runner-shard-scope's own rule (an inherited slot=0/slots=16 is
 * not a chosen shard). Budgeted via runner-budget.cjs, same clock every
 * lane on this runner uses; a budget stop prints the marker the relaunch
 * composite greps for and the next dispatch continues from where the last
 * one left off -- every entry re-derives idempotently (a moved row reads
 * `movedFrom` and is skipped; a retired row's source is simply gone).
 *
 * RULES FILE SCHEMA (backend/data/parallel-name-rules/<date>-<slug>.json):
 *
 *   {
 *     "rules": [
 *       {
 *         "id": "<stable slug, unique in the file>",
 *         "scope": { "sport": "baseball", "year": 2026, "setKey": "topps" },
 *         "kind": "strip-note" | "alias",
 *         // strip-note: one or more regexes matching the LEAKED SUFFIX/NOTE
 *         // shape to remove from the raw `parallel` string. Applied in
 *         // order; the first one that matches wins.
 *         "pattern": ["<regex source>", ...],
 *         // alias: exact human-form strings.
 *         "from": "Raywave Refractor",
 *         "to": "RayWave Refractor",
 *         // only when a stripped count must become printRun (see above):
 *         "printRunFromName": false,
 *         "ruling": "<one line, what was decided and why>",
 *         "rulingDate": "2026-09-26",
 *         "sources": ["<verbatim quote, with site + year>", ...],
 *         "reason": "<short, for the report>"
 *       }
 *     ]
 *   }
 *
 * `scope.year` accepts a single year or `scope.years: [2024,2025,2026]`;
 * `scope.setKey` accepts a single key. `scope.setKeyPrefix` names the MATCH
 * SHAPE for a family (e.g. "topps-chrome" matches "topps-chrome" and
 * "topps-chrome-update-series"), but a prefix is not itself a scan scope --
 * this lane never discovers which literal setKeys exist under a prefix (that
 * is a GROUP BY, forbidden by doctrine) -- so a `setKeyPrefix` rule MUST also
 * carry a non-empty `scope.setKeys: [...]` array naming every literal setKey
 * it scans; a rule missing that pairing is REFUSED at load. A rule missing
 * `ruling`, `rulingDate` or a non-empty `sources` array is REFUSED at load
 * too -- before any row is read -- exactly as an unexplained retire is
 * refused elsewhere on this runner.
 *
 * `TITLES` (shared input) filters to one or more rule ids, comma-separated,
 * for a canary dispatch against a single rule before the whole file runs.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<rules file
 *      path, relative to backend/ -- REQUIRED, no default>; TITLES=<rule id
 *      filter, comma-separated, optional>; SLOT/SLOTS (hash of id, opt-in
 *      sharding via runner-shard-scope); LIMIT (bound the number of entries
 *      considered); RUN_MINUTES (default 110), RESERVE_MS, VERIFY_MS.
 * Exit 4 when the reconciliation does not add up.
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
// The dual cross-partition + partition-scoped sales check every retire gate
// on this runner shares -- see lib/sales-at-id.cjs for the reproduced
// anomaly a single cross-partition query missed.
const { salesAtId } = require(path.join(__dirname, "lib", "sales-at-id.cjs"));
// The grade-aware id splitter (#2431/#2434 mirror of catalogRowOps.service.ts's
// private parseSlugWithGrade) -- used ONLY to recover THIS lane's own row's
// setKey segment as it is actually SPELLED in the row's existing id, never as
// text computeHobbyIqCardId is free to re-resolve. See computeNewIdPreservingSetKey
// below for why that distinction is the whole fix.
const { parseSlugWithGrade } = require(path.join(__dirname, "lib", "graded-id.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n).toLocaleString();

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE. `scope` is shared with
// every other lane on this runner; a scope that does not name a rules file
// is a REFUSAL, not a fallback to "every rule ever written".
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane rewrites/moves/retires catalog rows and has "
      + "no default rules file — name the committed .json to run "
      + "(e.g. SCOPE=data/parallel-name-rules/2026-09-26-topps-bowman-2024-2026-leaked-notes-and-raywave.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a rules file. This lane's scope is a `
      + "committed .json rules file — never a predicate, a product key, or another lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;
const TITLES_FILTER = String(process.env.TITLES || "").trim()
  .split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "rewrite-parallel-names" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

// CF-A-RETIRE-NEEDS-A-LEDGER (review, PR #2438). Every RETIRE this lane
// performs is a hard delete with no read-back (retireCatalogRow), same as
// resolve-split-identity-parks/collapse-ch-synthetic-twins/fold-catalog-
// duplicate-rungs before it -- same PLAN_OUT convention, same fixed-path-
// guarded-on-script wiring, so a REPORT and an APPLY both write one NDJSON
// record per MOVE or RETIRE (never per refused/failed/left/healed row --
// those have no write to audit) into `${PLAN_OUT}/plan-slot-${SLOT}.ndjson`,
// truncated at open exactly like every sibling lane's own plan file.
//
// WIRING GAP, STATED PLAINLY: PLAN_OUT only takes effect for a script that
// this repo's .github/workflows/backfill-runner.yml names in its own
// script-gated ternary (see the other PLAN_OUT lanes above) -- and that file
// is backend/src's sibling off-limits path for this PR (the same "no
// backend/src, no .github" scope the original defect-fix PR was built
// under). This commit adds the SCRIPT-SIDE half only: rewrite-parallel-names
// reads PLAN_OUT like every sibling lane and writes the same NDJSON shape,
// so wiring it into the workflow later is a one-line ternary addition, not a
// script change. Until that workflow edit lands, PLAN_OUT is unset for this
// script in the real runner and the ledger is inert (same as it would be for
// any lane never added to that ternary) -- this is a real, stated gap, not a
// hidden one.
const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();

/**
 * Build one plan-file emitter, scoped to a single runLane() call -- factored
 * out (rather than module-level closure state) so a test can point it at a
 * scratch directory and assert on the file it writes without spawning a
 * child process or reloading this module. `main()` builds the real one from
 * PLAN_OUT/SLOT; runLane() defaults to a no-op emitter when the caller
 * passes none, so every existing in-process test that does not care about
 * the ledger is unaffected.
 *
 * One NDJSON record per confirmed MOVE or RETIRE -- APPLY writes it only
 * after its own write succeeds (never before, matching the same
 * confirmed-write discipline the moved/retired counters now use); REPORT
 * writes the identical shape with `mode: "report"` so an operator can diff
 * a REPORT's plan against a later APPLY's. Never called for
 * refused/failed/left/healed rows -- there is no write to audit there.
 */
function makePlanEmitter(planOut, slot) {
  const dir = String(planOut ?? "").trim();
  let fd = null; // null = not yet opened, -1 = tried and failed (never retry)
  function open() {
    if (!dir || fd !== null) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const planPath = path.join(dir, `plan-slot-${slot}.ndjson`);
      fd = fs.openSync(planPath, "w"); // truncate: each run's own selection, not an append log
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${dir}): ${e?.message}`);
      fd = -1;
    }
  }
  return {
    emitPlanRow(record) {
      if (!dir) return;
      open();
      if (!fd || fd === -1) return;
      try { fs.appendFileSync(fd, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n"); }
      catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${record?.id}: ${e?.message}`); }
    },
    close() {
      if (fd && fd !== -1) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
      fd = null;
    },
  };
}
const noopPlanEmitter = { emitPlanRow() {}, close() {} };

const CHECKLIST_SQL = "(c.source = 'bccp' OR STARTSWITH(c.source,'baseballcardpedia') OR STARTSWITH(c.source,'checklist') OR STARTSWITH(c.source,'beckett') OR STARTSWITH(c.source,'tcgdex') OR STARTSWITH(c.source,'cardboardchecklist'))";

// ─── RULE LOADING AND VALIDATION ──────────────────────────────────────────

/**
 * Load and validate the rules file. Refuses (throws) a rule missing
 * ruling/rulingDate/sources, or a malformed scope/kind -- before any row is
 * read. Returns the validated, filtered rule list.
 */
function loadRules(listPath, titlesFilter) {
  if (!fs.existsSync(listPath)) {
    throw new Error(`rules file not found: ${listPath}`);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const rawRules = Array.isArray(doc.rules) ? doc.rules : [];
  if (rawRules.length === 0) {
    throw new Error(`${listPath} names no rules — nothing is in scope.`);
  }
  const seen = new Set();
  const rules = [];
  for (const r of rawRules) {
    const id = String(r?.id ?? "").trim();
    if (!id) throw new Error("rule has no id");
    if (seen.has(id)) throw new Error(`duplicate rule id: ${id}`);
    seen.add(id);
    if (titlesFilter.length && !titlesFilter.includes(id)) continue;

    const ruling = String(r?.ruling ?? "").trim();
    const rulingDate = String(r?.rulingDate ?? "").trim();
    const sources = Array.isArray(r?.sources) ? r.sources.filter((s) => String(s ?? "").trim()) : [];
    if (!ruling) throw new Error(`rule "${id}" is missing "ruling" — refused before any row is read`);
    if (!rulingDate) throw new Error(`rule "${id}" is missing "rulingDate" — refused before any row is read`);
    if (!sources.length) throw new Error(`rule "${id}" is missing non-empty "sources" — refused before any row is read`);

    const kind = String(r?.kind ?? "").trim();
    if (kind !== "strip-note" && kind !== "alias") {
      throw new Error(`rule "${id}": kind must be "strip-note" or "alias", got ${JSON.stringify(r?.kind ?? null)}`);
    }
    const scope = r?.scope;
    if (!scope || typeof scope !== "object") throw new Error(`rule "${id}" has no scope`);
    const sport = String(scope.sport ?? "").trim();
    if (!sport) throw new Error(`rule "${id}": scope.sport is required`);
    const years = Array.isArray(scope.years) ? scope.years.map(Number)
      : scope.year !== undefined ? [Number(scope.year)] : null;
    if (!years || years.some((y) => !Number.isFinite(y))) {
      throw new Error(`rule "${id}": scope needs "year" or "years" (numeric)`);
    }
    const setKey = String(scope.setKey ?? "").trim();
    const setKeyPrefix = String(scope.setKeyPrefix ?? "").trim();
    if (!setKey && !setKeyPrefix) throw new Error(`rule "${id}": scope needs "setKey" or "setKeyPrefix"`);
    // CF-A-PREFIX-NAMES-A-SHAPE-A-SCAN-NAMES-AN-ADDRESS (review finding,
    // 2026-09-26). `setKeyPrefix` alone is not a scan scope: nothing in this
    // file may DISCOVER which literal setKeys exist under a prefix (that is
    // a GROUP BY this lane's own doctrine forbids), so a prefix rule with no
    // enumerated setKeys would either scan zero cells or -- the actual
    // defect this replaces -- silently scan only the cells some OTHER rule
    // happened to name explicitly. Every rule states its own scan scope, by
    // name, exactly like every other whole-scope write on this runner.
    const setKeys = Array.isArray(scope.setKeys)
      ? scope.setKeys.map((s) => String(s ?? "").trim()).filter(Boolean)
      : (setKey ? [setKey] : []);
    if (setKeyPrefix && setKeys.length === 0) {
      throw new Error(
        `rule "${id}": scope.setKeyPrefix requires a non-empty scope.setKeys array naming every literal `
        + `setKey this rule scans -- a prefix is a MATCH SHAPE, not a scan scope, and this lane never `
        + `discovers setKeys from Cosmos`,
      );
    }
    if (setKeyPrefix) {
      const offPrefix = setKeys.filter((sk) => !sk.startsWith(setKeyPrefix));
      if (offPrefix.length) {
        throw new Error(`rule "${id}": scope.setKeys entries ${JSON.stringify(offPrefix)} do not start with setKeyPrefix "${setKeyPrefix}"`);
      }
    }
    if (!setKeyPrefix && setKeys.length === 0) {
      throw new Error(`rule "${id}": scope.setKey resolved to no scan cells`);
    }

    if (kind === "strip-note") {
      const patternsRaw = Array.isArray(r?.pattern) ? r.pattern : (r?.pattern ? [r.pattern] : []);
      if (!patternsRaw.length) throw new Error(`rule "${id}" (strip-note) needs a non-empty "pattern" list`);
      // A leading "(?i)" is JSON-authoring shorthand for "case-insensitive" --
      // JS RegExp has no inline mode modifier, so it is stripped here and
      // turned into the real flag rather than left to silently fail to match
      // (as a literal "(?i)" substring would).
      const patterns = patternsRaw.map((p) => {
        const raw = String(p);
        const ci = raw.startsWith("(?i)");
        const src = ci ? raw.slice(4) : raw;
        try { return new RegExp(src, ci ? "i" : ""); }
        catch (e) { throw new Error(`rule "${id}": bad pattern ${JSON.stringify(p)}: ${e.message}`); }
      });
      rules.push({
        id, kind, sport, years, setKey, setKeyPrefix, setKeys, patterns,
        printRunFromName: r?.printRunFromName === true,
        ruling, rulingDate, sources, reason: String(r?.reason ?? "").trim() || ruling,
      });
    } else {
      const from = String(r?.from ?? "").trim();
      const to = String(r?.to ?? "").trim();
      if (!from) throw new Error(`rule "${id}" (alias) needs "from"`);
      if (!to) throw new Error(`rule "${id}" (alias) needs "to"`);
      if (from === to) throw new Error(`rule "${id}" (alias): "from" equals "to" — nothing to alias`);
      rules.push({
        id, kind, sport, years, setKey, setKeyPrefix, setKeys, from, to,
        printRunFromName: false,
        ruling, rulingDate, sources, reason: String(r?.reason ?? "").trim() || ruling,
      });
    }
  }
  return rules;
}

/** Does this rule apply to this (sport, year, setKey)? Matching still uses
 *  the prefix (a real row's setKey may be a family member not individually
 *  enumerated at scan time is impossible by construction now -- setKeys IS
 *  the scan scope -- but the prefix remains the shape test so a rule reads
 *  the same whether asked "does X match" or "what do I scan"). */
function ruleMatchesProduct(rule, sport, year, setKey) {
  if (rule.sport !== String(sport ?? "").trim()) return false;
  if (!rule.years.includes(Number(year))) return false;
  if (rule.setKeyPrefix) return String(setKey ?? "").startsWith(rule.setKeyPrefix);
  return rule.setKey === String(setKey ?? "").trim();
}

/**
 * Apply one rule to a raw `parallel` string. Returns
 * `{ name, printRunFromName }` when the rule matches and produces a
 * (possibly unchanged) clean name, or null when it does not match at all.
 */
function applyRule(rule, rawParallel) {
  const raw = String(rawParallel ?? "");
  if (rule.kind === "alias") {
    if (raw.trim() !== rule.from) return null;
    return { name: rule.to, strippedNote: null };
  }
  // strip-note: the FIRST matching pattern in the list wins.
  for (const re of rule.patterns) {
    const m = raw.match(re);
    if (!m) continue;
    // Every strip-note pattern is written to capture the CLEAN name in group
    // 1 (see the rules file); a pattern with no group 1 is a rule-authoring
    // bug and is refused rather than silently taking the whole match.
    const clean = m[1] !== undefined ? m[1].trim() : null;
    if (clean === null) {
      throw new Error(`rule "${rule.id}": pattern ${re} has no capture group 1 — cannot recover the clean name`);
    }
    if (!clean) return { name: "", strippedNote: m[0], empty: true };
    return { name: clean, strippedNote: m[0] };
  }
  return null;
}

// ─── NEW-ID DERIVATION THAT NEVER CHANGES THE PRODUCT ─────────────────────

/**
 * Build the row's new id with its OWN setKey segment preserved, and verify
 * the round-trip before trusting it -- see the CF-A-RENAME-NEVER-CHANGES-THE-
 * PRODUCT header comment above for why `computeHobbyIqCardId` cannot simply
 * be handed `row.setKey` and trusted, even under `authoritativeSetKey: true`:
 * `resolveSetKeyForSlug` treats its `setKey` argument as untrusted free text
 * to RE-RESOLVE (alias tables, family folds), not as an already-canonical
 * segment to pass through, and `authoritativeSetKey` only gates the LATER
 * chrome-prefix step -- verified live (2026-09-26): feeding it the literal
 * segment "topps-series-2" with authoritativeSetKey:true still returns
 * "topps". THE SERVICE CANNOT BE FORCED for a refinement-family setKey, so
 * this function never trusts its setKey output -- it uses computeHobbyIqCardId
 * ONLY to get the correctly-normalized parallel/printRun/auto SEGMENTS (via
 * a probe call), then reconstructs the id by substituting ONLY those segments
 * into the row's OWN id, leaving every other segment -- setKey, subset,
 * cardNumber, year, sport -- byte-for-byte what the row's own id already
 * says. The round-trip is then verified by RE-PARSING the reconstructed id
 * and confirming every field except parallel/printRun equals what the row's
 * own id parsed to; any disagreement (a malformed reconstruction, or a rule
 * whose output cannot be reconciled with the row's own address at all) is a
 * refusal, never a silent guess.
 *
 * @returns {{ newId: string } | { refused: "cross-product", detail: string }}
 */
function computeNewIdPreservingSetKey(row, newName, printRun, deps) {
  const { computeHobbyIqCardId, parseHobbyIqCardId } = deps;
  const ownId = String(row.id);
  const split = parseSlugWithGrade(ownId, parseHobbyIqCardId);
  if (!split) {
    return { refused: "cross-product", detail: `cannot parse the row's own id "${ownId}" with the grade-aware splitter` };
  }
  const own = split.parsed;
  const finalPrintRun = printRun ?? own.printRun ?? null;

  // PROBE ONLY: this call's setKey is never trusted (see header above) --
  // it exists solely to reproduce the exact parallel-slug/auto/printRun
  // segments the real minting path would produce for this (sport, year,
  // cardNumber, parallel, printRun) combination, INCLUDING product-specific
  // tiering rules (e.g. the 1997 Topps Finest bronze/silver/gold-by-number
  // fold) that live inside computeHobbyIqCardId and nowhere else. Its setKey
  // input is the row's own -- passed only so a same-family probe doesn't
  // trip an unrelated guard -- and its OUTPUT setKey is discarded entirely.
  let probe;
  try {
    probe = computeHobbyIqCardId({
      sport: own.sport, year: own.year, setKey: row.setKey ?? own.setKey,
      cardNumber: own.cardNumber, isAuto: own.isAuto, parallel: newName,
      printRun: finalPrintRun,
      authoritativeSetKey: true,
      unnumberedByChecklist: true,
      playerName: row.playerName ?? null,
      subsetName: own.subsetName ?? null,
      subsetInId: own.subsetInId === true,
    });
  } catch (e) {
    return { refused: "cross-product", detail: `computeHobbyIqCardId threw while probing the new parallel/printRun segments: ${e.message}` };
  }
  const probeParsed = parseHobbyIqCardId(probe);
  if (!probeParsed) {
    return { refused: "cross-product", detail: `probe id "${probe}" does not itself parse` };
  }

  // Reconstruct the id with ONLY the setKey segment forced back to the row's
  // OWN, verbatim, spelling -- every other segment comes from the probe
  // (parallel slug, auto flag, printRun) or the row's own parsed id (sport,
  // year, cardNumber, subset). This is the literal "replace ONLY the
  // parallel segment" the fix requires, generalized to also carry a
  // printRunFromName change through the same substitution.
  const parts = ["hiq", own.sport, String(own.year), own.setKey];
  if (own.subsetInId && own.subsetName) parts.push(`sub-${own.subsetName}`);
  parts.push(own.cardNumber, probeParsed.parallel, probeParsed.isAuto ? "auto" : "no-auto");
  if (probeParsed.printRun) parts.push(`num-${probeParsed.printRun}`);
  const candidateParent = parts.join(":");

  // VERIFY THE ROUND-TRIP. Re-parse the reconstructed id.
  //
  // WHAT THIS CAN ACTUALLY CATCH (review, PR #2438): `sport`/`year`/`setKey`/
  // `cardNumber` below are placed into `parts` verbatim from `own.*` (the row's
  // OWN parsed id) two lines above, and parseHobbyIqCardId does nothing but
  // echo `parts[1..3]` straight back with no validation -- so a mismatch on
  // any of those four is structurally impossible today; they can never fail
  // and the actual cross-product protection is "never build the candidate's
  // setKey segment from anything but own.setKey", not this comparison. Kept
  // as DEFENSE IN DEPTH ONLY: if a future change to the reconstruction above
  // (or to parseHobbyIqCardId itself) ever lets one of these segments drift,
  // this still catches it -- but do not read a passing check on these four as
  // proof of anything; read the construction above instead.
  //
  // isAuto IS a real check: it comes from `probeParsed`, a value this
  // function does not itself control, not from `own`. subsetName/subsetInId
  // are also real: whether the `sub-` segment is included at all depends on
  // `own.subsetInId`, and a parser disagreement there is a genuine defect
  // this guard is designed to catch (see #2434's own subset-dropping defect).
  const verify = parseHobbyIqCardId(candidateParent);
  if (!verify) {
    return { refused: "cross-product", detail: `reconstructed id "${candidateParent}" does not itself parse` };
  }
  const mismatches = [];
  // -- defense in depth only; see note above, these cannot fail today --
  if (verify.sport !== own.sport) mismatches.push(`sport ${verify.sport} != ${own.sport}`);
  if (verify.year !== own.year) mismatches.push(`year ${verify.year} != ${own.year}`);
  if (verify.setKey !== own.setKey) mismatches.push(`setKey ${verify.setKey} != ${own.setKey}`);
  if (verify.cardNumber !== own.cardNumber) mismatches.push(`cardNumber ${verify.cardNumber} != ${own.cardNumber}`);
  // -- real checks: probeParsed/conditional-segment sourced --
  if (verify.isAuto !== own.isAuto) mismatches.push(`isAuto ${verify.isAuto} != ${own.isAuto}`);
  if ((verify.subsetName ?? null) !== (own.subsetName ?? null)) mismatches.push(`subsetName ${verify.subsetName} != ${own.subsetName}`);
  if ((verify.subsetInId ?? false) !== (own.subsetInId ?? false)) mismatches.push(`subsetInId ${verify.subsetInId} != ${own.subsetInId}`);
  if (mismatches.length) {
    return {
      refused: "cross-product",
      detail: `newId "${candidateParent}" disagrees with the row's own id "${ownId}" on: ${mismatches.join(", ")} `
        + `-- a rename never changes the product`,
    };
  }

  // Re-attach the grade tier the ORIGINAL id carried (this lane never
  // touches a grade tier's own text -- it only ever moves the parent).
  const newId = split.gradeTier ? `${candidateParent}:${split.gradeTier}` : candidateParent;
  return { newId };
}

/**
 * Shared guard run identically by REPORT and APPLY, so a clean REPORT can
 * never promise a move that APPLY's own moveCatalogRow guard would refuse.
 * `outcome` is computeNewIdPreservingSetKey's return value.
 *
 * @returns {{ ok: true, newId: string } | { ok: false, refused: "cross-product", detail: string }}
 */
function preflight(row, outcome) {
  if (outcome.refused) {
    return { ok: false, refused: outcome.refused, detail: outcome.detail };
  }
  return { ok: true, newId: outcome.newId };
}

// ─── COSMOS-DEPENDENT MAIN (requires COSMOS_CONNECTION_STRING + dist/) ────

const retry = async (fn, tries = 12) => {
  let wait = 1000;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
    }
  }
};

/** Sales at a given hobbyiqCardId, by the DUAL check (lib/sales-at-id.cjs):
 *  a cross-partition query UNIONed with the same predicate scoped to
 *  `partitionKey: slug`. A bare cross-partition equality query can miss a
 *  real row -- see that module for the reproduced anomaly -- so this lane's
 *  "retire only if 0 sales" gate never relies on the cross-partition form
 *  alone. Never COUNT/GROUP BY, never maxItemCount: -1. */
async function salesCountAt(pool, slug) {
  const { xp, pk, total } = await salesAtId(pool, slug, { retry });
  console.log(`      sales at id: xp=${xp} pk=${pk}`);
  return { xp, pk, total };
}

/** A checklist-grade row somewhere in (sport, year, setKey) already carrying
 *  `parallel` at exactly `printRun` -- the attestation printRunFromName
 *  requires before it is allowed to mint a run nobody has confirmed. */
async function checklistAttestsPrintRun(cat, sport, year, setKey, parallelName, printRun) {
  // An EXISTENCE check, never an aggregate: select the id (bounded to one
  // page of at most 1 row) and ask whether anything came back. Doctrine on
  // this runner is "never COUNT, never GROUP BY" even for a one-shot answer.
  const query = {
    query: `SELECT c.id FROM c WHERE c.sport=@sp AND c.year=@yr AND c.setKey=@sk `
      + `AND c.parallel=@pl AND c.printRun=@pr AND ${CHECKLIST_SQL}`,
    parameters: [
      { name: "@sp", value: sport }, { name: "@yr", value: Number(year) },
      { name: "@sk", value: setKey }, { name: "@pl", value: parallelName }, { name: "@pr", value: printRun },
    ],
  };
  const { resources } = await retry(() => cat.items.query(query, { maxItemCount: 1 }).fetchAll());
  return (resources ?? []).length > 0;
}

/**
 * All (sport, year, setKey) product cells a rule scans -- ENTIRELY from the
 * rule's own `setKeys` (loadRules already resolved `scope.setKey` to a
 * one-element list and refused a `setKeyPrefix` rule with no `scope.setKeys`
 * array). No discovery, no second argument: a rule that scans nothing beyond
 * what it names by id is a rule this lane can neither under- nor over-reach.
 *
 * CF-A-PREFIX-NAMES-A-SHAPE-A-SCAN-NAMES-AN-ADDRESS (review finding,
 * 2026-09-26): the earlier version expanded a `setKeyPrefix` rule against
 * whichever literal setKeys OTHER rules in the file happened to name
 * explicitly. Every strip-note rule in the shipped file used a prefix with
 * no sibling `setKey` rule anywhere near most of the family, so 9 of 15
 * rules reached only 4 of the family's 15 setKeys and the Series-1-Tinsel
 * evidence the rule was WRITTEN FROM could never be scanned by it.
 */
function productCellsOf(rule) {
  const cells = [];
  for (const year of rule.years) {
    for (const sk of rule.setKeys) cells.push({ sport: rule.sport, year, setKey: sk });
  }
  return cells;
}

/**
 * The lane's whole work loop, container-injectable so tests can drive it
 * against an in-memory fake rather than a live Cosmos account -- the same
 * shape fold-catalog-duplicate-rungs' own `runLane` uses.
 *
 * @param {object} opts
 * @param {object} opts.cat            card_catalog container (or fake)
 * @param {object} opts.pool           sold_comps container (or fake)
 * @param {Array}  opts.rules          validated rules (loadRules() output)
 * @param {boolean} opts.apply
 * @param {object} opts.budget         a budget() instance
 * @param {object} opts.deps           { moveCatalogRow, patchCatalogRowFields,
 *                                       rebuildSearchFields, retireCatalogRow,
 *                                       computeHobbyIqCardId }
 * @param {number} [opts.limit]
 * @param {boolean} [opts.sharded]
 * @param {number} [opts.slot]
 * @param {number} [opts.slots]
 */
async function runLane({ cat, pool, rules, apply, budget: b, deps, limit = 0, sharded = false, slot = 0, slots = 1, planEmitter = noopPlanEmitter }) {
  const { emitPlanRow } = planEmitter;
  const {
    moveCatalogRow, patchCatalogRowFields, rebuildSearchFields, retireCatalogRow,
    computeHobbyIqCardId, parseHobbyIqCardId,
  } = deps;

  const rowAt = async (id) => {
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) { if (err?.code === 404 || err?.statusCode === 404) return null; throw err; }
  };

  // Per-rule counters, keyed by rule id, so the report is a table.
  const perRule = new Map(rules.map((r) => [r.id, {
    matched: 0, moved: 0, retired: 0, heldSales: 0, heldDerived: 0, leftCanonical: 0,
    healed: 0, refused: 0, printRunFilled: 0,
    examples: [],
    salesUnderOldId: 0,
  }]));

  // THE SCOPE, PRINTED BEFORE A SINGLE ROW IS READ. Review finding
  // (2026-09-26): a report that only shows outcomes after the fact cannot
  // catch a rule whose scan reaches the wrong cells -- exactly the defect
  // productCellsOf's own header now documents. Every rule's product cells
  // come straight from its own `setKeys` (see loadRules/productCellsOf), so
  // printing them here is the operator's chance to see the scan scope BEFORE
  // an APPLY, not infer it from a silent zero afterwards.
  const cellsByRule = new Map(rules.map((r) => [r.id, productCellsOf(r)]));
  console.log("scan scope, per rule (before any row is read):");
  for (const rule of rules) {
    const cells = cellsByRule.get(rule.id);
    console.log(`  ${rule.id}: ${cells.length} cell(s)`);
    for (const c of cells) console.log(`    ${c.sport}/${c.year}/${c.setKey}`);
  }
  console.log("");

  let considered = 0, stoppedAt = null, failed = 0;

  outer:
  for (const rule of rules) {
    const cells = cellsByRule.get(rule.id);
    for (const cell of cells) {
      const query = {
        query: `SELECT * FROM c WHERE c.sport=@sp AND c.year=@yr AND c.setKey=@sk AND IS_DEFINED(c.parallel) AND ${CHECKLIST_SQL}`,
        parameters: [
          { name: "@sp", value: cell.sport }, { name: "@yr", value: cell.year }, { name: "@sk", value: cell.setKey },
        ],
      };
      const iter = cat.items.query(query, { maxItemCount: 500, maxDegreeOfParallelism: -1 });
      while (iter.hasMoreResults()) {
        if (b.outOfClock()) { stoppedAt = considered; break outer; }
        const { resources } = await retry(() => iter.fetchNext());
        for (const row of resources ?? []) {
          if (sharded && shardOf(row.id) !== slot) continue;
          if (limit && considered >= limit) { stoppedAt = considered; break outer; }
          if (b.outOfClock()) { stoppedAt = considered; break outer; }

          const applied = applyRule(rule, row.parallel);
          if (!applied) continue;
          considered++;
          const st = perRule.get(rule.id);
          st.matched++;

          if (applied.empty) {
            // A pattern matched but the capture is empty -- a channel-only
            // note with no name left. Reported, never applied: an empty name
            // is not a rung.
            st.refused++;
            console.error(`  REFUSED (empty name after strip)  ${String(row.id).slice(0, 70)}`);
            continue;
          }

          const newName = applied.name;
          let printRun = row.printRun ?? null;
          let printRunFromName = false;
          if (rule.printRunFromName && !row.printRun && applied.strippedNote) {
            const m = String(applied.strippedNote).match(/(\d[\d,]{2,7})/);
            const candidate = m ? Number(m[1].replace(/,/g, "")) : null;
            if (candidate) {
              const attested = await checklistAttestsPrintRun(cat, cell.sport, cell.year, cell.setKey, newName, candidate);
              if (attested) { printRun = candidate; printRunFromName = true; }
              else {
                st.refused++;
                console.error(`  HOLD (printRunFromName unattested)  ${String(row.id).slice(0, 70)}  candidate=${candidate}`);
                continue;
              }
            }
          }

          // CF-A-RENAME-NEVER-CHANGES-THE-PRODUCT: newId is built with the
          // row's OWN setKey segment preserved (computeNewIdPreservingSetKey),
          // then run through the SAME preflight() REPORT and APPLY both call
          // -- a rule whose output would re-address the row onto a different
          // product's numbering is refused HERE, before any occupant read,
          // identically in both modes.
          const idOutcome = computeNewIdPreservingSetKey(row, newName, printRunFromName ? printRun : null, { computeHobbyIqCardId, parseHobbyIqCardId });
          const gate = preflight(row, idOutcome);
          if (!gate.ok) {
            st.refused++;
            console.error(`  REFUSED (${gate.refused})  ${String(row.id).slice(0, 70)}: ${gate.detail}`);
            continue;
          }
          const newId = gate.newId;

          if (newId === row.id) {
            if (row.parallel === newName && (!printRunFromName || row.printRun === printRun)) {
              st.leftCanonical++;
              continue;
            }
            // HEAL: already at the right address, but the field text (or a
            // recovered printRun) has not caught up to it. In REPORT mode
            // (apply=false) there is no write to confirm, so `healed` states
            // the projection, exactly as before. In APPLY mode `healed` is
            // credited ONLY once patchCatalogRowFields actually returns --
            // CF-MOVED-COUNTS-CONFIRMED-WRITES-ONLY (run 36227642297, exit 4):
            // a count taken before the write is attempted double-counts a
            // row that then fails, because the failure path could only add
            // to `failed`, never subtract the pre-emptive credit.
            if (st.examples.length < 10) st.examples.push({ id: row.id, from: row.parallel, to: newName, newId, action: "heal" });
            if (!apply) { st.healed++; continue; }
            try {
              const fields = { parallel: newName };
              if (printRunFromName) fields.printRun = printRun;
              Object.assign(fields, rebuildSearchFields({ ...row, ...fields }));
              await patchCatalogRowFields(cat, row.id, row.cardId ?? row.id, fields, { retry });
              st.healed++;
              if (printRunFromName) st.printRunFilled++;
            } catch (e) {
              failed++;
              console.error(`      FAILED heal ${String(row.id).slice(0, 60)}: ${e.message}`);
            }
            continue;
          }

          const occupant = await rowAt(newId);
          if (!occupant) {
            // MOVE. Same confirmed-write discipline as HEAL above: REPORT
            // states the projection, APPLY credits `moved` only after
            // moveCatalogRow returns something other than "refused" --
            // never before the write, and never left standing after a
            // thrown write (that row lands in `failed` only). PLAN_OUT gets
            // one record per outcome (mode "report" or "apply"), never one
            // for a refusal or a thrown write -- those have nothing to audit.
            if (st.examples.length < 10) st.examples.push({ id: row.id, from: row.parallel, to: newName, newId, action: "move" });
            if (!apply) {
              st.moved++;
              emitPlanRow({ mode: "report", action: "move", id: row.id, newId, reason: rule.reason });
              continue;
            }
            try {
              const changedFields = { parallel: newName };
              if (printRunFromName) changedFields.printRun = printRun;
              // CF-DO-NOT-LOOK-TWICE: `occupant` above already IS the fresh
              // point read moveCatalogRow would otherwise repeat.
              const res = await moveCatalogRow(cat, row, newId, changedFields, {
                reason: `rewrite-parallel-names: ${rule.reason}`,
                dryRun: false, salesContainer: pool, known: occupant, retry,
              });
              if (res?.action === "refused") {
                st.refused++;
                console.error(`      FAILED move ${String(row.id).slice(0, 60)}: ${res.decision}`);
              } else {
                st.moved++;
                if (printRunFromName) st.printRunFilled++;
                emitPlanRow({ mode: "apply", action: "move", id: row.id, newId, reason: rule.reason });
              }
            } catch (e) {
              failed++;
              console.error(`      FAILED move ${String(row.id).slice(0, 60)}: ${e.message}`);
            }
            continue;
          }

          const occupantIsChecklist = /^(bccp|baseballcardpedia|checklist|beckett|tcgdex|cardboardchecklist)/.test(String(occupant.source ?? ""));
          if (occupantIsChecklist) {
            // A duplicate of an already-canonical rung. Retire the SOURCE
            // only when zero sales point at it -- never a silent orphan.
            // THE CHECK IS THE GATE: a thrown query is an unanswered
            // question, never a green light. It lands in `failed`, and
            // retireCatalogRow below is never reached on that path.
            let salesCheck;
            try {
              salesCheck = await salesCountAt(pool, row.id);
            } catch (e) {
              failed++;
              console.error(`      FAILED sales check ${String(row.id).slice(0, 60)}: ${e.message}`);
              continue;
            }
            const { xp: salesXp, pk: salesPk, total: n } = salesCheck;
            st.salesUnderOldId += n;
            if (n > 0) {
              st.heldSales++;
              console.error(`  HOLD (sales present, n=${n})  ${String(row.id).slice(0, 70)} -> ${String(newId).slice(0, 70)}`);
              continue;
            }
            // RETIRE (duplicate). Same confirmed-write discipline: REPORT
            // states the projection, APPLY credits `retired` only once
            // retireCatalogRow actually returns. PLAN_OUT carries the sales
            // check's own xp/pk breakdown (the dual cross-partition +
            // partition-scoped read this gate is built on) so a read-back
            // audit can see the ZERO-sales evidence, not just the verdict --
            // this is a hard delete with no other read-back path.
            if (st.examples.length < 10) st.examples.push({ id: row.id, from: row.parallel, to: newName, newId, action: "retire-duplicate" });
            if (!apply) {
              st.retired++;
              emitPlanRow({ mode: "report", action: "retire", id: row.id, twinId: newId, reason: rule.reason, salesXp, salesPk });
              continue;
            }
            try {
              await retireCatalogRow(cat, row.id, row.cardId ?? row.id, `rewrite-parallel-names: duplicate of canonical ${newId} (${rule.reason})`, { retry });
              st.retired++;
              emitPlanRow({ mode: "apply", action: "retire", id: row.id, twinId: newId, reason: rule.reason, salesXp, salesPk });
            } catch (e) {
              failed++;
              console.error(`      FAILED retire ${String(row.id).slice(0, 60)}: ${e.message}`);
            }
            continue;
          }

          // Occupied by a DERIVED (non-checklist) twin. Overwriting its
          // text/identity is the relocate lane's call, not this one's.
          st.heldDerived++;
          console.error(`  HOLD (derived twin occupies target)  ${String(row.id).slice(0, 70)} -> ${String(newId).slice(0, 70)}`);
        }
      }
    }
  }

  // ── REPORT ────────────────────────────────────────────────────────────
  console.log(`\n${apply ? "APPLY" : "REPORT ONLY — nothing written"}`);
  let totalMatched = 0, totalMoved = 0, totalRetired = 0, totalHeldSales = 0, totalHeldDerived = 0, totalLeft = 0, totalHealed = 0, totalRefused = 0;
  for (const rule of rules) {
    const st = perRule.get(rule.id);
    totalMatched += st.matched; totalMoved += st.moved; totalRetired += st.retired;
    totalHeldSales += st.heldSales; totalHeldDerived += st.heldDerived; totalLeft += st.leftCanonical;
    totalHealed += st.healed; totalRefused += st.refused;
    console.log(`\n  rule ${rule.id}`);
    console.log(`    matched            ${f(st.matched)}`);
    console.log(`    would-move/moved   ${f(st.moved)}`);
    console.log(`    would-retire/retired ${f(st.retired)}`);
    console.log(`    held-sales         ${f(st.heldSales)}   <- sales under old rung ids: ${f(st.salesUnderOldId)}`);
    console.log(`    held-derived       ${f(st.heldDerived)}`);
    console.log(`    left-canonical     ${f(st.leftCanonical)}`);
    console.log(`    healed             ${f(st.healed)}`);
    console.log(`    refused            ${f(st.refused)}`);
    console.log(`    printRun filled    ${f(st.printRunFilled)}`);
    if (st.examples.length) {
      console.log(`    examples (up to 10):`);
      for (const ex of st.examples) {
        console.log(`      [${ex.action}] ${String(ex.from).slice(0, 40)} -> ${String(ex.to).slice(0, 40)}   ${String(ex.id).slice(0, 50)} -> ${String(ex.newId).slice(0, 50)}`);
      }
    }
  }

  const written = totalMoved + totalRetired + totalHealed;
  const held = totalHeldSales + totalHeldDerived;
  console.log(`\n  reconciled: matched ${f(totalMatched)} = moved ${f(totalMoved)} + retired ${f(totalRetired)} `
    + `+ healed ${f(totalHealed)} + held ${f(held)} + left-canonical ${f(totalLeft)} + refused ${f(totalRefused)} + failed ${f(failed)}`);
  let exitCode = 0;
  if (totalMoved + totalRetired + totalHealed + held + totalLeft + totalRefused + failed !== totalMatched) {
    console.error("  !! RECONCILE MISMATCH — a matched row was neither moved, retired, healed, held, left, refused nor failed");
    exitCode = 4;
  }

  if (stoppedAt !== null) {
    console.log(`\n  stopped at the ${b.RUN_MINUTES}-minute budget — the relaunch continues from here`);
    console.log("  every entry is idempotent: an already-moved row re-reads as left-canonical, an already-retired source is simply gone.");
  }

  planEmitter.close();

  return {
    exitCode, totalMatched, totalMoved, totalRetired, totalHeldSales, totalHeldDerived,
    totalLeft, totalHealed, totalRefused, failed, written, held, stoppedAt, perRule,
  };
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const {
    moveCatalogRow, patchCatalogRowFields, rebuildSearchFields, retireCatalogRow,
  } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { computeHobbyIqCardId, parseHobbyIqCardId } = require(
    path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"),
  );

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  let rules;
  try {
    rules = loadRules(listPath, TITLES_FILTER);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
  if (rules.length === 0) {
    console.error(`FATAL: no rules matched TITLES filter "${TITLES_FILTER.join(",")}" in ${SCOPE}`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`rules in scope          ${f(rules.length)}${TITLES_FILTER.length ? `  (filtered by titles=${TITLES_FILTER.join(",")})` : ""}`);
  for (const r of rules) console.log(`  rule: ${r.id} — ${r.ruling}`);
  console.log("");
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const b = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${b.describe()}`);
  console.log("");

  const result = await runLane({
    cat, pool, rules, apply: APPLY, budget: b,
    deps: { moveCatalogRow, patchCatalogRowFields, rebuildSearchFields, retireCatalogRow, computeHobbyIqCardId, parseHobbyIqCardId },
    limit: LIMIT, sharded: SHARDED, slot: SLOT, slots: SLOTS,
    planEmitter: makePlanEmitter(PLAN_OUT, SLOT),
  });

  process.exitCode = result.exitCode;
  if (APPLY) {
    reportWrites({
      job: "rewrite-parallel-names", intended: result.totalMatched,
      written: result.written, skipped: result.totalLeft + result.held, failed: result.failed + result.totalRefused,
    });
  }

  await finishLane(process.exitCode ?? 0, { client, budget: b });
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}

module.exports = {
  SCOPE, APPLY, loadRules, ruleMatchesProduct, applyRule, runLane, productCellsOf, salesCountAt, checklistAttestsPrintRun,
  computeNewIdPreservingSetKey, preflight, makePlanEmitter,
};
