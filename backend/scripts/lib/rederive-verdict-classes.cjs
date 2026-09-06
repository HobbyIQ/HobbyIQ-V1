#!/usr/bin/env node
/**
 * CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE (#1868).
 *
 * THE RUN THAT WROTE THIS FILE. Run 34021743427 — the first end-to-end night
 * of `acquire-for-withheld-holdings`, after #1867 unblocked the plan step —
 * went green on all ten cells. Cell `baseball|2025|bowman-draft` re-derived
 * holding a2963cd5 and repriced user-67878bb5. And every one of the ten cells
 * printed the same summary line:
 *
 *   CLASSIFY agree=0 rederive=0 no-match-blank=0 no-match-fields=0
 *            self-derived=0 collision=0 over-claim=0 human=0 low-conf=0
 *            unverified-total=0
 *
 * ALL ZEROS — including the cell whose report contained `"verdict": "REDERIVE"`
 * and whose Gate 3 proceeded ON that verdict and applied it. The night's one
 * real re-point was invisible in the very line written to describe it.
 *
 * WHY. The classifier grepped the report log with LINE-ANCHORED patterns:
 *
 *   AGREE=$(num "^[[:space:]]*AGREE ")
 *   REDERIVE=$(num "^[[:space:]]*REDERIVE ")
 *
 * The lane really does print `  REDERIVE   Conor Essenburg  2025 #CPA-CE`, so
 * those anchors are right about the SCRIPT's stdout. But the file they read is
 * not the script's stdout. `dispatch` captures the dispatched run with
 *
 *   gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY" --log > /tmp/run-$RUN_ID.log
 *
 * and `--log` prefixes EVERY line with `<job>\t<step>\t<timestamp>`:
 *
 *   run-backfill	Run backfill (DRY-RUN)	2026-09-06T08:51:11.3907930Z   REDERIVE   Conor Essenburg …
 *
 * so `^[[:space:]]*REDERIVE ` cannot match, and `grep -c` honestly returns 0.
 * Verified against the real log of run 34022954856: the anchored pattern finds
 * 0, the report contains 1.
 *
 * WHY GATE 3 SURVIVED AND THE CLASSIFIER DID NOT. Gate 3 tests
 *
 *   '^[[:space:]]*REDERIVE |"REDERIVE":[[:space:]]*[1-9]'
 *
 * — two alternatives, and the SECOND is unanchored, so it matched the lane's
 * machine-readable `SUMMARY  {"REDERIVE":1}` through the prefix. The gate read
 * the report; the classifier read the line shape. One of them was portable
 * across a capture format and the other was not, and nothing said so.
 *
 * THE RULE. The CLASSIFY line is DERIVED FROM THE SAME JSON THE GATES READ.
 * The lane emits, after its human lines:
 *
 *   SUMMARY  {"REDERIVE":1}
 *   { "event": "holding_rederive_report", "mode": …, "verdicts": [ … ] }
 *
 * `verdicts[]` is the authority: one entry per holding, each with a `verdict`
 * (the CLASS) and a `reason` (the SUBCLASS the operator's table splits on).
 * This module reconstructs that document out of a captured log — stripping the
 * `gh --log` prefix and any ANSI — and counts it. A future capture format that
 * adds a different prefix changes one function here, not nine grep anchors in
 * YAML, and the pin catches it either way.
 *
 * WHY A MODULE AND NOT MORE SHELL. The defect is a parsing defect, and shell
 * greps in a workflow are unpinnable: nothing in CI ever ran that classifier
 * against a real report. This is a pure function over text with a fixture pin,
 * so the mutation "parse the wrong stream" is a red build rather than another
 * silent zero.
 */
"use strict";

/** `gh run view --log` writes `<job>\t<step>\t<ISO timestamp> <content>`, and
 *  the runner's own steps add ANSI. Strip both so the payload is the script's
 *  actual stdout line. A line with no prefix is returned unchanged, which is
 *  what makes this safe against a RAW capture too (`| tee`, a fixture, a local
 *  run) — the classifier does not need to know which shape it was handed. */
