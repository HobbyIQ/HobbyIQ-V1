// Small formatting helpers. All money on the wire is dollars-float
// (per backend responseAssembly.ts) so we format straight from Number.

export function formatUSD(n: number | null | undefined, opts: { hideCents?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const { hideCents = false } = opts;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (hideCents && abs >= 100) {
    return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatUSDCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return formatUSD(n, { hideCents: true });
}

export function formatPct(n: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const { signed = true } = opts;
  const rounded = Math.round(n * 10) / 10;
  const sign = signed && rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)}%`;
}

/** CF-MOBILE-HOLDING-CARD (Drew, 2026-09-04). The "what product is this"
 *  half of a card title — year + product + parallel — with the two cleanups
 *  `formatCardTitle` has always done applied: a product whose leading four
 *  digits repeat `cardYear` loses them, and a product whose trailing words
 *  repeat the parallel loses those.
 *
 *  Exported because the mobile holding card shows this half on its own line,
 *  under the player + card number. It must not re-implement the cleanups —
 *  a second copy would drift, and the phone would show "Bowman Chrome
 *  Refractor Refractor" on the exact rows Drew already had fixed once
 *  (CF-TITLE-DEDUP-PARALLEL, 2026-08-10). `formatCardTitle` calls this too,
 *  so the two are one computation.
 */
export function formatCardContext(h: {
  cardYear?: number | null;
  product?: string | null;
  parallel?: string | null;
}): string {
  // Strip a leading year from product when we're already going to prepend
  // cardYear — otherwise "2026" + "2026 Bowman Baseball" collapses to
  // "2026 2026 Bowman Baseball". Same year (four digits) at the very
  // start of product is the only shape we drop; anything else stays.
  let product = h.product?.trim() ?? "";
  if (h.cardYear && product) {
    const yearStr = String(h.cardYear);
    const leadingYear = product.match(/^(\d{4})\s+/);
    if (leadingYear && leadingYear[1] === yearStr) {
      product = product.slice(leadingYear[0].length);
    }
  }

  // CF-TITLE-DEDUP-PARALLEL (Drew, 2026-08-10). Some vendor product
  // names already carry the parallel as a suffix ("2026 Bowman -
  // Chrome Prospect Autographs - Refractor"). Appending parallel
  // "Refractor" then produces "Refractor Refractor Owen Carey" —
  // Drew flagged this on the Owen Carey CPA-OC panel. Strip a
  // trailing `[-\s]<parallel>` from product when it duplicates the
  // parallel we're about to append.
  const rawParallel = h.parallel?.trim() ?? "";
  const parallelToAppend = rawParallel && rawParallel.toLowerCase() !== "base" ? rawParallel : "";
  if (product && parallelToAppend) {
    const escaped = parallelToAppend.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const trailingRe = new RegExp(`[-\\s]+${escaped}\\s*$`, "i");
    const stripped = product.replace(trailingRe, "").trim();
    if (stripped.length > 0) product = stripped;
  }

  const parts: string[] = [];
  if (h.cardYear) parts.push(String(h.cardYear));
  if (product) parts.push(product);
  // Parallel goes inline right after the product (before the player) so
  // the title reads like "2026 Bowman Baseball Orange Shimmer Eric
  // Hartman #CPA-EHA" — the parallel is what distinguishes similarly-
  // numbered cards and needs to be visible without a second glance.
  if (parallelToAppend) parts.push(parallelToAppend);
  return parts.join(" ");
}

export function formatCardTitle(h: {
  cardYear?: number | null;
  product?: string | null;
  playerName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  cardTitle?: string | null;
}): string {
  // Year + product + parallel, with the leading-year and trailing-parallel
  // cleanups applied. Shared with the mobile holding card, which renders
  // this half on its own line — see formatCardContext.
  const context = formatCardContext(h);
  const parts: string[] = [];
  if (context) parts.push(context);
  if (h.playerName) parts.push(h.playerName);
  if (h.cardNumber) parts.push(`#${h.cardNumber}`);
  const base = parts.join(" ");
  return base || h.cardTitle || "Untitled card";
}

export function formatGrade(h: {
  gradeCompany?: string | null;
  gradeValue?: number | null;
}): string {
  if (!h.gradeCompany && h.gradeValue == null) return "Raw";
  if (!h.gradeCompany) return `Grade ${h.gradeValue}`;
  if (h.gradeValue == null) return h.gradeCompany;
  return `${h.gradeCompany} ${h.gradeValue}`;
}

/** CF-SHOW-WHAT-WE-WOULD-WRITE (2026-08-23). Renders a canonical slug as the
 *  card a person would recognise, for the one screen where the machine asks
 *  "is this it?" and the answer has to be readable at a glance.
 *
 *    hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150
 *    -> 2024 Bowman Draft · #CPA-TG · Blue Refractor · Auto · /150
 *
 *  Segments are positional and fixed:
 *    hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallel}:{autoFlag}[:num-{n}]
 *
 *  This prettifies the SLUG, not a catalog row — so it shows our setKey, which
 *  may read less naturally than the printed product name. That is deliberate:
 *  this is the identity about to be written, and showing something nicer than
 *  what gets stored would be a lie at exactly the moment the user is being
 *  asked to vouch for it. The raw slug is shown alongside for the same reason.
 *  Returns null for anything that is not a canonical slug rather than
 *  half-rendering a string it does not understand. */
export function describeSlug(slug: string | null | undefined): string | null {
  const parts = String(slug ?? "").split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return null;

  const [, , year, setKey, cardNumber, parallel, autoFlag, ...rest] = parts;
  const titleCase = (s: string) =>
    s.split("-").filter(Boolean)
      .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(" ");

  const bits: string[] = [];
  const head = [year, setKey ? titleCase(setKey) : ""].filter(Boolean).join(" ");
  if (head) bits.push(head);
  if (cardNumber) bits.push(`#${cardNumber.toUpperCase()}`);
  // "base" is the absence of a parallel, not a parallel called Base.
  if (parallel && parallel !== "base") bits.push(titleCase(parallel));
  if (autoFlag === "auto") bits.push("Auto");
  const printRun = rest.find((p) => p.startsWith("num-"));
  if (printRun) bits.push(`/${printRun.slice(4)}`);
  // Graders are initialisms, and titleCase would render PSA as "Psa". "raw"
  // is a word, not a grader, so it stays a word.
  const grade = rest.find((p) => !p.startsWith("num-"));
  if (grade) {
    bits.push(
      grade === "raw"
        ? "Raw"
        : grade.split("-").filter(Boolean)
            .map((t) => (/^[a-z]+$/.test(t) && t.length <= 4 ? t.toUpperCase() : t))
            .join(" "),
    );
  }

  return bits.join(" · ") || null;
}
