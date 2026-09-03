// CF-VALUATION-REPORT (Drew, 2026-09-02): the printable document.
//
// Renders a ValuationReport as ONE self-contained HTML file: no external
// stylesheet, no font fetch, no script. It has to survive being saved to
// disk, emailed, and opened offline months later, and a document that
// depends on a CDN is a document that eventually renders as unstyled text.
//
// PRINT IS THE TARGET. The backend carries no PDF renderer (see the note
// in valuationReport.service.ts), so "Save as PDF" in the browser is the
// PDF path. That means the print stylesheet is not decoration:
//   - @page sets Letter margins so the header never collides with the
//     printer's own margin;
//   - `print-color-adjust: exact` keeps the provenance labels coloured on
//     paper, because a SPECULATIVE label that prints as plain black text
//     beside a number is the failure this whole feature exists to avoid;
//   - table rows never break across pages, and the methodology and
//     disclaimer each start their own page.
//
// Everything user-supplied is escaped. A card title is user-editable
// free text, and this document is rendered into a browser.

import type {
  ReportProvenanceClass,
  ReportRow,
  ValuationReport,
} from "./valuationReport.service.js";
import { PROVENANCE_LEGEND } from "./valuationReport.service.js";

/** HTML-escape. Applied to every interpolated value without exception. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return USD.format(n);
}

function pct(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** "September 2, 2026 at 3:14 PM UTC" — unambiguous on paper, where the
 *  reader has no tooltip to hover and no locale context to rely on. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "UTC",
  });
  return `${date} at ${time} UTC`;
}

/** Short form for the dense per-row as-of cell. */
export function formatStampShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
}

const CLASS_ORDER: ReportProvenanceClass[] = [
  "observed", "estimated", "speculative", "own-purchase", "unpriced",
];

const CLASS_TITLE: Record<ReportProvenanceClass, string> = {
  observed: "Observed",
  estimated: "Estimated",
  speculative: "Speculative",
  "own-purchase": "Own purchase (at cost)",
  unpriced: "Not priced",
};

// ─── Row ─────────────────────────────────────────────────────────────────

function renderRow(r: ReportRow): string {
  const labelHtml = r.label
    ? `<span class="tag tag-${esc(r.klass)}">${esc(r.label)}</span>`
    : "";
  // The staleness note is a SECOND fact beside the rung, never a rewrite
  // of it — the same rule the web's chip follows.
  const stale =
    r.compAgeDays !== null && r.compAgeDays > 45
      ? `<div class="stale">Last direct sale ${Math.max(1, Math.round(r.compAgeDays / 7))} weeks ago — priced to today's market, not read off a recent trade.</div>`
      : "";
  const basis = r.basis ? `<div class="basis">${esc(r.basis)}</div>` : "";

  return `
      <tr>
        <td class="c-identity">
          <div class="ident">${esc(r.identity)}</div>
          <div class="rung">${esc(r.rung.text)}${
            r.rung.label ? ` <span class="rung-label">(${esc(r.rung.label)})</span>` : ""
          }</div>
          ${basis}
          ${stale}
        </td>
        <td class="c-tier">${esc(r.tier)}</td>
        <td class="c-num">${esc(r.quantity)}</td>
        <td class="c-conf">${esc(pct(r.confidence))}</td>
        <td class="c-asof">${esc(formatStampShort(r.asOf))}</td>
        <td class="c-money">
          <div class="val">${esc(money(r.perUnit))}</div>
          ${labelHtml}
        </td>
        <td class="c-money c-total">${esc(money(r.lineTotal))}</td>
      </tr>`;
}

// ─── Totals ──────────────────────────────────────────────────────────────

