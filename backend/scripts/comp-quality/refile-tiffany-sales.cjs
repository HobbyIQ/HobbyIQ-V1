// File Tiffany sales under the Tiffany card, not the base card.
//
// THE BUG, as it reaches a user. A 1987 Topps Traded Tiffany Greg Maddux #70T
// PSA 10 is a ~$1,000 card. The holding shows $190.55 and an empty comps panel.
//
// Every PSA 10 sale of #70T — Tiffany and base alike — is filed under one slug,
// hiq:baseball:1987:topps:70t:base:no-auto:
//
//   title says Tiffany     28 sales   median $999.95   (recent: $1,647 $4,941 $6,255)
//   title does not        320 sales   median $122.50
//
// The holding itself is correctly identified as topps-traded-tiffany, so it
// matches none of them: the panel is empty while 348 comps exist, and the value
// comes from a fallback that blends a $1,000 card with a $122 one.
//
// SCOPE. 13,959 sales say "tiffany"; 5,936 already sit on a tiffany slug; 8,023
// do not.
//
// THE TRAP THIS SCRIPT IS BUILT AROUND: "tiffany" IS ALSO A PERSON.
// Among the misfiled rows are 106 under 2022:panini-prizm and 99 under
// 2022:panini-wwe-nxt-wrestling — those are the wrestler Tiffany Stratton, not
// a Topps Tiffany parallel. A title-contains match alone would refile a
// wrestler's rookie card as a 1980s parallel. Three independent conditions keep
// that from happening:
//
//   1. ERA + BRAND. Topps and Bowman Tiffany ran 1984-1992. A sale outside that
//      window, or under any other brand, is not a Tiffany parallel whatever its
//      title says. This alone excludes every Panini row.
//   2. NOT THE PLAYER. If the player's own name contains "tiffany", the word in
//      the title is explained and carries no product claim.
//   3. THE DESTINATION MUST ALREADY EXIST. The tiffany slug is never invented —
//      it must be a catalog row we already hold, and EXACTLY ONE candidate must
//      resolve. topps -> topps-tiffany OR topps-traded-tiffany are both
//      plausible for a #70T, and guessing between them is how a card ends up
//      somewhere no lookup asks for. Ambiguous rows are reported, not moved.
//
// Nothing about the sale changes but which card it belongs to — not price, not
// date, not source. Same sale, correct card.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/refile-tiffany-sales.cjs
//     APPLY=true       perform the writes (default: report only)
//     CONCURRENCY=8
//     YEARS=1984-1992  era window (default 1984-1992)
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const [ERA_FROM, ERA_TO] = String(process.env.YEARS || "1984-1992").split("-").map(Number);

/** Brands that actually had a Tiffany edition. */
const TIFFANY_BASE_SETKEYS = new Set(["topps", "topps-traded", "bowman"]);
const TIFFANY_VARIANTS = ["-tiffany"];

const seg = (slug, i) => {
  const p = String(slug || "").split(":");
  return p[0] === "hiq" && p.length > i ? p[i] : null;
};

/** Candidate destinations: swap the setKey segment for its tiffany form.
 *  topps -> topps-tiffany, and for a Traded card also topps-traded-tiffany. */
