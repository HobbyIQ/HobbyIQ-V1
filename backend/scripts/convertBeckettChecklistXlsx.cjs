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
// Only a direct run needs the CLI args; the classifier is also imported as a
// module (see module.exports at the bottom) and must not exit on load.
if (require.main === module && (!XLSX || !YEAR || !SET_KEY || !OUT)) {
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
const SKIP_SHEETS = new Set(["Full Checklist", "Team Sets", "Teams", "Checklist", "Master"]);

// CF-BECKETT-A-SUPERSET-SHEET-IS-NOT-A-SECTION (2026-09-04). The literal list
// above only ever knew the five spellings the 2022/2023 Bowman workbooks used.
// Measured across 48 live workbooks, publishers name the same roster sheet six
// more ways, and NONE of them were skipped:
//
//     Master Card List              11 products    57,349 card lines
//     Master Checklist               2 products    23,575
//     Parallel Guide                 2 products    14,353
//     Metal - Parallels              1 product      5,266
//     Holo Prospect Sigs Parallels   1 product      2,918
//     Aquatic - Parallels            1 product      2,022
//
// 105,483 lines re-listing cards that Base / Autographs / Inserts already
// carry. Worse than a duplicate: a "Master Card List" is a WIDE MATRIX, one
// column per parallel, so its first two columns hold the product name and the
// subset -- not a card number and a player. 2026 Leaf Electrum emitted
//
//     insert-master-card-list,2026 Leaf Electrum Baseball,,false,,Achromatic
//
// thirteen times, with 938 further rows collapsing onto those same keys and
// being dropped by the dedup. The sheet contributed no real card and hid its
// own breakage behind a plausible row count.
//
// Matched on SHAPE rather than one more literal, because the next workbook will
// invent a seventh spelling. A sheet is a superset when its name says master /
// full checklist / roster, or when it is a parallel GUIDE -- a sheet whose only
// job is to tabulate the ladder the card sheets already carry per section.
const SUPERSET_SHEET = /^(master\b|full\s+checklist\b|team\s*sets?\b|teams\b|checklist$|.*\bparallel\s*guide\b|.*\bparallels?$)/i;
const isSupersetSheet = (name) => SKIP_SHEETS.has(String(name).trim()) || SUPERSET_SHEET.test(String(name).trim());

// CF-CHECKLIST-VARIATION-IS-A-PARALLEL (Drew, 2026-08-25). Sections that name
// the plain card of their own numbering run rather than a variant of it. These
// seed the ANCHOR set every other section is tested against. Kept identical to
// the PLAIN_SECTION list in ingest-scraped-checklist.cjs so the converter and
// the ingester agree on what "the plain card" means.
const PLAIN_SECTION = /^(base[- ]?set|base|chrome[- ]prospects?|base[- ]prospects?|prospects?|chrome[- ]prospect[- ]autographs?|rookie[- ]autographs?|chrome[- ]rookie[- ]autographs?)$/;

// Sheet -> category prefix. Chrome Prospects are part of the base set's own
// numbering (BCP-###), so they are base cards, not inserts.
function categoryFor(sheetName, section) {
  const s = slug(section) || "unsectioned";
  // A variation section gets its own category even when Beckett lists it on the
  // Base sheet, which Mega Box does ('Base > Mega Chrome Base Cards - Image
  // Variations'). Returning "base" here would seed it as an ANCHOR instead of a
  // candidate rung, and it would then collide with the very cards it varies —
  // same number, same player, same blank parallel — and be dropped by the dedup
  // (10 lost on the first 2026 Mega Box parse).
  //
  // It keeps the sheet's auto-ness, though: an autographed variation returned as
  // "insert-" would only ever be compared against non-auto anchors, so it could
  // never fold onto the signed card it varies, and left unfolded it would claim
  // isAuto=false on a card that is signed.
  if (/variation/i.test(section)) {
    // Same widened sheet test as below: an "Autographed Relics" or "Multi-Signed
    // Autographs" variation is signed just as much as an "Autographs" one.
    const signed = /\bautograph|\bautographed\b|\bsign(ed|atures?)\b/i.test(String(sheetName || ""));
    return (signed ? "auto-" : "insert-") + s;
  }
  const sheet = String(sheetName || "").trim();
  // CF-BECKETT-THE-SHEET-NAMES-THE-CARD-TYPE (2026-09-04). This matched three
  // sheet names as literals and swept every other sheet into "insert-". Measured
  // across 48 live workbooks that is wrong for four whole classes of card:
  //
  //   Autographed Relics       391 cards  ->  insert-*, isAuto=FALSE
  //   Multi-Signed Autographs   96 cards  ->  insert-*, isAuto=FALSE
  //   Memorabilia            3,513 cards  ->  insert-*
  //   Relics                   586 cards  ->  insert-*
  //   Memorabilia Cards        705 cards  ->  insert-*
  //
  // The two autograph sheets are the harm that matters: 487 cards the publisher
  // states are SIGNED were emitted isAuto=false, so their pool never joined the
  // signed identity and every auto sale on them orphaned. A checklist is the
  // authority for isAuto, and these sheets say signed in their own titles.
  //
  // "Base - Prospects" (300 cards) and " Base" (a leading space, 2026 Panini
  // Immaculate) also missed the equality test and were filed as inserts rather
  // than as the base run they are.
  //
  // Relic sheets keep riding as insert-<subset>: the catalog has no cardType
  // field, and the subset name IS the memorabilia vocabulary -- exactly how
  // fetchHobbyMonitorChecklist.cjs, the lane that reads its relics correctly,
  // already emits them. What was missing was never a field; it was the section
  // name, which the count-line and ladder defects below were deleting.
  if (/^base\b|^prospects?\b/i.test(sheet)) return "base";
  // Signed when the SHEET says signed. Autographed Relics is an autograph sheet
  // that happens to carry a swatch; the signature is what sets isAuto.
  if (/\bautograph|\bautographed\b|\bsign(ed|atures?)\b/i.test(sheet)) return "auto-" + s;
  return "insert-" + s;   // Inserts, Variations, Memorabilia, Relics, Updates
}

// CF-BECKETT-A-COUNT-LINE-IS-NOT-A-SECTION (2026-09-04). This pattern had no
// trailing-period branch, and 2024 Bowman writes "100 cards." with one. A count
// line that does not match falls through to the single-cell branch in main()
// and BECOMES the section, so every real section name in that workbook was
// replaced by its own card count:
//
//     anchor    100 | Base > 100 cards.        category=base
//     own-cards  30 | Inserts > 15 cards.      category=insert-15-cards
//     own-cards   3 | Autographs > 1 card.     category=auto-1-card
//
// All 18 sections, every name gone -- "55 Bowman Anime", "Bowman Ultimate
// Autograph Book Card" and the rest. The row count stayed plausible (936) while
// the subset each row belongs to became unrecoverable: the same shape of
// failure the ladder fix found in 2023 Bowman Chrome.
const isCountLine = (r) => /^\d[\d,]*\s+cards?\.?$/i.test(String(r[0] || "").trim());
const nonEmpty = (r) => r.filter((c) => c !== "").length;

// ---- parallel naming ------------------------------------------------------
// Canonical rung spellings already verified in
// backend/src/services/catalog/parallelLadders.ts (2026 Bowman Chrome ladder,
// Cardsmiths + LUDEX 2026-08-04). Beckett's section title and the verified
// ladder disagree on these two; the ladder wins, or the checklist row slugs to
// `gold-ink` while every other code path in the repo says `gold-ink-variation`.
const CANONICAL_RUNG = {
  "packfractor": "PackFractor",
  "gold ink": "Gold Ink Variation",
};

// The rung name is what the section ADDS to its anchor, not the whole section
// title. "Chrome Prospect Packfractor Autographs" anchored on "Chrome Prospect
// Autographs" is the PackFractor rung — storing the full section name produced
// slugs like `...:cpa-jg:chrome-prospect-packfractor-autographs:auto`, which no
// parsed sale title can ever match.
const tokens = (s) => String(s || "").split(/[\s–—]+/)
  .map((t) => t.replace(/^-+|-+$/g, "").trim())
  .filter((t) => t.length > 0);

function rungName(section, anchorSection) {
  const drop = new Set(tokens(anchorSection).map((t) => t.toLowerCase()));
  let out = tokens(section).filter((t) => !drop.has(t.toLowerCase()));
  // "Autograph(s)" is carried by the isAuto flag, not by the parallel name.
  out = out.filter((t) => !/^autographs?$/i.test(t));
  if (!out.length) return "";
  // Beckett titles sections in the plural ("Packfractors"); a rung is singular.
  const last = out[out.length - 1];
  if (/s$/i.test(last) && !/ss$/i.test(last)) out[out.length - 1] = last.replace(/s$/i, "");
  const name = out.join(" ");
  return CANONICAL_RUNG[name.toLowerCase()] || name;
}

function secBrief(s) {
  return { sheet: s.sheet, section: s.section, category: s.category, cards: s.cards };
}

// Decide, for every section, whether it is an anchor, a parallel of an anchor,
// or its own run of cards. Exported so the classification can be tested and
// re-run against an already-generated checklist without re-reading the xlsx.
//
// A variation is a RUNG on an existing card, not a separate card. The test is
// the card numbers: a section whose numbers ALL already exist in an anchor
// section is re-listing those same cards in a different finish. Classify on the
// numbers, never on the sheet name — Beckett files WBC Flag Variations and
// Retrofractors on the same 'Variations' sheet as the Packfractors, and those
// two are their own cards on their own numbering runs.
function classifySections(sections) {
  const all = [...sections.values()];
  const isAutoSection = (s) => s.category.startsWith("auto-");
  const normSection = (s) => s.toLowerCase().replace(/\s*-\s*/g, " ").trim();

  // Sections that name the plain card of their own run are anchors outright.
  // Everything else has to earn the title by not folding onto one.
  const anchors = all.filter(
    (s) => s.category === "base" || PLAIN_SECTION.test(normSection(s.section)),
  );
  for (const a of anchors) { a.isAnchor = true; a.explicitAnchor = true; }

  // Largest first, so a section that turns out to be a card run in its own right
  // is already an anchor by the time its own variations are tested against it.
  // PLAIN_SECTION only ever knew Bowman Chrome's vocabulary; Mega Box calls its
  // anchor "Prospect Mega Autographs", which that list has never heard of, and
  // its Image Variations would otherwise have no anchor to fold onto at all.
  const rest = all.filter((s) => !s.isAnchor).sort((a, b) => b.numbers.size - a.numbers.size);

  const report = [];
  const push = (sec, extra) => report.push(Object.assign(secBrief(sec), extra));

  for (const sec of rest) {
    // Only compare against anchors of the same auto class: a non-auto insert
    // cannot be a rung on a signed card, however well the numbers line up.
    // A section may only fold onto an anchor that is either (a) the plain card
    // of its own run — base / PLAIN_SECTION — or (b) a section whose whole name
    // this one contains and extends, which is what "X - Image Variations" is to
    // "X". Without (b)'s containment test, size alone decides, and the LARGER
    // section wins even when it is the more specific one: 1999 Black Diamond
    // folded "Prime Cuts Relics" onto "Prime Cuts Pine Tar Relics" and then had
    // no words left to name the rung with.
    const extendsName = (cand, anchor) => {
      const at = tokens(anchor.section).map((t) => t.toLowerCase());
      const ct = tokens(cand.section).map((t) => t.toLowerCase());
      return at.length > 0 && ct.length > at.length && at.every((t) => ct.includes(t));
    };
    const candidates = anchors.filter((a) =>
      a !== sec && isAutoSection(a) === isAutoSection(sec) &&
      (a.explicitAnchor || extendsName(sec, a)));
    let best = null;
    for (const a of candidates) {
      const hit = [...sec.numbers].filter((n) => a.numbers.has(n)).length;
      const pct = sec.numbers.size ? hit / sec.numbers.size : 0;
      // On a tie prefer the tightest anchor — the smallest section that still
      // contains every one of these numbers is the run they actually belong to.
      if (!best || pct > best.pct || (pct === best.pct && a.numbers.size < best.anchor.numbers.size)) {
        best = { anchor: a, pct: pct, hit: hit };
      }
    }

    if (best && best.pct === 1) {
      const rung = rungName(sec.section, best.anchor.section);
      // A fold that cannot be named is not a fold. An empty rung means this
      // section adds no word to the anchor's name, so folding would collapse it
      // silently onto the anchor's own slug and overwrite it. Leave it as its
      // own cards and say why — refusing is always recoverable, overwriting is
      // not.
      if (!rung) {
        sec.isAnchor = true;
        anchors.push(sec);
        push(sec, {
          role: "own-cards-UNNAMEABLE", anchor: best.anchor.key,
          note: "numbers match the anchor exactly but the section name yields no rung",
        });
        continue;
      }
      sec.parallelOf = best.anchor;
      sec.rung = rung;
      push(sec, { role: "parallel", anchor: best.anchor.key, rung: rung });
      continue;
    }

    // It folds onto nothing, so it is a run of cards in its own right — and
    // therefore an anchor that its OWN variations can fold onto.
    sec.isAnchor = true;
    anchors.push(sec);

    if (!best || best.pct === 0) {
      push(sec, { role: "own-cards" });
    } else {
      // Partially overlapping: genuinely ambiguous. Do NOT guess in either
      // direction — leave it as its own cards (the prior behaviour) and say so
      // loudly, because a silent choice here is how a whole section gets filed
      // wrong and stays wrong.
      push(sec, {
        role: "own-cards-AMBIGUOUS", anchor: best.anchor.key,
        overlapPct: Number((best.pct * 100).toFixed(1)),
      });
    }
  }

  for (const s of all) {
    if (s.isAnchor && !report.some((r) => r.sheet === s.sheet && r.section === s.section)) {
      push(s, { role: "anchor" });
    }
  }
  // Report in the workbook's own section order, not the order decided in.
  const order = new Map(all.map((s, i) => [s.sheet + ">" + s.section, i]));
  report.sort((a, b) => order.get(a.sheet + ">" + a.section) - order.get(b.sheet + ">" + b.section));
  return report;
}

// CF-THE-LADDER-IS-A-LADDER-NOT-A-SECTION (Drew, 2026-08-26).
//
// A single populated cell is treated as a section header, and a Beckett sheet
// lists its parallels in exactly that shape:
//
//     Base Set                 <- a section
//     100 cards.
//     Parallels:               <- ...and then ELEVEN more single-cell rows
//     Refractors - /499
//     Gold Refractors - /50
//     Superfractors - 1/1
//     BCP-1  Jackson Holliday  <- the cards
//
// so every rung became its own section. 2023 Bowman Chrome converted to
// categories like "auto-superfractors-11" and "insert-100-cards", and all 97
// rungs in the workbook were dropped -- every one of 1,372 rows emitted with a
// blank parallel. Bowman Chrome IS its refractor ladder, so that was the whole
// checklist missing while the row count still looked plausible.
//
// The ladder belongs to the section it sits in, not to the sheet. The
// Autographs sheet holds 42 rungs across ~12 subsections, each with its own
// "Parallels:" block, so applying the sheet's rungs to every card would be a
// cross join -- exactly the template `no-synthetic-parallels` forbids.
// Scoped per section it is not a template: Beckett is publishing which
// parallels that specific run of cards has.
// The colon is OPTIONAL. Measured across 48 live workbooks: 90 ladder headers
// are written bare as "Parallels" (2026 Donruss Elite, Panini Immaculate, Topps
// Chrome Team Samurai) and ZERO carried the colon this pattern required. Each of
// those 90 fell through to the section-header branch, so the word "Parallels"
// became the section name and every rung beneath it became a section too.
const LADDER_HEAD = /^parallels?\s*:?\s*$/i;

// Beckett publishes unannounced content as a placeholder rather than omitting
// the heading:
//
//     It Came for the League Checklist
//     15 cards.
//     Parallels:
//     TBA                      <- the ladder is not announced yet
//     CFL-1  Corbin Carroll    <- but the CARDS are here
//
// "TBA" is not a rung, so it fell through to the section-header branch and
// BECAME the section -- stealing the name from "It Came for the League" and
// filing its 15 cards under a set called "TBA". A placeholder is skipped and
// the ladder stays open; only a real heading closes it.
const PLACEHOLDER = /^(tba|n\/?a|none|list tba\.?|checklist tba\.?|coming soon)\.?$/i;

// "Gold Refractors - /50" -> /50. "Superfractors - 1/1" -> a one-of-one.
// "Gold /10" -> /10: the dash is OPTIONAL, and most publishers omit it.
// Distribution notes ("hobby only", "HTA only") and pack odds ("1:83") are not
// different parallels; they are stripped from the name and kept as a note.
//
// CF-BECKETT-A-COLOUR-IS-A-FINISH (2026-09-04). This function used to demand a
// word from a twelve-item finish vocabulary (refractor|prizm|foil|...) before it
// would call a line a rung. Measured across 48 live workbooks, 1,594 ladder
// lines state an explicit print run and STILL fail that whitelist:
//
//     "Gold /10" x143    "Platinum /1" x68     "Platinum 1/1" x64
//     "Emerald /5" x47   "Holo Silver /25" x45  "Green /5" x40
//
// A colour with a serial number on it is the most common parallel in the hobby.
// All 1,594 were rejected here, fell through to the section-header branch in
// main(), and BECAME the section -- which is why sections in the corpus are
// named "Superfractor /1" and "Rose Gold Mega Refractor /1". The checklist was
// publishing print runs and the converter was deleting them, and printRun is
// the one field a sale title can never reconstruct.
//
// The guard now keys on EVIDENCE rather than vocabulary: inside a ladder block
// a line is a rung when it states a print run, states pack odds, or names a
// finish. Prose with none of the three ("*Odds as provided by Topps",
// "100 cards.") is still refused, so this widens what counts as a rung without
// inventing one -- no-synthetic-parallels holds, because every rung emitted is
// a line the publisher printed.
const FINISH_WORD = /refractor|prizm|foil|shimmer|wave|atomic|mojo|superfractor|parallel|logo|variation|sparkle|speckle|holo|disco|laser|pulsar|velocity|mini\s*diamond/i;

function parseRung(line) {
  const raw = String(line || "").trim();
  if (!raw || LADDER_HEAD.test(raw)) return null;
  // A footnote is never a rung, however it is worded. A leading "*" is how every
  // workbook in the corpus marks one ("*Odds as provided by Topps", "*Plates
  // were made for this product").
  if (/^[*]/.test(raw)) return null;
  // The count line closes nothing and names nothing.
  if (isCountLine([raw])) return null;
  const noteMatch = raw.match(/\(([^)]*)\)\s*$/);
  const note = noteMatch ? noteMatch[1] : null;
  let s = raw.replace(/\([^)]*\)\s*$/, "").trim();

  let printRun = null;
  // The separator between the name and the run is optional: Beckett writes
  // "Gold Refractors - /50" and Panini writes "Gold /10". Both are one rung
  // with a stated print run.
  const oneOf = s.match(/(?:[\u2013\u2014-]\s*)?\b1\s*\/\s*1\s*$/);
  const numbered = s.match(/(?:[\u2013\u2014-]\s*)?\/\s*(\d[\d,]*)\s*$/);
  if (oneOf) {
    printRun = 1;
    s = s.slice(0, oneOf.index).trim();
  } else if (numbered) {
    printRun = Number(numbered[1].replace(/,/g, ""));
    s = s.slice(0, numbered.index).trim();
  }
  s = s.replace(/[\u2013\u2014-]\s*$/, "").trim();

  if (!s || s.length < 3) return null;
  // Evidence, not vocabulary. A stated print run, stated pack odds, or a named
  // finish each make this a rung; a line carrying none of the three is prose.
  const statesOdds = note != null && /^\s*1\s*:\s*[\d,]+/.test(String(note).trim());
  if (printRun == null && !statesOdds && !FINISH_WORD.test(s)) return null;
  return { name: s, printRun: printRun, note: note };
}

