// CF-PARALLELS-CHECKLIST-FIRST-THEN-OBSERVED (Drew, 2026-08-12).
//
// Build a parallels-*.json actuals file for a product, VERIFIED CHECKLIST
// FIRST, then fill remaining gaps from parallels we have actually observed
// in sold_comps.
//
// WHY: seven 2026 products resolve their parallels by PROXY off the 2025
// actuals. A proxy inherits 2025's list, so every parallel NEW for 2026 is
// structurally uncreatable. Confirmed: 2026 Topps Chrome #136 "White
// Refractor" has real sales and no catalog row because the 2025 list (43
// parallels) has no "white" entry. Meanwhile sold_comps holds 63,464 sales
// of 2026 Topps Chrome across 179 distinct parallels, WITH print runs.
//
// PRECEDENCE — checklist wins, always:
//   1. Every parallel from the existing (verified/scraped) checklist is
//      emitted first, unchanged, keeping its printRun.
//   2. An observed parallel is added ONLY when the checklist has no entry
//      for it. An observed printRun NEVER overwrites a checklist printRun —
//      a scraped checklist states the print run; a sale merely reflects what
//      a seller typed.
//
// Every emitted parallel carries `provenance` so the two are always
// distinguishable downstream and observed ones can be superseded when a real
// 2026 checklist lands.
//
// NOT A TEMPLATE. Templates were rejected 2026-08-11 because they invent
// parallels that may not exist. These are the inverse: each observed entry is
// backed by >= MIN_SALES completed transactions. Still, observation includes
// title-parse noise, hence the floor and the provenance tag.
//
// Env:
//   YEAR=2026  SET_KEY=topps-chrome  SPORT=baseball   (required)
//   MIN_SALES=3        floor for an observed parallel to count
//   APPLY=true         write the file (default: preview to stdout)
//   COSMOS_CONNECTION_STRING

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const YEAR = Number(process.env.YEAR || 0);
const SET_KEY = String(process.env.SET_KEY || "").trim();
const SPORT = String(process.env.SPORT || "baseball").trim();
const MIN_SALES = Number(process.env.MIN_SALES || 3);
const APPLY = process.env.APPLY === "true";

const HAND_FETCHED_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

if (!YEAR || !SET_KEY) { console.error("YEAR and SET_KEY required"); process.exit(2); }

/** Title-case a parallel slug back into display form: "ray-wave-refractor"
 *  -> "Ray Wave Refractor". Matches the existing files' `name` style. */
function slugToName(slug) {
  return String(slug)
    .split("-")
    .filter(Boolean)
    .map((w) => (w === "x" ? "X" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bX Fractor\b/, "X-Fractor");
}

/** Existing checklist actuals for this product, following the same key
 *  resolution the explode uses (including "(proxy)" suffix stripping). */
function loadChecklistBaseline() {
  if (!fs.existsSync(HAND_FETCHED_DIR)) return null;
  const wanted = [`${YEAR}-${SET_KEY}-${SPORT}`, `${YEAR}-${SET_KEY}`];

  // CF-BASELINE-PREFER-DIRECT (Drew, 2026-08-12). Collect ALL matches, then
  // prefer a DIRECT claim over a PROXY claim.
  //
  // The first version returned the first readdir match and silently picked
  // the proxy: parallels-2025-topps-chrome-baseball.json claims
  // "2026-topps-chrome-baseball (proxy)" and sorts before the real
  // parallels-2026-*.json, so a freshly-written authoritative 2026 checklist
  // was ignored AND overwritten by a merge built on last year's list. A
  // proxy must never outrank the real thing.
  const matches = [];
  for (const f of fs.readdirSync(HAND_FETCHED_DIR).filter((f) => f.startsWith("parallels-") && f.endsWith(".json"))) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(HAND_FETCHED_DIR, f), "utf8"));
      for (const a of doc.appliesTo || []) {
        const clean = String(a).replace(/\s*\(.*\)\s*$/, "").trim();
        if (wanted.includes(clean)) {
          matches.push({ file: f, doc, viaProxy: /\(proxy/i.test(a) });
          break;
        }
      }
    } catch { /* skip malformed */ }
  }
  if (matches.length === 0) return null;
  return matches.find((m) => !m.viaProxy) ?? matches[0];
}

