#!/usr/bin/env node
// CF-HOBBYMONITOR-CHECKLIST (Drew, 2026-08-15, sharing
// hobbymonitor.com/release/2026-donruss-baseball-checklist).
//
// FOURTH checklist source, and the one that covers what the other three do
// not. Beckett publishes Topps/Bowman XLSX and almost no Panini;
// cardboardchecklist holds 3 Panini checklists in total. Hobby Monitor's
// release index carries 112 releases — 68 Topps, 29 PANINI — including
// 2026 Panini Prizm Baseball, 2026 Panini Immaculate Baseball, 2026 Panini
// Donruss Football, 2025-26 Panini Prizm Basketball and Panini Origins.
//
// NO API KEY NEEDED. api.hobbymonitor.com/v3 answers 401, but the release
// page server-renders the whole checklist into the HTML, so this parses the
// page rather than calling the API.
//
// Page shape — two independent arrays:
//   teamChecklists[] one object per CARD
//       {cardNumber, players[], cardSet, cardType, rookie, team, ...}
//   cardParallels[]  one entry per SUBSET, listing that subset's parallels
//       {cardSet, cardType, parallels:[{name, printRun, isOneOfOne, odds}]}
//
// THE LADDER LANDS ON ITS OWN SUBSET'S CARDS (CF-HM-LADDER-INTO-ROWS,
// 2026-08-30). This used to emit one row per card and park the ladder in a
// sidecar, so every print run in the release was lost: hobbymonitor puts
// numberDenominator on ZERO card objects and states the run once per subset,
// on the ladder. 2026 Bowman ingested that way gives 1,165 rows with an empty
// printRun column — CPA-JG's Refractor is /499 on the page and null in the
// catalog.
//
// This is NOT the cross-product rejected on 2026-08-11. A subset's ladder is
// applied to THAT SUBSET'S OWN CARDS ONLY — the same shape
// convertChecklistCenterToChecklistCsv already uses (its convertHtml emits a
// base row per card, then one row per rung of that card's own subset). The
// rejected shape multiplied one product-wide parallel list across every card
// in the release; this joins on (cardSet, cardType), which is how the source
// itself scopes a ladder.
//
// TWO GUARDS, because a ladder is only as good as what is in it:
//   * REAL RUNGS ONLY. 53 of 2026 Bowman's 218 "parallels" are PLAYER NAMES
//     misfiled into the parallels[] of five hit subsets ({name:"Ethan
//     Holliday", printRun:null, odds:null}). A rung is real only when the
//     source gives it a printRun, isOneOfOne or odds; anything else that also
//     matches this product's own roster is dropped as a misfiled name. That is
//     the exploded-spine shape (11.49M cards x players rows) caught early.
//   * PER-SUBSET CEILINGS. Same gate as the CLC converter: a subset whose
//     ladder exceeds PAR_MAX rungs, or whose card list exceeds NUM_MAX
//     numbers, is what a roster-read-as-a-ladder looks like — refuse that
//     subset, keep the rest, and say so.
//
// Emits the canonical CSV contract, with the 7th column the CLC converter
// added for a rung's odds/footnote:
//     category,cardNumber,parallel,isAuto,printRun,player,parallelNote
//
// The manifest sets parallelColumnAuthoritative:true, so ingest-scraped-
// checklist reads the rung out of the parallel column instead of re-deriving
// a label from the category slug. Without that flag the legacy branch turns
// "insert-base-cards" into the parallel "Base Cards" — the anchor's own name
// baked into the rung, on the 100 BASE cards of the set.
//
//   node scripts/fetchHobbyMonitorChecklist.cjs \
//     --url https://www.hobbymonitor.com/release/2026-donruss-baseball-checklist \
//     --out data/checklists/scraped/2026-panini-donruss-baseball.csv
//   node scripts/fetchHobbyMonitorChecklist.cjs --list

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const UA = "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0)";

/**
 * Politeness. One release page is one request, and the driver walks the lane
 * back-to-back: 92 products in run 33839296630 went out as fast as the pipe
 * allowed. HM_FETCH_DELAY_MS (default 1000) puts a floor between requests so a
 * long lane paces itself; the runner can raise it without a code change if the
 * host ever asks us to slow down.
 */
const FETCH_DELAY_MS = Math.max(0, Number(process.env.HM_FETCH_DELAY_MS || 1000));
let lastFetchAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function paced() {
  const wait = lastFetchAt + FETCH_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

/**
 * Pull every JSON object in `html` that carries `marker`, by walking balanced
 * braces outward from each hit. The page is a Next.js payload with the data
 * inlined as escaped strings, so a regex cannot bound an object reliably.
 */
function extractObjects(html, marker) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf(marker, i)) !== -1) {
    let start = i, depth = 0;
    for (let j = i; j >= 0; j--) {
      const c = html[j];
      if (c === "}") depth++;
      else if (c === "{") { if (depth === 0) { start = j; break; } depth--; }
    }
    let d = 0, end = start;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (c === "{") d++;
      else if (c === "}") { d--; if (d === 0) { end = j; break; } }
    }
    try { out.push(JSON.parse(html.slice(start, end + 1))); } catch { /* not JSON — skip */ }
    i = end > i ? end : i + marker.length;
  }
  return out;
}

