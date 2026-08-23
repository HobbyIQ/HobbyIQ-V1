// One tool for "the sale says a product the slug does not".
//
// WHY THIS IS GENERAL AND THE LAST THREE WERE NOT. Bowman draft/chrome, Tiffany
// and Topps Traded were each written as their own script, and by the third the
// copies had already drifted: the Tiffany one still compared player names raw
// and silently refused 828 sales the Traded one would have moved. Same defect,
// fixed once, not fixed where it was copied to. So this is parameterised, and
// the shared player matcher is required rather than re-typed.
//
// THE SHAPE, every time:
//   A sale title names a distinct PRODUCT LINE — Sapphire, Tiffany, Traded —
//   while the slug it is filed under names the base product. The card page then
//   shows a price blended from two different cards, or no comps at all while a
//   pool of comps sits somewhere nothing looks.
//
// THE FOUR GUARDS, in the order they proved necessary:
//   1. ERA + BRAND. A product line existed for particular brands in particular
//      years. Outside that window the word means something else.
//   2. NOT THE PLAYER. "Tiffany" is also a wrestler; 915 rows were excluded on
//      that alone, plus 205 Panini rows the era guard caught. Any product word
//      can collide with a person's name.
//   3. THE DESTINATION MUST EXIST, and exactly one must resolve. Never invent
//      a card to move sales onto.
//   4. THE DESTINATION MUST BE THE SAME PLAYER. Base sets and their spin-offs
//      both number from 1, so the same number is routinely a different person.
//      This caught a sale labelled Doug Jones pointing at Pedro Guerrero.
//
// Report-only by default. Every write is a patch with a condition asserting the
// row is still where we found it, so a re-run skips rather than rewrites, and
// every moved row records where it came from so the move is reversible.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/refile-product-line-sales.cjs
//     LINE=sapphire            required — which product line (see LINES)
//     APPLY=true               perform the writes
//     CONCURRENCY=6
const { CosmosClient } = require("@azure/cosmos");
const { normPlayerName } = require("./playerNameMatch.cjs");

/** Each line: the word in the title, the base products it spins off from, the
 *  years it existed, and how a destination setKey is built from a base one. */
const LINES = {
  sapphire: {
    word: "sapphire",
    // Topps Chrome Sapphire and Bowman Chrome/Draft Sapphire, 2018 onward.
    bases: ["bowman-chrome", "bowman-draft", "topps-chrome", "bowman", "topps"],
    era: [2017, 2030],
    dest: (base) => [`${base}-sapphire`],
    // "SAPPHIRE" IS NOT ALWAYS THE PRODUCT — but it is more often than a first
    // pass assumed. RUBY & SAPPHIRE is Pokemon: 2003-pokemon-ex-ruby-sapphire,
    // ex-ruby-and-sapphire, ruby-sapphire. The era window happens to exclude
    // those, but an era window is a weak thing to rest correctness on, so they
    // are named.
    //
    // AN EARLIER VERSION ALSO BLOCKED EVERY "<colour> Sapphire" as a suspected
    // parallel-in-an-ordinary-set. That was wrong, and Drew corrected it: Blue
    // Sapphire IS the base Sapphire card, and gold/black/orange/red/yellow/
    // padparadscha are parallels OF Sapphire. The catalog agrees —
    // bowman-draft-sapphire holds Base (21,459) alongside Orange Sapphire, Red
    // Sapphire, Gold Sapphire, Black Sapphire and Padparadscha Sapphire as
    // distinct parallels. Those 292 sales belong in Sapphire; they need the
    // right PARALLEL, which parallelFromTitle supplies.
    titleExcludes: [/\bruby\s*(&|and)\s*sapphire\b/i, /\bpokemon\b/i],
    // WHICH PARALLEL, not just which set. Swapping only the setKey would file a
    // "Gold Sapphire /50" as base Sapphire — the same conflation this whole
    // sweep exists to undo, one level down. Returns the parallel slug segment,
    // or null to keep whatever the source slug already had.
    parallelFromTitle: (title) => {
      const t = String(title || "").toLowerCase();
      // Blue Sapphire is the base card, so it maps to the base parallel rather
      // than to a "blue-sapphire" segment that does not exist.
      if (/\bblue\s+sapphire\b/.test(t)) return "base";
      const m = t.match(/\b(gold|black|orange|red|yellow|purple|green|aqua|pink|padparadscha|papradascha)\s+sapphire\b/);
      return m ? `${m[1]}-sapphire` : null;
    },
  },
  tiffany: {
    word: "tiffany",
    bases: ["topps", "topps-traded", "bowman"],
    era: [1984, 1992],
    dest: (base) => [`${base}-tiffany`, base === "topps" ? "topps-traded-tiffany" : `${base}-tiffany`],
  },
};

// Exported so create-product-line-cards-from-base.cjs works from the SAME
// definition of each line. A second copy of "which base products, which years,
// which destination setKey" is precisely how the earlier scripts drifted.
module.exports = { LINES };

