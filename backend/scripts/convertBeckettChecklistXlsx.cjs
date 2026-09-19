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
// CF-BECKETT-S3-SOURCE-LABEL (2026-09-19). Optional, additive. Distinguishes
// a checklist fetched directly from the S3 origin (beckett-www.s3.amazonaws.com)
// via discoverBeckettS3Checklists.cjs from the same converter's other callers,
// which read the img.beckett.com CDN URL discoverBeckettChecklists.cjs finds.
// Defaults to "" so every existing caller's manifest is byte-identical.
const SOURCE_LABEL = val("--source-label", "");
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
// lowercase, de-duplicate, sort (players split so "Will Shipley/Xavier
// Legette" and "Xavier Legette / Will Shipley" agree) -- AND strip a trailing
// " RC" first, because Beckett's own RC flag (appended in pass 1 above,
// `player += " RC"`) is stamped onto the player field by SOME sheets (the
// Base sheet, and any parallel section built from the same sheet layout) and
// never by others for the identical card, which would otherwise read as a
// disagreement that is really a formatting artifact, not a different player.
function normalizeRosterPlayer(player) {
  return String(player || "")
    .split("/")
    .map((p) => p.trim().replace(/\s+RC$/i, "").trim().toLowerCase())
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
    const candidates = anchors.filter((a) =>
      a !== sec && isAutoSection(a) === isAutoSection(sec) &&
      ((a.explicitAnchor && looksLikeFinishName(sec)) || extendsName(sec, a)));
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
    if (!sec || sec.parallelOf || isHub(sec)) continue;
    const baseAnchor = anchors.find((a) => a !== sec && a.category === "base" && PLAIN_SECTION.test(normSection(a.section)));
    if (!baseAnchor) continue;
    const fold = rosterFoldAgainst(sec, baseAnchor);
    if (fold.shared === 0 || fold.disagree > 0) continue;
    const rung = sec.section; // the section's own header names the parallel
    sec.parallelOf = baseAnchor;
    sec.rung = rung;
    // Numbers this section has that base does not (R67's #420 shape): held
    // out of the fold, not disagreements -- they keep their own category and
    // a blank parallel, same as any other own-cards section, while every
    // clean-subset number folds onto base.
    sec.foldExceptions = new Set(fold.extra);
    Object.assign(r, {
      role: "parallel", anchor: baseAnchor.key, rung: rung,
      rosterFold: true, agree: fold.agree, disagree: fold.disagree,
      ...(fold.extra.length ? { heldNumbers: fold.extra } : { overlapPct: undefined }),
    });
    delete r.overlapPct;
    delete r.note;
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
  // Evidence, not vocabulary. A stated print run, stated pack odds, or a named
  // finish each make this a rung; a line carrying none of the three is prose.
  const statesOdds = note != null && /^\s*1\s*:\s*[\d,]+/.test(String(note).trim());
  if (printRun == null && !statesOdds && !FINISH_WORD.test(s)) return null;
  return { name: s, printRun: printRun, note: note };
}

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
  for (const [name, rows] of Object.entries(sheets)) {
    if (isSupersetSheet(name)) continue;
    let section = name;
    // Every OTHER header on this sheet, computed once, so
    // stripChecklistSuffix can ask "do this sheet's siblings carry the same
    // suffix" without re-scanning the sheet per section.
    const siblingSectionNames = sheetSectionHeaderNames(rows);
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
        section = stripChecklistSuffix(cell, siblingSectionNames, masterNames);
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
          // (cardNumber -> Set of normalizeRosterPlayer(player)), for
          // classifySections's roster-based fold below. Built from the SAME
          // player string every other pass reads (post-RC-append), so the
          // roster a section states here never disagrees with what pass 3
          // emits.
          roster: new Map(),
          // Whatever "Parallels:" block preceded this section's first card.
          ladder: pendingLadder,
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

  // ---- pass 2: which sections are parallels of which anchors? -------------
  const report = classifySections(sections);

  // ---- pass 3: emit ------------------------------------------------------
  const out = [];
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
    // The plain card. Parallel stays BLANK, never "Base" — normalizeParallel()
    // already reads "" as the base tier, so the blank lies about nothing.
    out.push({
      category: target.category,
      cardNumber: rec.cardNumber,
      parallel: foldsHere ? sec.rung : "",
      isAuto: isAuto,
      printRun: "",
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
    if (!foldsHere) {
      for (const rung of sec.ladder || []) {
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

module.exports = {
  classifySections, rungName, categoryFor, PLAIN_SECTION, parseRung, LADDER_HEAD, isSupersetSheet, isCountLine,
  stripChecklistSuffix, masterCardSetNames, sheetSectionHeaderNames,
  normalizeRosterPlayer, rosterFoldAgainst,
};
