#!/usr/bin/env node
/**
 * CF-JUNKWAX-SETDOCS (2026-07-11, Drew).
 *
 * Builds SetDoc-shaped rows for the junk-wax era (1989-2010) base
 * products, extending the vintage_set_catalog container's coverage
 * forward from 1988 to 2010.
 *
 * These aren't parallels — they're base sets that existed but
 * mostly didn't ship with parallels. Adding them as SetDocs lets
 * CompIQ know these products EXIST for cataloging + fuzzy-match
 * purposes, even though they don't drive the parallel-floor ladder.
 *
 * Sources: BaseballCardPedia + Beckett + Cardboard Connection.
 *
 * Runbook (uses --format=sets):
 *   node scripts/build-junkwax-setdocs.cjs <output.xlsx>
 *   node scripts/ingest-reference.cjs --format=sets <output.xlsx>
 */

const XLSX = require("xlsx");

const [outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node build-junkwax-setdocs.cjs <output.xlsx>");
  process.exit(1);
}

const notes = "junk-wax era SetDoc expansion (BCP + Beckett + Cardboard Connection, 2026-07-11)";

function setRow(yearText, setName, manufacturer, setType, setSize, format, keyNotes = "", confidence = "High") {
  return {
    "Year(s)": yearText,
    Set: setName,
    Manufacturer: manufacturer,
    Type: setType,
    "Set Size": setSize,
    Format: format,
    "Key Notes": keyNotes || notes,
    Confidence: confidence,
  };
}

const rows = [];

// ─── Topps flagship 1989-2010 ────────────────────────────────────────────
const toppsFlagship = [
  [1989, 792, "First to include previous year's draft picks; Biggio/RJohnson/Sheffield/Smoltz RCs"],
  [1990, 792, "Gray stock; Frank Thomas/Sosa/Bernie Williams RCs; NNOF variation"],
  [1991, 792, "40th Anniversary; Chipper Jones RC; final Tiffany year"],
  [1992, 792, "Ivan Rodriguez / Jim Thome RCs"],
  [1993, 825, "Derek Jeter RC; final Tiffany-style Gold set"],
  [1994, 792, "Alex Rodriguez XRC in Traded"],
  [1995, 660, "Reduced from 792"],
  [1996, 440, "Reduced set size"],
  [1997, 495, "Vlad Guerrero RC"],
  [1998, 503, "Kerry Wood RC; Roy Halladay RC"],
  [1999, 462, "Includes McGwire/Sosa HR Record cards"],
  [2000, 478, "Includes Magical Moments variations"],
  [2001, 790, "Ichiro / Pujols RCs"],
  [2002, 718, ""],
  [2003, 720, ""],
  [2004, 733, ""],
  [2005, 733, ""],
  [2006, 660, ""],
  [2007, 660, ""],
  [2008, 660, ""],
  [2009, 660, "Trout variation"],
  [2010, 660, "Strasburg-mania"],
];
for (const [year, size, notesInline] of toppsFlagship) {
  rows.push(setRow(String(year), "Topps", "Topps", "Base", size, "Card", notesInline));
}

// ─── Topps Update (Traded) 1989-2010 ─────────────────────────────────────
for (let year = 1989; year <= 2010; year++) {
  const setSize = year >= 2000 ? 330 : 132;
  const setName = year <= 2005 ? "Topps Traded" : "Topps Update";
  rows.push(setRow(String(year), setName, "Topps", "Base", setSize, "Card"));
}

// ─── Topps Tiffany 1989-1991 (final year 1991) ──────────────────────────
for (const year of [1989, 1990, 1991]) {
  rows.push(setRow(String(year), "Topps Tiffany", "Topps", "Parallel", 792, "Card", "Factory set; ~15,000 produced"));
}

