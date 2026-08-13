#!/usr/bin/env node
// CF-BECKETT-XLSX-CONVERT (Drew, 2026-08-12: "it just released!").
//
// Beckett publishes each product's checklist as an .xlsx. This converts one
// into the scraped-CSV + manifest pair that ingest-scraped-checklist.cjs
// already consumes, so a Beckett release reuses the ingest path rather than
// growing a second one.
//
// SHEET SHAPE. Sections are inline, not separate sheets:
//     ['Base Set']                          <- section header (single cell)
//     ['100 cards']                         <- count line, skipped
//     ['1', 'Konnor Griffin,', 'Pittsburgh Pirates', 'RC']
// so the parser tracks the current section as it walks rows. Player cells
// carry a trailing comma, and an RC flag sits in a later column — the repo's
// CSV convention folds that into the player field ("Jacob Wilson RC").
//
// Beckett xlsx are CARD LISTS ONLY — no print runs. printRun is left blank
// rather than guessed; parallels and their print runs come from elsewhere.
//
// The 'Full Checklist' and 'Team Sets' sheets are supersets of the others and
// are skipped, or every card would ingest two or three times.
//
// Usage:
//   node scripts/convertBeckettChecklistXlsx.cjs \
//     --xlsx <file.xlsx> --year 2026 --set-key bowman-chrome \
//     --set-name "2026 Bowman Chrome" --out data/checklists/scraped/2026-bowman-chrome.csv \
//     --source-url "https://img.beckett.com/..."

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const XLSX = val("--xlsx", "");
const YEAR = Number(val("--year", "0"));
const SET_KEY = val("--set-key", "");
const SET_NAME = val("--set-name", "");
const SPORT = val("--sport", "baseball");
const OUT = val("--out", "");
const SOURCE_URL = val("--source-url", "");
if (!XLSX || !YEAR || !SET_KEY || !OUT) {
  console.error("required: --xlsx --year --set-key --out");
  process.exit(2);
}

// ---- minimal xlsx reader (no dependency) ---------------------------------
// Only needs shared strings + sheet cell values; xlsx is a zip of XML.
function readZip(buf) {
  const files = {};
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip");
  let off = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&");

function sharedStrings(files) {
  const xml = files["xl/sharedStrings.xml"];
  if (!xml) return [];
  const out = [];
  for (const si of xml.toString("utf8").split("<si>").slice(1)) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]));
    out.push(parts.join(""));
  }
  return out;
}

function sheetRows(xml, ss) {
  const rows = [];
  for (const rowXml of xml.toString("utf8").split("<row ").slice(1)) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = m[1] ?? m[3] ?? "";
      const body = m[2] ?? "";
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || "";
      let col = 0;
      for (const ch of ref) col = col * 26 + (ch.charCodeAt(0) - 64);
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const isRaw = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      let value = "";
      if (t === "s" && v != null) value = ss[Number(v)] ?? "";
      else if (isRaw != null) value = decode(isRaw);
      else if (v != null) value = decode(v);
      if (col > 0) cells[col - 1] = value;
    }
    rows.push(Array.from(cells, (c) => (c == null ? "" : String(c).trim())));
  }
  return rows;
}

function sheetsByName(files) {
  const wb = files["xl/workbook.xml"].toString("utf8");
  const rels = files["xl/_rels/workbook.xml.rels"].toString("utf8");
  const relMap = {};
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
  const ss = sharedStrings(files);
  const out = {};
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const target = (relMap[m[2]] || "").replace(/^\/?xl\//, "").replace(/^\//, "");
    const key = "xl/" + target;
    if (files[key]) out[m[1]] = sheetRows(files[key], ss);
  }
  return out;
}

// ---- checklist extraction -------------------------------------------------
const slug = (s) => String(s || "").toLowerCase()
  .normalize("NFKD").replace(/[^\w\s-]/g, "")
  .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// Roster sheets repeat every card already listed elsewhere, grouped a second
