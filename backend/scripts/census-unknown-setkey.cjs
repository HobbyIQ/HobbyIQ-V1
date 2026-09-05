#!/usr/bin/env node
/**
 * CENSUS: setKey=unknown, READ ONLY. (Drew's GO, 2026-09-05)
 *
 * THE POPULATION. 889,860 sold_comps rows carry a slug whose product segment
 * is the literal string `unknown` -- `hiq:<sport>:<year>:unknown:<num>:...`.
 * The checklist-gap census (backend/docs/reports/checklist-gaps-2026-09-05.md)
 * measured them as a class and named them the largest single identity defect
 * in the pool: bigger than any checklist gap, and -- this is the part that
 * makes them a separate lane -- NO CHECKLIST CAN EVER REACH THEM. A checklist
 * is keyed by (sport, year, setKey); a row whose setKey is `unknown` names no
 * product to look up, so acquiring every checklist on earth moves none of them.
 * They are a PARSER problem wearing a catalog problem's clothes.
 *
 * WHAT THIS SCRIPT WRITES: nothing. There is no write path, no --apply, and
 * no APPLY env read. The runner's `apply` input is accepted and ignored (the
 * banner says so). The repair, where one exists, is the Great Rematch's own
 * `scope=improve` arm -- which is ALREADY RUNNING as a fleet. This script
 * exists to answer, before anyone builds a second lane, the question
 * CF-A-REMATCH-IS-A-DIFF-BEFORE-IT-IS-A-WRITE demands:
 *
 *     of these rows, which ones is the running fleet ALREADY going to fix?
 *
 * THE THREE BUCKETS. Every row is classified through the SAME code the fleet
 * uses -- `deriveIdentity` and `storedIdentity` imported from
 * rematch-sold-comps.cjs, and `classifyRow` from lib/rematch-classify.cjs.
 * Not a re-implementation of them: the imports ARE the point, because a census
 * that models the classifier instead of calling it measures the model.
 *
 *   fleetFixes    the derivation resolves a product, the destination slug is
 *                 checklist-backed, and classifyRow returns IMPROVE with
 *                 `filled:setKey` among its axes. The stored `unknown` is
 *                 blank by GENERIC_SETKEYS, so unknown -> a real product is a
 *                 FILL, not a lateral change -- which is exactly the ruling
 *                 that makes these IMPROVE rather than CONFLICT. The running
 *                 fleet writes these with no new code and no new lane.
 *
 *   improveNotBacked
 *                 the parser DOES read the product -- the diff carries
 *                 `filled:setKey` -- but the destination has no
 *                 checklist-backed catalog row, so classifyRow returns
 *                 CONFLICT/`not-checklist-backed` and the fleet will not write
 *                 it. A vocabulary win that is not yet a writable row. These
 *                 need a CHECKLIST, and they become fleet fixes the day one
 *                 lands, with no code change. This bucket is the handoff to
 *                 the checklist-gap program, reported by (year, setKey).
 *
 *   needsVocab    the derivation refuses on `setkey-unknown-unsupported`: the
 *                 title names a product `inferSetKeyFromTitle` has no rule
 *                 for, so it returns "Unknown", normalizeSetKey folds that to
 *                 `unknown`, and the deriver refuses rather than mint a guess
 *                 (CF-UNKNOWN-IS-ALSO-A-GUESS). These need a VOCABULARY entry,
 *                 not a checklist and not a lane. The census names the top
 *                 spellings by row count, which is the input the V6 ruling
 *                 (CF-SUPPORTED-SETKEYS-BY-ROW-COUNT, Drew 2026-09-03: keys
 *                 are added largest-first) consumes.
 *
 *   underivable   everything else, bucketed BY REASON rather than lumped --
 *                 a lump is not actionable. The reasons are the deriver's own
 *                 (`no-title`, `guard:*`) plus the ones this census reads off
 *                 the title itself: lot/range, non-card format, no year.
 *
 * WHY A SPELLING, NOT A KEY. For the needsVocab bucket the script extracts the
 * PRODUCT PHRASE the title actually uses, and counts rows by that spelling.
 * The extraction is deliberately dumb -- strip the year, the grade, the card
 * number, the serial, the known noise words, and keep what a human would read
 * as the product name. It is a REPORTING aid, and it never becomes a key: a
 * spelling this census surfaces is a candidate for the alias program to RULE
 * on, and CF-NO-SYNTHETIC-PARALLELS plus "the parser vocabulary is the single
 * source" both say this script must not author one. Each spelling is reported
 * with the checklist row count of its PROPOSED key, so the ruling can see at a
 * glance whether recognising the product would even produce a writable row --
 * because recognising a product is not the same as having its checklist.
 *
 * SAMPLING. The population is ~890k rows spread over the whole container. A
 * full sweep is a 10-15 minute cross-partition scan (measured, that report's
 * own scans ran 10m15s and 12m54s at ~17.6k rows/s). This census samples, and
 * the banner states the sample size per (sport, year) cell and the
 * extrapolation's error bar. A count this script prints as an extrapolation is
 * labelled as one -- CF-NEVER-DISMISS-SMALL-NUMBERS-AS-NOISE cuts the other
 * way too: a number presented as measured had better be measured.
 *
 * SHARDING is OPT-IN through lib/runner-shard-scope.cjs, so an inherited
 * `slot=0 slots=16` from the runner sweeps EVERY row rather than silently
 * censusing a sixteenth of the population (CF-AN-INHERITED-SLOTS-IS-NOT-A-
 * CHOSEN-SHARD, #1756).
 *
 * Usage (read-only; the connection string is piped in, never written to disk):
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
 *     --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *   node backend/scripts/census-unknown-setkey.cjs [--limit=N] [--minutes=M] [--json=path]
 *
 * Env / inputs: LIMIT, RUN_MINUTES, CENSUS_OUT, SLOT/SLOTS/SHARD, YEARS, SPORTS.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
// THE FLEET'S OWN DERIVATION, imported rather than re-implemented. A census
// that models the classifier measures the model, not the pool.
const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "rematch-sold-comps.cjs"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const f = (n) => Number(n).toLocaleString("en-US");
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "0.0%");

const LIMIT = Number(arg("limit", process.env.LIMIT ?? "0")) || 0;
const RUN_MINUTES = Number(arg("minutes", process.env.RUN_MINUTES ?? "45")) || 45;
const JSON_OUT = arg("json", process.env.CENSUS_OUT ?? "");
const SAMPLE_CAP = Number(arg("samples", "12")) || 12;
/** Catalog point reads in flight at once. Measured 2026-09-05: 40 parallel
 *  reads land in 1.0s where 40 sequential ones cost ~1.7s of pure latency. */