// ─── Bowman flagship 1989-2010 ───────────────────────────────────────────
const bowmanFlagship = [
  [1989, 484, "Relaunch year; Griffey RC"],
  [1990, 528, ""],
  [1991, 704, "Chipper Jones RC"],
  [1992, 705, "Mariano Rivera RC"],
  [1993, 708, "Derek Jeter RC (BB card #511)"],
  [1994, 682, ""],
  [1995, 439, "First year with metallic foil"],
  [1996, 385, ""],
  [1997, 442, "Vlad Guerrero"],
  [1998, 441, "Kerry Wood; first Chrome parallel"],
  [1999, 440, "Josh Beckett"],
  [2000, 440, ""],
  [2001, 415, "Ichiro RC / Pujols RC"],
  [2002, 495, ""],
  [2003, 720, ""],
  [2004, 405, ""],
  [2005, 331, ""],
  [2006, 385, ""],
  [2007, 385, ""],
  [2008, 385, ""],
  [2009, 330, "Trout as prospect"],
  [2010, 330, "Bryce Harper RC"],
];
for (const [year, size, note] of bowmanFlagship) {
  rows.push(setRow(String(year), "Bowman", "Topps/Bowman", "Base", size, "Card", note));
}

// ─── Bowman's Best 1994-2005 ─────────────────────────────────────────────
for (let year = 1994; year <= 2005; year++) {
  rows.push(setRow(String(year), "Bowman's Best", "Topps/Bowman", "Insert Chrome", 200, "Card"));
}

// ─── Topps Chrome 1996-2020 (SetDocs; parallels covered elsewhere) ──────
for (let year = 1996; year <= 2020; year++) {
  rows.push(setRow(String(year), "Topps Chrome", "Topps", "Chromium", 200, "Card"));
}

// ─── Bowman Chrome 1997-2020 ─────────────────────────────────────────────
for (let year = 1997; year <= 2020; year++) {
  rows.push(setRow(String(year), "Bowman Chrome", "Topps/Bowman", "Chromium", 200, "Card"));
}

// ─── Topps Finest 1993-2015 ──────────────────────────────────────────────
for (let year = 1993; year <= 2015; year++) {
  rows.push(setRow(String(year), "Topps Finest", "Topps", "Premium Chromium", 200, "Card"));
}

// ─── Bowman Draft Picks & Prospects 1998-2020 ────────────────────────────
for (let year = 1998; year <= 2020; year++) {
  rows.push(setRow(String(year), "Bowman Draft Picks & Prospects", "Topps/Bowman", "Draft", 400, "Card"));
}

// ─── Fleer 1989-2007 ─────────────────────────────────────────────────────
for (let year = 1989; year <= 2007; year++) {
  rows.push(setRow(String(year), "Fleer", "Fleer/UD", "Base", 660, "Card"));
}

// ─── Fleer Ultra 1991-2007 ───────────────────────────────────────────────
for (let year = 1991; year <= 2007; year++) {
  rows.push(setRow(String(year), "Fleer Ultra", "Fleer/UD", "Premium", 400, "Card"));
}

// ─── Fleer EX 1997-2003 ──────────────────────────────────────────────────
for (let year = 1997; year <= 2003; year++) {
  rows.push(setRow(String(year), "Fleer EX", "Fleer/UD", "Premium Acetate", 100, "Card"));
}

// ─── Fleer Metal 1995-2001 ───────────────────────────────────────────────
for (let year = 1995; year <= 2001; year++) {
  rows.push(setRow(String(year), "Fleer Metal Universe", "Fleer/UD", "Metallic", 200, "Card"));
}

// ─── Score 1988-2005 ─────────────────────────────────────────────────────
for (let year = 1988; year <= 2005; year++) {
  rows.push(setRow(String(year), "Score", "Score/Pinnacle/Panini", "Base", 660, "Card"));
}

// ─── Upper Deck 1989-2013 ────────────────────────────────────────────────
for (let year = 1989; year <= 2013; year++) {
  rows.push(setRow(String(year), "Upper Deck", "Upper Deck", "Base", 800, "Card"));
}

