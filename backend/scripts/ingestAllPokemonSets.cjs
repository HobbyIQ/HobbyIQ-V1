#!/usr/bin/env node
// CF-POKEMON-FULL-CATALOG (Drew, 2026-08-13: "ingest the full API TCG checklist
// NOW").
//
// Drives fetchPokemonTcgChecklist + ingest-scraped-checklist across every set in
// the pokemon-tcg-data dataset (174 sets).
//
// TWO setKey FORMS PER SET, on purpose. The setKey our sales compute comes from
// the vendor's title text, and the vendor is not consistent:
//
//   "SWSH10: Astral Radiance"   -> swsh10-astral-radiance   (code prefix)
//   "Neo Genesis"               -> neo-genesis              (no prefix)
//   "SV: Scarlet & Violet 151"  -> sv-scarlet-violet-151
//   "EX Sandstorm"              -> ex-sandstorm
//
// Rather than guess which form a given set's titles use, emit BOTH
// `<slug(name)>` and `<id>-<slug(name)>` when they differ. An unmatched catalog
// row costs nothing; a missed form leaves the whole set unmatchable — and the
// asymmetry there is the entire lesson of tonight.
//
//   node scripts/ingestAllPokemonSets.cjs              # dry run, lists plan
//   node scripts/ingestAllPokemonSets.cjs --apply
//   node scripts/ingestAllPokemonSets.cjs --apply --limit 20

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = Number(val("--limit", "999"));
// Measured serially at ~40s per setKey variant — 348 variants is ~3.9 hours,
// and it is nearly all I/O (dataset fetch + Cosmos writes in a spawned child).
// Sharding by set index lets N processes cover disjoint slices with no
// coordination: set i belongs to shard i % SHARDS.
const SHARD = Number(val("--shard", "-1"));
const SHARDS = Number(val("--shards", "1"));

const BACKEND = path.resolve(__dirname, "..");
const OUTDIR = path.join(BACKEND, "data/checklists/scraped");
const DATA_BASE = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "HobbyIQ-checklist/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(fetchJson(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => { b += c; });
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const slug = (s) => String(s).toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function run(cmd, argv, env) {
  const r = spawnSync(cmd, argv, {
    cwd: BACKEND, encoding: "utf8", env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

(async () => {
  console.log(`pokemon full-catalog ingest — ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  const sets = await fetchJson(`${DATA_BASE}/sets/en.json`);
  console.log(`${sets.length} sets in dataset\n`);

  const stats = { sets: 0, variants: 0, rows: 0, failed: 0 };
  const mine = sets.slice(0, LIMIT).filter((_, i) => SHARD < 0 || SHARDS <= 1 || i % SHARDS === SHARD % SHARDS);
  if (SHARD >= 0 && SHARDS > 1) console.log(`shard ${SHARD}/${SHARDS} -> ${mine.length} sets
`);
  for (const set of mine) {
    const year = Number(String(set.releaseDate || "").slice(0, 4));
    if (!year) { continue; }
    const nameSlug = slug(set.name);
    const forms = [nameSlug];
    const withId = `${slug(set.id)}-${nameSlug}`;
    if (withId !== nameSlug) forms.push(withId);

    stats.sets++;
    for (const setKey of forms) {
      stats.variants++;
      const csv = path.join(OUTDIR, `${year}-${setKey}.csv`);
      if (!APPLY) { console.log(`  would build ${year} ${setKey}`); continue; }

      const gen = run("node", ["scripts/fetchPokemonTcgChecklist.cjs",
        "--set-id", String(set.id), "--set-key", setKey, "--year", String(year),
        "--out", csv, "--quiet"]);
      if (gen.code !== 0) {
        console.log(`  [${setKey}] generate failed: ${gen.out.split("\n").slice(-2).join(" ").slice(0, 110)}`);
        stats.failed++; continue;
      }
      const ing = run("node", ["scripts/ingest-scraped-checklist.cjs"],
        { CSV_PATH: csv, SOURCE_LABEL: "pokemon-tcg-data", APPLY: "true" });
      if (ing.code !== 0) {
        console.log(`  [${setKey}] ingest failed: ${ing.out.split("\n").slice(-2).join(" ").slice(0, 110)}`);
        stats.failed++; continue;
      }
      const wrote = (ing.out.split("\n").find((l) => l.includes("wrote=")) || "").trim();
      const n = Number((wrote.match(/wrote=(\d+)/) || [])[1] || 0);
      stats.rows += n;
      console.log(`  ${String(year)} ${setKey.padEnd(42)} ${wrote}`);
    }
  }

  console.log(`\nsets processed : ${stats.sets}`);
  console.log(`setKey variants: ${stats.variants}`);
  console.log(`catalog rows   : ${stats.rows.toLocaleString()}`);
  console.log(`failed         : ${stats.failed}`);
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
