#!/usr/bin/env node
/**
 * CF-MISSING-PRODUCTS (2026-07-11, Drew).
 *
 * Adds SetDocs for product lines that the coverage audit flagged as
 * completely missing from the reference catalog. These are legit
 * baseball products from 1990s-2020s that CompIQ should be able to
 * catalog + fuzzy-match against.
 *
 * Runbook:
 *   node scripts/build-missing-products-setdocs.cjs <output.xlsx>
 *   node scripts/ingest-reference.cjs --format=sets <output.xlsx>
 */

const XLSX = require("xlsx");

const [outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node build-missing-products-setdocs.cjs <output.xlsx>");
  process.exit(1);
}

function setRow(yearText, setName, manufacturer, setType, setSize, format, keyNotes = "", confidence = "High") {
  return {
    "Year(s)": yearText,
    Set: setName,
    Manufacturer: manufacturer,
    Type: setType,
    "Set Size": setSize,
    Format: format,
    "Key Notes": keyNotes,
    Confidence: confidence,
  };
}

const rows = [];

// ─── Fleer sub-brands ────────────────────────────────────────────────────
for (let y = 1998; y <= 2006; y++) rows.push(setRow(String(y), "Fleer Tradition", "Fleer/UD", "Base Retro", 500, "Card"));
for (let y = 2001; y <= 2003; y++) rows.push(setRow(String(y), "Fleer Focus", "Fleer/UD", "Base", 250, "Card"));
for (let y = 2001; y <= 2005; y++) rows.push(setRow(String(y), "Fleer Genuine", "Fleer/UD", "Premium", 150, "Card"));
for (let y = 2003; y <= 2005; y++) rows.push(setRow(String(y), "Fleer Showcase", "Fleer/UD", "Insert", 100, "Card"));
for (let y = 2005; y <= 2007; y++) rows.push(setRow(String(y), "Fleer Fabrics of the Game", "Fleer/UD", "Premium Memorabilia", 100, "Card"));

// ─── Upper Deck sub-brands ───────────────────────────────────────────────
for (let y = 1999; y <= 2006; y++) rows.push(setRow(String(y), "Upper Deck Ultimate", "Upper Deck", "Ultra Premium", 60, "Card"));
for (let y = 1998; y <= 2001; y++) rows.push(setRow(String(y), "Upper Deck Portrait", "Upper Deck", "Premium Artistic", 100, "Card"));
for (let y = 1998; y <= 2000; y++) rows.push(setRow(String(y), "Upper Deck PowerDeck", "Upper Deck", "CD-ROM Card", 100, "CD-ROM"));
for (let y = 1997; y <= 2002; y++) rows.push(setRow(String(y), "Upper Deck Retro", "Upper Deck", "Retro", 100, "Card"));
for (let y = 2001; y <= 2005; y++) rows.push(setRow(String(y), "Upper Deck Sweet Spot", "Upper Deck", "Premium", 100, "Card"));

// ─── Pacific line ────────────────────────────────────────────────────────
for (let y = 1998; y <= 2004; y++) rows.push(setRow(String(y), "Pacific Crown Royale", "Pacific", "Premium Die-Cut", 150, "Card"));
for (let y = 1997; y <= 2000; y++) rows.push(setRow(String(y), "Pacific Invincible", "Pacific", "Premium", 150, "Card"));
for (let y = 1998; y <= 2000; y++) rows.push(setRow(String(y), "Pacific Omega", "Pacific", "Premium", 250, "Card"));
for (let y = 1998; y <= 2000; y++) rows.push(setRow(String(y), "Pacific Paramount", "Pacific", "Base", 300, "Card"));
for (let y = 1998; y <= 2001; y++) rows.push(setRow(String(y), "Pacific Aurora", "Pacific", "Premium Artistic", 200, "Card"));
for (let y = 1998; y <= 2000; y++) rows.push(setRow(String(y), "Pacific Online", "Pacific", "Base", 800, "Card"));

// ─── Skybox line (mostly discontinued 2001) ─────────────────────────────
for (let y = 1997; y <= 2001; y++) rows.push(setRow(String(y), "Skybox EX", "Fleer/Skybox", "Premium Acetate", 100, "Card"));
for (let y = 1996; y <= 2001; y++) rows.push(setRow(String(y), "Skybox Metal Universe", "Fleer/Skybox", "Metallic", 220, "Card"));
for (let y = 1996; y <= 2001; y++) rows.push(setRow(String(y), "Skybox Premium", "Fleer/Skybox", "Premium", 250, "Card"));
for (let y = 1998; y <= 2001; y++) rows.push(setRow(String(y), "Skybox Autographics", "Fleer/Skybox", "Autograph", 90, "Card"));

