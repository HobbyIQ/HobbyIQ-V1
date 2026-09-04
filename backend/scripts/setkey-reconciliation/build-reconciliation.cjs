#!/usr/bin/env node
/**
 * Builds backend/data/setkey-reconciliation.json from the read-only census.
 *
 * ONE VERDICT PER STALE CATALOG setKey. The verdicts are DERIVED, not typed:
 * each rule below is a mechanical test over the key pair (stale key, the key
 * normalizeSetKey collapses it to) plus the census evidence. Where no rule
 * fires the entry is `needs-ruling` and carries the question to ask.
 *
 * READ-ONLY. Consumes scripts/setkey-reconciliation/out/*.json, writes one
 * data file. No Cosmos access here, no writes to prod.
 */
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..", "..");
// `derivesToToday` is a HISTORICAL measurement of the deriver BEFORE this
// reconciliation existed, so it must never be read from a build that already
// consumes the file being generated -- that would be circular, and every
// re-run would report the fix as the defect. BASELINE_DIST points at a dist
// built from the commit this reconciliation was measured against (a git
// worktree at that sha); it falls back to this tree's dist for a first run on
// a checkout that predates the change.
const BASELINE_DIST = process.env.BASELINE_DIST || path.join(backend, "dist");
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { normalizeSetKey, stripYearAndSport } = require(path.join(BASELINE_DIST, "services/portfolioiq/hobbyIqCardId.service.js"));
const { isProductSetKey, productEntry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
if (require(path.join(BASELINE_DIST, "services/portfolioiq/hobbyIqCardId.service.js")).normalizeSetKey.toString().includes("reconcileSetKey")) {
  throw new Error("BASELINE_DIST already consumes the reconciliation - point it at a dist built from the pre-change commit, or the verdicts are circular");
}

const OUT_DIR = path.join(__dirname, "out");
const catalog = require(path.join(OUT_DIR, "catalog.json"));
const pool = require(path.join(OUT_DIR, "pool.json"));

// ---------------------------------------------------------------- evidence --
const byKey = new Map();
for (const r of catalog) {
  const k = String(r.setKey || "").trim().toLowerCase();
  if (!k) continue;
  let e = byKey.get(k);
  if (!e) { e = { key: k, checklistRows: 0, totalRows: 0, years: new Set(), sports: new Set(), sources: new Set() }; byKey.set(k, e); }
  e.totalRows += r.n;
  if (catalogAuthorityOf(r.source) === "checklist") {
    e.checklistRows += r.n;
    if (r.cardYear) e.years.add(Number(r.cardYear));
    if (r.sport) e.sports.add(String(r.sport));
    if (r.source) e.sources.add(String(r.source));
  }
}

// Pool demand expressed in the DERIVER's vocabulary, plus the sample setNames.
const poolByDerived = new Map();
for (const r of pool) {
  const setName = String(r.setName || "");
  const d = normalizeSetKey(setName);
  if (!d) continue;
  let e = poolByDerived.get(d);
  if (!e) { e = { rows: 0, samples: [] }; poolByDerived.set(d, e); }
  e.rows += r.n;
  if (e.samples.length < 4 && setName) e.samples.push({ setName, sport: r.sport ?? null, year: r.cardYear ?? null, rows: r.n });
}

// ------------------------------------------------------------------- rules --
const segs = (s) => s.split("-");
function hasRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
/** Same words, different punctuation: "-and-" vs "-", a plural head. */
const wordFold = (s) => s.replace(/-and-/g, "-").replace(/-/g, "").replace(/s$/, "");

/** The makers whose name is a PREFIX the market drops ("Finest" = "Topps
 *  Finest"). Dropping a maker prefix spells the SAME product; adding a
 *  QUALIFIER after the product name names a DIFFERENT one. */
const MAKER_PREFIXES = ["topps", "panini", "bowman", "upper-deck", "fleer", "score", "donruss", "leaf", "skybox", "pinnacle"];

/** ASSUMPTION (Drew has NOT ruled): brand-ownership dates. A brand key is bare
 *  before its acquisition year and maker-prefixed from it. Panini bought
 *  Donruss-Playoff in 2009, which carried Score and Leaf's US line with it.
 *  Fleer and Skybox went to Upper Deck in 2005 and were NEVER Panini. */
const ERA_BRANDS = [
  { brand: "donruss", maker: "panini", fromYear: 2009 },
  { brand: "score", maker: "panini", fromYear: 2009 },
  { brand: "leaf", maker: "panini", fromYear: 2009 },
];
const NEVER_PANINI = ["fleer", "skybox"];

/** Drew 2026-09-01 (R2) and 2026-09-03: the bare official Pokemon set code IS
 *  the key, so a code-shaped catalog key is a fixed point by ruling. */
const POKEMON_CODE = /^(?:sv|swsh|sm|xy|bw|dp|hgss|me|s)\d+[a-z]?(?:pt\d+)?(?:-|$)/;

function verdictFor(e) {
  const key = e.key;
  const dest = normalizeSetKey(key);
  const K = segs(key), D = segs(dest);
  const years = [...e.years].sort((a, b) => a - b);
  const sports = [...e.sports].sort();
  const ev = {
    catalogRows: e.totalRows,
    checklistRows: e.checklistRows,
    years: years.length ? `${years[0]}-${years[years.length - 1]}` : null,
    sports,
    sources: [...e.sources].sort().slice(0, 4),
    poolRowsAtDerived: poolByDerived.get(dest)?.rows ?? 0,
    poolRowsAtKey: poolByDerived.get(key)?.rows ?? 0,
    sampleTitles: (poolByDerived.get(dest)?.samples ?? []).slice(0, 3),
  };

  // (0) MIS-SPORTED. Drew's ruling: a row stored sport=pokemon whose key names
  // no pokemon product counts as BLANK, never as pokemon. The key is not the
  // defect here — the sport field is.
  if (e.sports.size === 1 && e.sports.has("pokemon") &&
      (isProductSetKey(key) || /^(?:panini|topps|donruss|bowman)-/.test(key)) &&
      !/pokemon|pikachu|charizard/.test(key)) {
    return { verdict: "mis-sported", canonical: key,
      rule: "sport=pokemon on a sports-product key — the tca-ebay pokemon-default writer; a stored pokemon with no pokemon token counts as blank",
      evidence: ev };
  }

  // (1) ERA SPLIT — one brand, two owners; the YEAR decides the spelling.
  for (const { brand, maker, fromYear } of ERA_BRANDS) {
    if (key === brand && dest === `${maker}-${brand}`) {
      const pre = years.filter((y) => y < fromYear);
      return {
        verdict: "era-split", canonical: null, assumption: true,
        eraRule: { brand, bareBeforeYear: fromYear, makerKey: `${maker}-${brand}` },
        rule: `ASSUMPTION (unruled): ${maker} acquired ${brand} in ${fromYear}; a ${brand} card printed before ${fromYear} is \`${brand}\`, from ${fromYear} it is \`${maker}-${brand}\``,
        evidence: { ...ev, checklistYearsBeforeBoundary: pre.length ? `${pre[0]}-${pre[pre.length - 1]}` : null, checklistYearCount: years.length },
      };
    }
  }
  for (const brand of NEVER_PANINI) {
    if (key === brand && dest === `panini-${brand}`) {
      return { verdict: "era-split", canonical: brand, assumption: true,
        eraRule: { brand, bareBeforeYear: null, makerKey: null },
        rule: `ASSUMPTION (unruled): Panini never owned ${brand} (Upper Deck bought it in 2005) — \`${brand}\` is the key in EVERY year`,
        evidence: ev };
    }
  }

  // (1b) THE KEY ITSELF IS MALFORMED — a year prefix or a trailing sport word
  // that stripYearAndSport correctly removes ("bowman-baseball" -> "bowman",
  // "2024-25-panini-prizm" -> "panini-prizm"). The DERIVER is right here and
  // the CATALOG ROW is the defect: it was written with the year and the sport
  // leaked into the key (CF-THE-PRODUCT-NAME-IS-NOT-THE-KEY). Reconciling it
  // as an alias would be wrong twice over — it would bless a malformed key and
  // it would let the year prefix into the alias table. These belong to the
  // catalog rename fleet, not the vocabulary, so they are declared and left
  // to the deriver.
  //
  // The exception worth naming: "topps-150-years-of-baseball" is a product
  // whose NAME ends in the word baseball, so stripping it leaves
  // "topps-150-years-of" and the vocabulary then collapses that to `topps`.
  // That is a real defect in stripYearAndSport, filed here as evidence rather
  // than fixed, because changing the strip changes every id it has ever minted.
  const stripped = stripYearAndSport(key);
  if (stripped !== key) {
    return { verdict: "catalog-key-malformed", canonical: dest,
      rule: `the CATALOG key carries a year prefix or a trailing sport word (\`${key}\` strips to \`${stripped}\`) — the deriver is right and the catalog row is the defect; a rename-fleet item, not a vocabulary one`,
      evidence: { ...ev, strippedTo: stripped } };
  }

  // (2) POKEMON CODE — a fixed point by Drew's ruling, whatever the vocabulary
  // does to it today.
  if (POKEMON_CODE.test(key) && e.sports.has("pokemon")) {
    return { verdict: "distinct", canonical: key,
      rule: "Drew 2026-09-01 R2: the bare official Pokemon/Japanese set code IS the key — a fixed point by ruling",
      evidence: ev };
  }

  // (2a) CROSS-VERTICAL COLLAPSE. A Pokemon checklist key swallowed by a
  // SPORTS product's pattern is never an alias — `ex6-firered-leafgreen` is a
  // 2004 Pokemon set the bare `/leaf/` rule captures on the word "leafgreen".
  // Two verticals cannot be one product, so the key is a fixed point.
  if (e.sports.size === 1 && e.sports.has("pokemon") && isProductSetKey(dest) && !/pokemon/.test(dest)) {
    return { verdict: "distinct", canonical: key,
      rule: `cross-vertical collapse — a Pokemon checklist key captured by the sports product \`${dest}\`; two verticals are never one product`,
      evidence: ev };
  }

  // (2b) THE PRODUCT TABLE HAS ALREADY RULED. productSetKeys.ts is where the
  // ONE spelling of a product lives (D23), and `names` are the other spellings
  // Drew ruled onto it — panini-optic -> donruss-optic is D31, topps-update ->
  // topps-update-series is D23 ruling (a). A key the table NAMES is a declared
  // alias, not an open question; a key the table SPELLS is a fixed point.
  const pe = productEntry(key);
  if (pe && pe.setKey !== key) {
    return { verdict: "alias", canonical: pe.setKey,
      rule: `productSetKeys.ts already rules \`${key}\` a spelling of \`${pe.setKey}\` (D23/D31) — the table is the authority on the one spelling`,
      evidence: ev };
  }
  if (pe && pe.setKey === key) {
    return { verdict: "distinct", canonical: key,
      rule: `productSetKeys.ts spells \`${key}\` as its own product — the table is the authority, so the key is a fixed point and the vocabulary must stop collapsing it to \`${dest}\``,
      evidence: ev };
  }

  // (3) TRUE ALIAS — the derivation ADDS a maker prefix to the same product
  // name ("finest" -> "topps-finest"). The catalog key is the market's
  // spelling of one product; the destination spells the same one.
  //
  // WHICH SIDE IS CANONICAL IS DECIDED BY SOURCE, NOT BY THE SPELLING. The
  // maker-prefixed form is the house style and wins by default — but only if a
  // checklist stands behind it. `nba-hoops` holds 26,355 checklistinsider rows
  // while `panini-hoops` holds ZERO, so for that pair the catalog key is
  // canonical and the prefixed form is the alias. Same doctrine as the
  // bare-Pokemon-code ruling: the checklist-backed spelling is the key.
  if (D.length > K.length && hasRun(D, K) && MAKER_PREFIXES.includes(D[0]) &&
      D.slice(D.length - K.length).join("-") === key) {
    const dChk = byKey.get(dest)?.checklistRows ?? 0;
    if (e.checklistRows > 0 && dChk === 0) {
      return { verdict: "alias", canonical: key, canonicalFlipped: true,
        rule: `maker prefix added, but the PREFIXED form \`${dest}\` holds zero checklist rows and \`${key}\` holds ${e.checklistRows.toLocaleString()} — the checklist-backed spelling is the key, so the canonical is \`${key}\` and the deriver must stop rewriting it`,
        evidence: { ...ev, destChecklistRows: dChk } };
    }
    return { verdict: "alias", canonical: dest,
      rule: `maker prefix added: \`${key}\` and \`${dest}\` name ONE product (the market drops the maker word)`,
      evidence: { ...ev, destChecklistRows: dChk } };
  }

  // (4) TRUE ALIAS — punctuation or a plural only.
  if (wordFold(key) === wordFold(dest)) {
    return { verdict: "alias", canonical: dest,
      rule: `same words, different punctuation ("-and-" / a plural head): \`${key}\` is \`${dest}\``,
      evidence: ev };
  }

  // (5) DISTINCT — the derivation SWALLOWS the key into a shorter ancestor by
  // dropping qualifying segments. Drew ruled 2026-09-03 that collapsing a
  // product into its family is forbidden: topps-triple-threads is not topps.
  if (K.length > D.length && hasRun(K, D)) {
    return { verdict: "distinct", canonical: key,
      rule: `product-family collapse — \`${dest}\` is an ancestor of \`${key}\`, and product-family collapse is forbidden (Drew 2026-09-03)`,
      evidence: ev };
  }

  // (5a) CROSS-BRAND COLLAPSE. The destination names a DIFFERENT maker than
  // the key and holds NO checklist row of its own — `triple-threads` (Topps,
  // 23,053 baseballcardpedia rows) collapsing into `panini-threads` (0
  // checklist rows) on the bare `/threads/` alias. Count by source, not by row
  // count: a destination no checklist stands behind cannot be the canonical
  // spelling of one that is checklist-backed. The key is the fixed point.
  const destChecklist = byKey.get(dest)?.checklistRows ?? 0;
  const keyMaker = MAKER_PREFIXES.find((m) => key === m || key.startsWith(`${m}-`)) ?? null;
  const destMaker = MAKER_PREFIXES.find((m) => dest === m || dest.startsWith(`${m}-`)) ?? null;
  if (destMaker && keyMaker !== destMaker && e.checklistRows > 0 && destChecklist === 0) {
    return { verdict: "distinct", canonical: key,
      rule: `cross-brand collapse — \`${dest}\` names a different maker and holds ZERO checklist rows, while \`${key}\` holds ${e.checklistRows.toLocaleString()}; count by source, not row count, so the key is the fixed point`,
      evidence: { ...ev, destChecklistRows: destChecklist } };
  }

  // (5b) DISTINCT — the same collapse as (5), one indirection later. The key
  // carries a BRAND that the destination re-spells with its maker prefix
  // ("donruss-euroleague" -> "panini-donruss" via the bare `/donruss/` alias),
  // so the destination is not a segment-run of the key but the collapse is the
  // same one: qualifying segments dropped, a product swallowed by its family.
  // Euroleague, WNBA and FIFA Donruss are separate releases with separate
  // checklists, not the flagship.
  const brandOfDest = D.length > 1 && MAKER_PREFIXES.includes(D[0]) ? D.slice(1).join("-") : null;
  if (brandOfDest && K.length > 1 && hasRun(K, segs(brandOfDest))) {
    return { verdict: "distinct", canonical: key,
      rule: `product-family collapse through a bare brand alias — \`${key}\` carries the qualifier the deriver drops on its way to \`${dest}\`; product-family collapse is forbidden (Drew 2026-09-03)`,
      evidence: ev };
  }

  // (6a) MALFORMED KEY — no checklist row stands behind it, and the key itself
  // is not a product name: a year prefix the writer never stripped, a raw
  // spaced title, an apostrophe slugified into a segment. There is nothing to
  // rule on; the deriver's collapse of these is the correct outcome, and the
  // rows are a writer defect for the rename fleet, not a vocabulary question.
  if (e.checklistRows === 0 && (/^(?:19|20)\d{2}[- ]/.test(key) || /\s/.test(key) || /-s-/.test(key))) {
    return { verdict: "malformed", canonical: dest,
      rule: `not a product name and no checklist row behind it — a year prefix / raw title / slugified apostrophe; \`${dest}\` is the right destination and the row is a writer defect`,
      evidence: ev };
  }

  // (6) Everything else is a genuine question. Ask it in the terms the pair
  // actually differs by, so the answer is a word and not an essay.
  const kSet = new Set(K), dSet = new Set(D);
  const keyOnly = K.filter((s) => !dSet.has(s));
  const destOnly = D.filter((s) => !kSet.has(s));
  const scope = `${e.checklistRows.toLocaleString()} checklist rows${ev.years ? `, ${ev.years}` : ""}${sports.length ? `, ${sports.join("/")}` : ""}`;
  let question;
  if (destOnly.length === 1 && keyOnly.length === 0) {
    // The catalog key omits ONE word the deriver inserts ("bowman-sapphire" vs
    // "bowman-chrome-sapphire"). Shorthand, or a second product?
    question = `\`${key}\` (${scope}) derives to \`${dest}\`, which inserts "${destOnly.join(" ")}". Is \`${key}\` the market's shorthand for \`${dest}\` (alias), or a product of its own (fixed point)?`;
  } else if (keyOnly.length && destOnly.length) {
    question = `\`${key}\` (${scope}) derives to \`${dest}\`: the key says "${keyOnly.join(" ")}" where the destination says "${destOnly.join(" ")}". One product spelled two ways, or two products?`;
  } else {
    question = `\`${key}\` (${scope}) derives to \`${dest}\` — one product under two names (alias), or a product of its own (fixed point)?`;
  }
  return { verdict: "needs-ruling", canonical: null, derivesTo: dest, question, evidence: ev };
}

// ------------------------------------------------------------------ build ---
const entries = [];
for (const e of byKey.values()) {
  const dest = normalizeSetKey(e.key);
  if (dest === e.key) continue; // already a fixed point — nothing to reconcile
  entries.push({ setKey: e.key, derivesToToday: dest, ...verdictFor(e) });
}
entries.sort((a, b) => (b.evidence.checklistRows - a.evidence.checklistRows) || a.setKey.localeCompare(b.setKey));

const counts = {};
for (const e of entries) counts[e.verdict] = (counts[e.verdict] || 0) + 1;

// -- the mis-sported class, measured on the POOL side ------------------------
//
// #1689 named 90,462 rows of "2023 panini-obsidian / zenith / origins tagged
// sport=pokemon". They do NOT appear in the entries above, and the reason is
// worth stating rather than leaving as a silent zero: the defect is in the
// SPORT field, not in the setKey. Every one of those keys is already a
// normalizeSetKey fixed point, and the catalog rows carrying them hold ZERO
// checklist rows, so no stale key exists for them to be a verdict about.
//
// Drew's ruling -- a stored `pokemon` with no pokemon token in the title
// counts as BLANK, never as pokemon -- therefore lands on the tca-ebay
// pokemon-default writer and on a pool repair, not on the vocabulary. Measured
// read-only here so the number travels with the reconciliation.
const misSported = { poolRows: 0, byKey: {} };
for (const r of pool) {
  if (r.sport !== "pokemon") continue;
  const d = normalizeSetKey(String(r.setName || ""));
  if (!/^(?:panini|topps|donruss|bowman)-/.test(d)) continue;
  if (/pokemon|pikachu|charizard/.test(d)) continue;
  misSported.poolRows += r.n;
  misSported.byKey[d] = (misSported.byKey[d] || 0) + r.n;
}
misSported.byKey = Object.fromEntries(Object.entries(misSported.byKey).sort((a, b) => b[1] - a[1]).slice(0, 12));

const doc = {
  $comment: [
    "SETKEY RECONCILIATION - every card_catalog setKey that normalizeSetKey does not leave alone.",
    "Generated read-only by scripts/setkey-reconciliation/build-reconciliation.cjs against prod",
    "hobbyiq-comps on 2026-09-03. A ruled key MUST be a normalizeSetKey fixed point; this file lists",
    "the keys that are not, one verdict each, with the evidence the verdict was derived from.",
    "Verdicts: alias (one product, two spellings - `canonical` is the key that wins) | distinct (two",
    "products the deriver merges - the key is a fixed point) | era-split (one brand, two owners - the",
    "year decides) | mis-sported (the sport field is wrong, not the key) | needs-ruling (no mechanical",
    "rule fires - Drew answers `question`).",
    "Entries carrying `assumption: true` rest on a date Drew has NOT ruled.",
  ],
  generatedAt: "2026-09-03",
  source: "read-only census of card_catalog + sold_comps, prod hobbyiq-comps",
  totals: {
    catalogSetKeys: byKey.size,
    staleSetKeys: entries.length,
    checklistRowsStranded: entries.reduce((a, e) => a + e.evidence.checklistRows, 0),
    verdicts: counts,
  },
  misSported: {
    $comment: "sport-field defect, NOT a setKey defect: these keys are already fixed points and their catalog rows hold no checklist rows. Belongs to the tca-ebay pokemon-default writer and a pool repair.",
    ...misSported,
  },
  entries,
};
fs.writeFileSync(path.join(backend, "data", "setkey-reconciliation.json"), JSON.stringify(doc, null, 1) + "\n");
console.log(JSON.stringify(doc.totals, null, 1));
