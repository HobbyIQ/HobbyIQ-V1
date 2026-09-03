/**
 * CF-GUARD-THE-CATALOG-WRITE-CONTRACT (Drew, 2026-08-26: "creation and repair
 * BUT equal").
 *
 * card_catalog has no agreed addressing contract, and that -- not any single
 * bug -- is what cost four days. Three live code paths each believed something
 * different:
 *
 *   catalogMatcher.service.ts   item(slug, slug)          canonical
 *   explodeCatalogGrades.cjs    cardId = parent.cardId    co-located ladder
 *   cardCatalog.service.ts      item(slug, SPORT)         stale; returned null
 *                                                         for every row in a
 *                                                         48M-row container
 *
 * Every repair was correct under one belief and wrong under another, which is
 * why fixes kept not sticking: the re-home moved rows the explode re-broke,
 * half-moved twins accumulated, and matching stayed poor no matter what was
 * normalised.
 *
 * THE CONTRACT: id === cardId === the hiq slug. Every row is its own
 * single-document partition, which is what makes the ~1 RU point read work and
 * what deriveCatalogEntry already does. upsertCatalogEntry is the write side.
 * Moving or retiring a row is D5 PR 2's catalogRowOps (moveCatalogRow /
 * retireCatalogRow); until it lands, every mover is hand-rolled debt.
 *
 * This asserts that a script writing card_catalog goes through that path. It
 * cannot check what a script does at RUNTIME -- only that it did not hand-roll
 * its own row shape, which is where every one of these defects came from.
 *
 * HOW IT MEASURES (rewritten 2026-08-29, D5 PR 1). The first version of this
 * guard was green by blindness three ways, all found by a read-only census:
 *
 *   1. "canonical" was a text match, and two of its three passes were
 *      COMMENTS (explodeCatalogGrades.cjs line 72, cleanupNullPartition-
 *      CatalogRows.cjs line 5; both hand-roll `cat.items.upsert`). Now comments
 *      are stripped first, and only an import/require of cardCatalog.service
 *      that names the builder, or a real call `deriveCatalogEntry(` /
 *      `upsertCatalogEntry(`, counts. A mention can never count.
 *   2. WRITES only knew items.upsert/bulk/create. `.item(..).patch|replace|
 *      delete` mutates the same rows, and 41 files did it invisibly (every
 *      retire-* script, conform-card-profile, fastPatchIdIsSlug ...). Now both
 *      count. Mutators get their own debt list, so the number is honest and a
 *      patcher that STARTS minting rows is caught as a new minter.
 *   3. TOUCHES and WRITES were matched independently across the whole file,
 *      so a file that READ card_catalog and WROTE sold_comps was a "writer" --
 *      five of them sat on the debt list. Now the card_catalog handle is
 *      resolved to the name it is bound to (`const cat = db.container(...)`,
 *      a module-level cache behind a getter, a local helper's parameter, a
 *      name that is later re-bound to another container) and only a write on
 *      THAT name counts. The loose text match survives only as the fallback
 *      for a file where nothing resolves, and every such file is logged.
 *
 * BYPASSING and MUTATORS_BYPASSING are debt lists, not exemption lists. They
 * may shrink and must never grow. This debt compounds unusually badly: each
 * bypassing writer produces rows a later sweep has to find and repair, and we
 * have now watched that cycle run for four days.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");

/** The builder itself: the one place allowed to write a row shape. Not a "writer". */
const CANONICAL_HOME = "backend/src/services/portfolioiq/cardCatalog.service.ts";
/** D5 PR 2 lands this (moveCatalogRow / retireCatalogRow). Tolerated absent until then. */
const ROW_OPS_HOME = "backend/src/services/catalog/catalogRowOps.service.ts";

