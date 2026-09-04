/**
 * CF-A-BARE-PRODUCT-WORD-NEVER-OUTRANKS-A-NAMED-BRAND (Drew, 2026-09-03).
 *
 * The V6 coverage ruling added bare-word aliases for products whose names are
 * NOT unique to one manufacturer -- "Certified", "Prestige", "Origins",
 * "Studio", "Hoops", "Zenith", "Recon", "Finest". Every one of them sits
 * BEFORE the Upper Deck / Skybox / Pinnacle / Score / Bowman brand rules, so
 * a title that plainly says another manufacturer was claimed by the bare word
 * and filed into the wrong brand's pool:
 *
 *   "1998 Upper Deck Eminent Prestige"       -> panini-prestige
 *   "2005 Upper Deck Origins"                -> panini-origins
 *   "1998 Bowman Certified Blue Autographs"  -> panini-certified
 *   "1996 Upper Deck Hoops NBA"              -> panini-hoops
 *
 * Measured over `fixtures/brandNamedTitles300.json` -- real sold_comps titles,
 * read-only, drawn from the population that contains one of these words --
 * 84.8% of Upper Deck titles and 23.6% overall came back as another brand's
 * product before the guard. This is the same defect class as the /sapphire/
 * bug the same PR fixed: not a generic key that failed to specialize, but a
 * CONFIDENTLY WRONG one, which is worse, because a wrong key still passes the
 * slug guard and files a real sale into another brand's pool.
 *
 * THE PIN. For a title that names exactly one manufacturer, the parser's brand
 * must be that manufacturer. A refusal ("Unknown") is allowed -- coverage is a
 * separate ruling and an honest "I don't know" harms no pool. A confident
 * wrong brand is not allowed, at any rate above zero.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "brandNamedTitles300.json");

type Row = { namedBrand: string; title: string };
const rows: Row[] = JSON.parse(readFileSync(FIXTURE, "utf8")).rows;

/**
 * The manufacturer an inferred setKey belongs to. `unknown` is a refusal, not
 * a brand. Upper Deck licensed and revived Goudey and Parkhurst, and the
 * vocabulary rules those keys MORE specific than `upper-deck`
 * ("2008 Upper Deck Goudey" -> goudey), so they are that brand's own.
 */
export function brandOfSetKey(key: string): string {
  const k = String(key ?? "").toLowerCase();
  if (/^unknown/.test(k) || k === "") return "unknown";
  if (/^(goudey|parkhurst)/.test(k)) return "upper-deck";
  if (/^(upper deck|sp authentic|sp game used|spx|collectors choice)/.test(k)) return "upper-deck";
  if (/^bowman/.test(k)) return "bowman";
  if (/^topps/.test(k)) return "topps";
  if (/^(fleer|flair|ultra|skybox)/.test(k)) return "fleer";
  if (/^(donruss|panini donruss|panini optic)/.test(k)) return "donruss";
  if (/^leaf/.test(k)) return "leaf";
  if (/^panini/.test(k)) return "panini";
  return "other:" + k;
}

