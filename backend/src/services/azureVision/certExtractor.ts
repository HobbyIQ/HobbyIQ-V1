// CF-GRADED-SCAN-B1 (2026-06-02) — extract cert number candidates from OCR.
//
// Searches OCR-extracted lines for 6-12 digit runs (the PSA cert number
// pattern, also the generic format the certGraders registry's
// recognizing graders accept). Returns the highest-confidence candidate.
//
// Future graders (BGS / SGC / CGC) can have different formats; the
// graderId on the response is currently hardcoded "psa" because PSA is
// the only registered grader at launch. When v1.5 graders ship, this
// module extends to detect grader-specific patterns + emit the right
// graderId — same surface, no caller-side change.

import type { OcrLine } from "./visionOcr.client.js";

// PSA cert numbers are all-digit. Historical 7-9 chars; we accept 6-12
// to match the certGraders registry's PSA grader recognizer pattern.
// Anchored at digit-boundary so the regex doesn't grab mid-word digits
// inside a longer alphanumeric sequence.
const CERT_NUMBER_RE = /(?:^|\D)(\d{6,12})(?:\D|$)/g;

// Tokens that increase confidence when found on the same line as a
// digit run. PSA slabs typically have "PSA" + "CERT #" near the
// number; BGS slabs have "BGS"; etc. Case-insensitive match.
const CONTEXT_TOKENS = [
  "psa",
  "bgs",
  "sgc",
  "cgc",
  "cert",
  "cert#",
  "certification",
  "certified",
];

export interface CertCandidate {
  graderId: "psa" | "bgs" | "sgc" | "cgc";
  certNumber: string;
  /** 0..1 — combines OCR per-line confidence with context-boost. */
  ocrConfidence: number;
}

/**
 * Scan OCR lines for the highest-confidence cert-number candidate.
 *
 * Returns null when no digit run in [6, 12] range is found across any
 * line, OR when the only candidates fall below a base confidence floor
 * (an OCR garbage line with all-low-confidence words is more likely a
 * misread of decorative text than a real cert).
 */
export function extractCertCandidate(lines: ReadonlyArray<OcrLine>): CertCandidate | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  let best: CertCandidate | null = null;
  for (const line of lines) {
    if (typeof line.text !== "string" || line.text.length === 0) continue;
    const baseConfidence = Number.isFinite(line.confidence)
      ? Math.max(0, Math.min(1, line.confidence))
      : 0;

    // Skip very-low-confidence lines entirely — they're almost always
    // OCR garbage; matching a digit run inside them is more noise than
    // signal.
    if (baseConfidence < 0.3) continue;

    // Context boost: lines with grader/cert tokens get a multiplier
    // applied to their confidence. Bounded so a high-OCR-confidence
    // line without context still beats a low-OCR-confidence line with
    // context (e.g. a sticker that says "CERT" stamped on garbage).
    const lowered = line.text.toLowerCase();
    const hasContext = CONTEXT_TOKENS.some((t) => lowered.includes(t));
    const contextBoost = hasContext ? 0.2 : 0;
    const effectiveConfidence = Math.min(1, baseConfidence + contextBoost);

    // Find all 6-12 digit runs on this line.
    CERT_NUMBER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CERT_NUMBER_RE.exec(line.text)) !== null) {
      const certNumber = match[1];
      if (!best || effectiveConfidence > best.ocrConfidence) {
        best = {
          graderId: "psa", // PSA-only at v1; v1.5 grader CFs extend this
          certNumber,
          ocrConfidence: effectiveConfidence,
        };
      }
    }
  }

  return best;
}
