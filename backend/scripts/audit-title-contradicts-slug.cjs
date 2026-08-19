#!/usr/bin/env node
/**
 * CF-TITLE-CONTRADICTS-SLUG (Drew, 2026-08-19).
 *
 * Finds comps whose OWN LISTING TITLE says something different from their slug
 * — a card sitting in a pool its own description rules out.
 *
 * WHERE THIS CAME FROM. A user's 2024 Bowman Walker Jenkins /499 refractor auto
 * priced wrongly. Its pool held:
 *
 *   $22.49  "...Walker Jenkins RC REFRACTOR ... Non Auto Rookie Holo"
 *           sitting in hiq:...:cpa-wj:refractor:auto      <- title says NON AUTO
 *   $611    "...HTA Choice Refractor 1st Auto 147/150"
 *           sitting in ...:refractor:auto (no serial)     <- title says /150
 *
 * Twelve comps in that one pool named a serial the slug contradicts. Both ends
 * of the price range were cards that did not belong, and the listing text said
 * so the whole time. Nothing downstream can notice: the slug is well-formed and
 * the pool looks healthy.
 *
 * IT REUSES THE PARSER, DELIBERATELY. parseListingIdentity is the rule for
 * reading a title. Writing a second regex here would be the
 * one-rule-two-implementations defect that caused a string of bugs in this
 * effort — a naive colour matcher built during it scored "Red Sox",
 * "Redemption" and "Stickered" as the colour RED, and "Choice" as ICE, and
 * reported 6.3% of a pool as recoverable when the true figure was near zero.
 * The parser already handles those; this asks it, and compares.
 *
 * ABSENCE IS NEVER A CONTRADICTION. Vendor titles omit things constantly — most
 * of them never mention the serial. A row is only flagged when the title states
 * a value AND that value differs. A quiet title is not evidence.
 *
 * READ-ONLY, AND THE REPAIR IS NOT OBVIOUS. Three classes, three different
 * right answers:
 *
 *   SERIAL   the title names the number, so the slug can be corrected
 *   AUTO     "Non Auto" is explicit, so the slug can be corrected
 *   PARALLEL the title names a colour the slug lacks — but a title also
 *            describes lots, promos and the wrong card, so this one wants a
 *            reviewed pass rather than a blanket rewrite
 *
 * And for a contradicted row that cannot be confidently re-homed, the doctrine
 * already says an ABSENT slug beats a WRONG one: dropping it out of the pool is
 * better than guessing a new one.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-title-contradicts-slug.cjs \
 *     [--sport=baseball] [--setKey=bowman] [--limit=N] [--top=25]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { normalizeParallel } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const SETKEY = arg("setKey", "");
const TOP = Number(arg("top", "25"));
const LIMIT = Number(arg("limit", "0")) || Infinity;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[title-contradicts-slug] sport=${SPORT} setKey=${SETKEY || "(all)"}\n`);

  const where = [`STARTSWITH(c.hobbyiqCardId, "hiq:${SPORT}:")`, "IS_STRING(c.title)", `c.title <> ""`];
  if (SETKEY) where.push(`CONTAINS(c.hobbyiqCardId, ":${SETKEY}:")`);
  const sql = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.price FROM c WHERE ${where.join(" AND ")}`;

  const stats = { scanned: 0, parsed: 0, serial: 0, auto: 0, notAuto: 0, parallel: 0 };
  const examples = { serial: [], auto: [], notAuto: [], parallel: [] };
  const bySlugSerial = new Map();

  // A 429 pauses the scan; it never ends it. Third script to need this today.
  let token, throttles = 0, drained = false;
  while (!drained && stats.scanned < LIMIT) {
    const iter = sold.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let progressed = false;
    while (iter.hasMoreResults() && stats.scanned < LIMIT) {
      let page;
      try {
        page = await iter.fetchNext();
      } catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const waitMs = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  throttled (${throttles}), waiting ${Math.round(waitMs / 1000)}s   `);
        await new Promise((r) => setTimeout(r, waitMs));
        break;
      }
      token = page.continuationToken;
      progressed = true;

      for (const r of page.resources || []) {
        if (stats.scanned >= LIMIT) break;
        stats.scanned++;
        const parts = String(r.hobbyiqCardId).split(":");
        if (parts.length < 7) continue;
        const slugParallel = parts[5];
        const slugAuto = parts[6] === "auto";
        const slugSerial = (parts[7] || "").startsWith("num-") ? Number(parts[7].slice(4)) : null;

        let p;
        try { p = parseListingIdentity(String(r.title)); } catch { continue; }
        if (!p) continue;
        stats.parsed++;

        // ── SERIAL. Only when the title states one AND they differ. ──────────
        if (p.printRun && slugSerial && Number(p.printRun) !== slugSerial) {
          stats.serial++;
          const k = `${slugSerial} <- title says ${p.printRun}`;
          bySlugSerial.set(k, (bySlugSerial.get(k) ?? 0) + 1);
          if (examples.serial.length < TOP) examples.serial.push({ r, said: p.printRun, slug: slugSerial });
        } else if (p.printRun && !slugSerial) {
          // Slug has no serial but the title names one — the row is pooled with
          // unnumbered cards. Same defect, opposite shape.
          stats.serial++;
          const k = `(none) <- title says ${p.printRun}`;
          bySlugSerial.set(k, (bySlugSerial.get(k) ?? 0) + 1);
          if (examples.serial.length < TOP) examples.serial.push({ r, said: p.printRun, slug: null });
        }

        // ── AUTO. parseListingIdentity decides; "Non Auto" is explicit. ──────
        if (typeof p.isAuto === "boolean") {
          if (p.isAuto && !slugAuto) {
            stats.auto++;
            if (examples.auto.length < 6) examples.auto.push(r);
          } else if (!p.isAuto && slugAuto && /\bnon[-\s]?auto\b/i.test(String(r.title))) {
            // Only trust a NEGATIVE when the title says so in words. A parser
            // returning false for a quiet title is absence, not contradiction.
            stats.notAuto++;
            if (examples.notAuto.length < 6) examples.notAuto.push(r);
          }
        }

        // ── PARALLEL. Title names one, slug says base. ───────────────────────
        if (p.parallel) {
          const want = normalizeParallel(p.parallel);
          if (want && want !== "base" && slugParallel === "base") {
            stats.parallel++;
            if (examples.parallel.length < 6) examples.parallel.push({ r, want });
          }
        }
      }
      if (stats.scanned % 250000 < 2000) process.stderr.write(`\r  scanned=${stats.scanned}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  if (throttles) console.log(`absorbed ${throttles} throttle pause(s)`);

  const pct = (n) => `${((n / Math.max(stats.parsed, 1)) * 100).toFixed(2)}%`;
  console.log(`scanned=${stats.scanned.toLocaleString()}  parsed=${stats.parsed.toLocaleString()}\n`);
  console.log(`SERIAL   title names a different serial : ${String(stats.serial).padStart(8)}  ${pct(stats.serial)}`);
  console.log(`AUTO     title says auto, slug says not : ${String(stats.auto).padStart(8)}  ${pct(stats.auto)}`);
  console.log(`NON-AUTO title says NON auto, slug auto : ${String(stats.notAuto).padStart(8)}  ${pct(stats.notAuto)}`);
  console.log(`PARALLEL title names one, slug is base  : ${String(stats.parallel).padStart(8)}  ${pct(stats.parallel)}\n`);

  console.log("── serial disagreements, most common ──");
  for (const [k, n] of [...bySlugSerial.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(7)}  slug ${k}`);
  }
  console.log("\n── examples: SERIAL ──");
  for (const e of examples.serial.slice(0, 6)) {
    console.log(`   $${String(e.r.price).padEnd(9)} slug=${e.slug ?? "(none)"} title=${e.said}`);
    console.log(`      ${String(e.r.title).slice(0, 95)}\n      ${e.r.hobbyiqCardId}`);
  }
  console.log("\n── examples: NON-AUTO in an auto pool ──");
  for (const e of examples.notAuto) {
    console.log(`   $${String(e.price).padEnd(9)} ${String(e.title).slice(0, 92)}\n      ${e.hobbyiqCardId}`);
  }
  console.log("\n── examples: PARALLEL named but slug is base ──");
  for (const e of examples.parallel) {
    console.log(`   $${String(e.r.price).padEnd(9)} -> ${e.want}\n      ${String(e.r.title).slice(0, 92)}\n      ${e.r.hobbyiqCardId}`);
  }

  console.log("\nREAD-ONLY. Absence is never a contradiction — only titles that STATE a");
  console.log("differing value are counted. Repair differs per class and gets its own pass.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