function candidateSlugs(slug) {
  const parts = String(slug).split(":");
  if (parts[0] !== "hiq" || parts.length < 5) return [];
  const setKey = parts[3];
  const out = [];
  for (const suffix of TIFFANY_VARIANTS) {
    for (const base of new Set([setKey, setKey === "topps" ? "topps-traded" : setKey])) {
      const next = [...parts];
      next[3] = `${base}${suffix}`;
      out.push(next.join(":"));
    }
  }
  return [...new Set(out)];
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL REFILE SALES" : "report only"}   era: ${ERA_FROM}-${ERA_TO}\n`);

  const { resources: raw } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName, c.price, c.gradeCompany, c.gradeValue FROM c
            WHERE CONTAINS(LOWER(c.title), "tiffany")
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND NOT CONTAINS(c.hobbyiqCardId, "tiffany")`,
  }).fetchAll();
  console.log(`sales titled tiffany, not on a tiffany slug: ${raw.length}`);

  // Guard 1 + 2.
  let outOfEra = 0, playerIsTiffany = 0;
  const candidates = [];
  for (const r of raw) {
    const year = Number(seg(r.hobbyiqCardId, 2));
    const setKey = seg(r.hobbyiqCardId, 3);
    if (!(year >= ERA_FROM && year <= ERA_TO) || !TIFFANY_BASE_SETKEYS.has(setKey)) { outOfEra++; continue; }
    if (/tiffany/i.test(String(r.playerName || ""))) { playerIsTiffany++; continue; }
    candidates.push(r);
  }
  console.log(`  excluded, outside the Topps/Bowman Tiffany era  : ${outOfEra}`);
  console.log(`  excluded, "tiffany" is the PLAYER's name        : ${playerIsTiffany}`);
  console.log(`  eligible                                       : ${candidates.length}`);

  // Guard 3: the destination must already exist, and exactly one of them.
  const wanted = new Set();
  for (const r of candidates) for (const s of candidateSlugs(r.hobbyiqCardId)) wanted.add(s);
  const want = [...wanted];
  const exists = new Map(); // slug -> playerName on that catalog row
  for (let i = 0; i < want.length; i += 60) {
    const ch = want.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id, c.playerName FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) exists.set(x.id, x.playerName);
  }
  console.log(`  distinct destinations considered               : ${want.length}`);
  console.log(`  of those, present in the catalog               : ${exists.size}`);

  // GUARD 4: THE DESTINATION MUST BE THE SAME PLAYER.
  // A base set and its Traded set both number from 1, so #100 in Topps and #100
  // in Topps Traded are different cards with different players. "The slug
  // exists" is not evidence that it is THIS card — that is precisely the
  // mistake that nearly merged 131 unrelated bowman cards whose initials-based
  // numbers collided. Existence plus identity, or it does not move.
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const moves = [];
  let noDestination = 0, ambiguous = 0, wrongPlayer = 0, noPlayerToCheck = 0;
  const wrongPlayerSample = [];
  for (const r of candidates) {
    const hits = candidateSlugs(r.hobbyiqCardId).filter((s) => exists.has(s));
    if (hits.length === 0) { noDestination++; continue; }
    const salePlayer = norm(r.playerName);
    if (!salePlayer) { noPlayerToCheck++; continue; }
    const sameName = hits.filter((s) => {
      const p = norm(exists.get(s));
      return p && p === salePlayer;
    });
    if (sameName.length === 0) {
      wrongPlayer++;
      if (wrongPlayerSample.length < 5) {
        wrongPlayerSample.push(`${r.playerName} -> ${hits[0]} is ${exists.get(hits[0])}`);
      }
      continue;
    }
    if (sameName.length > 1) { ambiguous++; continue; }
    moves.push({ r, to: sameName[0] });
  }
  console.log(`  no tiffany card exists to move to              : ${noDestination}   (needs a catalog row first)`);
  console.log(`  destination is a DIFFERENT player             : ${wrongPlayer}   (same number, other set — never moved)`);
  for (const s of wrongPlayerSample) console.log(`      ${s}`);
  console.log(`  sale has no player to verify against          : ${noPlayerToCheck}   (unverifiable, left alone)`);
  console.log(`  ambiguous, more than one tiffany card matches  : ${ambiguous}   (reported, never guessed)`);
  console.log(`  MOVABLE                                        : ${moves.length}`);

  const byPair = new Map();
  for (const m of moves) {
    const k = `${seg(m.r.hobbyiqCardId, 2)}:${seg(m.r.hobbyiqCardId, 3)} -> ${seg(m.to, 3)}`;
    byPair.set(k, (byPair.get(k) || 0) + 1);
  }
  console.log("\nwhat would move:");
  for (const [k, v] of [...byPair].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(v).padStart(6)}  ${k}`);

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
            { op: "set", path: "/repointedReason", value: "title says Tiffany; sale belongs to the Tiffany card, not the base card" },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 500 === 0) process.stdout.write(`  ...${moved}/${moves.length}\n`);
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

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
