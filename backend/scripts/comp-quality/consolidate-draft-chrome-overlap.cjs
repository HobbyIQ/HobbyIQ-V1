// Consolidate the bowman-draft / bowman-chrome overlap: where the SAME card
// exists under both product keys, Bowman Draft is authoritative and the chrome
// row is superseded.
//
// WHY. Catalog rows disagree with themselves — a row is filtered on its setKey
// field but consumers use its `id`, and those do not always encode the same
// product. On 2024 alone, 8,412 of 125,044 draft/chrome rows have an id-slug
// that contradicts their own setKey. #1205 stops the matcher ADOPTING the
// wrong product; this is the data half.
//
// ─── WHY THIS IS NOT "DELETE CHROME WHERE DRAFT EXISTS" ───────────────────
//
// Card numbers in these products are INITIALS-BASED, so the same code is a
// different player in each product. Measured on 2024's 273 overlapping numbers:
//
//   SAME player      177 numbers, 6,487 chrome rows   <- the same card twice
//   DIFFERENT player  73 numbers, 2,290 chrome rows   <- two different cards
//   no player         23
//
//   #CPA-DJ   Dawel Joseph   |  Dakota Jordan
//   #CPA-TB   Travis Bazzana |  Tony Blanco Jr.
//   #CPA-BM   Braylin Morel  |  Braden Montgomery | Brice Matthews
//
// A blanket removal deletes 73 real cards in 2024 alone. So the player must
// match on both sides — normalised, because "Josh Kuroda-Grauer" and "Josh
// Kuroda-grauer" are the same person — and anything else is left strictly
// alone.
//
// ─── SUPERSEDE, DO NOT DELETE ─────────────────────────────────────────────
//
// Rows already carry supersededBy / supersededReason. Marking is reversible
// and auditable; a delete against a catalog we have repeatedly mis-measured
// today is not. Readers that respect supersededBy stop seeing the row; the
// evidence survives if this call turns out to be wrong for some product.
//
// Read-only by default. APPLY=true writes. Paced, and scoped per year — the
// whole-catalog version of this query times out.
//
// Usage:
//   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
//     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
//     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
//     node scripts/comp-quality/consolidate-draft-chrome-overlap.cjs
//
//   YEARS=2024,2023   years to process (default 2024)
//   APPLY=true        write supersededBy (default: report only)
//   PACE_MS=250       delay between writes
const { CosmosClient } = require("@azure/cosmos");

const YEARS = String(process.env.YEARS || "2024").split(",").map((y) => Number(y.trim())).filter(Boolean);
// CF-BOWMAN-OVERLAP-SWEEP (2026-08-22). The draft/chrome pair is the one that
// surfaced, but the failure mode — one card catalogued under two product keys
// — is not specific to it. KEEP is authoritative; DROP is superseded onto it.
const KEEP = String(process.env.KEEP || "bowman-draft");

/** The provenance stamp. repoint-comps-to-surviving-slug requires this exact
 *  string before it will follow a mark, so the two must never drift — hence one
 *  definition, exported, rather than the same literal typed in both files. */
function supersedeReasonFor(drop, keep) {
  return `${drop}->${keep} ${SUPERSEDE_MARKER}; ${keep} is authoritative`;
}
/** The stable part of the stamp. The wording around it has already changed once
 *  — 2024 was marked "draft-chrome-overlap: ... Bowman Draft is authoritative"
 *  before the template was parameterised — so the repoint matches on THIS
 *  substring rather than the whole sentence. Exact matching would have silently
 *  locked out 438 legitimate 2024 marks. No other pass's reason contains it. */
const SUPERSEDE_MARKER = "overlap: same card catalogued under both product keys";
module.exports = { supersedeReasonFor, SUPERSEDE_MARKER };
const DROP = String(process.env.DROP || "bowman-chrome");
const APPLY = process.env.APPLY === "true";
const PACE_MS = Number(process.env.PACE_MS || 250);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Same person regardless of casing, punctuation or spacing. */
const normPlayer = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