function renderTotals(report: ValuationReport): string {
  const t = report.totals;
  const lines = CLASS_ORDER
    .filter((k) => t.byClass[k].count > 0)
    .map((k) => `
        <tr class="bc-${esc(k)}">
          <td class="c-identity">${esc(CLASS_TITLE[k])}</td>
          <td class="c-num">${esc(t.byClass[k].count)}</td>
          <td class="c-money">${esc(
            k === "unpriced" ? "—" : money(t.byClass[k].total),
          )}</td>
        </tr>`)
    .join("");

  const gain = t.unrealizedGainLoss;
  const gainRow =
    gain === null
      ? ""
      : `
        <tr class="grand-sub">
          <td class="c-identity">Recorded cost basis</td>
          <td class="c-num"></td>
          <td class="c-money">${esc(money(t.costBasisTotal))}</td>
        </tr>
        <tr class="grand-sub">
          <td class="c-identity">Unrealized gain / loss</td>
          <td class="c-num"></td>
          <td class="c-money ${gain >= 0 ? "pos" : "neg"}">${esc(money(gain))}</td>
        </tr>`;

  return `
    <section class="totals">
      <h2>Totals</h2>
      <table class="t-totals">
        <thead>
          <tr><th class="c-identity">Basis</th><th class="c-num">Holdings</th><th class="c-money">Value</th></tr>
        </thead>
        <tbody>
          ${lines}
          <tr class="sub">
            <td class="c-identity">Market-derived value <span class="sub-note">(observed + estimated + speculative)</span></td>
            <td class="c-num"></td>
            <td class="c-money">${esc(money(t.marketDerivedTotal))}</td>
          </tr>
          <tr class="grand">
            <td class="c-identity">Total carried value <span class="sub-note">(includes own-purchase carries)</span></td>
            <td class="c-num">${esc(t.holdingCount)}</td>
            <td class="c-money">${esc(money(t.grandTotal))}</td>
          </tr>
          ${gainRow}
        </tbody>
      </table>
      <p class="totals-note">
        Of ${esc(t.holdingCount)} holdings (${esc(t.cardCount)} cards),
        ${esc(t.byClass.observed.count)} carry a value read from sales of that
        exact card at that exact grade, totalling ${esc(money(t.observedTotal))}.
        The remainder is derived, speculative, carried at cost, or not priced —
        each row says which, and the basis of value section explains what each
        term means.
      </p>
    </section>`;
}

// ─── Methodology ─────────────────────────────────────────────────────────

/**
 * The methodology page, in the site's own language. This is not marketing
 * copy: it states the doctrine the engine actually implements, because
 * this document's whole claim to being useful is that a reader can check
 * how each number was produced.
 */
function renderMethodology(report: ValuationReport): string {
  const used = CLASS_ORDER.filter((k) => report.totals.byClass[k].count > 0);
  const legend = used
    .map((k) => `
        <dt class="tag tag-${esc(k)}">${esc(CLASS_TITLE[k])}</dt>
        <dd>${esc(PROVENANCE_LEGEND[k])}</dd>`)
    .join("");

  return `
    <section class="page-break methodology">
      <h2>How these values were produced</h2>

      <h3>Fair market value is a projection, not an average</h3>
      <p>
        A HobbyIQ valuation is the <strong>projected next sale</strong> for a
        card: what the evidence says the next copy is likely to trade for.
        It is not the average of past sales and it is not the median of
        past sales. Where a card has enough recent sales, the value is a
        trend read over that card's own sale history, evaluated at today —
        so a card whose market has been climbing is not valued at what it
        fetched three months ago, and one that has been falling is not
        valued at its peak.
      </p>

      <h3>The pool is the exact card at the exact grade</h3>
      <p>
        Every value starts from the sales of the <em>same card</em> — same
        year, same product, same card number, same parallel, same print
        run, same autograph status — at the <em>same grade</em>. A PSA 10
        is not priced from PSA 9 sales, and a Gold Refractor is not priced
        from base-card sales, when sales of the actual card exist. Where
        that exact pool exists, the row is marked
        <span class="tag tag-observed">Observed</span>.
      </p>

      <h3>When the exact pool is empty, the report says so</h3>
      <p>
        Cards trade thinly. When there are no sales of a card at its grade,
        the value is derived from the nearest real evidence — that same
        card at another grade scaled by a multiplier measured from our own
        sales data, a sibling parallel, or the card's family — and the row
        is marked <span class="tag tag-estimated">Estimated</span>. Every
        multiplier used is empirical: measured from observed sales, never
        assumed, never a published price-guide ratio.
      </p>

      <h3>Speculation is named, not hidden</h3>
      <p>
        Some cards have not traded recently at all. Where a card's own
        market has gone cold, its last real sale is carried forward on the
        movement of that player's other cards — today's market applied to
        an old print, rather than a stale price presented as current. Those
        rows are marked
        <span class="tag tag-speculative">Speculative</span> and their
        confidence is capped accordingly. A speculative value is a method
        applied to a guess; it is reported because omitting the card
        entirely would understate the collection, not because it carries
        the same weight as an observed sale.
      </p>

      <h3>Your own purchases</h3>
      <p>
        Where no market value could be produced for a card at all, the
        report carries it at what you paid and marks it
        <span class="tag tag-own-purchase">Own purchase</span>. That figure
        is your cost, not a valuation, and no comparable sales stand behind
        it. Where your own past purchase of a card is the only sale in a
        card's pool, it is used as a market signal — a real transaction is
        evidence — but the row is labelled so you can see that the market
        being described is, in part, your own.
      </p>

      <h3>Grades are observed, never smoothed</h3>
      <p>
        Where sales exist at several grades of the same card, each grade is
        reported from its own sales. If the market has paid more for a PSA
        9 than a PSA 10 of a card in the period measured, that is what the
        report shows. Values are not adjusted to make higher grades rank
        above lower ones, because the inversion is information.
      </p>

      <h3>Confidence</h3>
      <p>
        The confidence figure on each row reflects how well-evidenced that
        specific value is &mdash; how many sales stood behind it, how recent they
        were, and how far the method reached from the exact card. It is a
        measure of evidence, not a probability that a particular sale price
        will be achieved.
      </p>
      <p>
        It is a statement about the <em>value</em>, not about the card&rsquo;s
        identity. A card we have identified with complete certainty can still
        carry a low confidence here, because the sales behind its price were
        few, old, or drawn from a method that reached beyond the exact card.
        Those are separate questions and this column answers only the second.
      </p>
      <p>
        A dash means no confidence figure was recorded for that value &mdash;
        typically a price set before this figure was tracked, or one from a
        path that does not report one. It is not a low score, and it should
        not be read as one; the row&rsquo;s basis and method still say where
        the number came from.
      </p>

      <h3>Basis of value</h3>
      <dl class="legend">${legend}
      </dl>
    </section>`;
}

