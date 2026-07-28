// CF-PARSER-SUSPICION (Drew, 2026-07-28).
//
// Pure helper: given a parsed identity + the raw title, decide whether
// the parser probably missed a variant. Called at persist time; a true
// result routes the ingest to verify_queue with reason="parser-low-
// confidence" instead of poisoning the pool with a mislabeled Base row.
//
// Rule: fires when `parallel === "Base"` (parser hit the fallback) AND
// the title carries both a color word AND a parallel-adjacent word
// within the same string. Team-name false positives ("Blue Jays") are
// avoided by requiring the second word.

const COLOR_WORD_RE = /\b(blue|red|gold|green|orange|purple|yellow|aqua|black|pink)\b/i;
const CONTEXT_WORD_RE = /\b(refractor|shimmer|wave|prizm|auto|autograph|\/\d+|foil|lava|x-?fractor|holo)\b/i;

export function isParserProbablyWrong(input: {
  parsedParallel: string | null | undefined;
  title: string | null | undefined;
}): boolean {
  const parallel = String(input.parsedParallel ?? "").trim().toLowerCase();
  if (parallel !== "base") return false;
  const title = String(input.title ?? "").trim();
  if (!title) return false;
  return COLOR_WORD_RE.test(title) && CONTEXT_WORD_RE.test(title);
}
