#!/usr/bin/env node
/**
 * CF-IOS-BACKEND-CONTRACT-AUDIT (Drew, 2026-07-19).
 *
 * Cross-references iOS Swift URL strings against backend Express route
 * registrations. Outputs three categories:
 *   1. Backend registered but iOS never calls → deprecation candidate
 *   2. iOS calls but backend doesn't register → dead call / bug
 *   3. Matched → healthy
 *
 * Heuristics:
 *   - iOS: greps `/api/...` string literals in HobbyIQ/**\/*.swift
 *   - Backend: reads app.ts for `app.use("/api/x", xRoutes)` mounts,
 *     then reads each mounted router file for `router.METHOD("/path"`
 *     and concatenates.
 *   - Normalizes both sides: numeric IDs, alphanumeric UUIDs, and
 *     :param placeholders → single :param token so comparison is
 *     shape-based not value-based.
 *
 * Runbook:
 *   node scripts/audit-ios-backend-contract.cjs
 *   node scripts/audit-ios-backend-contract.cjs --format=json > audit.json
 *
 * Zero writes. Read-only. Runs in ~1 sec.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const IOS_DIR = path.join(REPO_ROOT, "HobbyIQ");
const BACKEND_SRC = path.join(REPO_ROOT, "backend", "src");
const APP_TS = path.join(BACKEND_SRC, "app.ts");

// ─────────────────────────────────────────────────────────────────────
// Path normalization: strip real values so `/api/players/Bobby%20Witt`
// and `router.get("/:name")` both compare as `/api/players/:param`.

function normalizePath(p) {
  return p
    .replace(/\?.*$/, "")                                  // strip query string
    .replace(/\/(\d+)(?=\/|$)/g, "/:param")                // numeric ids
    .replace(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi, "/:param")  // UUIDs
    .replace(/\/(:[A-Za-z_][A-Za-z0-9_]*)/g, "/:param")    // :name → :param
    .replace(/\/\{[^/}]+\}/g, "/:param")                   // {name} → :param
    .replace(/\/`[^`]*`/g, "/:param")                      // Swift interpolation with backticks
    .replace(/\/\\?\([^)]*\)/g, "/:param")                 // Swift interpolation \(x)
    .replace(/\/\$\{[^}]*\}/g, "/:param")                  // JS template literal
    .replace(/\/+$/, "");                                  // trailing slash
}

// ─────────────────────────────────────────────────────────────────────
// iOS side: recursive Swift file walk, grep `/api/...` string literals.

function walk(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "Pods" || entry.name === ".build") continue;
      out.push(...walk(full, filter));
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Match `/api/…` string literals in Swift. Trailing delimiters
// tolerated: quote, backtick, `?`, `)`, whitespace, period, comma. The
// captured group EXCLUDES the trailing delimiter and any Swift
// string-interpolation opening (`\(` or backtick) which we then
// separately treat as a `:param` placeholder.
const IOS_URL_RE = /(\/api\/[a-zA-Z][a-zA-Z0-9/_-]*(?:\/(?:\\\([^)]*\)|\{[^}]*\}|:[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z0-9_-]+))*)/g;

function collectIosEndpoints() {
  const files = walk(IOS_DIR, (n) => n.endsWith(".swift"));
  const found = new Map();   // normalized → { count, examples: Set<file:line> }
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      IOS_URL_RE.lastIndex = 0;
      while ((m = IOS_URL_RE.exec(line))) {
        const raw = m[1].replace(/["'?)\s].*$/, "");
        const norm = normalizePath(raw);
        if (!norm.startsWith("/api/")) continue;
        if (!found.has(norm)) found.set(norm, { count: 0, examples: new Set() });
        const entry = found.get(norm);
        entry.count++;
        if (entry.examples.size < 3) {
          entry.examples.add(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
        }
      }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────
// Backend side: parse app.ts for router mounts, then per-router files.

function parseAppMounts() {
  if (!fs.existsSync(APP_TS)) return [];
  const src = fs.readFileSync(APP_TS, "utf8");
  const mounts = [];
  const importRe = /^import\s+(\w+)\s+from\s+["']\.\/routes\/([\w.-]+)\.js["']/gm;
  const useRe = /app\.use\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/g;
  const nameToFile = new Map();
  let m;
  while ((m = importRe.exec(src))) {
    nameToFile.set(m[1], m[2]);
  }
  while ((m = useRe.exec(src))) {
    const basePath = m[1];
    const routerName = m[2];
    const routerFile = nameToFile.get(routerName);
    if (!routerFile) continue;
    mounts.push({ basePath, routerFile });
  }
  return mounts;
}

const METHODS = ["get", "post", "put", "patch", "delete", "all"];
const ROUTE_RE = new RegExp(
  String.raw`\brouter\.(${METHODS.join("|")})\(\s*["'\`]([^"'\`]+)["'\`]`,
  "g",
);

function collectBackendEndpoints(mounts) {
  const found = new Map();
  for (const { basePath, routerFile } of mounts) {
    const full = path.join(BACKEND_SRC, "routes", `${routerFile}.ts`);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let m;
      ROUTE_RE.lastIndex = 0;
      while ((m = ROUTE_RE.exec(lines[i]))) {
        const method = m[1].toUpperCase();
        const relPath = m[2];
        const fullPath = (basePath + relPath).replace(/\/+/g, "/");
        const norm = normalizePath(fullPath);
        const key = `${method} ${norm}`;
        if (!found.has(key)) found.set(key, { count: 0, source: [] });
        found.get(key).count++;
        found.get(key).source.push(`backend/src/routes/${routerFile}.ts:${i + 1}`);
      }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────
// Diff + report

function main() {
  const asJson = process.argv.includes("--format=json");

  const iosEndpoints = collectIosEndpoints();
  const backendMounts = parseAppMounts();
  const backendEndpoints = collectBackendEndpoints(backendMounts);

  // Set of just the paths (method-agnostic) since iOS grep can't easily
  // recover HTTP method from a string literal.
  const backendPaths = new Set(
    [...backendEndpoints.keys()].map((k) => k.split(" ").slice(1).join(" "))
  );
  const iosPaths = new Set(iosEndpoints.keys());

  const backendOnly = [...backendPaths].filter((p) => !iosPaths.has(p)).sort();
  const iosOnly = [...iosPaths].filter((p) => !backendPaths.has(p)).sort();
  const matched = [...iosPaths].filter((p) => backendPaths.has(p)).sort();

  const summary = {
    counts: {
      iosDistinctPaths: iosPaths.size,
      backendDistinctPaths: backendPaths.size,
      backendMounts: backendMounts.length,
      matched: matched.length,
      backendOnly: backendOnly.length,
      iosOnly: iosOnly.length,
    },
    backendOnly: backendOnly.map((p) => ({
      path: p,
      methods: [...backendEndpoints.keys()]
        .filter((k) => k.endsWith(" " + p))
        .map((k) => k.split(" ")[0])
        .sort(),
    })),
    iosOnly: iosOnly.map((p) => ({
      path: p,
      usages: iosEndpoints.get(p).count,
      examples: [...iosEndpoints.get(p).examples],
    })),
    matched: matched.map((p) => ({
      path: p,
      backendMethods: [...backendEndpoints.keys()]
        .filter((k) => k.endsWith(" " + p))
        .map((k) => k.split(" ")[0])
        .sort(),
      iosUsages: iosEndpoints.get(p).count,
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Human-friendly report
  console.log("=".repeat(72));
  console.log("iOS ↔ Backend Contract Audit");
  console.log("=".repeat(72));
  console.log("");
  console.log(`iOS distinct paths:     ${summary.counts.iosDistinctPaths}`);
  console.log(`Backend distinct paths: ${summary.counts.backendDistinctPaths}`);
  console.log(`Backend mounts:         ${summary.counts.backendMounts}`);
  console.log(`Matched:                ${summary.counts.matched}`);
  console.log(`Backend-only:           ${summary.counts.backendOnly}  (deprecation candidates)`);
  console.log(`iOS-only:               ${summary.counts.iosOnly}  (dead calls / bugs)`);
  console.log("");

  console.log("─".repeat(72));
  console.log("BACKEND-ONLY (registered but iOS never calls)");
  console.log("─".repeat(72));
  if (backendOnly.length === 0) console.log("  (none)");
  for (const { path, methods } of summary.backendOnly) {
    console.log(`  ${methods.join(",").padEnd(12)} ${path}`);
  }
  console.log("");

  console.log("─".repeat(72));
  console.log("iOS-ONLY (iOS calls but backend doesn't register)");
  console.log("─".repeat(72));
  if (iosOnly.length === 0) console.log("  (none)");
  for (const { path, usages, examples } of summary.iosOnly) {
    console.log(`  ${path}  (${usages} usages)`);
    for (const ex of examples.slice(0, 2)) console.log(`      ${ex}`);
  }
  console.log("");

  console.log("─".repeat(72));
  console.log(`MATCHED (${summary.counts.matched} endpoints)`);
  console.log("─".repeat(72));
  for (const { path, backendMethods, iosUsages } of summary.matched) {
    console.log(`  ${backendMethods.join(",").padEnd(12)} ${path}  (iOS: ${iosUsages}x)`);
  }
  console.log("");

  console.log("=".repeat(72));
  console.log("Notes");
  console.log("=".repeat(72));
  console.log("• Path shapes are normalized: /api/players/:param matches /api/players/Bobby%20Witt.");
  console.log("• iOS-only can be false-positives if the URL is built dynamically via template.");
  console.log("• Backend-only endpoints that are ONLY called by other backends (webhooks, cron)");
  console.log("  will show here — cross-reference with .github/workflows/ before deleting.");
  console.log("• Route paths inside admin.routes.ts / webhook.routes.ts are usually server-to-server");
  console.log("  and legitimately have zero iOS callers.");
}

main();
