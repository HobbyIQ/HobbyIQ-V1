const PRODUCT_HINTS = [
  'bowman chrome draft', 'bowman chrome', 'bowman draft', 'bowman',
  'topps chrome', 'topps update', 'topps heritage', 'topps',
  'prizm', 'select', 'optic', 'mosaic', 'national treasures',
  'immaculate', 'finest', 'stadium club', 'contenders',
];

const PARALLEL_HINTS = [
  'superfractor', 'gold refractor', 'orange refractor', 'red refractor',
  'blue refractor', 'green refractor', 'refractor', 'silver', 'gold',
  'blue', 'red', 'green', 'purple', 'orange', 'black',
];

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, 'I')
    .trim();
}

function pickFirstMatch(lower, hints) {
  for (const hint of hints) {
    if (lower.includes(hint)) return hint;
  }
  return undefined;
}

function extractOcrCandidate(frontText, backText) {
  const rawText = normalize(`${frontText || ''}\n${backText || ''}`);
  const lower = rawText.toLowerCase();

  const year = lower.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const cardNumber = rawText.match(/(?:card\s*(?:no\.?|#)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i)?.[1]
    || rawText.match(/#\s*([A-Z0-9\-]{1,12})\b/i)?.[1];
  const grade = rawText.match(/\b(PSA|BGS|SGC|CGC)\b\s*([0-9]{1,2}(?:\.[0-9])?)/i);
  const certNumber = rawText.match(/(?:cert(?:ification)?\s*(?:no\.?|#)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i)?.[1];

  const firstLine = rawText.split(/\n|\|/).map(x => x.trim()).find(Boolean);
  const cleanedLine = firstLine
    ? firstLine.replace(/\b(rookie|rc|auto|patch|refractor|prizm|chrome)\b/gi, '').trim()
    : '';
  const playerWords = cleanedLine.split(/\s+/).filter(Boolean);
  const playerName = (playerWords.length >= 2 && playerWords.length <= 4) ? playerWords.join(' ') : undefined;

  let confidence = 0.2;
  if (playerName) confidence += 0.18;
  if (year) confidence += 0.12;
  if (pickFirstMatch(lower, PRODUCT_HINTS)) confidence += 0.18;
  if (cardNumber) confidence += 0.12;
  if (pickFirstMatch(lower, PARALLEL_HINTS)) confidence += 0.1;
  if (grade?.[1] && grade?.[2]) confidence += 0.15;
  if (/\b(auto|autograph|patch)\b/i.test(rawText)) confidence += 0.05;

  return {
    playerName,
    cardYear: year ? parseInt(year, 10) : undefined,
    product: pickFirstMatch(lower, PRODUCT_HINTS),
    cardNumber,
    parallel: pickFirstMatch(lower, PARALLEL_HINTS),
    isAuto: /\b(auto|autograph)\b/i.test(rawText),
    isPatch: /\bpatch\b/i.test(rawText),
    grade: grade?.[2],
    gradingCompany: grade?.[1]?.toUpperCase(),
    certNumber,
    confidence: Math.min(0.99, Number(confidence.toFixed(2))),
    rawText,
  };
}

module.exports = { extractOcrCandidate };
