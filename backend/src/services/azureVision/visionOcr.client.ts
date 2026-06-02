// CF-GRADED-SCAN-B1 (2026-06-02) — Azure Computer Vision Read OCR client.
//
// Calls Azure Computer Vision's Read API (the recommended OCR endpoint
// for printed + handwritten text). Used by /api/portfolio/identify when
// `extractCert` is opt-in true, in parallel with the existing Cardsight
// identify call.
//
// Read API is async: POST to /read/analyze returns 202 + operation-location
// header; poll the operation-location until status=succeeded; parse the
// analyzeResult.readResults pages.
//
// Configuration via App Settings on HobbyIQ3:
//   AZURE_VISION_ENDPOINT — e.g. https://hobbyiq-dev.cognitiveservices.azure.com/
//   AZURE_VISION_API_KEY  — primary key (set, never echoed)
//
// Error contract: this module NEVER throws to callers. Cert extraction is
// best-effort; OCR failures gracefully degrade to "no certCandidate" on
// the response so the user still gets the Cardsight identify result.
// Failures are logged + return null.

const READ_API_VERSION = "v3.2";

export interface OcrLine {
  /** Concatenated text of the line. */
  text: string;
  /** Per-line confidence — Read API returns this on each word; we take
   *  the average across the line's words. Bounded 0..1. */
  confidence: number;
}

export interface OcrResult {
  /** Flattened list of lines across all pages, top-to-bottom reading order. */
  lines: OcrLine[];
  /** Wall-clock duration of the full extract round-trip (ms). */
  durationMs: number;
}

const TIMEOUT_MS = 8_000;     // Per-request timeout (single fetch)
const MAX_POLL_MS = 12_000;   // Total polling budget after initial POST
const POLL_INTERVAL_MS = 500;

function endpointBase(): string | null {
  const raw = String(process.env.AZURE_VISION_ENDPOINT ?? "").trim();
  if (!raw) return null;
  // Normalize: strip trailing slash.
  return raw.replace(/\/+$/, "");
}

function apiKey(): string | null {
  const raw = String(process.env.AZURE_VISION_API_KEY ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Best-effort OCR extraction. Returns lines + per-line confidence on
 * success; returns null when:
 *   - AZURE_VISION_ENDPOINT or AZURE_VISION_API_KEY is unset
 *   - Read API returns a non-2xx status
 *   - Polling times out before status=succeeded
 *   - Network error / fetch throws
 *
 * Callers MUST treat null as "no OCR available" and continue without
 * a certCandidate. NEVER throws.
 */
export async function extractTextFromImage(
  imageBuffer: Buffer | Uint8Array,
): Promise<OcrResult | null> {
  const start = Date.now();
  const base = endpointBase();
  const key = apiKey();
  if (!base || !key) {
    console.warn(
      "[vision-ocr] AZURE_VISION_ENDPOINT or AZURE_VISION_API_KEY not set; OCR disabled",
    );
    return null;
  }

  try {
    // Step 1: POST image bytes to /read/analyze; receive 202 + operation-location.
    const analyzeUrl = `${base}/vision/${READ_API_VERSION}/read/analyze`;
    const initResp = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/octet-stream",
      },
      // Cast required: Node's Buffer is BufferSource-compatible but TS DOM
      // lib types friction. Runtime is fine.
      body: imageBuffer as unknown as BodyInit,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!initResp.ok) {
      console.warn(
        `[vision-ocr] analyze POST failed status=${initResp.status}`,
      );
      return null;
    }

    const operationLocation = initResp.headers.get("operation-location");
    if (!operationLocation) {
      console.warn("[vision-ocr] analyze response missing operation-location header");
      return null;
    }

    // Step 2: poll operation-location until status=succeeded.
    const pollDeadline = Date.now() + MAX_POLL_MS;
    let resultBody: unknown = null;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pollResp = await fetch(operationLocation, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!pollResp.ok) {
        console.warn(`[vision-ocr] poll failed status=${pollResp.status}`);
        return null;
      }
      const body = (await pollResp.json()) as {
        status?: string;
        analyzeResult?: unknown;
      };
      if (body.status === "succeeded") {
        resultBody = body;
        break;
      }
      if (body.status === "failed") {
        console.warn("[vision-ocr] read operation reported status=failed");
        return null;
      }
      // notStarted / running → continue polling
    }
    if (!resultBody) {
      console.warn(
        `[vision-ocr] poll exhausted ${MAX_POLL_MS}ms budget without success`,
      );
      return null;
    }

    // Step 3: extract lines + per-line confidence from analyzeResult.readResults.
    const lines = parseReadResults(resultBody);
    return {
      lines,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vision-ocr] extraction failed: ${msg}`);
    return null;
  }
}

/**
 * Parse the analyzeResult.readResults array into flat OcrLine[].
 *
 * Read API v3.2 response shape:
 *   { status: "succeeded",
 *     analyzeResult: {
 *       readResults: [
 *         { page, lines: [{ text, words: [{text, confidence}] }] },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Per-line confidence is the average of word confidences (Read API
 * doesn't surface a single line.confidence field in v3.2). Lines with
 * no usable confidence default to 0 — callers can choose whether to
 * trust them.
 */
function parseReadResults(body: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  if (!body || typeof body !== "object") return out;
  const ar = (body as { analyzeResult?: unknown }).analyzeResult;
  if (!ar || typeof ar !== "object") return out;
  const pages = (ar as { readResults?: unknown }).readResults;
  if (!Array.isArray(pages)) return out;

  for (const page of pages) {
    const lines = (page as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      const text = String((line as { text?: unknown }).text ?? "").trim();
      if (!text) continue;
      const words = (line as { words?: unknown }).words;
      let confidence = 0;
      if (Array.isArray(words) && words.length > 0) {
        const cs = words
          .map((w) => Number((w as { confidence?: unknown }).confidence))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
        if (cs.length > 0) {
          confidence = cs.reduce((a, b) => a + b, 0) / cs.length;
        }
      }
      out.push({ text, confidence });
    }
  }
  return out;
}