// ─── Playoff/Leaf line ───────────────────────────────────────────────────
for (let y = 1998; y <= 2005; y++) rows.push(setRow(String(y), "Playoff Absolute", "Playoff/Panini", "Premium", 200, "Card"));
for (let y = 2001; y <= 2005; y++) rows.push(setRow(String(y), "Playoff Honors", "Playoff/Panini", "Premium", 200, "Card"));
for (let y = 1996; y <= 2002; y++) rows.push(setRow(String(y), "Leaf Signature Series", "Donruss/Leaf", "Autograph Premium", 200, "Card"));
for (let y = 1998; y <= 2004; y++) rows.push(setRow(String(y), "Leaf Rookies & Stars", "Donruss/Leaf", "Premium", 200, "Card"));
for (let y = 2020; y <= 2025; y++) rows.push(setRow(String(y), "Leaf Metal", "Leaf", "Modern Premium", 200, "Card"));
for (let y = 1995; y <= 2001; y++) rows.push(setRow(String(y), "Metal Universe", "Fleer/Skybox", "Metallic", 220, "Card"));

// ─── Studio ──────────────────────────────────────────────────────────────
for (let y = 1991; y <= 2004; y++) rows.push(setRow(String(y), "Donruss Studio", "Donruss/Leaf", "Portrait Premium", 200, "Card"));

// ─── Panini modern additions ────────────────────────────────────────────
for (let y = 2022; y <= 2025; y++) rows.push(setRow(String(y), "Panini Origins", "Panini", "Base", 300, "Card"));
for (let y = 2020; y <= 2025; y++) rows.push(setRow(String(y), "Panini Absolute", "Panini", "Base", 200, "Card"));
for (let y = 2020; y <= 2023; y++) rows.push(setRow(String(y), "Panini Playbook", "Panini", "Premium", 100, "Card"));
for (let y = 2024; y <= 2025; y++) rows.push(setRow(String(y), "Panini Three and Two", "Panini", "Base", 300, "Card"));
for (let y = 2024; y <= 2025; y++) rows.push(setRow(String(y), "Panini Prospect Edition", "Panini", "Prospects", 200, "Card"));
for (let y = 2020; y <= 2024; y++) rows.push(setRow(String(y), "Panini USA Baseball Stars & Stripes", "Panini", "USA Baseball", 100, "Card"));
for (let y = 2020; y <= 2025; y++) rows.push(setRow(String(y), "Panini Elite Extra Edition", "Panini", "Draft", 200, "Card"));

// ─── SAGE (prospect-focused) ─────────────────────────────────────────────
for (let y = 2010; y <= 2020; y++) rows.push(setRow(String(y), "SAGE Hit", "SAGE", "Prospects", 200, "Card"));
for (let y = 2010; y <= 2020; y++) rows.push(setRow(String(y), "SAGE Autographed", "SAGE", "Autograph", 100, "Card"));

// ─── Grandstand (minor league) ───────────────────────────────────────────
for (let y = 2018; y <= 2024; y++) rows.push(setRow(String(y), "Grandstand", "Grandstand", "Minor League", 300, "Card"));

// ─── Just Minors ─────────────────────────────────────────────────────────
for (let y = 2005; y <= 2015; y++) rows.push(setRow(String(y), "Just Minors", "Just Minors", "Minor League", 300, "Card"));

// ─── Topps Chrome Update years 2008-2016 (existed but currently thin) ───
for (let y = 2008; y <= 2016; y++) rows.push(setRow(String(y), "Topps Chrome Update", "Topps", "Chromium", 150, "Card"));

// ─── Bowman family additions ─────────────────────────────────────────────
for (let y = 2014; y <= 2020; y++) rows.push(setRow(String(y), "Bowman High Tek", "Topps/Bowman", "Premium Acetate", 100, "Card"));
for (let y = 2013; y <= 2026; y++) rows.push(setRow(String(y), "Bowman Inception", "Topps/Bowman", "Premium", 100, "Card"));
for (let y = 2010; y <= 2020; y++) rows.push(setRow(String(y), "Bowman Platinum", "Topps/Bowman", "Chromium Premium", 100, "Card"));
for (let y = 2004; y <= 2020; y++) rows.push(setRow(String(y), "Bowman Sterling", "Topps/Bowman", "Ultra Premium", 100, "Card"));

console.log(`[missing] generated ${rows.length} SetDocs`);

const wb = XLSX.utils.book_new();
const readmeRows = [
  ["Missing products SetDoc coverage", ""],
  ["Purpose", "Fills product families that the audit flagged as completely missing"],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readmeRows), "README");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Catalog");
XLSX.writeFile(wb, outPath);
console.log(`[missing] wrote ${outPath}`);
