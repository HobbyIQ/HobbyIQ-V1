// CF-SLUG-FRAG-MASS-RESLUG (Drew, 2026-08-10). Migrate every sold_comps
// row whose slug puts a chrome-only card under the bare product family.
//
// Pattern: hiq:<sport>:<year>:<bareFam>:<chromeOnlyCardNumber>:<rest>
//   → hiq:<sport>:<year>:<chromeFam>:<chromeOnlyCardNumber>:<rest>
//
// Chrome-only cardNumber prefixes (case-insensitive):
//   CPA-, BCP-, BDC-  → bowman → bowman-chrome / bowman-draft-chrome
//   TCPA-, CRA-       → topps  → topps-chrome
//
// Idempotent — skips rows already on a chrome family.
// 429-safe — patchWithRetry.
// Env: APPLY=true to write, LIMIT=N to cap rows per run (default unlimited).

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

// Rules: prefix regex → { bareFam, chromeFam }
// Regex uses `(?:-|\d)` after prefix to match BOTH dashed (BCP-102, 2020+)
// AND no-dash (BCP150, pre-2020) shapes. First pass 2026-08-10 used
// literal string prefixes and missed no-dash — Vlad Guerrero BCP150
// found via user test.
// Match the source-of-truth CHROME_PREFIX_OVERRIDES table in
// hobbyIqCardId.service.ts. Order = sapphire → chrome-family → paper.
const RULES = [
  // Sapphire — must come BEFORE plain chrome rules
  { prefixRe: /^bspa(?:-|\d)/i,          bareFam: "bowman",        chromeFam: "bowman-chrome-sapphire" },
  { prefixRe: /^bspa(?:-|\d)/i,          bareFam: "bowman-chrome", chromeFam: "bowman-chrome-sapphire" },
  // Bowman Chrome family
  { prefixRe: /^(?:bcp|bcpa|cpa)(?:-|\d)/i, bareFam: "bowman",        chromeFam: "bowman-chrome" },
  { prefixRe: /^(?:bdc|bdcpa|cda)(?:-|\d)/i, bareFam: "bowman",        chromeFam: "bowman-chrome" },
  { prefixRe: /^(?:bdc|bdcpa|cda)(?:-|\d)/i, bareFam: "bowman-draft",  chromeFam: "bowman-chrome" },
  // Topps Chrome family
  { prefixRe: /^(?:tcpa|cra)(?:-|\d)/i,  bareFam: "topps",         chromeFam: "topps-chrome"  },
  // Paper family (Bowman)
  { prefixRe: /^bpa(?:-|\d)/i,           bareFam: "bowman",        chromeFam: "bowman-paper" },
  { prefixRe: /^bp(?:-|\d)/i,            bareFam: "bowman",        chromeFam: "bowman-paper" },
  { prefixRe: /^bda(?:-|\d)/i,           bareFam: "bowman",        chromeFam: "bowman-draft-paper" },
  { prefixRe: /^bda(?:-|\d)/i,           bareFam: "bowman-draft",  chromeFam: "bowman-draft-paper" },
];

const SLUG_RE = /^(hiq:[^:]+:\d+):([^:]+):([^:]+):(.+)$/;
// groups: 1=prefix (hiq:sport:year), 2=family, 3=cardNumber, 4=rest

function rewriteSlug(slug) {
  const m = SLUG_RE.exec(slug);
  if (!m) return null;
  const [_, prefix, fam, cardNumber, rest] = m;
  for (const rule of RULES) {
    if (fam !== rule.bareFam) continue;
    if (rule.prefixRe.test(cardNumber)) {
      return `${prefix}:${rule.chromeFam}:${cardNumber}:${rest}`;
    }
  }
  return null; // no rule matched
}

async function patchWithRetry(sold, r, newSlug, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await sold.item(r.id, r.cardId).patch([
        { op: "set", path: "/hobbyiqCardId", value: newSlug },
        { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
        { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
        { op: "set", path: "/reslugedReason", value: "CF-SLUG-FRAG-MASS-RESLUG: chrome-only cardNumber → chrome family" },
      ]);
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code === 429) {
        const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  return false;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  limit=${LIMIT || "∞"}`);

  // Query all candidates. Drop the trailing dash from the CONTAINS
  // patterns to catch no-dash cardNumbers (BCP150, CPA123). The
  // rewriteSlug() regex still applies precisely per rule — spurious
  // matches (e.g. bowman:bcperry) that pass the CONTAINS filter will
  // fail rewriteSlug and get skipped.
  const query = `
    SELECT c.id, c.cardId, c.hobbyiqCardId
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND (
        CONTAINS(c.hobbyiqCardId, ':bowman:cpa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bcp')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bcpa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bdc')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bdcpa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:cda')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bspa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bp')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bpa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman:bda')
        OR CONTAINS(c.hobbyiqCardId, ':bowman-draft:bdc')
        OR CONTAINS(c.hobbyiqCardId, ':bowman-draft:bdcpa')
        OR CONTAINS(c.hobbyiqCardId, ':bowman-draft:cda')
        OR CONTAINS(c.hobbyiqCardId, ':bowman-draft:bda')
        OR CONTAINS(c.hobbyiqCardId, ':bowman-chrome:bspa')
        OR CONTAINS(c.hobbyiqCardId, ':topps:tcpa')
        OR CONTAINS(c.hobbyiqCardId, ':topps:cra')
      )
  `;
  const it = sold.items.query({ query }, { maxItemCount: 500 });

  let scanned = 0, rewriteEligible = 0, touched = 0, failed = 0, skipped = 0;
  const familyCounts = {};
  const startedAt = Date.now();
  const inflight = [];

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const newSlug = rewriteSlug(r.hobbyiqCardId);
      if (!newSlug) { skipped++; continue; }
      if (newSlug === r.hobbyiqCardId) { skipped++; continue; }
      rewriteEligible++;
      familyCounts[newSlug.split(":")[3]] = (familyCounts[newSlug.split(":")[3]]||0)+1;

      if (LIMIT && touched + inflight.length >= LIMIT) break;

      if (!APPLY) { touched++; continue; }

      const p = patchWithRetry(sold, r, newSlug)
        .then((ok) => { if (ok) touched++; else failed++; })
        .catch((err) => { console.warn(`fail ${r.id}: ${err.message||err}`); failed++; })
        .finally(() => {
          const idx = inflight.indexOf(p);
          if (idx >= 0) inflight.splice(idx, 1);
        });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

      if ((touched + failed) % 500 === 0 && (touched + failed) > 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  progress: scanned=${scanned} touched=${touched} failed=${failed} skipped=${skipped}  ${dur}s`);
      }
    }
    if (LIMIT && touched + inflight.length >= LIMIT) break;
  }
  await Promise.all(inflight);

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned} eligible=${rewriteEligible} touched=${touched} failed=${failed} skipped=${skipped}`);
  console.log(`  by target family:`);
  for (const [k,v] of Object.entries(familyCounts)) console.log(`    ${k}: ${v}`);
}
main().catch(e => { console.error(e); process.exit(1); });
