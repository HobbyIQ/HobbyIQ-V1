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

router.post("/webhook", rawJson, async (req: Request, res: Response) => {
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
    console.log(JSON.stringify({
      event: "tca.webhook.batch_coverage",
      source: "tcaWebhook.routes",
      batch: rows.length,
      hasTitle, hasPrice, hasSoldAt, hasCardNumber, hasPlayer, hasYear, hasSet, hasSport,
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

  // 3. Process synchronously with high concurrency. TCA times out at
  //    30 sec — must finish within that. 1000 rows × ~150ms serial =
  //    150s. With concurrency 48 that's ~3s. Safely inside window.
  //    persistVendorSalesToPool is idempotent (contentHash dedup) so
  //    replayed batches are safe.
  let inserted = 0, deduped = 0, skipped = 0, errors = 0;
  const CONCURRENCY = 48;
  const inflight = new Set<Promise<unknown>>();
  for (const t of rows) {
    if (Date.now() - startMs > 25_000) {
      // Approach TCA's timeout — return early so they don't retry.
      // Remaining rows will re-deliver on the next batch (cursor holds
      // per TCA's retry semantics).
      console.warn(`[tca.webhook] 25s budget exceeded — bailing out, ${rows.length - inserted - deduped - skipped - errors} rows unprocessed`);
      break;
    }
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const vsRow = {
      title: t.title || null,
      price: typeof t.price === "number" ? t.price : Number(t.price ?? 0),
      soldAt: t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null),
      url: t.listing_url || null,
      externalId: t.id || null,
      imageUrl: t.image_url || null,
    };
    if (!vsRow.soldAt || !(vsRow.price > 0)) { skipped++; continue; }
    // Pass every structured field TCA gave us so persistVendorSalesToPool
    // doesn't have to guess from the title (which fails on ~90% of raw
    // eBay titles). See VendorPersistIdentityHint.
    const hint: Record<string, unknown> = {};
    if (t.player) hint.playerName = String(t.player);
    if (typeof t.year === "number") hint.cardYear = t.year;
    if (t.sport) hint.sport = String(t.sport).toLowerCase();
    if (t.card_number) hint.cardNumber = String(t.card_number);
    if (t.card_set) hint.setName = String(t.card_set);
    // TCA payload doesn't split parallel from card_set (grade/grader are
    // separate fields, but parallel is baked into set/features). Leave
    // parallel + printRun + isAuto to fall through to title-parse.
    const p = persistVendorSalesToPool("tca-ebay", [vsRow], hint)
      .then((res) => { inserted += res.inserted; deduped += res.deduped; skipped += res.skipped; })
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
    event_type: payload?.event ?? null,
    batch_size: rows.length,
    inserted, deduped, skipped, errors,
    elapsedMs,
  }));

  res.status(200).json({ ok: true, inserted, deduped, skipped, errors, elapsedMs });
});

// GET endpoint for TCA registration validation (some webhook systems
// probe with a GET before allowing POST subscriptions).
router.get("/webhook", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, service: "tca-webhook-receiver" });
});

export default router;
