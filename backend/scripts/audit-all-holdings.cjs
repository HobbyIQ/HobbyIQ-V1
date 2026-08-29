#!/usr/bin/env node
/**
 * audit-all-holdings.cjs -- every holding, every user: is it on the right card,
 * is its pool the right pool, is its price defensible? READ-ONLY.
 *
 * CF-LOOK-AT-EVERY-HOLDING (Drew, 2026-08-29: "we may want to look at all
 * holdings for everyone", after holding ca7a150b priced a Gold Refractor /50
 * off 38 base autos and then off a paper-Bowman /75). Three defects were
 * behind that one card and none of them is specific to it:
 *
 *   1. IDENTITY  -- the holding's slug is an un-numbered twin (user-seeded /
 *                   sale-minted) of a numbered checklist row, or is not
 *                   checklist-backed at all, or is unresolved.
 *   2. POOL      -- the sales pooled under the slug carry titles that name a
 *                   different finish than the slug (a vendor tag stamped over
 *                   a silent title), or a different print run.
 *   3. PRICE     -- the persisted fairMarketValue disagrees with the exact
 *                   pool by more than 2x (either way), or came from a rung
 *                   that crosses identity (cross-setkey / sibling / model).
 *
 *   4. RUNGS     -- (D14) the wire fields the digest and iOS actually read:
 *                   `fmvRung` null or not an exact-pool rung, `cardId` !=
 *                   `hobbyiqCardId`, `cardId` not an hiq: slug, an
 *                   `estimatedValue` shown because `fairMarketValue` is
 *                   null, `isEstimate:true` while the exact pool
 *                   (hobbyiqCardId, raw, 180d) has >= 3 sales.
 *
 * Prints one line per holding with flags, then the roll-up, then the RUNGS
 * block. No writes.
 *
 * Env: COSMOS_CONNECTION_STRING (required); USER_ID (optional scope);
 *      RECENT=8 (pool rows sampled per slug).
 */