/** Balanced-scan the array value that follows `"key":`. */
function extractArray(html, key) {
  const k = html.indexOf(`"${key}"`);
  if (k === -1) return [];
  const s = html.indexOf("[", k);
  if (s === -1) return [];
  let d = 0, e = s;
  for (let j = s; j < html.length; j++) {
    const c = html[j];
    if (c === "[") d++;
    else if (c === "]") { d--; if (d === 0) { e = j; break; } }
  }
  try { return JSON.parse(html.slice(s, e + 1)); } catch { return []; }
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A subset is an autograph set when the source says so, either on cardType or
// in the subset name. Relic/Insert stay false — isAuto is about signatures.
//
// "Autograph Relic" is a cardType hobbymonitor uses in its own right (188 cards
// on 2026 Topps Series 1: City Connect Autograph Relic, Heavy Lumber Autograph
// Relic, Topps Flagship Autograph Patch). It matches /autograph/ and IS signed,
// which is right — the relic half of that name is carried by cardTypeOf()
// below, not by this flag.
const isAutoOf = (c) =>
  /autograph/i.test(String(c.cardType ?? "")) ||
  /\b(auto|autograph|signature)/i.test(String(c.cardSet ?? ""));

// CF-HM-CARD-TYPE-IS-THE-SOURCE-SPEAKING (2026-09-04).
//
// hobbymonitor types every card object. Across the four richest releases the
// vocabulary is exactly six values:
//
//     Insert 2199 | Base 1792 | Autograph 1280 | Variation 1083
//     Relic 478   | Autograph Relic 188
//
// The emitter read only isAutoOf, so Relic and Variation — 1,749 of those 7,020
// cards — were flattened into `insert-<slug>` with nothing left saying what
// they are. A Gold Logoman Relic and a Diamond Moments insert came out of this
// file as the same kind of thing.
//
// The type is normalised here and carried in the CSV's 9th column. The
// checklist CSV contract reads its header BY NAME and ignores a column it does
// not know, so this is additive: today's ingester sees the same eight columns
// it always did, and the memorabilia signal is in the file for the day
// ingest-scraped-checklist passes subsetName through. Nothing is invented —
// every value is the source's own cardType, folded to a slug.
const cardTypeOf = (c) => {
  const t = String(c.cardType ?? "").trim().toLowerCase();
  if (!t) return "";
  if (/autograph/.test(t) && /relic|patch|memorabilia/.test(t)) return "autograph-relic";
  if (/relic|patch|memorabilia/.test(t)) return "relic";
  if (/variation/.test(t)) return "variation";
  if (/autograph/.test(t)) return "autograph";
  if (/insert/.test(t)) return "insert";
  if (/^base$/.test(t)) return "base";
  return slug(t);
};

// CF-HM-A-VARIATION-IS-A-RUNG (2026-09-04) — the same ruling
// CF-CHECKLIST-VARIATION-IS-A-PARALLEL made for the Beckett converter, now for
// this lane. A variation is a FINISH ON A CARD THAT ALREADY EXISTS, not a card
// standing beside it. 2026 Topps Series 1 lists Jacob Misiorowski at #10 nine
// times — Base, plus Golden Mirror Image, Vintage Stock, Clear, Holiday, Team
// Color Border, True Photo, Player Number and 1952 Rookie. Emitting those as
// eight `insert-*` subsets mints eight cards where the hobby trades ONE card in
// eight finishes: a split pool, and a wrong FMV on every one of them.
//
// THE DISCRIMINATOR IS THE SOURCE, NEVER THE NUMBERS ALONE. Card-number overlap
// on its own is not sufficient here and would be actively wrong: "Real One
// Relic" (76 cards) and "Flagship Real One Autograph" (44) also sit entirely
// inside the base numbering run on that same page, and both are their own
// cards. So a subset may fold only when hobbymonitor ITSELF says it is a
// variation, in either of the two shapes the source uses —
//
//   * cardType === "Variation"        2026 Topps Series 1
//   * cardType "Base" + a cardSet naming a variation or short print
//                                     2026 Topps Chrome "Base - Image
//                                     Variations", 2026 Bowman "Base Rookie
//                                     Red RC Logo Variation"
//
// — and only then, having said so, must its numbers ALSO all land inside one
// anchor. Both tests, never either.
const VARIATION_NAME = /\b(variations?|short\s*prints?|ssps?)\b/i;

/** An anchor is a plain base run — the card a variation is a variation OF. A
 *  release can have several: 2026 Topps Series 1 numbers Team Card, League
 *  Leaders, Combo Card and Future Stars on their own runs, and each has its own
 *  Golden Mirror Image that must fold onto ITS run and no other. */
const isAnchorSubset = (type, set) =>
  cardTypeOf({ cardType: type }) === "base" && !VARIATION_NAME.test(String(set ?? ""));

/** A subset the source has declared a variation, by type or by name. */
const isVariationSubset = (type, set) => {
  const t = cardTypeOf({ cardType: type });
  if (t === "variation") return true;
  return t === "base" && VARIATION_NAME.test(String(set ?? ""));
};

/**
 * The rung a variation subset names, relative to its anchor: the words it ADDS.
 * "Base - Image Variations" against "Base Cards" is "Image Variation"; a bare
 * "Vintage Stock" against "Base" shares no word and is already the rung.
 *
 * Returns "" when the subset adds nothing — an unnameable fold, which
 * classifyVariations() refuses rather than collapsing onto the anchor's slug.
 */
function variationRung(set, anchorSet) {
  const tok = (x) => String(x ?? "").split(/[\s–—-]+/)
    .map((t) => t.trim()).filter(Boolean);
  const drop = new Set(tok(anchorSet).map((t) => t.toLowerCase()));
  // "Cards" in "Base Cards" names the anchor, not the finish.
  drop.add("cards");
  const out = tok(set).filter((t) => !drop.has(t.toLowerCase()));
  if (!out.length) return "";
  // The subset is titled in the plural ("Image Variations"); a rung is singular.
  const last = out[out.length - 1];
  if (/s$/i.test(last) && !/ss$/i.test(last)) out[out.length - 1] = last.replace(/s$/i, "");
  return out.join(" ");
}

/**
 * Decide, for every subset in the release, whether it is a run of cards in its
 * own right or a rung on an anchor.
 *
 * `subsets` is a Map of "cardSet||cardType" -> {set, type, nums:Set}.
 * Returns a Map of the same keys -> {role, ...} carrying the folds.
 *
 * Refusal is the safe direction and is taken twice:
 *   * PARTIAL overlap is ambiguous — 2026 Topps Series 1's "Golden Mirror
 *     Legend" hits 96% of the base run and "Funko" 80%. Guessing either way
 *     files a whole subset wrong and keeps it wrong, so both stay own-cards.
 *   * An UNNAMEABLE fold (the subset adds no word to its anchor) would collapse
 *     silently onto the anchor's own slug and overwrite it.
 */
function classifyVariations(subsets) {
  const all = [...subsets.entries()].map((e) => Object.assign({ key: e[0] }, e[1]));
  const anchors = all.filter((s) => isAnchorSubset(s.type, s.set));
  const out = new Map();
  if (!anchors.length) return out;

  for (const s of all) {
    if (anchors.indexOf(s) !== -1) continue;
    if (!isVariationSubset(s.type, s.set)) continue;

    let best = null;
    for (const a of anchors) {
      const hit = [...s.nums].filter((n) => a.nums.has(n)).length;
      const pct = s.nums.size ? hit / s.nums.size : 0;
      // On a tie prefer the TIGHTEST anchor: the smallest run that still holds
      // every one of these numbers is the run they actually belong to. Without
      // it, "Golden Mirror Image (Team Card)" folds onto the 303-card base run
      // instead of the 15-card Team Card run it is named after.
      if (!best || pct > best.pct || (pct === best.pct && a.nums.size < best.anchor.nums.size)) {
        best = { anchor: a, pct: pct };
      }
    }
    if (!best || best.pct < 1) {
      out.set(s.key, { role: "own-cards", reason: best && best.pct > 0
        ? `partial overlap ${(best.pct * 100).toFixed(0)}% with ${best.anchor.set}`
        : "no anchor holds these numbers" });
      continue;
    }
    const rung = variationRung(s.set, best.anchor.set);
    if (!rung) {
      out.set(s.key, { role: "own-cards", reason: "fold would be unnameable" });
      continue;
    }
    out.set(s.key, { role: "parallel", anchorKey: best.anchor.key,
      anchorSet: best.anchor.set, anchorType: best.anchor.type, rung: rung });
  }
  return out;
}

// Same ceilings as convertChecklistCenterToChecklistCsv: past these a "ladder"
// is a roster and the subset is refused rather than multiplied.
const PAR_MAX = 150, NUM_MAX = 2000;

/** Fold a name for roster comparison: "Julio Rodriguez - Seattle Mariners"
 *  and "Julio Rodriguez" are the same person. The team suffix comes off. */
const foldName = (s) => String(s ?? "").split(" - ")[0]
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z]/g, "");