// way. Including them ingests each card two or three times. Beckett names this
// sheet inconsistently across products ('Team Sets' in Bowman Chrome, 'Teams'
// in Mega Box), so match on shape rather than one literal.
const SKIP_SHEETS = new Set(["Full Checklist", "Team Sets", "Teams", "Checklist"]);

// Sheet -> category prefix. Chrome Prospects are part of the base set's own
// numbering (BCP-###), so they are base cards, not inserts.
function categoryFor(sheetName, section) {
  const s = slug(section) || "unsectioned";
  // Image / photo variations are DISTINCT cards that reuse the base card's
  // number and player — Mega Box files list them inside the Base sheet. Left
  // as category "base" they collide with the very cards they vary and get
  // dropped by the dedup below (10 lost on the first 2026 Mega Box parse).
  // They also need to stay findable as variations for the IV search (#1007).
  if (/variation/i.test(section)) return `insert-${s}`;
  if (sheetName === "Base" || sheetName === "Prospects") return "base";
  if (sheetName === "Autographs") return `auto-${s}`;
  return `insert-${s}`;   // Inserts + Variations
}

const isCountLine = (r) => /^\d[\d,]*\s+cards?$/i.test(String(r[0] || ""));
const nonEmpty = (r) => r.filter((c) => c !== "").length;

function main() {
  const files = readZip(fs.readFileSync(path.resolve(XLSX)));
  const sheets = sheetsByName(files);

  const out = [];
  const sections = [];
  for (const [name, rows] of Object.entries(sheets)) {
    if (SKIP_SHEETS.has(name)) continue;
    let section = name;
    let inSection = 0;
    for (const row of rows) {
      if (!nonEmpty(row)) continue;
      if (isCountLine(row)) continue;
      // A single populated cell is a section header.
      if (nonEmpty(row) === 1 && row[0]) {
        if (inSection) sections.push({ sheet: name, section, cards: inSection });
        section = row[0]; inSection = 0; continue;
      }
      const cardNumber = String(row[0] || "").trim();
      let player = String(row[1] || "").replace(/,\s*$/, "").trim();
      if (!cardNumber || !player) continue;
      // An RC flag sits in a later column; the repo's CSV folds it into the
      // player field ("Jacob Wilson RC").
      if (row.slice(2).some((c) => /^RC$/i.test(String(c || "").trim()))) player += " RC";

      const category = categoryFor(name, section);
      out.push({
        category,
        cardNumber,
        parallel: "Base",
        isAuto: category.startsWith("auto-") ? "true" : "false",
        printRun: "",   // Beckett xlsx are card lists only — never guessed
        player,
      });
      inSection++;
    }
    if (inSection) sections.push({ sheet: name, section, cards: inSection });
  }

  // Guard against the duplicate-id class of bug: same category+number+player
  // appearing twice would upsert over itself and hide a parse error.
  const seen = new Set();
  const rowsOut = out.filter((r) => {
    const k = `${r.category}|${r.cardNumber}|${r.player}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of rowsOut) {
    const q = (v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    csv.push([r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, q(r.player)].join(","));
  }

  const outPath = path.resolve(OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv.join("\n") + "\n");

  const manifest = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: SOURCE_URL,
    sport: SPORT,
    year: YEAR,
    setName: SET_NAME || SET_KEY,
    productKey: `${YEAR}-${SET_KEY}`,
    setKey: SET_KEY,
    rowCount: rowsOut.length,
    sectionsReport: sections,
  };
  fs.writeFileSync(outPath.replace(/\.csv$/, ".manifest.json"), JSON.stringify(manifest, null, 2));

  const byCat = {};
  for (const r of rowsOut) {
    const k = r.category.split("-")[0];
    byCat[k] = (byCat[k] || 0) + 1;
  }
  console.log(`wrote ${outPath}`);
  console.log(`  rows=${rowsOut.length}  (deduped ${out.length - rowsOut.length})`);
  console.log(`  by kind: ${JSON.stringify(byCat)}`);
  console.log(`  sections: ${sections.length}`);
  for (const s of sections.slice(0, 14)) console.log(`     ${s.sheet} > ${s.section}: ${s.cards}`);
}
main();
