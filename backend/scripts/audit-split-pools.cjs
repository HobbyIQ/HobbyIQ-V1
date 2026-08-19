#!/usr/bin/env node
/**
 * CF-SPLIT-POOLS (Drew, 2026-08-19: "there seems to be a lot of split pools.
 * How can we identify this issue and unify them?").
 *
 * Finds pairs of slugs that are probably ONE card wearing two identities, and —
 * just as importantly — tells them apart from pairs that are two real cards.
 *
 * WHY POOLS SPLIT. A slug has seven segments, and a source that omits one
 * writes a DIFFERENT slug for the same card:
 *
 *   hiq:baseball:2024:bowman-chrome:cpa-wj:refractor:auto            276 comps
 *   hiq:baseball:2024:bowman-chrome:cpa-wj:refractor:auto:num-499     41 comps
 *
 * Neither pool can see the other. Splitting does not lose data; it makes the
 * data unreachable, which prices the same. A gold CPA-MG auto came out at $6.90
 * against $187 paid for exactly this reason.
 *
 * THE SHAPE IT LOOKS FOR. Two slugs identical in every segment but one, where
 * one side HAS a value and the other is absent or empty. That is the signature
 * of an omission. Two slugs that disagree on a segment (blue vs gold) are two
 * cards and are never reported.
 *
 * PRICE IS THE DISCRIMINATOR, AND THIS IS THE WHOLE POINT.
 *
 * Volume cannot tell a split from two real cards, and neither can the segment
 * shape — the CPA-WJ pair above looks exactly like a split and probably is not
 * one. Compared at equal grade:
 *
 *   ...:refractor:auto          PSA 10 median $302  (n=93)
 *   ...:refractor:auto:num-499  PSA 10 median $504  (n=14)
 *
 * One card does not sell for $302 and $504 in the same grade at the same time.
 * That 1.7x gap is evidence of TWO products (Bowman flagship's /499 CPA auto
 * and Bowman Chrome's unnumbered one), and merging them would destroy a real
 * distinction — the same mistake as flattening a Sapphire into a paper base.
 *
 * So each pair carries a median ratio computed WITHIN a shared grade bucket,
 * because comparing a mostly-PSA-10 pool against a mostly-raw one measures
 * grade mix, not card identity:
 *
 *   ratio ~ 1.0  -> consistent with one card; a merge CANDIDATE
 *   ratio >> 1.0 -> two products; LEAVE ALONE
 *
 * AND A RATIO NEAR 1.0 IS STILL NOT PROOF. Two different parallels can happen
 * to trade at the same price. The ratio only ranks what a human checks against
 * the checklist; it never authorises a write on its own.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-split-pools.cjs \
 *     [--sport=baseball] [--setKey=bowman] [--minEach=5] [--top=50]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const SETKEY = arg("setKey", "");
const MIN_EACH = Number(arg("minEach", "5"));
const TOP = Number(arg("top", "50"));

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const where = [`STARTSWITH(c.hobbyiqCardId, "hiq:${SPORT}:")`];
  if (SETKEY) where.push(`CONTAINS(c.hobbyiqCardId, ":${SETKEY}:")`);

  // Prices are kept PER GRADE per slug. Holding every raw price would be
  // cheaper, but then the comparison below would be measuring grade mix.
  const pools = new Map();   // slug -> Map(gradeBucket -> number[])
  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId, c.price, c.gradeCompany, c.gradeValue FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      const slug = String(r.hobbyiqCardId ?? "");
      const price = Number(r.price) || 0;
      if (!slug || price <= 0) continue;
      scanned++;
      const g = r.gradeCompany ? `${r.gradeCompany} ${r.gradeValue}` : "raw";
      let byGrade = pools.get(slug);
      if (!byGrade) pools.set(slug, (byGrade = new Map()));
      let arr = byGrade.get(g);
      if (!arr) byGrade.set(g, (arr = []));
      arr.push(price);
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  scanned=${scanned} slugs=${pools.size}   `);
  }
  process.stderr.write("\n");

  const count = (byGrade) => [...byGrade.values()].reduce((s, a) => s + a.length, 0);

  // Group by the slug with one segment blanked. Two slugs landing in the same
  // bucket differ in exactly that segment — an omission, not a disagreement.
  const SEG = ["hiq", "sport", "year", "setKey", "cardNumber", "parallel", "auto", "printRun"];
  const findings = [];
  const seen = new Set();

  for (let si = 3; si < SEG.length; si++) {
    const buckets = new Map();
    for (const slug of pools.keys()) {
      const p = slug.split(":");
      const key = p.map((v, i) => (i === si ? "*" : v)).join(":");
      // A missing trailing printRun makes the slug SHORTER, so normalise length
      // too — otherwise `...:auto` and `...:auto:num-499` never meet.
      const norm = si === 7 ? p.slice(0, 7).join(":") : key;
      let arr = buckets.get(norm);
      if (!arr) buckets.set(norm, (arr = []));
      arr.push(slug);
    }
    for (const [, slugs] of buckets) {
      if (slugs.length < 2) continue;
      for (let i = 0; i < slugs.length; i++) {
        for (let j = i + 1; j < slugs.length; j++) {
          const a = slugs[i], b = slugs[j];
          const pa = a.split(":"), pb = b.split(":");
          const va = pa[si] ?? "", vb = pb[si] ?? "";
          // ONE side must be absent. Two present-but-different values are two
          // cards (blue vs gold), never a split.
          const aEmpty = !va || va === "null" || va === "undefined";
          const bEmpty = !vb || vb === "null" || vb === "undefined";
          if (aEmpty === bEmpty) continue;
          const ga = pools.get(a), gb = pools.get(b);
          const na = count(ga), nb = count(gb);
          if (na < MIN_EACH || nb < MIN_EACH) continue;
          const id = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(id)) continue;
          seen.add(id);

          // Compare inside the RICHEST shared grade bucket.
          let bucket = null, best = 0;
          for (const [g, arr] of ga) {
            const other = gb.get(g);
            if (!other) continue;
            const n = Math.min(arr.length, other.length);
            if (n > best) { best = n; bucket = g; }
          }
          if (!bucket || best < 3) continue;
          const ma = median(ga.get(bucket)), mb = median(gb.get(bucket));
          if (!ma || !mb) continue;
          const ratio = Math.max(ma, mb) / Math.min(ma, mb);
          findings.push({
            segment: SEG[si], a, b, na, nb, bucket,
            ma, mb, ratio, shared: best, total: na + nb,
          });
        }
      }
    }
  }

  findings.sort((x, y) => (x.ratio - y.ratio) || (y.total - x.total));

  console.log(`scanned=${scanned.toLocaleString()} distinct slugs=${pools.size.toLocaleString()}`);
  console.log(`pairs differing by exactly one ABSENT segment: ${findings.length.toLocaleString()}\n`);

  const likely = findings.filter((f) => f.ratio <= 1.25);
  const unclear = findings.filter((f) => f.ratio > 1.25 && f.ratio <= 2);
  const distinct = findings.filter((f) => f.ratio > 2);
  console.log(`  ratio <= 1.25  MERGE CANDIDATE (verify vs checklist) : ${likely.length}`);
  console.log(`  1.25 - 2.0     UNCLEAR, needs a human               : ${unclear.length}`);
  console.log(`  > 2.0          TWO REAL CARDS, leave alone          : ${distinct.length}\n`);

  const show = (title, list) => {
    console.log(`── ${title} ──`);
    for (const f of list.slice(0, TOP)) {
      console.log(`  ratio ${f.ratio.toFixed(2)}  [${f.segment}]  ${f.bucket} median $${f.ma} vs $${f.mb}`);
      console.log(`     ${String(f.na).padStart(6)}  ${f.a}`);
      console.log(`     ${String(f.nb).padStart(6)}  ${f.b}`);
    }
    console.log("");
  };
  show("MERGE CANDIDATES — same price at equal grade", likely);
  show("TWO REAL CARDS — priced too differently to be one card", distinct.slice(0, 12));

  console.log("READ-ONLY. A ratio near 1.0 RANKS a candidate; only the checklist confirms it.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