function stripCapturePrefix(line) {
  const noAnsi = String(line).replace(/\x1b\[[0-9;]*m/g, "");
  // Tab-delimited gh form: job \t step \t timestamp-and-content.
  const parts = noAnsi.split("\t");
  const tail = parts.length >= 3 ? parts.slice(2).join("\t") : noAnsi;
  // The timestamp leads the content when the prefix was present; a bare
  // timestamp-led line (some captures drop the tabs) is handled the same way.
  return tail.replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
}

/** The verdict classes the lane emits (recheck-holding-identity.ts). Listed
 *  explicitly so a NEW class is a visible addition here rather than silently
 *  bucketed into an existing count. */
const VERDICT_CLASSES = ["REDERIVE", "AGREE", "AGREE-UNBACKED", "NO-MATCH", "UNVERIFIED", "RULE", "REFUSED"];

/**
 * Pull the `holding_rederive_report` document out of a captured log.
 *
 * The document is pretty-printed across many lines, so it cannot be matched
 * with a single-line regex. Each line is de-prefixed, then the region from the
 * line that opens the report to its balanced close is re-parsed as JSON.
 *
 * @returns {{verdicts: Array<object>}|null} null when no report is present —
 *   which is NOT the same as an empty report and must never be shown as zeros.
 */
function extractReport(text) {
  const lines = String(text).split(/\r?\n/).map(stripCapturePrefix);

  // The report is the object whose `"event"` is holding_rederive_report. Find
  // the `{` that opens it: the emitter prints a bare `{` and then the event on
  // the next line, so anchor on the event and walk back to the nearest `{`.
  let eventAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/"event"\s*:\s*"holding_rederive_report"/.test(lines[i])) { eventAt = i; break; }
  }
  if (eventAt === -1) return null;

  let start = eventAt;
  while (start >= 0 && !/^\s*\{\s*$/.test(lines[start])) start--;
  if (start < 0) return null;

  // Balanced-brace scan, string-aware so a brace inside a reason or a slug
  // cannot end the document early.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < lines.length && end === -1; i++) {
    for (const ch of lines[i]) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end === -1) return null;

  try {
    const doc = JSON.parse(lines.slice(start, end + 1).join("\n"));
    return doc && Array.isArray(doc.verdicts) ? doc : null;
  } catch { return null; }
}

/** The `SUMMARY  {"REDERIVE":1}` line — the same shape Gate 3's second
 *  alternative matches. A cross-check on the report, and the fallback when a
 *  truncated capture lost the big document but kept the summary. */
function extractSummaryCounts(text) {
  const lines = String(text).split(/\r?\n/).map(stripCapturePrefix);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*SUMMARY\s+(\{.*\})\s*$/.exec(lines[i]);
    if (!m) continue;
    try {
      const o = JSON.parse(m[1]);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch { /* a malformed summary is no summary */ }
  }
  return null;
}

/**
 * The SUBCLASS an UNVERIFIED verdict falls into. These are the buckets the
 * operator's table splits on, and each maps to a different unblocking action,
 * so collapsing them would be a real loss of meaning. Matched on the verdict's
 * OWN `reason` field rather than on console text.
 */
function unverifiedSubclass(reason) {
  const r = String(reason || "");
  // Anchored on the REASON strings recheck-holding-identity.ts actually pushes
  // — NOT on its console text, which words the same case differently (the
  // console says "player mismatch", the reason says "does not corroborate it").
  // Reading the report means reading the report's own field:
  //
  //   "no catalog row backs the derived slug — never mint"
  //   "set name was recovered from listing text and the destination does not
  //    corroborate it: holding player X vs catalog row Y"
  //   "no ladder source — the holding claims a=b and the destination does not
  //    carry it"
  //   "a human ruled this identity (who) — report only; field recovery ..."
  //   "confidence 0.71 below 0.8"
  //
  // ORDER MATTERS: the corroborate and carry reasons both contain "destination
  // does not", so the player case is tested first.
  if (/no catalog row backs/i.test(r)) return "selfDerived";
  if (/does not corroborate it|player mismatch|holding player .* vs catalog row/i.test(r)) return "collision";
  if (/destination does not carry it|no ladder source/i.test(r)) return "overClaim";
  if (/a human ruled this identity|never overwritten/i.test(r)) return "human";
  if (/confidence\s+[\d.]+\s+below|\bconf(idence)?\b[^.]*\b(below|<)\b/i.test(r)) return "lowConf";
  return "other";
}

/** True when a NO-MATCH is a blank-fields holding rather than a matcher miss.
 *  The two need OPPOSITE work — field recovery (#1811) vs matcher work — so the
 *  split is kept even though both carry verdict NO-MATCH.
 *
 *  The shipped workflow split them by grepping the console line for
 *  `from=(null|""|none|-)$`; the report carries that same value as the
 *  verdict's own `from` field, so the rule is preserved exactly and read from
 *  the document instead of from a rendered line. `stillMissing` in the reason
 *  ("missing setName and no evidence on the holding names it") is the matcher's
 *  own statement that the fields were not there. */
