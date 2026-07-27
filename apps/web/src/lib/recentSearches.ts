// localStorage-backed recent searches. Newest first, deduped case-
// insensitively, capped at MAX. Shared between the global search bar
// (dropdown when input focused empty) and any future "recent searches"
// widget.

const KEY = "hobbyiq_recent_searches";
const MAX = 5;

export function getRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

export function addRecentSearch(query: string): void {
  if (typeof window === "undefined") return;
  const q = query.trim();
  if (!q) return;
  const lower = q.toLowerCase();
  const prior = getRecentSearches().filter((v) => v.toLowerCase() !== lower);
  const next = [q, ...prior].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage full or blocked — non-fatal
  }
}

export function clearRecentSearches(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
}