const LINE = String(process.env.LINE || "").trim().toLowerCase();
const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const seg = (s, i) => {
  const p = String(s || "").split(":");
  return p[0] === "hiq" && p.length > i ? p[i] : null;
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const cfg = LINES[LINE];
  if (!cfg) {
    console.error(`FATAL: LINE must be one of: ${Object.keys(LINES).join(", ")}`);
    process.exit(2);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL REFILE SALES" : "report only"}   line: ${cfg.word}   era: ${cfg.era[0]}-${cfg.era[1]}\n`);

  const { resources: raw } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.title, c.price FROM c
            WHERE CONTAINS(LOWER(c.title), @w)
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND NOT CONTAINS(c.hobbyiqCardId, @w)`,
    parameters: [{ name: "@w", value: cfg.word }],
  }).fetchAll();
  console.log(`sales titled ${cfg.word}, not on a ${cfg.word} slug: ${raw.length}`);

  // Guards 1 and 2.
  const wordRe = new RegExp(cfg.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  let outOfScope = 0, wordIsPlayer = 0, reinterpreted = 0;
  const reinterpretedSample = [];
  const eligible = [];
  for (const r of raw) {
    const y = Number(seg(r.hobbyiqCardId, 2));
    const base = seg(r.hobbyiqCardId, 3);
    if (!(y >= cfg.era[0] && y <= cfg.era[1]) || !cfg.bases.includes(base)) { outOfScope++; continue; }
    if (wordRe.test(String(r.playerName || ""))) { wordIsPlayer++; continue; }
    // The word is present but its neighbours change what it means — "Ruby &
    // Sapphire" is a Pokemon set, not a Topps product line.
    if ((cfg.titleExcludes ?? []).some((re) => re.test(String(r.title || "")))) {
      reinterpreted++;
      if (reinterpretedSample.length < 4) reinterpretedSample.push(String(r.title || "").slice(0, 76));
      continue;
    }
    eligible.push(r);
  }
  console.log(`  excluded, outside the era/brands this line existed in : ${outOfScope}`);
  console.log(`  excluded, the word is the PLAYER's own name           : ${wordIsPlayer}`);
  console.log(`  excluded, the word means something else in context    : ${reinterpreted}   (e.g. Pokemon Ruby & Sapphire)`);
  for (const t of reinterpretedSample) console.log(`      ${t}`);
  console.log(`  eligible                                             : ${eligible.length}`);
  if (!eligible.length) { console.log("nothing to do."); return; }

  // Guard 3.
  // hiq : sport : year : setKey : cardNumber : parallel : auto [: num-N]
  //  0      1       2       3         4           5        6
  const PARALLEL_SEG = 5;
  const candidatesFor = (slug, title) => {
    const parts = String(slug).split(":");
    const base = parts[3];
    // A colour named in the title decides the parallel; without one, keep
    // whatever the source slug had. Never guess between the two — the
    // destination-must-exist guard is what catches a wrong colour.
    const par = cfg.parallelFromTitle ? cfg.parallelFromTitle(title) : null;
    return [...new Set(cfg.dest(base))].map((d) => {
      const n = [...parts];
      n[3] = d;
      if (par && n.length > PARALLEL_SEG) n[PARALLEL_SEG] = par;
      return n.join(":");
    });
  };
  const wanted = new Set();
  for (const r of eligible) for (const s of candidatesFor(r.hobbyiqCardId, r.title)) wanted.add(s);
  const want = [...wanted];
  const exists = new Map();
  for (let i = 0; i < want.length; i += 60) {
    const ch = want.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id, c.playerName FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) exists.set(x.id, x.playerName);
  }
  console.log(`  distinct destinations considered                     : ${want.length}`);
  console.log(`  present in the catalog                               : ${exists.size}`);

  // Guard 4.
  const moves = [];
  let noDest = 0, wrongPlayer = 0, noPlayer = 0, ambiguous = 0;
  const sample = [];
  for (const r of eligible) {
    const hits = candidatesFor(r.hobbyiqCardId, r.title).filter((s) => exists.has(s));
    if (!hits.length) { noDest++; continue; }
    const want2 = normPlayerName(r.playerName);
    if (!want2) { noPlayer++; continue; }
    const same = hits.filter((s) => {
      const p = normPlayerName(exists.get(s));
      return p && p === want2;
    });
    if (!same.length) {
      wrongPlayer++;
      if (sample.length < 5) sample.push(`${r.playerName} -> ${String(hits[0]).slice(4, 62)} is ${exists.get(hits[0])}`);
      continue;
    }
    if (same.length > 1) { ambiguous++; continue; }
    moves.push({ r, to: same[0] });
  }
  console.log(`  no ${cfg.word} card exists to move to${" ".repeat(Math.max(0, 20 - cfg.word.length))}: ${noDest}   (needs a catalog row first)`);
  console.log(`  destination is a DIFFERENT player                    : ${wrongPlayer}`);
  for (const s of sample) console.log(`      ${s}`);
  console.log(`  no player to verify against                          : ${noPlayer}`);
  console.log(`  ambiguous between destinations                       : ${ambiguous}   (reported, never guessed)`);
  console.log(`  MOVABLE                                              : ${moves.length}`);

  const byPair = new Map();
  for (const m of moves) {
    const k = `${seg(m.r.hobbyiqCardId, 2)}:${seg(m.r.hobbyiqCardId, 3)} -> ${seg(m.to, 3)}`;
    byPair.set(k, (byPair.get(k) || 0) + 1);
  }
  console.log("\nwhat would move:");
  for (const [k, v] of [...byPair].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(v).padStart(6)}  ${k}`);

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let moved = 0, skipped = 0, failed = 0, unaddressable = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= moves.length) return;
      const { r, to } = moves[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: to },
            { op: "set", path: "/repointedFrom", value: r.hobbyiqCardId },
            { op: "set", path: "/repointedReason", value: `title says ${cfg.word}; sale belongs to the ${cfg.word} card, not the base card` },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 1000 === 0) process.stdout.write(`  ...${moved}/${moves.length}\n`);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  write failed ${r.id}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nREFILED: ${moved}   skipped: ${skipped}   unaddressable: ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

// Guarded so the creation tool can require this module for LINES without
// running a sweep as a side effect.
if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
}
