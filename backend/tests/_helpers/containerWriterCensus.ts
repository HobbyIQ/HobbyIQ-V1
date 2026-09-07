/**
 * containerWriterCensus.ts -- WHO WRITES THIS CONTAINER, and did they go
 * through the one door.
 *
 * Extracted from `oneWayToBuildACatalogRow.test.ts` (2026-09-07) so the
 * sold_comps guard can police its own write path with the SAME resolver
 * rather than a second, weaker copy of it. Every heuristic in here is one
 * that census found in a real file; the notes on each are in the catalog
 * test, which is still the worked example.
 *
 * It is TEXT-LEVEL and it says so: it cannot know what a script does at
 * RUNTIME, only whether it hand-rolled a container write instead of calling
 * the shared path. That is enough, because hand-rolling is where every one of
 * these defects came from.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const ROOT = path.join(__dirname, "..", "..", "..");

// ---- what a write looks like, on a RESOLVED handle ------------------------
const MINT_TAIL = String.raw`\s*\.\s*items\s*\.\s*(?:upsert|bulk|create)\s*\(`;
const MUTATE_TAIL = String.raw`\s*\.\s*item\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:patch|replace|delete)\s*\(`;
// ---- the same, loosely, for a file where no handle resolves ---------------
const LOOSE_MINT = new RegExp(String.raw`\bitems\s*\.\s*(?:upsert|bulk|create)\s*\(`);
const LOOSE_MUTATE = new RegExp(String.raw`\.item\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:patch|replace|delete)\s*\(`);


/** One file that writes the container, and how it was matched. */
export type ContainerWriter = {
  /** Repo-relative, forward slashes. */
  rel: string;
  /** It creates or replaces whole documents (`items.upsert/create/bulk`). */
  mint: boolean;
  /** It patches / replaces / deletes an addressed document. */
  mutate: boolean;
  /** Non-null when no handle resolved and the loose text match decided. */
  fallback: string | null;
};

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
function analyze(src: string, TOUCHES: RegExp, IS_CONTAINER_ARG: RegExp): Analysis {
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
      if (!IS_CONTAINER_ARG.test(src.slice(open + 1, j))) list.push(mm.index);
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

/** The handle shapes: `.container("x")`, `.container(process.env.Y ?? "x")`. */
function containerRegexes(containerName: string) {
  const ARG = String.raw`\s*(?:process\.env\.[A-Za-z_]+\s*(?:\?\?|\|\|)\s*)?["']${esc(containerName)}["']\s*`;
  return {
    IS_CONTAINER_ARG: new RegExp(`^${ARG}$`),
    TOUCHES: new RegExp(String.raw`[A-Za-z_]*[cC]ontainer\s*\(${ARG}\)`, "g"),
    TOUCHES_ONCE: new RegExp(String.raw`[A-Za-z_]*[cC]ontainer\s*\(${ARG}\)`),
  };
}

/**
 * Walk `dirs` (repo-relative) and return every file that WRITES `containerName`.
 * `skip` names files the caller handles itself (the canonical writer, say).
 */
export function containerWriters(opts: {
  containerName: string;
  dirs: string[];
  skip?: ReadonlySet<string>;
}): ContainerWriter[] {
  const { IS_CONTAINER_ARG, TOUCHES, TOUCHES_ONCE } = containerRegexes(opts.containerName);
  const skip = opts.skip ?? new Set<string>();
  const out: ContainerWriter[] = [];
  for (const dir of opts.dirs) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|cjs|js|mjs)$/.test(e.name)) continue;
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        if (skip.has(rel)) continue;
        let raw = "";
        try { raw = fs.readFileSync(p, "utf8"); } catch { continue; }
        const src = stripComments(raw);
        if (!TOUCHES_ONCE.test(src)) continue;
        const a = analyze(src, TOUCHES, IS_CONTAINER_ARG);
        let { mint, mutate } = a;
        let fallback: string | null = null;
        if ((a.resolved === 0 || a.unresolved.length > 0) && !mint && !mutate) {
          fallback = [...new Set(a.unresolved)].join("; ") || "no handle resolved";
          mint = LOOSE_MINT.test(src);
          mutate = LOOSE_MUTATE.test(src);
        }
        // `items.bulk` carries EITHER shape. A bulk of `operationType: "Patch"`
        // operations mutates rows that already exist and mints nothing --
        // relink-sold-comps-to-tree.ts is exactly that -- so calling it a
        // minter would demand an identity guard on a write that supplies no
        // identity. Only a bulk that Creates, Upserts or Replaces mints.
        if (mint && !/\bitems\s*\.\s*(?:upsert|create)\s*\(/.test(src)) {
          const bulkMints = /operationType\s*:\s*(?:"|')(?:Create|Upsert|Replace)(?:"|')/.test(src);
          if (!bulkMints) { mint = false; mutate = true; }
        }
        if (!mint && !mutate) continue;
        out.push({ rel, mint, mutate, fallback });
      }
    };
    walk(base);
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Does this file's source (comments stripped) match `re`? */
export function sourceMatches(rel: string, re: RegExp): boolean {
  try { return re.test(stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"))); }
  catch { return false; }
}

export const lines = (xs: string[]) => (xs.length ? `\n  ${xs.join("\n  ")}` : "");
export { stripComments };