// ─── Disclaimer ──────────────────────────────────────────────────────────

function renderDisclaimer(): string {
  return `
    <section class="page-break disclaimer">
      <h2>Important — what this document is and is not</h2>

      <p class="lead">
        This is a <strong>valuation opinion generated from market data</strong>.
        It is <strong>not an appraisal</strong>, and it is not a guarantee
        of value.
      </p>

      <p>
        The values in this report are algorithmically generated estimates
        based on historical sales data and statistical modelling. They are
        inherently uncertain, may be inaccurate, incomplete, or out of
        date, and are not appraisals, offers to buy or sell, guarantees of
        value, or predictions of future sale prices. HobbyIQ is not a
        licensed appraiser, broker-dealer, investment adviser, financial
        adviser, tax adviser, or insurance provider, and nothing in this
        document constitutes financial, investment, legal, tax, insurance,
        or other professional advice.
      </p>

      <p>
        Actual sale prices depend on factors this report cannot fully
        capture — including condition and eye appeal within a grade,
        centering, authenticity, timing, the venue of sale, fees, and buyer
        demand at the moment of sale. Comparable-sales data may contain
        errors, mislabelled listings, invalid or non-arm's-length sales, or
        gaps in coverage. Values for low-liquidity, rare, or newly released
        cards may rest on very limited data and are especially uncertain.
        Past sales performance does not indicate future results.
      </p>

      <p>
        Any decision to buy, sell, hold, grade, insure, consign, or
        otherwise transact in cards is made solely at your own risk. If you
        require a valuation for insurance scheduling, estate, donation, or
        any other legal or tax purpose, obtain an independent appraisal
        from a qualified professional appraiser. This document is not a
        substitute for one and should not be presented as one.
      </p>

      <p class="asof-note">
        Values reflect the data available to HobbyIQ as of the timestamps
        shown on each row. Card markets move continuously; a value computed
        days ago may no longer reflect the current market.
      </p>
    </section>`;
}

// ─── Styles ──────────────────────────────────────────────────────────────

