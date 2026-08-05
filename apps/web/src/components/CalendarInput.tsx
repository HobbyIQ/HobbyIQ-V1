"use client";

// CF-CALENDAR-INPUT (Drew, 2026-08-05).
//
// Purchase-date field on the add/edit-card modals uses `<input type="date">`
// which is a tiny native OS picker most users don't visually notice. This
// wraps that same field with a proper 6-week calendar grid that opens on
// click — the "purchase date exploding into a calendar" experience.
//
// Value contract matches the native input: an ISO date string (yyyy-mm-dd),
// or "" when nothing's selected. onChange fires with the same shape. The
// native <input type="date"> is preserved for the value display + keyboard
// entry; the calendar is a visual overlay that also mutates the same value.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

interface Props {
  value: string;                                  // yyyy-mm-dd or ""
  onChange: (next: string) => void;
  min?: string;
  max?: string;
  className?: string;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIso(iso: string): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDisplay(iso: string): string {
  const d = parseIso(iso);
  if (!d) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function CalendarInput({ value, onChange, min, max, className }: Props) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => parseIso(value) ?? new Date());
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Sync visible month to value whenever value flips underneath us.
  useEffect(() => {
    const parsed = parseIso(value);
    if (parsed) setViewMonth((prev) => (sameDay(prev, parsed) ? prev : parsed));
  }, [value]);

  const today = useMemo(() => new Date(), []);
  const selected = parseIso(value);
  const minDate = min ? parseIso(min) : null;
  const maxDate = max ? parseIso(max) : null;

  // Build 6-week grid starting on Sunday, so month cells line up under S..S.
  const days: Array<{ date: Date; inMonth: boolean }> = useMemo(() => {
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const start = new Date(firstOfMonth);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { date: d, inMonth: d.getMonth() === viewMonth.getMonth() };
    });
  }, [viewMonth]);

  const goPrev = (e: FormEvent): void => { e.preventDefault(); setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1)); };
  const goNext = (e: FormEvent): void => { e.preventDefault(); setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1)); };
  const pick = (d: Date): void => {
    onChange(toIso(d));
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ textAlign: "left", cursor: "pointer" }}
      >
        <span style={{ color: value ? "var(--color-text)" : "var(--color-muted)" }}>
          {formatDisplay(value) || "Select a date"}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose purchase date"
          className="hiq-cal-popover"
        >
          <div className="hiq-cal-header">
            <button type="button" onClick={goPrev} className="hiq-cal-nav" aria-label="Previous month">‹</button>
            <div className="hiq-cal-title">{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</div>
            <button type="button" onClick={goNext} className="hiq-cal-nav" aria-label="Next month">›</button>
          </div>
          <div className="hiq-cal-weekgrid">
            {WEEKDAYS.map((w, i) => <div key={i} className="hiq-cal-weekhead">{w}</div>)}
          </div>
          <div className="hiq-cal-grid">
            {days.map(({ date, inMonth }, i) => {
              const isSelected = selected && sameDay(selected, date);
              const isToday = sameDay(today, date);
              const outOfRange =
                (minDate && date < minDate) || (maxDate && date > maxDate);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => !outOfRange && pick(date)}
                  disabled={!!outOfRange}
                  className={[
                    "hiq-cal-day",
                    inMonth ? "" : "hiq-cal-day--dim",
                    isSelected ? "hiq-cal-day--selected" : "",
                    isToday && !isSelected ? "hiq-cal-day--today" : "",
                    outOfRange ? "hiq-cal-day--disabled" : "",
                  ].filter(Boolean).join(" ")}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected ? "true" : "false"}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="hiq-cal-footer">
            <button
              type="button"
              onClick={() => pick(new Date())}
              className="hiq-cal-today-btn"
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { onChange(""); setOpen(false); }}
                className="hiq-cal-clear-btn"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
