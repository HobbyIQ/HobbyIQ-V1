#!/usr/bin/env node
/**
 * CF-BECKETT-VARIATION-SWEEP (Drew, 2026-09-01: "do it all, all of them",
 * scoped to the chrome flagship first).
 *
 * Runs convertBeckettVariationGuide across the discovered guides. Its real job
 * is the setKey: the article slug is NOT the product key, and guessing one is
 * how a checklist lands under the wrong product. Every guide is mapped here
 * explicitly, longest pattern first, and an unmapped guide is REPORTED, never
 * ingested under a guess.
 *
 * Defaults to --print (parse and report, write nothing).
 *
 * Usage:
 *   node backend/scripts/sweepBeckettVariationGuides.cjs \
 *     [--manifest=/tmp/beckett-variation-guides.json] [--family=chrome] [--write]
 */

const fs = require("fs");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const MANIFEST = arg("manifest", "C:/Users/dvabu/AppData/Local/Temp/beckett-variation-guides.json");
const FAMILY = arg("family", "chrome");
const WRITE = process.argv.includes("--write");

// Slug pattern -> setKey. ORDER MATTERS: the longest / most specific product
// must come first, exactly as the normalizer's own rule table works. A
// "bowman-chrome-mega-box" guide must not be read as "bowman-chrome".
const SETKEY_RULES = [
  [/topps-chrome-platinum-anniversary/, "topps-chrome-platinum-anniversary"],
  [/topps-chrome-update(-series)?/, "topps-chrome-update"],
  [/topps-chrome-logofractor/, "topps-chrome"],
  [/topps-chrome/, "topps-chrome"],
  [/bowman-chrome-sapphire|bowman-sapphire/, "bowman-chrome-sapphire"],
  [/bowman-chrome-mega-box|bowman-mega-box/, "bowman-chrome-mega-box"],
  [/bowman-chrome-draft/, "bowman-chrome-draft"],
  [/bowman-draft/, "bowman-draft"],
  [/bowman-platinum/, "bowman-platinum"],
  [/bowman-chrome/, "bowman-chrome"],
];
const FAMILY_RE = { chrome: /bowman-chrome|topps-chrome|bowman-draft|bowman-platinum|mega-box|sapphire/, all: /./ };

function setKeyFor(slug) {
  for (const [re, key] of SETKEY_RULES) if (re.test(slug)) return key;
  return null;
}

function main() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const famRe = FAMILY_RE[FAMILY] || FAMILY_RE.all;
  const guides = m.guides.filter((g) => famRe.test(g.slug));
  console.log(`[sweep] ${guides.length} guides in family=${FAMILY}, mode=${WRITE ? "WRITE" : "PRINT"}\n`);

  const ok = [], empty = [], unmapped = [], failed = [];
  for (const g of guides) {
    const setKey = setKeyFor(g.slug);
    if (!setKey || !g.year) { unmapped.push(g); console.log(`  SKIP (unmapped)  ${g.slug}`); continue; }
    const args = ["backend/scripts/convertBeckettVariationGuide.cjs",
      `--url=${g.url}`, `--set-key=${setKey}`, `--year=${g.year}`, "--sport=baseball"];
    if (!WRITE) args.push("--print");
    try {
      const outText = execFileSync("node", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      const n = Number((outText.match(/parsed (\d+) variations/) || [])[1] || 0);
      const cmp = (outText.match(/CMP codes: (\{[^}]*\})/) || [])[1] || "";
      if (n > 0) { ok.push({ ...g, setKey, n }); console.log(`  ${String(n).padStart(3)} vars  ${setKey.padEnd(34)} ${g.year} ${g.slug.slice(0, 52)} ${cmp}`); }
      else { empty.push({ ...g, setKey }); console.log(`    0 vars  ${setKey.padEnd(34)} ${g.slug.slice(0, 52)}  <- parsed nothing`); }
    } catch (e) {
      failed.push({ ...g, setKey, err: String(e.message).slice(0, 90) });
      console.log(`  FAIL     ${setKey.padEnd(34)} ${g.slug.slice(0, 52)}`);
    }
  }

  const total = ok.reduce((s, x) => s + x.n, 0);
  console.log(`\n=== ${ok.length} guides parsed, ${total} variation cards ===`);
  console.log(`    ${empty.length} parsed nothing, ${unmapped.length} unmapped, ${failed.length} failed`);
  const byKey = new Map();
  for (const x of ok) byKey.set(x.setKey, (byKey.get(x.setKey) || 0) + x.n);
  console.log("\nby setKey:");
  for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (empty.length) {
    console.log("\nparsed nothing (gallery shape differs — needs a look, NOT a guess):");
    for (const e of empty) console.log(`  ${e.year} ${e.slug}`);
  }
}
main();
