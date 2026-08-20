#!/usr/bin/env node
/**
 * CF-SPORT-LEAK-SWEEP (Drew, 2026-08-18: "Football leaked in ... this is a BIG
 * BIG problem. Do a full sweep on ALL cards to fix this").
 *
 * Finds and repairs comps whose SLUG SPORT contradicts the sport that player
 * actually plays — at whole-container scale.
 *
 * WHAT IT FIXES. The 1997 Skybox Metal Universe Chipper Jones #31 page priced
 * off a $2.00 "Shannon Sharpe #31" — Sharpe is an NFL tight end. Metal Universe
 * shipped baseball AND football in 1997, both with a #31, so a mis-sported
 * football card lands on the baseball card's slug and drags its price. The
 * damage is silent: every field looks well-formed.
 *
 * WHY THE EARLIER AUDIT COULD NOT SCALE. audit-sport-leaks.cjs asks Cosmos for
 * each player's history individually. That is fine for 416 players in one set
 * and impossible for the container. This makes ONE pass, building the
 * player -> sport histogram in memory, then a SECOND pass that repairs only
 * rows the histogram condemns. Two scans, no per-player queries.
 *
 * THE SIGNAL, AND WHY IT NEEDS NO ROSTER. A player's dominant sport across all
 * their comps:
 *
 *   Shannon Sharpe    186 football (90.7%)  |  4 baseball (2.0%)   <- leak
 *   Irving Fryar      187 football (95.9%)  |  4 baseball (2.1%)   <- leak
 *   Chipper Jones   18825 baseball (97.6%)  | 43 football (0.2%)   <- leaks the other way
 *
 * DELIBERATELY CONSERVATIVE, because a minority sport is often REAL:
 *   - Michael Jordan has genuine baseball cards; Bo Jackson and Deion Sanders
 *     have both. Those names are excluded outright.
 *   - `multi-sport` is a legitimate vertical, never a leak.
 *   - A row is only condemned when the player has >= MIN_COMPS of history, one
 *     sport holds >= DOMINANCE, and the row's sport holds <= MAX_MINORITY.
 *
 * A first version of this check computed dominance WITHIN the target set and
 * flagged Wayne Gretzky for a hockey row — his in-set history was 11 multi-sport
 * rows, so "hockey" looked like the minority. Dominance must come from the
 * player's whole history; only the REPORTING is ever scoped.
 *
 * THE REPAIR REWRITES SEGMENT 1 AND NOTHING ELSE. Sport is the slug's
 * namespace, so correcting it moves the row to the right vertical while
 * preserving set, number, parallel and auto exactly. sportBefore and
 * hobbyiqCardIdBefore make it reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/sweep-sport-leaks.cjs \
 *     [--apply] [--minComps=25] [--dominance=0.85] [--maxMinority=0.10]
 *     [--pool=8] [--top=40] [--limit=N]
 */

const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const MIN_COMPS = Number(arg("minComps", "25"));
const DOMINANCE = Number(arg("dominance", "0.85"));
const MAX_MINORITY = Number(arg("maxMinority", "0.10"));
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "40"));
const LIMIT = Number(arg("limit", "0")) || Infinity;

/** Pass 1 costs a 13M-row scan and its verdict is just 4,791 player -> home
 *  decisions. Persisting it means a failed or re-tuned pass 2 never re-pays
 *  that. --homesOut writes it; --homesIn skips pass 1 entirely. */
const HOMES_OUT = arg("homesOut", "");
const HOMES_IN = arg("homesIn", "");

/** Players who legitimately hold cards in more than one sport. For these the
 *  minority is REAL and the premise of the check fails, so they are skipped
 *  rather than "corrected". */
const DUAL_SPORT = new Set([
  "michael jordan", "bo jackson", "deion sanders", "brian jordan", "kyler murray",
  "russell wilson", "tim tebow", "jim thorpe", "danny ainge", "dave winfield",
  "john elway", "drew henson", "chris weinke", "ricky williams", "charlie ward",
  "dave debusschere", "gene conley", "mark hendrickson", "jeff samardzija",
]);

