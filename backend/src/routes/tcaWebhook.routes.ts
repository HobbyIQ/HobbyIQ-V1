/**
 * CF-TCA-WEBHOOK (Drew, 2026-08-02). Receives push notifications from
 * thecardapi.com when new eBay sales are indexed (~30 sec latency,
 * batches of up to 1000). Bypasses our daily-query quota entirely.
 *
 * Registration: POST https://thecardapi.com/api/v1/market/webhook
 *   { url: "https://hobbyiq3-.../api/tca/webhook", secret: "<shared>" }
 * TCA then POSTs batches to us signed with HMAC-SHA256(secret, body).
 *
 * Route responsibilities:
 *   1. Verify X-Webhook-Signature header (HMAC-SHA256 of raw body
 *      against TCA_WEBHOOK_SECRET). Reject on mismatch.
 *   2. Parse batch payload (same shape as GET /sales row).
 *   3. Route each row through persistVendorSalesToPool — same clean
 *      pipeline as the pull ingest (identity parse, hobbyiqCardId,
 *      contentHash dedup, staging shim, image mirror).
 *   4. Respond 200 within TCA's 30-sec timeout. On non-2xx, TCA
 *      retries 3× (0s / 5s / 30s backoff) then holds cursor.
 *
 * IDEMPOTENCY: persistVendorSalesToPool dedups by (hobbyiqCardId,
 * contentHash), so replayed batches are safe.
 */

import { Router, Request, Response } from "express";
import express from "express";
import crypto from "crypto";
import { persistVendorSalesToPool } from "../services/portfolioiq/persistVendorSalesToPool.service.js";
import { matchKnownProductLine } from "../services/portfolioiq/hobbyIqCardId.service.js";

/**
 * CF-ONE-PIECE-IS-NOT-A-BOWMAN-CARD (Drew, 2026-08-25). Decide whether TCA's
 * `card_set` may be trusted as a setName hint.
 *
 * This is the other half of CF-SPORT-PRIORITY-INVERT. That fix stopped trusting
 * TCA's `sport` when the title said otherwise, but left `card_set` trusted
 * absolutely -- and TCA mis-categorises a TCG card wholesale, not one field at
 * a time. Still arriving as of 2026-08-23:
 *
 *   "2024 One Piece OP07 Japanese Manga Alternate Art #051 Boa Hancock"
 *     -> hiq:anime-tcg:2024:bowman:051:base:no-auto
 *
 * 30,829 One Piece and Naruto sales filed under setKey `bowman`, polluting the
 * most valuable namespace we have. Our own title parse gets this right
 * unaided -- inferSetKeyFromTitle returns "Unknown" for every one of them -- so
 * the vendor hint is the ONLY thing introducing the error.
 *
 * @param catSport  non-sport category detected from the title, or null
 * @param vendorSet TCA's card_set value
 * @returns the hint to use, or null to drop it and let the title parse speak
 */
export function vendorSetNameHint(catSport: string | null, vendorSet: string): string | null {
  const set = String(vendorSet ?? "").trim();
  if (!set) return null;
  // A sports title keeps the vendor's set: that is the case it is good at.
  if (!catSport) return set;
  // The title says TCG / non-sport. A card_set naming a real SPORTS product
  // line is vendor mis-categorisation by definition -- drop it.
  if (matchKnownProductLine(set) !== null) return null;
  // A set we do not recognise as a sports line is still useful: "One Piece
  // OP07" is a genuine hint and must survive. Dropping every hint on TCG rows
  // would trade one bug for a worse one.
  return set;
}

const router = Router();

// TCA webhook posts JSON; we need the RAW body to verify HMAC before
// JSON.parse. Use express.raw() on this route so req.body is a Buffer.
const rawJson = express.raw({ type: "application/json", limit: "8mb" });

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  // Header shape per docs: "sha256=<hex>"
  const provided = String(signatureHeader).trim();
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface TcaSaleRow {
  id: string;
  title?: string | null;
  price?: number | null;
  sold_at?: string | null;
  sale_date?: string | null;
  listing_url?: string | null;
  image_url?: string | null;
  player?: string | null;
  year?: number | null;
  sport?: string | null;
  card_set?: string | null;
  card_number?: string | null;
  platform?: string | null;
  category?: string | null;
}

