/**
 * CF-A-SOFT-BLOCK-IS-NOT-A-DEAD-ID (2026-09-06, run 34044007926).
 *
 * The basketball 1990-2009 walk, ALONE on the lane, took three consecutive
 *
 *   UNREACHABLE — sportscardchecklist did not serve the set page
 *   (a 200 carrying no checklist) — exit 9: no checklist on the page
 *
 * and aborted. Every one of those pages is alive: 2000-01 Topps Chrome
 * (set-151053) re-fetched by hand minutes later served HTTP 200, 817,204 bytes
 * and 200 <h5> headers. The lane had fetched thousands of pages already today.
 *
 * That is a RATE LIMIT wearing the costume of a dead id, and the cost is not
 * the aborted run -- it is that `unreachable` is TERMINAL, so every entry the
 * block touched was closed against a page that was never broken. Measured
 * read-only in crawl_state today: 24 entries carry the "a 200 carrying no
 * checklist" reason (18 basketball, 6 baseball; 12 of them recorded today),
 * against 6 that are genuine dead ids.
 *
 * WHY THE OLD TEST COULD NOT SEE IT. `zeroCardReason` tested for challenge
 * markers with a bare substring sweep and, failing that, fell through to "the
 * host did not serve a set page". Two problems, in opposite directions:
 *
 *   - it never LOGGED what it actually received, so a human reading the run
 *     could not tell a challenge from a truncation from a dead id; and
 *   - a bare `cloudflare` test is USELESS on this host, because its ordinary
 *     healthy pages carry Cloudflare markers too (18 matches on the live,
 *     200-header 2000-01 Topps Chrome page). A naive test would have declared
 *     every good page a challenge.
 *
 * So the signal has to be the ABSENCE of a checklist COMBINED with a positive
 * block marker -- never a CDN name on its own.
 */

/**
 * Markers that mean THIS RESPONSE is an interrogation or a refusal, not a page.
 * Deliberately narrow: each is a phrase a challenge/limit page renders as its
 * OWN content, none is merely evidence that Cloudflare fronts the site.
 */
const CHALLENGE_MARKERS = [
  /cf-browser-verification/i,
  /cf_chl_(?:opt|jschl|managed)/i,
  /\bjust a moment\b/i,
  /attention required/i,
  /checking your browser before/i,
  /enable javascript and cookies to continue/i,
  /\bddos protection by\b/i,
  /error 10\d\d/i,                    // Cloudflare 1006/1010/1015 family
  /\bray id\b/i,
  /access denied/i,
  /\btoo many requests\b/i,
  /\brate limit(?:ed|ing)?\b/i,
  /you (?:have been|are) blocked/i,
];

/** The <title> of a response, trimmed. "" when it has none. */
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Is this body a challenge / rate-limit page?
 *
 * `hasChecklist` is the caller's own answer to "did I find card scaffolding":
 * a page WITH cards is never a block, however many CDN strings it carries. That
 * pairing is the whole point -- see the header note about the 18 Cloudflare
 * matches on a perfectly healthy page.
 */
function challengeSignal(html, hasChecklist) {
  const h = String(html || "");
  if (hasChecklist) return null;
  for (const re of CHALLENGE_MARKERS) {
    const m = re.exec(h);
    if (m) return { marker: m[0].slice(0, 60), title: titleOf(h), bytes: h.length };
  }
  return null;
}

/**
 * A one-line description of what the host actually sent, for the log.
 *
 * The run that lost three entries could not answer "what did we get?" from its
 * own output. This is that answer, and it is printed on EVERY zero-card
 * outcome, not only the ones we classify as a block.
 */
function describeResponse(html) {
  const h = String(html || "");
  const t = titleOf(h);
  return `bytes=${h.length} title=${t ? JSON.stringify(t.slice(0, 80)) : "(none)"}`;
}

module.exports = { CHALLENGE_MARKERS, titleOf, challengeSignal, describeResponse };
