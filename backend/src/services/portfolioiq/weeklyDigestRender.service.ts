// CF-WEEKLY-DIGEST (Drew, 2026-09-02). Renders a WeeklyDigest into the
// text + HTML a person actually reads.
//
// Copy rules, and they are rules:
//   • Plain collector language. "Selling about 6 a week against a normal
//     2" — not "velocity multiple 3.0x". The number and the English both
//     appear; the English is what makes the number mean something.
//   • Every number carries its basis. Each row prints its `basisNote`;
//     there is no path here that renders a bare figure.
//   • Speculative values are LABELED, inline, next to the number — never
//     in a legend at the bottom that the reader has already scrolled past.
//   • A section that isn't in `digest.sections` renders NOTHING. Not a
//     header, not "none this week". The renderer walks `sections`, so a
//     missing section cannot leave a stub behind.
//
// Both renderers walk the same section list in the same order, so the
// text and HTML bodies can never disagree about what the digest contains.

import type {
  DigestAuditItem,
  DigestMarketRow,
  DigestMover,
  DigestSignal,
  WeeklyDigest,
} from "./weeklyDigestBuild.service.js";

function money(n: number | null): string {
  if (n === null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`;
}

/** The inline speculative label. Sits next to the value, always. */
function valueLabel(m: { valueBasis: string }): string {
  if (m.valueBasis === "estimated") return " (estimated)";
  if (m.valueBasis === "under-review") return " (under review)";
  return "";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function weekLabel(digest: WeeklyDigest): string {
  const start = new Date(`${digest.weekStart}T00:00:00Z`);
  const end = new Date(`${digest.weekEnd}T00:00:00Z`);
  const fmt = (d: Date) =>
    Number.isFinite(d.getTime())
      ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
      : "";
  const a = fmt(start);
  const b = fmt(end);
  return a && b ? `${a} – ${b}` : digest.weekId;
}

// ── Plain text ──────────────────────────────────────────────────────

function moverLine(m: DigestMover): string {
  return (
    `  ${pct(m.movePct)}  ${m.playerName} — ${m.cardTitle}\n` +
    `     Now ${money(m.value)}${valueLabel(m)}. ${m.basisNote}`
  );
}

/** CF-A-MOVER-NEEDS-CORROBORATION. A re-estimate is NOT rendered with a
 *  signed move percentage: a "+9433.9%" under any heading reads as market
 *  news. The two values are shown, and the basis note says what happened. */
function reestimatedLine(m: DigestMover): string {
  return (
    `  ${m.playerName} — ${m.cardTitle}
` +
    `     ${money(m.fromValue)} → ${money(m.value)}${valueLabel(m)}. ${m.basisNote}`
  );
}

function signalLine(s: DigestSignal): string {
  return `  ${s.playerName} — ${s.cardTitle}\n     ${s.basisNote}`;
}

function auditLine(a: DigestAuditItem): string {
  return `  ${a.playerName} — ${a.cardTitle}\n     ${a.basisNote}`;
}

function marketLine(r: DigestMarketRow): string {
  return `  ${r.basisNote}`;
}

export function renderWeeklyDigestText(digest: WeeklyDigest): string {
  const out: string[] = [];
  out.push(`Your week in cards — ${weekLabel(digest)}`);
  out.push("");
  out.push(digest.headline);
  out.push("");
  out.push(
    `You hold ${digest.summary.holdings} card${digest.summary.holdings === 1 ? "" : "s"}` +
      (digest.summary.portfolioValue !== null
        ? `, worth about ${money(digest.summary.portfolioValue)} all in.`
        : `.`),
  );
  out.push(digest.summary.portfolioValueBasis);

  for (const section of digest.sections) {
    if (section === "movers" && digest.movers) {
      if (digest.movers.gainers.length > 0) {
        out.push("", "WHAT WENT UP", ...digest.movers.gainers.map(moverLine));
      }
      if (digest.movers.decliners.length > 0) {
        out.push("", "WHAT CAME DOWN", ...digest.movers.decliners.map(moverLine));
      }
    }
    if (section === "reestimated" && digest.reestimated) {
      out.push(
        "",
        `RE-ESTIMATED THIS WEEK — NOT A MARKET MOVE (${digest.reestimated.total})`,
        "  These values changed because of how we priced the card, not because it sold.",
        ...digest.reestimated.items.map(reestimatedLine),
      );
      if (digest.reestimated.total > digest.reestimated.items.length) {
        out.push(`  …and ${digest.reestimated.total - digest.reestimated.items.length} more.`);
      }
    }
    if (section === "signals" && digest.signals) {
      if (digest.signals.sell.length > 0) {
        out.push("", "GOOD WEEK TO SELL", ...digest.signals.sell.map(signalLine));
      }
      if (digest.signals.watch.length > 0) {
        out.push("", "WORTH WATCHING", ...digest.signals.watch.map(signalLine));
      }
    }
    if (section === "audit" && digest.audit) {
      out.push(
        "",
        `UNDER REVIEW (${digest.audit.total})`,
        ...digest.audit.items.map(auditLine),
      );
      if (digest.audit.total > digest.audit.items.length) {
        out.push(`  ... and ${digest.audit.total - digest.audit.items.length} more.`);
      }
    }
    if (section === "market" && digest.market) {
      out.push("", "THE WIDER MARKET", ...digest.market.rows.map(marketLine));
    }
  }

  if (digest.footnotes.length > 0) {
    out.push("", "WHAT THESE NUMBERS MEAN", ...digest.footnotes.map((f) => `  ${f}`));
  }
  out.push("", "— HobbyIQ");
  return out.join("\n");
}

// ── HTML ────────────────────────────────────────────────────────────

const WRAP_OPEN =
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
  `font-size:15px;line-height:1.55;color:#1a1a1a;max-width:640px;margin:0 auto;padding:8px">`;
const SECTION_H =
  `font:600 12px/1.2 inherit;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;` +
  `margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e5e7eb`;
const NOTE = `margin:2px 0 0;font-size:13px;color:#4b5563`;

function rowHtml(title: string, lead: string, note: string, accent: string): string {
  return (
    `<div style="margin:0 0 14px;padding-left:12px;border-left:3px solid ${accent}">` +
    `<div style="font-weight:600">${esc(title)}</div>` +
    `<div style="font-size:14px;margin-top:1px">${esc(lead)}</div>` +
    `<p style="${NOTE}">${esc(note)}</p>` +
    `</div>`
  );
}

function moverHtml(m: DigestMover): string {
  const accent = m.movePct >= 0 ? "#15803d" : "#b91c1c";
  return rowHtml(
    `${m.playerName} — ${m.cardTitle}`,
    `${pct(m.movePct)} this week · now ${money(m.value)}${valueLabel(m)}`,
    m.basisNote,
    accent,
  );
}

/** CF-A-MOVER-NEEDS-CORROBORATION. No signed percentage, and a neutral
 *  accent — nothing on this row may read as a market move. */
function reestimatedHtml(m: DigestMover): string {
  return rowHtml(
    `${m.playerName} — ${m.cardTitle}`,
    `${money(m.fromValue)} → ${money(m.value)}${valueLabel(m)}`,
    m.basisNote,
    "#6b7280",
  );
}

function signalHtml(s: DigestSignal): string {
  return rowHtml(
    `${s.playerName} — ${s.cardTitle}`,
    s.value !== null ? `Currently ${money(s.value)}` : "No value on file",
    s.basisNote,
    s.kind === "sell" ? "#b45309" : "#6b7280",
  );
}

function auditHtml(a: DigestAuditItem): string {
  return rowHtml(
    `${a.playerName} — ${a.cardTitle}`,
    `${money(a.value)} (under review)`,
    a.basisNote,
    "#7c3aed",
  );
}

export function renderWeeklyDigestHtml(digest: WeeklyDigest): string {
  const parts: string[] = [WRAP_OPEN];
  parts.push(
    `<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:0">` +
      `Your week in cards · ${esc(weekLabel(digest))}</p>`,
  );
  parts.push(`<h1 style="font-size:20px;line-height:1.35;margin:6px 0 14px">${esc(digest.headline)}</h1>`);
  parts.push(
    `<p style="margin:0">You hold <strong>${digest.summary.holdings}</strong> card${digest.summary.holdings === 1 ? "" : "s"}` +
      (digest.summary.portfolioValue !== null
        ? `, worth about <strong>${money(digest.summary.portfolioValue)}</strong> all in.`
        : `.`) +
      `</p>`,
  );
  parts.push(`<p style="${NOTE}">${esc(digest.summary.portfolioValueBasis)}</p>`);

  for (const section of digest.sections) {
    if (section === "movers" && digest.movers) {
      if (digest.movers.gainers.length > 0) {
        parts.push(`<h2 style="${SECTION_H}">What went up</h2>`);
        parts.push(...digest.movers.gainers.map(moverHtml));
      }
      if (digest.movers.decliners.length > 0) {
        parts.push(`<h2 style="${SECTION_H}">What came down</h2>`);
        parts.push(...digest.movers.decliners.map(moverHtml));
      }
    }
    if (section === "reestimated" && digest.reestimated) {
      parts.push(`<h2 style="${SECTION_H}">Re-estimated this week — not a market move (${digest.reestimated.total})</h2>`);
      parts.push(
        `<p style="${NOTE}">${esc("These values changed because of how we priced the card, not because it sold.")}</p>`,
      );
      parts.push(...digest.reestimated.items.map(reestimatedHtml));
      if (digest.reestimated.total > digest.reestimated.items.length) {
        parts.push(
          `<p style="${NOTE}">${esc(`…and ${digest.reestimated.total - digest.reestimated.items.length} more.`)}</p>`,
        );
      }
    }
    if (section === "signals" && digest.signals) {
      if (digest.signals.sell.length > 0) {
        parts.push(`<h2 style="${SECTION_H}">Good week to sell</h2>`);
        parts.push(...digest.signals.sell.map(signalHtml));
      }
      if (digest.signals.watch.length > 0) {
        parts.push(`<h2 style="${SECTION_H}">Worth watching</h2>`);
        parts.push(...digest.signals.watch.map(signalHtml));
      }
    }
    if (section === "audit" && digest.audit) {
      parts.push(`<h2 style="${SECTION_H}">Under review (${digest.audit.total})</h2>`);
      parts.push(...digest.audit.items.map(auditHtml));
      if (digest.audit.total > digest.audit.items.length) {
        parts.push(
          `<p style="${NOTE}">… and ${digest.audit.total - digest.audit.items.length} more.</p>`,
        );
      }
    }
    if (section === "market" && digest.market) {
      parts.push(`<h2 style="${SECTION_H}">The wider market</h2>`);
      parts.push(
        ...digest.market.rows.map(
          (r) =>
            `<p style="margin:0 0 8px;font-size:14px">${esc(r.basisNote)}</p>`,
        ),
      );
    }
  }

  if (digest.footnotes.length > 0) {
    parts.push(`<h2 style="${SECTION_H}">What these numbers mean</h2>`);
    parts.push(
      `<ul style="margin:0;padding-left:18px;font-size:13px;color:#4b5563">` +
        digest.footnotes.map((f) => `<li style="margin-bottom:6px">${esc(f)}</li>`).join("") +
        `</ul>`,
    );
  }

  parts.push(
    `<p style="margin:28px 0 0;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px">` +
      `HobbyIQ · week ${esc(digest.weekId)}</p>`,
  );
  parts.push(`</div>`);
  return parts.join("");
}

export function weeklyDigestSubject(digest: WeeklyDigest): string {
  return `Your week in cards — ${weekLabel(digest)}`;
}

export function renderWeeklyDigestEmail(digest: WeeklyDigest): {
  subject: string;
  plainText: string;
  html: string;
} {
  return {
    subject: weeklyDigestSubject(digest),
    plainText: renderWeeklyDigestText(digest),
    html: renderWeeklyDigestHtml(digest),
  };
}
