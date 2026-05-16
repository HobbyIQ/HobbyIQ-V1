// Path Z agent-assisted curation harness for the parallels reference catalog
// (issue #33 Phase 2b-iv-a). See backend/docs/parallels-curation-workflow.md.
//
// Principle: agent fetches a PUBLIC hobby-community article (primarily
// cardboardconnection.com), extracts a structured proposal of parallels per
// the schema in backend/docs/parallels-reference-schema.md, surfaces the
// proposal to the owner, and ONLY writes to Cosmos after owner confirmation.
//
// This module is pure: no network fetches, no Cosmos writes inside
// `extractProposalFromArticle`. The CLI wrapper in
// backend/scripts/parallels-curate-from-article.ts owns the I/O.

import { Container } from "@azure/cosmos";
import {
  parallelAttributesId,
  upsertParallelAttributes,
  validateParallelAttributesRecord,
  type ParallelAttributesRecord,
  type SourceCitation,
} from "./ingestion.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface ParallelAttributesEntry {
  parallelName: string;
  color: string | null;
  printRun: number | null;
  isAutograph: boolean;
  parentVariant: string | null;
  /**
   * Owner-curated post-extraction. The extractor never populates this; it
   * proposes `null` and surfaces a warning so the owner sets it manually
   * before committing.
   */
  tierWithinSet: number | null;
  sourceCitation: SourceCitation;
  /** Raw text the extractor matched for this entry (for owner review). */
  matchedText: string;
}

export interface ParallelAttributesProposal {
  sourceUrl: string;
  sourceTitle: string;
  extractedAt: string;
  targetSet: string;
  entries: ParallelAttributesEntry[];
  warnings: string[];
}

export interface CommitEntryResult {
  parallelName: string;
  isAutograph: boolean;
  id: string;
  ok: boolean;
  error?: string;
}

export interface CommitResult {
  attempted: number;
  succeeded: number;
  failed: number;
  results: CommitEntryResult[];
}

// ─── Color / parallel vocabulary ────────────────────────────────────────────

/**
 * Color tokens that may appear in a parallel name. Order matters for matching:
 * multi-word tokens must precede single-word tokens so "Aqua Lava" wins over
 * "Aqua" alone.
 */
export const COLOR_TOKENS = [
  "Aqua Lava",
  "Atomic",
  "Aqua",
  "Black",
  "Blue Wave",
  "Blue",
  "Bronze",
  "Cyan",
  "Fuchsia",
  "Gold Wave",
  "Gold",
  "Green Wave",
  "Green",
  "Lava",
  "Magenta",
  "Mini Diamond",
  "Mojo",
  "Orange",
  "Pink",
  "Platinum",
  "Purple Wave",
  "Purple",
  "Raywave",
  "Red Wave",
  "Red",
  "Shimmer",
  "Silver Wave",
  "Silver",
  "Speckle",
  "SuperFractor",
  "Super-Fractor",
  "Tie-Dye",
  "Tie Dye",
  "White",
  "X-Fractor",
  "Yellow",
] as const;

/**
 * Tokens that signal the parallel is autograph-bearing. Case-insensitive
 * substring match against the matched text or surrounding context.
 */
const AUTO_TOKENS = ["autograph", "autographs", "auto", "signature", "signed"];

// ─── HTML normalization ─────────────────────────────────────────────────────

/**
 * Strip HTML tags, collapse whitespace, and normalize entities into something
 * the regex matchers can work with line-by-line. Intentionally simple — full
 * HTML parsing isn't necessary because Cardboard Connection lays out parallel
 * data in <li> / <p> elements that survive this transform.
 */
export function htmlToText(html: string): string {
  let txt = html;
  // Drop <script> and <style> blocks entirely.
  txt = txt.replace(/<script[\s\S]*?<\/script>/gi, " ");
  txt = txt.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Preserve list-item / paragraph / br boundaries as newlines.
  txt = txt.replace(/<\/(li|p|h[1-6]|div|br)>/gi, "\n");
  txt = txt.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags.
  txt = txt.replace(/<[^>]+>/g, " ");
  // Decode the most common entities.
  txt = txt
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
  // Collapse runs of whitespace but keep newlines.
  txt = txt.replace(/[ \t]+/g, " ");
  txt = txt.replace(/\s*\n\s*/g, "\n");
  return txt.trim();
}