/**
 * Names that exist as REAL cards in more than one trading-card game.
 *
 * The sweep's premise is that a name identifies a person, so a minority sport
 * must be a filing error. That premise fails for TCGs, where a "player" is a
 * card name and the same name is genuinely printed by different games.
 * "Mountain" is a basic land in Magic AND a field card in Yu-Gi-Oh, so its 11
 * yugioh rows are real cards, not leaks from tcg-other.
 *
 * Kept explicit rather than inferred: a blanket "never move between TCG
 * verticals" rule would also block the legitimate One Piece rows sitting under
 * `pokemon`, which ARE mis-slugged.
 */
const AMBIGUOUS_TCG_NAMES = new Set(["mountain", "island", "forest", "plains", "swamp"]);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * CF-NAME-FRAGMENTATION (Drew, 2026-08-20: cross-sport contamination still in
 * the baseball index after the first sweep).
 *
 * The first sweep keyed its histogram on norm(playerName), and that is why
 * Marcus Mariota, Shedeur Sanders and Cristiano Ronaldo survived it. Their comp
 * playerNames are polluted with insert and parallel words, so ONE player becomes
 * hundreds of keys:
 *
 *   shedeur sanders   10,731 comps   84.8% football, 14.4% BASEBALL
 *                     550 distinct normalised names
 *     9,003  "shedeur sanders"
 *       145  "rookies shedeur sanders"
 *        72  "rated shedeur sanders"
 *
 *   and the baseball rows are named
 *     "Phoenician Penmanship Shedeur Sanders"
 *     "Revolution Rookies Shedeur Sanders"
 *
 * Each variant is thin on its own, so it is skipped as insufficient history and
 * the player's overwhelming football dominance never reaches it. I had blamed
 * the DOMINANCE / MIN_COMPS thresholds; they were never the cause.
 *
 * A leading-noise stripper does not fix it either. core() takes the first two
 * non-noise tokens, which for "Phoenician Penmanship Shedeur Sanders" yields
 * "phoenician penmanship" — the noise here is a PREFIX, and the vocabulary of
 * insert names is open-ended, so no strip list can be complete.
 *
 * CONTAINMENT AGAINST AN ESTABLISHED NAME IS THE SIGNAL. A variant that CONTAINS
 * a name we already know — one with real volume and a clear home sport — is
 * almost certainly that player. Anchors require ANCHOR_MIN_COMPS so a rare
 * two-word name cannot capture unrelated cards, and both parts must be present
 * as whole words so "sanders" alone never matches Deion.
 */
const ANCHOR_MIN_COMPS = Number(arg("anchorMinComps", "200"));

/**
 * CF-TWO-PEOPLE-ONE-NAME. Dominance alone cannot tell a contaminated player
 * from two real people who share a name, and the two need OPPOSITE treatment:
 *
 *   tony gonzalez  1,227 comps   69.6% baseball / 28.9% football
 *      baseball 838 PRE-1990        <- the MLB outfielder, 1960s
 *      football 279 (1990-2009)     <- the NFL Hall of Fame tight end
 *      TWO PEOPLE — moving either way destroys real data
 *
 *   jason kelce    1,327 comps   65.3% football / 34.7% baseball
 *      football 866 (2010+)
 *      baseball 460 (2010+)         <- same era
 *      ONE PERSON — 460 contaminated rows
 *
 * Both sit below a 0.85 dominance bar, so the current threshold protects
 * Gonzalez and abandons Kelce by accident rather than by reasoning. Lowering it
 * would fix Kelce and CORRUPT Gonzalez.
 *
 * ERA IS THE DISCRIMINATOR. Two people occupy different decades; contamination
 * shares an era. So a stray sport is only condemned when its cards overlap the
 * home sport's active years — otherwise it is reported and left alone.
 */
const ERA_OVERLAP_MIN = Number(arg("eraOverlapMin", "0.5"));

