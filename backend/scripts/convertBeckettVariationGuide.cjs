#!/usr/bin/env node
/**
 * CF-BECKETT-VARIATION-CONVERTER (Drew, 2026-09-01).
 *
 * Turns one Beckett variations guide into the canonical checklist CSV. The
 * guide's gallery block names both photos per card:
 *
 *     1 Shohei Ohtani, Los Angeles Angels
 *     Variation - carrying bag
 *     Base - batting
 *
 * and that descriptor is the card's identity. Drew, 2026-09-01: "Carrying Bag
 * Image Variation SP so those match in searches. so they can find variation, sp
 * and the name" — one stored string carrying all three searchable parts, with
 * card details leading on the name (canonicalCardName appends the parallel, so
 * no display code is needed).
 *
 * WHAT THIS REFUSES TO GUESS, because a wrong checklist is worse than none:
 *   - Autograph versions. 2018 Bowman Chrome has 13 autos across 15 variations
 *     (Nick Williams and Alex Verdugo have none), stated in prose, not in the
 *     gallery. Unless --autos names them, only the base variation is emitted.
 *   - Print runs. A guide states pack odds (1:133), which is NOT a print run.
 *   - The setKey. Passed in, never inferred from the article slug.
 *
 * Usage:
 *   node backend/scripts/convertBeckettVariationGuide.cjs \
 *     --url=https://www.beckett.com/news/<guide>/ \
 *     --set-key=bowman-chrome --year=2018 --sport=baseball \
 *     [--set-name="2018 Bowman Chrome"] [--autos=all|none|"Player A;Player B"] \
 *     [--out=backend/data/checklists/scraped/<name>.csv] [--print]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL_ = arg("url", "");
const SET_KEY = arg("set-key", "");
const YEAR = Number(arg("year", "0"));
const SPORT = arg("sport", "baseball");
const SET_NAME = arg("set-name", "");
const AUTOS = arg("autos", "none");
const PRINT_ONLY = process.argv.includes("--print");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const get = (url) => execFileSync("curl", ["-sL", "--max-time", "45", "-A", UA,
  "-H", "Accept: text/html,application/xhtml+xml", "-H", "Accept-Language: en-US,en;q=0.9", url],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Title case that does not capitalise the letter after an apostrophe —
 *  "catcher's gear" is Catcher's Gear, never Catcher'S Gear. */
const titleCase = (s) => String(s).trim().toLowerCase()
  .replace(/\s+/g, " ")
  .replace(/(^|[\s\-/])(\w)/g, (_, pre, ch) => pre + ch.toUpperCase());

/** The card's NAME, from Beckett's photo description.
 *
 *  A description is written to help you spot the card, so it sometimes carries
 *  a second clause: "gray jersey, wearing cap", "with ball, gray sleeves". The
 *  first clause is the distinguishing trait and the rest is corroboration, so
 *  the name is the first clause — a shorter, stabler label that still reads as
 *  the card ("Gray Jersey", "With Ball"). The full description is kept in the
 *  manifest so nothing is lost.
 *
 *  Leading filler ("wearing white shirt") is dropped for the same reason:
 *  White Shirt is the name; "wearing" is grammar. */
const photoName = (photo) => {
  let s = String(photo).split(",")[0].trim();
  s = s.replace(/^(?:wearing|with an?|holding)\s+/i, "").trim();
  return titleCase(s);
};

