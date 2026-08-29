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
 * TWO KEYS PER ROW. Exact: (cardNumber, parallel, printRun), lower-cased.
 * Normalised: the same with the parallel stripped of a leading subset word the
 * product itself names ("chrome prospects gold refractor" -> "gold refractor"),
 * of "auto"/"autograph(s)", "(rc)"/"(xrc)", "prizm(s)" (leading or trailing)
 * and "paper"/"set"/"base" prefixes -- the glued-prefix shapes the old
 * ingesters produced ("prizms blue", "set concourse gold prizms", "auto crystal
 * ..."). A colour or finish word is never stripped, whatever the subset names:
 * a "Gold Rush" insert must not turn "Gold Refractor" into "Refractor".
 *
 * Read-only. Every function here queries; none writes.
 */
const STRIP_WORDS = new Set(["auto", "autos", "autograph", "autographs", "autographed", "prizm", "prizms", "paper", "set", "base", "rc", "xrc", "rookie", "rookies", "insert", "inserts", "variation", "variations"]);
const FINISH_WORDS = new Set(["black", "gold", "silver", "blue", "red", "green", "orange", "purple", "pink", "yellow", "aqua", "teal", "magenta", "fuchsia", "bronze", "platinum", "white", "rainbow", "refractor", "refractors", "superfractor", "xfractor", "x-fractor", "prizm", "prizms", "wave", "shimmer", "lava", "mojo", "holo", "foil", "sapphire", "speckle", "sparkle", "atomic", "pulsar", "ice", "flash", "geometric", "raywave", "sepia", "negative", "mini", "plates", "plate", "printing", "camo", "disco", "cracked", "neon", "vinyl", "finite", "laser", "border", "die", "cut", "1/1"]);

const lc = (v) => String(v ?? "").toLowerCase().trim();
const words = (v) => lc(v).replace(/[^a-z0-9/]+/g, " ").trim().split(" ").filter(Boolean);

/** The product's own subset vocabulary: every word of every subsetName seen on
 *  either side that is not a colour/finish word. */
function subsetWordsOf(rows) {
  const out = new Set();
  for (const r of rows) for (const w of words(r.subsetName)) if (!FINISH_WORDS.has(w)) out.add(w);
  return out;
}

function normalizeParallel(parallel, subsetWords) {
  let toks = words(String(parallel ?? "").replace(/\((rc|xrc)\)/gi, " "));
  let n = 0;
  // STRIP_WORDS is the explicit list (it names prizm/prizms on purpose);
  // subsetWords never holds a colour or finish word (subsetWordsOf).
  while (toks.length > 1 && n < 4 && (STRIP_WORDS.has(toks[0]) || subsetWords.has(toks[0]))) { toks.shift(); n++; }
  while (toks.length > 1 && /^prizms?$/.test(toks[toks.length - 1])) toks.pop();
  return toks.join(" ");
}

const exactKey = (r) => `${lc(r.cardNumber)}|${lc(r.parallel)}|${r.printRun ?? ""}`;
const normalizedKey = (r, subsetWords) => `${lc(r.cardNumber)}|${normalizeParallel(r.parallel, subsetWords)}|${r.printRun ?? ""}`;

const ROW_SQL = "SELECT c.cardNumber, c.parallel, c.printRun, c.subsetName FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND NOT IS_DEFINED(c.gradeTier) AND ";

/**
 * Coverage of one product: the old sources' identity rows against the new
 * source's. `retry` wraps each query (throttling is the caller's policy).
 * Returns null when the old sources hold nothing for the product.
 */
async function measureProductCoverage(container, retry, product, oldSources, newSource) {
  const params = [{ name: "@sp", value: product.sport }, { name: "@y", value: product.year }, { name: "@k", value: product.setKey }];
  const oldRows = (await retry(() => container.items.query({ query: ROW_SQL + "ARRAY_CONTAINS(@old, c.source)", parameters: [...params, { name: "@old", value: oldSources }] }, { maxItemCount: 5000 }).fetchAll())).resources;
  if (!oldRows.length) return null;
  const newRows = (await retry(() => container.items.query({ query: ROW_SQL + "c.source = @new", parameters: [...params, { name: "@new", value: newSource }] }, { maxItemCount: 5000 }).fetchAll())).resources;
  const subsetWords = subsetWordsOf([...oldRows, ...newRows]);
  const haveExact = new Set(newRows.map(exactKey)), haveNorm = new Set(newRows.map((r) => normalizedKey(r, subsetWords)));
  const oldExact = new Set(oldRows.map(exactKey));
  const uncovered = [];
  let coveredExact = 0, coveredNorm = 0;
  const seenNorm = new Set();
  for (const r of oldRows) {
    const k = exactKey(r); if (seenNorm.has(k)) continue; seenNorm.add(k);
    if (haveExact.has(k)) { coveredExact++; coveredNorm++; continue; }
    if (haveNorm.has(normalizedKey(r, subsetWords))) { coveredNorm++; continue; }
    uncovered.push(k);
  }
  const keys = oldExact.size;
  return {
    sport: product.sport, year: product.year, setKey: product.setKey,
    oldRows: oldRows.length, newRows: newRows.length, keys,
    coveredExact, coveredNorm,
    pctExact: keys ? (100 * coveredExact) / keys : 0,
    pctNorm: keys ? (100 * coveredNorm) / keys : 0,
    uncovered,
  };
}

/** The (sport, year, setKey) products the old sources hold identity rows for, largest first. */
async function productsOf(container, retry, oldSources) {
  const { resources } = await retry(() => container.items.query({
    query: "SELECT c.sport, c.year, c.setKey, COUNT(1) AS n FROM c WHERE ARRAY_CONTAINS(@old, c.source) AND NOT IS_DEFINED(c.gradeTier) GROUP BY c.sport, c.year, c.setKey",
    parameters: [{ name: "@old", value: oldSources }],
  }, { maxItemCount: 5000 }).fetchAll());
  return resources.filter((p) => p.sport && p.year && p.setKey).sort((a, b) => b.n - a.n);
}

/** The retire's REPLACED_BY resolution, shared so the audit reads the same env. */
function resolveNewSource(env) {
  const scope = env.SCOPE && env.SCOPE !== "refractor" ? env.SCOPE : "";
  return String(env.NEW_SOURCE || env.REPLACED_BY || scope || "checklistcenter-2026-08-29").trim();
}

const coverageLine = (c) => `${c.year} ${c.setKey} (${c.sport}): old ${c.oldRows} rows / ${c.keys} keys, new ${c.newRows} rows, covered exact ${c.coveredExact} (${c.pctExact.toFixed(0)}%) normalised ${c.coveredNorm} (${c.pctNorm.toFixed(0)}%)${c.newRows === 0 ? "  <-- NEW SOURCE HAS NOTHING" : ""}`;

module.exports = { normalizeParallel, subsetWordsOf, exactKey, normalizedKey, measureProductCoverage, productsOf, resolveNewSource, coverageLine, STRIP_WORDS, FINISH_WORDS };