/**
 * Best-effort title extraction. Prefers <title>, falls back to first <h1>.
 */
export function extractTitle(html: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) return htmlToText(titleMatch[1]).slice(0, 200);
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1Match) return htmlToText(h1Match[1]).slice(0, 200);
  return "";
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

/**
 * Match an explicit print-run pattern. Captures variant name (loose) and the
 * print-run integer. Accepts:
 *   "Refractor (#/499)"      → name="Refractor"      run=499
 *   "Refractor (/499)"       → name="Refractor"      run=499
 *   "Gold Refractor (/50)"   → name="Gold Refractor" run=50
 *   "SuperFractor (1/1)"     → name="SuperFractor"   run=1
 *   "Red Refractor – #/5"    → name="Red Refractor"  run=5
 */
const PRINT_RUN_RE =
  /([A-Z][A-Za-z0-9][A-Za-z0-9 \-'/]{0,60}?)\s*(?:\(|[–\-—,])\s*#?\s*(?:1\s*\/\s*)?\/?\s*(\d{1,5})\s*\)?/g;

const ONE_OF_ONE_RE =
  /([A-Z][A-Za-z0-9][A-Za-z0-9 \-'/]{0,60}?)\s*(?:\(|[–\-—,])?\s*1\s*\/\s*1\b/g;

/**
 * Recognises the trailing portion of a sentence so we know when to STOP a
 * parallel name. E.g., for "Refractors (/499) are limited to..." we cut at
 * "(".
 */
function trimName(raw: string): string {
  let s = raw.trim();
  // Strip leading bullet / dash punctuation.
  s = s.replace(/^[\s•·*\-–—]+/, "");
  // Drop trailing common joiners that wouldn't be part of a parallel name.
  s = s.replace(/\s+(and|with|plus|including|or)\s.*$/i, "");
  // Cap at first comma or semicolon — those typically separate entries.
  const stopIdx = s.search(/[,;]/);
  if (stopIdx > 0) s = s.slice(0, stopIdx);
  // Drop pluralization. "Refractors" → "Refractor", "Refractor Parallels" → "Refractor".
  s = s.replace(/\bRefractors\b/g, "Refractor");
  s = s.replace(/\bParallels?\b/gi, "").trim();
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Infer the color subtoken for a parallel name. Returns the FIRST color from
 * COLOR_TOKENS that appears as a whole word in the name (case-insensitive).
 * Returns null if no color is present.
 */
export function inferColor(parallelName: string): string | null {
  const haystack = parallelName.toLowerCase();
  for (const token of COLOR_TOKENS) {
    const re = new RegExp(`\\b${token.toLowerCase().replace(/[-]/g, "[- ]")}\\b`, "i");
    if (re.test(haystack)) return token;
  }
  return null;
}

/**
 * Detect autograph status from surrounding text. Heuristic: if the parallel
 * name or the line containing the match contains "auto" / "autograph" /
 * "signature" / "signed".
 */
export function inferAutograph(parallelName: string, context: string): boolean {
  const blob = `${parallelName} ${context}`.toLowerCase();
  return AUTO_TOKENS.some((t) => new RegExp(`\\b${t}\\b`, "i").test(blob));
}

// ─── Core extractor ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  sourceUrl: string;
  sourceTitle?: string;
  targetSet: string;
  /** Override extractedAt for deterministic tests. */
  now?: string;
}

/**
 * Pure extractor. Takes an HTML string (or already-cleaned text) and produces
 * a proposal. No network. No Cosmos. Suitable for unit testing.
 *
 * The extractor is conservative: it only emits entries where it found an
 * explicit print-run pattern (`/N` or `1/1`). Parallels mentioned without a
 * print-run are recorded as a warning, not as an entry.
 */
export function extractProposalFromHtml(
  html: string,
  opts: ExtractOptions
): ParallelAttributesProposal {
  const extractedAt = opts.now ?? new Date().toISOString();
  const text = htmlToText(html);
  const title = opts.sourceTitle ?? extractTitle(html);
  const warnings: string[] = [];
  const entries: ParallelAttributesEntry[] = [];

  // Dedupe by (parallelName, isAutograph). Last-write wins because later
  // mentions in an article tend to be more precise.
  const seen = new Map<string, ParallelAttributesEntry>();

  const recordEntry = (
    rawName: string,
    printRun: number | null,
    contextLine: string,
    matchedText: string
  ) => {
    const parallelName = trimName(rawName);
    if (!parallelName) return;
    if (parallelName.length < 2) return;
    if (parallelName.length > 80) return; // sanity cap
    // Reject if name is just a color modifier with no parallel root noun and
    // no explicit "Refractor" / "Wave" / etc. — too vague to be useful.
    if (!/[A-Za-z]/.test(parallelName)) return;

    const isAutograph = inferAutograph(parallelName, contextLine);
    const color = inferColor(parallelName);
    const citation: SourceCitation = {
      type: "web-research",
      url: opts.sourceUrl,
      siteName: deriveSiteName(opts.sourceUrl),
      date: extractedAt,
      note: "Extracted via curationHarness (Path Z agent-assisted).",
    };
    const entry: ParallelAttributesEntry = {
      parallelName,
      color,
      printRun,
      isAutograph,
      parentVariant: null, // owner fills in post-extraction
      tierWithinSet: null, // owner fills in post-extraction
      sourceCitation: citation,
      matchedText,
    };
    const dedupeKey = `${parallelName.toLowerCase()}|${isAutograph ? "auto" : "base"}`;
    seen.set(dedupeKey, entry);
  };

  // Walk the text line-by-line for better context attribution.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Pattern 1: explicit print-run /N.
    PRINT_RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRINT_RUN_RE.exec(line)) !== null) {
      const printRun = Number(m[2]);
      if (!Number.isFinite(printRun) || printRun <= 0 || printRun > 10_000) continue;
      recordEntry(m[1], printRun, line, m[0]);
    }
    // Pattern 2: explicit 1/1 (SuperFractor).
    ONE_OF_ONE_RE.lastIndex = 0;
    while ((m = ONE_OF_ONE_RE.exec(line)) !== null) {
      recordEntry(m[1], 1, line, m[0]);
    }
  }

  // Surface a warning if owner needs to back-fill tierWithinSet (always).
  if (seen.size > 0) {
    warnings.push(
      `Owner must set 'tierWithinSet' (positive integer per schema §2.1) on ALL ${seen.size} proposed entries before commit. The extractor leaves it null.`
    );
    warnings.push(
      `Owner must set 'parentVariant' (string or null) on each entry per the parallel family hierarchy. The extractor leaves it null.`
    );
  } else {
    warnings.push(
      `No print-run patterns matched in the article. Verify the article URL and selector, or fall back to manual curation.`
    );
  }

  // Surface parallels mentioned without an extractable print-run.
  // Heuristic: any color token + "Refractor" / "parallel" phrase that didn't
  // result in an entry.
  const refractorMentionRe = /\b([A-Z][A-Za-z\- ]{1,40}?)\s+Refractor(?!s?\s*\()/g;
  for (const line of lines) {
    refractorMentionRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = refractorMentionRe.exec(line)) !== null) {
      const candidate = trimName(m[1] + " Refractor");
      if (!candidate) continue;
      const k = `${candidate.toLowerCase()}|base`;
      if (!seen.has(k) && !seen.has(`${candidate.toLowerCase()}|auto`)) {
        warnings.push(
          `Parallel '${candidate}' mentioned in article without an explicit print-run pattern; not added. Owner may add manually.`
        );
      }
    }
  }

  return {
    sourceUrl: opts.sourceUrl,
    sourceTitle: title,
    extractedAt,
    targetSet: opts.targetSet,
    entries: [...seen.values()],
    warnings: dedupe(warnings),
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function deriveSiteName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("cardboardconnection")) return "Cardboard Connection";
    if (host.includes("checklistinsider")) return "Checklist Insider";
    return host;
  } catch {
    return "unknown";
  }
}

