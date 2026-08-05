#!/usr/bin/env node
// CF-BCCP-PARALLEL-REPAIR (Drew, 2026-08-05).
//
// Post-scrape fix-up: walks c:/tmp/bccp/**/*.json and rewrites every
// parallel entry's name + printRun using the CORRECT
// [eiral]{4}l-numbered regex. The scraper had [eir]{4} which never
// matched "seri**a**l-numbered" — so every parallel entry across all
// 3,075 products has printRun=null and still carries the paren in name.
//
// Faster than re-scraping (2 min vs 2 hr). Safe to re-run.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "c:/tmp/bccp";

const WORD_MAP = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };

function repairName(raw) {
  let name = String(raw ?? "");
  let printRun = null;

  // (serial-numbered to N copies) or (numbered to N copies)
  let m = name.match(/\((?:s[eiral]{4}l-numbered|numbered)\s+to\s+(\d[\d,]*)\s+copies?\)/i);
  if (m) {
    printRun = Number(m[1].replace(/,/g, ""));
    name = name.replace(m[0], "").trim();
  }

  // (serial-numbered to word)
  if (printRun == null) {
    m = name.match(/\(s[eiral]{4}l-numbered\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten)\)/i);
    if (m) {
      printRun = WORD_MAP[m[1].toLowerCase()];
      name = name.replace(m[0], "").trim();
    }
  }

  // Trailing "/N" that scraper never stripped
  if (printRun == null) {
    m = name.match(/\s*\/\s*(\d[\d,]*)\b/);
    if (m) {
      printRun = Number(m[1].replace(/,/g, ""));
      name = name.replace(m[0], "").trim();
    }
  }

  // 1-of-1 markers
  if (printRun == null && /\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/i.test(name)) printRun = 1;
  if (printRun == null && /\bone[-\s]of[-\s]one\b/i.test(name)) printRun = 1;
  name = name.replace(/\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/gi, "").replace(/\bone[-\s]of[-\s]one\b/gi, "").trim();

  // Trailing tabs/whitespace/punct
  name = name.replace(/[\s\t.:,]+$/, "").trim();

  return { name, printRun };
}

let touchedFiles = 0;
let touchedParallels = 0;
let printRunsAdded = 0;
const yearDirs = readdirSync(ROOT).filter(n => /^\d{4}$/.test(n)).sort();
for (const yd of yearDirs) {
  const dir = join(ROOT, yd);
  try { statSync(dir); } catch { continue; }
  const files = readdirSync(dir).filter(n => n.endsWith(".json") && n !== "products.json");
  for (const f of files) {
    const path = join(dir, f);
    let doc;
    try { doc = JSON.parse(readFileSync(path, "utf8")); }
    catch { continue; }
    if (!Array.isArray(doc.parallels)) continue;
    let changed = false;
    for (const p of doc.parallels) {
      if (!p || typeof p.name !== "string") continue;
      const { name, printRun } = repairName(p.name);
      if (name !== p.name || printRun !== p.printRun) {
        if (printRun != null && p.printRun == null) printRunsAdded++;
        touchedParallels++;
        p.name = name;
        if (printRun != null) p.printRun = printRun;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(path, JSON.stringify(doc, null, 2));
      touchedFiles++;
    }
  }
}
console.log(`Repaired ${touchedParallels} parallel entries across ${touchedFiles} product files.`);
console.log(`Print runs newly extracted: ${printRunsAdded}`);
