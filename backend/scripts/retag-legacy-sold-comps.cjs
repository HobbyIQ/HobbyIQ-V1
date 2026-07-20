#!/usr/bin/env node
/**
 * CF-RETAG-LEGACY (Drew, 2026-07-20). One-shot re-tag of legacy
 * sold_comps rows that were written with wrong / missing metadata
 * before recent PRs fixed the emit paths. Scans a scoped batch,
 * checks each row against ch_daily_sales (the authoritative CH
 * source), and updates:
 *
 *   - gradeCompany / gradeValue when the row was written as raw but
 *     ch_daily_sales's c.grade field has a proper tier (BGS 9.5,
 *     PSA 10, etc.). Fixes the "40 raw / 0 BGS 9" bug from tonight's
 *     Bobby Witt smoke.
 *   - sport when the row is null-tagged but the setName is
 *     unambiguously baseball / football / etc.
 *
 * Read-heavy: for each candidate row we fetch the matching
 * ch_daily_sales doc by (card_id, sale_date, price). Rate-limited to
 * avoid RU pressure.
 *
 * Runbook (dry-run by default):
 *   node backend/scripts/retag-legacy-sold-comps.cjs --cardId=X
 *   node backend/scripts/retag-legacy-sold-comps.cjs --cardId=X --apply
 *   node backend/scripts/retag-legacy-sold-comps.cjs --sport=baseball --limit=1000 --apply
 *
 * Idempotent: rows already correctly tagged are skipped. Safe to
 * re-run against overlapping windows.
 */
const { CosmosClient } = require("@azure/cosmos");

function parseArgs(argv) {
  const args = { apply: false, cardId: null, sport: null, limit: Infinity, rateMs: 50 };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--cardId=")) args.cardId = a.slice(9);
    else if (a.startsWith("--sport=")) args.sport = a.slice(8);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--rate=")) args.rateMs = parseInt(a.slice(7), 10);
  }
  return args;
}

function parseGrade(g) {
  const s = String(g ?? "").trim();
  if (!s || s.toLowerCase() === "raw") return { gradeCompany: null, gradeValue: null };
  const m = s.match(/^([A-Z]+)\s+([0-9.]+)$/i);
  if (!m) return { gradeCompany: null, gradeValue: null };
  const v = Number(m[2]);
  return { gradeCompany: m[1].toUpperCase(), gradeValue: Number.isFinite(v) ? v : null };
}

function inferSport(setName, title) {
  const text = `${setName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (text.includes("soccer") || text.includes("mls")) return "soccer";
  if (/\bbowman\b/.test(text)) return "baseball";
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const sc = db.container("sold_comps");
  const ch = db.container("ch_daily_sales");

  console.error(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  cardId=${args.cardId ?? "(all)"}  sport=${args.sport ?? "(all)"}  limit=${args.limit}  rate=${args.rateMs}ms`);

  // Pull candidate rows from sold_comps
  const params = [];
  let filter = "1=1";
  if (args.cardId) { filter += " AND c.cardId = @cid"; params.push({ name: "@cid", value: args.cardId }); }
  if (args.sport) { filter += " AND c.sport = @sport"; params.push({ name: "@sport", value: args.sport }); }
  // Only revisit CH-source rows that look like they need a re-tag —
  // either raw-tagged but might be graded, or null-sport but might
  // have inferable sport.
  filter += " AND c.source = 'cardhedge' AND ((c.gradeCompany = null AND c.gradeValue = null) OR (NOT IS_DEFINED(c.sport)) OR c.sport = null)";

  const opts = args.cardId ? { partitionKey: args.cardId } : {};
  const iter = sc.items.query({
    query: `SELECT c.id, c.cardId, c.soldAt, c.price, c.gradeCompany, c.gradeValue, c.sport, c.setName, c.title
            FROM c WHERE ${filter}
            OFFSET 0 LIMIT ${Math.min(args.limit, 200000)}`,
    parameters: params,
  }, opts);

  const rows = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }
  console.error(`Candidate rows: ${rows.length.toLocaleString()}`);

  let scanned = 0, updated = 0, alreadyOk = 0, notInCh = 0, errors = 0;
  const t0 = Date.now();

  for (const row of rows) {
    scanned++;

    // Try to find the matching ch_daily_sales doc by (cardId, sale_date, price)
    const priceCents = Math.round(Number(row.price) * 100);
    const priceLo = priceCents - 5;
    const priceHi = priceCents + 5;
    const dayStart = row.soldAt.slice(0, 10) + "T00:00:00Z";
    const dayEnd = row.soldAt.slice(0, 10) + "T23:59:59Z";

    let match = null;
    try {
      const chRes = await ch.items.query({
        query: `SELECT TOP 1 c.grade, c.grader, c.card_set, c.player FROM c
                WHERE c.card_id = @cid
                  AND c.sale_date >= @from AND c.sale_date <= @to
                  AND c.price * 100 >= @lo AND c.price * 100 <= @hi`,
        parameters: [
          { name: "@cid", value: row.cardId },
          { name: "@from", value: dayStart },
          { name: "@to", value: dayEnd },
          { name: "@lo", value: priceLo },
          { name: "@hi", value: priceHi },
        ],
      }, { partitionKey: row.cardId }).fetchAll();
      match = chRes.resources[0];
    } catch { /* skip on error */ }

    const patch = {};
    if (match) {
      const parsed = parseGrade(match.grade);
      if (parsed.gradeCompany && row.gradeCompany !== parsed.gradeCompany) {
        patch.gradeCompany = parsed.gradeCompany;
        patch.gradeValue = parsed.gradeValue;
      }
    } else {
      notInCh++;
    }
    if (!row.sport) {
      const s = inferSport(row.setName, row.title);
      if (s) patch.sport = s;
    }

    if (Object.keys(patch).length === 0) { alreadyOk++; continue; }

    if (args.apply) {
      try {
        const ops = Object.entries(patch).map(([path, value]) => ({
          op: "set", path: `/${path}`, value,
        }));
        await sc.item(row.id, row.cardId).patch(ops);
        updated++;
        await sleep(args.rateMs);
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`  patch failed ${row.id}: ${err.message}`);
      }
    } else {
      updated++;
    }

    if (updated % 100 === 0 && updated > 0) {
      const rate = updated / ((Date.now() - t0) / 1000);
      console.error(`  ${scanned.toLocaleString()} scanned, ${updated} would-update, ${alreadyOk} already-ok, ${notInCh} not-in-ch, ${errors} err @ ${rate.toFixed(1)}/s`);
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.error(`\nDONE. scanned=${scanned.toLocaleString()}  ${args.apply ? "updated" : "would-update"}=${updated.toLocaleString()}  alreadyOk=${alreadyOk.toLocaleString()}  notInCh=${notInCh.toLocaleString()}  errors=${errors}  time=${elapsed.toFixed(0)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
