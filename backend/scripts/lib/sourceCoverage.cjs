/**
 * CF-COVERAGE-IS-MEASURED-ON-KEYS (2026-08-29, D3b) -- ONE definition of "does
 * the replacement source cover what the old source had?", shared by the audit
 * that reports it (audit-source-coverage) and the retire that acts on it
 * (retire-exploded-checklist-rows MODE=source). They must not each carry a copy.
 *
 * WHY A PRODUCT BEING PRESENT IS NOT ENOUGH. The first REPLACED_BY guard asked
 * "does the replacement source have ANY row for this product?" and retired the
 * whole old product on a yes. Measured on 2026-08-29 over the 60 largest old
 * checklistcenter products (551,845 keys): the new source covered 23% of them.
 * 2025 Bowman Draft: old 8,591 rows, new 3,658, ZERO keys in common. The
 * re-ingest had transcribed every one of those rungs -- but the merge kept the
 * existing row on a confidence tie, so the rows stayed under the old label
 * (see mergeCatalogEntries) -- and a yes/no presence guard would have deleted
 * the ladder the re-ingest had just re-attested.
 *
 * CF-THE-LABEL-IS-NOT-THE-IDENTITY (2026-08-30, D3c). Measured after #1472
 * and the ×8 re-ingest, the audit still said 349 of 406 old products were
 * below the floor -- 2024 Topps Series 1 at 52% with every plain `33|base|`
 * and `33|rainbow foil|` uncovered, 2025 Donruss at 2%. Neither converter
 * path had dropped a row: the runner's own log converts 2024 Topps Series 1
 * to 20,043 rows (Base + all 37 foils) and 2025 Donruss to 17,722, and every
 * shard reached every file. Two things hid them from a source-label count:
 *   1. the ingest mints ids through computeHobbyIqCardId, which collapses the
 *      setKey (`topps-series-1` -> `topps`, `donruss` -> `panini-donruss`,
 *      `leaf-vivid` -> `leaf`), so the old raw-upserted row (id under
 *      `topps-series-1`) and the re-ingested row (id under `topps`) are two
 *      documents -- the new write never replaces the old one; and
 *   2. at the canonical id an EARLIER checklist source already sits at equal
 *      authority and confidence (bcp ladders are ingested before CLC in the
 *      same job; checklistinsider/beckett landed 08-27), so the merge keeps
 *      that row and the key never carries the new label ("kept the existing
 *      row 30k-104k" per shard). `hiq:baseball:2024:topps:33:base:no-auto` is
 *      baseballcardpedia-ladders; `hiq:baseball:2025:panini-donruss:53:
 *      artist-proof:no-auto:num-25` is checklistinsider-2026-08-27.
 * So coverage is measured on IDENTITY, the way the catalog itself dedups: an
 * old row is covered when its canonical id (the slug the ingest would mint
 * for the same sport/year/setKey/cardNumber/parallel/printRun) is held by a
 * checklist-authority row that is not one of the sources being retired --
 * the replacement's own label or the earlier one the merge kept. Who held
 * it is counted per source and printed. `COVER_BY=replacement` restores the
 * label-only reading.
 *
 * TWO KEYS PER ROW, still. Exact: the canonical id of the old row's own words
 * (isAuto either way -- the old ingesters glued "Auto" into the parallel and
 * left isAuto false). Normalised: the id of the parallel stripped of the
 * glued prefixes the old ingesters produced -- a leading subset word the
 * product itself names ("chrome prospects gold refractor" -> "gold refractor"),
 * a card-TYPE label the old ingester glued onto every rung of a numbered
 * range ("rated prospects artist proof black" -> "artist proof black"; a type
 * label is a bare old parallel with no print run and no finish word that
 * stands in for the plain card, extended by other rungs), "auto"/
 * "autograph(s)", "(rc)"/"(xrc)", "prizm(s)" (leading or trailing) and
 * "paper"/"set"/"base" prefixes -- tried shortest strip first, so "rated
 * prospects optic gold" meets "optic gold" before it could meet "gold"; and a
 * bare colour meets its long form ("green" -> "green refractor" / "green
 * prizm": one card, the long form kept, the colour = refractor ruling). A
 * colour or finish word is never stripped, whatever the subset names: a
 * "Gold Rush" insert must not turn "Gold Refractor" into "Refractor". Blank
 * and "Base" are the same plain card (the ingest slugs both to :base:).
 *
 * A legend line is not a card: the old html ingester split "Subset Key:
 * FS=Future Stars; WS=World Series Highlights" into rungs on every base card
 * (1,050 of 2020 Topps Series 1's 10,539 keys). Rows whose parallel reads
 * `XX=...` are counted and left out of the denominator.
 *
 * Read-only. Every function here queries; none writes.
 */