const STYLES = `
  :root {
    --ink: #14161a;
    --ink-soft: #4a5058;
    --ink-faint: #767d87;
    --rule: #d9dde3;
    --rule-soft: #ebeef2;
    --observed: #0f7a4a;
    --estimated: #1256b8;
    --speculative: #a35a06;
    --own: #7a2f8f;
    --unpriced: #6b7280;
    --neg: #b3261e;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    padding: 32px 28px 48px;
    background: #fff;
    color: var(--ink);
    font: 13px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 1100px;
    margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 0 0 10px; letter-spacing: -0.005em; }
  h3 { font-size: 13px; margin: 18px 0 4px; }
  p { margin: 0 0 9px; color: var(--ink-soft); max-width: 68ch; }

  /* ── Masthead ── */
  .masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 24px; padding-bottom: 12px; margin-bottom: 18px;
    border-bottom: 2px solid var(--ink);
  }
  .brand { font-size: 11px; font-weight: 700; letter-spacing: 0.09em;
           text-transform: uppercase; color: var(--ink-faint); margin-bottom: 6px; }
  .meta { text-align: right; font-size: 11px; color: var(--ink-soft); line-height: 1.65; white-space: nowrap; }
  .meta strong { color: var(--ink); font-weight: 600; }
  .subtitle { font-size: 12px; color: var(--ink-faint); margin: 0; }

  /* ── Callout ── */
  .callout {
    border: 1px solid var(--rule); border-left: 3px solid var(--ink);
    background: #fafbfc; padding: 10px 14px; margin: 0 0 20px;
    font-size: 11.5px; color: var(--ink-soft);
  }
  .callout strong { color: var(--ink); }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--ink-faint);
    border-bottom: 1px solid var(--rule); padding: 0 8px 6px;
  }
  tbody td { padding: 9px 8px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  tbody tr { page-break-inside: avoid; break-inside: avoid; }
  .c-num, .c-money, .c-conf { text-align: right; white-space: nowrap; }
  .c-tier { white-space: nowrap; color: var(--ink-soft); }
  .c-asof { white-space: nowrap; color: var(--ink-faint); font-size: 11px; }
  .c-money { font-variant-numeric: tabular-nums; }
  .c-total { font-weight: 650; }
  .ident { font-weight: 600; color: var(--ink); margin-bottom: 2px; }
  .rung { font-size: 11px; color: var(--ink-soft); }
  .rung-label { color: var(--ink-faint); font-size: 10px; }
  .basis { font-size: 10.5px; color: var(--ink-faint); margin-top: 3px; max-width: 74ch; }
  .stale { font-size: 10.5px; color: var(--speculative); margin-top: 3px; max-width: 74ch; }
  .val { font-weight: 600; }

  /* ── Provenance tags ── */
  .tag {
    display: inline-block; margin-top: 4px; padding: 1px 5px; border-radius: 3px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.05em; white-space: nowrap;
  }
  .tag-observed    { color: var(--observed);    background: #e7f4ee; }
  .tag-estimated   { color: var(--estimated);   background: #e8effb; }
  .tag-speculative { color: var(--speculative); background: #fdf0e0; }
  .tag-own-purchase{ color: var(--own);         background: #f5eaf8; }
  .tag-unpriced    { color: var(--unpriced);    background: #f0f1f3; }

  /* ── Totals ── */
  .totals { margin-top: 26px; page-break-inside: avoid; break-inside: avoid; }
  .t-totals { max-width: 560px; }
  .t-totals td { padding: 7px 8px; }
  .t-totals .sub td { border-top: 1px solid var(--rule); font-weight: 600; color: var(--ink); }
  .t-totals .grand td { border-top: 2px solid var(--ink); border-bottom: none;
                        font-size: 15px; font-weight: 700; padding-top: 9px; }
  .t-totals .grand-sub td { border-bottom: none; color: var(--ink-soft); padding-top: 2px; }
  .sub-note { font-weight: 400; font-size: 10px; color: var(--ink-faint); }
  .pos { color: var(--observed); }
  .neg { color: var(--neg); }
  .totals-note { font-size: 11px; margin-top: 12px; max-width: 78ch; }

  /* ── Methodology + disclaimer ── */
  .legend { margin: 8px 0 0; }
  .legend dt { margin-top: 9px; }
  .legend dd { margin: 3px 0 0; font-size: 11.5px; color: var(--ink-soft); max-width: 74ch; }
  .disclaimer .lead { font-size: 13.5px; color: var(--ink); max-width: 74ch; }
  .disclaimer p { font-size: 11.5px; }
  .asof-note { border-top: 1px solid var(--rule); padding-top: 9px; margin-top: 14px;
               font-size: 11px; color: var(--ink-faint); }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid var(--rule);
          font-size: 10px; color: var(--ink-faint); display: flex;
          justify-content: space-between; gap: 16px; }

  .empty { padding: 28px; text-align: center; color: var(--ink-faint);
           border: 1px dashed var(--rule); }

  /* ── Print ── */
  @page { size: letter; margin: 14mm 12mm; }
  @media print {
    body { padding: 0; max-width: none; font-size: 10.5px; }
    /* Provenance labels MUST survive the printer. */
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page-break { page-break-before: always; break-before: page; }
    thead { display: table-header-group; }
    .no-print { display: none !important; }
    h1 { font-size: 18px; }
    a[href]:after { content: ""; }
  }
  @media screen and (max-width: 700px) {
    .masthead { flex-direction: column; gap: 10px; }
    .meta { text-align: left; }
    body { padding: 18px 14px 32px; }
  }
`;