/**
 * A parallel entry is a real RUNG when the source names a PARALLEL rather than
 * a PERSON. The roster check is the guard that does that work: `roster` holds
 * every player name in THIS product, so "Ethan Holliday" filed into a hit
 * subset's parallels[] is caught by name, not by proxy.
 *
 * IT USED TO REQUIRE SCARCITY (CF-HM-VINTAGE-LADDER-DROPPED, 2026-09-03).
 * The original rule demanded a printRun, a 1/1 flag or pack odds, using
 * scarcity as a proxy for "this is a real rung". That proxy holds on 2026
 * Bowman, where every rung is numbered, and it is WRONG on everything older:
 * hobbymonitor states unnumbered parallels with no printRun at all, so the
 * proxy dropped the entire ladder. Measured over 34 pages of the lane: 3,644
 * ladder entries, 2,685 scarce, 958 unnumbered-but-real, and exactly ONE
 * misfiled player name ("Christy Mathewson - All 300 subjects") -- which the
 * roster check catches on its own. 2012/13 Panini Prizm published "Prizms",
 * "Prizms Green" and "Prizms Gold", all unnumbered, and ingested base-only;
 * 2019/20 Prizm kept 3 rungs and dropped 49 real ones (Prizms Silver, Prizms
 * Mojo, Prizms Green Ice). That is the "ladder present but ZERO print runs"
 * partial the universe manifest counts 2,029 of.
 *
 * A DROPPED PRINT RUN IS NOT A DROPPED RUNG. An unnumbered rung is emitted
 * with printRun BLANK -- blank means unknown, never a guess and never "Base"
 * (CF-BLANK-MEANS-UNKNOWN-NEVER-BASE). The card exists and the pool has sales
 * for it; what we do not know is its scarcity, and inventing one would be a
 * synthetic parallel.
 *
 * The name still has to LOOK like a rung and not a stray sentence, so two
 * cheap shape checks stay: an empty name, and a name past 60 characters (the
 * "- All 300 subjects" shape), are still refused.
 */
