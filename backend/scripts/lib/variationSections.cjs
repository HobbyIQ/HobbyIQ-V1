/**
 * variationSections.cjs -- the image-variation vocabulary for the checklist
 * converters, which run without dist/ (their tests run the .cjs directly).
 *
 * CF-A-VARIATION-IS-A-CARD (D22, Drew 2026-08-30). This is a MIRROR of
 * backend/src/services/catalog/variationVocabulary.ts: normalizeVariationSlug
 * and variationFinishOfSection, spelled the same way. The test
 * tests/variationSectionsMirror.test.ts runs both over one table so the two
 * cannot drift; change the TS first, then this, then the table.
 */
"use strict";

const NEVER_KIND = new Set(["base", "set", "cards", "card", "variation", "variations", "var", "vars"]);
const IMAGE_WORDS = new Set(["image", "images", "photo", "photos", "picture", "pic"]);
const GENERIC = new Set([...NEVER_KIND, ...IMAGE_WORDS]);
const FINISH_SPELLING = { superfractor: "SuperFractor", xfractor: "X-Fractor", raywave: "RayWave", frozenfractor: "FrozenFractor", logofractor: "Logofractor" };
// The kinds whose name alone is unambiguous (variationVocabulary.ts KINDS
// without a `requires` context — "chrome" is Heritage-only there).
const KNOWN_KIND_SLUGS = new Set([
  "team-color-border", "team-color", "golden-mirror", "true-photo", "lightboard-logo", "murakami", "frozenfractor",
  "throwback-uniform", "throwback", "nickname", "color-swap", "missing-facsimile-signature", "black-&-white",
  "rookie-design", "1991-design", "wbc-flag", "retrofractor", "award-winners", "player-number", "action", "clear", "error", "mini",
]);
const VARIATION_WORD = /\b(?:variations?|var)\b/;
const IMAGE_VARIATION = /\b(?:image|photo|picture|pic)\s*(?:variations?|var)\b/;
const SSP = /\bssp\b|\bsuper\s+short\s+prints?\b/;

const slugOf = (text) => String(text).toLowerCase().replace(/[^a-z0-9&]+/g, "-").replace(/^-+|-+$/g, "");
const titleCaseWord = (w) => FINISH_SPELLING[w] ?? (w === "ssp" ? "SSP" : w === "&" ? "&" : w === "wbc" ? "WBC" : /^[0-9]/.test(w) ? w : w[0].toUpperCase() + w.slice(1));
const titleCaseSlug = (slug) => slug.split("-").filter(Boolean).map(titleCaseWord).join(" ");

function isVariationSlug(slug) { return /(^|-)variation(-|$)/.test(String(slug ?? "").toLowerCase()); }

function normalizeVariationSlug(slug) {
  let s = String(slug ?? "").toLowerCase().replace(/^-+|-+$/g, "");
  if (!s) return s;
  if (/^(ssp|super-short-prints?)$/.test(s)) return "image-variation-ssp";
  if (s === "iv" || s === "image-var" || s === "photo-var") return "image-variation";
  const label = s.match(/^(ssp|sp)-(chrome|paper)$/);
  if (label) return `image-variation${label[1] === "ssp" ? "-ssp" : ""}-${label[2]}`;
  if (/^short-prints?$/.test(s)) return "short-print";
  if (!/(^|-)(variations?|var)(-|$)/.test(s)) return s;
  s = s.replace(/(^|-)variations(-|$)/g, "$1variation$2").replace(/(^|-)var(-|$)/g, "$1variation$2");
  let ssp = false;
  if (/(^|-)(ssp|super-short-prints?)(-|$)/.test(s)) { ssp = true; s = s.replace(/(^|-)(ssp|super-short-prints?)(?=-|$)/g, ""); }
  s = s.replace(/(^|-)(sp|short-prints?)(?=-|$)/g, "");
  s = s.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  const parts = s.split("-");
  const at = parts.indexOf("variation");
  const before = parts.slice(0, at).filter((w) => !NEVER_KIND.has(w));
  const after = parts.slice(at + 1).filter((w) => w !== "variation" && !GENERIC.has(w));
  const withoutImageWords = before.filter((w) => !IMAGE_WORDS.has(w));
  const kindWords = withoutImageWords.length === 0 || KNOWN_KIND_SLUGS.has(withoutImageWords.join("-")) ? withoutImageWords : before;
  const kind = kindWords.length ? kindWords.join("-") : "image";
  return [kind, "variation", ...(ssp ? ["ssp"] : []), ...after].join("-");
}

/** Section text -> the finish it names, or null for a non-variation section.
 *  The anchor section's own words come off the front. Same rules as the TS. */
function variationFinishOfSection(sectionText, anchorSection = null) {
  let t = String(sectionText ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (anchorSection) {
    const a = String(anchorSection).replace(/\s+/g, " ").trim();
    if (a && t.toLowerCase().startsWith(a.toLowerCase() + " ")) t = t.slice(a.length + 1).trim();
  }
  t = t.replace(/^\d{4}\s+[^-]*-\s*/, "").replace(/\s+(set|checklist)$/i, "").trim();
  const lower = t.toLowerCase();
  if (!VARIATION_WORD.test(lower) && !IMAGE_VARIATION.test(lower) && !SSP.test(lower)) return null;
  const slug = normalizeVariationSlug(slugOf(lower));
  if (!isVariationSlug(slug)) return null;
  const parts = slug.split("-");
  const at = parts.indexOf("variation");
  const after = parts.slice(at + 1).filter((w) => w !== "ssp");
  const kind = parts.slice(0, at).join("-");
  if (after.length === 0 && (kind === "image" || KNOWN_KIND_SLUGS.has(kind))) return titleCaseSlug(slug);
  return t.replace(/^base\s+/i, "")
    .replace(/\b(v)ariations\b/gi, (_m, v) => `${v}ariation`)
    .replace(/\b(image|photo)\s+(v)ariation\b/gi, (_m, _w, v) => `Image ${v}ariation`)
    .replace(/\s+/g, " ").trim();
}

const isVariationSection = (text) => variationFinishOfSection(text) !== null;

module.exports = { normalizeVariationSlug, isVariationSlug, variationFinishOfSection, isVariationSection };