function main() {
  const files = readZip(fs.readFileSync(path.resolve(XLSX)));
  const sheets = sheetsByName(files);

  // ---- pass 1: read every row, remembering which section it came from -----
  const records = [];
  const sections = new Map();   // "sheet>section" -> section descriptor
  for (const [name, rows] of Object.entries(sheets)) {
    if (isSupersetSheet(name)) continue;
    let section = name;
    // The ladder belongs to the section it sits under, and resets with it.
    let inLadder = false;
    let pendingLadder = [];
    for (const row of rows) {
      if (!nonEmpty(row)) continue;
      if (isCountLine(row)) continue;
      // A single populated cell is a section header, the "Parallels:" marker,
      // or a rung of the ladder that marker opened. Treating all three as
      // section headers is what turned 97 rungs into 97 sections.
      if (nonEmpty(row) === 1 && row[0]) {
        const cell = String(row[0]).trim();
        if (LADDER_HEAD.test(cell)) { inLadder = true; pendingLadder = []; continue; }
        // A placeholder never names a section, in or out of a ladder.
        if (PLACEHOLDER.test(cell)) continue;
        if (inLadder) {
          const rung = parseRung(cell);
          if (rung) { pendingLadder.push(rung); continue; }
          // CF-BECKETT-PROSE-INSIDE-A-LADDER-IS-NOT-A-SECTION (2026-09-04).
          // A line the rung parser refuses used to fall through and BECOME the
          // section, which closed the ladder and threw away every rung after it.
          // 2026 Donruss Elite lists its base ladder as 22 rungs and the 12th is
          //
          //     Aspirations /99 or fewer (See list below)
          //
          // -- an UNSTATED run, correctly refused as a rung because "/99 or
          // fewer" is not a print run. Promoting it to a section discarded the
          // ten rungs that follow it, Elite 1/1 and Printing Plates 1/1 among
          // them, on both the Base and the Base - Prospects sheets.
          //
          // Only a CARD ROW closes a ladder. Beckett's own layout says so: the
          // ladder runs from the "Parallels" marker to the first numbered card,
          // and everything between is about those parallels. So a refused line
          // here is skipped and the ladder stays open, which loses that one
          // unnameable rung instead of the whole tail of the ladder. Refusing is
          // recoverable; the section-name theft was not.
          continue;
        }
        section = cell;
        inLadder = false;
        pendingLadder = [];
        continue;
      }
      // A card row closes the ladder: everything after it belongs to the cards.
      inLadder = false;
      const cardNumber = String(row[0] || "").trim();
      let player = String(row[1] || "").replace(/,\s*$/, "").trim();
      if (!cardNumber || !player) continue;
      // An RC flag sits in a later column; the repo's CSV convention folds it
      // into the player field ("Jacob Wilson RC").
      if (row.slice(2).some((c) => /^RC$/i.test(String(c || "").trim()))) player += " RC";

      const key = name + ">" + section;
      if (!sections.has(key)) {
        sections.set(key, {
          sheet: name, section: section, key: key,
          category: categoryFor(name, section),
          numbers: new Set(), cards: 0,
          // Whatever "Parallels:" block preceded this section's first card.
          ladder: pendingLadder,
        });
      }
      const sec = sections.get(key);
      sec.numbers.add(cardNumber.toUpperCase());
      sec.cards++;
      records.push({ sectionKey: key, cardNumber: cardNumber, player: player });
    }
  }

  // ---- pass 2: which sections are parallels of which anchors? -------------
  const report = classifySections(sections);

  // ---- pass 3: emit ------------------------------------------------------
  const out = [];
  for (const rec of records) {
    const sec = sections.get(rec.sectionKey);
    const target = sec.parallelOf || sec;
    const isAuto = target.category.startsWith("auto-") ? "true" : "false";
    // The plain card. Parallel stays BLANK, never "Base" — normalizeParallel()
    // already reads "" as the base tier, so the blank lies about nothing.
    out.push({
      category: target.category,
      cardNumber: rec.cardNumber,
      parallel: sec.parallelOf ? sec.rung : "",
      isAuto: isAuto,
      printRun: "",
      player: rec.player,
    });

    // CF-EMIT-THE-WHOLE-LADDER. Newer Beckett workbooks DO publish the ladder:
    // 2023 Bowman Chrome names 97 rungs with print runs, 11 on the base set
    // alone. Dropping them emitted every card with a blank parallel and lost
    // the set's entire refractor ladder -- and print run is the one field that
    // cannot be reconstructed from a sale title.
    //
    // Scoped to the section's OWN ladder, never the sheet's. The Autographs
    // sheet carries 42 rungs across ~12 subsections; applying all of them to
    // every card would be the cross join that no-synthetic-parallels forbids.
    // Per section it is not a template -- it is Beckett stating which
    // parallels this specific run of cards has.
    if (!sec.parallelOf) {
      for (const rung of sec.ladder || []) {
        out.push({
          category: target.category,
          cardNumber: rec.cardNumber,
          parallel: rung.name,
          isAuto: isAuto,
          printRun: rung.printRun == null ? "" : String(rung.printRun),
          player: rec.player,
        });
      }
    }
  }

  // Guard against the duplicate-id class of bug: the same card appearing twice
  // would upsert over itself and hide a parse error. parallel and isAuto are
  // part of the key — once a variation folds onto its anchor's card number, the
  // rung is the ONLY thing separating it from the anchor row, and keying
  // without it would delete every folded row as a "duplicate".
  const seen = new Set();
  const rowsOut = out.filter((r) => {
    const k = [r.category, r.cardNumber, r.parallel, r.isAuto, r.player].join("|");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of rowsOut) {
    const q = (v) => (/[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
    csv.push([r.category, r.cardNumber, q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
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
    productKey: YEAR + "-" + SET_KEY,
    setKey: SET_KEY,
    rowCount: rowsOut.length,
    // Tells ingest-scraped-checklist.cjs to read the CSV's parallel column
    // instead of re-deriving a label from the category slug. Opt-in by design:
    // checklists written by the other scrapers carry a parallel column that
    // means something different ("Normal" for the Pokemon base tier), and
    // changing how those are read is a separate decision from this one.
    parallelColumnAuthoritative: true,
    sectionsReport: report,
  };
  fs.writeFileSync(outPath.replace(/\.csv$/, ".manifest.json"), JSON.stringify(manifest, null, 2));

  const byCat = {};
  for (const r of rowsOut) {
    const k = r.category.split("-")[0];
    byCat[k] = (byCat[k] || 0) + 1;
  }
  const roleCount = (role) => report.filter((r) => r.role === role).length;
  const folded = report.filter((r) => r.role === "parallel");
  const ambiguous = report.filter((r) => r.role === "own-cards-AMBIGUOUS");
  console.log("wrote " + outPath);
  console.log("  rows=" + rowsOut.length + "  (deduped " + (out.length - rowsOut.length) + ")");
  console.log("  by kind: " + JSON.stringify(byCat));
  console.log("  sections: " + report.length + "  (anchors " + roleCount("anchor") +
    ", parallels " + folded.length + ", own-cards " + roleCount("own-cards") + ")");
  for (const f of folded) {
    console.log("     PARALLEL  " + f.sheet + " > " + f.section + " (" + f.cards +
      ")  ->  " + f.anchor + "   parallel=\"" + f.rung + "\"");
  }
  for (const a of ambiguous) {
    console.log("     !! AMBIGUOUS  " + a.sheet + " > " + a.section + " (" + a.cards +
      ") overlaps " + a.anchor + " by " + a.overlapPct +
      "% — left as its own cards, needs a human ruling");
  }
}

if (require.main === module) main();

module.exports = { classifySections, rungName, categoryFor, PLAIN_SECTION, parseRung, LADDER_HEAD, isSupersetSheet, isCountLine };