"use strict";
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { catalogAuthorityOf } = require(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const { isExactPoolRung } = require(path.join(backend, "dist", "services", "compiq", "fmvRung.js"));

const USER_ID = process.env.USER_ID || "";
const RECENT = Number(process.env.RECENT || 8);
const SINCE_180D = new Date(Date.now() - 180 * 864e5).toISOString();
// The price comparison is RAW-vs-raw: graded pool rows are excluded so a PSA 10
// pool never flags a raw holding (first run over-flagged Ohtani/Maddux this way).
const f = (n) => Number(n).toLocaleString();
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const COLOUR_WORDS = ["gold", "blue", "green", "orange", "red", "purple", "black", "silver", "pink", "yellow", "aqua", "sapphire", "sepia", "fuchsia", "magenta", "teal", "rose", "platinum", "bronze"];
const FINISH_WORDS = ["refractor", "x-fractor", "xfractor", "prizm", "mojo", "wave", "shimmer", "speckle", "lava", "atomic", "superfractor", "logofractor", "holo", "foil", "sapphire", "mini", "camo", "ice", "pulsar", "geometric", "raywave", "reptilian", "chrome"];
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function slugParts(slug) {
  const p = String(slug ?? "").split(":");
  if (p.length < 7 || p[0] !== "hiq") return null;
  const numSeg = p.slice(7).find((x) => /^num-\d+$/.test(x));
  return { sport: p[1], year: p[2], setKey: p[3], cardNumber: p[4], parallel: p[5], auto: p[6], printRun: numSeg ? Number(numSeg.slice(4)) : null, base: p.slice(0, 7).join(":") };
}

/** Does this title contradict the slug's parallel? Only colour words are
 *  judged (a title silent on "refractor" is not evidence either way). */
function titleContradicts(parallelSlug, title) {
  const t = String(title ?? "").toLowerCase();
  const slugColours = COLOUR_WORDS.filter((c) => parallelSlug.split("-").includes(c));
  const titleColours = COLOUR_WORDS.filter((c) => new RegExp("\\b" + c + "\\b").test(t));
  if (slugColours.length && !slugColours.some((c) => titleColours.includes(c))) return `slug says ${slugColours.join("/")}, title does not`;
  if (parallelSlug === "base" && titleColours.length && !/\bblue jays\b|\bred sox\b|\bredsox\b|\breds\b|\bwhite sox\b|\bgold glove\b|\bsilver slugger\b|\bblack ink\b/.test(t)) return `slug is Base, title says ${titleColours.join("/")}`;
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const portfolio = db.container("portfolio"), cat = db.container("card_catalog"), pool = db.container("sold_comps");
  const { resources: docs } = await retry(() => portfolio.items.query({ query: `SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)${USER_ID ? " AND c.userId = @u" : ""}`, parameters: USER_ID ? [{ name: "@u", value: USER_ID }] : [] }).fetchAll());
  const rows = [];
  for (const d of docs) for (const [hid, h] of Object.entries(d.holdings || {})) rows.push({ userId: d.userId, hid, h });
  console.log(`audit-all-holdings  READ-ONLY  ${f(docs.length)} portfolio docs, ${f(rows.length)} holdings${USER_ID ? `  user=${USER_ID}` : ""}\n`);

  const flags = { noSlug: 0, notInCatalog: 0, twinOfNumbered: 0, unbackedRow: 0, poolContradicts: 0, poolPrintRunMix: 0, priceOffPool: 0, crossIdentityRung: 0, noPrice: 0, clean: 0 };
  // D14 RUNGS: judged from the persisted fields alone, the way the digest gate
  // and iOS read them -- never inferred from estimateBasis prose.
  const rungs = { rungNull: 0, rungNonExact: 0, cardIdMismatch: 0, cardIdNotHiq: 0, estimateShown: 0, isEstimate: 0, estimateWhilePool: 0, labels: new Map() };
  const lines = [];
  for (const { userId, hid, h } of rows) {
    const slug = h.hobbyiqCardId || h.canonicalSlug || h.cardId || null;
    const title = h.cardTitle || h.title || `${h.cardYear ?? ""} ${h.setName ?? ""} ${h.playerName ?? ""} #${h.cardNumber ?? ""} ${h.parallel ?? ""}`;
    const fmv = typeof h.fairMarketValue === "number" ? h.fairMarketValue : null;
    const cost = typeof h.purchasePrice === "number" ? h.purchasePrice : (typeof h.costBasis === "number" ? h.costBasis : null);
    const method = h.pricingSourceMeta?.method ?? h.fmvRung ?? h.pricingSource ?? "-";
    const rung = typeof h.fmvRung === "string" && h.fmvRung ? h.fmvRung : null;
    if (rung == null) rungs.rungNull++; else if (!isExactPoolRung(rung)) rungs.rungNonExact++;
    rungs.labels.set(rung ?? "(null)", (rungs.labels.get(rung ?? "(null)") ?? 0) + 1);
    if (h.cardId && h.hobbyiqCardId && h.cardId !== h.hobbyiqCardId) rungs.cardIdMismatch++;
    if (h.cardId && !String(h.cardId).startsWith("hiq:")) rungs.cardIdNotHiq++;
    if (fmv == null && typeof h.estimatedValue === "number" && h.estimatedValue > 0) rungs.estimateShown++;
    if (h.isEstimate === true) rungs.isEstimate++;
    const fl = [];
    const parts = slugParts(slug);
    if (!parts) { fl.push("NO-SLUG"); flags.noSlug++; }
    let catRow = null, numberedTwins = [];
    if (parts) {
      try { catRow = (await retry(() => cat.item(slug, slug).read())).resource ?? null; } catch (e) { if (e?.code !== 404) throw e; }
      if (!catRow) { fl.push("NOT-IN-CATALOG"); flags.notInCatalog++; }
      else if (catalogAuthorityOf(String(catRow.source ?? "")) !== "checklist") {
        // is there a numbered checklist twin this row should have been?
        const { resources: twins } = await retry(() => cat.items.query({ query: "SELECT c.id, c.source, c.printRun FROM c WHERE STARTSWITH(c.id, @p) AND NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.printRun) AND c.printRun != null", parameters: [{ name: "@p", value: parts.base + ":num-" }] }).fetchAll());
        numberedTwins = twins.filter((t) => catalogAuthorityOf(String(t.source ?? "")) === "checklist");
        if (parts.printRun == null && numberedTwins.length === 1) { fl.push(`TWIN-OF ${numberedTwins[0].id.split(":").slice(7).join(":")} [${numberedTwins[0].source}]`); flags.twinOfNumbered++; }
        else { fl.push(`UNBACKED-ROW [${catRow.source}]`); flags.unbackedRow++; }
      }
      // the pool under this slug
      const { resources: sales } = await retry(() => pool.items.query({ query: "SELECT TOP 40 c.title, c.price, c.soldAt, c.source, c.parallel, c.printRun FROM c WHERE c.hobbyiqCardId = @s AND c.price > 0 AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null OR c.gradeCompany = '') ORDER BY c.soldAt DESC", parameters: [{ name: "@s", value: slug }] }).fetchAll());
      const contra = sales.map((r) => titleContradicts(parts.parallel, r.title)).filter(Boolean);
      if (contra.length) { fl.push(`POOL-CONTRADICTS ${contra.length}/${sales.length} (${contra[0]})`); flags.poolContradicts++; }
      const prs = new Set(sales.map((r) => r.printRun).filter((x) => typeof x === "number"));
      if (parts.printRun != null && [...prs].some((x) => x !== parts.printRun)) { fl.push(`POOL-PRINTRUN-MIX slug /${parts.printRun} vs ${[...prs].join("/")}`); flags.poolPrintRunMix++; }
      // the exact pool is keyed by hobbyiqCardId; `sales` is that pool only
      // when the slug came from it (newest 40, so >= 3 within 180d is exact)
      if (h.isEstimate === true && h.hobbyiqCardId && slug === h.hobbyiqCardId && sales.filter((r) => String(r.soldAt ?? "") >= SINCE_180D).length >= 3) rungs.estimateWhilePool++;
      const exact = sales.filter((r) => !titleContradicts(parts.parallel, r.title)).map((r) => r.price);
      const med = median(exact.slice(0, RECENT));
      if (fmv == null) { fl.push("NO-PRICE"); flags.noPrice++; }
      else if (med != null && (fmv > 2 * med || fmv < med / 2)) { fl.push(`PRICE-OFF-POOL fmv=$${fmv} vs recent-median=$${med} (n=${exact.length})`); flags.priceOffPool++; }
      if (/cross-setkey|sibling|neighbor|model|grade-cross|composite/i.test(String(method))) { fl.push(`CROSS-RUNG ${method}`); flags.crossIdentityRung++; }
      lines.push({ userId, hid, title, slug, fmv, cost, method, n: sales.length, fl });
    } else lines.push({ userId, hid, title, slug, fmv, cost, method, n: 0, fl });
    if (!fl.length) flags.clean++;
  }
  lines.sort((a, b) => b.fl.length - a.fl.length);
  for (const l of lines) console.log(`${String(l.userId).slice(0, 13).padEnd(13)} ${l.hid.slice(0, 8)}  ${String(l.title).slice(0, 46).padEnd(46)}  fmv=${l.fmv == null ? "-" : "$" + l.fmv}  cost=${l.cost == null ? "-" : "$" + l.cost}  n=${l.n}  ${l.method}\n              ${l.slug ?? "(no slug)"}\n              ${l.fl.length ? l.fl.join(" | ") : "clean"}`);
  console.log(`\nROLL-UP (${f(rows.length)} holdings)`);
  for (const [k, v] of Object.entries(flags)) console.log(`  ${k.padEnd(20)} ${f(v)}`);

  const n = rows.length, p = (a, d = n) => `${f(a)} (${d ? (100 * a / d).toFixed(1) : "0.0"}%)`;
  console.log(`\nRUNGS (${f(n)} holdings)  -- the persisted fields the digest and iOS read`);
  console.log(`  fmvRung null                              ${p(rungs.rungNull)}`);
  console.log(`  fmvRung not an exact-pool rung            ${p(rungs.rungNonExact)}`);
  console.log(`  cardId != hobbyiqCardId                   ${p(rungs.cardIdMismatch)}`);
  console.log(`  cardId not an hiq: slug                   ${p(rungs.cardIdNotHiq)}`);
  console.log(`  estimatedValue shown (fairMarketValue null) ${p(rungs.estimateShown)}`);
  console.log(`  isEstimate while exact pool >= 3 (180d)   ${p(rungs.estimateWhilePool, rungs.isEstimate)}   of ${f(rungs.isEstimate)} isEstimate holdings`);
  console.log(`  fmvRung labels: ${[...rungs.labels].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${f(v)}`).join(", ")}`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
