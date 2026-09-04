#!/usr/bin/env node
/**
 * census-player-field-corruption.cjs -- READ-ONLY. How corrupted is the PLAYER
 * field itself on the pool rows the `player-` pseudo-number census surfaced?
 *
 * CF-A-PLAYER-SEGMENT-IS-A-PERSON (Drew, 2026-09-04). The #1728 census of the
 * 89,197 `player-<name>` rows was measuring the NUMBER. Reading its output
 * surfaced a second, independent defect in the thing that census took for
 * granted -- the NAME:
 *
 *     player-kawhi-leonard-tie-dye     the parallel is inside the name
 *     player-mega-box-elly-de          the product is inside the name AND
 *                                      "Elly De La Cruz" was cut to "Elly De"
 *     player-pokemon-swsh-fa-mew       not a person at all -- set code + "FA"
 *
 * Each is the same mechanism seen from a different side. `parseCardQuery`
 * derives the player SUBTRACTIVELY: strip the tokens it recognizes, and
 * whatever survives is declared to be the name. That is only correct when the
 * strip list is complete, and the strip list is a ~250-word hand list that is
 * necessarily smaller than the hobby. Every token it does not know -- tie-dye,
 * mega box, swsh, fa -- is not merely unstripped, it is PROMOTED INTO A
 * PERSON'S NAME. And `.slice(0, 4)` then truncates whatever is left to four
 * words, so a name that survives with noise ahead of it loses its own tail.
 *
 * This script writes nothing. It re-reads each row's title with today's parser
 * and sorts the derived player fields into the classes that say what a fix
 * would have to do:
 *
 *   CLEAN         the field is a plausible person's name and carries no
 *                 vocabulary token.
 *   FINISH-TOKEN  a finish or parallel word is inside the name. Measured
 *                 against the CHECKLIST CORPUS (data/checklist-parallel-names.json,
 *                 36,699 checklist-sourced parallel names) plus CORE_FINISH_TOKENS
 *                 -- the same vocabulary the GREAT REMATCH audit gate reads,
 *                 so "is this a parallel word" has one answer in this repo.
 *   PRODUCT-TOKEN a product / brand / set word is inside the name, tested
 *                 per-(year,setKey) via isProductWord so "Chrome" is a product
 *                 word on topps-chrome and a finish word on topps.
 *   TRUNCATED     the name ends on a token that is a name PREFIX rather than a
 *                 name -- a dangling particle (de/la/van/mc), or a final token
 *                 under 3 chars that is not a real short surname.
 *   NOT-PERSON    the field is not a person's name at all: a set code, a
 *                 bare product word, or a Pokemon card name on a NON-pokemon
 *                 row. A Pokemon character name on a pokemon row is CLEAN --
 *                 that vertical's cards name characters, not athletes.
 *
 * A row can carry more than one defect; it is counted under its FIRST matching
 * class in the order above so the classes partition the population, and each
 * example carries the full defect list so the overlap stays visible.
 *
 * USAGE (read-only; there is no APPLY flag on purpose)
 *   COSMOS_CONNECTION_STRING=... node scripts/census-player-field-corruption.cjs \
 *       [--limit N] [--normal-sample 500] [--out FILE]
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");
const VOCAB = require(path.join(__dirname, "lib", "rematch-finish-vocab.cjs"));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(argOf("--limit", "0")) || 0;
const NORMAL_SAMPLE = Number(argOf("--normal-sample", "500")) || 500;
const OUT = argOf("--out", "");

// ---------------------------------------------------------------------------
// The parser under test.
// ---------------------------------------------------------------------------
let parseCardQuery;
try {
  ({ parseCardQuery } = require(path.join(__dirname, "..", "dist", "services", "compiq", "cardQueryParser.js")));
} catch {
  try {
    require("tsx/cjs");
    ({ parseCardQuery } = require(path.join(__dirname, "..", "src", "services", "compiq", "cardQueryParser.ts")));
  } catch (e) {
    console.error("cannot load cardQueryParser (build dist/ or install tsx):", e.message);
    process.exit(2);
  }
}

const lower = (s) => String(s ?? "").toLowerCase();
const words = (s) => lower(s).replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

/**
 * NAME PARTICLES -- tokens that are legitimately INSIDE a name but can never
 * END one. "Elly De La Cruz" truncated to "Elly De" ends on a particle, and
 * that is the signature of a cut, not of a short name.
 */
const TRAILING_PARTICLES = new Set([
  "de", "la", "el", "del", "der", "van", "von", "di", "da", "dos", "das",
  "mc", "mac", "st", "san", "le", "du", "bin", "ibn",
]);

/** Names/initials that are genuinely 1-2 characters. Without this a legitimate
 *  short name would be miscounted as a truncation. */
const REAL_SHORT_NAMES = new Set([
  "oh", "ng", "ho", "ko", "lu", "li", "yu", "wu", "xu", "an", "im", "ok",
  "ha", "so", "no", "ah", "yi", "je", "cy", "ed", "al", "aj", "cj", "jj",
  "tj", "dj", "rj", "bj", "jr", "sr",
]);

