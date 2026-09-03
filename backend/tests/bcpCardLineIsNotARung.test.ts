/**
 * CF-A-CARD-IS-NOT-A-PARALLEL (D33, Drew 2026-08-30).
 *
 * Prod's 2020 Bowman Draft BD-152 carries 15 catalog rows whose "parallel" is
 * ANOTHER CARD: "BD 154 Adley Rutschman", "BD 121 Spencer Torkelson", and
 * "Bd 152 Bobby Witt, Jr." itself. The source is the Chrome Gimmicks card
 * list sitting inside the Parallels section.
 *
 * The old guards missed it from both ends. The (now deleted) ingester tested
 * /^[A-Z]{1,6}-\d{1,4}[a-z]?\s+\S/ -- hyphen REQUIRED -- against a
 * space-separated string. The ladders converter tested only the FIRST TOKEN
 * ("BD"), which is not a card number. And the CSV ingest gate matched bare
 * numbers only, so it would re-admit every prefixed form today.
 *
 * These pins hold both guards, and hold their BLAST RADIUS: real parallel
 * names that start with digits must survive.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { qualifiedSetKeyFromTitle } from "../src/services/catalog/productQualifiers.js";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));
// CF-CHRONIC-REDS-DIST (2026-09-03). Was `require_("../dist/services/catalog/
// productQualifiers.js")`, which made this suite fail at import on any clone
// that had not run `npm run build`. Unlike the ops-script suites, nothing here
// tests the compiled artifact: qualifiedSetKeyFromTitle is used purely as a
// helper to express what the BCP ladder guard should decide. The contract under
// test is the guard's behaviour, so the source module is the honest import.
// Same assertions, same inputs, same expected values.
const qualify = (setKey: string, title: string) => qualifiedSetKeyFromTitle(setKey, title);

/**
 * The ingest gate lives in a CLI script that connects to Cosmos on load, so
 * the guard is read out of the source and evaluated on its own. If the
 * function is renamed or removed this test fails loudly rather than silently
 * passing against a stale copy.
 */