/** Median year of a set of card years, cheap and outlier-tolerant. */
function medianYear(years) {
  if (!years.length) return null;
  const s = years.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Do two year-sets describe the same career window?
 *
 * Compares medians against a generous 20-year window — a career plus its
 * reprints. Deliberately generous: the cost of a false "same era" is one bad
 * move, while a false "different era" merely leaves a row unfixed.
 */
function sameEra(homeYears, strayYears) {
  const h = medianYear(homeYears), t = medianYear(strayYears);
  if (h == null || t == null) return true;   // no evidence -> do not block
  return Math.abs(h - t) <= 20;
}

/** Build a lookup of established two-word names, longest first so a more
 *  specific anchor wins over a shorter one it contains. */
function buildAnchors(hist) {
  const anchors = [];
  for (const [name, m] of hist) {
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    if (total < ANCHOR_MIN_COMPS) continue;
    if (name.split(" ").length !== 2) continue;   // first + last only
    anchors.push(name);
  }
  anchors.sort((a, b) => b.length - a.length);
  return anchors;
}

/** Does this variant name contain an established anchor as whole words? */
function anchorFor(name, anchors) {
  if (!name) return null;
  const padded = ` ${name} `;
  for (const a of anchors) if (padded.includes(` ${a} `)) return a;
  return null;
}
const sportOf = (slug) => String(slug ?? "").split(":")[1] || "";

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const container = (c, name) => c.database(process.env.COSMOS_DATABASE || "hobbyiq").container(name);

/** Pages to read before minting a fresh client. */
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
// A Cosmos auth token is minted when the iterator opens and expires under a
// long scan. Page count is the WRONG unit for that: 400 pages is 800k rows,
// and at a throttled RU ceiling one leg can outlive the token — which killed
// a 10-hour trend scan with a 403. Elapsed time is what the token cares about.
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

/**
 * Full-container scan that survives its own duration.
 *
 * A single query iterator over 13M rows runs for HOURS, and the auth token is
 * minted when the iterator opens. The first full run died at 9h51m with
 *
 *   403 Forbidden — "The authorization token is not valid at the current time
 *   (token start 02:42:25, current server time 12:34:02)"
 *
 * after pass 1 had already succeeded — nine hours of scanning thrown away for a
 * credential that aged out mid-flight. Retrying the page cannot help; the token
 * is stale for every subsequent page too.
 *
 * So the scan is broken into legs: every REFRESH_PAGES pages the continuation
 * token is kept, the client is dropped, and a NEW client resumes exactly where
 * the old one stopped. Cosmos continuation tokens are position, not session, so
 * a resumed query returns the same rows the original would have.
 */
async function scanAll(name, sql, onRow, label) {
  let token, pages = 0, rows = 0, throttles = 0;
  for (;;) {
    const c = container(newClient(), name);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, drained = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try {
        page = await iter.fetchNext();
      } catch (e) {
        // A 429 whose SDK retries are exhausted is NOT fatal — the continuation
        // token still marks our place, so the correct response is to wait and
        // resume, not to lose the scan. The second full run died here after the
        // first survived nine hours, which would have been a very expensive way
        // to learn that an unhandled 429 discards everything.
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const waitMs = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}), waiting ${Math.round(waitMs / 1000)}s at row ${rows}   `);
        await new Promise((r) => setTimeout(r, waitMs));
        break;   // rebuild the iterator from `token` on the next leg
      }
      token = page.continuationToken;
      for (const r of page.resources || []) { rows++; onRow(r); }
      pages++; legPages++;
      if (rows % 500000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      // Hand back to the outer loop so the next leg gets a fresh credential.
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
      if (rows >= LIMIT) { drained = true; break; }
    }
    // Finished only when the iterator actually drained. `!token` is NOT a
    // termination signal: a cross-partition query legitimately reports an
    // undefined continuation mid-flight, and treating that as done silently
    // truncates the sweep.
    if (drained || rows >= LIMIT) break;
    if (!token && legPages === 0 && throttles === 0) break;
  }
  process.stderr.write("\n");
  if (throttles) console.log(`  ${label}: absorbed ${throttles} throttle pause(s)`);
  return rows;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  console.log(`[sweep-sport-leaks] mode=${APPLY ? "APPLY" : "DRY-RUN"} minComps=${MIN_COMPS} dominance=${DOMINANCE} maxMinority=${MAX_MINORITY}\n`);

  const homeOf = new Map();     // player -> { home, strays:Set }

  if (HOMES_IN) {
    const cached = JSON.parse(fs.readFileSync(HOMES_IN, "utf8"));
    // Exclusions are re-applied on LOAD, not trusted from the file. A cache
    // written before a name was excluded would otherwise smuggle it back in,
    // and the whole point of the cache is that it outlives the run that made it.
    let dropped = 0;
    for (const [player, v] of Object.entries(cached.homes)) {
      if (DUAL_SPORT.has(player) || AMBIGUOUS_TCG_NAMES.has(player)) { dropped++; continue; }
      homeOf.set(player, { home: v.home, strays: new Set(v.strays), total: v.total, homeCount: v.homeCount });
    }
    if (dropped) console.log(`  dropped ${dropped} cached player(s) now on an exclusion list`);
    console.log(`pass1 SKIPPED — loaded ${homeOf.size.toLocaleString()} player homes from ${HOMES_IN}`);
    console.log(`  (built ${cached.builtAt ?? "?"} from ${Number(cached.scanned ?? 0).toLocaleString()} rows)\n`);
    return await passTwo(homeOf);
  }

  // ── PASS 1: player -> sport histogram, whole container ────────────────────
  // Counts only. Row identities are NOT held here — 13M ids would not fit.
  const hist = new Map();   // player -> Map(sport -> count)
  const years = new Map();  // player -> Map(sport -> year[])
  let scanned = 0;
  scanned = await scanAll("sold_comps",
    `SELECT c.playerName, c.hobbyiqCardId FROM c
      WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId) AND IS_DEFINED(c.playerName)`,
    (r) => {
      const player = norm(r.playerName);
      const sport = sportOf(r.hobbyiqCardId);
      if (!player || !sport) return;
      let m = hist.get(player);
      if (!m) hist.set(player, (m = new Map()));
      m.set(sport, (m.get(sport) ?? 0) + 1);
      // Year per (player, sport) — the era signal that separates two people
      // sharing a name from one contaminated player.
      const yr = Number(String(r.hobbyiqCardId).split(":")[2]);
      if (Number.isFinite(yr) && yr > 1900) {
        let ym = years.get(player);
        if (!ym) years.set(player, (ym = new Map()));
        let arr = ym.get(sport);
        if (!arr) ym.set(sport, (arr = []));
        if (arr.length < 400) arr.push(yr);   // a sample is plenty for a median
      }
    }, "pass1");

  // ── Fold name variants into their anchor BEFORE deciding homes ───────────
  //
  // Without this, "Phoenician Penmanship Shedeur Sanders" is a separate player
  // from "Shedeur Sanders", thin on its own, and skipped — which is exactly how
  // 1,547 of his BASEBALL rows survived the first sweep.
  const anchors = buildAnchors(hist);
  const alias = new Map();          // variant -> anchor
  let folded = 0, foldedComps = 0;
  for (const [name, m] of hist) {
    if (name.split(" ").length === 2 && hist.has(name)) {
      const total = [...m.values()].reduce((s, n) => s + n, 0);
      if (total >= ANCHOR_MIN_COMPS) continue;   // it IS an anchor
    }
    const a = anchorFor(name, anchors);
    if (!a || a === name) continue;
    alias.set(name, a);
    folded++;
    const target = hist.get(a);
    for (const [sport, n] of m) { target.set(sport, (target.get(sport) ?? 0) + n); foldedComps += n; }
    const vy = years.get(name), ay = years.get(a);
    if (vy && ay) for (const [sport, arr] of vy) {
      let dst = ay.get(sport); if (!dst) ay.set(sport, (dst = []));
      for (const y of arr) if (dst.length < 400) dst.push(y);
    }
  }
  // A variant's counts now live on its anchor; drop the variant so it cannot be
  // judged on its own thin history.
  for (const v of alias.keys()) hist.delete(v);
  console.log(`name variants folded into an anchor: ${folded.toLocaleString()}  (${foldedComps.toLocaleString()} comps)`);
  console.log(`anchors (>= ${ANCHOR_MIN_COMPS} comps, two-word names): ${anchors.length.toLocaleString()}
`);

  // ── Decide each player's home sport, and which sports are strays ──────────
  let skippedDual = 0, skippedThin = 0, skippedNoDominance = 0, eraBlocked = 0;
  for (const [player, m] of hist) {
    if (DUAL_SPORT.has(player) || AMBIGUOUS_TCG_NAMES.has(player)) { skippedDual++; continue; }
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    if (total < MIN_COMPS) { skippedThin++; continue; }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [home, homeCount] = ranked[0];
    if (homeCount / total < DOMINANCE) { skippedNoDominance++; continue; }
    const strays = new Set();
    const ym = years.get(player);
    for (const [sport, n] of ranked.slice(1)) {
      if (!sport || sport === "multi-sport") continue;
      if (n / total > MAX_MINORITY) continue;
      // ERA GATE. A stray whose cards sit in a different decade from the home
      // sport is probably a DIFFERENT PERSON with the same name — the MLB and
      // NFL Tony Gonzalezes — and must not be moved.
      if (ym && !sameEra(ym.get(home) ?? [], ym.get(sport) ?? [])) { eraBlocked++; continue; }
      strays.add(sport);
    }
    if (strays.size) homeOf.set(player, { home, strays, total, homeCount });
  }

  console.log(`pass1 scanned=${scanned.toLocaleString()} players=${hist.size.toLocaleString()}`);
  console.log(`  skipped: dual-sport ${skippedDual}, thin ${skippedThin.toLocaleString()}, no-dominance ${skippedNoDominance.toLocaleString()}`);
  console.log(`  players with at least one stray sport: ${homeOf.size.toLocaleString()}\n`);
  if (homeOf.size === 0) { console.log("nothing to repair."); return 0; }

  if (HOMES_OUT) {
    const homes = {};
    for (const [p, v] of homeOf) homes[p] = { home: v.home, strays: [...v.strays], total: v.total, homeCount: v.homeCount };
    fs.writeFileSync(HOMES_OUT, JSON.stringify({
      builtAt: new Date().toISOString(), scanned, players: hist.size,
      minComps: MIN_COMPS, dominance: DOMINANCE, maxMinority: MAX_MINORITY, homes,
      alias: Object.fromEntries(alias),
    }));
    console.log(`pass1 verdict saved -> ${HOMES_OUT}\n`);
  }
  return await passTwo(homeOf, alias);
}

/** ── PASS 2: collect the actual stray rows, then repair ──────────────────── */
async function passTwo(homeOf, alias = new Map()) {
  const sold = container(newClient(), "sold_comps");

  // Pass 2 re-reads the container rather than querying the 4,791 condemned
  // names directly, and that is deliberate. The obvious optimisation —
  // `WHERE LOWER(c.playerName) IN (...)` — is WRONG here: the keys are norm()ed,
  // which strips punctuation, so "George Lombard Jr." would never match its own
  // row and the sweep would silently under-report. Matching has to happen in JS
  // where norm() is applied to both sides.
  const work = [];
  await scanAll("sold_comps",
    `SELECT c.id, c.cardId, c.playerName, c.hobbyiqCardId, c.sport, c.price FROM c
      WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId) AND IS_DEFINED(c.playerName)`,
    (r) => {
      const n = norm(r.playerName);
      const info = homeOf.get(alias.get(n) ?? n);
      if (!info) return;
      const sport = sportOf(r.hobbyiqCardId);
      if (!info.strays.has(sport)) return;
      const parts = String(r.hobbyiqCardId).split(":");
      parts[1] = info.home;
      work.push({ r, next: parts.join(":"), from: sport, to: info.home });
    }, "pass2");

  const byMove = new Map();
  for (const w of work) {
    const k = `${w.from} -> ${w.to}`;
    byMove.set(k, (byMove.get(k) ?? 0) + 1);
  }
  console.log(`stray comps found: ${work.length.toLocaleString()}\n`);
  console.log("moves:");
  for (const [k, n] of [...byMove.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(7)}  ${k}`);
  }
  console.log("\nexamples:");
  for (const w of work.slice(0, Math.min(TOP, 12))) {
    console.log(`   $${String(w.r.price).padEnd(9)} ${w.r.playerName}`);
    console.log(`      ${w.r.hobbyiqCardId}\n      -> ${w.next}`);
  }

  // ── Repair ───────────────────────────────────────────────────────────────
  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(w.r.id, w.r.cardId).patch([
          { op: "add", path: "/sportBefore", value: w.r.sport ?? null },
          { op: "add", path: "/hobbyiqCardIdBefore", value: w.r.hobbyiqCardId },
          { op: "set", path: "/sport", value: w.to },
          { op: "set", path: "/hobbyiqCardId", value: w.next },
        ]);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.r.id}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }));

  console.log(`\n${APPLY ? "repaired" : "would repair"}=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
