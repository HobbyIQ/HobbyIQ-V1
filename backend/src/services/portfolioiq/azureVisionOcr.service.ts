// CF-AZURE-VISION-OCR (Drew, 2026-07-28).
//
// Thin wrapper around Azure AI Vision's Read (OCR) API. Given an
// image URL, returns the extracted text. Used by the image-verify
// job when Tier 1 pHash is inconclusive — Tier 2 OCR reads the slab
// label (grader, grade, cert #) or card tokens to break the tie.
//
// Endpoint + key live in App Service settings:
//   AZURE_VISION_ENDPOINT = https://ai-hobbyiq-vision.cognitiveservices.azure.com/
//   AZURE_VISION_KEY      = <rotated key1>
//
// The Read API is async (submit → poll for result), which the SDK
// abstracts away. This wrapper handles poll + timeout so callers
// get a Promise<string> back.

const READ_API_VERSION = "2024-02-01";
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

function endpoint(): string {
  const raw = process.env.AZURE_VISION_ENDPOINT ?? "";
  return raw.replace(/\/$/, "");
}
function apiKey(): string {
  return process.env.AZURE_VISION_KEY ?? "";
}

export interface OcrResult {
  ok: boolean;
  rawText: string;
  lines: string[];
  confidence: number;   // avg confidence across lines; 0 if none
  error?: string;
}

/**
 * Extract text from an image URL. Silent-safe: any failure returns
 * `{ok: false, error}` instead of throwing. Timeout at 15s.
 */
export async function ocrImageUrl(imageUrl: string, attempt = 0): Promise<OcrResult> {
  if (!imageUrl) return { ok: false, rawText: "", lines: [], confidence: 0, error: "missing URL" };
  const ep = endpoint();
  const key = apiKey();
  if (!ep || !key) return { ok: false, rawText: "", lines: [], confidence: 0, error: "vision creds not configured" };

  try {
    // 1. Submit
    const submitUrl = `${ep}/computervision/imageanalysis:analyze?api-version=${READ_API_VERSION}&features=read&language=en&gender-neutral-caption=false`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": key,
      },
      body: JSON.stringify({ url: imageUrl }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!submitRes.ok) {
      // CF-VISION-429-RETRY (Drew, 2026-08-18). image-verify used to call this
      // strictly one row at a time, so throttling was near-impossible and a
      // non-2xx could be reported and forgotten. It now runs a pool
      // (CF-IMAGE-VERIFY-CONCURRENCY), which makes 429 a REAL outcome rather
      // than a theoretical one.
      //
      // Without this, raising concurrency would have traded a slow-but-correct
      // job for a fast-but-lossy one: a throttled row returns ok:false, the
      // caller reads that as "vision could not verify", and the row is routed
      // to manual review as though the image genuinely did not match. Silent
      // loss dressed as a verdict — the same failure shape as a confidently
      // wrong slug.
      //
      // Honour Retry-After when the service sends it; otherwise back off
      // gently. Bounded at 2 retries because the batch has its own wall clock
      // and the cron reruns every 5 minutes — a row that cannot get through
      // now is better left for the next pass than spun on here.
      if (submitRes.status === 429 && attempt < 2) {
        const hdr = Number(submitRes.headers.get("retry-after"));
        const waitMs = Number.isFinite(hdr) && hdr > 0
          ? Math.min(hdr * 1000, 10_000)
          : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        return ocrImageUrl(imageUrl, attempt + 1);
      }
      const body = await submitRes.text().catch(() => "");
      return { ok: false, rawText: "", lines: [], confidence: 0, error: `submit HTTP ${submitRes.status}: ${body.slice(0, 200)}` };
    }
    // v4 (2024-02-01) returns the OCR result synchronously in the response body.
    const json: {
      readResult?: {
        blocks?: Array<{
          lines?: Array<{ text: string; confidence?: number }>;
        }>;
        content?: string;
      };
    } = await submitRes.json();
    const readResult = json.readResult;
    if (!readResult) {
      return { ok: false, rawText: "", lines: [], confidence: 0, error: "no readResult in response" };
    }
    const lines: string[] = [];
    let sumConfidence = 0;
    let lineCount = 0;
    for (const block of readResult.blocks ?? []) {
      for (const line of block.lines ?? []) {
        if (typeof line.text === "string" && line.text.trim() !== "") {
          lines.push(line.text);
          if (typeof line.confidence === "number" && Number.isFinite(line.confidence)) {
            sumConfidence += line.confidence;
            lineCount += 1;
          }
        }
      }
    }
    const rawText = readResult.content ?? lines.join("\n");
    return {
      ok: true,
      rawText,
      lines,
      confidence: lineCount > 0 ? sumConfidence / lineCount : 0,
    };
  } catch (err) {
    return { ok: false, rawText: "", lines: [], confidence: 0, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Convenience: given OCR text + expected identity tokens (player,
 * cardNumber, year, parallel), return which expected tokens appeared
 * in the OCR text and which didn't. Case-insensitive.
 */
export function checkTokensAgainstOcr(ocrText: string, expected: {
  playerName?: string | null;
  cardNumber?: string | null;
  cardYear?: number | null;
  parallel?: string | null;
}): { matchedTokens: string[]; missingTokens: string[] } {
  const t = String(ocrText ?? "").toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  const check = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const norm = String(value).toLowerCase();
    if (!norm) return;
    if (t.includes(norm)) matched.push(`${label}=${value}`);
    else missing.push(`${label}=${value}`);
  };
  check("player", expected.playerName ?? null);
  check("cardNumber", expected.cardNumber ?? null);
  check("year", expected.cardYear ? String(expected.cardYear) : null);
  check("parallel", expected.parallel ?? null);
  return { matchedTokens: matched, missingTokens: missing };
}