// CF-TCA-WEBHOOK-CURSOR-TEST (Drew, 2026-08-03). Both /webhook and
// /webhook-v2 hit the same handler. Each is registered as a distinct
// TCA endpoint (separate id), so if TCA's cursor is per-endpoint,
// the v2 route will receive fresh sold_at values while the original
// keeps grinding through the May-June 2026 backlog. If both get the
// same historical dates, the cursor is per-account/key and only
// TCA support can reset it. Endpoint label logged for split diagnosis.
async function webhookHandler(req: Request, res: Response, endpointLabel: string) {
  const startMs = Date.now();
  const secret = process.env.TCA_WEBHOOK_SECRET ?? "";
  const rawBody = req.body as Buffer;

  // 1. Signature check
  if (!Buffer.isBuffer(rawBody)) {
    console.warn(`[tca.webhook] body is not a buffer — express.raw() didn't fire`);
    res.status(400).json({ error: "bad body" });
    return;
  }
  const sig = req.header("x-webhook-signature") || req.header("X-Webhook-Signature");
  if (!verifySignature(rawBody, sig || undefined, secret)) {
    console.warn(JSON.stringify({
      event: "tca.webhook.signature_invalid",
      source: "tcaWebhook.routes",
      sigHeaderPresent: !!sig,
      secretPresent: !!secret,
      bodyBytes: rawBody.length,
    }));
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // 2. Parse
  let payload: { event?: string; count?: number; data?: TcaSaleRow[] };
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch (err) {
    console.warn(`[tca.webhook] json parse failed: ${(err as Error)?.message}`);
    res.status(400).json({ error: "bad json" });
    return;
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  // CF-TCA-WEBHOOK-ACK-FIRST (Drew, 2026-08-07). Eric at TCA flagged that
  // our handler was timing out — synchronous processing of up to 1000
  // rows per batch (LLM enrichment + catalog match + Cosmos upsert per
  // row) blew past TCA's 10s ack window on nearly every delivery, so
  // TCA retried the same batch endlessly and it *looked* like the cursor
  // was frozen. It wasn't: 68M pg_ids advanced since Aug 3, one batch
  // per rare success.
  //
  // Fix: ack 200 as soon as signature verified + JSON parsed. Kick the
  // processing loop into a detached background task. TCA sees our
  // response in <100ms, marks the batch acked, cursor advances, next
  // batch delivers. Idempotent semantics on our side already protect
  // us: persistVendorSalesToPool dedups by (hobbyiqCardId, contentHash)
  // so a retried-then-late-processed row is a no-op.
  const ackedAtMs = Date.now();
  res.status(200).json({ ok: true, queued: rows.length });
  // Everything below runs after the response is sent — TCA already got
  // its ack. Errors here are logged but never surface to TCA.
  void processBatchAsync(rows, payload, endpointLabel, startMs, ackedAtMs).catch((err) => {
    console.error(`[tca.webhook] async processing crashed: ${(err as Error)?.message}`);
  });
}

async function processBatchAsync(
  rows: TcaSaleRow[],
  payload: { event?: string; count?: number; data?: TcaSaleRow[] },
  endpointLabel: string,
  startMs: number,
  ackedAtMs: number,
): Promise<void> {
  const ackLatencyMs = ackedAtMs - startMs;

  // TEMP DIAG (Drew, 2026-08-02): count STRUCTURED identity coverage
  // across the batch to see whether TCA is actually populating
  // card_number / player / year on their side. Remove once ingest is
  // healthy.
  if (rows.length > 0) {
    let hasCardNumber = 0, hasPlayer = 0, hasYear = 0, hasSet = 0, hasSport = 0, hasPrice = 0, hasSoldAt = 0, hasTitle = 0;
    for (const t of rows as TcaSaleRow[]) {
      if (t.card_number) hasCardNumber++;
      if (t.player) hasPlayer++;
      if (typeof t.year === "number" && t.year > 1800) hasYear++;
      if (t.card_set) hasSet++;
      if (t.sport) hasSport++;
      if (typeof t.price === "number" && t.price > 0) hasPrice++;
      if (t.sold_at || t.sale_date) hasSoldAt++;
      if (t.title) hasTitle++;
    }
    const first = rows[0];
    // Sample sold_at values across the batch to distinguish
    // per-endpoint vs per-account cursor semantics.
    const soldAtSamples = rows.slice(0, 5).map((r) => (r as TcaSaleRow).sold_at || (r as TcaSaleRow).sale_date || null);
    const soldAtMax = rows.reduce<string | null>((mx, r) => {
      const v = (r as TcaSaleRow).sold_at || (r as TcaSaleRow).sale_date || null;
      return v && (!mx || v > mx) ? v : mx;
    }, null);
    console.log(JSON.stringify({
      event: "tca.webhook.batch_coverage",
      source: "tcaWebhook.routes",
      endpoint: endpointLabel,
      batch: rows.length,
      hasTitle, hasPrice, hasSoldAt, hasCardNumber, hasPlayer, hasYear, hasSet, hasSport,
      soldAtSamples,
      soldAtMax,
      firstRow: {
        title: first?.title?.slice?.(0, 100),
        card_number: first?.card_number,
        player: first?.player,
        year: first?.year,
        card_set: first?.card_set,
        sport: first?.sport,
        category: first?.category,
        platform: first?.platform,
      },
    }));
  }

  // 3. TCA webhook is uncategorized — pushes sports + TCG + non_sport
  //    all in the same batch (their docs: "cannot filter subscriptions
  //    by category"). We keep everything, but tag non-sports with a
  //    specific sport hint (pokemon / tcg-other / non-sport) so the
  //    existing sport IN ('baseball','basketball',...) filters
  //    naturally exclude them from FMV/calibration pools while the
  //    raw data stays queryable for follow-on categorization.
  // CF-CATEGORY-MARKERS-EXPANDED (Drew, 2026-08-08). Tonight's probe
  // caught Pokemon rows ("Snorlax - SV08: Surging Sparks") landing as
  // sport=baseball because TCA's vendor sport field wins over our
  // title detector, AND the title has no literal word "pokemon" in it
  // — just the Pokemon character + set code. Extending markers to
  // catch:
  //   - Pokemon set-code prefixes (SV##, SWSH##, XY##, BW##, DP##,
  //     HGSS##, PL##, EX##, TG##, obf, twm etc.)
  //   - F1 / Formula 1 (was showing up as "Formula Arvid Lindblad
  //     Autographs" earlier)
  //   - WWE / WWF / AEW / wrestling
  //   - UFC / MMA / NASCAR / Racing
  //   - Card-number in "###/###" format is Pokemon-specific (sports
  //     never use it — sports cardNumbers are bare integers or
  //     letter-prefix like BCP-102, CPA-EHA)
  const CATEGORY_MARKERS: Array<[RegExp, string]> = [
    [/\b(pokemon|pok[eé]?mon)\b/i, "pokemon"],
    // Pokemon set-code prefixes — SV##, SWSH##, XY##, BW##, etc.
    [/\b(SV\d{1,2}|SWSH\d{1,2}|XY\d{1,3}|BW\d{1,3}|HGSS\d{1,3}|DP\d{1,3}|PL\d{1,3})\b/i, "pokemon"],
    // Pokemon set names (colon-prefix like "SV: Scarlet & Violet",
    // "SWSH: ...", "XY: ..." plus set-name words that only Pokemon uses)
    [/\b(SV:|SWSH:|XY:|BW:|HGSS:|scarlet\s*&\s*violet|sword\s*&\s*shield|prismatic\s+evolutions|surging\s+sparks|obsidian\s+flames|paldea\s+evolved|fusion\s+strike)\b/i, "pokemon"],
    // Pokemon-only parallel names — "Holofoil" / "Reverse Holofoil" /
    // "Rainbow Rare" don't appear on sports cards.
    [/\b(reverse\s+holofoil|holofoil|rainbow\s+rare|full\s+art\s+trainer|shining\s+rare)\b/i, "pokemon"],
    // CF-SLASH-FORMAT-REMOVED (Drew, 2026-08-08). Previously used
    // /\b\d{1,3}\/\d{2,3}\b/ to catch Pokemon "023/131"-style card
    // numbers in-title. FALSE POSITIVE RATE was catastrophic —
    // matched print-run notation on legit sports cards ("Auto 10/150",
    // "Blue Refractor 008/150" on Bowman Draft baseball autos), which
    // would have kicked ~20% of the baseball pool into Pokemon on
    // the next re-clean. Removed. Pokemon coverage is still solid
    // via the set-code (SV##, SWSH##), colon-set (SV:, SWSH:), and
    // Pokemon-only-parallel (Holofoil) rules above.
    [/\b(yugioh|yu-?gi-?oh)\b/i, "yugioh"],
    [/\b(magic\s+the\s+gathering|\bmtg\b|hearthstone|lorcana|flesh\s+and\s+blood)\b/i, "tcg-other"],
    [/\b(dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|hunter\s*x\s*hunter|jujutsu\s+kaisen|attack\s+on\s+titan|naruto|my\s+hero\s+academia|demon\s+slayer)\b/i, "anime-tcg"],
    // Non-sport entertainment / IP.
    // CF-SKYBOX-IS-NBA (Drew, 2026-08-08). Removed "skybox" from this
    // list — Skybox is primarily an NBA brand (1990s Skybox Premium,
    // Skybox EX). The only Skybox non-sport product I've seen is
    // "The Boys" trading cards, which is already caught by "the boys".
    // If Skybox has other non-sport lines they'll need explicit
    // product-name entries here, not a brand-wide gate.
    [/\b(star\s+wars|halo|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|dungeons|d\s*&\s*d|d&d|world\s+of\s+warcraft|\bwow\b|the\s+boys)\b/i, "non-sport"],
    // Motorsport
    [/\b(formula\s*1|formula\s*one|\bf1\b|nascar|indycar|motogp)\b/i, "motorsport"],
    // Combat sports outside the VALID_5 sports pool
    [/\b(\bwwe\b|\bwwf\b|\baew\b|wrestling|\bufc\b|\bmma\b|pride\s+fc|bellator)\b/i, "combat-sport"],
  ];
  function detectCategorySport(title: string | null | undefined): string | null {
    if (!title) return null;
    for (const [re, tag] of CATEGORY_MARKERS) if (re.test(title)) return tag;
    return null;
  }
  let inserted = 0, deduped = 0, skipped = 0, errors = 0;
  // Vendor card_set values discarded because the title says TCG and the value
  // named a sports product. Counted so the mis-categorisation stays visible.
  let tcgSetHintDropped = 0;
  // Skip-reason instrumentation (Drew, 2026-08-02). Track WHERE we're
  // losing rows so we can prioritize which parser gate to fix first.
  const skipReasons = {
    no_price_or_date: 0,
    persist_skipped: 0,    // persistVendorSalesToPool returned skipped>0
  };
  const skipSamples: Record<string, string[]> = {
    no_price_or_date: [],
    persist_skipped: [],
  };
  // CF-LLM-BATCH-PREWARM-WEBHOOK (Drew, 2026-08-03). Pre-warm the
  // LLM cache with ONE batched call for every eligible title in this
  // webhook batch. Downstream per-row persistVendorSalesToPool calls
  // then hit the cache instead of firing an LLM call per row —
  // background path, no user-facing latency impact. Gated on
  // PERSIST_LLM_BATCH_ENABLED (safe to toggle without redeploy).
  if (rows.length >= 4
      && process.env.PERSIST_LLM_BATCH_ENABLED === "true"
      && process.env.PERSIST_LLM_ENRICH_ENABLED === "true") {
    try {
      const sportsSet = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
      const candidateTitles: string[] = [];
      for (const r of rows) {
        const title = (r.title || "").trim();
        if (title.length < 15) continue;
        // Skip non-sports (matches persistVendorSalesToPool's
        // skipLlmForSport gate) — don't waste batch tokens on Pokemon.
        const sportHint = r.sport ? String(r.sport).toLowerCase() : detectCategorySport(title);
        if (sportHint && !sportsSet.has(sportHint)) continue;
        candidateTitles.push(title);
      }
      if (candidateTitles.length >= 2) {
        const { parseTitlesBatchWithAi } = await import("../services/portfolioiq/titleParserAi.service.js");
        await parseTitlesBatchWithAi(candidateTitles);
      }
    } catch { /* soft — per-row fallback still works */ }
  }
  const CONCURRENCY = 48;
  const inflight = new Set<Promise<unknown>>();
  for (const t of rows) {
    // CF-TCA-WEBHOOK-ACK-FIRST removed the 25s hard-bail budget that
    // used to sit here. Rationale: the bail existed to beat TCA's 10s
    // ack window on sync-processing batches. Now that we ack in <100ms
    // (before this loop runs), dropping rows to "save time" would just
    // silently lose data TCA already thinks we processed. Let the loop
    // run to completion; idempotency protects us against future retries.
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const vsRow = {
      title: t.title || null,
      price: typeof t.price === "number" ? t.price : Number(t.price ?? 0),
      soldAt: t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null),
      url: t.listing_url || null,
      externalId: t.id || null,
      imageUrl: t.image_url || null,
    };
    if (!vsRow.soldAt || !(vsRow.price > 0)) {
      skipped++;
      skipReasons.no_price_or_date++;
      if (skipSamples.no_price_or_date.length < 2) skipSamples.no_price_or_date.push(vsRow.title?.slice(0, 100) || "(no title)");
      continue;
    }
    // Pass every structured field TCA gave us so persistVendorSalesToPool
    // doesn't have to guess from the title (which fails on ~90% of raw
    // eBay titles). See VendorPersistIdentityHint.
    const hint: Record<string, unknown> = {};
    if (t.player) hint.playerName = String(t.player);
    if (typeof t.year === "number") hint.cardYear = t.year;
    // CF-SPORT-PRIORITY-INVERT (Drew, 2026-08-08). Title-based
    // non-sport detection now wins over TCA's vendor sport tag.
    // Rationale: TCA defaults many TCG cards (Pokemon SV/SWSH sets,
    // etc.) to sport="baseball", which poisoned baseball FMV pools
    // for weeks. Our regex-based detector catches Pokemon/YGO/MTG/
    // motorsport/combat-sport reliably from title text. Only when
    // NO non-sport marker fires do we trust TCA's tag.
    // Downstream FMV/calibration filters on sport IN (baseball,
    // basketball, football, hockey, soccer) — non-sport tagged
    // values stay in the pool but don't corrupt those aggregations.
    const catSport = detectCategorySport(vsRow.title);
    if (catSport) {
      hint.sport = catSport;
    } else if (t.sport) {
      hint.sport = String(t.sport).toLowerCase();
    }
    if (t.card_number) hint.cardNumber = String(t.card_number);
    // CF-ONE-PIECE-IS-NOT-A-BOWMAN-CARD (Drew, 2026-08-25). The other half of
    // CF-SPORT-PRIORITY-INVERT above. That fix stopped trusting TCA's `sport`
    // when the title says otherwise, but left `card_set` trusted absolutely --
    // and TCA mis-categorises a TCG card wholesale, not one field at a time.
    // The result, still arriving as of 2026-08-23:
    //
    //   "2024 One Piece OP07 Japanese Manga Alternate Art #051 Boa Hancock"
    //     -> hiq:anime-tcg:2024:bowman:051:base:no-auto
    //
    // 30,829 One Piece and Naruto sales filed under setKey `bowman`, polluting
    // the single most valuable namespace we have. Our own title parse gets this
    // right on its own -- inferSetKeyFromTitle returns "Unknown" for all of
    // them -- so the vendor hint is the only thing introducing the error.
    //
    // When the title has already told us this is a TCG/non-sport card, a
    // `card_set` naming a real SPORTS product line is vendor mis-categorisation
    // by definition. Drop it and let the title parse speak. A card_set we do
    // not recognise as a sports line is still passed through: "One Piece OP07"
    // is a genuinely useful hint and must survive.
    const vendorSet = t.card_set ? String(t.card_set) : "";
    const keptSet = vendorSetNameHint(catSport, vendorSet);
    if (keptSet) hint.setName = keptSet;
    else if (vendorSet) tcgSetHintDropped++;
    // TCA payload doesn't split parallel from card_set (grade/grader are
    // separate fields, but parallel is baked into set/features). Leave
    // parallel + printRun + isAuto to fall through to title-parse.
    const p = persistVendorSalesToPool("tca-ebay", [vsRow], hint)
      .then((res) => {
        inserted += res.inserted;
        deduped += res.deduped;
        skipped += res.skipped;
        if (res.skipped > 0 && res.inserted === 0) {
          skipReasons.persist_skipped++;
          if (skipSamples.persist_skipped.length < 5) {
            skipSamples.persist_skipped.push(vsRow.title?.slice(0, 120) || "(no title)");
          }
        }
      })
      .catch((err) => {
        errors++;
        if (errors < 10) console.warn(`  webhook persist failed id=${t.id}: ${err?.code ?? err?.message ?? err}`);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all([...inflight]);

  const elapsedMs = Date.now() - startMs;
  console.log(JSON.stringify({
    event: "tca.webhook.batch_processed",
    source: "tcaWebhook.routes",
    endpoint: endpointLabel,
    event_type: payload?.event ?? null,
    batch_size: rows.length,
    inserted, deduped, skipped, errors, tcgSetHintDropped,
    skipReasons,
    skipSamples,
    elapsedMs,
    ackLatencyMs, // time from receipt to 200 ack (must stay <<10s)
  }));
}

router.post("/webhook", rawJson, (req, res) => webhookHandler(req, res, "v1"));
router.post("/webhook-v2", rawJson, (req, res) => webhookHandler(req, res, "v2"));

// GET endpoint for TCA registration validation (some webhook systems
// probe with a GET before allowing POST subscriptions).
router.get("/webhook", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, service: "tca-webhook-receiver" });
});

export default router;