const path = require("node:path");

const STRIP_WORDS = new Set(["auto", "autos", "autograph", "autographs", "autographed", "prizm", "prizms", "paper", "set", "base", "rc", "xrc", "rookie", "rookies", "insert", "inserts", "variation", "variations"]);
const FINISH_WORDS = new Set(["black", "gold", "silver", "blue", "red", "green", "orange", "purple", "pink", "yellow", "aqua", "teal", "magenta", "fuchsia", "bronze", "platinum", "white", "rainbow", "refractor", "refractors", "superfractor", "xfractor", "x-fractor", "prizm", "prizms", "wave", "shimmer", "lava", "mojo", "holo", "foil", "sapphire", "speckle", "sparkle", "atomic", "pulsar", "ice", "flash", "geometric", "raywave", "sepia", "negative", "mini", "plates", "plate", "printing", "camo", "disco", "cracked", "neon", "vinyl", "finite", "laser", "border", "die", "cut", "1/1"]);
/** The finish families the D3b converter appends to a bare colour rung; an
 *  old bare "Green" and a new "Green Refractor" are one card (long form kept). */
const FAMILY_SUFFIXES = ["refractor", "prizm"];
const LEGEND_RX = /^[a-z]{1,4}\s*=\s*\S/i;
const MAX_STRIP = 6;   // "rookie and veteran retail autographs purple border" is five glued words

const lc = (v) => String(v ?? "").toLowerCase().trim();
const words = (v) => lc(v).replace(/[^a-z0-9/]+/g, " ").trim().split(" ").filter(Boolean);
const isLegend = (parallel) => LEGEND_RX.test(String(parallel ?? "").trim());

/** The product's own subset vocabulary: every word of every subsetName seen on
 *  either side that is not a colour/finish word. */
function subsetWordsOf(rows) {
  const out = new Set();
  for (const r of rows) for (const w of words(r.subsetName)) if (!FINISH_WORDS.has(w)) out.add(w);
  return out;
}

/** The card-type labels an old ingester glued onto a numbered range's rungs
 *  ("Rated Prospects", "Rookie and Veteran Retail Autographs"): a bare old
 *  parallel with no print run and no finish word, on a card that has NO plain
 *  (blank / Base) row -- so the label IS that card's plain form -- extended by
 *  at least three other parallels of the product. "Optic" on 2025 Donruss is
 *  not one: card 53 carries a plain Base row, so "Optic" is a finish there and
 *  "Optic Gold /10" must never be read as "Gold /10". */
function typeLabelWordsOf(rows) {
  const plain = new Set();
  for (const r of rows) { const p = lc(r.parallel); if (!p || p === "base") plain.add(lc(r.cardNumber)); }
  const pars = new Set(rows.map((r) => lc(r.parallel)).filter(Boolean));
  const labels = new Set();
  for (const r of rows) {
    const p = lc(r.parallel);
    if (!p || p === "base" || r.printRun || labels.has(p) || plain.has(lc(r.cardNumber))) continue;
    const w = words(p);
    if (!w.length || w.some((x) => FINISH_WORDS.has(x))) continue;
    let ext = 0;
    for (const q of pars) if (q !== p && q.startsWith(p + " ") && ++ext >= 3) break;
    if (ext >= 3) labels.add(p);
  }
  const out = new Set();
  for (const l of labels) for (const w of words(l)) out.add(w);
  return out;
}

const strippable = (w, subsetWords) => STRIP_WORDS.has(w) || subsetWords.has(w);