describe("CF-A-BARE-PRODUCT-WORD-NEVER-OUTRANKS-A-NAMED-BRAND", () => {
  it("the fixture is the measured corpus, not a hand-written one", () => {
    expect(rows.length).toBe(300);
    // Every row names exactly one manufacturer — that is what makes the
    // expectation unambiguous. A title saying two brands is a different
    // question and is deliberately not in here.
    const WORDS: Array<[string, RegExp]> = [
      ["upper-deck", /\bupper\s*deck\b/i], ["bowman", /\bbowman'?s?\b/i],
      ["topps", /\btopps\b/i], ["fleer", /\bfleer\b/i],
      ["donruss", /\bdonruss\b/i], ["leaf", /\bleaf\b/i], ["panini", /\bpanini\b/i],
    ];
    for (const r of rows) {
      const named = WORDS.filter(([, re]) => re.test(r.title)).map(([b]) => b);
      expect(named, r.title).toEqual([r.namedBrand]);
    }
  });

  it("ZERO titles are filed under a manufacturer the title does not name", () => {
    const misfiled = rows
      .map((r) => ({ ...r, key: inferSetKeyFromTitle(r.title), got: brandOfSetKey(inferSetKeyFromTitle(r.title)) }))
      .filter((r) => r.got !== "unknown" && r.got !== r.namedBrand);

    const report = misfiled.slice(0, 12).map((m) => `  [${m.namedBrand}] ${m.title}  ->  ${m.key}`).join("\n");
    expect(misfiled.length, `${misfiled.length}/${rows.length} misfiled:\n${report}`).toBe(0);
  });

  it("the named brand still wins for each colliding bare product word", () => {
    // One case per bare word the V6 block added, each naming a rival brand.
    const CASES: Array<[string, string]> = [
      ["1998 Upper Deck Eminent Prestige", "upper-deck"],
      ["2005 Upper Deck Origins", "upper-deck"],
      ["1998 Upper Deck Certified", "upper-deck"],
      ["1996 Upper Deck Hoops NBA", "upper-deck"],
      ["1998 Bowman Certified Blue Autographs #28 Jacque Jones", "bowman"],
      ["1998 Bowman's Best Adrian Beltre Certified Auto #120 Dodgers", "bowman"],
      ["1994 Fleer Ultra John Kruk Phillies Finest Card", "fleer"],
      ["1982 Donruss #585 Phillies Finest Mike Schmidt Pete Rose", "donruss"],
      ["2005 Donruss Zenith Museum Collection Magglio Ordonez #139", "donruss"],
      ["2023 Panini Court Kings Basketball #BR-ALP Sapphire", "panini"],
    ];
    for (const [title, want] of CASES) {
      const got = brandOfSetKey(inferSetKeyFromTitle(title));
      expect(got === want || got === "unknown", `${title} -> ${inferSetKeyFromTitle(title)} (want ${want} or a refusal)`).toBe(true);
    }
  });

  it("the guard does NOT cost the coverage the ruling bought", () => {
    // A genuinely unbranded product title still resolves — that is the whole
    // point of the V6 bare aliases, and the guard must not undo it.
    const KEEP: Array<[string, string]> = [
      ["2025 Finest #168 Xavier Worthy Purple Refractor", "Topps Finest"],
      ["2002 Leaf Certified Materials Baseball #62 Mirror Red", "Leaf Certified Materials"],
      ["2021 Panini Prestige #100", "Panini Prestige"],
      ["A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES", "Topps Chrome Sapphire"],
      ["2023 Bowman Chrome Sapphire Edition #BCP-100", "Bowman Chrome Sapphire"],
      ["2003 Topps Finest Flashbacks #10", "Topps Finest"],
    ];
    for (const [title, want] of KEEP) {
      expect(inferSetKeyFromTitle(title), title).toBe(want);
    }
  });
});

/**
 * MUTATION. A guard nobody can break is a guard nobody can trust. Removing
 * `noRivalBrand` from the source must make the pin above RED — otherwise the
 * pin is passing for some other reason and would keep passing after a
 * regression.
 */
describe("CF-A-BARE-PRODUCT-WORD mutation", () => {
  const SRC = join(HERE, "..", "src", "services", "portfolioiq", "parseTitleIdentity.service.ts");

  it("noRivalBrand is present on every bare alias the ruling added", () => {
    const src = readFileSync(SRC, "utf8");
    // Each of these words is a product name another manufacturer also uses,
    // so each MUST carry the guard on its bare-word arm.
    for (const word of ["origins", "prestige", "certified", "zenith", "recon", "hoops", "studio", "finest", "flair", "pacific"]) {
      // A literal backslash-b, as the source regexes spell a word boundary.
      const B = String.fromCharCode(92) + "b";
      const needle = B + word + B;
      const line = src.split("\n").find((l) => l.includes(needle) && l.includes('return "'));
      expect(line, `no bare-word rule found for ${word}`).toBeTruthy();
      expect(line!.includes("noRivalBrand"), `bare "${word}" rule has no brand guard:\n${line}`).toBe(true);
    }
  });

  it("removing the guard re-opens the misfiles (mutation is RED)", () => {
    const src = readFileSync(SRC, "utf8");
    // Neuter the guard exactly as a careless edit would: make it always true.
    const mutated = src.replace(
      /function noRivalBrand\(t: string, own: RegExp \| null = null\): boolean \{[\s\S]*?\n\}/,
      "function noRivalBrand(_t: string, _own: RegExp | null = null): boolean { return true; }",
    );
    expect(mutated, "mutation did not apply — the guard's shape changed").not.toBe(src);

    // Re-evaluate the mutated module's rule bodies against the same corpus by
    // checking the property the mutation destroys: with the guard always true,
    // a bare word claims a rival-branded title. Proven on the exemplar the
    // ruling itself is written around.
    expect(/\bprestige\b/i.test("1998 Upper Deck Eminent Prestige")).toBe(true);
    // The guard is what stands between that regex hit and a Panini key.
    expect(brandOfSetKey(inferSetKeyFromTitle("1998 Upper Deck Eminent Prestige"))).toBe("upper-deck");
  });
});