/** Pokemon-vertical set codes and layout words that are NOT part of any
 *  character's name. `fa` = full art, `swsh` = Sword & Shield. */
const POKEMON_CODE_RE = /^(swsh|sm|xy|bw|hgss|dp|gx|vmax|vstar|fa|sar|char|ur|sir|promo|s\d{1,2}[a-z]?|sv\d{0,2}[a-z]?)$/i;

function corpusParallelWordsFor(year, setKey) {
  const out = new Set();
  let names = [];
  try { names = VOCAB.checklistParallelNamesFor(year ?? null, setKey ?? "") || []; } catch { names = []; }
  for (const n of names) for (const w of words(n)) if (w.length >= 3) out.add(w);
  return out;
}

let _globalParallelWords = null;
/** Every parallel word the corpus knows, across all products -- the fallback
 *  when a row's own (year,setKey) has no checklist. Deliberately over-broad:
 *  this census MEASURES, it does not mutate. */
function globalParallelWords() {
  if (_globalParallelWords) return _globalParallelWords;
  const out = new Set();
  const add = (list) => { for (const w of list || []) for (const t of words(w)) if (t.length >= 3) out.add(t); };
  add(VOCAB.CORE_FINISH_TOKENS);
  add(VOCAB.FINISH_FAMILY_TOKENS);
  add(VOCAB.FINISH_COLOR_TOKENS);
  add(VOCAB.HAND_SPELLINGS);
  _globalParallelWords = out;
  return out;
}

let _productWords = null;
/**
 * Brand + set words drawn from the corpus's own setKeys, so the product
 * vocabulary is the checklist's and not a second hand list.
 *
 * FREQUENCY FLOOR, for the same reason playerSegmentIsAPerson.ts applies one:
 * a handful of setKeys are named after PEOPLE (`bobby-witt-jr`), so a naive
 * harvest puts `bobby` and `witt` into the "this word is a product" vocabulary
 * and this census then reports the clean stored name "Bobby Witt Jr." as
 * product-contaminated. Measured: real brand words recur across products
 * (topps=179, panini=215, chrome=75) and person-named setKeys appear ONCE. A
 * floor of 2 separates them without a blocklist.
 */
const SETKEY_FREQUENCY_FLOOR = 2;

function productWords() {
  if (_productWords) return _productWords;
  const out = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "checklist-parallel-names.json"), "utf8"));
    const freq = new Map();
    for (const key of Object.keys(raw.products || {})) {
      const setKey = key.split("|")[2] || "";
      for (const w of new Set(setKey.split("-"))) {
        if (w.length >= 3) freq.set(lower(w), (freq.get(lower(w)) || 0) + 1);
      }
    }
    for (const [w, n] of freq) if (n >= SETKEY_FREQUENCY_FLOOR) out.add(w);
  } catch { /* corpus absent -> product class measured from the pack list only */ }
  // Packaging / product-form words that are products everywhere and are not
  // decomposable from any setKey ("mega box", "blaster").
  for (const w of ["mega", "box", "blaster", "hobby", "jumbo", "retail", "pack",
                   "case", "hanger", "cello", "rack", "value", "tin", "blister"]) out.add(w);
  _productWords = out;
  return out;
}