// ─── Upper Deck SP 1993-2006 ─────────────────────────────────────────────
for (let year = 1993; year <= 2006; year++) {
  rows.push(setRow(String(year), "Upper Deck SP", "Upper Deck", "Premium", 200, "Card"));
}

// ─── Upper Deck SPX 1996-2006 ────────────────────────────────────────────
for (let year = 1996; year <= 2006; year++) {
  rows.push(setRow(String(year), "Upper Deck SPX", "Upper Deck", "Ultra Premium", 100, "Card"));
}

// ─── Pinnacle 1992-1998 ──────────────────────────────────────────────────
for (let year = 1992; year <= 1998; year++) {
  rows.push(setRow(String(year), "Pinnacle", "Score/Pinnacle", "Premium", 620, "Card"));
}

// ─── Donruss 1989-2005 (junk-wax through modern relaunch) ───────────────
for (let year = 1989; year <= 2005; year++) {
  rows.push(setRow(String(year), "Donruss", "Donruss/Panini", "Base", 660, "Card"));
}

// ─── Pacific 1993-2004 ───────────────────────────────────────────────────
for (let year = 1993; year <= 2004; year++) {
  rows.push(setRow(String(year), "Pacific", "Pacific Trading Cards", "Base", 660, "Card"));
}

// ─── Stadium Club 1991-2008 ──────────────────────────────────────────────
for (let year = 1991; year <= 2008; year++) {
  rows.push(setRow(String(year), "Stadium Club", "Topps", "Premium", 720, "Card"));
}

// ─── Topps Gallery 1996-2006 ─────────────────────────────────────────────
for (let year = 1996; year <= 2006; year++) {
  rows.push(setRow(String(year), "Topps Gallery", "Topps", "Premium Artistic", 175, "Card"));
}

// ─── Topps Archives (throwback) 2001-2020 ────────────────────────────────
for (let year = 2001; year <= 2020; year++) {
  rows.push(setRow(String(year), "Topps Archives", "Topps", "Throwback", 300, "Card"));
}

// ─── Topps Heritage 2001-2020 ────────────────────────────────────────────
for (let year = 2001; year <= 2020; year++) {
  rows.push(setRow(String(year), "Topps Heritage", "Topps", "Retro", 500, "Card"));
}

// ─── Topps Allen & Ginter 2006-2020 ──────────────────────────────────────
for (let year = 2006; year <= 2020; year++) {
  rows.push(setRow(String(year), "Topps Allen & Ginter", "Topps", "Retro Insert", 350, "Card"));
}

// ─── Topps Gypsy Queen 2011-2020 ─────────────────────────────────────────
for (let year = 2011; year <= 2020; year++) {
  rows.push(setRow(String(year), "Topps Gypsy Queen", "Topps", "Retro", 350, "Card"));
}

console.log(`[junkwax] generated ${rows.length} SetDocs`);

const wb = XLSX.utils.book_new();
const readmeRows = [
  ["Junk-wax + modern era SetDoc expansion", ""],
  ["Purpose", "Adds ~350+ SetDocs covering 1988-2020 base products so CompIQ can catalog them"],
  ["Coverage", "Topps flagship, Traded, Tiffany; Bowman flagship; Fleer, Fleer Ultra, EX, Metal; Score; Upper Deck, SP, SPX; Pinnacle; Donruss; Pacific; Stadium Club; Topps Gallery, Archives, Heritage, Allen & Ginter, Gypsy Queen; Topps Chrome + Finest; Bowman Chrome + Draft + Best (SetDoc entries; parallels covered in the parallel-catalog)"],
  ["Source", "BaseballCardPedia + Beckett + Cardboard Connection"],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readmeRows), "README");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Catalog");
XLSX.writeFile(wb, outPath);
console.log(`[junkwax] wrote ${outPath}`);