function parseGuide(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const lines = body.replace(/<[^>]+>/g, "\n")
    .replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&amp;/g, "&")
    .split("\n").map((s) => s.trim()).filter(Boolean);

  // Anchor past the site nav. Older guides have a "Variations Gallery"
  // heading; newer ones only have a "... Variations Checklist" heading. With
  // no anchor at all the nav menu ("2018 Baseball Cards & Checklists") matches
  // the card-row pattern and the parse returns junk, so require one.
  const anchorRe = /Variations?\s+(Gallery|Checklist)|Variations? Codes/i;
  const gi = lines.findIndex((s, i) => i > 60 && anchorRe.test(s));
  const scope = gi >= 0 ? lines.slice(gi + 1) : lines;

  const cards = [];
  for (let i = 0; i < scope.length; i++) {
    // "1 Shohei Ohtani, Los Angeles Angels"
    const m = /^([A-Za-z0-9-]{1,10})\s+([A-Za-z.'\-À-ɏ ]+?),\s+(.+)$/.exec(scope[i]);
    if (!m) continue;
    const [, num, player] = m;
    const next = scope[i + 1] || "";
    const vm = /^Variation\s*-\s*(.+)$/i.exec(next);
    if (!vm) continue;
    const photo = vm[1].trim().replace(/\.$/, "");
    if (!photo || photo.length > 60) continue;
    cards.push({ cardNumber: num, player: player.trim(), photo });
  }
  // SECOND GALLERY SHAPE (2021-2026). Newer guides drop the photo descriptor
  // and publish a checklist of tiers instead:
  //
  //     1 Adley Rutschman
  //     - SP | SSP
  //     3 Bryce Harper
  //     - SP
  //
  // Drew, 2026-09-01: where Beckett gives no name, use the TIER alone — blank
  // means unknown, never invented (a photo-derived name would not trace to a
  // publisher). And SP and SSP are SEPARATE CARDS: the SSP is a different pull
  // rate (1:16,938 vs 1:1,000-ish) and trades differently, which is the same
  // reason a variation is not its base card.
  if (!cards.length) {
    for (let i = 0; i < scope.length; i++) {
      const m = /^(\d{1,4})\s+([A-Za-z.'\-À-ɏ ]{3,40})$/.exec(scope[i]);
      if (!m) continue;
      const tierLine = scope[i + 1] || "";
      const tm = /^-\s*(SP(?:\s*\|\s*SSP)?|SSP)\s*$/i.exec(tierLine);
      if (!tm) continue;
      const tiers = /ssp/i.test(tm[1]) && /\|/.test(tm[1]) ? ["SP", "SSP"]
        : /^ssp$/i.test(tm[1].trim()) ? ["SSP"] : ["SP"];
      for (const tier of tiers) cards.push({ cardNumber: m[1], player: m[2].trim(), photo: null, tier });
    }
  }

  // THIRD GALLERY SHAPE (2025-2026). The number moves onto its own line and
  // the tier list names variation TYPES rather than rarity alone:
  //
  //     1
  //     Shohei Ohtani, Los Angeles Dodgers
  //     - Image | SSP | Award
  //
  // "Image" and "SSP" are the two rarity tiers of the image variation, and
  // "Award" is a DIFFERENT variation (Award Winners) that happens to share the
  // card number — so each type earns its own row, by the same rule that makes
  // SP and SSP separate cards.
  if (!cards.length) {
    for (let i = 0; i < scope.length - 2; i++) {
      if (!/^\d{1,4}$/.test(scope[i])) continue;
      const pm = /^([A-Za-z.'\-À-ɏ ]{3,40}?)(?:,\s*.+)?$/.exec(scope[i + 1]);
      if (!pm) continue;
      const tm = /^-\s*((?:Image|SSP|Award|SP)(?:\s*\|\s*(?:Image|SSP|Award|SP))*)\s*$/i.exec(scope[i + 2]);
      if (!tm) continue;
      const player = pm[1].replace(/\s+(RC|SP)$/i, "").trim();
      for (const raw of tm[1].split("|").map((s) => s.trim())) {
        // "Image" is the plain image variation; its label is the tier the
        // guide uses everywhere else, so it reads as "Image Variation SP".
        const tier = /^image$/i.test(raw) ? "SP" : raw.toUpperCase();
        const kind = /^award$/i.test(raw) ? "Award Winners" : null;
        cards.push({ cardNumber: scope[i], player, photo: null, tier, kind });
      }
    }
  }

  // FOURTH GALLERY SHAPE. A guide for ONE named variation family lists its
  // cards flat under a heading naming the family:
  //
  //     Facsimile Signature
  //     BD-1 Royce Lewis
  //     BD-25 MacKenzie Gore
  //
  // The heading IS the card's name, so these are "Facsimile Signature SP" —
  // not image variations, which they are not. Card numbers here are the
  // product's own (BD-1), so the pattern must accept an alpha prefix.
  if (!cards.length) {
    const FAMILY_RE = /^(Facsimile Signature|Photo Variation|Image Variation|Nickname|Throwback|Sepia|Negative)s?$/i;
    let family = null;
    for (const line of scope) {
      const fm = FAMILY_RE.exec(line);
      if (fm) { family = titleCase(fm[1]); continue; }
      if (!family) continue;
      const m = /^([A-Z]{1,6}-?\d{1,4}[A-Z]?)\s+([A-Za-z.'\-À-ɏ ]{3,40})$/.exec(line);
      if (!m) {
        // A long prose line ends the flat list; a short unmatched line is
        // tolerated (captions, blanks) so one stray does not truncate a set.
        if (line.length > 80) family = null;
        continue;
      }
      cards.push({ cardNumber: m[1], player: m[2].trim(), photo: null, tier: "SP", kind: family });
    }
  }

  // FIFTH GALLERY SHAPE. A flat list of "<number> <player>, <team>" with a
  // lone "*" on the following line marking the cards that ALSO have an
  // autograph version, explained by a footnote:
  //
  //     BDC-1 Eli Willits, Washington Nationals
  //     *
  //     BDC-4 Gage Wood, Philadelphia Phillies
  //     *Also have Image Variation Autographs
  //
  // This is the one shape that STATES its autos, so they are emitted here
  // rather than left to --autos. Everywhere else the autos live in prose and
  // are not guessed at.
  if (!cards.length) {
    const starMeansAuto = scope.some((l) => /^\*\s*Also have .*Autograph/i.test(l));
    for (let i = 0; i < scope.length; i++) {
      const m = /^([A-Z]{1,6}-\d{1,4}[A-Z]?)\s+([A-Za-z.'\-À-ɏ ]{3,40}?),\s*.+$/.exec(scope[i]);
      if (!m) continue;
      const alsoAuto = starMeansAuto && /^\*$/.test(scope[i + 1] || "");
      cards.push({ cardNumber: m[1], player: m[2].trim(), photo: null, tier: "SP", alsoAuto });
    }
  }

  // CMP code, when the guide states one — the definitive back-of-card check.
  const cmp = {};
  for (const l of lines) {
    const c = /^(Base|Rookie Variations?|Variations?)\s*-\s*(\d{3})$/i.exec(l);
    if (c) cmp[c[1].toLowerCase()] = c[2];
  }
  const odds = (lines.find((l) => /1:\d[\d,]*\s*(hobby\s*)?packs/i.test(l)) || "").slice(0, 200) || null;
  // A guide often prints its checklist AND a gallery of the same cards, so the
  // flat shapes see each card twice. One card, one row — dedupe on the identity
  // the row will carry, keeping the first (checklist) occurrence and any auto
  // flag either copy asserted.
  const seen = new Map();
  for (const c of cards) {
    const key = `${String(c.cardNumber).toUpperCase()}|${c.player.toLowerCase()}|${c.tier || ""}|${c.kind || ""}|${c.photo || ""}`;
    if (!seen.has(key)) seen.set(key, c);
    else if (c.alsoAuto) seen.get(key).alsoAuto = true;
  }
  return { cards: [...seen.values()], cmp, odds };
}

function main() {
  if (!URL_ || !SET_KEY || !YEAR) {
    console.error("FATAL: --url, --set-key and --year are required.");
    process.exit(2);
  }
  const html = get(URL_);
  const { cards, cmp, odds } = parseGuide(html);
  const pageTitle = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  console.log(`▸ ${URL_}`);
  console.log(`  ${html.length} bytes — "${pageTitle.slice(0, 80)}"`);
  console.log(`  parsed ${cards.length} variations`);
  if (!cards.length) { console.error("  no variations parsed — refusing to write an empty checklist."); process.exit(3); }

  let autoPlayers = null;
  if (AUTOS === "all") autoPlayers = new Set(cards.map((c) => c.player));
  else if (AUTOS !== "none") autoPlayers = new Set(AUTOS.split(";").map((s) => s.trim()).filter(Boolean));

  const out = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const c of cards) {
    // A named photo leads; where the guide gave none, the tier stands alone.
    // `kind` names a DIFFERENT variation family (Award Winners), which must
    // not be labelled an image variation just because it shares the number.
    const tier = c.tier || "SP";
    const family = c.kind || "Image Variation";
    const parallel = c.photo
      ? `${photoName(c.photo)} ${family} ${tier}`
      : (c.kind ? `${family} SP` : `${family} ${tier}`);
    out.push(`insert-rookie-image-variations,${c.cardNumber},${parallel},false,,${c.player}`);
    // A guide that STATES its autos (the "*" shape) carries them per card.
    if (c.alsoAuto) {
      out.push(`auto-rookie-image-variations,${c.cardNumber},${parallel},true,,${c.player}`);
    } else if (autoPlayers && autoPlayers.has(c.player)) {
      out.push(`auto-rookie-image-variations,${c.cardNumber},${parallel},true,,${c.player}`);
    }
  }

  for (const c of cards) {
    const fam = c.kind || "Image Variation";
    const label = c.photo ? `${photoName(c.photo)} ${fam} ${c.tier || "SP"}` : (c.kind ? `${fam} SP` : `${fam} ${c.tier || "SP"}`);
    console.log(`   #${String(c.cardNumber).padEnd(5)} ${c.player.padEnd(22)} ${label}${c.photo ? `   [${c.photo}]` : ""}`);
  }
  if (Object.keys(cmp).length) console.log(`  CMP codes: ${JSON.stringify(cmp)}`);
  if (odds) console.log(`  odds: ${odds}`);

  if (PRINT_ONLY) { console.log(`\n(--print; ${out.length - 1} rows not written)`); return; }

  const slug = URL_.replace(/\/$/, "").split("/").pop();
  const dest = arg("out", path.join("backend/data/checklists/scraped", `beckett-${slug}.csv`));
  fs.writeFileSync(dest, out.join("\n") + "\n");
  fs.writeFileSync(dest.replace(/\.csv$/, ".manifest.json"), JSON.stringify({
    scrapedAt: new Date().toISOString(),
    sourceUrl: URL_, source: "beckett", sport: SPORT, year: YEAR,
    setName: SET_NAME || `${YEAR} ${titleCase(SET_KEY.replace(/-/g, " "))}`,
    productKey: slug, setKey: SET_KEY,
    rowCount: out.length - 1,
    photoDescriptions: Object.fromEntries(cards.filter((c) => c.photo).map((c) => [`${c.cardNumber} ${c.player}`, c.photo])),
    parallelColumnAuthoritative: true,
    cmpCodes: Object.keys(cmp).length ? cmp : undefined,
    packOdds: odds || undefined,
    note: "Rookie Image Variations. Parallel is '<Photo> Image Variation SP' so the name, 'variation' and 'SP' are all searchable; card details leads with the name. Autos emitted only where --autos named them; a guide states them in prose, not in the gallery.",
  }, null, 2) + "\n");
  console.log(`\n  wrote ${dest} (${out.length - 1} rows)`);
}
main();