// ---- what a card_catalog handle looks like --------------------------------
// `.container("card_catalog")`, `.container(process.env.X ?? "card_catalog")`,
// `getContainer('card_catalog')`. A named constant or a helper that takes the
// container NAME is a known blind spot of this guard (catalogMatcher's
// CATALOG_CONTAINER, labeler's db("card_catalog")); neither writes today.
const CATALOG_ARG = String.raw`\s*(?:process\.env\.[A-Za-z_]+\s*(?:\?\?|\|\|)\s*)?["']card_catalog["']\s*`;
const IS_CATALOG_ARG = new RegExp(`^${CATALOG_ARG}$`);
const TOUCHES = new RegExp(String.raw`[A-Za-z_]*[cC]ontainer\s*\(${CATALOG_ARG}\)`, "g");
const TOUCHES_ONCE = new RegExp(TOUCHES.source);

// ---- what a write looks like, on a RESOLVED handle ------------------------
const MINT_TAIL = String.raw`\s*\.\s*items\s*\.\s*(?:upsert|bulk|create)\s*\(`;
const MUTATE_TAIL = String.raw`\s*\.\s*item\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:patch|replace|delete)\s*\(`;
// ---- the same, loosely, for a file where no handle resolves ---------------
const LOOSE_MINT = new RegExp(String.raw`\bitems\s*\.\s*(?:upsert|bulk|create)\s*\(`);
const LOOSE_MUTATE = new RegExp(String.raw`\.item\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:patch|replace|delete)\s*\(`);