function noMatchIsBlank(v) {
  const r = String(v && v.reason || "");
  if (/\bmissing\b.*no evidence|blank|no usable fields|nothing to match on/i.test(r)) return true;
  const from = v && v.from;
  return from === null || from === undefined || from === "" || from === "-" || from === "none";
}

/**
 * Count a captured rederive report into the classes the summary line names.
 *
 * @returns {{ok: boolean, why?: string, counts: object, total: number}}
 *   `ok:false` means the report could not be READ — reported as such, never as
 *   a row of zeros (feedback_never_dismiss_small_numbers_as_noise: an unread
 *   count is not a zero, and this whole file exists because zeros lied once).
 */
function classify(text) {
  const zero = {
    agree: 0, rederive: 0, noMatchBlank: 0, noMatchFields: 0,
    selfDerived: 0, collision: 0, overClaim: 0, human: 0, lowConf: 0,
    unverifiedTotal: 0,
  };

  const doc = extractReport(text);
  if (!doc) {
    // The summary alone still answers the two classes the gates care about,
    // so a truncated capture degrades to partial truth rather than to zeros.
    const s = extractSummaryCounts(text);
    if (!s) return { ok: false, why: "no holding_rederive_report and no SUMMARY line in the capture", counts: zero, total: 0 };
    const counts = { ...zero };
    counts.rederive = Number(s.REDERIVE || 0);
    counts.agree = Number(s.AGREE || 0) + Number(s["AGREE-UNBACKED"] || 0);
    counts.unverifiedTotal = Number(s.UNVERIFIED || 0);
    const total = Object.values(s).reduce((a, n) => a + Number(n || 0), 0);
    return { ok: true, partial: true, why: "SUMMARY only — the verdict detail was not in the capture", counts, total };
  }

  const counts = { ...zero };
  for (const v of doc.verdicts) {
    switch (String(v && v.verdict)) {
      case "REDERIVE": counts.rederive++; break;
      case "AGREE": case "AGREE-UNBACKED": counts.agree++; break;
      case "NO-MATCH":
        if (noMatchIsBlank(v)) counts.noMatchBlank++; else counts.noMatchFields++;
        break;
      case "UNVERIFIED": {
        counts.unverifiedTotal++;
        const sub = unverifiedSubclass(v.reason);
        if (sub !== "other") counts[sub]++;
        break;
      }
      default: break; // RULE / REFUSED are other modes' vocabulary
    }
  }
  return { ok: true, counts, total: doc.verdicts.length };
}

/** The one-line summary the workflow echoes and comments. Key names are the
 *  wire format the comment step already publishes and must not drift. */
function summaryLine(counts) {
  return `agree=${counts.agree} rederive=${counts.rederive}`
    + ` no-match-blank=${counts.noMatchBlank} no-match-fields=${counts.noMatchFields}`
    + ` self-derived=${counts.selfDerived} collision=${counts.collision}`
    + ` over-claim=${counts.overClaim} human=${counts.human}`
    + ` low-conf=${counts.lowConf} unverified-total=${counts.unverifiedTotal}`;
}

module.exports = {
  stripCapturePrefix, extractReport, extractSummaryCounts,
  unverifiedSubclass, noMatchIsBlank, classify, summaryLine, VERDICT_CLASSES,
};

// ── CLI ────────────────────────────────────────────────────────────────────
// `node lib/rederive-verdict-classes.cjs <log>` prints the summary line on
// stdout and a human note on stderr, so the workflow substitutes it directly.
// CF-A-DATA-CHANNEL-IS-NOT-A-LOG (#1867): stdout is the value, nothing else.
if (require.main === module) {
  const fs = require("node:fs");
  const file = process.argv[2];
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    process.stderr.write(`classify: cannot read ${file}: ${e && e.message}\n`);
    process.stdout.write("unreadable\n");
    process.exit(0);
  }
  const r = classify(text);
  if (!r.ok) {
    // NOT zeros. The line says it could not read, because a row of zeros is
    // exactly what made run 34021743427's real re-point invisible.
    process.stderr.write(`classify: ${r.why}\n`);
    process.stdout.write("unread\n");
    process.exit(0);
  }
  if (r.partial) process.stderr.write(`classify: ${r.why}\n`);
  process.stdout.write(`${summaryLine(r.counts)}\n`);
}