// ─── Document ────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Shown in the masthead when known — whose collection this is. */
  ownerLabel?: string | null;
  /** Adds a "Print / Save as PDF" button, hidden when printing. */
  includePrintButton?: boolean;
}

export function renderValuationReportHtml(
  report: ValuationReport,
  opts: RenderOptions = {},
): string {
  const t = report.totals;
  const owner = opts.ownerLabel ? esc(opts.ownerLabel) : null;

  const rowsHtml = report.rows.length
    ? report.rows.map(renderRow).join("")
    : "";

  const table = report.rows.length
    ? `
    <table class="t-holdings">
      <thead>
        <tr>
          <th class="c-identity">Card / basis of value</th>
          <th class="c-tier">Grade</th>
          <th class="c-num">Qty</th>
          <th class="c-conf">Conf.</th>
          <th class="c-asof">Valued</th>
          <th class="c-money">Per card</th>
          <th class="c-money">Line total</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}
      </tbody>
    </table>`
    : `<div class="empty">This collection has no holdings to report.</div>`;

  const printButton = opts.includePrintButton
    ? `<button class="no-print" onclick="window.print()" style="position:fixed;top:14px;right:14px;padding:8px 14px;font:600 12px ui-sans-serif,system-ui,sans-serif;background:#14161a;color:#fff;border:0;border-radius:6px;cursor:pointer;z-index:10">Print / Save as PDF</button>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HobbyIQ Valuation Report — ${esc(formatStampShort(report.generatedAt))}</title>
<style>${STYLES}</style>
</head>
<body>
${printButton}
  <header class="masthead">
    <div>
      <div class="brand">HobbyIQ</div>
      <h1>Collection Valuation Report</h1>
      <p class="subtitle">${owner ? `Prepared for ${owner}` : "Valuation opinion from market data"}</p>
    </div>
    <div class="meta">
      <div>Generated <strong>${esc(formatStamp(report.generatedAt))}</strong></div>
      <div>${esc(t.holdingCount)} holdings · ${esc(t.cardCount)} cards</div>
      <div>Total carried value <strong>${esc(money(t.grandTotal))}</strong></div>
    </div>
  </header>

  <div class="callout">
    <strong>This is a valuation opinion generated from market data — not an appraisal.</strong>
    Each row states how its value was produced and how current it is. Values
    that are estimated, speculative, or carried at your own purchase price
    are labelled as such in the table below. See the basis of value and the
    disclaimer at the end of this document.
  </div>

  ${table}

  ${renderTotals(report)}

  ${renderMethodology(report)}

  ${renderDisclaimer()}

  <footer class="foot">
    <span>HobbyIQ Collection Valuation Report · generated ${esc(formatStamp(report.generatedAt))}</span>
    <span>Values as of ${esc(formatStampShort(report.oldestAsOf))} – ${esc(formatStampShort(report.newestAsOf))}</span>
  </footer>
</body>
</html>`;
}

/** Filename for the download, dated. */
export function reportFilename(generatedAt: string): string {
  const t = Date.parse(generatedAt);
  const stamp = Number.isFinite(t)
    ? new Date(t).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return `hobbyiq-valuation-report-${stamp}.html`;
}
