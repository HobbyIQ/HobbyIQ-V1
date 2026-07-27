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

export function formatCardTitle(h: {
  cardYear?: number | null;
  product?: string | null;
  playerName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  cardTitle?: string | null;
}): string {
  const parts: string[] = [];
  if (h.cardYear) parts.push(String(h.cardYear));
  if (h.product) parts.push(h.product);
  if (h.playerName) parts.push(h.playerName);
  if (h.cardNumber) parts.push(`#${h.cardNumber}`);
  const base = parts.join(" ");
  const suffix = h.parallel && h.parallel.toLowerCase() !== "base" ? ` — ${h.parallel}` : "";
  return base || h.cardTitle || "Untitled card";
  // parallel appended below to preserve fallback
  // (kept concise; caller can render the parallel separately if preferred)
  void suffix;
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