/**
 * Network-aware wrapper. Fetches the article HTML via Node fetch, then runs
 * the pure extractor. Intentionally kept thin so it's easy to mock.
 */
export async function extractProposalFromArticle(
  articleUrl: string,
  targetSet: string,
  fetchImpl: typeof fetch = fetch
): Promise<ParallelAttributesProposal> {
  if (!/^https?:\/\//i.test(articleUrl)) {
    throw new Error(`[curationHarness] articleUrl must be http(s): got '${articleUrl}'`);
  }
  const res = await fetchImpl(articleUrl, {
    headers: {
      // Identify ourselves so the host can rate-limit/block if needed.
      "User-Agent": "HobbyIQ-CurationHarness/1.0 (+https://github.com/HobbyIQ/HobbyIQ-V1; issue #33)",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`[curationHarness] article fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return extractProposalFromHtml(html, { sourceUrl: articleUrl, targetSet });
}

// ─── Commit path ────────────────────────────────────────────────────────────

export interface CommitOptions {
  /** Reviewer identifier persisted on each record. */
  reviewedBy: string;
  /** ISO timestamp persisted as lastReviewedAt. Defaults to now. */
  reviewedAt?: string;
  schemaVersion?: number;
}

/**
 * Validate a proposal end-to-end without writing anything. Returns the list
 * of validation errors (empty list means safe to commit).
 *
 * Designed to be called before `commitProposal` so the harness can show the
 * owner the full failure breakdown.
 */
export function validateProposal(
  proposal: ParallelAttributesProposal,
  opts: CommitOptions
): string[] {
  const errors: string[] = [];
  const reviewedAt = opts.reviewedAt ?? new Date().toISOString();
  const schemaVersion = opts.schemaVersion ?? 1;

  if (!proposal.targetSet || proposal.targetSet.trim() === "") {
    errors.push("proposal.targetSet must be a non-empty string.");
  }
  if (!opts.reviewedBy || opts.reviewedBy.trim() === "") {
    errors.push("commitOptions.reviewedBy must be a non-empty string.");
  }
  if (proposal.entries.length === 0) {
    errors.push("proposal.entries is empty; nothing to commit.");
  }

  const seenIds = new Set<string>();
  for (const [i, e] of proposal.entries.entries()) {
    const ctx = `entries[${i}] ('${e.parallelName}')`;
    if (!e.parallelName || e.parallelName.trim() === "") {
      errors.push(`${ctx}: parallelName must be non-empty.`);
      continue;
    }
    if (e.parallelName.includes("|")) {
      errors.push(`${ctx}: parallelName must not contain '|' (reserved for composite ID).`);
    }
    if (e.printRun !== null && !(Number.isInteger(e.printRun) && e.printRun > 0)) {
      errors.push(`${ctx}: printRun must be a positive integer or null (got ${e.printRun}).`);
    }
    if (typeof e.isAutograph !== "boolean") {
      errors.push(`${ctx}: isAutograph must be boolean.`);
    }
    if (e.tierWithinSet !== null && !(Number.isInteger(e.tierWithinSet) && e.tierWithinSet > 0)) {
      errors.push(`${ctx}: tierWithinSet must be a positive integer when set.`);
    }
    if (e.tierWithinSet === null) {
      errors.push(`${ctx}: tierWithinSet is null — owner must fill in before commit.`);
    }
    if (!e.sourceCitation || (e.sourceCitation as any).type !== "web-research") {
      errors.push(`${ctx}: sourceCitation.type must be 'web-research' for Path Z extractions.`);
    }
    // Build a candidate record and run the schema validator so we catch
    // anything the entry-level checks above missed.
    try {
      const id = parallelAttributesId(proposal.targetSet, e.parallelName, e.isAutograph);
      if (seenIds.has(id)) {
        errors.push(`${ctx}: duplicate composite id '${id}'.`);
      }
      seenIds.add(id);
      const rec: ParallelAttributesRecord = {
        id,
        set: proposal.targetSet,
        parallelName: e.parallelName,
        color: e.color,
        printRun: e.printRun,
        isAutograph: e.isAutograph,
        parentVariant: e.parentVariant,
        tierWithinSet: e.tierWithinSet ?? 1, // placeholder so validator can run
        sourceCitation: e.sourceCitation,
        lastReviewedAt: reviewedAt,
        reviewedBy: opts.reviewedBy,
        schemaVersion,
      };
      validateParallelAttributesRecord(rec);
    } catch (err: any) {
      errors.push(`${ctx}: schema validation failed → ${err?.message ?? err}`);
    }
  }
  return errors;
}

/**
 * Idempotent commit. Builds a ParallelAttributesRecord from each entry and
 * upserts via the shared ingestion helper. Composite id is derived from
 * (set, parallelName, isAutograph) so repeated runs do not produce
 * duplicates.
 */
export async function commitProposal(
  container: Container,
  proposal: ParallelAttributesProposal,
  opts: CommitOptions
): Promise<CommitResult> {
  // Belt-and-suspenders: re-validate at commit time. The caller should have
  // already run validateProposal and surfaced any errors.
  const validationErrors = validateProposal(proposal, opts);
  if (validationErrors.length > 0) {
    throw new Error(
      `[curationHarness] cannot commit proposal: ${validationErrors.length} validation error(s).\n${validationErrors.join("\n")}`
    );
  }

  const reviewedAt = opts.reviewedAt ?? new Date().toISOString();
  const schemaVersion = opts.schemaVersion ?? 1;
  const results: CommitEntryResult[] = [];

  for (const e of proposal.entries) {
    const id = parallelAttributesId(proposal.targetSet, e.parallelName, e.isAutograph);
    const rec: ParallelAttributesRecord = {
      id,
      set: proposal.targetSet,
      parallelName: e.parallelName,
      color: e.color,
      printRun: e.printRun,
      isAutograph: e.isAutograph,
      parentVariant: e.parentVariant,
      tierWithinSet: e.tierWithinSet as number, // validated non-null above
      sourceCitation: e.sourceCitation,
      lastReviewedAt: reviewedAt,
      reviewedBy: opts.reviewedBy,
      schemaVersion,
    };
    try {
      await upsertParallelAttributes(container, rec);
      results.push({ parallelName: rec.parallelName, isAutograph: rec.isAutograph, id, ok: true });
    } catch (err: any) {
      results.push({
        parallelName: rec.parallelName,
        isAutograph: rec.isAutograph,
        id,
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

// ─── Owner-facing rendering ─────────────────────────────────────────────────

/**
 * Render a proposal as a markdown table for owner review. Pure / no I/O so
 * tests can assert the output shape.
 */
export function renderProposalMarkdown(proposal: ParallelAttributesProposal): string {
  const lines: string[] = [];
  lines.push(`# Curation proposal — ${proposal.targetSet}`);
  lines.push("");
  lines.push(`- **Source URL**: ${proposal.sourceUrl}`);
  lines.push(`- **Source title**: ${proposal.sourceTitle || "(no title)"}`);
  lines.push(`- **Extracted at**: ${proposal.extractedAt}`);
  lines.push(`- **Entries**: ${proposal.entries.length}`);
  lines.push(`- **Warnings**: ${proposal.warnings.length}`);
  lines.push("");
  if (proposal.entries.length > 0) {
    lines.push(
      "| # | parallelName | color | printRun | isAutograph | parentVariant | tierWithinSet | matchedText |"
    );
    lines.push(
      "|---|---|---|---|---|---|---|---|"
    );
    for (const [i, e] of proposal.entries.entries()) {
      lines.push(
        `| ${i + 1} | ${e.parallelName} | ${e.color ?? "(none)"} | ${e.printRun ?? "null"} | ${e.isAutograph} | ${e.parentVariant ?? "(unset)"} | ${e.tierWithinSet ?? "**REQUIRED**"} | ${truncate(e.matchedText, 60)} |`
      );
    }
  }
  if (proposal.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const w of proposal.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