// ---- the canonical path: a real call or a real import, never prose --------
const CANONICAL_CALL = /\b(?:upsertCatalogEntry|deriveCatalogEntry)\s*\(/;
const CANONICAL_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*\b(?:upsertCatalogEntry|deriveCatalogEntry)\b[^}]*\}\s*from\s*["'][^"']*cardCatalog\.service(?:\.js)?["']/;
const CANONICAL_REQUIRE =
  /\{[^}]*\b(?:upsertCatalogEntry|deriveCatalogEntry)\b[^}]*\}\s*=\s*require\s*\((?:[^()]|\([^()]*\))*cardCatalog\.service(?:\.js)?["'](?:[^()]|\([^()]*\))*\)/;
// ---- the row-ops path (D5 PR 2): the compliant way to move or retire a row
const ROW_OPS_CALL = /\b(?:moveCatalogRow|retireCatalogRow)\s*\(/;
const ROW_OPS_IMPORT = /(?:from\s*|require\s*\(\s*)["'][^"']*catalogRowOps\.service(?:\.js)?["']/;

/**
 * Movers: scripts that MOVE a card_catalog row (upsert at the new slug,
 * re-point sales, delete the old row) by hand. Keyed to "imports
 * catalogRowOps": the moment one does, the stale check below makes it leave
 * BYPASSING and this list -- it self-empties. The seven setKey movers the
 * 2026-08-29 census found (apply-setkey-rulings, clean-parallel-annotations,
 * map-derived-parallels-to-rungs, map-pokemon-setkeys-to-checklist,
 * map-yearprefixed-setkeys, rename-setkey, repair-pokemon-glued-numbers) were
 * converted in D5 PR 3 and left; the seven allowlisted movers (dedupe-catalog-
 * by-hobbyiq, dedupe-catalog-partition-shadows, dedupe-catalog-setkeys,
 * migrate-catalog-setkey, priorityCatalogReslug, rehome-catalog-rows-to-own-
 * partition, reslugCatalogFromCurrent) in D5 PR 4. A new hand-rolled mover is
 * listed here until it goes through moveCatalogRow.
 */
const MOVERS = new Set<string>();

/**
 * Writers that hand-roll a catalog ROW (items.upsert / bulk / create on the
 * card_catalog handle) without the builder. Measured 2026-08-29: 62;
 * re-measured after D5 PR 3 moved the seven movers onto catalogRowOps: 54;
 * re-measured after D5 PR 5 deleted the 25 dead minters (sales never mint,
 * #1353; vendor feeds never mint, #1362): 29; after D5 PR 4 moved the seven
 * allowlisted movers onto catalogRowOps: 22.
 * Versus the 2026-08-26 list: the five sold_comps writers and the two ebay
 * services (PR 6, #1403/#1404) are gone; the two comment-match "canonical"
 * files, the capital-C `getContainer` cardsight crawler and the env-fallback
 * seedCardCatalog are newly visible.
 */
const BYPASSING = new Set([
  // A hand-rolled mover is debt here (via MOVERS) until it imports catalogRowOps.
  ...MOVERS,
  "backend/scripts/attachImagesToCatalog.cjs",
  "backend/scripts/auto-label-catalog-variants.cjs",
  "backend/scripts/backfill-canonicalize-chrome-slugs.cjs",
  "backend/scripts/backfill-catalog-cs-images.cjs",
  "backend/scripts/backfill-cs-card-population.cjs",
  "backend/scripts/backfill-searchtokens-all-sports.cjs",
  "backend/scripts/cleanupNullPartitionCatalogRows.cjs",
  "backend/scripts/comp-quality/backfill-search-fields.cjs",
  "backend/scripts/comp-quality/create-product-line-cards-from-base.cjs",
  "backend/scripts/comp-quality/create-tiffany-cards-from-base.cjs",
  "backend/scripts/explodeCatalogGrades.cjs",
  "backend/scripts/fix-catalog-parallel-as-player.cjs",
  "backend/scripts/import-bccp-to-catalog.ts",
  "backend/scripts/import-clc-to-catalog.ts",
  "backend/scripts/match-catalog-to-alt-sources.ts",
  "backend/scripts/match-catalog-to-bccp.ts",
  "backend/scripts/match-catalog-to-xlsx.ts",
  "backend/scripts/normalize-catalog-format.cjs",
  "backend/scripts/normalize-catalog-schema.cjs",
  "backend/scripts/normalizeVendorRows.cjs",
  "backend/scripts/resport-mistagged-pokemon.cjs",
  "backend/src/services/portfolioiq/catalogReview.service.ts",
]);

/**
 * Writers that only PATCH / REPLACE / DELETE existing card_catalog rows by
 * hand (never mint one). Measured 2026-08-29: 41, every one invisible to the
 * 2026-08-26 guard. Safer than a minter -- a patcher cannot invent a row
 * shape -- but a patch that touches setKey, id fields or searchTokens is
 * still a hand-rolled move, which is catalogRowOps' job. A file on this list
 * that starts minting fails the guard as a new minter; it does not get to
 * hide here.
 */
const MUTATORS_BYPASSING = new Set([
  "backend/scripts/annotate-checklist-backing.cjs",
  "backend/scripts/attach-sales-summary-to-catalog.ts",
  "backend/scripts/auditSetKeyFieldMismatch.cjs",
  "backend/scripts/backfill-catalog-images-from-pool.cjs",
  "backend/scripts/backfill-playerslug.cjs",
  "backend/scripts/backfillCardYearField.cjs",
  "backend/scripts/backfillCatalogCardYearFromSlug.cjs",
  "backend/scripts/backfillCatalogHiqSlug.cjs",
  "backend/scripts/backfillCatalogPlayerSlug.cjs",
  "backend/scripts/backfillOrphanCatalogSlugs.cjs",
  "backend/scripts/clear-dead-catalog-images.cjs",
  "backend/scripts/comp-quality/consolidate-draft-chrome-overlap.cjs",
  "backend/scripts/comp-quality/remove-parallel-list-phantoms.cjs",
  "backend/scripts/conform-card-profile.cjs",
  "backend/scripts/consolidate-bowman-draft-catalog.cjs",
  "backend/scripts/dedupe-catalog-rows.cjs",
  "backend/scripts/dedupeCatalogBySlug.cjs",
  "backend/scripts/delete-corrupted-canonical.cjs",
  "backend/scripts/deleteGarbageCatalogSources.cjs",
  "backend/scripts/deleteVladOldCatalog.cjs",
  "backend/scripts/fastPatchIdIsSlug.cjs",
  "backend/scripts/graft-catalog-sibling-images.cjs",
  "backend/scripts/hashReferenceImages.ts",
  "backend/scripts/nukeCatalogFragmentation.cjs",
  "backend/scripts/nukeCatalogRuleBased.cjs",
  "backend/scripts/nukeSalesDerivedCatalog.cjs",
  "backend/scripts/purge-old-sales-derived.cjs",
  "backend/scripts/repair-cardsight-catalog-stubs.cjs",
  "backend/scripts/repair-catalog-string-year.cjs",
  "backend/scripts/repair-catalog-variant-slugs.cjs",
  "backend/scripts/repair-parallel-player-names.cjs",
  "backend/scripts/repair-setkey-punctuation.cjs",
  "backend/scripts/retire-autoseed-window.cjs",
  "backend/scripts/retire-exploded-checklist-rows.cjs",
  "backend/scripts/retire-flattened-attestations.cjs",
  "backend/scripts/retire-impossible-grade-rows.cjs",
  "backend/scripts/retire-numbered-base-rows.cjs",
  "backend/scripts/retire-prose-parallel-rows.cjs",
  "backend/scripts/retire-unreferenced-graded-rows.cjs",
  "backend/scripts/revert-parallel-player-repair.cjs",
  "backend/scripts/unify-catalog-setkeys.cjs",
]);

// ============================================================================
// Resolving the handle. Text-level, deliberately small; every heuristic here
// is one the census found in a real file.
// ============================================================================

const KEYWORDS = new Set(["if", "while", "for", "switch", "catch", "return", "typeof", "await", "new", "function", "async"]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isWord = (c: string) => /[\w$]/.test(c);

/** Drop `//` and `/* *\/` comments, leaving strings and regex literals intact. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // Is a `/` at this point the start of a regex literal (vs. division)?
  const regexOk = () => {
    let j = out.length - 1;
    while (j >= 0 && isWs(out.charAt(j))) j--;
    if (j < 0) return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(out.charAt(j))) return true;
    return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|throw|new|delete|await|yield)$/.test(out.slice(Math.max(0, j - 6), j + 1));
  };
  while (i < n) {
    const c = src.charAt(i);
    const d = src.charAt(i + 1);
    if (c === "/" && d === "/") { while (i < n && src.charAt(i) !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out += " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < n && src.charAt(i) !== c) {
        if (src.charAt(i) === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src.charAt(i); i++;
      }
      out += src.charAt(i); i++;
      continue;
    }
    if (c === "/" && regexOk()) {
      out += c; i++;
      let inClass = false;
      while (i < n && src.charAt(i) !== "\n") {
        const r = src.charAt(i);
        if (r === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) { out += "/"; i++; break; }
        out += r; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Name of the nearest function declared before `idx` (the one a `return` at idx belongs to). */
function enclosingFnName(src: string, idx: number): string | null {
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
  const pre = src.slice(0, idx);
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(pre))) last = m[1] ?? m[2] ?? null;
  return last;
}

/** Parameter name at position `pos` of a function declared IN THIS FILE, or null. */
function localParam(src: string, name: string, pos: number): string | null {
  const re = new RegExp(
    String.raw`(?:function\s+${esc(name)}\s*\(([^)]*)\)|(?:const|let|var)\s+${esc(name)}\s*=\s*(?:async\s*)?(?:function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>))`,
  );
  const m = re.exec(src);
  if (!m) return null;
  const list = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
  const params = list.split(",").map((p) => p.trim().replace(/^\.\.\./, "").replace(/[:=].*$/, "").trim()).filter(Boolean);
  return params[pos] ?? null;
}

/** Identifier before the `(` at parenIdx -- null for a method call (`.foo(`) or a keyword. */
function calleeBefore(src: string, parenIdx: number): string | null {
  let e = parenIdx - 1;
  while (e >= 0 && isWs(src.charAt(e))) e--;
  let s = e;
  while (s >= 0 && isWord(src.charAt(s))) s--;
  const name = src.slice(s + 1, e + 1);
  if (!name || KEYWORDS.has(name) || src.charAt(s) === ".") return null;
  return name;
}

/** Which argument (0-based) of the call opened at parenIdx contains index idx. */
function argPosition(src: string, parenIdx: number, idx: number): number {
  let depth = 0;
  let pos = 0;
  for (let i = parenIdx + 1; i < idx; i++) {
    const c = src.charAt(i);
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) pos++;
  }
  return pos;
}

type Binding = { name: string; idx: number; param?: boolean };
type Analysis = { mint: boolean; mutate: boolean; resolved: number; unresolved: string[] };

/**
 * Pair every card_catalog handle in `src` with the writes made THROUGH it.
 *
 *   inline      `.container("card_catalog").items.upsert(`
 *   binding     `cat = db.container("card_catalog")`   (const/let/comma-decl/this.x)
 *   argument    `helper(db.container("card_catalog"))` -> helper's local param
 *   getter      `return db.container(...)` / `return _cached` -> `x = getter()`
 *   escape      `helper(cat)`                            -> helper's local param
 *   re-binding  `container = getContainer("card_population")` after a
 *               catalog binding ends that binding's reach (scope by span)
 */
function analyze(src: string): Analysis {
  const bindings: Binding[] = [];
  const getters = new Set<string>();
  const unresolved: string[] = [];
  let resolved = 0;
  let mint = false;
  let mutate = false;

  TOUCHES.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOUCHES.exec(src))) {
    const start = m.index;
    const end = start + m[0].length;
    let k = end;
    while (k < src.length && isWs(src.charAt(k))) k++;
    if (src.charAt(k) === ".") {
      resolved++;
      const rest = src.slice(end, end + 400);
      if (new RegExp("^" + MINT_TAIL).test(rest)) mint = true;
      if (new RegExp("^" + MUTATE_TAIL).test(rest)) mutate = true;
      continue;
    }
    // Walk back to the `=` (a binding), the `(` (an argument), or a `return`.
    let depth = 0;
    let i = start - 1;
    let done = false;
    while (i >= 0 && !done) {
      const ch = src.charAt(i);
      if (ch === ")" || ch === "]" || ch === "}") { depth++; i--; continue; }
      if (ch === "(" || ch === "[" || ch === "{") {
        if (depth === 0) {
          if (ch === "(") {
            const callee = calleeBefore(src, i);
            const p = callee ? localParam(src, callee, argPosition(src, i, start)) : null;
            if (p) { bindings.push({ name: p, idx: start, param: true }); resolved++; }
            else unresolved.push(`argument to ${callee ?? "a method"}`);
          } else unresolved.push("literal element");
          done = true;
          break;
        }
        depth--; i--; continue;
      }
      if (depth > 0) { i--; continue; }
      if (ch === ";") { unresolved.push("bare statement"); done = true; break; }
      if (ch === ">" && src.charAt(i - 1) === "=") {
        // `NAME = (...) => db.container(...)` -- an arrow getter.
        let j = i - 2;
        let pd = 0;
        while (j >= 0) {
          const cj = src.charAt(j);
          if (cj === ")") pd++; else if (cj === "(") pd--; else if (pd === 0 && cj === "=") break;
          j--;
        }
        if (j >= 0) {
          let e = j - 1;
          while (e >= 0 && isWs(src.charAt(e))) e--;
          let s = e;
          while (s >= 0 && /[\w$.]/.test(src.charAt(s))) s--;
          const name = src.slice(s + 1, e + 1);
          if (name) { getters.add(name); resolved++; done = true; break; }
        }
        unresolved.push("arrow"); done = true; break;
      }
      if (ch === "=") {
        const prev = src.charAt(i - 1);
        const next = src.charAt(i + 1);
        if (prev === "=" || prev === "!" || prev === "<" || prev === ">" || next === "=") { unresolved.push("comparison"); done = true; break; }
        let e = i - 1;
        while (e >= 0 && isWs(src.charAt(e))) e--;
        let s = e;
        while (s >= 0 && /[\w$.]/.test(src.charAt(s))) s--;
        const name = src.slice(s + 1, e + 1);
        if (name) { bindings.push({ name, idx: start }); resolved++; } else unresolved.push("assignment to no name");
        done = true; break;
      }
      if (isWord(ch)) {
        let s = i;
        while (s >= 0 && isWord(src.charAt(s))) s--;
        if (src.slice(s + 1, i + 1) === "return") {
          const fn = enclosingFnName(src, s + 1);
          if (fn) { getters.add(fn); resolved++; } else unresolved.push("returned from an anonymous function");
          done = true; break;
        }
        i = s; continue;
      }
      i--;
    }
    if (!done) unresolved.push("start of file");
  }

  // Fixpoint: getters name bindings (`x = getter()`), bindings name getters
  // (`return x`), and a binding passed to a local helper names its parameter.
  const seenEscape = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of [...getters]) {
      const re = new RegExp(String.raw`([\w$.]+)\s*=\s*(?:await\s+)?${esc(g)}\s*\(\s*\)`, "g");
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(src))) {
        const name = mm[1] ?? "";
        if (name && !bindings.some((b) => b.name === name && b.idx === mm!.index)) { bindings.push({ name, idx: mm.index }); changed = true; }
      }
    }
    for (const b of [...bindings]) {
      const rr = new RegExp(String.raw`return\s+${esc(b.name)}\s*[;\n}]`, "g");
      let mm: RegExpExecArray | null;
      while ((mm = rr.exec(src))) {
        const fn = enclosingFnName(src, mm.index);
        if (fn && !getters.has(fn)) { getters.add(fn); changed = true; }
      }
      const er = new RegExp(String.raw`([A-Za-z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*?)(?<![\w$.])${esc(b.name)}\s*[,)]`, "g");
      let em: RegExpExecArray | null;
      while ((em = er.exec(src))) {
        const key = `${em.index}:${b.name}`;
        if (seenEscape.has(key)) continue;
        seenEscape.add(key);
        const callee = em[1] ?? "";
        if (!callee || KEYWORDS.has(callee) || src.charAt(em.index - 1) === ".") continue;
        const parenIdx = em.index + em[0].indexOf("(");
        const p = localParam(src, callee, argPosition(src, parenIdx, em.index + em[0].length - 1));
        if (p) { if (!bindings.some((x) => x.name === p)) { bindings.push({ name: p, idx: em.index, param: true }); changed = true; } }
        else unresolved.push(`${b.name} escapes into ${callee}`);
      }
    }
  }

  // A name re-bound to something that is NOT the catalog ends the reach of
  // the catalog binding before it (cardsight's `container` is card_catalog in
  // one function and card_population in the next). A helper's parameter is
  // one identity for every call, so it is never scoped.
  const conflicts = new Map<string, number[]>();
  for (const name of new Set(bindings.map((b) => b.name))) {
    const list: number[] = [];
    const re = new RegExp(String.raw`(?<![\w$.])${esc(name)}\s*=\s*(?:await\s+)?(?:([A-Za-z_$][\w$]*)\s*\(\s*\)|[^;=]*?[cC]ontainer\s*\()`, "g");
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(src))) {
      if (mm[1] !== undefined) { if (!getters.has(mm[1])) list.push(mm.index); continue; }
      const open = mm.index + mm[0].length - 1;
      let d = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src.charAt(j) === "(") d++;
        else if (src.charAt(j) === ")") { d--; if (d === 0) break; }
      }
      if (!IS_CATALOG_ARG.test(src.slice(open + 1, j))) list.push(mm.index);
    }
    if (list.length) conflicts.set(name, list.sort((a, b) => a - b));
  }

  for (const b of bindings) {
    const conf = b.param ? undefined : conflicts.get(b.name);
    let end = src.length;
    if (conf) { const next = conf.find((c) => c > b.idx); if (next !== undefined) end = next; }
    const span = conf ? src.slice(b.idx, end) : src;
    const head = String.raw`(?<![\w$.])${esc(b.name)}`;
    if (new RegExp(head + MINT_TAIL).test(span)) mint = true;
    if (new RegExp(head + MUTATE_TAIL).test(span)) mutate = true;
  }
  for (const g of getters) {
    for (const head of [String.raw`(?<![\w$.])${esc(g)}\s*\(\s*\)`, String.raw`\(\s*await\s+${esc(g)}\s*\(\s*\)\s*\)`]) {
      if (new RegExp(head + MINT_TAIL).test(src)) mint = true;
      if (new RegExp(head + MUTATE_TAIL).test(src)) mutate = true;
    }
  }
  return { mint, mutate, resolved, unresolved };
}

