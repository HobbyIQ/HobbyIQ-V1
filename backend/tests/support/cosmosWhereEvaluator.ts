/**
 * R71 (owner ruling, 2026-09-19). A small, real evaluator for the Cosmos SQL
 * WHERE-clause subset this repo's sold_comps readers actually write --
 * IS_DEFINED, NOT, =, !=, >=, >, <, STARTSWITH, CONTAINS, parenthesized AND/
 * OR, and named `@param` substitution. It exists so a reader test can prove
 * "this fixture row would/would not survive the REAL composed query text"
 * instead of trusting a `fetchAll` mock that never looks at the query at
 * all (the gap a review flagged: mocking fetchAll means a test can capture
 * the query string and assert a substring is present, but it can never
 * prove the substring actually EXCLUDES the row it claims to exclude).
 *
 * This is a MUTATION GUARD, not a general SQL engine: it throws on a clause
 * shape it does not recognize, so a future query edit that adds an
 * unsupported operator fails the test loudly rather than silently
 * evaluating to the wrong answer.
 */

export type CosmosParam = { name: string; value: string | number | boolean | null };

/** Resolve `c.<path>` (dotted paths supported) off a fixture row, or
 *  `@param` off the parameter list. Returns `undefined` when the field is
 *  absent -- the caller (IS_DEFINED / comparisons) decides what that means. */
function resolveOperand(token: string, row: Record<string, unknown>, params: CosmosParam[]): unknown {
  token = token.trim();
  if (token.startsWith("@")) {
    const p = params.find((x) => x.name === token);
    if (!p) throw new Error(`evalCosmosWhere: no parameter bound for ${token}`);
    return p.value;
  }
  if (token.startsWith("c.")) {
    const path = token.slice(2).split(".");
    let cur: unknown = row;
    for (const seg of path) {
      if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  }
  if (token === "null") return null;
  if (token === "true") return true;
  if (token === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  throw new Error(`evalCosmosWhere: unrecognized operand: ${token}`);
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && s.slice(i, i + sep.length) === sep) {
      parts.push(s.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function topLevelHas(s: string, sep: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && s.slice(i, i + sep.length) === sep) return true;
  }
  return false;
}

/** Evaluate one Cosmos WHERE-clause fragment against a fixture row + its
 *  query parameters. Throws on an unrecognized shape. */
export function evalCosmosWhere(
  clause: string,
  row: Record<string, unknown>,
  params: CosmosParam[],
): boolean {
  clause = clause.trim();

  if (clause.startsWith("(") && clause.endsWith(")")) {
    // Only strip the outer parens when they actually wrap the WHOLE clause
    // (balanced from position 0 to the end), not e.g. "(a) AND (b)".
    let depth = 0, wrapsAll = true;
    for (let i = 0; i < clause.length; i++) {
      if (clause[i] === "(") depth++;
      else if (clause[i] === ")") { depth--; if (depth === 0 && i !== clause.length - 1) { wrapsAll = false; break; } }
    }
    if (wrapsAll) return evalCosmosWhere(clause.slice(1, -1), row, params);
  }

  if (topLevelHas(clause, " OR ")) return splitTopLevel(clause, " OR ").some((c) => evalCosmosWhere(c, row, params));
  if (topLevelHas(clause, " AND ")) return splitTopLevel(clause, " AND ").every((c) => evalCosmosWhere(c, row, params));

  if (clause.startsWith("NOT ")) return !evalCosmosWhere(clause.slice(4), row, params);

  const isDefined = clause.match(/^IS_DEFINED\((c\.[\w.]+)\)$/);
  if (isDefined) return resolveOperand(isDefined[1], row, params) !== undefined;

  const startsWith = clause.match(/^STARTSWITH\((c\.[\w.]+), '((?:[^'\\]|\\.)*)'\)$/);
  if (startsWith) {
    const v = resolveOperand(startsWith[1], row, params);
    return typeof v === "string" && v.startsWith(startsWith[2]);
  }

  const contains = clause.match(/^CONTAINS\((c\.[\w.]+), '((?:[^'\\]|\\.)*)'\)$/);
  if (contains) {
    const v = resolveOperand(contains[1], row, params);
    return typeof v === "string" && v.includes(contains[2]);
  }

  // Binary comparisons: !=, >=, <=, =, >, < (order matters -- check
  // multi-char operators first so "!=" is not mis-split as "=").
  for (const op of ["!=", ">=", "<=", "=", ">", "<"]) {
    const idx = clause.indexOf(` ${op} `);
    if (idx === -1) continue;
    const left = resolveOperand(clause.slice(0, idx), row, params);
    const right = resolveOperand(clause.slice(idx + op.length + 2), row, params);
    switch (op) {
      case "=": return left === right;
      case "!=": return left !== right;
      case ">": return typeof left === "string" && typeof right === "string" ? left > right : Number(left) > Number(right);
      case "<": return typeof left === "string" && typeof right === "string" ? left < right : Number(left) < Number(right);
      case ">=": return typeof left === "string" && typeof right === "string" ? left >= right : Number(left) >= Number(right);
      case "<=": return typeof left === "string" && typeof right === "string" ? left <= right : Number(left) <= Number(right);
    }
  }

  throw new Error(`evalCosmosWhere: unrecognized clause shape: ${clause}`);
}

/** Parse `SELECT ... FROM c WHERE <clause>` and evaluate the WHERE part
 *  against a fixture row. Throws if the query has no WHERE (every reader
 *  this repo's park-exclusion tests care about has one). */
export function evalCosmosQuery(query: string, row: Record<string, unknown>, params: CosmosParam[]): boolean {
  const m = query.match(/\bWHERE\s+([\s\S]+?)(?:\s+ORDER BY\s|$)/i);
  if (!m) throw new Error("evalCosmosQuery: no WHERE clause found");
  return evalCosmosWhere(m[1].trim(), row, params);
}
