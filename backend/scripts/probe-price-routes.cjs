#!/usr/bin/env node
/**
 * probe-price-routes.cjs -- replay checklist-backed slugs through the four
 * live pricing routes and compare what each one says. READ-ONLY: HTTP reads
 * against prod plus Cosmos reads to pick the sample. One scorecard.
 *
 * D14 probe #2 (Drew, 2026-08-29: "maybe we should audit the whole app
 * too?"). The doctrine is ONE valuation path with a truthful rung label:
 * every route that prices a card must name the rung in the closed vocabulary
 * (fmvRung.ts), carry the identity it priced, and agree with the other
 * routes on the same (slug, Raw). Every defect so far had the shape "one
 * number from two computations", invisible until a probe compared surfaces.
 *
 * Sample: LIMIT checklist-backed catalog rows (checklistBacking =
 * 'checklist-confirmed' -- the field annotate-checklist-backing.cjs writes:
 * a checklist lists this card AND this parallel) spread across sports and
 * years, kept only when the exact pool (hobbyiqCardId, raw, DAYS) has at
 * least MIN_POOL sales, so a null is a route's answer, not an empty pool.
 *
 * Routes (base: prod HobbyIQ3), request shapes from compiq.routes.ts /
 * canonicalFmv.routes.ts:
 *   POST /api/compiq/price-by-id            { cardId }
 *   POST /api/compiq/canonical-fmv          { cardId }
 *   POST /api/compiq/hobbyiq-fmv            { hobbyiqCardId }
 *   GET  /api/compiq/observed-grade-curve/:cardId   (Raw entry)
 * Auth: x-session-id = TIER1_HARNESS_TOKEN (requireSession's harness
 * bypass; the runner fetches it from App Service, never echoed).
 *
 * Measures per route: % of 200s whose label (rungLabel / fmvRung / source)
 * is in the FmvRungLabel vocabulary; % whose cardIdentity.setKey equals the
 * slug's setKey segment; % null FMV. Cross-route: % of (slug, Raw) where
 * the routes disagree by > 25%; % where hobbyiq-fmv priced from a median
 * rung while its pool had >= 8 sales (the projection should have fired).
 *
 * The vocabulary is read from the TypeScript unions at run time so the
 * probe cannot drift from fmvRung.ts; a hardcoded copy is the fallback and
 * the banner says which one was used.
 *
 * <= RPS requests per second. Exit 0 on a bad number; 2 when the probe
 * cannot run (no token, auth rejected, empty sample); 3 on an exception.
 *
 * Env: COSMOS_CONNECTION_STRING, TIER1_HARNESS_TOKEN (required);
 *      LIMIT=200 (slugs; 0/empty = default); RPS=4; SEED=7; DAYS=180;
 *      MIN_POOL=3; SPORTS=baseball,football,basketball; YEARS=2016-2026;
 *      BASE=https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");

const BASE = (process.env.BASE || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net").replace(/\/+$/, "");
const TOKEN = (process.env.TIER1_HARNESS_TOKEN || "").trim();
const LIMIT = Number(process.env.LIMIT) > 0 ? Math.trunc(Number(process.env.LIMIT)) : 200;
const RPS = Number(process.env.RPS) > 0 ? Number(process.env.RPS) : 4;
const DAYS = Number(process.env.DAYS) > 0 ? Number(process.env.DAYS) : 180;
const MIN_POOL = Number(process.env.MIN_POOL) > 0 ? Number(process.env.MIN_POOL) : 3;
const SPORTS = String(process.env.SPORTS || "baseball,football,basketball").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const [Y0, Y1] = String(process.env.YEARS || "2016-2026").split("-").map(Number);
const YEARS = Array.from({ length: Math.max(1, Y1 - Y0 + 1) }, (_, i) => Y0 + i);
const SEED = Number(process.env.SEED || 7);
const DISAGREE = 0.25;
const f = (n) => Number(n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + "%" : "-");
const cell = (a, b) => `${f(a)} / ${f(b)} (${pct(a, b)})`;
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
let seed = SEED; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ── the closed vocabulary, read from the unions ─────────────────────────
const FALLBACK = {
  exact: ["exact-pool-projection", "exact-pool-last-sale", "exact-pool-leading-edge", "exact-pool-weighted-median", "exact-pool-median", "exact-pool-trajectory"],
  extra: ["cross-grade-fallback", "grade-curve-estimate", "sibling-estimate"],
  canon: ["direct-comp", "cross-parallel", "neighbor-parallel", "sibling-parallel", "hot-raw-same-card-anchor", "family-baseline", "product-tier", "tiered-momentum-card", "tiered-momentum-player", "no-basis"],
  hiq: ["direct-slug", "cross-setkey", "cross-printrun", "same-printrun-cross-parallel", "printrun-discovery", "sibling-parallel", "family-baseline", "grade-cross-raw", "composite-neighbor", "rare-card-anchor", "no-basis"],
};
const MEDIAN_RUNGS = new Set(["exact-pool-median", "exact-pool-weighted-median", "exact-pool-leading-edge"]);
function unionLiterals(src, typeName) {
  const at = src.indexOf(`export type ${typeName} =`);
  if (at < 0) return null;
  const body = src.slice(at, at + 6000).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const end = body.indexOf(";");
  const union = body.slice(body.indexOf("=") + 1, end > 0 ? end : undefined).replace(/Exclude<[^>]*>/g, "");
  return [...union.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}
function loadVocabulary() {
  try {
    const read = (p) => fs.readFileSync(path.join(backend, "src", "services", p), "utf8");
    const rung = read("compiq/fmvRung.ts");
    const exact = unionLiterals(rung, "ExactPoolRungLabel"), extra = unionLiterals(rung, "FmvRungLabel");
    const canon = unionLiterals(read("compiq/canonicalFmv.service.ts"), "CanonicalFmvMethod");
    const hiq = unionLiterals(read("portfolioiq/hobbyIqFmv.service.ts"), "HobbyIqFmvMethod");
    if (!exact?.length || !extra?.length || !canon?.length || !hiq?.length) throw new Error("a union was not found");
    return { exact: new Set(exact), labels: new Set([...exact, ...extra, ...canon.filter((x) => x !== "direct-comp"), ...hiq.filter((x) => x !== "direct-slug")]), canon: new Set(canon), hiq: new Set(hiq), from: "src unions" };
  } catch (e) {
    return { exact: new Set(FALLBACK.exact), labels: new Set([...FALLBACK.exact, ...FALLBACK.extra, ...FALLBACK.canon.filter((x) => x !== "direct-comp"), ...FALLBACK.hiq.filter((x) => x !== "direct-slug")]), canon: new Set(FALLBACK.canon), hiq: new Set(FALLBACK.hiq), from: `hardcoded fallback (${String(e.message).slice(0, 60)})` };
  }
}

// ── paced HTTP ──────────────────────────────────────────────────────────
let lastStart = 0;
async function paced(fn) {
  const gap = Math.ceil(1000 / RPS);
  const wait = lastStart + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
  return fn();
}
async function call(method, route, body) {
  const H = { "Content-Type": "application/json", "x-session-id": TOKEN };
  try {
    const res = await paced(() => fetch(`${BASE}${route}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }));
    let json = null; try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch (e) { return { status: 0, json: null, error: String(e?.message ?? e).slice(0, 80) }; }
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  if (!TOKEN) { console.error("FATAL: TIER1_HARNESS_TOKEN not set — cannot authenticate against the routes"); process.exit(2); }
  const vocab = loadVocabulary();
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  const q = async (c, query, parameters = []) => (await retry(() => c.items.query({ query, parameters }, { maxItemCount: 1000 }).fetchAll())).resources;

  // ── the sample: checklist-backed rows, spread across sports × years ──
  // Only ~1 in 7 checklist-confirmed rows has >= 3 raw sales in 180d (first
  // run: 45 of 323 candidates), so the pull is ~15x LIMIT — cheap, these are
  // indexed TOP reads — or the default LIMIT is never reached.
  const perBucket = Math.max(50, Math.ceil((LIMIT * 15) / Math.max(1, SPORTS.length * YEARS.length)));
  const candidates = [];
  for (const sp of SPORTS) for (const y of YEARS) {
    const rows = await q(cat, `SELECT TOP ${perBucket} c.id, c.sport, c.setKey FROM c WHERE c.sport = @sp AND c.year = @y AND c.checklistBacking = 'checklist-confirmed' AND NOT IS_DEFINED(c.gradeTier)`, [{ name: "@sp", value: sp }, { name: "@y", value: y }]);
    for (const r of rows) if (typeof r.id === "string" && r.id.startsWith("hiq:")) candidates.push(r);
  }
  // D16 (2026-08-30): a before/after pair must replay the SAME slugs, and the
  // catalog moves under the sampler between runs. SLUGS_FILE replays a fixed
  // list (one slug per line; the pool count is still measured so `[pool n]`
  // is current); SAMPLE_FILE writes the slugs this run priced, for the next.
  const shuffled = process.env.SLUGS_FILE
    ? fs.readFileSync(process.env.SLUGS_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith("hiq:")).map((id) => ({ id, sport: id.split(":")[1] ?? null, setKey: id.split(":")[3] ?? "" }))
    : candidates.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const sample = []; let tried = 0;
  for (const r of shuffled) {
    if (sample.length >= LIMIT || tried >= LIMIT * 20) break;
    tried++;
    const n = Number((await q(pool, "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s AND c.price > 0 AND c.soldAt >= @d AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null OR c.gradeCompany = '')", [{ name: "@s", value: r.id }, { name: "@d", value: since }]))[0] ?? 0);
    // A replayed slug is kept whatever its pool says today — the point of the
    // replay is the same rows, and a slug whose pool drained is a finding.
    if (n >= MIN_POOL || process.env.SLUGS_FILE) sample.push({ slug: r.id, sport: r.sport, setKey: String(r.id.split(":")[3] ?? ""), poolN: n });
  }
  console.log(`probe-price-routes  READ-ONLY  ${BASE}\n  sample ${f(sample.length)} checklist-backed slugs (${process.env.SLUGS_FILE ? `replayed from ${process.env.SLUGS_FILE}` : `tried ${f(tried)} of ${f(candidates.length)} candidates`}) sports=${SPORTS.join(",")} years=${Y0}-${Y1}  pool >= ${MIN_POOL} raw sales / ${DAYS}d  rps=${RPS}\n  rung vocabulary: ${vocab.labels.size} labels from ${vocab.from}\n`);
  if (!sample.length) { console.error("FATAL: empty sample — no checklist-backed slug met the pool threshold"); process.exit(2); }
  if (process.env.SAMPLE_FILE) { fs.writeFileSync(process.env.SAMPLE_FILE, sample.map((s) => s.slug).join("\n") + "\n"); console.log(`  sample written to ${process.env.SAMPLE_FILE}\n`); }

  // ── replay ──────────────────────────────────────────────────────────
  const ROUTES = ["price-by-id", "canonical-fmv", "hobbyiq-fmv", "grade-curve"];
  const results = [];
  for (const s of sample) {
    const row = { slug: s.slug, setKey: s.setKey, poolN: s.poolN };
    const a = await call("POST", "/api/compiq/price-by-id", { cardId: s.slug });
    const aj = a.json ?? {};
    row["price-by-id"] = { status: a.status, error: a.error, fmv: num(aj.marketValue) ?? num(aj.predictedPrice) ?? num(aj.fairMarketValueLive), label: aj.rungLabel ?? aj.fmvRung ?? aj.source ?? null, setKey: aj.cardIdentity?.setKey ?? null, hasIdentity: !!aj.cardIdentity };
    const b = await call("POST", "/api/compiq/canonical-fmv", { cardId: s.slug });
    const bj = b.json ?? {};
    row["canonical-fmv"] = { status: b.status, error: b.error, fmv: num(bj.fmv), label: bj.rungLabel ?? bj.method ?? null, method: bj.method ?? null, n: bj.recentRange?.n ?? null, setKey: null, hasIdentity: false };
    const c = await call("POST", "/api/compiq/hobbyiq-fmv", { hobbyiqCardId: s.slug });
    const cj = c.json ?? {};
    row["hobbyiq-fmv"] = { status: c.status, error: c.error, fmv: num(cj.fmv), label: cj.rungLabel ?? cj.method ?? null, method: cj.method ?? null, compCount: typeof cj.compCount === "number" ? cj.compCount : null, setKey: null, hasIdentity: false };
    const d = await call("GET", `/api/compiq/observed-grade-curve/${encodeURIComponent(s.slug)}`);
    const dj = d.json ?? {};
    const raw = Array.isArray(dj.entries) ? dj.entries.find((e) => e?.grade === "Raw" || e?.grader === "Raw") : null;
    row["grade-curve"] = { status: d.status, error: d.error, fmv: num(raw?.value), label: raw?.rungLabel ?? null, valueSource: raw?.valueSource ?? null, sampleCount: raw?.sampleCount ?? null, resolvedTo: typeof dj.cardId === "string" ? dj.cardId : null, setKey: null, hasIdentity: false };
    results.push(row);
    if (results.length === 1 && ROUTES.every((r) => row[r].status === 401)) { console.error("FATAL: every route answered 401 — the harness token was rejected"); process.exit(2); }
  }

  // ── scorecard ───────────────────────────────────────────────────────
  console.log(`ROUTE            ${"200s".padStart(14)}   ${"label in vocabulary".padEnd(26)} ${"exact-pool rung".padEnd(26)} ${"setKey = slug".padEnd(26)} ${"FMV null".padEnd(24)} errors`);
  for (const r of ROUTES) {
    const all = results.map((x) => x[r]);
    const ok = all.filter((x) => x.status === 200);
    const inVocab = ok.filter((x) => vocab.labels.has(x.label)).length;
    const exact = ok.filter((x) => vocab.exact.has(x.label)).length;
    const withId = ok.filter((x) => x.hasIdentity);
    const setKeyEq = withId.filter((x, i) => x.setKey === results.filter((y) => y[r].status === 200 && y[r].hasIdentity)[i].setKey).length;
    const nullFmv = ok.filter((x) => x.fmv == null).length;
    const errs = new Map(); for (const x of all) if (x.status !== 200) { const k = x.status || `net:${x.error}`; errs.set(k, (errs.get(k) ?? 0) + 1); }
    const errText = errs.size ? [...errs].map(([k, n]) => `${k}×${n}`).join(" ") : "-";
    const setKeyText = withId.length ? cell(setKeyEq, withId.length) : "no identity on the wire";
    console.log(`${r.padEnd(16)} ${cell(ok.length, all.length).padStart(14)}   ${cell(inVocab, ok.length).padEnd(26)} ${cell(exact, ok.length).padEnd(26)} ${setKeyText.padEnd(26)} ${cell(nullFmv, ok.length).padEnd(24)} ${errText}`);
  }
  // labels seen, per route -- the vocabulary finding needs names, not a percentage
  console.log("\n  labels seen:");
  for (const r of ROUTES) {
    const seen = new Map();
    for (const x of results) if (x[r].status === 200) { const k = String(x[r].label ?? "(none)"); seen.set(k, (seen.get(k) ?? 0) + 1); }
    console.log(`    ${r.padEnd(16)} ${[...seen].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}${vocab.labels.has(k) ? "" : " [NOT IN VOCAB]"} ×${n}`).join(", ")}`);
  }

  const withTwo = results.filter((x) => ROUTES.map((r) => x[r].fmv).filter((v) => v != null).length >= 2);
  const disagree = withTwo.filter((x) => { const v = ROUTES.map((r) => x[r].fmv).filter((v) => v != null); return Math.max(...v) / Math.min(...v) - 1 > DISAGREE; });
  const hf = results.map((x) => x["hobbyiq-fmv"]).filter((x) => x.status === 200);
  const hfBig = hf.filter((x) => (x.compCount ?? 0) >= 8);
  const hfMedian = hfBig.filter((x) => MEDIAN_RUNGS.has(x.label));
  const hfOutside = hf.filter((x) => !vocab.hiq.has(x.method));
  const pbOk = results.map((x) => x["price-by-id"]).filter((x) => x.status === 200);
  const pbMethod = pbOk.filter((x) => vocab.canon.has(x.label) && !vocab.labels.has(x.label));
  const cvOk = results.map((x) => x["grade-curve"]).filter((x) => x.status === 200);
  const cvVendor = cvOk.filter((x) => x.resolvedTo && !x.resolvedTo.startsWith("hiq:"));
  console.log("\nCROSS-ROUTE");
  console.log(`  (slug, Raw) with >= 2 route values                 ${f(withTwo.length)} / ${f(results.length)}`);
  console.log(`  routes disagree by > ${Math.round(DISAGREE * 100)}%                          ${cell(disagree.length, withTwo.length)}`);
  console.log(`  hobbyiq-fmv median rung while pool >= 8            ${cell(hfMedian.length, hfBig.length)}   (${[...MEDIAN_RUNGS].join(", ")})`);
  console.log(`  hobbyiq-fmv method outside HobbyIqFmvMethod        ${cell(hfOutside.length, hf.length)}   ${hfOutside.length ? "[" + [...new Set(hfOutside.map((x) => x.method))].join(", ") + "]" : ""}`);
  console.log(`  price-by-id label is a canonical METHOD, not a rung ${cell(pbMethod.length, pbOk.length)}   (no rungLabel on that wire)`);
  console.log(`  grade-curve answered under a vendor id, not the slug ${cell(cvVendor.length, cvOk.length)}`);
  if (disagree.length) {
    disagree.sort((a, b) => { const sp = (x) => { const v = ROUTES.map((r) => x[r].fmv).filter((v) => v != null); return Math.max(...v) / Math.min(...v); }; return sp(b) - sp(a); });
    console.log(`\n  worst disagreements (top ${Math.min(10, disagree.length)}):  price-by-id / canonical-fmv / hobbyiq-fmv / grade-curve(Raw)   [pool n]`);
    for (const x of disagree.slice(0, 10)) console.log(`    ${x.slug}\n      ${ROUTES.map((r) => (x[r].fmv == null ? "null" : "$" + x[r].fmv.toFixed(2)) + " " + (x[r].label ?? "-")).join("  /  ")}   [${x.poolN}]`);
  }
  console.log(`\ndone: ${f(results.length * ROUTES.length)} requests  (read-only; nothing written)`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