type Kind = "canonical" | "row-ops" | "minter" | "mutator";
type Writer = { rel: string; kind: Kind; mint: boolean; mutate: boolean; fallback: string | null };

function classify(rel: string, raw: string): Writer | null {
  const src = stripComments(raw);
  if (!TOUCHES_ONCE.test(src)) return null;
  const a = analyze(src);
  const canonical = CANONICAL_CALL.test(src) || CANONICAL_IMPORT.test(src) || CANONICAL_REQUIRE.test(src);
  const rowOps = ROW_OPS_CALL.test(src) || ROW_OPS_IMPORT.test(src);
  let { mint, mutate } = a;
  let fallback: string | null = null;
  if ((a.resolved === 0 || a.unresolved.length > 0) && !mint && !mutate) {
    // Nothing paired and at least one handle we could not follow: the loose
    // text match decides, and the file is reported.
    fallback = [...new Set(a.unresolved)].join("; ") || "no handle resolved";
    mint = LOOSE_MINT.test(src);
    mutate = LOOSE_MUTATE.test(src);
  }
  if (!mint && !mutate && !canonical && !rowOps) return null;
  const kind: Kind = canonical ? "canonical" : rowOps && !mint ? "row-ops" : mint ? "minter" : "mutator";
  return { rel, kind, mint, mutate, fallback };
}

