/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): "as of <time>", honestly.
 *
 * The portfolio renders persisted values instantly and dispatches a refresh
 * behind itself, so this line is the only thing telling the user how current
 * the numbers on screen are.
 *
 * Shows a clock time for anything today and a date beyond that, because
 * "as of 10:42" is only useful once you know it means today — the same
 * string on a week-old value reads as current, which is exactly the
 * misreading this change exists to fix.
 *
 * Returns null when there is no usable timestamp rather than inventing
 * "just now": a portfolio whose holdings carry no lastUpdated should say
 * nothing, not claim freshness it cannot support.
 */
export function formatAsOf(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