function normalizeParallel(parallel, subsetWords) {
  let toks = words(String(parallel ?? "").replace(/\((rc|xrc)\)/gi, " "));
  let n = 0;
  // STRIP_WORDS is the explicit list (it names prizm/prizms on purpose);
  // subsetWords never holds a colour or finish word (subsetWordsOf).
  while (toks.length > 1 && n < MAX_STRIP && strippable(toks[0], subsetWords)) { toks.shift(); n++; }
  while (toks.length > 1 && /^prizms?$/.test(toks[toks.length - 1])) toks.pop();
  // Blank, "Base", or a lone type word ("rated prospects" -> "prospects") is
  // the plain card; the ingest slugs every one of them to :base:.
  if (!toks.length || (toks.length === 1 && strippable(toks[0], subsetWords))) return "base";
  return toks.join(" ");
}

/** Every reading of an old parallel, most literal first: the words as written,
 *  then with the finish family appended, then each progressively shorter
 *  strip of glued prefixes (each with its family forms). Duplicates removed. */
function parallelCandidates(parallel, subsetWords) {
  const out = [];
  const seen = new Set();
  const push = (p) => { const k = p || "base"; if (!seen.has(k)) { seen.add(k); out.push(k); } };
  const withFamilies = (p) => {
    push(p);
    const last = p.split(" ").pop();
    if (p !== "base" && !FAMILY_SUFFIXES.includes(last) && !/fractor$/.test(last) && !/^plates?$/.test(last)) for (const fam of FAMILY_SUFFIXES) push(`${p} ${fam}`);
  };
  let toks = words(String(parallel ?? "").replace(/\((rc|xrc)\)/gi, " "));
  while (toks.length > 1 && /^prizms?$/.test(toks[toks.length - 1])) toks.pop();
  withFamilies(toks.length ? toks.join(" ") : "base");
  for (let n = 1; n <= MAX_STRIP && n <= toks.length; n++) {
    if (!strippable(toks[n - 1], subsetWords)) break;
    const rest = toks.slice(n);
    if (rest.length) withFamilies(rest.join(" ")); else push("base");   // every word glued: the plain card
  }
  return out;
}

const exactKey = (r) => `${lc(r.cardNumber)}|${lc(r.parallel)}|${r.printRun ?? ""}`;
const normalizedKey = (r, subsetWords) => `${lc(r.cardNumber)}|${normalizeParallel(r.parallel, subsetWords)}|${r.printRun ?? ""}`;

/** The ids the ingest would mint for this identity -- isAuto both ways. */
function canonicalIds(product, row, parallel, slugOf) {
  const base = { sport: product.sport, year: Number(product.year), setKey: product.setKey, cardNumber: String(row.cardNumber), parallel: parallel && parallel !== "base" ? parallel : "Base", printRun: row.printRun ? Number(row.printRun) : null };
  const first = !!row.isAuto;
  return [slugOf({ ...base, isAuto: first }), slugOf({ ...base, isAuto: !first })].filter((id) => id && id.startsWith("hiq:"));
}

const ID_PREFIX_RX = /^(hiq:[^:]+:[^:]+:[^:]+:)/;
/** The canonical id prefixes (`hiq:sport:year:setKey:`) the product's old rows land under. */
function canonicalPrefixesOf(product, oldRows, slugOf) {
  const out = new Set();
  for (const r of oldRows) for (const id of canonicalIds(product, r, lc(r.parallel), slugOf)) { const m = id.match(ID_PREFIX_RX); if (m) out.add(m[1]); }
  return [...out];
}

let deps = null;
function defaultDeps() {
  if (!deps) {
    const dist = path.join(__dirname, "..", "..", "dist", "services");
    deps = {
      slugOf: require(path.join(dist, "portfolioiq", "hobbyIqCardId.service.js")).computeHobbyIqCardId,
      authorityOf: require(path.join(dist, "catalog", "catalogAuthority.service.js")).catalogAuthorityOf,
    };
  }
  return deps;
}

/** The retire's REPLACED_BY resolution, shared so the audit reads the same env. */
function resolveNewSource(env) {
  const scope = env.SCOPE && env.SCOPE !== "refractor" ? env.SCOPE : "";
  return String(env.NEW_SOURCE || env.REPLACED_BY || scope || "checklistcenter-2026-08-29").trim();
}

/** What counts as holding a key: any checklist-authority source that is not
 *  being retired (default), or the replacement label alone. */
