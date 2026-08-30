import { judgeCardNumber, logCardNumberVerdict } from "../portfolioiq/cardNumberIntegrity.js";

export interface OcrExtractInput {
  frontText?: string;
  backText?: string;
}

export interface OcrCardCandidate {
  playerName?: string;
  cardYear?: number;
  product?: string;
  cardNumber?: string;
  parallel?: string;
  isAuto?: boolean;
  isPatch?: boolean;
  grade?: string;
  gradingCompany?: string;
  certNumber?: string;
  confidence: number;
  rawText: string;
}

const PRODUCT_HINTS = [
  "bowman chrome draft",
  "bowman chrome",
  "bowman draft",
  "bowman",
  "topps chrome",
  "topps update",
  "topps heritage",
  "topps",
  "prizm",
  "select",
  "optic",
  "mosaic",
  "national treasures",
  "immaculate",
  "finest",
  "stadium club",
  "contenders",
];

const PARALLEL_HINTS = [
  "superfractor",
  "gold refractor",
  "orange refractor",
  "red refractor",
  "blue refractor",
  "green refractor",
  "refractor",
  "silver",
  "gold",
  "blue",
  "red",
  "green",
  "purple",
  "orange",
  "black",
];

function normalize(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .replace(/[|]/g, "I")
    .trim();
}

function pickFirstMatch(lower: string, hints: string[]): string | undefined {
  for (const hint of hints) {
    if (lower.includes(hint)) return hint;
  }
  return undefined;
}

function parseYear(lower: string): number | undefined {
  const m = lower.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseCardNumber(text: string): string | undefined {
  const m = text.match(/(?:card\s*(?:no\.?|#)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i)
    ?? text.match(/#\s*([A-Z0-9\-]{1,12})\b/i);
  return m?.[1];
}

function parseGrade(text: string): { company?: string; grade?: string; cert?: string } {
  const m = text.match(/\b(PSA|BGS|SGC|CGC)\b\s*([0-9]{1,2}(?:\.[0-9])?)/i);
  const cert = text.match(/(?:cert(?:ification)?\s*(?:no\.?|#)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i)?.[1];
  return {
    company: m?.[1]?.toUpperCase(),
    grade: m?.[2],
    cert,
  };
}

function parsePlayerName(text: string): string | undefined {
  const line = text.split(/\n|\|/).map(x => x.trim()).find(Boolean);
  if (!line) return undefined;
  const cleaned = line.replace(/\b(rookie|rc|auto|patch|refractor|prizm|chrome)\b/gi, "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 4) return words.join(" ");
  return undefined;
}

export function extractCardCandidate(input: OcrExtractInput): OcrCardCandidate {
  const raw = [input.frontText ?? "", input.backText ?? ""].join("\n").trim();
  const normalized = normalize(raw);
  const lower = normalized.toLowerCase();

  const product = pickFirstMatch(lower, PRODUCT_HINTS);
  const parallel = pickFirstMatch(lower, PARALLEL_HINTS);
  const year = parseYear(lower);
  // D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). A slab's OCR text is the one place
  // the grader's digit is guaranteed to be present -- "PSA 9" is printed on
  // the label this text came from -- and `#\s*([A-Z0-9-]{1,12})` reads it
  // happily. Same ruling as every other emitter: the explicit `#X` wins, and a
  // number the text shows to be a grade / print run / year / ordinal / lot is
  // refused rather than becoming the card.
  const ocrCardNumberCandidate = parseCardNumber(normalized);
  const cardNumberVerdict = judgeCardNumber(ocrCardNumberCandidate ?? null, normalized);
  logCardNumberVerdict("slab-ocr", cardNumberVerdict, { candidate: ocrCardNumberCandidate ?? null, title: normalized });
  const cardNumber = cardNumberVerdict.cardNumber ?? undefined;
  const grade = parseGrade(normalized);
  const playerName = parsePlayerName(normalized);
  const isAuto = /\b(auto|autograph)\b/i.test(normalized);
  const isPatch = /\bpatch\b/i.test(normalized);

  let confidence = 0.2;
  if (playerName) confidence += 0.18;
  if (year) confidence += 0.12;
  if (product) confidence += 0.18;
  if (cardNumber) confidence += 0.12;
  if (parallel) confidence += 0.1;
  if (grade.company && grade.grade) confidence += 0.15;
  if (isAuto || isPatch) confidence += 0.05;

  return {
    playerName,
    cardYear: year,
    product,
    cardNumber,
    parallel,
    isAuto,
    isPatch,
    grade: grade.grade,
    gradingCompany: grade.company,
    certNumber: grade.cert,
    confidence: Math.min(0.99, Number(confidence.toFixed(2))),
    rawText: normalized,
  };
}