(async () => {
  const baseline = loadChecklistBaseline();
  console.log(`▸ ${APPLY ? "APPLY" : "PREVIEW"}  ${YEAR} ${SET_KEY} (${SPORT})  minSales=${MIN_SALES}`);
  if (baseline) {
    console.log(`  checklist baseline: ${baseline.file}${baseline.viaProxy ? "  (PROXY — this is why 2026-only parallels are missing)" : ""}`);
    console.log(`    source=${baseline.doc.source}  fetched=${baseline.doc.fetchedAt}`);
  } else {
    console.log(`  checklist baseline: NONE — output will be observed-only`);
  }

  // ---- 1. checklist parallels (authoritative, emitted unchanged) --------
  const checklistBase = [...(baseline?.doc?.baseParallels || []), ...(baseline?.doc?.prospectParallels || [])];
  const checklistAuto = [...(baseline?.doc?.autoParallels || [])];
  const seen = new Set();
  const norm = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const p of [...checklistBase, ...checklistAuto]) seen.add(norm(p.name ?? p));

  // ---- 2. observed parallels from real sales ---------------------------
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database("hobbyiq").container("sold_comps");
  const prefix = `hiq:${SPORT}:${YEAR}:${SET_KEY}:`;
  const { resources } = await c.items.query(
    { query: "SELECT c.hobbyiqCardId, c.printRun FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)", parameters: [{ name: "@p", value: prefix }] },
    { maxItemCount: -1 },
  ).fetchAll();

  const obs = new Map(); // key "slug|auto" -> { slug, auto, n, printRuns:Map }
  for (const r of resources) {
    const parts = String(r.hobbyiqCardId).split(":");
    const slug = parts[5]; const auto = parts[6] === "auto";
    if (!slug || slug === "base") continue;
    const k = `${slug}|${auto}`;
    const e = obs.get(k) || { slug, auto, n: 0, printRuns: new Map() };
    e.n++;
    if (r.printRun) e.printRuns.set(r.printRun, (e.printRuns.get(r.printRun) || 0) + 1);
    obs.set(k, e);
  }

  const added = { base: [], auto: [] };
  let skippedThin = 0, skippedKnown = 0;
  for (const e of [...obs.values()].sort((a, b) => b.n - a.n)) {
    if (e.n < MIN_SALES) { skippedThin++; continue; }
    if (seen.has(e.slug)) { skippedKnown++; continue; }
    // Most-frequently-observed print run wins; ties resolve to the smaller
    // (a /25 mislabelled as /250 is likelier than the reverse).
    const pr = [...e.printRuns.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
    (e.auto ? added.auto : added.base).push({
      name: slugToName(e.slug),
      printRun: pr,
      provenance: "observed-sold-comps",
      observedSales: e.n,
    });
    seen.add(e.slug);
  }

  console.log(`\n  sales scanned:        ${resources.length.toLocaleString()}`);
  console.log(`  observed parallels:   ${obs.size}`);
  console.log(`  already in checklist: ${skippedKnown}`);
  console.log(`  below ${MIN_SALES}-sale floor:  ${skippedThin}`);
  console.log(`  NEW from observation: ${added.base.length} base + ${added.auto.length} auto`);

  const stamp = (p) => ({ ...p, provenance: p.provenance ?? "checklist" });
  const out = {
    source: baseline ? `${baseline.doc.source}+observed-sold-comps` : "observed-sold-comps",
    sourceUrl: baseline?.doc?.sourceUrl ?? null,
    fetchedAt: new Date().toISOString().slice(0, 10),
    note: "Checklist parallels are authoritative and emitted unchanged. Entries with provenance='observed-sold-comps' were added only where the checklist had no entry, each backed by >= " + MIN_SALES + " completed sales. Supersede them when a real checklist for this product lands.",
    appliesTo: [`${YEAR}-${SET_KEY}-${SPORT}`, `${YEAR}-${SET_KEY}`],
    baseParallels: [...checklistBase.map(stamp), ...added.base],
    autoParallels: [...checklistAuto.map(stamp), ...added.auto],
  };

  console.log(`\n  RESULT: ${out.baseParallels.length} base + ${out.autoParallels.length} auto parallels`);
  console.log(`  sample NEW base:`, added.base.slice(0, 8).map((p) => `${p.name}${p.printRun ? "/" + p.printRun : ""}`).join(", ") || "(none)");
  console.log(`  sample NEW auto:`, added.auto.slice(0, 6).map((p) => `${p.name}${p.printRun ? "/" + p.printRun : ""}`).join(", ") || "(none)");

  const outFile = path.join(HAND_FETCHED_DIR, `parallels-${YEAR}-${SET_KEY}-${SPORT}.json`);
  if (!APPLY) { console.log(`\n[preview] would write ${outFile}`); return; }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n[written] ${outFile}`);
})().catch((e) => { console.error("ERR", e && e.message ? e.message : e); process.exit(1); });
