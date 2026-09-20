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
// CF-A-TRANSCRIPTION-VARIANT-IS-NOT-A-DISAGREEMENT (2026-09-20, review fix).
// normalizeRosterPlayer's own `.toLowerCase()` reduction treats "Ja'Marr"
// and "JaMarr", or an accented spelling and its plain-ASCII transcription,
// as two different players -- and now that a roster disagreement actively
// SUPPRESSES a fold (Defect 2's explicitAnchor gate) and SPLITS a repeated
// section into two (Defect 4), a punctuation/accent transcription variant
// would wrongly read as a real disagreement and either block a genuine
// colour rung's fold or mint a fake second insert set out of one card
// spelled two ways across two sheets. `player-identity.cjs` is the shared
// reduction the rest of the repo already uses for exactly this question
// (playerIdentityKey.ts's own header: accents fold to their base letter,
// identity-bearing symbols transliterate to the market's own spelling,
// then everything else outside a-z0-9 is deleted) -- loaded the same
// defensive way `player-evidence.cjs`/`market-guard.cjs` already do, so a
// tree without `dist/` built degrades to the pre-fix bare reduction rather
// than throwing.
const { playerIdentityKey } = require(path.join(__dirname, "lib", "player-identity.cjs"));
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
// CF-BECKETT-S3-SOURCE-LABEL (2026-09-19). Optional, additive. Distinguishes
// a checklist fetched directly from the S3 origin (beckett-www.s3.amazonaws.com)
// via discoverBeckettS3Checklists.cjs from the same converter's other callers,
// which read the img.beckett.com CDN URL discoverBeckettChecklists.cjs finds.
// Defaults to "" so every existing caller's manifest is byte-identical.
const SOURCE_LABEL = val("--source-label", "");
// CF-A-DECLARED-PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING (2026-09-20).
// Opt-in escape hatch for the droppedDeclaredParallels guard (see main()):
// when a section's own "Parallels:" block declares a name that produces zero
// rows for that section and the refused line is not recognizably a footnote
// or a hedge phrase, the run FAILS LOUDLY by default rather than emitting a
// plausible-looking row count with a silent gap -- the exact failure mode
// Phoenix's sixteen missing names shipped as before this guard existed. Set
// only when a human has looked at the reported drop and confirmed the name
// genuinely is not a card-bearing parallel (Beckett prints a LOT of ladder
// prose this file has never seen the shape of yet).
const ALLOW_DROPPED_PARALLELS = args.includes("--allow-dropped-parallels");
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

// CF-BECKETT-CHECKLIST-IS-A-TITLE-ARTIFACT-NOT-A-NAME (2026-09-19). Many
// Beckett workbooks title every Autographs/Inserts/Memorabilia section header
// "<Set Name> Checklist" -- "Z Marquee Checklist", "Zoom Blue Checklist" -- but
// the word names the PAGE, not the card set. Left in, it rode straight into the
// category slug and the minted parallel/insert-set-key text
// (`z-marquee-checklist`), which is what a registered insert-set key would then
// carry verbatim forever.
//
// MEASURED, NOT GUESSED, on both committed fixtures: 2024 Panini Zenith
// Football's Master sheet lists the same card sets WITHOUT the suffix ("Z
// Marquee", never "Z Marquee Checklist") for every single Autographs/Inserts/
// Memorabilia section -- 27 of 27 checked -- while its Base sheet's own
// sections ("Base Set", "Rookies", "Rookie Patch Autographs") carry no suffix
// AT ALL on either sheet or Master. 2024 Panini Photogenic Football's ten
// Inserts sections and eight Autographs sections show the identical split.
//
// So this strips a trailing " Checklist" only when BOTH hold:
//   (a) Master's own Card Set column states the same name WITHOUT the suffix
//       (the authority for what the card set is actually called), or, when no
//       Master sheet exists or does not carry this section, when
//   (b) at least one OTHER section on the SAME sheet also carries the exact
//       same suffix -- a sheet-wide title convention, measured from that
//       sheet's own other headers, never assumed from one section alone.
//
// This is why a genuine "Team Checklist" insert (a card literally named that,
// no sibling on its sheet titled the same way, and Master -- if present --
// stating the same full name including the word) is never touched: neither
// gate fires for a section that is alone in carrying the word, and Master's
// own spelling always wins when it disagrees.
function stripChecklistSuffix(section, siblingSectionNames, masterNames) {
  const raw = String(section || "").trim();
  const m = /^(.*\S)\s+Checklist$/i.exec(raw);
  if (!m) return raw;
  const bare = m[1];
  // Master is the authority when it has an opinion at all.
  if (masterNames && masterNames.size) {
    if (masterNames.has(bare.toLowerCase())) return bare;
    if (masterNames.has(raw.toLowerCase())) return raw;
    // Master exists but names neither form for this section -- fall through to
    // the sheet-wide sibling signal rather than guess from Master's silence.
  }
  const siblingsCarryIt = (siblingSectionNames || []).some((other) => {
    if (other === raw) return false;
    return /\sChecklist$/i.test(String(other || "").trim());
  });
  return siblingsCarryIt ? bare : raw;
}

// CF-BECKETT-A-RANGE-LABEL-LINE-IS-A-TABLE-OF-CONTENTS-NOT-A-HEADER
// (2026-09-19). 2024 Panini Zenith Football's Base sheet opens:
//
//     Base Set
//     238 cards.
//     Rookies - #101-200
//     Rookie Patch Autographs - #201-242
//     Parallels:
//     No Huddle
//     ...
//     1  Kyler Murray  Arizona Cardinals
//
// "238 cards." is the count line for the WHOLE tab (100 + 100 + 38 = 238), and
// the two lines under it are a PREVIEW of what the tab contains further down
// -- Beckett prints them once, at the top, before the real "Rookies" section
// (its own header, with its own cards, at row 122) and the real "Rookie Patch
// Autographs" section (row 240). Neither preview line is followed by a single
// card row anywhere near it; the very next content is the "Parallels:" ladder
// and then card #1 Kyler Murray -- who is base-set inventory (#1-100, the
// SAME 100 numbers as "Base Set"'s own range), not a rookie and not a patch
// autograph. Every prior single-cell row closed a section, so the parser
// (correctly, given the shape) treated "Rookie Patch Autographs - #201-242"
// as the new header and filed Base Set's own veteran-autograph cards under
// it. Independently corroborated against checklistinsider.com's 2024 Zenith
// page: the real name of this 100-card set is "Base Autographs" (Kyler
// Murray, Kirk Cousins, Michael Vick all listed there under that name with
// the identical parallel ladder), never "Rookie Patch Autographs" of any
// range -- so this is not a label the source ever meant to attach to these
// cards at all, and the actual downstream category correction lives in the
// package CSV/manifest (traced-to-source, per doctrine), not in a renamed
// slug here.
//
// THE FIX IS NARROW: a single-cell row shaped "<name> - #NNN-NNN" is a
// content-preview line, never a real header, WHEN it sits back-to-back with
// another line of the identical shape (both lines announce ranges; a real
// section header is never followed immediately by a second header of the
// same "- #NNN-NNN" shape with no cards between). Skipping it leaves
// whichever real section was already open (here, "Base Set") in force, so
// the cards that follow land on their true anchor instead of stealing a
// later section's name. Measured across every fixture xlsx in this repo:
// this shape occurs in exactly one workbook, exactly these two consecutive
// lines -- nothing else in the corpus has a bare range-labelled line
// followed immediately by another one.
const RANGE_PREVIEW_LINE = /^.+[–—-]\s*#\s*\d+\s*-\s*\d+$/;

/** Row indices (within one sheet's `rows`) of range-preview lines: a
 *  RANGE_PREVIEW_LINE header immediately adjacent (directly before OR after,
 *  skipping only truly empty rows) to another RANGE_PREVIEW_LINE header. Two
 *  such lines never sit back-to-back by accident -- a real section's range
 *  label, if Beckett ever prints one over a section that actually has its
 *  own cards, is not immediately followed by ANOTHER range label with zero
 *  cards between, because that would mean the first "section" got no cards
 *  at all. Built once per sheet, cheaply, from the same single-cell-header
 *  test main()'s own pass uses (mirrors sheetSectionHeaderNames), so this
 *  never disagrees with what main() treats as a header row. */
function rangePreviewLineIndices(rows) {
  const headerIdx = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!nonEmpty(row)) continue;
    if (isCountLine(row)) continue;
    if (nonEmpty(row) === 1 && row[0]) headerIdx.push(i);
  }
  const isPreview = (i) => RANGE_PREVIEW_LINE.test(String(rows[i][0]).trim());
  const out = new Set();
  for (let h = 0; h < headerIdx.length; h++) {
    const i = headerIdx[h];
    if (!isPreview(i)) continue;
    const prevIsPreview = h > 0 && isPreview(headerIdx[h - 1]);
    const nextIsPreview = h + 1 < headerIdx.length && isPreview(headerIdx[h + 1]);
    if (prevIsPreview || nextIsPreview) out.add(i);
  }
  return out;
}

/** Every distinct value in the Master sheet's first ("Card Set") column,
 *  lower-cased, when the sheet exists and its header row is the expected
 *  shape. Returns an empty Set (never null) so a caller with no Master sheet
 *  degrades to the sibling-suffix signal alone rather than special-casing
 *  "no Master" at every call site. */
function masterCardSetNames(sheets) {
  const rows = sheets["Master"];
  const out = new Set();
  if (!rows || !rows.length) return out;
  const header = (rows[0] || []).map((c) => String(c || "").trim().toLowerCase());
  if (!/^card\s*set$/i.test(header[0] || "")) return out;
  for (const r of rows.slice(1)) {
    const name = String((r || [])[0] || "").trim();
    if (name) out.add(name.toLowerCase());
  }
  return out;
}

/**
 * CF-A-SELECT-CARDS-ONLY-RUNG-NEEDS-ITS-OWN-ROSTER (2026-09-20, review fix).
 *
 * Master's own "Card Set" column is the most direct evidence a workbook can
 * offer for "which cards actually carry rung X": measured on 2023 Topps
 * Series 1 and Series 2 Baseball, Master lists exactly 100 rows tagged
 * "Clear" (out of 330 base cards) for the ladder's `Clear - /10 (select
 * cards, see below; hobby only)` rung -- the restricted roster the ladder's
 * own note points at.
 *
 * DELIBERATELY POSITIONAL, never assumes a header row: masterCardSetNames
 * (above) requires row 0 to read literally "Card Set" and returns an empty
 * Set otherwise -- both 2023 workbooks' Master sheets open directly on data
 * (`["Base", 1, "Juan Soto", "San Diego Padres"]`, no header at all), so that
 * function silently sees no Master sheet for either file. This reads every
 * row of column 0 as a card-set label unconditionally; a genuine header row
 * ("Card Set", "Base") simply never matches a real rung name and is ignored
 * on its own (rung names are colour/finish words, not literally "Card Set").
 *
 * Returns Map<cardNumber (uppercased string), Set<normalizeRosterPlayer>>
 * for the requested card-set label (case-insensitive exact match on column
 * 0), or null when Master has no row at all under that label -- the caller
 * uses null, not an empty Map, to mean "no list found in this workbook",
 * per CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE below.
 */
function masterRosterFor(sheets, cardSetLabel) {
  const rows = sheets["Master"];
  if (!rows || !rows.length) return null;
  const wanted = String(cardSetLabel || "").trim().toLowerCase();
  if (!wanted) return null;
  const out = new Map();
  let found = false;
  for (const r of rows) {
    const label = String((r || [])[0] || "").trim().toLowerCase();
    if (label !== wanted) continue;
    found = true;
    const num = String((r || [])[1] || "").trim();
    const player = String((r || [])[2] || "").trim();
    if (!num || !player) continue;
    const key = num.toUpperCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(normalizeRosterPlayer(player));
  }
  return found ? out : null;
}

/** Every single-cell header row on one sheet, in the shape stripChecklistSuffix
 *  needs to test "do this sheet's OTHER sections carry the same suffix" --
 *  built once per sheet, cheaply, from the same non-empty/non-ladder test
 *  main()'s own pass uses, so this never disagrees with what main() treats as
 *  a section header. */
function sheetSectionHeaderNames(rows) {
  const out = [];
  let inLadder = false;
  for (const row of rows) {
    if (!nonEmpty(row)) continue;
    if (isCountLine(row)) continue;
    if (nonEmpty(row) === 1 && row[0]) {
      const cell = String(row[0]).trim();
      if (LADDER_HEAD.test(cell)) { inLadder = true; continue; }
      if (PLACEHOLDER.test(cell)) continue;
      // CF-BECKETT-AN-ODDS-LINE-IS-NEVER-A-SECTION-NAME (see its own header
      // comment above): never a sibling header name either, or a workbook
      // whose sections are all named after their own odds line would make
      // stripChecklistSuffix compare against those odds lines as if they
      // were real titles.
      if (!inLadder && ODDS_LINE.test(cell)) continue;
      // CF-BECKETT-A-FOOTNOTE-SENTENCE-IS-NEVER-A-SECTION-NAME (see its own
      // header comment above FOOTNOTE_LINE's definition): never a sibling
      // header name either, for the same reason ODDS_LINE is excluded above.
      if (!inLadder && FOOTNOTE_LINE.test(cell)) continue;
      // CF-BECKETT-A-HEDGE-PRINT-RUN-FOOTNOTE-IS-NEVER-A-SECTION-NAME (see
      // its own header comment above HEDGE_PRINT_RUN_FOOTNOTE's definition):
      // never a sibling header name either, same reason as FOOTNOTE_LINE.
      if (!inLadder && HEDGE_PRINT_RUN_FOOTNOTE.test(cell)) continue;
      if (inLadder) { if (!parseRung(cell)) continue; else continue; }
      out.push(cell);
      inLadder = false;
      continue;
    }
    inLadder = false;
  }
  return out;
}

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
// CF-BECKETT-A-BRAND-WIDE-FINISH-SUFFIX-IS-NOT-A-NEW-PRODUCT (2026-09-19).
// A section header that is ALSO the whole product's own base card stock name
// ("Prizm" on every 2024 Panini Select Football section; "Mosaic" on every
// 2024 Panini Mosaic Football section, since each product IS printed on that
// finish) carries the brand word as REDUNDANT PROSE, not as a distinct
// insert set's own name -- but categoryFor has no way to tell that from a
// genuinely independent insert whose title happens to end the same way,
// short of a registered-key lookup this offline converter does not have.
//
// MEASURED, NOT GUESSED: this map holds ONLY category slugs verified, by
// hand, against `backend/src/services/catalog/productSetKeys.ts`, to be a
// trailing-brand-suffix spelling of an ALREADY-REGISTERED sibling key with
// no suffix at all --
//
//   insert-sparks-prizm                    -> insert-sparks                 (panini-select-sparks registered)
//   insert-jumbo-rookie-swatch-prizm        -> insert-jumbo-rookie-swatch     (panini-select-jumbo-rookie-swatch)
//   insert-draft-selections-memorabilia-prizm -> insert-draft-selections-memorabilia
//   insert-rookie-swatches-prizm           -> insert-rookie-swatches         (panini-select-rookie-swatches)
//   auto-select-signatures-prizm           -> auto-select-signatures         (panini-select-select-signatures)
//   auto-signatures-prizm                  -> auto-signatures                (panini-select-signatures)
//   auto-rookie-signature-memorabilia-prizm -> auto-rookie-signature-memorabilia
//   auto-jumbo-rookie-signature-swatches-prizm -> auto-jumbo-rookie-signature-swatches
//   auto-2025-xrc-mystery-autograph-prizm  -> auto-2025-xrc-mystery-autograph (panini-select-2025-xrc-mystery-autograph)
//   auto-jumbo-signature-swatches-prizm    -> auto-jumbo-signature-swatches   (panini-select-jumbo-signature-swatches)
//   insert-center-stage-mosaic             -> insert-center-stage            (panini-mosaic-center-stage, pre-existing)
//   insert-overdrive-mosaic                -> insert-overdrive               (panini-mosaic-overdrive, pre-existing)
//
// EVERY OTHER "-prizm"/"-mosaic" category on either file is LEFT ALONE --
// most of Select's own Prizm-suffixed sections (Signatures Prizm's rookie
// sibling Rookie Signatures Prizm, Jumbo Signature Swatches Prizm, etc.) and
// most of Mosaic's own Mosaic-suffixed sections (Capital Gains Mosaic,
// Splash Mosaic, Storm Mosaic, Micro Mosaic) are each their OWN genuinely
// new named insert set with no un-suffixed registered sibling at all --
// #2342 registers those, deliberately, rather than folding them here. A
// blanket "always strip the trailing brand word" rule was considered and
// rejected: it is exactly the unbounded-whitelist trap PLAIN_SECTION's own
// history already warns this file about, just aimed at a suffix instead of
// a whole name, and it would have silently merged Capital Gains Mosaic into
// a "Capital Gains" key that does not exist and should not.
//
// This table is therefore a closed, hand-verified list of SPELLING fixes
// for keys that already have a registered sibling -- not a general finish-
// word stripper, and not something a future acquisition should extend
// without first checking the registered key table the same way.
//
// SCOPED BY PRODUCT SET KEY (2026-09-20, review fix). A flat, unscoped map
// keyed on the slug ALONE would rewrite an unrelated product's own
// coincidentally-identical category the same way -- nothing stops some
// future workbook's own "Sparks Prizm" section (a different product, a
// different roster, no relationship to Select's registered
// panini-select-sparks at all) from silently landing on
// panini-select-sparks's address the moment its raw slug happens to match.
// Each entry is therefore keyed `${SET_KEY}::${rawSlug}`, so a fold only
// ever fires for the EXACT product it was hand-verified against.
const CANONICAL_CATEGORY_SLUG = {
  "panini-select::insert-sparks-prizm": "insert-sparks",
  "panini-select::insert-jumbo-rookie-swatch-prizm": "insert-jumbo-rookie-swatch",
  "panini-select::insert-draft-selections-memorabilia-prizm": "insert-draft-selections-memorabilia",
  "panini-select::insert-rookie-swatches-prizm": "insert-rookie-swatches",
  "panini-select::auto-select-signatures-prizm": "auto-select-signatures",
  "panini-select::auto-signatures-prizm": "auto-signatures",
  "panini-select::auto-rookie-signature-memorabilia-prizm": "auto-rookie-signature-memorabilia",
  "panini-select::auto-jumbo-rookie-signature-swatches-prizm": "auto-jumbo-rookie-signature-swatches",
  "panini-select::auto-2025-xrc-mystery-autograph-prizm": "auto-2025-xrc-mystery-autograph",
  "panini-select::auto-jumbo-signature-swatches-prizm": "auto-jumbo-signature-swatches",
  "panini-mosaic::insert-center-stage-mosaic": "insert-center-stage",
  "panini-mosaic::insert-overdrive-mosaic": "insert-overdrive",
};