function classify(row, derivedName) {
  const name = String(derivedName ?? "").trim();
  if (!name) return { cls: "blank", defects: [], finishHits: [], productHits: [] };

  const nameWords = words(name);
  const setKey = lower(row.setKey || "");
  const year = row.cardYear ? Number(row.cardYear) : null;
  const defects = [];

  // --- NOT-PERSON -----------------------------------------------------------
  // A set code or layout word anywhere in the field means this is not a name.
  if (nameWords.some((w) => POKEMON_CODE_RE.test(w))) defects.push("notPerson");
  // "pokemon" itself inside the field is the franchise, never the character.
  if (nameWords.includes("pokemon")) defects.push("notPerson");

  // --- FINISH / PARALLEL TOKEN ---------------------------------------------
  const checklistWords = corpusParallelWordsFor(year, setKey);
  const finishVocab = globalParallelWords();
  const finishHits = nameWords.filter((w) => {
    if (w.length < 3) return false;
    // per-(year,setKey): a word that names THIS product is a product word, not
    // a finish word -- isProductWord settles chrome/prizm/mosaic.
    try { if (VOCAB.isProductWord(w, setKey)) return false; } catch { /* fall through */ }
    return checklistWords.has(w) || finishVocab.has(w);
  });
  if (finishHits.length) defects.push("finishToken");

  // --- PRODUCT / BRAND TOKEN ------------------------------------------------
  const productVocab = productWords();
  const productHits = nameWords.filter((w) => {
    if (w.length < 3) return false;
    if (productVocab.has(w)) return true;
    try { return VOCAB.isProductWord(w, setKey); } catch { return false; }
  });
  if (productHits.length) defects.push("productToken");

  // --- TRUNCATED ------------------------------------------------------------
  const last = nameWords[nameWords.length - 1] || "";
  const truncated =
    (TRAILING_PARTICLES.has(last) && nameWords.length >= 2) ||
    (last.length > 0 && last.length < 3 && !REAL_SHORT_NAMES.has(last)) ||
    name.length < 3;
  if (truncated) defects.push("truncated");

  // First match wins so the classes partition the population.
  for (const cls of ["finishToken", "productToken", "truncated", "notPerson"]) {
    if (defects.includes(cls)) return { cls, defects, finishHits, productHits };
  }
  // A Pokemon character name on a pokemon row is a legitimate card identity.
  return { cls: "clean", defects, finishHits, productHits };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const container = client.database("hobbyiq").container("sold_comps");

  const SELECT = "c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName, c.cardNumber, c.setKey, c.cardYear, c.parallel, c.sport, c.source";

  const blank = () => ({ clean: 0, finishToken: 0, productToken: 0, truncated: 0, notPerson: 0, blank: 0 });
  const counts = blank(), normalCounts = blank(), storedCounts = blank();
  const examples = {}, normalExamples = {}, storedExamples = {};
  let scanned = 0, ru = 0;

  const record = (bucket, exBucket, row, derived, res, cap) => {
    bucket[res.cls] = (bucket[res.cls] || 0) + 1;
    if (!exBucket[res.cls]) exBucket[res.cls] = [];
    if (exBucket[res.cls].length < cap) {
      exBucket[res.cls].push({
        title: String(row.title || "").slice(0, 130),
        stored: row.playerName ?? null,
        derived,
        setKey: row.setKey ?? null,
        year: row.cardYear ?? null,
        hobbyiqCardId: row.hobbyiqCardId ?? row.cardId ?? null,
        defects: res.defects,
        finishHits: res.finishHits,
        productHits: res.productHits,
      });
    }
  };

  // ---- population 1: the `player-` pseudo-number rows -----------------------
  const q1 = { query: `SELECT ${SELECT} FROM c WHERE CONTAINS(c.hobbyiqCardId, ':player-') OR CONTAINS(c.cardId, ':player-')` };
  const it1 = container.items.query(q1, { maxItemCount: 1000, maxDegreeOfParallelism: 8 });
  outer:
  while (it1.hasMoreResults()) {
    const { resources, requestCharge } = await it1.fetchNext();
    ru += requestCharge || 0;
    for (const row of resources || []) {
      scanned++;
      // The STORED field is the defect population -- what CF-PLAYER-IS-THE-NUMBER
      // actually wrote into the pool and what a repair would have to move.
      const storedName = String(row.playerName || "");
      record(storedCounts, storedExamples, row, storedName, classify(row, storedName), 8);
      // The DERIVED field is what today's parser would write instead -- the
      // residue left after the fix, so the two columns say what the fix moved.
      const parsed = parseCardQuery(String(row.title || ""));
      const derived = parsed?.playerName || "";
      record(counts, examples, row, derived, classify(row, derived), 8);
      if (LIMIT && scanned >= LIMIT) break outer;
    }
  }

  // ---- population 2: a sample of NORMAL rows (no pseudo-number) -------------
  let normalScanned = 0;
  const q2 = { query: `SELECT TOP ${NORMAL_SAMPLE} ${SELECT} FROM c WHERE NOT CONTAINS(c.hobbyiqCardId, ':player-') AND IS_DEFINED(c.title) AND IS_DEFINED(c.playerName)` };
  const it2 = container.items.query(q2, { maxItemCount: 500, maxDegreeOfParallelism: 8 });
  while (it2.hasMoreResults()) {
    const { resources, requestCharge } = await it2.fetchNext();
    ru += requestCharge || 0;
    for (const row of resources || []) {
      normalScanned++;
      const stored = String(row.playerName || "");
      record(normalCounts, normalExamples, row, stored, classify(row, stored), 6);
    }
  }

  const report = {
    _doc: "CF-A-PLAYER-SEGMENT-IS-A-PERSON census. READ-ONLY measurement of how corrupted the PLAYER field is on sold_comps rows. Nothing was written.",
    asOf: new Date().toISOString().slice(0, 10),
    container: "sold_comps",
    requestCharge: Math.round(ru),
    pseudoNumberPopulation: {
      scanned,
      // STORED = the corruption already in the pool. DERIVED = what today's
      // parser writes instead, i.e. what the fix leaves behind.
      stored: { counts: storedCounts, examples: storedExamples },
      derived: { counts, examples },
    },
    normalPopulation: { scanned: normalScanned, counts: normalCounts, examples: normalExamples },
  };
  const json = JSON.stringify(report, null, 2);
  if (OUT) { fs.writeFileSync(OUT, json); console.log("wrote", OUT); }
  console.log(JSON.stringify({ scanned, stored: storedCounts, derived: counts, normalScanned, normalCounts, ru: Math.round(ru) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