// A "player" that is actually a product word means the ROW IS MIS-PARSED, not
// that we found a twin. Some catalog rows have the parallel in the cardNumber
// slot and a product word in the playerName slot:
//
//   cardNumber "Gold"         parallel "Base"            playerName "Refractor"
//   cardNumber "Printing"     parallel "SuperFractor"    playerName "Plates"
//   cardNumber "SuperFractor" parallel "Base"            playerName "(one-of-one)"
//
// The same-player rule then matches "Refractor" to "Refractor" and calls two
// pieces of debris the same card. Both sides being garbage does not make the
// merge safe: repointing sales onto a junk slug buries them somewhere no
// lookup will ever ask for. These are excluded and COUNTED, not silently
// dropped — they are a parser bug worth its own fix, not noise.
const PRODUCT_TOKEN = new RegExp("^(" + [
  "base","refractor","refractors","superfractor","xfractor","atomic","mojo",
  "prism","prizm","shimmer","wave","speckle","sparkle","lava","magma","scope",
  "disco","negative","ray","aqua","sepia","gold","orange","red","blue","green",
  "purple","black","yellow","pink","bronze","silver","platinum","chrome",
  "draft","sapphire","auto","autograph","autographs","parallel","insert",
  "plate","plates","printingplate","printingplates","printing","mini",
  "oneofone","onefone","numbered","diecut","image","variation","short","print",
].join("|") + ")$");

/** Two alphabetic tokens or more, and not a bare product word. Deliberately
 *  strict: over-rejecting leaves a real duplicate in place, which is the
 *  reversible direction. Over-accepting corrupts sales attribution. */
function isPlayerLike(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  const words = s.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.every((w) => PRODUCT_TOKEN.test(w.replace(/[^a-z]/g, "")))) return false;
  return true;
}
/** Parallel compared on letters only — "Gold Refractor" vs "gold-refractor". */
const normParallel = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Print run from a slug's num-N segment, wherever it sits. Anchoring on the
 *  END missed "…:num-499:raw" — a grade-exploded row — and reported it as
 *  unnumbered, so a /499 twinned with an unnumbered card. */
const printRunOf = (slug) => {
  const m = String(slug || "").match(/:num-(\d+)(?::|$)/);
  return m ? m[1] : "";
};
/** Grade-exploded rows carry a grade tier after the auto segment
 *  ("…:auto:raw", "…:auto:psa-10"). They are per-grade children, never the
 *  card itself, so they must not be a supersede target. */
/** A CARD slug has exactly hiq:sport:year:setKey:number:parallel:auto, plus an
 *  optional num-N. Anything longer is a grade-exploded child
 *  (":raw", ":psa-10", ":bgs-10-black"). Counting segments beats matching
 *  grade names — three separate grade spellings slipped past a name pattern
 *  tonight, the last being "bgs-10-black", which has letters after its digits. */
const isGradeExploded = (slug) => {
  const p = String(slug || "").split(":");
  if (p[0] !== "hiq") return false;
  if (p.length <= 7) return false;
  if (p.length === 8 && /^num-\d+$/.test(p[7])) return false;
  return true;
};
/** Compare on SLUG SEGMENTS, never on the row's fields. The fields disagree
 *  with the slug often enough that a field match is meaningless: two rows both
 *  labelled parallel "Base Autograph" carry slugs :base-autograph: and
 *  :base-autograph-refractor:, which are different cards. The slug is what
 *  every consumer resolves against, so the slug is what has to match. */
const seg = (slug, i) => { const p = String(slug || "").split(":"); return p[0] === "hiq" ? (p[i] ?? "") : ""; };
const slugSetKey = (slug) => seg(slug, 3);
const slugParallelSeg = (slug) => seg(slug, 5);
const slugAutoSeg = (slug) => seg(slug, 6);
/** Only a canonical slug can stand in for a card. A vendor id
 *  ("cardhedge::…") is not an identity we can point at. */