const compliant = (w: Writer) => w.kind === "canonical" || w.kind === "row-ops";

let cache: Writer[] | null = null;
function catalogWriters(): Writer[] {
  if (cache) return cache;
  const out: Writer[] = [];
  for (const dir of ["backend/src", "backend/scripts"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|cjs|js|mjs)$/.test(e.name)) continue;
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        if (rel === CANONICAL_HOME || rel === ROW_OPS_HOME) continue;
        let src = "";
        try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
        const w = classify(rel, src);
        if (w) out.push(w);
      }
    };
    walk(base);
  }
  cache = out.sort((a, b) => a.rel.localeCompare(b.rel));
  return cache;
}

const lines = (xs: string[]) => (xs.length ? `\n  ${xs.join("\n  ")}` : "");

describe("one way to build a catalog row", () => {
  // CF-CHRONIC-REDS-SLOW (2026-09-03). This census walks every file under
  // backend/src AND backend/scripts and reads each one to classify catalog
  // writers -- several thousand readFileSync calls. Measured at 79s IN
  // ISOLATION on a cold clone, so the 30s default is simply below the honest
  // cost of the work; it is not flake and not parallel-load contention. The
  // scan is the point of the test (a writer it never reads is a writer it
  // cannot police), so the fix is to let it finish rather than narrow what it
  // walks. Assertions below are untouched.
  it("finds the writers, and says which it could only text-match", { timeout: 240_000 }, () => {
    const all = catalogWriters();
    expect(all.length).toBeGreaterThan(20);
    const loose = all.filter((w) => w.fallback).map((w) => `${w.rel}  [${w.fallback}]`);
    // eslint-disable-next-line no-console
    console.log(loose.length
      ? `catalog writers matched loosely (no handle resolved -- may be a false positive):${lines(loose)}`
      : `every card_catalog handle resolved to a name; no loose fallback used`);
  });

  it("no NEW writer may hand-roll a catalog row", () => {
    const rogue = catalogWriters()
      .filter((w) => !compliant(w) && !BYPASSING.has(w.rel) && !MUTATORS_BYPASSING.has(w.rel))
      .map((w) => `${w.rel}  (${w.kind})`);
    expect(rogue, `these write card_catalog by hand -- a minter without deriveCatalogEntry/upsertCatalogEntry, or a mutator without catalogRowOps -- and are on neither debt list:${lines(rogue)}`)
      .toEqual([]);
  });

  it("the debt lists only name files that still bypass, each on the right list", () => {
    // Once converted (or gone), a name must come OUT, or the list stops
    // meaning anything and silently re-permits the next regression. And a
    // minter belongs on BYPASSING, a patcher on MUTATORS_BYPASSING -- a
    // patcher that starts minting is a NEW minter, not a mutator.
    const byRel = new Map(catalogWriters().map((w) => [w.rel, w] as const));
    const stale: string[] = [];
    const misfiled: string[] = [];
    const promoted: string[] = [];
    const gone = (rel: string) => (fs.existsSync(path.join(ROOT, rel)) ? "no longer writes card_catalog" : "file deleted");
    for (const rel of BYPASSING) {
      const w = byRel.get(rel);
      if (!w) stale.push(`${rel}  (${gone(rel)})`);
      else if (compliant(w)) stale.push(`${rel}  (converted: ${w.kind})`);
      else if (!w.mint) misfiled.push(`${rel}  (patches only -- belongs on MUTATORS_BYPASSING)`);
    }
    for (const rel of MUTATORS_BYPASSING) {
      const w = byRel.get(rel);
      if (!w) stale.push(`${rel}  (${gone(rel)})`);
      else if (compliant(w)) stale.push(`${rel}  (converted: ${w.kind})`);
      else if (w.mint) promoted.push(rel);
    }
    expect(stale, `converted or gone but still listed as debt -- remove:${lines(stale)}`).toEqual([]);
    expect(misfiled, `listed as a minter but only patches -- move to MUTATORS_BYPASSING so the minter count stays honest:${lines(misfiled)}`).toEqual([]);
    expect(promoted, `a patcher started MINTING rows. That is a new hand-rolled minter; it does not get to hide on the mutator list:${lines(promoted)}`).toEqual([]);
  });

  it("the setKey movers leave the debt list by importing catalogRowOps", () => {
    const byRel = new Map(catalogWriters().map((w) => [w.rel, w] as const));
    const landed = fs.existsSync(path.join(ROOT, ROW_OPS_HOME));
    const converted = [...MOVERS].filter((rel) => !byRel.has(rel) || compliant(byRel.get(rel)!));
    const notDebt = [...MOVERS].filter((rel) => !BYPASSING.has(rel) && !MUTATORS_BYPASSING.has(rel));
    // eslint-disable-next-line no-console
    console.log(landed
      ? `catalogRowOps.service.ts is in; movers converted ${converted.length}/${MOVERS.size}`
      : `catalogRowOps.service.ts has not landed (D5 PR 2); ${MOVERS.size} movers waiting`);
    expect(notDebt, `a mover is debt until it imports catalogRowOps -- list it in BYPASSING or drop it from MOVERS:${lines(notDebt)}`).toEqual([]);
    expect(converted, `converted (or gone) -- remove from MOVERS and from BYPASSING:${lines(converted)}`).toEqual([]);
  });

  it("the debt is measured, so it can be seen shrinking", () => {
    const all = catalogWriters();
    const ok = all.filter(compliant).length;
    const minters = all.filter((w) => w.kind === "minter").length;
    const mutators = all.filter((w) => w.kind === "mutator").length;
    // eslint-disable-next-line no-console
    console.log(`catalog writers on the builder or catalogRowOps: ${ok}/${all.length}  (hand-rolled minters ${minters}, hand-rolled mutators ${mutators})`);
    // Measured floor, not an aspiration: the 2026-08-29 census found 9 of 112
    // writers on the canonical path (ensureCatalogRow plus eight scripts that
    // require the builder from dist/); re-measured after D5 PR 3 put the seven
    // movers on catalogRowOps: 17 of 112; after D5 PR 5 deleted 25 dead
    // hand-rolled minters (none compliant): still 17, of 87; after D5 PR 4
    // put the seven allowlisted movers on catalogRowOps: 24 of 87. It can
    // only go up -- if it drops, a writer was converted back to hand-rolling
    // or the matcher above regressed. Deleting a compliant writer lowers it
    // legitimately; re-measure and change the number in that PR. D15 added
    // three row-ops scripts (repair-trailing-comma-player-names, repair-isauto-
    // from-cardnumber-catalog, conform-one-of-one-parallels): 28 of 91.
    expect(ok).toBeGreaterThanOrEqual(28);
  });
});