function loadIngestGate(): (s: string) => boolean {
  const src = fs.readFileSync(path.resolve(__dirname, "../scripts/ingest-checklist-csv-to-catalog.cjs"), "utf8");
  const m = src.match(/const CARD_LINE_PARALLEL[\s\S]*?\nfunction isCardLineParallel[\s\S]*?\n\}/);
  if (!m) throw new Error("isCardLineParallel not found in ingest-checklist-csv-to-catalog.cjs");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return isCardLineParallel;`)() as (s: string) => boolean;
}

// A card line, in every spelling the pages and the pool actually produce.
const CARD_LINES = [
  "100 Mike Trout",              // bare number (the ONLY shape the old gate caught)
  "BD 154 Adley Rutschman",      // space-separated -- prod's shape
  "BD-154 Adley Rutschman",      // hyphenated
  "Bd 152 Bobby Witt, Jr.",      // mixed case, honorific
  "BDC-1 Eli Willits",           // 2025 chrome numbering
  "US150 Juan Soto",             // no separator
];

// Real parallel / insert names. Blocking any of these is the guard eating
// good data -- the "right guard, wrong scope" failure this repo keeps hitting.
const REAL_PARALLELS = [
  "1st Edition Blue",
  "Gold Refractor",
  "Sky Blue Refractor",
  "Padparadscha",
  "20 in '20",        // a 2020 Bowman Draft INSERT that starts with digits
  "1990 Bowman",      // a 2020 Bowman insert that starts with a year
  "3 Color Patch",    // bare number + finish vocabulary
  "2 Color Patch",
  "5 Tool",
  "1 of 1",
  "Base",
  "Chrome",
  "Refractor",
  "Blue",
  "Printing Plates",
];

describe("the converter's card-line guard", () => {
  it.each(CARD_LINES)("rejects the card line %j", (line) => {
    expect(L.isCardLine(line)).toBe(true);
  });

  it.each(REAL_PARALLELS)("admits the real parallel %j", (name) => {
    expect(L.isCardLine(name)).toBe(false);
  });
});

describe("the ingest gate (defence in depth, after the converter)", () => {
  const isCardLineParallel = loadIngestGate();

  it.each(CARD_LINES)("blocks the card line %j", (line) => {
    expect(isCardLineParallel(line)).toBe(true);
  });

  it.each(REAL_PARALLELS)("writes the real parallel %j", (name) => {
    expect(isCardLineParallel(name)).toBe(false);
  });
});

describe("Chrome Gimmicks contributes ZERO parallel rows", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "fixtures/bcp/2020-bowman-draft.trimmed.html"), "utf8");
  const par = L.section(html, "Parallels", 2);
  const scopes = L.parseScopedLadders(par, { html, setName: "Bowman Draft", setKey: "bowman-draft", qualify });

  it("is a nested h4, so it never reaches the Chrome ladder at all", () => {
    // On the 2020 page Chrome_Gimmicks is an h4 INSIDE the Chrome h3. A
    // scope's rungs stop at its first nested subsection, so the 15 card
    // lines are excluded structurally -- before any name-level guard runs.
    expect(scopes.map((s: any) => s.title)).toEqual([null, "Chrome", "1st Edition", "Sapphire Edition"]);
    const chrome = scopes.find((s: any) => s.title === "Chrome");
    expect(chrome.rungs).toHaveLength(11);
    expect(chrome.rungs.map((r: any) => r.name).join(" | ")).not.toMatch(/Hancock|Hassell|Detmers/i);
  });

  it("the card-list guard catches the shape when it IS a scope of its own", () => {
    // The same list, promoted to an h3 (the shape other years use): it must
    // be recognised as a CARD LIST and contribute zero rungs.
    const lis = [
      "<li>BD-12 Emerson Hancock</li>", "<li>BD-34 Austin Hendrick</li>",
      "<li>BD-39 Robert Hassell</li>", "<li>BD-41 Reid Detmers</li>",
      "<li>BD-152 Bobby Witt, Jr.</li>",
    ].join("");
    const synthetic = `<h2 id="Parallels"><h3 id="Chrome_Gimmicks"><ul>${lis}</ul>`;
    const s = L.parseScopedLadders(synthetic, {
      html: synthetic, setName: "Bowman Draft", setKey: "bowman-draft", qualify,
    }).find((x: any) => x.title === "Chrome Gimmicks");
    expect(s.cardList).toBe(true);
    expect(s.rungs).toHaveLength(0);
    expect(s.cards).toHaveLength(5);
  });

  it("no scope emits a parallel that is really a card", () => {
    for (const s of scopes) {
      for (const r of s.rungs) {
        expect(L.isCardLine(r.name), `"${r.name}" in scope ${s.title}`).toBe(false);
      }
    }
  });

  it("specifically, Bobby Witt never appears as a PARALLEL of anything", () => {
    const all = scopes.flatMap((s: any) => s.rungs.map((r: any) => r.name)).join(" | ");
    expect(all).not.toMatch(/Bobby Witt/i);
    expect(all).not.toMatch(/Adley Rutschman/i);
    expect(all).not.toMatch(/Spencer Torkelson/i);
  });
});

describe("a scope heading never ships as a parallel row", () => {
  const FIXTURES = ["2020-bowman-draft", "2025-bowman-draft", "2020-bowman"] as const;
  const UMBRELLAS = /^(chrome|chrome gimmicks|1st edition|sapphire edition|chrome prospects|1st edition prospects)$/i;

  it.each(FIXTURES)("%s emits no umbrella heading as a rung", (name) => {
    const html = fs.readFileSync(path.resolve(__dirname, `fixtures/bcp/${name}.trimmed.html`), "utf8");
    const par = L.section(html, "Parallels", 2);
    const setKey = name.includes("draft") ? "bowman-draft" : "bowman";
    const setName = name.includes("draft") ? "Bowman Draft" : "Bowman";
    const scopes = L.parseScopedLadders(par, { html, setName, setKey, qualify });
    for (const s of scopes) {
      for (const r of s.rungs) {
        expect(UMBRELLAS.test(r.name.trim()), `"${r.name}" in ${name}`).toBe(false);
      }
    }
  });
});
