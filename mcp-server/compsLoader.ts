// HTTP-backed comp loader for the MCP server (Phase 2 of MCP rewire).
//
// Replaces the prior blob-read path (`compiq-signals/{player-slug}/cardhedge.json`
// written nightly by `fn-cardhedge-comps`) with an HTTP call to the backend's
// `/api/compiq/comps-by-player` endpoint, which itself aggregates live
// Cardsight pricing data. The MCP server no longer depends on the nightly
// blob writer.
//
// Design: docs/phase0/mcp_rewire_design.md (61e2d5c) — Option B / addendum.
// Backend endpoint contract: docs/phase0/mcp_rewire_design.md addendum §5
// "Endpoint signature change". Q1 finding mandates `product` is REQUIRED on
// the new endpoint (Cardsight catalog text-relevance buries Topps Update
// Base Sets when only player+year is given).
//
// Caller adjustments:
//  - server.ts /predict passes `body.set` as product (already in scope at
//    line 239 as `setName`).
//  - backtest.ts groups predictions by player+product (per PR #119 / b6ec8a3)
//    and passes the group's product per fetch.
//
// Failure handling: HTTP error or network failure returns `[]` (same as the
// prior blob-miss behavior). pricing.ts tolerates empty comps via its
// neutral-multiplier fallback. Empty `product` also returns `[]` since the
// backend requires it.
//
// No MCP-side cache layer — the backend's compsByPlayer.service.ts owns the
// 6h Redis-backed aggregate cache (per design Q3). MCP becomes a thin
// HTTP client.

import type { CardComp } from "./pricing.js";

const BACKEND_URL =
  process.env.HOBBYIQ_BACKEND_URL?.trim() ??
  process.env.COMPIQ_BACKEND_URL?.trim() ??
  "";

const HTTP_TIMEOUT_MS = 30_000;

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "compsLoader", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "compsLoader", ...fields })),
};

/**
 * Player-slug helper kept for backward compatibility with any external
 * consumer (the previous blob-read path used this for `{slug}/cardhedge.json`).
 * The HTTP path doesn't use slugs — the backend handles normalization.
 */
export function playerSlug(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

interface CompsByPlayerResponse {
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: Array<{
    cardId: string;
    price: number;
    date: string;
    title: string;
    source: string;
  }>;
  cached: boolean;
  cacheAge?: number;
  warnings: string[];
}

export interface FetchPlayerCompsOpts {
  /** Card year — narrows the catalog search and bypasses year-mismatched cards. */
  cardYear?: number;
  /** Preferred grade label applied to each returned CardComp (raw default). */
  preferredGrade?: string;
}

/**
 * Fetch player+product comps from the backend aggregation endpoint.
 *
 * Returns `[]` (graceful degradation) when:
 *  - `HOBBYIQ_BACKEND_URL` is not configured (local dev without backend)
 *  - `product` is empty/missing (backend requires it; we don't fail-fast)
 *  - Backend returns non-2xx or empty `comps[]`
 *  - Network failure / timeout
 *
 * The empty-array contract matches the prior blob-read behavior so
 * pricing.ts's neutral-multiplier fallback path continues to work
 * unchanged.
 */
export async function fetchPlayerComps(
  playerName: string,
  product: string,
  opts: FetchPlayerCompsOpts = {},
): Promise<CardComp[]> {
  if (!BACKEND_URL) {
    log.warn("backend_url_missing", { playerName, product });
    return [];
  }
  if (!playerName?.trim() || !product?.trim()) {
    log.warn("missing_required_input", {
      hasPlayerName: !!playerName?.trim(),
      hasProduct: !!product?.trim(),
    });
    return [];
  }

  const params = new URLSearchParams({
    playerName: playerName.trim(),
    product: product.trim(),
  });
  if (opts.cardYear != null && Number.isFinite(opts.cardYear)) {
    params.set("cardYear", String(opts.cardYear));
  }

  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/compiq/comps-by-player?${params}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      log.warn("backend_http_error", {
        status: res.status,
        playerName,
        product,
        cardYear: opts.cardYear ?? null,
        elapsedMs: Date.now() - start,
      });
      return [];
    }

    const body = (await res.json()) as CompsByPlayerResponse;
    if (!Array.isArray(body?.comps) || body.comps.length === 0) {
      log.info("backend_empty_comps", {
        playerName,
        product,
        cardYear: opts.cardYear ?? null,
        cardIds: body?.cardIds?.length ?? 0,
        warnings: body?.warnings ?? [],
        elapsedMs: Date.now() - start,
      });
      return [];
    }

    const grade = opts.preferredGrade ?? "Raw";
    const comps: CardComp[] = body.comps.map((c) => ({
      price: Number(c.price),
      date: c.date,
      grade,
      source: c.source ?? "cardsight",
      title: c.title,
    }));

    log.info("backend_fetch_ok", {
      playerName,
      product,
      cardYear: opts.cardYear ?? null,
      compsCount: comps.length,
      cardIdsCount: body.cardIds?.length ?? 0,
      cached: body.cached,
      cacheAgeMs: body.cacheAge ?? null,
      elapsedMs: Date.now() - start,
    });

    return comps;
  } catch (err: any) {
    const msg =
      err?.name === "AbortError"
        ? `backend_timeout after ${HTTP_TIMEOUT_MS}ms`
        : err?.message ?? String(err);
    log.warn("backend_fetch_failed", {
      playerName,
      product,
      cardYear: opts.cardYear ?? null,
      error: msg,
      elapsedMs: Date.now() - start,
    });
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}