function classifyRung(p, roster) {
  const name = String(p && p.name != null ? p.name : "").trim();
  if (!name) return { ok: false, why: "empty" };
  // The misfiled-name guard, which is the one that was ever load-bearing.
  if (roster.has(foldName(name))) return { ok: false, why: "player-name" };
  if (name.length > 60) return { ok: false, why: "over-60-chars" };
  const hasScarcity = p.printRun != null || p.isOneOfOne === true ||
    (p.odds != null && String(p.odds).trim() !== "");
  // Kept either way; `why` records which, so the run banner can still report
  // how much of a ladder the source priced.
  return { ok: true, why: hasScarcity ? null : "unnumbered" };
}

/** The print run a rung states. isOneOfOne is the source's way of writing /1. */
const runOf = (p) => (p.isOneOfOne === true ? 1 : (p.printRun != null ? p.printRun : ""));

/** A rung's footnote -- the pack odds, kept in the 7th column like the CLC
 *  converter's parallelNote. Never part of the parallel name. */
const noteOf = (p) => String(p.odds == null ? "" : p.odds).replace(/\s+/g, " ").trim();

// THE EMITTER, lifted out of main() so a test can reach it
// (CF-BLANK-MEANS-UNKNOWN-NEVER-BASE, 2026-09-01). All of this used to live
// inline behind a network fetch, which is why the literal-"Base" defect
// shipped with no test able to see it. Pure: (cards[], parallelGroups[]) in,
// {rows, ...stats} out, no I/O.
function buildRows(cards, parallelGroups) {
  // The product's own roster, for the misfiled-name guard.
  const roster = new Set();
  for (const c of cards) {
    for (const pl of (Array.isArray(c.players) ? c.players : [c.players])) {
      const f = foldName(pl); if (f) roster.add(f);
    }
  }

  // Index the ladders by the pair the source itself scopes them with. A group
  // is {cardSet, cardType, parallels[]} and the cards carry the same two
  // fields, so the join is exact -- no name-similarity guessing.
  const ladderByKey = new Map();
  const rungStats = { entries: 0, real: 0, unnumbered: 0, playerName: 0, noScarcity: 0, other: 0 };
  const droppedNames = [];
  for (const g of parallelGroups) {
    const kept = [];
    for (const p of (g.parallels || [])) {
      rungStats.entries++;
      const v = classifyRung(p, roster);
      if (v.ok) { rungStats.real++; if (v.why === "unnumbered") rungStats.unnumbered++; kept.push(p); continue; }
      if (v.why === "player-name") { rungStats.playerName++; droppedNames.push(`${g.cardSet} :: ${p.name}`); }
      else if (v.why === "no-scarcity") rungStats.noScarcity++;
      else rungStats.other++;
    }
    ladderByKey.set(`${g.cardSet}||${g.cardType}`, kept);
  }

  // Cards, deduped -- the same card is listed once per team.
  const cardRows = [];
  const seen = new Set();
  for (const c of cards) {
    const num = String(c.cardNumber ?? "").trim();
    if (!num) continue;
    const set = String(c.cardSet ?? c.cardType ?? "Base").trim() || "Base";
    const player = Array.isArray(c.players) ? c.players.join(" / ") : String(c.players ?? "");
    const key = `${set}|${num}|${player}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cardRows.push({ num, set, type: String(c.cardType ?? "").trim(), player,
      auto: isAutoOf(c), kind: cardTypeOf(c) });
  }

  // CF-HM-A-VARIATION-IS-A-RUNG. Build the (cardSet, cardType) subset index the
  // classifier reads, then decide which subsets are variations OF an anchor.
  // This runs on the deduped card rows so a card listed once per team counts
  // once toward its subset's numbering run.
  const subsets = new Map();
  for (const c of cardRows) {
    const k = `${c.set}||${c.type}`;
    if (!subsets.has(k)) subsets.set(k, { set: c.set, type: c.type, nums: new Set() });
    subsets.get(k).nums.add(c.num);
  }
  const variationRoles = classifyVariations(subsets);
  const foldedSubsets = [];
  const refusedFolds = [];
  for (const [k, v] of variationRoles) {
    if (v.role === "parallel") foldedSubsets.push(`${k} -> ${v.anchorSet} as "${v.rung}"`);
    else refusedFolds.push(`${k}: ${v.reason}`);
  }

  // ingest-scraped-checklist accepts only "base", "insert-*" and "auto-*", so
  // the subset name has to ride in the category or the row is skipped and its
  // identity is lost.
  //
  // CF-HM-BASE-CARDS-IS-STILL-BASE (2026-09-04). This tested `slug(set) === "base"`
  // and nothing else, so a release whose base run hobbymonitor titles anything
  // but the bare word "Base" emitted NO base-category row at all. Both 2026
  // Topps Chrome and 2026 Bowman title theirs "Base Cards", which slugs to
  // `base-cards` and came out as `insert-base-cards` — 300 and 2,300 rows
  // respectively, the whole base set of each release filed as an insert named
  // after itself. That is the same shape the parallelColumnAuthoritative note
  // at the top of this file was written to prevent, arriving through the
  // category instead of the parallel; and a release with no base row is what
  // the universe driver's zero-base gate refuses outright.
  //
  // The base run is whatever the source types `Base` while naming no variation
  // — exactly isAnchorSubset(), the same test the variation classifier uses, so
  // the two can never disagree about which subset is the plain card. A release
  // with several base runs (Series 1 numbers Team Card, League Leaders, Combo
  // Card and Future Stars separately) keeps them distinct: only the run whose
  // name adds nothing to "Base" is the bare `base` category, and the others
  // stay `insert-base-<run>` on their own numbering, which is what they are.
  const BASE_RUN_NAME = /^base(\s+cards?)?$/i;
  const categoryOf = (set, auto) => {
    if (auto) return `auto-${slug(set)}`;
    return BASE_RUN_NAME.test(String(set ?? "").trim()) ? "base" : `insert-${slug(set)}`;
  };

  // Emit: the card's own row for every card, then that card's own subset
  // ladder. EVERY card row's parallel is blank -- "blank means unknown, never
  // Base" -- in every category, the base category included. ingest reads "" as
  // the base tier through normalizeParallel.
  const rows = [];
  const bySubset = new Map();
  let ladderRows = 0, refusedSubsets = 0, foldedRows = 0;
  const refusedNote = [];
  // One representative row per subset, so a fold can read its ANCHOR's
  // auto-ness rather than assuming its own.
  const anchorRowsByKey = new Map();
  for (const c of cardRows) {
    const k = `${c.set}||${c.type}`;
    if (!anchorRowsByKey.has(k)) anchorRowsByKey.set(k, c);
  }
  for (const c of cardRows) {
    const cat = categoryOf(c.set, c.auto);
    const rungs = ladderByKey.get(`${c.set}||${c.type}`) || [];
    const st = bySubset.get(c.set) || { cards: 0, rungs: rungs.length, rows: 0, refused: false };
    st.cards++;
    bySubset.set(c.set, st);
    // CF-BLANK-MEANS-UNKNOWN-NEVER-BASE (2026-09-01). The comment above has
    // said "blank means unknown, never Base" since this emitter was written;
    // the code contradicted it for the one category where it matters most.
    // `cat === "base" ? "Base" : ""` wrote the literal word into the parallel
    // column of every base card of every hobbymonitor release, and the source
    // page never says it -- hobbymonitor states a finish only on the ladder
    // (cardParallels[]), never on a card object. The word was ours, not the
    // checklist's.
    //
    // Two consequences, both observed. A base-ONLY release emits zero rows the
    // driver can see as base, so the zero-base gate REFUSES it (25 manifest
    // entries, 1952 Topps and its 5,418 rows among them). A release WITH
    // inserts passes that gate and ingests every base card carrying the
    // parallel "Base" -- a second row beside the blank-parallel row every other
    // source mints for the same card, which is a split pool and a wrong FMV.
    //
    // Identity grammar lives in the SLUG, not in the stored field:
    // normalizeParallel("") is already the base tier, and ingest-scraped-
    // checklist.cjs reads this column verbatim under
    // parallelColumnAuthoritative. So the honest emission is the empty string
    // -- the source stated no finish, and we store no finish. Insert and auto
    // rows are unchanged: they emitted "" before and emit "" here, and their
    // real rung names are written by the ladder loop below.
    // A variation subset does not get its own category. It emits ON its anchor,
    // carrying the words it adds as the rung — "Golden Mirror Image" on the base
    // card, not a card called "Golden Mirror Image". The anchor's own auto-ness
    // decides isAuto: a variation of an unsigned base card is unsigned.
    const fold = variationRoles.get(`${c.set}||${c.type}`);
    if (fold && fold.role === "parallel") {
      const anchor = anchorRowsByKey.get(fold.anchorKey);
      const anchorAuto = anchor ? anchor.auto : c.auto;
      rows.push({ category: categoryOf(fold.anchorSet, anchorAuto), cardNumber: c.num,
        parallel: fold.rung, isAuto: anchorAuto, printRun: "", player: c.player,
        parallelNote: "", cardType: c.kind });
      st.rows++;
      foldedRows++;
      continue;
    }
    rows.push({ category: cat, cardNumber: c.num, parallel: "",
      isAuto: c.auto, printRun: "", player: c.player, parallelNote: "",
      cardType: c.kind });
    st.rows++;
  }
  // Per-subset ceilings, decided on the subset as a whole before any rung row
  // is emitted for it.
  const numsBySubset = new Map();
  for (const c of cardRows) {
    if (!numsBySubset.has(c.set)) numsBySubset.set(c.set, new Set());
    numsBySubset.get(c.set).add(c.num);
  }
  for (const c of cardRows) {
    // A folded variation is already a rung on the anchor. Stacking the anchor's
    // OWN ladder on top of it would mint "Golden Mirror Image" x "Gold
    // Refractor" pairs the page never lists — the cartesian smear this lane's
    // guards exist to refuse. hobbymonitor states a variation's own ladder under
    // the variation's own (cardSet, cardType) when it has one, and that is the
    // only ladder a folded row may carry.
    const fold = variationRoles.get(`${c.set}||${c.type}`);
    const rungs = ladderByKey.get(`${c.set}||${c.type}`) || [];
    if (!rungs.length) continue;
    const nRungs = new Set(rungs.map((r) => r.name)).size;
    const nNums = (numsBySubset.get(c.set) || new Set()).size;
    if (nRungs > PAR_MAX || nNums > NUM_MAX) {
      const st = bySubset.get(c.set);
      if (st && !st.refused) {
        st.refused = true; refusedSubsets++;
        refusedNote.push(`${c.set}: rungs=${nRungs} numbers=${nNums} (gate ${PAR_MAX}/${NUM_MAX})`);
      }
      continue;
    }
    // A folded subset's rungs land on the ANCHOR's category, and each rung name
    // is qualified by the variation it is a finish of, because "Gold Refractor"
    // of the Image Variation is not "Gold Refractor" of the plain card.
    const anchorRow = fold && fold.role === "parallel" ? anchorRowsByKey.get(fold.anchorKey) : null;
    const rowAuto = anchorRow ? anchorRow.auto : c.auto;
    const cat = categoryOf(fold && fold.role === "parallel" ? fold.anchorSet : c.set, rowAuto);
    for (const r of rungs) {
      const name = String(r.name).trim();
      const parallel = fold && fold.role === "parallel" ? `${fold.rung} ${name}` : name;
      rows.push({ category: cat, cardNumber: c.num, parallel: parallel,
        isAuto: rowAuto, printRun: runOf(r), player: c.player, parallelNote: noteOf(r),
        cardType: c.kind });
      ladderRows++;
      const st = bySubset.get(c.set); if (st) st.rows++;
    }
  }


  return { rows, cardRows, bySubset, rungStats, droppedNames, ladderRows,
    refusedSubsets, refusedNote, variationRoles, foldedSubsets, refusedFolds, foldedRows };
}

/**
 * CF-ZERO-CARDS-ON-A-200-PAGE-MUST-NAME-WHY (2026-09-04, run 33857627732).
 *
 * The fetcher had ONE sentence for every way a release page can yield no
 * cards -- "no cards found — the page shape may have changed" -- and the
 * driver, having no better information, wrote `failed` on all of them. On
 * that run entry 18 (2026 Panini Prizm WNBA) was a release dated 2026-09-25:
 * an UNRELEASED product whose checklist hobbymonitor has not published yet.
 * It became the third `failed` in a row and aborted the lane with 81 entries
 * unattempted. Nothing was broken; the source simply has nothing yet.
 *
 * Probed directly (HTTP 200, 296,204 bytes, no redirect, no challenge):
 *
 *   WNBA  "status":"upcoming"  teamChecklists:[] cardVariations:[] cardParallels:[]
 *   2026 Bowman Football (works)  teamChecklists:[{...664229...}]  2,138 cardNumbers
 *
 * So three DIFFERENT causes get three DIFFERENT sentences, and the driver
 * classifies on them:
 *
 *   EMPTY AT SOURCE  the release payload parsed and carries no checklist of
 *      any kind. A verdict about the product, not our pipe.
 *   UNKNOWN LAYOUT   the payload is there and populated, but no cardNumber
 *      came out of it -- OUR parser, and it stays a lane fault so someone
 *      comes back to it.
 *   NOT A RELEASE PAGE  no release payload at all: a challenge page, an
 *      interstitial, or an error body served with a 200.
 *
 * Naming the cause is the whole point: "0 cards" is an observation, never a
 * diagnosis, and calling a parser gap "the source has nothing" is how a
 * defect goes quiet.
 */
function zeroCardReason(html) {
  const h = String(html || "");

  // A challenge/interstitial served with a 200 carries no release payload at
  // all. Checked FIRST: everything below assumes the page is really ours.
  if (!/"cardParallels"|"teamChecklists"|"queryKey"/.test(h)) {
    const challenged = /cf-browser-verification|cf_chl|__cf_bm|Just a moment|Attention Required|Checking your browser|Access denied|Please enable (?:JS|JavaScript)/i.test(h);
    return challenged
      ? `no release payload — the host served a challenge/interstitial page with HTTP 200 (${h.length} bytes)`
      : `no release payload on the page — not a hobbymonitor release page (${h.length} bytes)`;
  }

  // The payload IS there. Empty on every checklist-bearing array means the
  // release exists and carries nothing yet -- an unreleased/announced product.
  const emptyTeams = /"teamChecklists":\[\]/.test(h);
  const emptyVariations = /"cardVariations":\[\]/.test(h);
  const emptyParallels = /"cardParallels":\[\]/.test(h);
  if (emptyTeams && emptyVariations && emptyParallels) {
    // Read the status off THIS release's own object, not the first one in the
    // page (the sidebar lists other releases and would lend us its status).
    // The empty arrays are the tail of the release object, so the window that
    // ends at them is the only one that describes the set we asked for.
    const own = h.slice(Math.max(0, h.indexOf('"teamChecklists":[]') - 1200), h.indexOf('"teamChecklists":[]'));
    const st = (own.match(/"status":"([a-z]+)"/g) || []).pop()?.replace(/.*:"|"$/g, "");
    const eff = (own.match(/"effectiveDate":"([^"]+)"/) || [])[1];
    return "the release carries no checklist at the source — nothing new to add"
      + (st ? ` (status "${st}"` + (eff ? `, effective ${eff.slice(0, 10)})` : ")") : "");
  }

  // Payload present AND populated, yet nothing parsed: our reader.
  return "0 cards — the release payload is populated but no cardNumber parsed; layout not understood";
}

async function main() {
  if (has("--list")) {
    await paced();
    const html = await get("https://www.hobbymonitor.com/releases");
    const rel = extractObjects(html, '"manufacturer"').filter((o) => o.slug);
    const uniq = [...new Map(rel.map((o) => [o.slug, o])).values()];
    console.log(JSON.stringify(uniq.map((o) => ({
      slug: o.slug, manufacturer: o.manufacturer, sport: o.sport, status: o.status,
    })), null, 1));
    console.log(`\n${uniq.length} releases`);
    return;
  }

  const url = val("--url", "");
  if (!url) { console.error("need --url <release page> (or --list)"); process.exit(1); }
  const out = val("--out", "");

  await paced();
  const html = await get(url);
  const cards = extractObjects(html, '"cardNumber"');
  const parallelGroups = extractArray(html, "cardParallels");

  if (cards.length === 0) {
    console.error(zeroCardReason(html));
    process.exit(1);
  }

  const { rows, cardRows, bySubset, rungStats, droppedNames, ladderRows, refusedSubsets,
    refusedNote, foldedSubsets, refusedFolds, foldedRows } = buildRows(cards, parallelGroups);

  // Columns 1-8 are the fixed contract (docs/reference/checklist-csv-contract.md);
  // `rarity` stays blank because hobbymonitor states no set-level production
  // figure. `cardType` is the 9th, additive: the contract's consumer reads its
  // header BY NAME and ignores a column it does not know, so this file stays
  // byte-compatible for every existing reader while carrying the source's own
  // card type for the one that learns to read it.
  const header = "category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity,cardType";
  const body = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun,
    r.player, r.parallelNote, "", r.cardType || ""]
    .map(csvCell).join(",")).join("\n");

  const withRun = rows.filter((r) => String(r.printRun) !== "").length;
  console.log(`${url}`);
  console.log(`  cards=${cards.length} cardRows=${cardRows.length} (deduped ${cards.length - cardRows.length}) subsets=${bySubset.size}`);
  console.log(`  ladder groups=${parallelGroups.length} entries=${rungStats.entries} -> real rungs=${rungStats.real}` +
    ` (${rungStats.real - rungStats.unnumbered} priced, ${rungStats.unnumbered} unnumbered)` +
    `  DROPPED player-names=${rungStats.playerName} over-60-chars=${rungStats.other}`);
  console.log(`  rows=${rows.length} (base ${cardRows.length} + ladder ${ladderRows})  with printRun=${withRun}`);
  const byKind = {};
  for (const r of rows) { const k = r.cardType || "(untyped)"; byKind[k] = (byKind[k] || 0) + 1; }
  console.log(`  card types: ${Object.entries(byKind).map((e) => `${e[0]}=${e[1]}`).join(" ")}`);
  if (foldedSubsets.length) {
    console.log(`  folded ${foldedSubsets.length} variation subsets onto their anchors (${foldedRows} card rows):`);
    for (const f of foldedSubsets) console.log(`     ${f}`);
  }
  if (refusedFolds.length) {
    console.log(`  REFUSED to fold ${refusedFolds.length} (kept as their own cards):`);
    for (const f of refusedFolds) console.log(`     ${f}`);
  }
  // A release that emits no base row at all is one the universe driver's
  // zero-base gate will refuse, so say so here rather than letting the driver
  // report it as a mystery. The usual cause is a base run this file's
  // BASE_RUN_NAME does not recognise — 2024 Bowman titles its "Base Paper",
  // 2025 Topps Stadium Club UFC splits its into "BASE CARDS I" and "BASE CARDS
  // II". Naming those is a vocabulary ruling, not a regex to widen quietly:
  // guessing which of two runs is "the" base set decides card identity.
  if (!rows.some((r) => r.category === "base")) {
    const baseish = [...new Set(cardRows.filter((c) => cardTypeOf({ cardType: c.type }) === "base")
      .map((c) => c.set))];
    console.log(`  !! NO BASE CATEGORY — the zero-base gate will refuse this release.`);
    console.log(`     base-typed subsets present: ${baseish.length ? baseish.join(" | ") : "(none)"}`);
  }
  if (refusedSubsets) for (const n of refusedNote) console.log(`  !! REFUSED subset ${n}`);
  if (droppedNames.length) {
    console.log(`  dropped names (first 5 of ${droppedNames.length}):`);
    for (const n of droppedNames.slice(0, 5)) console.log(`     ${n}`);
  }

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${header}\n${body}\n`);
    console.log(`  wrote ${out}`);

    // ingest-scraped-checklist reads a sibling manifest for product identity.
    // setKey must be the key the CATALOG already uses, not a prettified page
    // title -- modern Donruss lives under "panini-donruss", so passing
    // "donruss" would mint a second, parallel product.
    const yr = Number(val("--year", "")) || null;
    const setKey = val("--set-key", "");
    const setName = val("--set-name", setKey);
    const sport = val("--sport", "baseball");
    if (!yr || !setKey) {
      console.log("  NOTE: --year and --set-key required for a manifest; CSV written without one.");
    } else {
      const mPath = out.replace(/[.]csv$/, "") + ".manifest.json";
      fs.writeFileSync(mPath, JSON.stringify({
        scrapedAt: new Date().toISOString(),
        sourceUrl: url,
        sport: sport, year: yr, setName: setName,
        productKey: yr + "-" + setKey,
        setKey: setKey,
        rowCount: rows.length,
        // ingest-scraped-checklist re-derives the parallel from the category
        // slug UNLESS this says otherwise -- which would file the 100 base
        // cards under a parallel named "Base Cards". The rung is already in
        // the parallel column, put there by the subset's own ladder.
        parallelColumnAuthoritative: true,
        cardRows: cardRows.length,
        ladderRows: ladderRows,
        rungsReal: rungStats.real,
        rungsDroppedPlayerName: rungStats.playerName,
        rungsUnnumbered: rungStats.unnumbered,
        refusedSubsets: refusedSubsets,
        // CF-HM-A-VARIATION-IS-A-RUNG: which subsets became rungs on which
        // anchor, and which the classifier REFUSED to fold and why. A fold is a
        // claim about card identity, so it has to be auditable from the file.
        foldedVariationSubsets: foldedSubsets,
        refusedVariationFolds: refusedFolds,
        foldedRows: foldedRows,
        sectionsReport: [...bySubset.entries()].map(function (e) {
          return {
            breadcrumb: "Checklist > " + e[0],
            category: slug(e[0]),
            playerCount: e[1].cards,
            rungs: e[1].rungs,
            rowCount: e[1].rows,
            refused: e[1].refused,
            printRun: null,
          };
        }),
      }, null, 1));
      console.log("  wrote " + mPath);
    }
    // Park the parallel list next to the CSV. It is real published data and
    // we should not lose it just because we are not minting rows from it.
    if (parallelGroups.length) {
      const side = out.replace(/\.csv$/, "") + ".parallels.json";
      fs.writeFileSync(side, JSON.stringify({ sourceUrl: url, groups: parallelGroups }, null, 1));
      console.log(`  wrote ${side}  (${rungStats.entries} published entries, ${rungStats.real} real rungs)`);
    }
  } else {
    console.log(`${header}\n${body}`);
  }
}

// Only run when invoked directly, so the pure helpers above can be unit
// tested (the ladder filter is the guard against minting players as rungs).
if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
}

module.exports = { zeroCardReason, buildRows, classifyRung, foldName, runOf, noteOf, extractObjects, extractArray,
  cardTypeOf, classifyVariations, variationRung, isAnchorSubset, isVariationSubset,
  PAR_MAX, NUM_MAX };