function resolveCoverBy(env) {
  const v = String(env.COVER_BY || "").trim().toLowerCase();
  return v === "replacement" ? "replacement" : "any-checklist";
}

/**
 * Coverage of one product, pure: the old rows against `held` -- a Map of
 * canonical id -> source (or a function id -> source | undefined) of every
 * row that may cover an old one (already filtered to checklist authority and
 * to sources not being retired). `slugOf` mints ids the way the ingest does.
 */
function coverageOfRows(oldRows, product, held, slugOf, extra = {}) {
  const holderOf = typeof held === "function" ? held : (id) => held.get(id);
  // An old row with NO print run is a row whose ingester lost the run, not a
  // claim that the card is unnumbered: "Base" with no run meets the checklist's
  // "Base /25" (numbered Base is checklist-defined). Held ids without their
  // :num-N tail, for that second chance only.
  const runless = new Map();
  if (held instanceof Map) for (const [id, s] of held) { const k = id.replace(/:num-\d+$/, ""); if (!runless.has(k)) runless.set(k, s); }
  const runlessOf = (ids) => { for (const id of ids) { const s = runless.get(id.replace(/:num-\d+$/, "")); if (s) return s; } return null; };
  const subsetWords = subsetWordsOf([...oldRows, ...(extra.newRows ?? [])]);
  for (const w of typeLabelWordsOf(oldRows)) subsetWords.add(w);
  const seen = new Set();
  const uncovered = [];
  const heldBy = new Map();
  let coveredExact = 0, coveredNorm = 0, legendRows = 0;
  const hit = (ids) => { for (const id of ids) { const s = holderOf(id); if (s) return s; } return null; };
  for (const r of oldRows) {
    if (isLegend(r.parallel)) { legendRows++; continue; }
    const k = exactKey(r); if (seen.has(k)) continue; seen.add(k);
    const exact = lc(r.parallel) || "base";
    let holder = hit(canonicalIds(product, r, exact, slugOf));
    if (holder) { coveredExact++; coveredNorm++; heldBy.set(holder, (heldBy.get(holder) || 0) + 1); continue; }
    const candidates = parallelCandidates(r.parallel, subsetWords).filter((c) => c !== exact);
    // The old bcp/CLC scrapes filed the parallel name in subsetName and wrote
    // "Base" as the parallel ("Bowman Sterling Aqua Refractor" / Base /125 is
    // the Aqua Refractor): misfiled, not fabricated -- read it from there.
    if (exact === "base" && r.subsetName) for (const c of parallelCandidates(r.subsetName, subsetWords)) if (c !== "base" && !candidates.includes(c)) candidates.push(c);
    for (const cand of candidates) { holder = hit(canonicalIds(product, r, cand, slugOf)); if (holder) break; }
    if (!holder && !r.printRun) for (const cand of [exact, ...candidates]) { holder = runlessOf(canonicalIds(product, r, cand, slugOf)); if (holder) break; }
    if (holder) { coveredNorm++; heldBy.set(holder, (heldBy.get(holder) || 0) + 1); continue; }
    uncovered.push(k);
  }
  const keys = seen.size;
  return {
    sport: product.sport, year: product.year, setKey: product.setKey,
    oldRows: oldRows.length, newRows: extra.newRows ? extra.newRows.length : (extra.newRowCount ?? 0), keys, legendRows,
    coveredExact, coveredNorm,
    pctExact: keys ? (100 * coveredExact) / keys : 0,
    pctNorm: keys ? (100 * coveredNorm) / keys : 0,
    heldBy: [...heldBy.entries()].sort((a, b) => b[1] - a[1]),
    uncovered,
  };
}

const ROW_SQL = "SELECT c.cardNumber, c.parallel, c.printRun, c.subsetName, c.isAuto FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND NOT IS_DEFINED(c.gradeTier) AND ";
const HELD_SQL = "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p) AND NOT IS_DEFINED(c.gradeTier)";