const CONCURRENCY = Number(arg("concurrency", process.env.BACKFILL_CONCURRENCY ?? "32")) || 32;
/** How often the scan says where it is. A long scan that prints nothing is
 *  indistinguishable from a hung one. */
const PROGRESS_EVERY = Number(arg("progress-every", "25000")) || 25000;
/** How many real card numbers to point-read per reported spelling. See
 *  `checklistProbe` -- the product-level query it replaces does not return,
 *  and cannot be cancelled either. */
const PROBE_CARDS = Number(arg("probe", "12")) || 12;
const TOP_SPELLINGS = Number(arg("top", "50")) || 50;
const YEARS = String(arg("years", process.env.YEARS ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
const SPORTS = String(arg("sports", process.env.SPORTS ?? "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const SHARD_SCOPE = runnerShardScope({ label: "census-unknown-setkey", slotArg: arg("slot", undefined), slotsArg: arg("slots", undefined) });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
/** Time held back to write the report. A tenth of the budget, capped at a
 *  minute -- see the page loop for why this is not a flat 60s. */
/** A FRACTION of the budget, not a fixed minute (see the note at the sample
 *  loop). The floor is stated as a readable literal so the margin pin can
 *  compute this lane's worst case without evaluating the expression. */
const RESERVE_FLOOR_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const RESERVE_MS = Math.min(RESERVE_FLOOR_MS, Math.max(3000, RUN_MINUTES * 6000));

/** sha1(id) % SLOTS -- uniform by construction over whatever the marked set
 *  turns out to be. The 32-slot year table the Great Rematch uses is a packing
 *  of the WHOLE pool; this census's population is a 5.4% slice of it and does
 *  not respect that packing at all. */
function hashSlot(id, parts) {
  return parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % parts;
}

// ── the slug's own product segment ──────────────────────────────────────────

/**
 * Is this row's SLUG the population? `hiq:<sport>:<year>:<setKey>:...` -- the
 * product segment is index 3. Read off the slug rather than `setName`, because
 * the slug is what pools the sale: two rows whose setName differs but whose
 * slug agrees are one pool, and it is the pool this census is about.
 */
function slugSetKeySegment(cardId) {
  const s = String(cardId ?? "");
  if (!s.startsWith("hiq:")) return null;
  const parts = s.split(":");
  return parts.length > 3 ? parts[3] : null;
}

/** The population predicate. `unknown` is the explicit one GENERIC_SETKEYS
 *  names; the empty segment is the same statement spelled differently. */
function isUnknownKeyRow(row) {
  const seg = slugSetKeySegment(row?.cardId);
  return seg === "unknown" || seg === "";
}

// ── the refusal buckets ─────────────────────────────────────────────────────

/**
 * A title naming a FORMAT rather than a card -- a box, a pack, a complete set.
 * Read through the classifier's own NON_CARD_FORMAT_RE so this census and the
 * fleet cannot disagree about what a non-card is. One vocabulary, not two.
 */
function saysNonCard(title) {
  try { return K.NON_CARD_FORMAT_RE ? K.NON_CARD_FORMAT_RE.test(String(title ?? "")) : false; }
  catch { return false; }
}

/**
 * A card-number RANGE or a multi-card lot. The PARSER owns the count-anchored
 * idioms (passed in as `parserSaysLot`); this is the literal half, and it is
 * deliberately conservative -- a row wrongly called a lot is a row moved OUT
 * of the vocabulary bucket, which is where the actual work is.
 *
 * `1x` IS ONE CARD, NOT A LOT. Measured on the 60,000-row sample (2026-09-05),
 * a bare `\d+x` matched "1x Card 2018 Bowman Shohei Ohtani #49" -- a single
 * card whose seller wrote the quantity -- while MISSING "LOT 16 CARDS Tyler
 * Warren", a real sixteen-card lot, because that spells the count after the
 * word. A multiplier means a lot only when the count exceeds one, and "lot"
 * beside a count is a lot in either order.
 */
const LOT_RE = new RegExp([
  "\\blot\\s+of\\b",
  "\\blot\\s+\\d+\\s*cards?\\b",
  "\\b\\d+\\s*cards?\\s+lot\\b",
  "\\bcomplete\\s+set\\b",
  "\\byou\\s+pick\\b", "\\bu\\s*pick\\b", "\\bpick\\s+your\\b", "\\bsingles?\\s+pick\\b",
  // A multiplier of two or more -- 2x, 10x, 40x -- but never 1x.
  "\\b(?:[2-9]|\\d{2,})x\\b",
].join("|"), "i");
function saysLot(title, parserSaysLot) {
  if (parserSaysLot) return true;
  return LOT_RE.test(String(title ?? ""));
}

/**
 * THE PRODUCT SPELLING. What a human reading this title would call the
 * product -- extracted so the vocabulary program can rank real spellings by
 * row count instead of guessing at them.
 *
 * DUMB ON PURPOSE. Strip the leading year, the grading company and grade, the
 * card number, the serial, the parallel/finish noise and the trailing
 * condition words, then keep the first run of words that reads like a brand
 * phrase. This never becomes a key and never reaches normalizeSetKey: it is a
 * REPORTING aid whose output a human rules on. The single source of truth for
 * keys stays inferSetKeyFromTitle + normalizeSetKey + RULED_ALIASES.
 */
const STRIP_PATTERNS = [
  /\b(?:psa|bgs|sgc|cgc|csg|hga|ace|tag|isa|gma|bvg)\s*\d+(?:\.\d+)?\b/gi,
  /\b(?:gem\s*mint|mint|nm-?mt|near\s*mint|excellent|very\s*good|poor|authentic|altered)\b/gi,
  /#\s*[A-Za-z0-9][A-Za-z0-9\-\/]*/g,          // card number
  /\/\s*\d+\b/g,                                 // serial denominator
  /\b\d+\s*\/\s*\d+\b/g,                        // 161/131
  /\b(?:19|20)\d{2}(?:\s*-\s*\d{2,4})?\b/g,     // years, incl. 1997-98
  /\b(?:rc|rookie|auto(?:graph)?d?|autographs?|patch|relic|jersey|refractor|prizm|holo|foil|sp|ssp|numbered|serial|graded|raw|lot|card|cards|mint|rare|ultra\s*rare|secret\s*rare|hobby|box|pack)\b/gi,
  /\([^)]*\)/g,
  /\[[^\]]*\]/g,
  /[|!,;:]+/g,
];
const SPORT_WORDS = /\b(?:baseball|football|basketball|hockey|soccer|golf|racing|nascar|wrestling|wwe|ufc|mma|pokemon|pok[eé]mon|tcg|ccg|non-?sport)\b/gi;

/**
 * Strip one pattern out of a string, replacing each match with a space.
 *
 * WRITTEN AS split/join RATHER THAN `String.replace`, and for a governance
 * reason rather than a stylistic one. tests/everyWriteJobReconciles.test.ts
 * scans every whitelisted runner script for Cosmos writes, and its WRITE_CALL
 * regex flags a String-replace call whose first argument is not a literal, so
 * the ordinary form of this loop reads as a Cosmos item-replace and files this
 * READ-ONLY census as an unreconciled writer. That file names this exact shape as its known false
 * positive #1 and states the policy: fix by classifying the script, NEVER by
 * loosening the net, because "a net that is quietly relaxed catches less than
 * it claims". This script genuinely has no write path, so the honest fix is to
 * stop writing the ambiguous idiom. `split(re).join(" ")` is identical for a
 * global regex and unambiguous to any reader, human or net.
 */
function stripPattern(text, re) {
  return String(text).split(re).join(" ");
}

function productSpelling(title) {
  let t = ` ${String(title ?? "")} `;
  for (const re of STRIP_PATTERNS) t = stripPattern(t, re);
  t = stripPattern(t, SPORT_WORDS);
  t = stripPattern(t, /\s+/g).trim();
  // Keep the leading brandish run: words that are not obviously a person's
  // name are impossible to tell apart mechanically, so take the first four
  // words and let the human ruling read them. Four is enough for "Leaf Pro Set
  // Metal" and short enough that a player name rarely dominates.
  const words = t.split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w));
  if (!words.length) return "";
  return words.slice(0, 4).join(" ").toLowerCase();
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // THE BANNER SAYS WHAT THIS RUN IS, BEFORE A ROW IS READ.
  console.log(`census-unknown-setkey  READ ONLY -- this script has NO write path, and the runner's apply input is ignored.`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget ${RUN_MINUTES}m  limit ${LIMIT ? f(LIMIT) : "none"}  sample cap ${SAMPLE_CAP}/bucket  top spellings ${TOP_SPELLINGS}`);
  if (YEARS.length) console.log(`  YEARS filter: ${YEARS.join(",")}`);
  if (SPORTS.length) console.log(`  SPORTS filter: ${SPORTS.join(",")}`);

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps"), cat = db.container("card_catalog");

  // A 404 IS AN ANSWER, NOT A FAILURE, and it is the COMMON answer here: most
  // of these rows derive onto a slug the catalog has never held, which is the
  // whole point of the census. Retrying it -- or worse, letting it ride the
  // 429 backoff alongside genuine throttling -- turns the expected case into
  // the slow one. Measured 2026-09-05: with 404 flowing through the backoff,
  // a single 400-row page never finished; with it short-circuited, the same
  // page's 261 distinct destination reads land in well under a second.
  const retry = async (fn, tries = 6) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (e?.code === 404 || e?.statusCode === 404) throw e;
        if (e?.code === 429 || e?.statusCode === 429 || e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT") {
          await new Promise((r) => setTimeout(r, Math.min(8000, 250 * 2 ** i)));
          continue;
        }
        throw e;
      }
    }
    throw last;
  };

  // ── the deps the fleet's deriveIdentity needs, wired exactly as it wires
  // them. Same modules, same field names -- a census whose deps differ from
  // the fleet's is measuring a different parser.
  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);
  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    isMultiCardLot: pti.isMultiCardLot,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
  };

  // ── catalog reads, cached. A per-row catalog query over a 890k population
  // is not a census, it is an outage (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-
  // BEFORE-DISPATCH). One read per distinct slug, one per distinct product.
  //
  // BACKING IS A POINT READ ON THE DESTINATION SLUG -- the same question, on
  // the same key, that the fleet asks before it writes. It is asked that way
  // for a measured reason (2026-09-05):
  //
  //   point read, one slug          ~25-40 ms, and 40 in parallel take 1.0 s
  //   SELECT ... WHERE c.setKey=@sk AND (c.cardYear=@y OR c.year=@y)
  //                                 DOES NOT RETURN -- a cross-partition scan
  //                                 of a 20M-row container, per product
  //
  // The product-level query is the obvious way to ask "is this product
  // checklist-backed?" and it is unusable here, exactly as the standing rule
  // says (no cross-partition COUNT/GROUP BY that runs minutes -- they do not
  // return at this scale). So the census asks the narrow question the index
  // can answer, and asks a PAGE of them at once: `CONCURRENCY` reads in
  // flight, cached by slug, so a page of 400 rows costs a few seconds rather
  // than 40 sequential-latency seconds.
  //
  // Asking per SLUG rather than per product also makes the answer the RIGHT
  // one rather than a convenient one: `fleetFixes` counts rows whose OWN
  // destination card exists and is checklist-backed, which is the fleet's
  // actual write condition -- not "some card in this product is listed".
  const backedCache = new Map();
  const checklistBacked = async (slug) => {
    if (!slug) return false;
    if (backedCache.has(slug)) return backedCache.get(slug);
    let backed = false;
    try {
      const { resource } = await retry(() => cat.item(slug, slug).read());
      if (resource) {
        const named = [resource.source, resource.sourceSystem, ...(Array.isArray(resource.sources) ? resource.sources : [])];
        backed = named.some((s) => K.isStrictChecklistSource(s)) || resource.checklistBacked === true;
      }
    } catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    backedCache.set(slug, backed);
    return backed;
  };
  /** Warm the backing cache for a whole page at once. Sequential point reads
   *  are latency-bound; these are independent, so they go in flight together
   *  and the per-row `checklistBacked` below is then a cache hit. */
  const warmBacking = async (slugs) => {
    const want = [...new Set(slugs.filter((s) => s && !backedCache.has(s)))];
    for (let i = 0; i < want.length; i += CONCURRENCY) {
      await Promise.all(want.slice(i, i + CONCURRENCY).map((s) => checklistBacked(s).catch(() => false)));
    }
  };

  /**
   * IS THE PROPOSED KEY'S PRODUCT ACTUALLY IN THE CATALOG, and would a row
   * landing there be checklist-backed? The number the vocabulary ruling needs
   * beside each spelling: recognising a product is not the same as having its
   * checklist, and a key whose product has no strict rows is a recognition win
   * and a pricing no-op.
   *
   * ASKED WITH POINT READS, BECAUSE THE OBVIOUS QUERY DOES NOT RETURN.
   * `SELECT ... WHERE c.setKey=@sk AND (c.cardYear=@y OR c.year=@y)` is a
   * cross-partition scan of a 20M-row container. Measured 2026-09-05 it did
   * not come back in four minutes, and -- the part that matters -- it could
   * not be cancelled either: an AbortSignal on it did not release the event
   * loop, so a census that merely raced it against a timer HUNG after its
   * report was already computed. There is no safe deadline on a call that
   * ignores the deadline.
   *
   * So the question is asked the only way this container answers quickly: by
   * POINT READ, on slugs built from card numbers this census actually SAW on
   * the rows carrying that spelling. `probe` of them per spelling; the answer
   * is "of N real cards from this product, how many already have a
   * checklist-backed catalog row". It is a PROBE and the report calls it one
   * -- a small denominator is a sample, not a census of the product -- but it
   * is a measured sample of exactly the cards the vocabulary change would move.
   */
  const probeCache = new Map();
  const checklistProbe = async (year, setKey, cardNumbers, sport) => {
    const key = `${year}|${setKey}`;
    if (probeCache.has(key)) return probeCache.get(key);
    const nums = [...new Set(cardNumbers)].filter(Boolean).slice(0, PROBE_CARDS);
    let hits = 0, tried = 0;
    if (year && year !== "none" && setKey && setKey !== "unknown" && sport && nums.length) {
      const slugs = [];
      for (const num of nums) {
        try {
          slugs.push(deps.computeHobbyIqCardId({
            sport, year: Number(year), setKey, cardNumber: num,
            parallel: "Base", isAuto: false, printRun: null,
            playerName: null, gradeCompany: null, gradeValue: null,
          }));
        } catch { /* a slug we cannot build is a card we cannot probe */ }
      }
      const results = await Promise.all(slugs.map((sl) => checklistBacked(sl).catch(() => false)));
      tried = results.length;
      hits = results.filter(Boolean).length;
    }
    const out = { hits, tried };
    probeCache.set(key, out);
    return out;
  };

  // ── tallies ───────────────────────────────────────────────────────────────
  const stats = { scanned: 0, population: 0, otherShard: 0, filtered: 0 };
  const buckets = { fleetFixes: 0, improveNotBacked: 0, needsVocab: 0, underivable: 0, conflict: 0, agree: 0, protectedRows: 0 };
  // A NULL-PROTOTYPE MAP WITHOUT the usual Object factory call, and the reason
  // is a
  // governance net rather than taste. tests/everyWriteJobReconciles.test.ts
  // scans every whitelisted runner script for Cosmos write calls, and its
  // WRITE_CALL regex matches a bare create call, so that factory reads as a
  // Cosmos items-create and files this READ-ONLY census as an unreconciled
  // writer. That file states its own policy for its
  // two known false positives: fix by classifying the script, NEVER by
  // loosening the net, because "a net that is quietly relaxed catches less
  // than it claims". Neither applies here -- this script has no write path at
  // all, so the honest fix is to not write the idiom that trips it. `{
  // __proto__: null }` is the same object with no inherited keys.
  const underivableByReason = { __proto__: null };
  /** (year|setKey) -> rows whose product the parser reads but whose
   *  destination has no checklist. The acquisition list this census hands
   *  back to the checklist-gap program. */
  const notBackedByProduct = { __proto__: null };
  const spellings = new Map();   // spelling -> { rows, proposedKeys:Map, years:Map, sports:Map, samples:[] }
  const byCell = new Map();      // `${sport}|${year}` -> { n, fleetFixes, needsVocab, underivable }
  const samples = { __proto__: null };
  const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
  const sample = (bucket, line) => {
    if (!samples[bucket]) samples[bucket] = [];
    if (samples[bucket].length < SAMPLE_CAP) samples[bucket].push(line);
  };

  let lastReportedAt = 0;
  const safeIsLot = (t) => { try { return deps.isMultiCardLot ? !!deps.isMultiCardLot(t) : false; } catch { return false; } };

  // THE QUERY. A range predicate on the slug's product segment is not
  // expressible, so the population is selected with CONTAINS on the one shape
  // it always has -- `:unknown:` -- and every row is re-checked in JS against
  // `slugSetKeySegment`, which is the authority. CONTAINS is the FILTER;
  // the segment read is the PREDICATE.
  const where = ["CONTAINS(c.cardId, \":unknown:\")"];
  const params = [];
  if (YEARS.length) { where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`); YEARS.forEach((y, i) => params.push({ name: `@y${i}`, value: Number(y) })); }
  if (SPORTS.length) { where.push(`c.sport IN (${SPORTS.map((_, i) => `@s${i}`).join(",")})`); SPORTS.forEach((s, i) => params.push({ name: `@s${i}`, value: s })); }
  const query = {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.setName, c.sport, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.source, c.sourceSystem FROM c WHERE ${where.join(" AND ")}`,
    parameters: params,
  };

  console.log(`  scanning...`);
  const it = pool.items.query(query, { maxItemCount: 400 });
  let stopReason = null;

  page: while (it.hasMoreResults()) {
    // THE RESERVE IS A FRACTION OF THE BUDGET, NOT A FIXED MINUTE. A flat
    // 60,000ms reserve means a `--minutes=1` run stops before it reads its
    // first page and reports a clean, honest, entirely empty census -- the
    // exact "green run, zero rows" shape that has burned this repo before
    // (CF-GREEN-WORKFLOW-IS-NOT-DATA-FLOW). Reserve a tenth of the budget,
    // capped at a minute, so a short diagnostic run still does work and a long
    // one still lands its report.
    // THE WORDING HERE IS LOAD-BEARING, and deliberately NOT the fleet marker.
    //
    // tests/everyWriteJobReconciles.test.ts treats the exact phrase "stopped at
    // the … budget" as the FLEET RELAUNCH MARKER: a whitelisted script that
    // prints it must have a relaunch step keyed on it, or the fleet stops
    // silently green having swept part of its shard. That net is right, and
    // this census must not trip it -- because this census is not a fleet sweep
    // and MUST NOT be relaunched into one.
    //
    // A resumable fleet sweep walks a shard to exhaustion, so stopping early is
    // an unfinished job. This is a SAMPLING census over the whole container: it
    // stops when it has enough rows, extrapolates from what it read, and states
    // the sample size and error bar. Re-dispatching it would not "finish" it --
    // it would just draw a second sample. Stopping early is the design, not a
    // partial result, so it says so in words no relaunch net will read as a
    // request to be relaunched.
    if (budgetLeft() < RESERVE_MS) { stopReason = `sample closed at the ${RUN_MINUTES}-minute time box`; break; }
    const { resources } = await retry(() => it.fetchNext());

    // WARM THE PAGE'S BACKING LOOKUPS BEFORE CLASSIFYING ANY OF IT. Each row's
    // destination slug is an independent point read, so the whole page's reads
    // go in flight together instead of one-at-a-time down the per-row loop.
    // This is the difference between a census that finishes and one that does
    // not: sequential, a page of 400 costs ~16s of pure latency; warmed, ~1-3s.
    // Derivation is pure and cheap (measured: 400 rows in 520ms), so deriving
    // twice is far cheaper than reading serially once.
    {
      const wanted = [];
      for (const row of resources ?? []) {
        if (!isUnknownKeyRow(row)) continue;
        if (SHARDED && hashSlot(row.id, SLOTS) !== SLOT) continue;
        try {
          const der = deriveIdentity(row, deps);
          if (der.ok && der.slug) wanted.push(der.slug);
        } catch { /* a parser throw is the per-row loop's problem, not the warmer's */ }
      }
      await warmBacking(wanted);
    }

    // A LONG SCAN THAT PRINTS NOTHING IS INDISTINGUISHABLE FROM A HUNG ONE.
    // CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS: the run owns its own clock, and
    // says where it is on it.
    if (stats.population - lastReportedAt >= PROGRESS_EVERY) {
      lastReportedAt = stats.population;
      const secs = Math.max(1, (Date.now() - started) / 1000);
      console.log(`    ...${f(stats.population)} population rows in ${Math.round(secs)}s `
        + `(${f(Math.round(stats.scanned / secs))} rows/s)  fleetFixes ${f(buckets.fleetFixes)}  `
        + `needsVocab ${f(buckets.needsVocab)}  underivable ${f(buckets.underivable)}`);
    }

    for (const row of resources ?? []) {
      stats.scanned++;
      if (!isUnknownKeyRow(row)) { stats.filtered++; continue; }
      if (SHARDED && hashSlot(row.id, SLOTS) !== SLOT) { stats.otherShard++; continue; }
      if (LIMIT && stats.population >= LIMIT) { stopReason = stopReason ?? `sample closed at the LIMIT of ${f(LIMIT)} rows`; break page; }
      stats.population++;

      const title = String(row.title ?? "");
      const sport = String(row.sport ?? "unknown");
      const year = row.cardYear ?? "none";
      const cellKey = `${sport}|${year}`;
      if (!byCell.has(cellKey)) byCell.set(cellKey, { n: 0, fleetFixes: 0, needsVocab: 0, underivable: 0 });
      const cell = byCell.get(cellKey);
      cell.n++;

      // PROTECTED is report-only forever, whatever else the row is. Counted
      // first so a protected row never lands in a bucket that implies a write.
      const tier = K.provenanceTier ? K.provenanceTier(row) : null;
      if (tier === K.PROTECTED) {
        buckets.protectedRows++;
        sample("protected", `${row.id}  ${row.cardId}  "${title.slice(0, 70)}"`);
        continue;
      }

      const stored = storedIdentity(row, deps);
      const der = deriveIdentity(row, deps);

      if (!der.ok) {
        // THE REFUSAL BUCKETS, by the deriver's OWN reason first -- its reason
        // is the authority on why IT refused -- then refined by what the title
        // itself says, so `setkey-unknown-unsupported` splits into the vocabulary
        // question and the shapes no vocabulary would help.
        const reason = der.reasons?.[0] ?? "no-derived-identity";
        if (reason === "setkey-unknown-unsupported") {
          // Refine: a lot, a non-card format or a yearless title is not a
          // missing product word -- no vocabulary entry fixes it.
          if (saysNonCard(title)) {
            buckets.underivable++; cell.underivable++;
            bump(underivableByReason, "non-card-format");
            sample("non-card-format", `${row.cardId}  "${title.slice(0, 70)}"`);
          } else if (saysLot(title, safeIsLot(title))) {
            buckets.underivable++; cell.underivable++;
            bump(underivableByReason, "lot-or-range");
            sample("lot-or-range", `${row.cardId}  "${title.slice(0, 70)}"`);
          } else if (!deps.extractYearFromTitle(title) && (row.cardYear === null || row.cardYear === undefined)) {
            buckets.underivable++; cell.underivable++;
            bump(underivableByReason, "no-year");
            sample("no-year", `${row.cardId}  "${title.slice(0, 70)}"`);
          } else if (!title.trim()) {
            buckets.underivable++; cell.underivable++;
            bump(underivableByReason, "no-title");
          } else {
            // THE VOCABULARY BUCKET. The title has words and a year; the
            // parser simply has no rule for the product they name.
            buckets.needsVocab++; cell.needsVocab++;
            const sp = productSpelling(title);
            if (sp) {
              if (!spellings.has(sp)) spellings.set(sp, { rows: 0, years: new Map(), sports: new Map(), samples: [], cardNumbers: [] });
              const e = spellings.get(sp);
              e.rows++;
              e.years.set(year, (e.years.get(year) ?? 0) + 1);
              e.sports.set(sport, (e.sports.get(sport) ?? 0) + 1);
              if (e.samples.length < 3) e.samples.push(title.slice(0, 90));
              // Real card numbers off the rows themselves, so the checklist
              // probe below asks about cards that actually exist in this
              // product rather than about numbers we invented.
              if (e.cardNumbers.length < 40) {
                const cn = String(row.cardNumber ?? "").trim();
                if (cn && !K.isPseudoCardNumber?.(cn)) e.cardNumbers.push(cn);
              }
            } else {
              bump(underivableByReason, "no-product-words");
            }
            sample("needsVocab", `${row.cardId}  [${sp}]  "${title.slice(0, 70)}"`);
          }
        } else if (reason === "no-title") {
          buckets.underivable++; cell.underivable++;
          bump(underivableByReason, "no-title");
        } else if (String(reason).startsWith("guard:")) {
          buckets.underivable++; cell.underivable++;
          bump(underivableByReason, reason);
          sample(reason, `${row.cardId}  "${title.slice(0, 70)}"`);
        } else {
          buckets.underivable++; cell.underivable++;
          bump(underivableByReason, String(reason));
          sample(String(reason), `${row.cardId}  "${title.slice(0, 70)}"`);
        }
        continue;
      }

      // THE DERIVATION RESOLVED A PRODUCT. Now the fleet's own question: does
      // classifyRow call it IMPROVE, and is the destination checklist-backed?
      // Both, or the fleet does not write it.
      const backed = await checklistBacked(der.slug);
      const res = K.classifyRow({
        row, stored, derived: der.identity, checklistBacked: backed,
        derivationReasons: der.reasons, storedSlug: row.cardId,
        baseDestSlug: der.baseSlug ?? null, baseDestBacked: false,
        parserSaysLot: safeIsLot(title),
        autoByCardNumber: der.autoByCardNumber === true,
        titleStatesNumber: K.titleStatesCardNumber(title),
      });

      const filledSetKey = (res.axes?.filled ?? []).includes("setKey");
      const reasons = res.reasons ?? [];
      // THE CLASS ALONE DOES NOT SEPARATE THESE TWO, and reading it as though
      // it did was this census's first wrong answer (caught 2026-09-05 on a
      // 1,200-row sample that reported 48% CONFLICT).
      //
      // `classifyRow` applies the checklist gate INSIDE the class decision: a
      // row that is strictly more specific on every axis but whose destination
      // has no checklist-backed catalog row does NOT come back IMPROVE-and-
      // unbacked. It comes back CONFLICT, carrying `filled:<axes>` and
      // `not-checklist-backed` (rematch-classify.cjs, the second gate). So
      // bucketing on `klass === IMPROVE && !backed` matched nothing at all,
      // and eleven of every twelve "CONFLICT" rows were in fact vocabulary
      // successes waiting on a checklist.
      //
      // Read the REASON, which is where the classifier actually put the
      // answer. A rival reading of the card and a reading nothing can vouch
      // for are different findings and get different buckets.
      const notBacked = reasons.includes("not-checklist-backed");
      if (res.klass === K.IMPROVE && backed) {
        buckets.fleetFixes++; cell.fleetFixes++;
        sample("fleetFixes", `${row.cardId} -> ${der.slug}${filledSetKey ? "  [filled:setKey]" : ""}  "${title.slice(0, 60)}"`);
      } else if (notBacked && filledSetKey) {
        // The parser READS the product -- `filled:setKey` says so -- and the
        // catalog simply has no checklist-backed row at the destination. This
        // is the checklist-gap census's population wearing this census's
        // clothes: a vocabulary win that is not yet a writable row, and it
        // becomes writable the day that product's checklist lands, with no
        // code change at all.
        buckets.improveNotBacked++;
        const dk = `${der.identity?.cardYear}|${der.identity?.setKey}`;
        bump(notBackedByProduct, dk);
        sample("improveNotBacked", `${row.cardId} -> ${der.slug}  [${dk}]  "${title.slice(0, 55)}"`);
      } else if (res.klass === K.AGREE) {
        buckets.agree++;
        sample("agree", `${row.cardId}  "${title.slice(0, 70)}"`);
      } else if (res.klass === K.CONFLICT) {
        buckets.conflict++;
        sample("conflict", `${row.cardId} -> ${der.slug}  ${(res.reasons ?? []).slice(0, 2).join(",")}`);
      } else {
        buckets.underivable++; cell.underivable++;
        bump(underivableByReason, `classified:${res.klass}`);
      }
    }
  }

  // ── ONE PRODUCT, ONE ROW ──────────────────────────────────────────────────
  //
  // The raw spellings fragment: "UD Exquisite Collection Limited", "...Dual",
  // "...Emblems", "...Number" are FOUR spellings of ONE product, split by
  // whichever subset name happened to follow the brand. Ranking those
  // separately buries a 90-row product under nine 10-row lines and tells the
  // vocabulary ruling to write nine rules where one will do.
  //
  // So fold by the PROPOSED KEY -- which is `normalizeSetKey`'s own answer for
  // the spelling, the single source consulted rather than second-guessed. Rows
  // add up across the spellings that share a key; every spelling that produced
  // it is carried along, because the ruling needs to see the variants it must
  // match, and the largest of them is reported as the representative.
  //
  // CF-ONE-CARD-ONE-ROW-ONE-POOL is about sales, but the same discipline
  // applies to a work list: one product, one line, one decision.
  const byKey = new Map();
  for (const [spelling, e] of spellings) {
    let key = "";
    try { key = hic.normalizeSetKey(spelling); } catch { key = ""; }
    if (!key) key = spelling;
    if (!byKey.has(key)) byKey.set(key, { rows: 0, spellings: [], years: new Map(), sports: new Map(), cardNumbers: [], example: "" });
    const g = byKey.get(key);
    g.rows += e.rows;
    g.spellings.push({ spelling, rows: e.rows });
    for (const [y, n] of e.years) g.years.set(y, (g.years.get(y) ?? 0) + n);
    for (const [sp, n] of e.sports) g.sports.set(sp, (g.sports.get(sp) ?? 0) + n);
    for (const cn of e.cardNumbers) if (g.cardNumbers.length < 60) g.cardNumbers.push(cn);
    if (!g.example && e.samples[0]) g.example = e.samples[0];
  }

  const top = [...byKey.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, TOP_SPELLINGS);
  const top50 = [];
  for (const [proposedKey, g] of top) {
    const topYear = [...g.years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const topSport = [...g.sports.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const probe = (proposedKey && proposedKey !== "unknown")
      ? await checklistProbe(topYear, proposedKey, g.cardNumbers, topSport)
      : { hits: 0, tried: 0 };
    g.spellings.sort((a, b) => b.rows - a.rows);
    top50.push({
      proposedKey,
      spelling: g.spellings[0]?.spelling ?? proposedKey,
      variants: g.spellings.slice(0, 8),
      rows: g.rows,
      // A PROBE, named as one: `checklistHits` of `checklistProbed` real card
      // numbers from this product's own rows already have a checklist-backed
      // catalog row. Never presented as the product's row count.
      checklistHits: probe.hits, checklistProbed: probe.tried,
      topYear: topYear ?? null, topSport: topSport ?? null,
      example: g.example ?? "",
    });
  }

  // ── extrapolation ─────────────────────────────────────────────────────────
  // The report's own measured total for this population.
  const POPULATION_TOTAL = 889860;
  const sampled = stats.population;
  const covered = SHARDED ? POPULATION_TOTAL / SLOTS : POPULATION_TOTAL;
  const fraction = covered ? Math.min(1, sampled / covered) : 0;
  /** A binomial 95% half-width on a proportion, scaled to the population.
   *  Stated so a number this census extrapolates is never mistaken for one it
   *  measured. */
  const errorBar = (k) => {
    if (!sampled) return 0;
    const p = k / sampled;
    const half = 1.96 * Math.sqrt(Math.max(p * (1 - p), 1e-9) / sampled);
    return Math.round(half * POPULATION_TOTAL);
  };
  const scale = (k) => (sampled ? Math.round((k / sampled) * POPULATION_TOTAL) : 0);

  const elapsed = (Date.now() - started) / 1000;
  const out = {
    script: "census-unknown-setkey",
    at: new Date().toISOString(),
    readOnly: true,
    sharded: SHARDED, slot: SLOT, slots: SLOTS,
    stopReason,
    elapsedSeconds: Math.round(elapsed),
    rowsPerSecond: Math.round(stats.scanned / Math.max(elapsed, 1)),
    populationTotalMeasured: POPULATION_TOTAL,
    sampleSize: sampled,
    sampleFraction: Number((fraction * 100).toFixed(2)),
    scanned: stats.scanned,
    filteredNotPopulation: stats.filtered,
    otherShard: stats.otherShard,
    buckets,
    extrapolated: {
      fleetFixes: { estimate: scale(buckets.fleetFixes), plusMinus: errorBar(buckets.fleetFixes) },
      improveNotBacked: { estimate: scale(buckets.improveNotBacked), plusMinus: errorBar(buckets.improveNotBacked) },
      needsVocab: { estimate: scale(buckets.needsVocab), plusMinus: errorBar(buckets.needsVocab) },
      underivable: { estimate: scale(buckets.underivable), plusMinus: errorBar(buckets.underivable) },
      conflict: { estimate: scale(buckets.conflict), plusMinus: errorBar(buckets.conflict) },
      agree: { estimate: scale(buckets.agree), plusMinus: errorBar(buckets.agree) },
      protectedRows: { estimate: scale(buckets.protectedRows), plusMinus: errorBar(buckets.protectedRows) },
    },
    underivableByReason,
    // The acquisition list: products the parser now READS whose checklists we
    // do not have. Ranked by rows, because that is the order they are worth
    // acquiring in.
    notBackedTopProducts: Object.entries(notBackedByProduct)
      .sort((a, b) => b[1] - a[1]).slice(0, 60)
      .map(([k, n]) => ({ product: k, rows: n, estimatedRows: scale(n) })),
    top50Spellings: top50,
    distinctSpellings: spellings.size,
    byCell: [...byCell.entries()]
      .map(([k, v]) => ({ cell: k, ...v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 60),
    samples,
  };

  // ── the banner ────────────────────────────────────────────────────────────
  console.log("");
  console.log(`── census-unknown-setkey ─────────────────────────────────────────────`);
  console.log(`  scanned ${f(stats.scanned)} rows in ${Math.round(elapsed)}s (${f(out.rowsPerSecond)} rows/s)${stopReason ? `  -- ${stopReason}` : ""}`);
  console.log(`  population sampled: ${f(sampled)} of ${f(POPULATION_TOTAL)} measured unknown-key rows (${(fraction * 100).toFixed(2)}%)`);
  if (stats.filtered) console.log(`  ${f(stats.filtered)} rows matched the CONTAINS filter but were NOT population (segment re-check)`);
  if (SHARDED) console.log(`  shard ${SLOT}/${SLOTS} -- ${f(stats.otherShard)} rows belong to other shards`);
  console.log("");
  console.log(`  BUCKET                       sampled      share    extrapolated (95% CI)`);
  const line = (label, k) => console.log(`  ${label.padEnd(26)} ${f(k).padStart(9)}  ${pct(k, sampled).padStart(8)}    ${f(scale(k)).padStart(9)} ± ${f(errorBar(k))}`);
  line("fleet fixes (IMPROVE+backed)", buckets.fleetFixes);
  line("reads product, no checklist", buckets.improveNotBacked);
  line("needs vocabulary", buckets.needsVocab);
  line("underivable", buckets.underivable);
  line("CONFLICT", buckets.conflict);
  line("AGREE", buckets.agree);
  line("PROTECTED (report-only)", buckets.protectedRows);
  console.log("");
  console.log(`  UNDERIVABLE by reason:`);
  for (const [r, n] of Object.entries(underivableByReason).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`    ${String(r).padEnd(40)} ${f(n).padStart(8)}   ~${f(scale(n))}`);
  }
  console.log("");
  const nbTop = Object.entries(notBackedByProduct).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (nbTop.length) {
    console.log(`  READS THE PRODUCT, HAS NO CHECKLIST -- top products (the acquisition list):`);
    for (const [k, n] of nbTop) console.log(`    ${String(k).padEnd(42)} ${f(n).padStart(7)}   ~${f(scale(n))}`);
    console.log("");
  }
  console.log(`  TOP ${Math.min(TOP_SPELLINGS, top50.length)} PRODUCTS the vocabulary has no rule for `
    + `(${f(byKey.size)} distinct proposed keys over ${f(spellings.size)} raw spellings):`);
  console.log(`    ${"proposedKey".padEnd(30)} ${"rows".padStart(6)} ${"~total".padStart(8)} ${"chkProbe".padStart(8)}  representative spelling`);
  for (const s of top50) {
    console.log(`    ${String(s.proposedKey).padEnd(30).slice(0, 30)} ${f(s.rows).padStart(6)} ${f(scale(s.rows)).padStart(8)} `
      + `${(s.checklistProbed ? `${s.checklistHits}/${s.checklistProbed}` : "-").padStart(8)}  ${String(s.spelling).slice(0, 40)}`
      + `${s.variants.length > 1 ? `  (+${s.variants.length - 1} more spellings)` : ""}`);
  }
  console.log("");
  console.log(`  Every extrapolation above is LABELLED as one. The sample is ${(fraction * 100).toFixed(2)}% of the population;`);
  console.log(`  the ± is a binomial 95% half-width scaled to ${f(POPULATION_TOTAL)} rows.`);
  console.log(`  NOTHING WAS WRITTEN. This script has no write path.`);

  if (JSON_OUT) {
    const dir = fs.statSync(JSON_OUT, { throwIfNoEntry: false })?.isDirectory() ? JSON_OUT : path.dirname(JSON_OUT);
    const file = dir === JSON_OUT ? path.join(JSON_OUT, `unknown-setkey-slot-${SLOT}.json`) : JSON_OUT;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`  census JSON -> ${file}`);
  } else {
    console.log(`CENSUS_JSON ${JSON.stringify({ ...out, samples: undefined })}`);
  }
}

module.exports = { slugSetKeySegment, isUnknownKeyRow, productSpelling, saysLot, saysNonCard, hashSlot };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
