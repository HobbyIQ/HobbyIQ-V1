"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { fetchSuggestions } from "@/lib/api";
import { getRecentSearches, addRecentSearch, clearRecentSearches } from "@/lib/recentSearches";

interface Props {
  compact?: boolean;  // narrower placeholder / no submit button (mobile top bar)
  autoFocus?: boolean;
}

// Global search bar rendered in the AppShell top bar. Debounces to
// /api/compiq/suggest as the user types, shows recent searches from
// localStorage when empty focused, arrow/enter keyboard nav.
export function GlobalSearchBar({ compact = false, autoFocus = false }: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [mode, setMode] = useState<"recent" | "suggestions" | "empty">("recent");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);  // keyboard-highlighted index
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRecent = useCallback(() => {
    const recent = getRecentSearches();
    setItems(recent);
    setMode(recent.length > 0 ? "recent" : "empty");
    setActive(-1);
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      // Empty input while open → show recent
      if (open) showRecent();
      return;
    }
    // Debounce 180ms then fetch suggestions
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      try {
        const res = await fetchSuggestions(trimmed, 8);
        // Only accept the response if the query hasn't moved on
        if (trimmed !== q.trim()) return;
        setItems(res.suggestions ?? []);
        setMode(res.suggestions?.length ? "suggestions" : "empty");
        setActive(-1);
      } catch {
        // Suggest is best-effort; silently drop errors
        setItems([]);
        setMode("empty");
      }
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function commit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    addRecentSearch(trimmed);
    setOpen(false);
    setActive(-1);
    router.push(`/app/search?q=${encodeURIComponent(trimmed)}`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (active >= 0 && items[active]) commit(items[active]);
    else commit(q);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown") {
        setOpen(true);
        showRecent();
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      setActive((prev) => Math.min(items.length - 1, prev + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((prev) => Math.max(-1, prev - 1));
      e.preventDefault();
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    } else if (e.key === "Enter") {
      if (active >= 0 && items[active]) {
        e.preventDefault();
        commit(items[active]);
      }
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            style={{ color: "var(--color-muted)" }}
          >
            <path d="M10 2a8 8 0 016.32 12.9l5.39 5.4-1.42 1.4-5.39-5.39A8 8 0 1110 2zm0 2a6 6 0 100 12 6 6 0 000-12z" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
            placeholder={compact ? "Search" : "Search any card, player, or cert #…"}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              if (!q.trim()) showRecent();
            }}
            onKeyDown={onKeyDown}
            className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
          />
        </div>
        {!compact && (
          <button
            type="submit"
            disabled={!q.trim()}
            className="hiq-btn-primary text-sm disabled:opacity-50 whitespace-nowrap"
          >
            Search
          </button>
        )}
      </form>

      {open && items.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-2 rounded-xl border shadow-2xl overflow-hidden z-40"
          style={{
            background: "var(--color-bg-card)",
            borderColor: "var(--color-border)",
          }}
        >
          <div className="flex items-center justify-between px-4 py-2 text-[10px] uppercase tracking-wide font-medium text-[color:var(--color-muted)]">
            {mode === "recent" && (
              <>
                <span>Recent</span>
                <button
                  type="button"
                  onClick={() => {
                    clearRecentSearches();
                    setItems([]);
                    setMode("empty");
                  }}
                  className="hover:text-white transition-colors"
                >
                  Clear
                </button>
              </>
            )}
            {mode === "suggestions" && <span>Suggestions</span>}
          </div>
          <ul>
            {items.map((s, i) => (
              <li key={`${s}-${i}`}>
                <button
                  type="button"
                  onClick={() => commit(s)}
                  onMouseEnter={() => setActive(i)}
                  className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors"
                  style={{
                    background: active === i ? "color-mix(in oklab, var(--color-accent) 10%, transparent)" : "transparent",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    style={{ color: "var(--color-muted)" }}
                  >
                    {mode === "recent" ? (
                      <path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 117 7 6.94 6.94 0 01-4.9-2.05l-1.42 1.42A9 9 0 1013 3zm-1 5v5l4.28 2.54.72-1.21L13.5 12.25V8z" />
                    ) : (
                      <path d="M10 2a8 8 0 016.32 12.9l5.39 5.4-1.42 1.4-5.39-5.39A8 8 0 1110 2zm0 2a6 6 0 100 12 6 6 0 000-12z" />
                    )}
                  </svg>
                  <span className="truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