// `setKeyOverride` lets a test (or a future caller) exercise the scoping
// directly without going through the CLI arg parser; main()'s own call
// sites never pass it, so they always scope on the real `--set-key`.
function categoryFor(sheetName, section, setKeyOverride) {
  const raw = categoryForRaw(sheetName, section);
  const setKey = setKeyOverride !== undefined ? setKeyOverride : SET_KEY;
  const scoped = CANONICAL_CATEGORY_SLUG[`${setKey}::${raw}`];
  return scoped || raw;
}

function categoryForRaw(sheetName, section) {
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
  //
  // CF-BECKETT-BASE-SHEET-IS-NOT-ONE-SECTION (2026-09-19). The line above
  // tested the SHEET only, so it returned "base" for EVERY section printed on
  // a tab named Base/Prospects, including subsets that are their own distinct
  // card run and share the tab only because Beckett put them there — 2024
  // Panini Zenith Football's Base tab carries three: "Base Set" (#1-100),
  // "Rookies" (#101-200), and "Rookie Patch Autographs" (#201-242, SIGNED).
  // categoryFor("Base", "Rookie Patch Autographs - #201-242") returned "base",
  // which in classifySections makes the section an explicitAnchor — bypassing
  // the extendsName title-containment guard entirely — AND sets isAuto=false
  // on 100 cards Beckett's own Master sheet lists as autographed. This is the
  // exact "categoryFor returned base for everything on the sheet" collapse
  // CF-EVERY-INGEST-USES-THE-ONE-FORMAT (2026-08-26) documented for
  // checklistinsider, now found natively in this converter: a sheet name is
  // not a section.
  //
  // A whitelist of "what the plain run is called" is the wrong shape of fix —
  // tried first, and it broke 2026 Topps Tier One, whose plain run is spelled
  // "Base - Tier 1" / "Base - Tier 2" / "Base - Tier 3" (a tier-numbered
  // three-way split with no single canonical name at all). Guessing every
  // spelling a publisher might use for "this is the plain run" is the same
  // unbounded-whitelist trap PLAIN_SECTION's own history already warns about.
  //
  // The one thing that is NEVER true of a plain, unsigned base/rookie/prospect
  // run — on any Beckett workbook seen so far — is that its own section name
  // says SIGNED. That is the one bit of section-name evidence this file can
  // trust without a whitelist, and it is also the only bit whose absence
  // caused real harm (isAuto=false on signed cards). So: stay permissive for
  // every section on a Base/Prospects sheet EXCEPT one that names itself
  // Autograph/Signed — that one is never the plain run, however plain its
  // sheet's name is, and falls through to auto-<subset> below instead.
  const sectionNorm = String(section || "").trim();
  const looksSigned = /\bautograph|\bautographed\b|\bsign(ed|atures?)\b/i.test(sectionNorm);
  if (/^base\b|^prospects?\b/i.test(sheet) && !looksSigned) return "base";
  // A section on the Base/Prospects sheet that says SIGNED in its own name
  // (Rookie Patch Autographs, Autographed Rookies, ...) is an auto subset that
  // merely shares the tab with the plain run — never file it as "insert-" just
  // because its SHEET's own name doesn't happen to say "Autograph" too.
  if (looksSigned) return "auto-" + s;
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

// CF-BECKETT-ROSTER-FOLD-FOR-NAMELESS-SECTIONS (2026-09-19). classifySections's
// existing fold only ever tries a section against an anchor whose NAME the
// section extends (extendsName) or that is an explicitAnchor paired with a
// FINISH_WORD spelling. Neither test can see a section like "Hobby Exclusive"
// or "Super Box Exclusive": it shares no name token with "Base Set" and is not
// a colour/finish word, so it never becomes a fold candidate at all and stays
// its own section with a blank parallel column -- even when every card it
// lists is, in fact, the identical base card by number AND by player. Measured
// on 2026 Topps Series 1 Baseball (S3, 2026-09-19): 5 of 7 such sections are
// clean 100% roster subsets of Base Set on every shared number, and 2 more are
// clean subsets plus exactly one card with no base counterpart at all.
//
// THE ROSTER IS THE FALLBACK TEST, TRIED ONLY WHEN THE NAME TEST FINDS
// NOTHING. A section that already has a naming relationship to some anchor is
// decided by that relationship, unchanged -- this never overrides an existing
// fold, it only rescues the sections that had no fold candidate to test in the
// first place (`candidates.length === 0`, so `best` stays null and rungName
// never runs).
//
// R67 (Drew, ruling round of 2026-09-19): same numbers + a same-or-subset
// roster is a PARALLEL, whatever word the section used for the variant.
// normalizeRosterPlayer is the shared comparison: split on "/", trim,
// reduce EACH name through playerIdentityKey (accents fold, identity
// symbols transliterate, punctuation/case become noise -- see the
// player-identity.cjs require above), de-duplicate, sort (players split so
// "Will Shipley/Xavier Legette" and "Xavier Legette / Will Shipley" agree)
// -- AND strip a trailing " RC" first, because Beckett's own RC flag
// (appended in pass 1 above, `player += " RC"`) is stamped onto the player
// field by SOME sheets (the Base sheet, and any parallel section built from
// the same sheet layout) and never by others for the identical card, which
// would otherwise read as a disagreement that is really a formatting
// artifact, not a different player. The explicit RC strip stays even though
// playerIdentityKey's own cleanPlayerName pass also strips it -- belt and
// suspenders, and it keeps this function's contract readable on its own.
function normalizeRosterPlayer(player) {
  return String(player || "")
    .split("/")
    .map((p) => playerIdentityKey(p.trim().replace(/\s+RC$/i, "")))
    .filter(Boolean)
    .sort()
    .join("/");
}

// A section's roster is a clean fold candidate against `anchor` when every
// number it shares with the anchor names a subset of the anchor's own roster
// there, with ZERO disagreements. Numbers the section has that the anchor
// lacks are reported separately (`extra`) rather than failing the whole
// section -- R67's own Super Box Exclusive/Funko Pop Autographs case is
// exactly this: 16 of 17 and 1 of 2 rows are a clean subset, and the
// remaining row (#420, no base counterpart at all) is neither a disagreement
// nor a reason to leave the OTHER sixteen rows unfolded.
function rosterFoldAgainst(sec, anchor) {
  let agree = 0, disagree = 0;
  const extra = [];
  // No roster on either side means no evidence, not a crash: a caller that
  // built a section descriptor from numbers alone (every classifySections
  // unit test predating this fold, and any future one) gets "nothing shared,
  // nothing agrees" -- the same answer classifySections's own numeric-only
  // path already gives that shape when it has no roster to consult, so a
  // missing roster degrades to the pre-existing behaviour rather than
  // throwing partway through the second pass.
  if (!sec.roster || !anchor.roster) return { agree: 0, disagree: 0, extra: [], shared: 0 };
  for (const [num, players] of sec.roster) {
    const anchorPlayers = anchor.roster.get(num);
    if (!anchorPlayers) { extra.push(num); continue; }
    const isSubset = [...players].every((p) => anchorPlayers.has(p));
    if (isSubset) agree++; else disagree++;
  }
  return { agree, disagree, extra, shared: agree + disagree };
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
  // Hoisted out of the per-section loop below (2026-09-20, Donruss FB fold)
  // so the nameless-section roster-fold pass further down can reuse the
  // identical containment test rather than re-deriving it -- see that pass's
  // own header comment for why it now also needs this.
  const extendsName = (cand, anchor) => {
    const at = tokens(anchor.section).map((t) => t.toLowerCase());
    const ct = tokens(cand.section).map((t) => t.toLowerCase());
    return at.length > 0 && ct.length > at.length && at.every((t) => ct.includes(t));
  };

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
    // no words left to name the rung with. (extendsName itself is hoisted to
    // this function's outer scope above, so the nameless-fold pass further
    // down can reuse it too.)
    // CF-BECKETT-EXPLICIT-ANCHOR-IS-NOT-A-BLANK-CHEQUE (2026-09-19). The
    // explicitAnchor branch above exists for "International Refractors" on
    // 2026 Bowman Chrome — a real rung whose section header extends nothing
    // ("Chrome Prospects" is not a token of it) and would otherwise never
    // clear extendsName. But left unconditional it also cleared for 2024
    // Panini Photogenic Football's "Avatars" / "Draft Snapshots" / "Troops
    // Tribute" / seven more — genuinely independent named insert sets whose
    // own numbering (1-10, 1-20) happens to be a SUBSET of Base Set's #1-100,
    // so the numeric-overlap test alone found a 100% match and folded every
    // one of them onto Base Set as a false parallel, the same "sheet name /
    // explicitAnchor waives the containment guard" hole
    // CF-BECKETT-BASE-SHEET-IS-NOT-ONE-SECTION already found and fixed for
    // categoryFor. The bypass is only safe for a section that is ITSELF
    // evidence of a finish/rung rather than a product name — FINISH_WORD
    // already carries that vocabulary for ladder lines; a section header
    // just is a longer line to test it against.
    const looksLikeFinishName = (cand) => FINISH_WORD.test(cand.section);
    // CF-BECKETT-THE-ROSTER-DECIDES-THE-EXPLICIT-ANCHOR-FOLD-TOO (2026-09-19).
    // looksLikeFinishName narrowed the bypass from "any explicitAnchor" to
    // "an explicitAnchor whose CANDIDATE section merely contains a finish
    // word" -- but a finish word in a section's own name is not proof the
    // section IS a finish/rung rather than an independently named insert
    // product that happens to be printed in that finish. 2024 Panini Select
    // Football's Memorabilia sheet lists "Draft Selections Memorabilia
    // Prizm" (25 cards, #1-25), "Jumbo Rookie Swatch Prizm" (42, #1-42),
    // "Rookie Swatches Prizm" (25, #1-25) and "Sparks Prizm" (58, #1-58) --
    // four already-registered named insert products whose own numbering is a
    // 100% SUBSET of Base>Base Concourse's #1-100 range, so looksLikeFinishName
    // (true: each contains "Prizm") plus the numeric-overlap test alone was
    // enough to fold all four onto Base Concourse as fabricated parallel
    // names ("parallel=Draft Selections Memorabilia Prizm" on a base row),
    // when their ACTUAL rosters disagree with Concourse card-for-card
    // (measured: Base Concourse #1 = Tory Taylor; the four sections' own #1 =
    // Caleb Williams / Adonai Mitchell / Caleb Williams / Kurt Warner) --
    // 150 rows, plus 832 id collisions downstream. rosterFoldAgainst already
    // exists and already correctly reports disagree > 0 for this exact
    // pairing; this bypass just never consulted it, unlike the roster-fold
    // pass much further down in this same function.
    //
    // Doctrine: "the roster decides" (R67, and CF-A-NAMED-INSERT-SET-IS-ITS-
    // OWN-CARD-SET before it). A colour/finish rung is a parallel of its
    // anchor only when it reprints the anchor's own roster; a named insert
    // set is its own card set whatever finish word its title happens to use.
    // So the explicitAnchor+FINISH_WORD bypass now additionally requires
    // rosterFoldAgainst to find at least one shared number and ZERO
    // disagreements -- the identical bar the nameless-section roster-fold
    // pass already holds itself to. "International Refractors" on Bowman
    // Chrome and "Chrome Prospect Packfractor Autographs" both still clear
    // this (their rosters, where numbers overlap the anchor at all, agree);
    // Select's four Memorabilia sections do not, and fall through to
    // own-cards under their own registered category exactly as intended.
    // ABSENT ROSTER DATA IS NOT A DISAGREEMENT (2026-09-20 correction, found
    // by CI). `rosterFoldAgainst` returns `shared: 0` both when the rosters
    // genuinely share zero numbers AND when either side carries no `roster`
    // map at all (its own documented degrade-gracefully behaviour, so a
    // caller built from numbers alone -- every classifySections unit test
    // predating this bypass, including checklistVariationIsAParallel.test.ts's
    // own Packfractor/International-Refractors fixtures, which construct a
    // section descriptor with numbers only, no roster -- gets the exact same
    // "nothing to disagree with" answer a roster-blind fold already gave).
    // The FIRST version of this fix treated `shared > 0` as the gate, which
    // made an absent roster read as "roster refuses" and broke every one of
    // those pre-existing tests -- fold something can't be more disagreeable
    // than what it never SAW.
    //
    // PARTIAL AGREEMENT IS NOT THE SAME QUESTION AS ZERO AGREEMENT (2026-09-20,
    // second review round). The bar here decides whether `a` is even a fold
    // CANDIDATE at all -- it must stay permissive for "at least some genuine
    // evidence of agreement, whatever the rest of the roster says", because
    // the actual per-number split (fold the agreeing numbers, hold out the
    // rest) is a SEPARATE decision made once a fold is chosen as `best`,
    // below, via the same foldExceptions mechanism the nameless-section
    // roster-fold pass already uses for its own #420 (R67 Super Box
    // Exclusive) shape. 2023 Topps Chrome Platinum's "Image Variations" (25
    // rows, 16 agree with base as a true photo variation, 9 name a
    // completely different card at the same number) needs exactly this: a
    // bar of "zero agreement" here would have refused the whole section, but
    // the 16 genuine variations are real evidence the fold IS live and only
    // 9 rows need holding out. 2026 Topps Series 1's "Golden Mirror Legend
    // Variations" (0/51 agree with base at all) still correctly finds NO
    // candidate here and falls through to own-cards, because zero shared
    // agreement is exactly the "no evidence this is a rung of anything"
    // case the bar exists to catch.
    //
    // "AT LEAST ONE" IS NOT ENOUGH -- A MAJORITY IS THE BAR (found live,
    // 2026-09-20, third pass). `fold.agree > 0` let a single COINCIDENTAL
    // match through: 2024 Panini Select Football's "Jumbo Rookie Swatch
    // Prizm" (42 cards, its own numbering, its own registered key) shares
    // exactly ONE number with Base>Base Concourse where the SAME real
    // person happens to sit at the SAME number in both -- #29 Malik Nabers,
    // pure coincidence across two independently-numbered 42-card and
    // 100-card checklists -- while the other 41 disagree outright. One
    // coincidence is not evidence a 42-card named insert is secretly a
    // rung of base; it very nearly re-created the exact false-fold this
    // whole bypass exists to prevent, just gated one match short of zero
    // instead of at zero. The bar is now a genuine MAJORITY: strictly more
    // agreements than disagreements. Verified against both measured cases:
    // Image Variations (16 agree, 9 disagree -- 16 > 9, clears) and Jumbo
    // Rookie Swatch Prizm (1 agree, 41 disagree -- 1 is not > 41, refused,
    // falls through to its own registered own-cards category).
    const rosterHasAgreeingMajority = (cand, anchor) => {
      if (!cand.roster || !anchor.roster) return true;
      const fold = rosterFoldAgainst(cand, anchor);
      // No roster overlap AT ALL (fold.shared === 0) is "nothing to agree or
      // disagree about" -- degrades to the pre-existing roster-blind numeric
      // decision, same as the absent-roster case above.
      return fold.shared === 0 || fold.agree > fold.disagree;
    };
    const candidates = anchors.filter((a) =>
      a !== sec && isAutoSection(a) === isAutoSection(sec) &&
      ((a.explicitAnchor && looksLikeFinishName(sec) && rosterHasAgreeingMajority(sec, a)) ||
        extendsName(sec, a)));
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
      // PARTIAL FOLD ON A DISAGREEING ROSTER (2026-09-20, review fix). The
      // explicitAnchor+FINISH_WORD path (`a.explicitAnchor &&
      // looksLikeFinishName(sec)`, never `extendsName`) can win `best` with
      // 100% numeric overlap while its roster only PARTLY agrees with the
      // anchor -- 2023 Topps Chrome Platinum's "Image Variations" is the
      // measured case: 16 of 25 numbers are a true photo variation of the
      // identical base card, the other 9 name a different player entirely
      // at the same number. Held out via `foldExceptions`, the SAME
      // mechanism the nameless-section roster-fold pass below already uses
      // for R67's own #420 (Super Box Exclusive) shape: the agreeing
      // numbers fold onto the anchor as the named parallel; the disagreeing
      // numbers stay on this section's own category with a blank parallel,
      // never silently merged into either address. Only checked for the
      // explicitAnchor route -- an ordinary extendsName fold (Packfractor,
      // International Refractors) has no roster-disagreement question at
      // all once its numbers are a 100% subset, and this must never touch
      // that path's own, already-correct all-or-nothing behaviour.
      const viaExplicitAnchor = best.anchor.explicitAnchor && looksLikeFinishName(sec) && !extendsName(sec, best.anchor);
      if (viaExplicitAnchor && sec.roster && best.anchor.roster) {
        const rosterFold = rosterFoldAgainst(sec, best.anchor);
        if (rosterFold.disagree > 0) {
          if (rosterFold.agree <= rosterFold.disagree) {
            // Not a genuine majority -- see rosterHasAgreeingMajority above
            // for why "at least one agreement" is not enough (the Jumbo
            // Rookie Swatch Prizm/Malik Nabers #29 coincidence). Falls
            // through to own-cards below exactly as a section with no
            // candidate would.
            best = null;
          } else {
            // Genuine partial fold: hold out the disagreeing numbers under
            // this section's own category (blank parallel, same shape every
            // other foldExceptions case uses), fold the rest onto the anchor
            // as the named parallel.
            const disagreeing = new Set();
            for (const [num, players] of sec.roster) {
              const anchorPlayers = best.anchor.roster.get(num);
              if (anchorPlayers && ![...players].every((p) => anchorPlayers.has(p))) disagreeing.add(num);
            }
            sec.foldExceptions = disagreeing;
            sec.parallelOf = best.anchor;
            sec.rung = rung;
            push(sec, {
              role: "parallel", anchor: best.anchor.key, rung: rung,
              rosterFold: true, agree: rosterFold.agree, disagree: rosterFold.disagree,
              heldNumbers: [...disagreeing],
            });
            continue;
          }
        }
      }
      if (best) {
        sec.parallelOf = best.anchor;
        sec.rung = rung;
        push(sec, { role: "parallel", anchor: best.anchor.key, rung: rung });
        continue;
      }
    }

    // CF-A-SELECT-CARDS-ONLY-EXTRA-IS-NOT-AN-AMBIGUITY (2026-09-20, Donruss
    // FB). best.pct < 1 via extendsName used to fall straight to own-cards-
    // AMBIGUOUS below, however clean the roster evidence was, because the
    // pct===1 gate above only ever asked "does every number match", never
    // "does every NON-match have an innocent explanation". 2024 Panini
    // Donruss Football's "Rated Rookies Autographs Orange" (51 cards) is a
    // "select cards only" colour rung of "Rated Rookies Autographs" (63
    // cards, itself now folded onto Base>Rated Rookies by the roster-fold
    // pass above) -- 50 of its 51 numbers are the identical rookie at the
    // identical number (98% -- Beckett's own note explains the pct
    // shortfall: not every base card got an Orange print), and the 51st
    // (#364 Tyrone Tracy Jr.) has literally no counterpart in the anchor's
    // own 63-card listing at all -- the exact R67 #420 "extra" shape the
    // nameless-section roster-fold pass already treats as a hold-out, not
    // a disagreement. "Rated Rookies Autographs Purple" (94.2%) is the
    // identical shape. Scoped to extendsName only (never explicitAnchor,
    // which keeps its own separate, already-correct partial-fold branch
    // above) and requires the roster to account for the ENTIRE shortfall as
    // extras with zero disagreements -- a shortfall roster-blind evidence
    // cannot explain, or that includes even one real disagreement, still
    // falls through to own-cards-AMBIGUOUS unchanged.
    const extendsNameMatch = best && best.anchor && extendsName(sec, best.anchor);
    let rosterExtraFold = null;
    if (best && best.pct > 0 && best.pct < 1 && extendsNameMatch && sec.roster && best.anchor.roster) {
      const rf = rosterFoldAgainst(sec, best.anchor);
      if (rf.disagree === 0 && rf.agree > 0 && rf.agree + rf.extra.length === sec.numbers.size) {
        rosterExtraFold = rf;
      }
    }
    if (rosterExtraFold) {
      const rung = rungName(sec.section, best.anchor.section);
      if (rung) {
        sec.parallelOf = best.anchor;
        sec.rung = rung;
        sec.foldExceptions = new Set(rosterExtraFold.extra);
        push(sec, {
          role: "parallel", anchor: best.anchor.key, rung: rung,
          rosterFold: true, agree: rosterExtraFold.agree, disagree: 0,
          heldNumbers: rosterExtraFold.extra,
        });
        continue;
      }
      // No rung name to fold under -- fall through to own-cards below, same
      // "a fold that cannot be named is not a fold" doctrine as the
      // pct===1 branch's own UNNAMEABLE case above.
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

  // CF-BECKETT-ROSTER-FOLD-FOR-NAMELESS-SECTIONS (2026-09-19), a SEPARATE pass
  // run only after every name-based fold above has finished. The existing loop
  // only ever tries a section against an anchor whose NAME it extends
  // (extendsName) or an explicitAnchor paired with a FINISH_WORD spelling.
  // Neither test can see a section like "Hobby Exclusive" or "Super Box
  // Exclusive": it shares no name token with "Base Set" and is not a colour/
  // finish word, so it falls through to `own-cards` above even when every card
  // it lists is, in fact, the identical base card by number AND by player.
  // Measured on 2026 Topps Series 1 Baseball (S3, 2026-09-19): 7 such sections,
  // 5 clean 100% roster subsets of Base Set plus 2 more that are clean subsets
  // except for one card each with no base counterpart at all.
  //
  // WHY THIS MUST BE ITS OWN PASS, NOT INLINE ABOVE. Photogenic's "Base
  // Autographs" (61 cards, signed, same roster as Base Set) and "Base Silver
  // Autographs" (49 cards, extends "Base Autographs"'s name) are the negative
  // case: tried inline, in size order, "Base Autographs" is classified BEFORE
  // "Base Silver Autographs" ever gets a chance to claim it as an anchor via
  // the ordinary extendsName fold, an inline roster-fold would immediately
  // steal "Base Autographs" onto plain Base Set as `parallel="Base
  // Autographs"` -- destroying the two-level hierarchy ("Base Autographs" its
  // own anchor; "Base Silver Autographs" a Silver rung ON IT, never on plain
  // base) that CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY's own photogenic
  // ruling requires (isAuto is its own axis: a same-roster signed section
  // that some OTHER section's name extends must stand as its own anchor, not
  // fold). Run AFTER the main loop, `anchors` already reflects every section
  // the ordinary fold chose to make a hub -- HUB-ness is exactly the fact a
  // same-pass roster-fold cannot see about a section not yet processed.
  //
  // A section already claimed as a hub by some OTHER section (own-cards or
  // not) is excluded, whatever its own roster looks like -- it already has an
  // identity nothing here should override.
  //
  // THE ANCHOR MUST BE THE FILE'S FLAGSHIP RUN SPECIFICALLY -- PLAIN_SECTION,
  // never merely `category === "base"`. CF-BECKETT-BASE-SHEET-IS-NOT-ONE-
  // SECTION made "base" permissive for every unsigned section on a Base/
  // Prospects SHEET, so a workbook can carry several base-category anchors
  // side by side: 2024 Panini Zenith Football's Base sheet holds "Base Set",
  // "Rookies" AND "Rookie Patch Autographs", all category "base". Zenith's
  // own registration (#2276) folds "Rookies Autographs No Huddle" / "...Two
  // Minute Drill" / "Rookies Red Zone Autographs*" onto "Rookies" (an INSERT
  // anchor, its own registered `panini-zenith-rookies-autographs` product)
  // precisely because a same-roster signed retailer-name cluster of a NAMED
  // INSERT is its own product, not a parallel of the FLAGSHIP base card --
  // `anchors.find(a => a.category === "base")` picked whichever base-category
  // anchor came first and folded them onto it as literal-title parallels,
  // which is wrong on both counts (wrong anchor, and these should not fold at
  // all). PLAIN_SECTION is already the file's own test for "this is the plain
  // run, not a same-sheet sibling insert" -- reused here for the identical
  // reason it protects the explicitAnchor bypass above.
  const isHub = (s) => all.some((o) => o.parallelOf === s);
  const stillUnfolded = report.filter((r) => /^own-cards($|-)/.test(r.role) && r.role !== "own-cards-AMBIGUOUS");
  for (const r of stillUnfolded) {
    const sec = sections.get(r.sheet + ">" + r.section);
    if (!sec || sec.parallelOf) continue;
    // CF-BECKETT-A-SIGNED-ROSTER-FOLD-CAN-NAME-ITS-OWN-NON-FLAGSHIP-ANCHOR
    // (2026-09-20, Donruss FB). 2024 Panini Donruss Football's "Rated
    // Rookies Autographs" (base #301-400, category auto-rated-rookies-
    // autographs) names "Rated Rookies" (base #301-400, category "base")
    // explicitly in its own header -- extendsName's tokens-subset test
    // already confirms it ("Rated Rookies" subset of "Rated Rookies
    // Autographs"), the same relation "X - Image Variations" has to "X" in
    // the main loop above. The main loop itself cannot make this fold: its
    // candidates filter requires isAutoSection(anchor) === isAutoSection
    // (sec) before extendsName is even tried (deliberately -- "a non-auto
    // insert cannot be a rung on a signed card"), which also blocks the
    // opposite, legitimate direction this fold exists for (a SIGNED section
    // as the parallel of an UNSIGNED base anchor -- R67: "isAuto is its own
    // axis, not the address", already relied on by pass 3's own isAuto-
    // from-the-section's-own-category comment). Computed BEFORE the isHub
    // gate below, because whether this section has a named anchor decides
    // how that gate treats it.
    // CF-THE-BARE-SIGNED-TIER-ADDS-NOTHING-BUT-AUTOGRAPHS (2026-09-20,
    // Donruss FB, review fix). extendsName + a clean roster fold alone is
    // NOT enough evidence -- it also matches 2024 Panini Zenith Football's
    // "Rookies Autographs No Huddle" against "Rookies" (same roster, and
    // "rookies" IS a token subset of "rookies autographs no huddle"), which
    // this pass's own pinned negative-case test requires to stay unfolded:
    // "No Huddle" is a genuine retailer-exclusive PRODUCT name (Zenith's own
    // real registration, #2276, gives it its OWN key, `panini-zenith-
    // rookies-autographs`, rather than folding it here) that classifySections
    // alone cannot distinguish from a colour/finish rung by roster evidence
    // -- exactly the same "own-named product vs. parallel" question
    // CF-THE-ROSTER-DECIDES-THE-EXPLICIT-ANCHOR-FOLD-TOO already needed
    // rosterHasAgreeingMajority for, one level up. The distinguishing signal
    // here is different and narrower: rungName(sec.section, a.section) --
    // the candidate's own name with the anchor's tokens AND the bare word
    // "Autograph(s)" stripped -- must reduce to EMPTY. "Rated Rookies
    // Autographs" strips to "" (nothing left after "Rated"/"Rookies"/
    // "Autographs" are all removed): it adds NO further distinguishing word
    // beyond stating it is the signed version of the anchor, so it is the
    // bare signed TIER, never a separately-named product. "Rookies
    // Autographs No Huddle" strips to "No Huddle": a real added name, the
    // same shape a genuine own-named insert always has, so it is correctly
    // refused here and left for a human/registration to decide, exactly as
    // it already is today.
    const namedAnchor = anchors.find((a) =>
      a !== sec && a.category === "base" && !PLAIN_SECTION.test(normSection(a.section)) &&
      extendsName(sec, a) && !rungName(sec.section, a.section));
    // CF-A-HUB-CAN-ITSELF-BE-A-NAMED-PARALLEL-TWO-LEVELS-UP (2026-09-20,
    // Donruss FB). isHub(sec) still refuses to fold a hub onto the
    // FLAGSHIP -- that is exactly Photogenic's own protected shape ("Base
    // Autographs" stays its own anchor so "Base Silver Autographs" has
    // somewhere to land, never collapsed onto plain Base Set; "Base
    // Autographs" has no namedAnchor candidate at all, so it is refused
    // here unchanged). But Donruss needs a THIRD level: "Rated Rookies
    // Autographs" is itself a hub (its own colour rungs -- Orange, Purple,
    // the Optic Preview auto -- fold onto it via the main loop's own
    // roster-extra branch above) AND its own name extends a genuine NAMED
    // (non-flagship) base-category anchor, "Rated Rookies". Both facts are
    // true at once and neither contradicts the other: "Rated Rookies
    // Autographs" is correctly the hub its colour rungs address (pass 3
    // reads their `category` off it directly, never recursing through ITS
    // OWN parallelOf), while it is simultaneously, correctly, a signed
    // PARALLEL of the unsigned base product it reprints -- R67's doctrine
    // ("isAuto is its own axis, not the address") is precisely this: a hub
    // for the auto side of the ladder is not disqualified from being a
    // rung on the unsigned side. Scoped to the NAMED-anchor path only --
    // a hub with no namedAnchor candidate still refuses via the flagship
    // exactly as before.
    if (isHub(sec) && !namedAnchor) continue;
    // A hub is never allowed to fall back to the flagship -- that fallback
    // is exactly what Photogenic's own protected shape must keep refusing
    // ("Base Autographs" must never collapse onto plain Base Set even
    // though its roster would agree). A non-hub keeps the ordinary
    // named-anchor-first-then-flagship-fallback behaviour unchanged.
    const flagshipAnchor = isHub(sec) ? undefined :
      anchors.find((a) => a !== sec && a.category === "base" && PLAIN_SECTION.test(normSection(a.section)));
    // TRIED FIRST, NOT ONLY ON A FLAGSHIP MISS. "Rated Rookies" is itself
    // category "base" and is FOUND by the exact same flagship-anchor
    // `.find` above whenever no PLAIN_SECTION-matching anchor exists ahead
    // of it in `anchors`' insertion order -- Base Set always exists first
    // on this workbook, so a flagship candidate is never null here and an
    // "only try the name-extension anchor when the flagship lookup found
    // nothing" gate would never fire for this exact case. The correct
    // precedence is specificity, not presence: a named anchor this
    // section's own title extends is always the more specific candidate
    // when one exists, tried before the flagship fallback below.
    let anchor = namedAnchor || flagshipAnchor;
    if (!anchor) continue;
    let fold = rosterFoldAgainst(sec, anchor);
    // A named anchor that turns out NOT to agree (or shares nothing) is not
    // evidence against the flagship -- fall back to it exactly as if the
    // named anchor had never been found, same "degrade gracefully" contract
    // rosterFoldAgainst's own header documents for a missing roster.
    if (namedAnchor && anchor === namedAnchor && (fold.shared === 0 || fold.disagree > 0) && flagshipAnchor && flagshipAnchor !== namedAnchor) {
      anchor = flagshipAnchor;
      fold = rosterFoldAgainst(sec, anchor);
    }
    if (fold.shared === 0 || fold.disagree > 0) continue;
    const rung = rungName(sec.section, anchor.section) || sec.section;
    sec.parallelOf = anchor;
    sec.rung = rung;
    // CF-A-SIGNED-PRODUCT-FOLDED-AS-A-TIER-KEEPS-ITS-OWN-LADDER (2026-09-20,
    // Donruss FB). Pass 3's CF-EMIT-THE-WHOLE-LADDER gate (`if
    // (!foldsHere)`) suppresses a folded section's ladder by design for the
    // ordinary same-auto-class colour-rung fold ("Base Autographs Silver"
    // folds onto "Base Autographs" as the Silver rung and has no further
    // ladder of its OWN to lose) -- but "Rated Rookies Autographs" is a
    // different shape: it folds UP as the bare signed tier of an unsigned
    // anchor (isAutoSection(sec) !== isAutoSection(anchor), the exact cross-
    // class fold this whole pass exists for), while remaining a real signed
    // PRODUCT with its own further colour ladder (Gold - /25, Black - /10,
    // no "select cards only" qualifier on either -- see the SELECT_CARDS_
    // ONLY_NOTE guard at the emission site, which separately excludes Purple
    // there). Suppressing that ladder here would silently drop two more
    // genuine full-roster parallels for every one of this shape found.
    // Flagged only for the cross-class direction; an ordinary same-class
    // fold (never reaches this branch at all -- it is handled by the main
    // loop above, which has no such flag) is unaffected.
    sec.crossClassFoldKeepsOwnLadder = isAutoSection(sec) !== isAutoSection(anchor);
    // Numbers this section has that base does not (R67's #420 shape): held
    // out of the fold, not disagreements -- they keep their own category and
    // a blank parallel, same as any other own-cards section, while every
    // clean-subset number folds onto base.
    sec.foldExceptions = new Set(fold.extra);
    Object.assign(r, {
      role: "parallel", anchor: anchor.key, rung: rung,
      rosterFold: true, agree: fold.agree, disagree: fold.disagree,
      ...(fold.extra.length ? { heldNumbers: fold.extra } : { overlapPct: undefined }),
    });
    delete r.overlapPct;
    delete r.note;
  }

  // CF-A-HELD-OUT-EXTRA-CAN-STILL-MATCH-THE-GRANDPARENT (2026-09-20, Donruss
  // FB). A held-out "extra" number (no counterpart in the immediate fold
  // anchor's own roster -- R67's #420 shape) is not automatically an orphan
  // if that anchor ITSELF folds one level further up onto a wider root: 2024
  // Panini Donruss Football's "Rated Rookies Autographs Purple" (52 cards)
  // folds onto "Rated Rookies Autographs" (63 cards, the immediate anchor,
  // itself now folded onto "Rated Rookies", 100 cards -- see the cross-class
  // roster fold above) with 1 number (#364 Tyrone Tracy Jr.) held out
  // because RRA's own signed list happens to exclude that player -- but #364
  // genuinely IS a "Rated Rookies" base card (row present, right player,
  // right team), so it is not an orphan at all, only excluded from the
  // MIDDLE tier's own narrower roster. Re-tested here against the immediate
  // anchor's OWN parallelOf (the grandparent, only ever set by the pass just
  // above, which is why this runs after it) using the identical
  // rosterFoldAgainst evidence bar (zero disagreement) -- a number that
  // agrees with the grandparent folds too, under the SAME rung name, and is
  // removed from foldExceptions; a number that disagrees with the
  // grandparent too, or has no counterpart there either, stays held out
  // exactly as before. Never applied beyond one extra level (grandparent
  // only) and never invents a rung name the section did not already carry.
  for (const sec of all) {
    if (!sec.parallelOf || !sec.foldExceptions || !sec.foldExceptions.size) continue;
    const grandparent = sec.parallelOf.parallelOf;
    if (!grandparent || !sec.roster || !grandparent.roster) continue;
    const stillHeld = new Set();
    let rescued = 0;
    for (const num of sec.foldExceptions) {
      const players = sec.roster.get(num);
      const grandparentPlayers = grandparent.roster.get(num);
      if (players && grandparentPlayers && [...players].every((p) => grandparentPlayers.has(p))) {
        rescued++;
      } else {
        stillHeld.add(num);
      }
    }
    if (rescued) {
      sec.foldExceptions = stillHeld;
      const r = report.find((x) => x.sheet === sec.sheet && x.section === sec.section);
      if (r) {
        r.heldNumbers = [...stillHeld];
        if (!stillHeld.size) delete r.heldNumbers;
        r.grandparentRescued = rescued;
      }
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

// CF-BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE-NOT-A-QUIET-SUCCESS
// (2026-09-19). Three converter defects found by this same audit
// (CF-BECKETT-BASE-SHEET-IS-NOT-ONE-SECTION, the count-line/ladder-prose
// defects, this file's own stated-range-header fix) all share one shape:
// something makes main() silently emit FEWER rows than the sheet actually
// has, and the run still exits 0 with a plausible-looking row count. A long-
// standing further suspicion, never yet measured against a live workbook:
// Beckett could print the PLAYER in column C rather than column B (row[1])
// for some sheet, and every row on it would silently fail the `!player`
// test in main()'s pass 1 and vanish -- zero cards from a sheet that looks,
// to a human, exactly as populated as every other one.
//
// A row is "data-looking" when it is a real multi-cell row (not a header,
// not inside a ladder, not a count line) whose own first cell reads like a
// card number -- alphanumeric, no spaces, not a bare finish/parallel word.
// This is deliberately looser than looksLikeCardNumber-style parsers
// elsewhere in the repo: it only needs to prove "Beckett put something
// row-shaped here", not decide whether it truly is one, so a false positive
// here (counting a row that in fact was not a card) only makes the guard
// MORE willing to fire, never less.
const DATA_LOOKING_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Count of "data-looking" rows on a raw (unfiltered) sheet -- the same
 *  count the CF-BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE guard in
 *  main() compares against how many of that sheet's rows actually became
 *  card records, to catch a column-shift or similar defect that would
 *  otherwise silently zero out a whole sheet while the run still exits 0.
 *  Exported so a fixture can exercise the guard directly without needing a
 *  whole malformed xlsx. */
function countDataLookingRows(rows) {
  let inLadder = false;
  let count = 0;
  for (const row of rows) {
    if (!nonEmpty(row)) continue;
    if (isCountLine(row)) continue;
    if (nonEmpty(row) === 1 && row[0]) {
      const cell = String(row[0]).trim();
      if (LADDER_HEAD.test(cell)) { inLadder = true; continue; }
      if (PLACEHOLDER.test(cell)) continue;
      if (inLadder) continue; // a rung or unnameable ladder prose, not a card
      inLadder = false;
      continue; // a section header
    }
    inLadder = false;
    const a = String(row[0] || "").trim();
    if (a && DATA_LOOKING_NUMBER.test(a)) count++;
  }
  return count;
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
// WIDENED (2026-09-20): 2026 Topps Series 2 Baseball's own Variations sheet
// prints a genuine second-header placeholder as "Versions TBA", immediately
// after the real header "Tin Exclusive" and before its own cards --
//
//     Tin Exclusive                <- the real section name Beckett DID
//     Versions TBA                     announce (a stated section)
//     352  Spencer Torkelson,...   <- the CARDS are here, under Tin Exclusive
//
// "TBA" alone already matched; a phrase whose LAST word is "TBA"/"TBD" is the
// same placeholder-word evidence with a leading noun ("Versions"), and no
// committed workbook's real header is TBA/TBD-suffixed (a real, stated rung
// name is never itself an admission that the name is unknown), so widening
// the match to end-of-string "TBA"/"TBD" carries the same guarantee the bare
// form already has.
const PLACEHOLDER = /^(tba|n\/?a|none|list tba\.?|checklist tba\.?|coming soon|.+\s(?:tba|tbd))\.?$/i;

// CF-BECKETT-AN-ODDS-LINE-IS-NEVER-A-SECTION-NAME (2026-09-20). 2025-26 Topps
// Holiday Basketball prints pack odds as their OWN single-cell row, directly
// under the section's real header and its count line, with no distinguishing
// word at all:
//
//     Frostbite Finishers          <- the real header
//     25 cards
//     1:200 packs                  <- odds, printed bare, no parens
//     FF-AB  Ace Bailey
//
//     Score Select Throwback       (repeats the shape on 10 more sections)
//     96 cards
//     1:379 packs
//     BCA-ABL  Anthony Black
//
// isCountLine only matches "<N> cards[.]"; "1:379 packs" is a DIFFERENT
// single-cell shape and fell straight through to the unconditional
// `section = cell` assignment (same as every other header line), so it
// overwrote the real header that had just been read one line above, before
// a single card row could commit it. 11 sections on this one workbook (12
// counting the split half of a repeated pair) ended up named after their own
// odds line -- categories like `auto-1379-packs`, `insert-1200-packs`,
// `insert-16-packs-advent-exclusive` -- and every one of "Frostbite
// Finishers", "Hidden Elf", "Making The Nice List", "Evergreen", "Score
// Select Throwback", "Snapshots" and the rest is gone from the checklist
// entirely, even though the workbook states the real name one line earlier
// every single time. Base's own "Base - SSP Variations" / "25 cards" /
// "1:23 packs" pair reproduces the identical shape.
//
// This is exactly the same class of evidence parseRung's `statesOdds` already
// recognizes for a NOTE trailing a ladder rung ("Green /99 (1:83)" -- see
// above) -- a "1:NNN[,NNN]" ratio is Beckett's pack-odds notation everywhere
// in this file, never a name. Extended here to a BARE single-cell line (no
// parens, because a header-fallback line never has the ladder's note
// syntax to strip first) so the section-header branch recognizes it the
// same way PLACEHOLDER and RANGE_PREVIEW_LINE already are recognized: it
// names no section, and whatever section was already open stays in force.
const ODDS_LINE = /^\s*1\s*:\s*[\d,]+(\s+\S.*)?$/i;

// CF-BECKETT-A-FOOTNOTE-SENTENCE-IS-NEVER-A-SECTION-NAME (2026-09-20).
// 2025 Topps Series 1 Baseball prints an availability/mechanics FOOTNOTE as
// its own single-cell line directly under a real header and its count line,
// exactly the same layout ODDS_LINE and PLACEHOLDER already guard against a
// line one below it stealing:
//
//     Player Number Variations Checklist
//     25 cards.
//     Hobby only.
//     Each card serial-numbered to the player's jersey number.   <- prose,
//     1   Shohei Ohtani   /17                                        not a
//                                                                     name
//     Companion Cards Checklist
//     25 cards.
//     Super box only.                                            <- prose
//     CC-1   Shohei Ohtani
//
// Both footnote lines are a full SENTENCE (title-cased words followed by a
// lower-case tail and a trailing period) -- unlike every real Beckett header
// this file already parses, which is Title Case throughout and never ends in
// a period. Read as a header anyway, the unconditional `section = cell`
// assignment overwrote "Player Number Variations Checklist" with the prose
// sentence itself, and separately made "Super box only." the PARALLEL name
// merged onto Base -- an availability note standing in for the section it
// was printed inside. Guarded the same way PLACEHOLDER/ODDS_LINE are: the
// line names no section, and whatever section was already open (the real
// header Beckett printed one or two lines earlier) stays in force.
//
// NARROW ON PURPOSE: requires a lower-case word after the leading run AND a
// trailing period, so a genuine bare Title-Case header ("Hobby Exclusive",
// "Base - Clear Variation") is untouched -- neither condition on its own
// would be safe (a real header can still end a sentence-like phrase, and
// "hobby only" / "retail only" without the period is already stripped as a
// distribution note by the ladder-line parser elsewhere in this file, never
// reaching this branch at all).
//
// LEADING SEGMENT MAY OPEN WITH A DIGIT, not only a capital letter: 2023
// Topps Series 1 Baseball's Team Logo Manufactured Patch Cards insert prints
// its own availability footnote as "1 per specially marked retail blaster
// value box." -- same sentence shape (a leading word/number run, a
// lower-case tail, a trailing period), just opening on a numeral instead of
// "Hobby"/"Super". No committed workbook's REAL header opens on a bare digit
// (a card NUMBER is a separate column, never row[0] text), so widening the
// leading character class to digits carries no risk of swallowing a genuine
// section name.
const FOOTNOTE_LINE = /^[A-Za-z0-9][A-Za-z0-9',/-]*(?:\s+[A-Za-z0-9',/-]+)*\s+[a-z][a-z0-9',/-]*(?:\s+[a-z0-9',/-]+)*\.$/;

// CF-BECKETT-A-HEDGE-PRINT-RUN-FOOTNOTE-IS-NEVER-A-SECTION-NAME (2026-09-20).
// 2023 Topps Series 1 Baseball prints a SET-WIDE maximum print run as its own
// single-cell footnote line, in the identical position FOOTNOTE_LINE already
// guards ("count line" then footnote then either "Parallels:" or the first
// card row):
//
//     2022's Greatest Hits Autographs Checklist
//     16 cards.
//     /25 or less.                      <- hedge footnote, not a name
//     22GHA-AP   Albert Pujols
//
//     All Aces Autographs Checklist
//     18 cards.
//     /25 or less.                      <- SAME footnote text, different
//     AAA-JM   Joe Musgrove                 section -- proves it is boiler-
//                                            plate, never a name of its own
//
// "/25 or less." does not match FOOTNOTE_LINE (no leading capital letter --
// it opens with a slash) but is the exact same defect: Beckett's own
// per-card autograph print run varies WITHIN the set (Beckett states no
// single number for the section as a whole, only a set-wide ceiling), so it
// prints the ceiling as a bare sentence instead of a real header. Read as a
// header anyway, "22GHA-AP" through "22GHA-AR" and "AAA-JM" through
// "AAA-AN" -- two DIFFERENT card sets -- would both file under one section
// literally named "/25 or less.", merging their distinct rosters. Guarded
// the same way: names no section, whatever was already open stays open.
const HEDGE_PRINT_RUN_FOOTNOTE = /^\/\s*\d[\d,]*\s+or\s+(?:less|fewer)\.$/i;

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
// "fractor" (not just "refractor"/"superfractor" as literals) so the same
// root covers Packfractor, which is neither -- CF-BECKETT-EXPLICIT-ANCHOR-IS-
// NOT-A-BLANK-CHEQUE below reuses this vocabulary to test a SECTION HEADER,
// not just a ladder line, and "Packfractor" failed the two-literal version.
const FINISH_WORD = /fractor|prizm|foil|shimmer|wave|atomic|mojo|parallel|logo|variation|sparkle|speckle|holo|disco|laser|pulsar|velocity|mini\s*diamond/i;

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
  // CF-BECKETT-A-TOTAL-COPY-COUNT-IS-STATED-EVIDENCE-NOT-A-PRINT-RUN
  // (2026-09-20). 2023 Topps Series 1 Baseball's "1988 Topps Baseball" and
  // "Team Logo Manufactured Patch Cards" inserts each state their Blue rung
  // as "Blue - (600 copies each)" -- a TOTAL production count for the whole
  // 100/50-card run, not a per-card serial number ("/600" would be per-card;
  // this is not that). The same ladder's OTHER four rungs on both sections
  // state ordinary per-card runs ("Black - /299", "Platinum - 1/1") and this
  // file already reads bare, unnumbered "Blue" correctly on eight OTHER
  // sections that print the identical name with no parenthetical at all
  // (parseLadderLine's BARE_LADDER_NAME fallback) -- so "Blue" is not a novel
  // name, only this one total-count phrasing was unrecognized, and it FATALs
  // main()'s droppedDeclaredParallels guard instead of silently vanishing.
  // Recognized narrowly, by the exact phrase Beckett uses here ("NNN copies
  // each" / "NNN copies"), as evidence a rung is stated -- printRun stays
  // null (a total production count is not a per-card serial and must never
  // be written as one), and the note is kept verbatim for provenance.
  const statesTotalCopies = note != null && /^\s*[\d,]+\s*copies(?:\s+each)?\s*$/i.test(String(note).trim());
  // CF-BECKETT-A-DISTRIBUTION-RESTRICTION-IS-STATED-EVIDENCE-TOO (2026-09-20).
  // 2023 Topps Series 2 Baseball's own Base Set ladder states
  // "Royal Blue - (retail only)" alongside ordinary print-run rungs
  // ("Gold Rainbow Foil - (HTA Jumbo only)" carries a run too, but is a
  // three-word name the BARE_LADDER_NAME fallback would refuse on word count
  // even if this guard let it through) -- a bare colour with NO stated print
  // run, only a channel restriction. This is the same defect class as
  // statesTotalCopies just above (a real, Beckett-printed rung whose evidence
  // is a parenthetical this file did not yet recognise, FATALing the
  // droppedDeclaredParallels guard instead of silently vanishing), not a new
  // one: "hobby only" / "retail only" are already the exact phrases this
  // file's own header comment above FINISH_WORD claims are "stripped from
  // the name and kept as a note" -- true of the STRING, never true of
  // whether they counted as EVIDENCE the line names a rung at all. Scoped to
  // the closed, already-documented distribution vocabulary (hobby/retail/HTA/
  // jumbo/blaster/box + "only"), never a general "any parenthetical counts"
  // rule -- an unstated hedge ("Aspirations /99 or fewer (See list below)")
  // must keep refusing, and LADDER_PROSE_NOT_A_NAME already covers that shape
  // separately. printRun stays null: an availability restriction states no
  // serial number, and none is invented.
  // CF-AN-UNSTATED-HEDGE-STAYS-REFUSED-EVEN-WITH-A-DISTRIBUTION-NOTE
  // (2026-09-20, review fix). Found in review: 2023 Topps Series 1
  // Baseball's own "1988 Topps Baseball Autographs" ladder states
  // "Red - /25 or less (hobby only)" -- the SAME hedge shape as the
  // "Aspirations /99 or fewer (See list below)" line this comment already
  // says must keep refusing, just with a distribution note instead of a
  // "See list below" pointer trailing it. `s` (the name after the trailing
  // parenthetical is stripped) still reads "Red - /25 or less" here --
  // `numbered` never matched it (the "or less" tail sits after the /NNN, so
  // the END-OF-STRING anchor in `numbered`'s own regex never reaches it) --
  // and statesDistributionOnly alone was wrongly admitting it as a real rung
  // named "Red - /25 or less", carrying the hedge text straight into the
  // parallel column. A stated print run or a named finish are never hedged
  // this way (an exact "/50" or "Foil" is not "50 or less" / "maybe Foil"),
  // so this check is scoped to statesDistributionOnly/statesTotalCopies
  // only -- the two evidence classes added in this same review round, both
  // narrow enough that a hedge sitting in `s` was never possible to notice
  // before either existed.
  const hedgedName = /\bor\s+(?:less|fewer)\b/i.test(s);
  const statesDistributionOnly = !hedgedName && note != null &&
    /^\s*(?:hobby|retail|hta|jumbo|blaster|box|pack)(?:\s+(?:hobby|retail|hta|jumbo|blaster|box|pack))*\s+(?:packs?|boxes?|only)(?:\s+only)?\s*$/i.test(String(note).trim());
  // Evidence, not vocabulary. A stated print run, stated pack odds, a stated
  // total copy count, a stated distribution restriction, or a named finish
  // each make this a rung; a line carrying none of the five is prose.
  const statesOdds = note != null && /^\s*1\s*:\s*[\d,]+/.test(String(note).trim());
  const statesTotalCopiesUnhedged = statesTotalCopies && !hedgedName;
  if (printRun == null && !statesOdds && !statesTotalCopiesUnhedged && !statesDistributionOnly && !FINISH_WORD.test(s)) return null;
  return { name: s, printRun: printRun, note: note };
}

// CF-BECKETT-AN-UNNUMBERED-PARALLEL-IS-STILL-A-PARALLEL (2026-09-20). 2024
// Panini Phoenix Football's Base sheet declares its "Parallels:" ladder as:
//
//     Parallels:
//     Hyper
//     Ice
//     International
//     Lazer
//     Orange
//     Orange Fade
//     Orange Hyper
//     Orange Lazer
//     Pandora
//     Purple
//     Purple Fade
//     Purple Hyper
//     Purple Lazer
//     Silver
//     Wave                      <- matches FINISH_WORD ("wave"), survives
//     White Shimmer             <- matches FINISH_WORD ("shimmer"), survives
//     Phoenix - /399            <- states a print run, survives
//     ...
//     1  Kyler Murray
//
// The sixteen unnumbered names above Phoenix's first print-run rung carry no
// print run (Beckett states none for these), no pack odds, and none of them
// happens to contain a word from FINISH_WORD's closed twelve-root vocabulary
// -- "Lazer" is Panini's own spelling and does not match "laser" either. Every
// one of them fell through to parseRung's vocabulary test, was refused, and
// (per CF-BECKETT-PROSE-INSIDE-A-LADDER-IS-NOT-A-SECTION above) silently
// disappeared: not a rung, not a section, just gone. The identical shape is
// already on a currently-committed, "clean" workbook: 2026 Donruss Elite's
// own base ladder declares "Orange", "Mixorama" and "Razzle Dazzle" the same
// way, and all three are dropped today by the same defect
// (beckettReadsEverySectionClass.test.ts's own ladder assertions never
// checked for them, so the loss went unmeasured).
//
// FIX IS EVIDENCE FROM CONTEXT, NOT A WIDER VOCABULARY. Extending FINISH_WORD
// with "hyper", "ice", "orange", "purple", "silver", "pandora", "lazer",
// "mixorama", "razzle dazzle", ... is exactly the whitelist-style fix the
// PLAIN_SECTION/CANONICAL_CATEGORY_SLUG history in this file warns against --
// the next workbook invents a seventeenth bare colour name and the same loss
// recurs. What actually distinguishes these sixteen names from real prose
// ("Aspirations /99 or fewer (See list below)", "*Odds as provided by Topps",
// "Printing Plates 1/1 (Each card has Cyan, Magenta, Yellow, and Black
// versions)") is SHAPE, not spelling: every one of the sixteen is a bare,
// short, Title-Case phrase -- one to three words, no digits, no slash, no
// leading asterisk, no parenthetical note -- while every refused prose line
// in the corpus is either marked with a footnote asterisk, states an
// unparseable fractional hedge ("/99 or fewer"), or carries an explanatory
// parenthetical. A bare short Title-Case line INSIDE an already-open ladder
// (the "Parallels:" marker has fired -- see the call site below) has no
// other candidate meaning: it is not a card row (single populated cell), not
// a footnote, not a count line, not prose describing something else -- it is
// Beckett naming one more rung of the ladder it just opened.
//
// SCOPED TO THE LADDER-READING CALL SITE ONLY, never merged into parseRung
// itself: parseRung is also called directly, context-free, by
// beckettReadsEverySectionClass.test.ts's own "still refuses prose" pins,
// which require parseRung("Base Set") and parseRung("Parallels") to stay
// null regardless of context -- both are bare, short, Title-Case phrases
// that would otherwise match this same shape. Only the row-reading loop
// knows it is inside a confirmed ladder, so only that call site may use this
// fallback; parseRung's own contract (called with no surrounding context) is
// unchanged.
//
// WIDENING TO 5 WORDS WAS TRIED AND REJECTED (2026-09-20, review round).
// 2024 Panini Mosaic Football's own base ladder declares the genuine
// four-word rung "No Huddle Silver Mosaic" the same bare way as Phoenix's
// sixteen names, and the 3-word cap here drops it too -- but a blind
// "raise the cap to 5" widen, measured against all 6 workbooks this PR's own
// regression table lists as changed, ALSO admitted two names this file has
// already, correctly, refused and reported: Select's "Black and Blue Shock"
// (+ 8 more "<Colour> and <Colour> Shock" siblings, 2,700 rows) and
// Illusions' "Yellow Diamond Trophy Collection" (100 rows) -- both already
// sitting in droppedDeclaredParallels on this same run, both explicitly
// named in this PR's own body as the harder, deliberately-unfixed shape.
// Every one of these three names is a bare, short, Title-Case line inside an
// open ladder whose OTHER rungs of the identical trailing shape DO carry a
// stated print run ("No Huddle Blue Mosaic - /75" / "Blue and Orange Shock
// /35" / "Black Ice Trophy Collection - 1/1") -- there is no shape-only
// rule, word-count or otherwise, that admits the Mosaic name while excluding
// the other two; they are indistinguishable by shape alone. Per doctrine
// (a wider name whitelist recurs every workbook; shape must do the work),
// the cap STAYS AT 3 WORDS. "No Huddle Silver Mosaic" is left to
// droppedDeclaredParallels, exactly like the two Shock/Trophy-Collection
// names it cannot be told apart from -- reported, not minted, for a human
// to resolve. See the PR report for the per-workbook verification.
const BARE_LADDER_NAME = /^[A-Za-z][A-Za-z'.]*(?:[\s-][A-Za-z][A-Za-z'.]*){0,2}$/;

/** parseRung, widened with the bare-name fallback above -- but ONLY for a
 *  line already known to sit inside an open ladder block. Never call this
 *  outside that context (see BARE_LADDER_NAME's header comment for why
 *  parseRung itself must stay narrow). */
function parseLadderLine(line) {
  const rung = parseRung(line);
  if (rung) return rung;
  const raw = String(line || "").trim();
  if (!raw || raw.length < 3) return null;
  if (!BARE_LADDER_NAME.test(raw)) return null;
  return { name: raw, printRun: null, note: null };
}

// CF-A-DECLARED-PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING (2026-09-20).
// parseLadderLine (above) reads nearly every genuinely-named rung, but a
// ladder line can still be refused -- a footnote asterisk, or an unstated,
// hedge-worded print run ("Aspirations /99 or fewer (See list below)") --
// and that refusal is BY DESIGN (see CF-BECKETT-PROSE-INSIDE-A-LADDER-IS-
// NOT-A-SECTION at the call site: neither is a real parallel name at all).
// This regex is how main()'s own guard tells the two apart: a footnote or a
// hedge phrase is recognizably prose ABOUT the ladder, never a name IN it,
// so a refused line matching it is not reported as a dropped declared
// parallel. A refused line that does NOT match it (some future workbook's
// line shape neither parseLadderLine nor this file's authors have seen yet)
// IS reported -- absent beats silently wrong, and a human sees it in the
// manifest instead of the loss disappearing the way Phoenix's sixteen names
// did before this file had any guard at all.
const LADDER_PROSE_NOT_A_NAME = /^[*]|\bor (fewer|less)\b|\(see /i;

function main() {
  const files = readZip(fs.readFileSync(path.resolve(XLSX)));
  const sheets = sheetsByName(files);
  // Master, when present, is the authority on a card set's real name (see
  // CF-BECKETT-CHECKLIST-IS-A-TITLE-ARTIFACT-NOT-A-NAME above); an empty Set
  // when absent, so every call site below degrades to the sibling-suffix
  // signal alone rather than branching on "is there a Master sheet".
  const masterNames = masterCardSetNames(sheets);

  // ---- pass 1: read every row, remembering which section it came from -----
  const records = [];
  const sections = new Map();   // "sheet>section" -> section descriptor
  // CF-BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE-NOT-A-QUIET-SUCCESS
  // (2026-09-19). sheet name -> { dataLooking, emitted }, checked once pass 1
  // finishes (see the guard after this loop, and countDataLookingRows above
  // for what "data-looking" means).
  const sheetEmitCounts = new Map();
  // CF-A-DISCARDED-RANGE-HEADER-IS-A-FINDING-NOT-A-SILENCE (2026-09-20,
  // review fix). CF-BECKETT-A-STATED-RANGE-HEADER-MUST-MATCH-ITS-OWN-CARDS
  // discards a header the moment the next card's number falls outside its
  // own stated range (or is not a plain integer at all -- a prefixed number
  // like "BCP-101", or a range Beckett itself mis-typed). That is the
  // correct DEFAULT -- Illusions's own "First Impressions Autographed
  // Memorabilia - #101-142" case needs exactly this to file its 100 base
  // cards correctly -- but a silent discard is still a fact a human should
  // see: it could equally be Beckett's own typo in the range, or a prefixed
  // numbering scheme this file's Number() test cannot parse at all, either
  // of which means the header's real cards never got their own section.
  // Collected here, one entry per discard, and written into the manifest's
  // sectionsReport (see main()'s own manifest-writing code) so an operator
  // reviewing the acquisition sees it instead of a clean-looking run.
  const discardedRangeHeaders = [];
  for (const [name, rows] of Object.entries(sheets)) {
    if (isSupersetSheet(name)) continue;
    sheetEmitCounts.set(name, { dataLooking: countDataLookingRows(rows), emitted: 0 });
    let section = name;
    // Every OTHER header on this sheet, computed once, so
    // stripChecklistSuffix can ask "do this sheet's siblings carry the same
    // suffix" without re-scanning the sheet per section.
    const siblingSectionNames = sheetSectionHeaderNames(rows);
    // Range-preview lines ("Rookies - #101-200" printed back-to-back with
    // "Rookie Patch Autographs - #201-242", announcing sections that appear
    // later on the same sheet) -- computed once, same shape as
    // siblingSectionNames, so it never disagrees with what this loop treats
    // as a header row (see CF-BECKETT-A-RANGE-LABEL-LINE-IS-A-TABLE-OF-
    // CONTENTS-NOT-A-HEADER above rangePreviewLineIndices).
    const rangePreviewIdx = rangePreviewLineIndices(rows);
    // The ladder belongs to the section it sits under, and resets with it.
    let inLadder = false;
    let pendingLadder = [];
    // CF-A-DECLARED-PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING
    // (2026-09-20). Every line inside the current ladder block that LOOKS
    // like a declared parallel name -- accepted by parseLadderLine, or
    // refused but not recognizably prose (LADDER_PROSE_NOT_A_NAME) -- is
    // recorded here, resetting at exactly the same points as pendingLadder
    // (same section, same ladder lifecycle) so the guard after pass 1 can
    // compare "every name this block declared" against "what this section
    // actually emitted" per section. Kept separate from pendingLadder
    // itself (which stays exactly what it was -- the rungs pass 3 emits)
    // so this guard is purely additive and cannot change a single emitted
    // row.
    let pendingDeclaredNames = [];
    // CF-BECKETT-A-STATED-RANGE-HEADER-MUST-MATCH-ITS-OWN-CARDS (2026-09-19).
    // 2024 Panini Illusions Football's Base sheet lists TWO section headers
    // back-to-back -- "Base Set", then (with no card row between them)
    // "First Impressions Autographed Memorabilia - #101-142" and its own
    // eleven-rung "Parallels:" block -- before card #1 ever appears:
    //
    //     Base Set
    //     136 cards.
    //     First Impressions Autographed Memorabilia - #101-142   <- premature
    //     Parallels:                 <- this ladder is BASE SET's own Trophy
    //     Dots Trophy Collection         Collection ladder, not the auto
    //     ... (19 rungs) ...             section's -- it sits where it does
    //     1   Kyler Murray                only because Beckett announced the
    //     ...                             next section's NAME early.
    //     100 J.J. McCarthy
    //     First Impressions Autographed Memorabilia   <- the SAME section,
    //     Parallels:                                     named again, for real
    //     Bronze - /299 (...)                            this time
    //     ...
    //     101 Michael Penix Jr.        <- NOW the autographed run's own cards
    //
    // The unconditional `section = cell` assignment overwrote "Base Set" the
    // moment the second header was read, so the 100 plain base cards that
    // followed were filed under the autograph section instead -- isAuto=true
    // on 100 unsigned cards, the exact defect class this whole file exists to
    // catch, just found in the header tracker rather than in categoryFor.
    //
    // THE FIX IS NARROW AND EVIDENCE-BASED, NOT "a header only counts once
    // the current one has cards" -- that general rule was tried first and
    // broke five committed, already-measured-clean workbooks. 2026 Topps
    // Series 1 Baseball's Variations sheet has the IDENTICAL shape --
    // "Base - Clear Variation" / "100 cards" / "Hobby Exclusive" / [cards
    // 1-100] -- where the SECOND header, not the first, is the one whose
    // cards these are (Hobby Exclusive is a genuine same-roster parallel of
    // Base Set); a general "prefer the earlier still-open header" rule gets
    // Illusions right and Series 1 wrong using the exact same row shape, so
    // shape alone cannot decide this. The one piece of evidence Beckett
    // actually prints that DOES decide it: "First Impressions Autographed
    // Memorabilia - #101-142" states its own numbering range in its own
    // text, and the cards that immediately follow (#1-100) fall OUTSIDE that
    // stated range -- proof this header does not own them, whatever section
    // is genuinely open when it's announced. "Hobby Exclusive" and "Base -
    // Clear Variation" state no range at all and are untouched by this
    // check.
    //
    // A header matching RANGE_PREVIEW_LINE (already defined above for the
    // adjacent-pair case) is held PENDING rather than committed immediately.
    // The next actual card row decides it: if the card's own number falls
    // inside the header's stated range, the header commits (this is why the
    // SECOND "First Impressions Autographed Memorabilia" -- Illusions row
    // 134, this time with no range suffix at all -- is unaffected: it isn't
    // range-shaped, so it commits immediately as it always did). If the
    // number falls OUTSIDE the stated range, the header is a premature
    // announcement: it is discarded, the section already open (and its
    // ladder) stays in force, and the card row is read against THAT section
    // instead -- exactly `section`'s pre-existing value, never overwritten.
    let pendingRangeHeader = null; // { name, lo, hi } | null
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!nonEmpty(row)) continue;
      if (isCountLine(row)) continue;
      // A single populated cell is a section header, the "Parallels:" marker,
      // or a rung of the ladder that marker opened. Treating all three as
      // section headers is what turned 97 rungs into 97 sections.
      if (nonEmpty(row) === 1 && row[0]) {
        const cell = String(row[0]).trim();
        if (LADDER_HEAD.test(cell)) { inLadder = true; pendingLadder = []; pendingDeclaredNames = []; continue; }
        // A placeholder never names a section, in or out of a ladder.
        if (PLACEHOLDER.test(cell)) continue;
        // A table-of-contents preview line names no section -- whatever
        // section was already open (or not yet opened) stays in force.
        if (rangePreviewIdx.has(rowIndex)) continue;
        // CF-BECKETT-AN-ODDS-LINE-IS-NEVER-A-SECTION-NAME (see its own
        // header comment above ODDS_LINE's definition): a bare "1:NNN
        // packs" line never names a section either, in or out of a ladder
        // -- whatever section was already open (the real header Beckett
        // printed one line earlier) stays in force, the same treatment
        // PLACEHOLDER and the range-preview line already get.
        if (ODDS_LINE.test(cell)) continue;
        // CF-BECKETT-A-FOOTNOTE-SENTENCE-IS-NEVER-A-SECTION-NAME (see its own
        // header comment above FOOTNOTE_LINE's definition): an availability/
        // mechanics footnote sentence never names a section either -- same
        // treatment as PLACEHOLDER, ODDS_LINE and the range-preview line.
        // Checked OUTSIDE inLadder too, mirroring ODDS_LINE just above: a
        // footnote sitting between a ladder's rungs and the ladder's own
        // ending odds-note is not evidenced on any committed workbook, so
        // this stays scoped to the header branch exactly like ODDS_LINE is.
        if (!inLadder && FOOTNOTE_LINE.test(cell)) continue;
        // CF-BECKETT-A-HEDGE-PRINT-RUN-FOOTNOTE-IS-NEVER-A-SECTION-NAME (see
        // its own header comment above HEDGE_PRINT_RUN_FOOTNOTE's
        // definition): a set-wide print-run ceiling stated as a bare "/NNN
        // or less." sentence never names a section either -- same treatment
        // as FOOTNOTE_LINE just above.
        if (!inLadder && HEDGE_PRINT_RUN_FOOTNOTE.test(cell)) continue;
        if (inLadder) {
          // CF-BECKETT-AN-UNNUMBERED-PARALLEL-IS-STILL-A-PARALLEL: widened to
          // parseLadderLine (see its own header above) so a bare, short,
          // Title-Case rung name with no stated print run -- "Hyper", "Ice",
          // "Orange" -- is read as a rung here, where it is known to sit
          // inside an already-open "Parallels:" block. parseRung itself
          // stays narrow; only this call site has that context.
          const rung = parseLadderLine(cell);
          if (rung) {
            pendingLadder.push(rung);
            pendingDeclaredNames.push(rung.name);
            continue;
          }
          // A refused line that is not recognizably prose (no footnote
          // asterisk, no hedge phrase, no bare odds statement) is still a
          // NAME as far as this guard is concerned -- see CF-A-DECLARED-
          // PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING above. Recorded
          // here, not emitted as a rung: this cannot change pass 3's
          // output, only what the guard compares against. ODDS_LINE is
          // excluded too (CF-BECKETT-AN-ODDS-LINE-IS-NEVER-A-SECTION-NAME,
          // defined below the header branch this same test is mirrored
          // from) -- this file has no evidence a "Parallels:" block ever
          // contains a bare odds line mid-ladder, but a future workbook
          // proving otherwise must not false-positive this guard over it.
          const trimmedCell = String(cell || "").trim();
          if (!LADDER_PROSE_NOT_A_NAME.test(trimmedCell) && !ODDS_LINE.test(trimmedCell)) {
            pendingDeclaredNames.push(trimmedCell);
          }
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
        const rangeMatch = /^(.*\S)\s*[–—-]\s*#\s*(\d+)\s*-\s*(\d+)\s*$/.exec(cell);
        if (rangeMatch) {
          // Held pending, not committed -- see CF-BECKETT-A-STATED-RANGE-
          // HEADER-MUST-MATCH-ITS-OWN-CARDS above. `section`, `pendingLadder`
          // and `inLadder` are all left exactly as they are; only the NEXT
          // card row's own number decides whether this header was real.
          pendingRangeHeader = {
            header: cell, sheetRowIndex: rowIndex,
            name: stripChecklistSuffix(rangeMatch[1].trim(), siblingSectionNames, masterNames),
            lo: Number(rangeMatch[2]), hi: Number(rangeMatch[3]),
          };
          continue;
        }
        section = stripChecklistSuffix(cell, siblingSectionNames, masterNames);
        inLadder = false;
        pendingLadder = [];
        pendingDeclaredNames = [];
        pendingRangeHeader = null;
        continue;
      }
      // A card row closes the ladder: everything after it belongs to the cards.
      inLadder = false;
      const cardNumber = String(row[0] || "").trim();
      let player = String(row[1] || "").replace(/,\s*$/, "").trim();
      if (!cardNumber || !player) continue;
      // Counted here, before the pendingRangeHeader/League-Leaders-merge
      // logic below -- this is "did the sheet yield a real card row at
      // all", not a dedup-accurate final count, which is exactly what CF-
      // BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE needs to compare
      // against countDataLookingRows.
      sheetEmitCounts.get(name).emitted++;
      if (pendingRangeHeader) {
        // A card number is not always purely numeric (Illusions itself mixes
        // in alpha-prefixed rows elsewhere), so only a row that parses as a
        // plain integer can be tested against the stated range at all; a
        // non-numeric number is neither confirming nor refuting evidence and
        // is treated the same as a mismatch -- absent beats wrong.
        const n = Number(cardNumber);
        const inRange = Number.isFinite(n) && n >= pendingRangeHeader.lo && n <= pendingRangeHeader.hi;
        if (inRange) {
          section = pendingRangeHeader.name;
          pendingLadder = [];
          pendingDeclaredNames = [];
        } else {
          // A discard is a finding, not a silence -- see
          // CF-A-DISCARDED-RANGE-HEADER-IS-A-FINDING-NOT-A-SILENCE above.
          discardedRangeHeaders.push({
            sheet: name, row: pendingRangeHeader.sheetRowIndex, header: pendingRangeHeader.header,
            nextCardNumber: cardNumber,
          });
        }
        // Whether confirmed or refused, the pending header is resolved --
        // either it committed above, or it is discarded and `section` (and
        // whatever ladder was already accumulating under it) stays exactly
        // as it was before this header line was ever read.
        pendingRangeHeader = null;
      }
      // An RC flag sits in a later column; the repo's CSV convention folds it
      // into the player field ("Jacob Wilson RC").
      if (row.slice(2).some((c) => /^RC$/i.test(String(c || "").trim()))) player += " RC";

      let key = name + ">" + section;
      // CF-BECKETT-A-REPEATED-HEADER-WITH-A-DISAGREEING-ROSTER-IS-A-SECOND-
      // SECTION (2026-09-19). Beckett sometimes prints the SAME bare header
      // text twice on one sheet for two genuinely different card groups --
      // 2024 Panini Select Football's Inserts sheet lists "Score Select
      // Throwback" (and separately "Snapshots") ONCE for a veterans roster
      // (#1 Jalen Hurts) and AGAIN, unchanged, for a rookies roster (#1 Caleb
      // Williams) -- no suffix, no distinguishing word, genuinely the exact
      // same section name repeated. The unconditional `key = name + ">" +
      // section` lookup found the SAME section both times and merged 50 rows
      // (25 + 25, two disjoint rosters) into one 94-distinct-number pool,
      // producing exactly the "two different cards forced onto one id" id-
      // collision id-collisions(...) exists to refuse -- 832 collision
      // groups across three such pairs on this one file, none of them a
      // fold candidate or a genuine source duplicate.
      //
      // THE DISCRIMINATOR IS THE ROSTER, same doctrine as every other fold
      // decision in this file: a card row whose NUMBER already exists in
      // this section's roster, naming a DIFFERENT player, is not this
      // section's own card restated -- it is the second listing's first
      // card, and belongs to a split section carrying the identical name
      // (so its category/rung derivation is unaffected) but its own
      // numbers/roster. Splits are named `key + "#2"`, `"#3"`, ... so a
      // THIRD repeat (not measured on any workbook yet, but the mechanism
      // must not silently merge into whichever split happened to exist) is
      // still caught rather than merged into split #2 by accident.
      //
      // A number NOT yet seen in this section, or seen with the SAME
      // player, is unaffected -- this never fires for the ordinary case
      // (first mention of a number). It must ALSO never fire for a
      // League-Leaders multi-player row (Pete Alonso / Kyle Schwarber /
      // Juan Soto, all card #11, consecutive rows meant to MERGE into one
      // card, not split into two sections) -- that shape is INDISTINGUISHABLE
      // from a genuine disagreeing repeat by roster content alone (both are
      // "same number, different player"); the one fact that tells them apart
      // is ADJACENCY, the exact test the merge below already uses. So this
      // check is skipped whenever the incoming row is adjacent to the prior
      // record in this pre-split section -- that row is the merge's own
      // candidate, decided by the merge logic below, never by this one.
      if (sections.has(key)) {
        const existing = sections.get(key);
        const priorForSplitCheck = existing.lastRecordIndex >= 0 ? records[existing.lastRecordIndex] : null;
        const isMergeCandidate = priorForSplitCheck && priorForSplitCheck.sectionKey === key &&
          String(priorForSplitCheck.cardNumber).toUpperCase() === cardNumber.toUpperCase();
        if (!isMergeCandidate) {
          const existingPlayers = existing.roster.get(cardNumber.toUpperCase());
          if (existingPlayers && existingPlayers.size &&
              !existingPlayers.has(normalizeRosterPlayer(player))) {
            let n = 2;
            while (sections.has(key + "#" + n) &&
                   sections.get(key + "#" + n).roster.get(cardNumber.toUpperCase()) &&
                   !sections.get(key + "#" + n).roster.get(cardNumber.toUpperCase()).has(normalizeRosterPlayer(player))) {
              n++;
            }
            key = key + "#" + n;
          }
        }
      }
      if (!sections.has(key)) {
        // A split section (key ends "#N") carries the SAME section name --
        // Beckett never named the two listings differently -- so its
        // category must be distinguishable too, or pass 3 would re-collide
        // the two groups the split above exists to separate. Suffixed
        // "-2"/"-3"/... on the category, same numbering as the key, flagged
        // in the manifest (sectionsReport carries the section's own `key`)
        // so a human can give it its real name once one is known -- absent
        // beats wrong, and a numbered placeholder is at least never silently
        // wrong about WHICH card it is.
        const splitMatch = /#(\d+)$/.exec(key);
        const baseCategory = categoryFor(name, section);
        const category = splitMatch ? baseCategory + "-" + splitMatch[1] : baseCategory;
        sections.set(key, {
          sheet: name, section: section, key: key,
          category: category,
          numbers: new Set(), cards: 0,
          // (cardNumber -> Set of normalizeRosterPlayer(player)), for
          // classifySections's roster-based fold below. Built from the SAME
          // player string every other pass reads (post-RC-append), so the
          // roster a section states here never disagrees with what pass 3
          // emits.
          roster: new Map(),
          // Whatever "Parallels:" block preceded this section's first card.
          ladder: pendingLadder,
          // Every name that block declared, accepted or refused-but-not-
          // prose -- see CF-A-DECLARED-PARALLEL-THAT-NEVER-BECOMES-A-ROW-
          // IS-A-FINDING above. A snapshot (never the live array) so a
          // later ladder on a DIFFERENT section can never retroactively
          // change what this one declared.
          declaredParallels: pendingDeclaredNames.slice(),
          lastRecordIndex: -1,
        });
      }
      const sec = sections.get(key);
      // CF-BECKETT-A-LEAGUE-LEADERS-CARD-IS-ONE-ROW (2026-09-19). Beckett
      // lists a multi-player card (League Leaders, a dual/triple/quad-player
      // insert) as SEVERAL CONSECUTIVE ROWS under the SAME card number, one
      // per player -- ['11', 'Pete Alonso'], ['11', 'Kyle Schwarber'], ['11',
      // 'Juan Soto'] -- never one row with the roster already joined. Reading
      // each as its own card minted the SAME id three times
      // (hiq:baseball:2026:topps:11:base:no-auto) for three different real
      // people, which `lib/insert-set-key.cjs`'s id-collision guard correctly
      // refuses the whole file over -- measured on 2026 Topps Series 1
      // Baseball: 10 numbers (11, 38, 84, 117, 130, 151, 203, 204, 211, 327),
      // 3 players each, 60 raw rows fighting for 20 addresses.
      //
      // The repo's own convention for a multi-player card is ALREADY a single
      // row with players joined "/" in source order (measured on committed
      // CSVs: `base,152,,false,,Alan Benes/Andy Benes` in
      // 1996-sp-baseball.csv; `insert-league-leaders,1,,false,,Mike
      // Bossy/Marcel Dionne/Guy Lafleur` in 1979-80-o-pee-chee-hockey.csv) --
      // this reproduces that shape rather than inventing a new one.
      //
      // MERGE ONLY WHEN NOTHING ELSE COULD DISAGREE. At this point in pass 1
      // the only card-level fields read yet are cardNumber and player --
      // parallel/isAuto/printRun are decided later in pass 2/3 from the
      // SECTION, not the row, so two rows in one section with the same
      // number are by construction already identical on every field this
      // pass could disagree on. The merge is keyed on (section, cardNumber)
      // and requires the PRIOR row read in this exact section to be the
      // immediately preceding record -- Beckett's own layout groups a
      // multi-player card's rows consecutively, and requiring adjacency
      // (not just "same section, same number, anywhere") is deliberately
      // conservative: two truly separate mentions of the same number
      // elsewhere in a section (a genuine checklist error, R30's own
      // same-numbered-different-card shape) must NOT silently merge, and
      // stay a collision for the guard to refuse exactly as before. The repo
      // has no team column in the checklist-csv-contract (`docs/reference/
      // checklist-csv-contract.md` lists category/cardNumber/parallel/
      // isAuto/printRun/player[, parallelNote, rarity], nothing else), so
      // Beckett's own team cell (row[2]) is read but never joined or
      // emitted here -- there is no column for it to join into.
      const num = cardNumber.toUpperCase();
      const priorIdx = sec.lastRecordIndex;
      const prior = priorIdx >= 0 ? records[priorIdx] : null;
      if (prior && prior.sectionKey === key && String(prior.cardNumber).toUpperCase() === num) {
        prior.player = prior.player + "/" + player;
        // The roster a card states is now the JOINED name, matching what
        // pass 3 will actually emit -- classifySections's roster fold must
        // compare against the same string the CSV carries, never the
        // pre-merge single name.
        sec.roster.get(num).clear();
        sec.roster.get(num).add(normalizeRosterPlayer(prior.player));
        continue;
      }
      sec.numbers.add(num);
      sec.cards++;
      if (!sec.roster.has(num)) sec.roster.set(num, new Set());
      sec.roster.get(num).add(normalizeRosterPlayer(player));
      records.push({ sectionKey: key, cardNumber: cardNumber, player: player });
      sec.lastRecordIndex = records.length - 1;
    }
  }

  // CF-BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE-NOT-A-QUIET-SUCCESS
  // (2026-09-19). A sheet with plenty of data-looking rows that nonetheless
  // emitted zero (or fewer than half) of them as real card rows is not a
  // clean, sparse sheet -- it is the shape a column-shift defect (the long-
  // standing "player printed in column C" suspicion, never yet measured
  // against a live workbook, but the same failure class as the count-line
  // and ladder-prose defects this file already fixed) would produce: every
  // row silently fails `!player` and vanishes while the run still exits 0
  // with a plausible-looking total row count. FAIL LOUDLY here instead of
  // letting that possibility hide behind a smaller, still-plausible number.
  // The threshold (>=10 data-looking rows, <50% emitted) is deliberately
  // generous -- a genuinely thin, correctly-read sheet (five-card insert,
  // a handful of case hits) must never trip this, only a sheet that looks
  // substantial and came back empty or nearly so.
  const emptySheets = [];
  for (const [name, counts] of sheetEmitCounts) {
    if (counts.dataLooking >= 10 && counts.emitted < counts.dataLooking * 0.5) {
      emptySheets.push({ sheet: name, dataLooking: counts.dataLooking, emitted: counts.emitted });
    }
  }
  if (emptySheets.length) {
    for (const s of emptySheets) {
      console.error(
        `FATAL: sheet "${s.sheet}" looks like it has ${s.dataLooking} card rows but only ` +
        `${s.emitted} were read as cards (player column empty, or some other column-shape ` +
        `mismatch). Refusing to emit a plausible-looking row count from a sheet this ` +
        `under-read -- see CF-BECKETT-A-SHEET-THAT-EMITS-NOTHING-IS-A-FAILURE-NOT-A-QUIET-` +
        `SUCCESS in convertBeckettChecklistXlsx.cjs.`);
    }
    process.exitCode = 3;
    return { emptySheets };
  }

  // ---- pass 2: which sections are parallels of which anchors? -------------
  const report = classifySections(sections);

  // A ladder rung's note saying it does not cover the whole section ("select
  // cards only", "select cards, see below", "select cards, list below" --
  // the "Purple - /150 (select cards only, list below)" and "Clear - /10
  // (select cards, see below; hobby only)" shapes -- see
  // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE at the emission
  // site below) is evidence from the note itself, the same class parseRung's
  // own statesOdds already reads from a trailing parenthetical -- never a
  // name guess.
  //
  // WIDENED (2026-09-20, review fix): the original pattern demanded the
  // literal phrase "select cards only" immediately adjacent. 2023 Topps
  // Series 1/2 Baseball's own "select cards, see below; hobby only" has
  // "hobby only" as a SEPARATE, later clause (a distribution note, covered
  // by "hobby only"/"retail only" ALONE never being read as a roster
  // restriction -- see the DISTRIBUTION_ONLY_NOTE guard below, which is the
  // deliberate non-match this pattern must not absorb). What actually marks a
  // roster restriction, on every workbook seen so far, is "select cards"
  // followed somewhere in the SAME parenthetical by a pointer to a list
  // ("only", "see below", "list below", "below") -- never "select cards"
  // alone with no pointer, which would be an unfalsifiable claim this file
  // has no evidence for.
  const SELECT_CARDS_ONLY_NOTE = /select\s+cards?\b(?:(?!\)).)*?\b(?:only|(?:see|list)\s+below|below)\b/i;
  // A distribution restriction ALONE ("hobby only", "retail only", "HTA
  // Jumbo only" -- see the parseRung evidence class of the same name added
  // earlier in this same review round) is never a roster restriction: every
  // card in the section still carries the rung, just sold only through that
  // channel. Checked so a note that happens to end "... hobby only" but
  // never said "select cards" is not misread by an even wider version of the
  // pattern above -- SELECT_CARDS_ONLY_NOTE already requires the literal
  // "select cards" token, so this is documentation of the boundary, not code
  // that changes behaviour on its own.
  const DISTRIBUTION_ONLY_NOTE = /^\s*(?:hobby|retail|hta|jumbo|blaster|box|pack)(?:\s+(?:hobby|retail|hta|jumbo|blaster|box|pack))*\s+(?:packs?|boxes?|only)(?:\s+only)?\s*$/i;
  // Precomputed once, not per (record, rung): for each section, which of its
  // OWN ladder rung names is satisfied by a sibling section that genuinely
  // folds onto it under that exact rung name (rungName, the same reduction
  // classifySections itself used to name the fold) -- i.e. a real,
  // roster-verified, separately-printed card list already accounts for that
  // name, so the mechanical full-roster ladder stamp for it would be either
  // redundant or, worse, synthetic for the numbers the real list excludes.
  const satisfiedLadderRungNames = new Map();
  for (const sec of sections.values()) {
    const names = new Set();
    for (const other of sections.values()) {
      if (other !== sec && other.parallelOf === sec) {
        const name = rungName(other.section, sec.section);
        if (name) names.add(name);
      }
    }
    satisfiedLadderRungNames.set(sec, names);
  }

  // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE, Master-sheet
  // half (2026-09-20, review fix). A rung whose note matches
  // SELECT_CARDS_ONLY_NOTE and is NOT already satisfied by a sibling fold
  // (satisfiedLadderRungNames, computed above) is looked up in Master by its
  // OWN name (masterRosterFor) before falling through to "no list found".
  // Found -> the roster IS the restricted list: emitted ONLY for the numbers
  // Master states, and ONLY when the player at that number agrees with this
  // run's own anchor roster (never trusted blind -- Master and the anchor
  // must name the SAME person at a shared number, or the row is dropped as
  // an unresolved disagreement rather than guessed either way). Not found in
  // Master either -> nothing is emitted and the rung is recorded verbatim in
  // `restrictedRungsWithoutAList`, per section, so main()'s own
  // droppedDeclaredParallels guard can treat it as declared-and-deliberately-
  // held rather than a silent, unexplained drop (see that guard's own call
  // site: `restrictedRungsWithoutAList` supplies the "this name is accounted
  // for" signal the guard's dropped-name diff already reads).
  const restrictedRungsWithoutAList = [];
  const masterRosterByRungName = new Map(); // name.toLowerCase() -> roster Map | null (looked up once)
  function masterRosterForRung(name) {
    const key = String(name || "").toLowerCase();
    if (!masterRosterByRungName.has(key)) masterRosterByRungName.set(key, masterRosterFor(sheets, name));
    return masterRosterByRungName.get(key);
  }

  // ---- pass 3: emit ------------------------------------------------------
  const out = [];
  // Disagreements between a dedicated section's own stated print run and its
  // fold anchor's ladder rung of the same name -- see CF-A-FOLDED-RUNG-
  // CARRIES-THE-SOURCE-STATED-PRINT-RUN below. A real finding, recorded in
  // the manifest, never silently resolved either way.
  const printRunConflicts = [];
  for (const rec of records) {
    const sec = sections.get(rec.sectionKey);
    // CF-BECKETT-ROSTER-FOLD-FOR-NAMELESS-SECTIONS's per-row carve-out: a
    // roster fold can clear for most of a section's numbers while a few (R67's
    // #420 Luis Arraez shape -- no base counterpart at all) have nothing to
    // fold onto. Those numbers are emitted exactly as an ordinary own-cards
    // section would be: original category, blank parallel -- never silently
    // dropped, never forced onto an anchor that does not carry them.
    const heldOut = sec.foldExceptions && sec.foldExceptions.has(rec.cardNumber.toUpperCase());
    const foldsHere = sec.parallelOf && !heldOut;
    const target = foldsHere ? sec.parallelOf : sec;
    // isAuto comes from the SECTION's own category, never the fold target's.
    // The two always agreed under the pre-existing name-based fold (it
    // requires isAutoSection(anchor) === isAutoSection(section) before it
    // will even consider a candidate), so this is a no-op there. The
    // roster-based fold above deliberately allows a signed section to fold
    // onto the unsigned base anchor (R67: "the tail says SIGNED" -- isAuto is
    // its own axis, not the address) and target.category would otherwise
    // silently overwrite isAuto=true with the anchor's own false.
    const isAuto = sec.category.startsWith("auto-") ? "true" : "false";
    // CF-BECKETT-RC-IS-A-FLAG-NOT-A-NAME (2026-09-19). The RC flag appended
    // above ("Jacob Wilson RC") is stamped onto the player field by only SOME
    // sheets for a card that appears, unflagged, on every other sheet under
    // the identical name -- measured on 2026 Topps Series 1 Baseball, 71
    // rookies read "<Name> RC" on the Base sheet and its Golden Mirror
    // Variation section, "<Name>" everywhere else. Left in, cleanPlayerName
    // (cardCatalog.service.ts) does not strip it either, so playerSlug would
    // mint "jonah-tong-rc" for the base row and "jonah-tong" for every one of
    // its own parallels and any sale -- never matching. The checklist-csv-
    // contract has no rookie/RC column, so none is invented here; the flag is
    // simply not carried into the emitted `player` field. A future column for
    // it is a separate decision, not silently reconstructable from this CSV.
    //
    // Stripped PER PLAYER, not just at the tail of the whole field: a merged
    // League Leaders row (CF-BECKETT-A-LEAGUE-LEADERS-CARD-IS-ONE-ROW) can
    // read "Jonah Tong RC/Someone Else", and a tail-only strip would miss the
    // flag entirely because "Someone Else" is now the last segment.
    const emitPlayer = rec.player.split("/").map((p) => p.replace(/\s+RC$/i, "")).join("/");
    // CF-A-FOLDED-RUNG-CARRIES-THE-SOURCE-STATED-PRINT-RUN (2026-09-20,
    // review fix). This plain-card push used to hardcode printRun: "" for
    // EVERY record, folded or not -- harmless for an unfolded own-cards
    // section (nothing else claims to know its run either), but WRONG for a
    // folded section: the fold target's own category is a real product
    // (e.g. "Silver" on "Base Autographs", "/49") whose print run the
    // source DOES state, just never on the dedicated section's own rows
    // (Beckett's "list below" pointer shape means the dedicated section --
    // "Base Silver Autographs", "Rated Rookies Autographs Purple" -- is a
    // plain card list with no ladder of its own; the run is stated on the
    // ANCHOR's ladder line instead: "Silver - /49 (select cards only, list
    // below)", "Purple - /150 (select cards only, list below)"). Before the
    // SELECT_CARDS_ONLY_NOTE guard above existed, the mechanical full-
    // roster ladder stamp (which DID carry the real run) emitted a second,
    // identically-keyed row that happened to win the pre-existing dedup
    // (`seen`, keyed without printRun) over this blank one, which MASKED
    // the defect: committed Photogenic reads "Silver,true,49" today only
    // because of that now-fixed duplicate, not because this line ever
    // computed 49 itself. Once that duplicate stopped being emitted for the
    // "select cards only" shape, this line's own hardcoded blank became the
    // only row left -- exactly the regression found in review.
    //
    // Resolution order (never invents a run, matches the review's own
    // instruction): (1) the DEDICATED section's own declared ladder, if it
    // has one stating a run for its own bare tier -- rare (no fixture
    // measured needs it yet, but a future one might) and checked first
    // because it is the more specific source; (2) else the FOLD TARGET's
    // (`target`, the anchor) own ladder, for a rung name matching what THIS
    // section folds as (`sec.rung`, or the section's own name for the
    // bare-signed-tier shape where rung equals the full name) -- this is
    // where "Silver -/49" and "Purple -/150" actually live. If both exist
    // and disagree, the dedicated section's own statement wins (closer to
    // the source) and the disagreement is recorded in the manifest via
    // printRunConflicts, never silently dropped either way.
    let resolvedPrintRun = "";
    let printRunConflict = null;
    if (foldsHere) {
      const rungLabel = sec.rung || "";
      const ownLadderRung = (sec.ladder || []).find((r) => r.name === rungLabel && r.printRun != null);
      const anchorLadderRung = (target.ladder || []).find((r) => r.name === rungLabel && r.printRun != null);
      if (ownLadderRung && anchorLadderRung && ownLadderRung.printRun !== anchorLadderRung.printRun) {
        printRunConflict = {
          sheet: sec.sheet, section: sec.section, rung: rungLabel,
          ownPrintRun: ownLadderRung.printRun, anchorPrintRun: anchorLadderRung.printRun,
        };
      }
      resolvedPrintRun = ownLadderRung ? ownLadderRung.printRun : (anchorLadderRung ? anchorLadderRung.printRun : "");
    }
    if (printRunConflict) printRunConflicts.push(printRunConflict);
    // The plain card. Parallel stays BLANK, never "Base" — normalizeParallel()
    // already reads "" as the base tier, so the blank lies about nothing.
    out.push({
      category: target.category,
      cardNumber: rec.cardNumber,
      parallel: foldsHere ? sec.rung : "",
      isAuto: isAuto,
      printRun: resolvedPrintRun === "" ? "" : String(resolvedPrintRun),
      player: emitPlayer,
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
    //
    // The `|| sec.crossClassFoldKeepsOwnLadder` half is CF-A-SIGNED-PRODUCT-
    // FOLDED-AS-A-TIER-KEEPS-ITS-OWN-LADDER (see that flag's own header
    // comment, set only by the cross-auto-class roster fold above): a
    // section folding UP as the bare signed tier of an unsigned anchor is
    // still a real product with its own further colour ladder, never
    // suppressed by the fold the way an ordinary same-class colour-rung
    // fold's ladder correctly is.
    if (!foldsHere || sec.crossClassFoldKeepsOwnLadder) {
      for (const rung of sec.ladder || []) {
        // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE
        // (2026-09-20, Donruss FB). A ladder rung can carry a stated print
        // run AND, in its own trailing note, say it does not apply to
        // every card in the section ("select cards only, list below") --
        // 2024 Panini Donruss Football's "Rated Rookies Autographs" ladder
        // states "Purple - /150 (select cards only, list below)" alongside
        // "Gold - /25" and "Black - /10" (no such qualifier). Mechanically
        // stamping Purple onto all 63 base-roster numbers the same way Gold
        // and Black correctly are is the cross-join CF-EMIT-THE-WHOLE-
        // LADDER's own header warns against: Beckett is stating that
        // Purple has an actual narrower, separately-printed roster --
        // "list below" pointing at exactly that: the real "Rated Rookies
        // Autographs Purple" section, printed further down this same
        // sheet, which classifySections's roster-fold now correctly folds
        // onto this same anchor as its own `parallel="Purple"` rows (50 of
        // its 51 numbers agree; the 51st has no counterpart here at all --
        // held out, not forced). Emitting BOTH here would either silently
        // duplicate the 50 agreeing rows (harmless but redundant) or, worse,
        // invent 12 Purple auto rows for base cards that were never
        // actually printed with one -- a synthetic parallel no scraped row
        // supports, which the no-synthetic-parallels rule forbids outright.
        // Detected the same way parseRung already recognizes a stated-odds
        // note (see statesOdds) -- evidence in the rung's own note, never a
        // vocabulary guess -- and the guard below only ever SKIPS emission
        // here when the fold this note points at genuinely exists among
        // this run's own sibling sections (by number, roster-verified,
        // never merely by name); if no such fold exists, the rung falls
        // through to the ordinary droppedDeclaredParallels finding via
        // main()'s own guard (sec.declaredParallels already carries this
        // exact string), never silently vanishing and never silently
        // over-applied.
        if (SELECT_CARDS_ONLY_NOTE.test(String(rung.note || ""))) {
          if (satisfiedLadderRungNames.get(sec) && satisfiedLadderRungNames.get(sec).has(rung.name)) {
            continue;
          }
          // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE,
          // Master-sheet half (2026-09-20, review fix). No sibling section
          // satisfies this rung by name -- check Master directly (see
          // masterRosterFor's own header comment) before deciding there is
          // no list at all. 2023 Topps Series 1/2 Baseball's "Clear" rung is
          // exactly this shape: no sibling section resolves via
          // classifySections's fold (the sub-list section, "Clear
          // Checklist", carries the generic "Checklist" title-artifact
          // suffix with no sibling on its own sheet to confirm stripping it
          // -- see stripChecklistSuffix's own header comment -- so it never
          // becomes a named fold candidate at all), but Master's own "Card
          // Set" column lists exactly 100 "Clear"-tagged rows out of 330
          // base cards, verbatim.
          const masterRoster = masterRosterForRung(rung.name);
          if (masterRoster) {
            const key = String(rec.cardNumber || "").toUpperCase();
            const masterPlayers = masterRoster.get(key);
            // ROSTER-VERIFIED, NEVER TRUSTED BLIND: Master must both LIST
            // this number for this rung AND name the SAME person this run's
            // own anchor roster already established for it. A number Master
            // lists under a DIFFERENT player than this card's own roster
            // (the same class of source disagreement
            // CF-BASE-SET-IS-NOT-A-SUBSET's own history warns about) is an
            // unresolved finding, not a fold -- dropped from the emitted
            // rows the same way any other disagreement is, never guessed.
            if (!masterPlayers || !masterPlayers.has(normalizeRosterPlayer(emitPlayer))) continue;
          } else {
            // No sibling fold AND no Master entry under this exact name --
            // Beckett states the restriction but this workbook carries no
            // discoverable list for it anywhere this converter reads. Absent
            // beats wrong: record once per (section, rung), emit nothing.
            if (!restrictedRungsWithoutAList.some((r) => r.sheet === sec.sheet && r.section === sec.section && r.rung === rung.name)) {
              restrictedRungsWithoutAList.push({
                sheet: sec.sheet, section: sec.section, rung: rung.name,
                note: rung.note || null, printRun: rung.printRun == null ? null : rung.printRun,
              });
            }
            continue;
          }
        }
        out.push({
          category: target.category,
          cardNumber: rec.cardNumber,
          parallel: rung.name,
          isAuto: isAuto,
          printRun: rung.printRun == null ? "" : String(rung.printRun),
          player: emitPlayer,
        });
      }
    }
  }

  // Guard against the duplicate-id class of bug: the same card appearing twice
  // would upsert over itself and hide a parse error. parallel and isAuto are
  // part of the key — once a variation folds onto its anchor's card number, the
  // rung is the ONLY thing separating it from the anchor row, and keying
  // without it would delete every folded row as a "duplicate".
  //
  // CF-A-NUMBERED-STATEMENT-OUTRANKS-AN-UNNUMBERED-ONE-OF-THE-SAME-RUNG
  // (2026-09-20, review fix). printRun is now PART of the identity below,
  // never folded into the same key a bare (category, cardNumber, parallel,
  // isAuto, player) tuple already used -- before this fix, a genuinely
  // numbered row (the mechanical full-roster ladder stamp, when it existed)
  // and a genuinely unnumbered row (the fold-target's plain-card push,
  // before CF-A-FOLDED-RUNG-CARRIES-THE-SOURCE-STATED-PRINT-RUN above
  // taught it to look the run up) could silently mask one another under
  // the OLD key, which is exactly how committed Photogenic's own "Silver,
  // true, 49" row survived for as long as it did -- the blank statement
  // this file used to emit was there the whole time, just shadowed. With
  // printRun resolved correctly at the emission site, the two should never
  // actually disagree any more for a fold -- but if some future workbook
  // shape still produces a genuine (numbered, unnumbered) pair for the
  // identical rung, this keeps them from silently collapsing into whichever
  // one the Map iteration order happened to see first: the numbered
  // statement is kept (closer to the source's own printed run than an
  // absence of one), the unnumbered twin is dropped as the finding it is,
  // and BOTH sides of every such swap are recorded in the manifest.
  const byIdentityNoRun = new Map();
  for (const r of out) {
    const kNoRun = [r.category, r.cardNumber, r.parallel, r.isAuto, r.player].join("|");
    if (!byIdentityNoRun.has(kNoRun)) byIdentityNoRun.set(kNoRun, []);
    byIdentityNoRun.get(kNoRun).push(r);
  }
  const numberedVsUnnumberedFindings = [];
  const seen = new Set();
  const rowsOut = [];
  for (const [kNoRun, group] of byIdentityNoRun) {
    let winner = group[0];
    if (group.length > 1) {
      const numbered = group.filter((r) => r.printRun !== "");
      const unnumbered = group.filter((r) => r.printRun === "");
      if (numbered.length && unnumbered.length) {
        numberedVsUnnumberedFindings.push({
          category: winner.category, cardNumber: winner.cardNumber, parallel: winner.parallel,
          keptPrintRun: numbered[0].printRun, droppedCount: group.length - 1,
        });
      }
      // Prefer a numbered statement; among numbered statements (or among
      // unnumbered ones, if that's all there is), the first seen is kept --
      // unchanged from the pre-existing behaviour for every shape that is
      // NOT this specific numbered/unnumbered split.
      winner = numbered.length ? numbered[0] : group[0];
    }
    const k = [winner.category, winner.cardNumber, winner.parallel, winner.isAuto, winner.printRun, winner.player].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    rowsOut.push(winner);
  }

  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of rowsOut) {
    const q = (v) => (/[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
    csv.push([r.category, r.cardNumber, q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
  }

  // CF-A-DECLARED-PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING (2026-09-20).
  // Every section declared at least one name in its OWN "Parallels:" block
  // (sec.declaredParallels, tracked in pass 1) that a card should carry as a
  // row once pass 3 runs -- UNLESS the section itself folds onto another
  // section as a parallel rung (foldsHere in pass 3 above; a folded
  // section's own ladder is never emitted by design, and checking it here
  // would false-positive on every ordinary fold in the corpus). For every
  // own-cards/anchor section, compare what it declared against what
  // actually reached rowsOut under that section's category -- a declared
  // name absent from that set never became a row for a single card, the
  // exact failure class Phoenix's sixteen names and Donruss Elite's three
  // shipped silently before this guard existed.
  // CF-A-LIST-BELOW-NAME-POINTS-AT-ANOTHER-SECTION-NOT-A-RUNG-HERE
  // (2026-09-20, Donruss FB). A declared name of the shape "<Name> - (...
  // list below)" / "<Name> - (... list below)" is Beckett's own table-of-
  // contents style pointer to a section named <Name> printed FURTHER DOWN
  // THE SAME SHEET -- never a same-section colour/finish rung at all. 2024
  // Panini Donruss Football's Base Set ladder declares "Jersey Number -
  // (print runs vary, list below)" and "Season Stat Line - (print runs
  // vary, list below)"; both names are ALSO real, separately materialized,
  // roster-verified sections elsewhere on the Base sheet ("Jersey Number
  // Checklist", 395 cards; "Season Stat Line", 400 cards) -- the guard's own
  // per-section emittedNames check can never see this, because the row it
  // is looking for was never going to be filed under Base Set's own
  // category at all; it already exists, correctly, under its own. The
  // guard's original form (comparing only against sec's own emitted rows)
  // is still the right test for a genuine same-section rung -- this is an
  // ADDITIONAL satisfaction, not a replacement: a name is dropped only when
  // NEITHER a same-section row NOR a materialized section elsewhere in the
  // file accounts for it. "Orange (select cards only, list below)" on
  // Rated Rookies Autographs is the identical shape one level down (points
  // at the separately materialized "Rated Rookies Autographs Orange").
  const LIST_BELOW_POINTER = /^(.*\S)\s*[–—-]\s*\(.*list below\)\s*$/i;
  // A trailing " Checklist" is stripped here unconditionally, regardless of
  // what stripChecklistSuffix decided for the SECTION'S OWN stored name
  // (its sibling-carries-it rule is deliberately conservative and can
  // legitimately leave "Checklist" attached -- 2024 Panini Donruss
  // Football's "Jersey Number Checklist" is the ONLY Base-sheet section
  // ending that way, so stripChecklistSuffix's own siblingsCarryIt test
  // never fires for it and the stored section name keeps the suffix). This
  // comparison is a pointer match, not a naming decision, so it always
  // compares the bare form on both sides.
  const normPointerName = (s) => String(s || "")
    .replace(/\s+Checklist$/i, "").toLowerCase().replace(/\s*-\s*/g, " ").trim();
  const materializedSectionNames = new Set(
    [...sections.values()].map((s) => normPointerName(s.section))
  );
  const droppedDeclaredParallels = [];
  for (const sec of sections.values()) {
    if (!sec.declaredParallels || !sec.declaredParallels.length) continue;
    if (sec.parallelOf) continue; // folds onto another section; its own ladder is never emitted
    const emittedNames = new Set(
      rowsOut.filter((r) => r.category === sec.category).map((r) => r.parallel)
    );
    for (const name of new Set(sec.declaredParallels)) {
      if (emittedNames.has(name)) continue;
      const pointerMatch = LIST_BELOW_POINTER.exec(name);
      if (pointerMatch && materializedSectionNames.has(normPointerName(pointerMatch[1].trim()))) continue;
      // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE (see the
      // emission-site guard above, and masterRosterFor's own header comment).
      // A rung this run already decided is a genuine, roster-restricted
      // parallel -- with either a Master-sheet list (in which case it DID
      // emit rows, just fewer than the full roster, so emittedNames.has(name)
      // already caught it above and this branch is not reached for that
      // case) or no list found anywhere in the workbook (recorded in
      // restrictedRungsWithoutAList instead) -- is declared-and-deliberately-
      // held, never a silent, unexplained drop. Checked here so the FATAL
      // below never fires for a name this file's own emission logic already
      // gave an explicit, reported reason for withholding.
      if (restrictedRungsWithoutAList.some((r) => r.sheet === sec.sheet && r.section === sec.section && r.rung === name)) continue;
      droppedDeclaredParallels.push({ sheet: sec.sheet, section: sec.section, parallel: name });
    }
  }
  if (droppedDeclaredParallels.length && !ALLOW_DROPPED_PARALLELS) {
    for (const d of droppedDeclaredParallels) {
      console.error(
        `FATAL: "${d.sheet}" > "${d.section}" declared a parallel named "${d.parallel}" in its ` +
        `own Parallels: block, but no row for that section carries it -- see CF-A-DECLARED-` +
        `PARALLEL-THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING in convertBeckettChecklistXlsx.cjs. Pass ` +
        `--allow-dropped-parallels once a human has confirmed this name genuinely is not a ` +
        `card-bearing parallel.`);
    }
    process.exitCode = 4;
    return { droppedDeclaredParallels };
  }

  const outPath = path.resolve(OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv.join("\n") + "\n");

  const manifest = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: SOURCE_URL,
    ...(SOURCE_LABEL ? { source: SOURCE_LABEL } : {}),
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
    // Additive, opt-in: absent entirely (never an empty array) when no
    // range header was ever discarded, so every existing manifest this
    // converter has ever written stays byte-identical on a re-run.
    ...(discardedRangeHeaders.length ? { discardedRangeHeaders } : {}),
    // Same additive contract, for a --allow-dropped-parallels run that
    // continued past the guard above instead of exiting: the manifest still
    // carries what was found, so a human reviewing the acquisition sees the
    // gap even though the run did not refuse -- see CF-A-DECLARED-PARALLEL-
    // THAT-NEVER-BECOMES-A-ROW-IS-A-FINDING.
    ...(droppedDeclaredParallels.length ? { droppedDeclaredParallels } : {}),
    // CF-AN-OVERRIDE-LEAVES-A-MARK (2026-09-20, review fix). Without this, a
    // manifest carrying droppedDeclaredParallels looks identical whether the
    // run refused (impossible -- refusing never reaches this point) or
    // whether a human explicitly waved the guard through with
    // --allow-dropped-parallels. That flag is meant to be used only after a
    // human looked at the reported drop and confirmed it is not a
    // card-bearing parallel (see ALLOW_DROPPED_PARALLELS's own header
    // comment) -- an auditor reading this manifest later needs to be able to
    // tell "this run never tripped the guard" apart from "this run tripped
    // the guard and someone overrode it" without re-running the CLI to check
    // which flag was passed. Stamped ONLY alongside droppedDeclaredParallels
    // (never on its own -- ALLOW_DROPPED_PARALLELS with nothing dropped has
    // nothing to have overridden) and only true, never false, so it stays
    // additive/opt-in like every other field in this block: a run that never
    // passes the flag, or passes it with nothing dropped, writes a manifest
    // byte-identical to before this stamp existed.
    ...(droppedDeclaredParallels.length && ALLOW_DROPPED_PARALLELS ? { allowDroppedParallelsUsed: true } : {}),
    // CF-A-SELECT-CARDS-ONLY-RUNG-IS-NOT-A-FULL-ROSTER-TEMPLATE (2026-09-20,
    // review fix). A rung whose note stated a roster restriction ("select
    // cards, see below") for which NEITHER a sibling fold NOR a Master-sheet
    // "Card Set" entry could be found anywhere in this workbook -- emitted
    // nowhere, rather than stamped across the whole section (the defect this
    // fix exists to close: 2023 Topps Series 1/2 Baseball's own "Clear -
    // /10 (select cards, see below; hobby only)" was landing on all 330 base
    // cards instead of the 100 Master states). Additive, opt-in: absent
    // entirely when nothing was withheld, so a workbook whose every
    // restriction resolves via a sibling fold or a Master list writes a
    // manifest byte-identical to before this field existed.
    ...(restrictedRungsWithoutAList.length ? { restrictedRungsWithoutAList } : {}),
    // CF-A-FOLDED-RUNG-CARRIES-THE-SOURCE-STATED-PRINT-RUN's own disagreement
    // record (see that CF's header comment at the emission site): a
    // dedicated section's own ladder and its fold anchor's ladder rung of
    // the same name stating DIFFERENT print runs for the same product is a
    // real finding, not a silent resolution either way -- additive/opt-in
    // like every other finding array in this manifest.
    ...(printRunConflicts.length ? { printRunConflicts } : {}),
    // CF-A-NUMBERED-STATEMENT-OUTRANKS-AN-UNNUMBERED-ONE-OF-THE-SAME-RUNG's
    // own record (see that CF's header comment at the dedup site): additive/
    // opt-in, empty on every workbook where this shape never occurs (which
    // is every currently-measured fixture once print run resolution is
    // fixed at the source -- this array exists for the NEXT workbook that
    // proves it can still happen).
    ...(numberedVsUnnumberedFindings.length ? { numberedVsUnnumberedFindings } : {}),
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
  for (const d of discardedRangeHeaders) {
    console.log("     !! DISCARDED RANGE HEADER  " + d.sheet + " row " + d.row +
      "  \"" + d.header + "\"  — next card #" + d.nextCardNumber +
      " falls outside its stated range (or is not a plain integer); the header named no section");
  }
}

if (require.main === module) main();

module.exports = {
  classifySections, rungName, categoryFor, PLAIN_SECTION, parseRung, LADDER_HEAD, isSupersetSheet, isCountLine,
  stripChecklistSuffix, masterCardSetNames, sheetSectionHeaderNames,
  normalizeRosterPlayer, rosterFoldAgainst,
  rangePreviewLineIndices, RANGE_PREVIEW_LINE,
  countDataLookingRows,
  parseLadderLine, BARE_LADDER_NAME, ODDS_LINE, LADDER_PROSE_NOT_A_NAME,
};