// The held rows of a canonical prefix are shared by every product that
// collapses onto it (every 2025 Leaf product lands under `hiq:baseball:2025:
// leaf:`); a few are kept so a run does not re-read them per product.
const heldCache = new Map();
const HELD_CACHE_MAX = 6;
async function heldRowsOf(container, retry, prefix) {
  if (heldCache.has(prefix)) return heldCache.get(prefix);
  const rows = [];
  const it = container.items.query({ query: HELD_SQL, parameters: [{ name: "@p", value: prefix }] }, { maxItemCount: 5000 });
  for (;;) {
    const page = await retry(() => it.fetchNext());
    for (const r of page.resources ?? []) rows.push(r);
    if (!page.hasMoreResults) break;
  }
  if (heldCache.size >= HELD_CACHE_MAX) heldCache.delete(heldCache.keys().next().value);
  heldCache.set(prefix, rows);
  return rows;
}

/**
 * Coverage of one product: the old sources' identity rows against every
 * checklist-authority row at the product's canonical ids (COVER_BY=
 * any-checklist, default) or against the replacement label alone
 * (COVER_BY=replacement). `retry` wraps each query (throttling is the
 * caller's policy). Returns null when the old sources hold nothing.
 */
async function measureProductCoverage(container, retry, product, oldSources, newSource, opts = {}) {
  const { slugOf, authorityOf } = opts.deps ?? defaultDeps();
  const coverBy = opts.coverBy ?? resolveCoverBy(process.env);
  const params = [{ name: "@sp", value: product.sport }, { name: "@y", value: product.year }, { name: "@k", value: product.setKey }];
  const oldRows = (await retry(() => container.items.query({ query: ROW_SQL + "ARRAY_CONTAINS(@old, c.source)", parameters: [...params, { name: "@old", value: oldSources }] }, { maxItemCount: 5000 }).fetchAll())).resources;
  if (!oldRows.length) return null;
  const newRows = (await retry(() => container.items.query({ query: ROW_SQL + "c.source = @new", parameters: [...params, { name: "@new", value: newSource }] }, { maxItemCount: 5000 }).fetchAll())).resources;
  const held = new Map();
  const old = new Set(oldSources);
  for (const prefix of canonicalPrefixesOf(product, oldRows, slugOf)) {
    for (const r of await heldRowsOf(container, retry, prefix)) {
      if (old.has(r.source)) continue;
      if (coverBy === "replacement" ? r.source !== newSource : authorityOf(r.source) !== "checklist") continue;
      held.set(r.id, r.source);
    }
  }
  const c = coverageOfRows(oldRows, product, held, slugOf, { newRows });
  c.coverBy = coverBy;
  return c;
}

/** The (sport, year, setKey) products the old sources hold identity rows for, largest first. */
async function productsOf(container, retry, oldSources) {
  const { resources } = await retry(() => container.items.query({
    query: "SELECT c.sport, c.year, c.setKey, COUNT(1) AS n FROM c WHERE ARRAY_CONTAINS(@old, c.source) AND NOT IS_DEFINED(c.gradeTier) GROUP BY c.sport, c.year, c.setKey",
    parameters: [{ name: "@old", value: oldSources }],
  }, { maxItemCount: 5000 }).fetchAll());
  return resources.filter((p) => p.sport && p.year && p.setKey).sort((a, b) => b.n - a.n);
}

const heldByLine = (c) => (c.heldBy && c.heldBy.length ? `  held by ${c.heldBy.slice(0, 4).map(([s, n]) => `${s} ${n}`).join(", ")}${c.heldBy.length > 4 ? ` (+${c.heldBy.length - 4} more)` : ""}` : "");
const coverageLine = (c) => `${c.year} ${c.setKey} (${c.sport}): old ${c.oldRows} rows / ${c.keys} keys${c.legendRows ? ` (${c.legendRows} legend rows left out)` : ""}, new ${c.newRows} rows, covered exact ${c.coveredExact} (${c.pctExact.toFixed(0)}%) normalised ${c.coveredNorm} (${c.pctNorm.toFixed(0)}%)${c.newRows === 0 && !(c.heldBy && c.heldBy.length) ? "  <-- NOTHING HOLDS THIS PRODUCT" : ""}${heldByLine(c)}`;

module.exports = { normalizeParallel, parallelCandidates, subsetWordsOf, typeLabelWordsOf, exactKey, normalizedKey, canonicalIds, canonicalPrefixesOf, coverageOfRows, measureProductCoverage, productsOf, resolveNewSource, resolveCoverBy, coverageLine, isLegend, STRIP_WORDS, FINISH_WORDS, FAMILY_SUFFIXES };
