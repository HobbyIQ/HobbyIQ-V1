#!/usr/bin/env node
/**
 * CF-BA-SWEEP (Drew, 2026-08-10). Batch runner for Baseball Almanac
 * vintage baseball ingest. Tries known set-code patterns for each
 * year, HEAD-checks each URL, and calls ingestBaseballAlmanac.cjs
 * for the ones that exist.
 *
 * BA URL: baseball_cards_oneset.php?s={YEAR}{CODE}{NN}
 *   Common codes: bow (Bowman), top (Topps), don (Donruss), fle (Fleer),
 *   upd (Upper Deck), sco (Score), lea (Leaf), pin (Pinnacle), stu (Studio)
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/baseballAlmanacSweep.cjs \
 *     [--years=1950,1951,...,1990] [--apply]
 */

const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const YEARS = (argOf("years", "").split(",").filter(Boolean).map(Number));
if (YEARS.length === 0) {
  // Default: 1950 - 1990 vintage baseball
  for (let y = 1950; y <= 1990; y++) YEARS.push(y);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Known BA set codes (each with the setKey to use in slug).
const SET_CODES = [
  { code: "bow", setKey: "bowman" },
  { code: "top", setKey: "topps" },
  { code: "don", setKey: "donruss" },
  { code: "fle", setKey: "fleer" },
  { code: "upd", setKey: "upper-deck" },
  { code: "sco", setKey: "score" },
  { code: "lea", setKey: "leaf" },
  { code: "pin", setKey: "pinnacle" },
  { code: "stu", setKey: "studio" },
  { code: "sel", setKey: "select" },
  { code: "sta", setKey: "stadium-club" },
];

function headCheck(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: "HEAD", headers: { "User-Agent": UA, "Referer": "https://www.baseball-almanac.com/baseball_cards/" } }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(8_000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function runIngester(year, setKey, code) {
  const args = [
    path.resolve("backend/scripts/ingestBaseballAlmanac.cjs"),
    `--year=${year}`, `--setKey=${setKey}`, `--code=${code}`,
  ];
  if (APPLY) args.push("--apply");
  const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  const lines = (r.stdout ?? "").split("\n");
  const doneLine = lines.find((l) => /DONE — upserted/.test(l))
                ?? lines.find((l) => /parsed \d+ cards/.test(l))
                ?? "(no result)";
  return { code: r.status, doneLine };
}

(async () => {
  console.log(`[ba-sweep] apply=${APPLY} years=${YEARS.length} (${YEARS[0]}-${YEARS[YEARS.length-1]})`);
  let attempted = 0, found = 0, ingested = 0;
  for (const year of YEARS) {
    for (const { code, setKey } of SET_CODES) {
      // Try up to 4 sequence numbers per year+code (bow01, bow02, bow03, bow04)
      for (let seq = 1; seq <= 4; seq++) {
        const seqStr = String(seq).padStart(2, "0");
        const url = `https://www.baseball-almanac.com/baseball_cards/baseball_cards_oneset.php?s=${year}${code}${seqStr}`;
        attempted++;
        const exists = await headCheck(url);
        if (!exists) continue;
        found++;
        const r = runIngester(year, setKey, `${code}${seqStr}`);
        console.log(`[${found}] ${year} ${setKey} ${code}${seqStr}: ${r.doneLine.trim()}`);
        if (/DONE — upserted (\d+)/.test(r.doneLine)) {
          const n = Number(r.doneLine.match(/DONE — upserted (\d+)/)[1]);
          ingested += n;
        }
      }
    }
  }
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`Attempted URLs:  ${attempted}`);
  console.log(`Found (200):     ${found}`);
  console.log(`Rows ingested:   ${ingested.toLocaleString()}`);
})().catch((e) => { console.error(e); process.exit(1); });