const isCanonicalSlug = (slug) => String(slug || "").startsWith("hiq:");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const c = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL WRITE supersededBy" : "report only"}   years: ${YEARS.join(", ")}\n`);

  let totalSame = 0, totalDiff = 0, totalUnknown = 0, totalMarked = 0, totalFailed = 0, totalAlready = 0;

  for (const year of YEARS) {
    const { resources } = await c.items.query({
      query: `SELECT c.id, c.cardId, c.cardNumber, c.setKey, c.playerName, c.parallel, c.source, c.supersededBy
              FROM c WHERE c.year = @y AND (c.setKey = @keep OR c.setKey = @drop)`,
      parameters: [{ name: "@y", value: year }, { name: "@keep", value: KEEP }, { name: "@drop", value: DROP }],
    }).fetchAll();
    if (resources.length === 0) {
      console.log(`${year}: no rows.`);
      continue;
    }

    const byNum = new Map();
    for (const r of resources) {
      const n = String(r.cardNumber || "").toUpperCase();
      if (!n) continue;
      if (!byNum.has(n)) byNum.set(n, { draft: [], chrome: [] });
      byNum.get(n)[r.setKey === KEEP ? "draft" : "chrome"].push(r);
    }

    let same = 0, diff = 0, unknown = 0, marked = 0, failed = 0, already = 0, unaddressable = 0;
    let parseJunk = 0;
    const junkSample = [];
    const toMark = [];
    const noTwin = [];

    for (const [num, side] of byNum) {
      if (!side.draft.length || !side.chrome.length) continue;
      // Count what the parse guard removes BEFORE using the filtered sets, so
      // the exclusion shows up in the report instead of vanishing into a lower
      // "same player" number.
      for (const r of side.chrome) {
        if (r.playerName && !isPlayerLike(r.playerName)) {
          parseJunk++;
          if (junkSample.length < 6) junkSample.push(r);
        }
      }
      const draftPlayers = new Set(side.draft.filter((r) => isPlayerLike(r.playerName)).map((r) => normPlayer(r.playerName)).filter(Boolean));
      const chromePlayers = new Set(side.chrome.filter((r) => isPlayerLike(r.playerName)).map((r) => normPlayer(r.playerName)).filter(Boolean));
      if (!draftPlayers.size || !chromePlayers.size) { unknown++; continue; }

      const sharesAPlayer = [...chromePlayers].some((p) => draftPlayers.has(p));
      if (!sharesAPlayer) { diff++; continue; }   // different cards — leave both
      same++;

      // Only the chrome rows whose player is ALSO on the draft side. A number
      // can carry both a shared player and a distinct one.
      for (const row of side.chrome) {
        if (!isPlayerLike(row.playerName)) continue;   // mis-parsed row, counted above
        const p = normPlayer(row.playerName);
        if (!p || !draftPlayers.has(p)) continue;
        if (row.supersededBy) { already++; continue; }
        // Grade-exploded chrome rows follow whatever happens to their parent;
        // marking them individually would scatter the decision.
        if (isGradeExploded(row.id)) continue;
        if (!isCanonicalSlug(row.id) || slugSetKey(row.id) !== DROP) continue;
        // The twin must be the SAME card, not merely the same number and
        // player: same parallel AND same print run. A chrome
        // "refractor:auto:num-250" is not the draft "refractor:auto" — those
        // are different parallels of one player, and pointing one at the other
        // would launder a real card into a duplicate.
        const twin = side.draft.find((d) => isCanonicalSlug(d.id)
          && !isGradeExploded(d.id)
          // The twin's own slug must say bowman-draft. A row whose setKey
          // FIELD says draft while its slug says "bowman-draft-chrome" is a
          // third spelling, not the card we are consolidating onto.
          && slugSetKey(d.id) === KEEP
          && isPlayerLike(d.playerName)
          && normPlayer(d.playerName) === p
          && slugParallelSeg(d.id) === slugParallelSeg(row.id)
          && slugAutoSeg(d.id) === slugAutoSeg(row.id)
          && printRunOf(d.id) === printRunOf(row.id));
        if (!twin) { noTwin.push(row); continue; }   // leave it; needs a human
        toMark.push({ row, twinId: twin.id, num });
      }
    }

    console.log(`${year}: ${byNum.size} card numbers, ${resources.length} rows`);
    console.log(`  overlapping, SAME player      : ${same}   -> ${toMark.length} chrome rows to supersede`);
    console.log(`  overlapping, DIFFERENT player : ${diff}   (left alone — distinct cards)`);
    console.log(`  excluded, playerName is a product word : ${parseJunk}   (mis-parsed rows — parser bug, not a twin)`);
    for (const r of junkSample) {
      console.log(`      #${String(r.cardNumber).padEnd(12)} parallel=${String(r.parallel || "—").padEnd(16)} player=${JSON.stringify(r.playerName)}`);
    }
    console.log(`  overlapping, no player        : ${unknown}   (left alone — cannot tell)`);
    console.log(`  already superseded            : ${already}`);
    console.log(`  chrome rows with NO exact twin : ${noTwin.length}   (left alone — parallel or print run differs)`);

    if (APPLY) {
      for (const { row, twinId, num } of toMark) {
        try {
          // card_catalog is partitioned by /cardId, NOT /id. Passing id as the
          // partition key silently works for canonical rows where the two are
          // equal and 404s for every row where they differ — which was 29 of
          // the first 501 writes.
          const pk = typeof row.cardId === "string" && row.cardId ? row.cardId : null;
          if (!pk) { unaddressable++; continue; }
          const { resource: doc } = await c.item(row.id, pk).read();
          if (!doc) { unaddressable++; continue; }
          doc.supersededBy = twinId || `bowman-draft:${num}`;
          doc.supersededReason = supersedeReasonFor(DROP, KEEP);
          doc.supersededAt = new Date().toISOString();
          await c.item(row.id, pk).replace(doc);
          marked++;
        } catch (e) {
          failed++;
          if (failed <= 3) console.log(`   write failed for ${row.id}: ${e.message}`);
        }
        await sleep(PACE_MS);
      }
      console.log(`  MARKED: ${marked}   failed: ${failed}   unaddressable: ${unaddressable}`);
      if (unaddressable) {
        console.log(`     ^ rows with no cardId. card_catalog is partitioned by /cardId, so a row`);
        console.log(`       missing it cannot be point-read or written at all. Separate defect.`);
      }
    } else if (toMark.length) {
      console.log(`\n  sample of what would be superseded:`);
      for (const { row, twinId } of toMark.slice(0, 6)) {
        console.log(`    #${String(row.cardNumber).padEnd(10)} ${String(row.parallel || "—").slice(0, 24).padEnd(24)} ${row.playerName}`);
        console.log(`       ${row.id}`);
        console.log(`       -> superseded by ${twinId ?? "(no exact-parallel twin — number-level marker)"}`);
      }
    }

    totalSame += same; totalDiff += diff; totalUnknown += unknown;
    totalMarked += marked; totalFailed += failed; totalAlready += already;
    console.log("");
  }

  console.log(`TOTAL  sameCard=${totalSame}  differentCard=${totalDiff}  unknown=${totalUnknown}  marked=${totalMarked}  failed=${totalFailed}  alreadyDone=${totalAlready}`);
  if (!APPLY) console.log("\nReport only — nothing written. Re-run with APPLY=true.");
  if (totalFailed) process.exit(4);
}

// Guarded so the repoint can require this module for supersedeReasonFor
// without executing a catalog sweep as a side effect.
if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    process.exit(3);
  });
}
