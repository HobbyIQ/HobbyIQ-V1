"use client";

// Mirrors iOS BuyerIQView.swift. Root: user's card-show buying lists.
// Tap a list -> /app/buyeriq/[listId].

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchBuyerIqLists,
  fetchBuyerIqTargets,
  createBuyerIqList,
  deleteBuyerIqList,
  type BuyerIqList,
  type BuyerIqTarget,
} from "@/lib/api";

export default function BuyerIqPage() {
  const [lists, setLists] = useState<BuyerIqList[]>([]);
  const [targetsByList, setTargetsByList] = useState<Record<string, BuyerIqTarget[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    try {
      const listsRes = await fetchBuyerIqLists();
      const activeLists = listsRes.lists.filter((l) => !l.archived);
      setLists(activeLists);
      const all = await fetchBuyerIqTargets();
      const bucket: Record<string, BuyerIqTarget[]> = {};
      for (const t of all.targets) {
        (bucket[t.listId] ??= []).push(t);
      }
      setTargetsByList(bucket);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to load lists");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onDelete(listId: string) {
    if (!confirm("Delete this list and all its targets?")) return;
    try {
      await deleteBuyerIqList(listId);
      await refresh();
    } catch (err) {
      alert((err as { message?: string }).message ?? "Failed to delete");
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">BuyerIQ</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Card-show buying checklists. Add targets, set your ceiling, check them off as you find them on the floor.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/app/buyeriq/deals" className="hiq-btn-secondary text-sm">
            Deals
          </Link>
          <button
            onClick={() => setShowCreate(true)}
            className="hiq-btn-primary"
          >
            + New list
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading lists…</div>
      )}

      {error && (
        <div className="hiq-card p-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {!loading && !error && lists.length === 0 && (
        <div className="hiq-card p-8 text-center">
          <p className="text-sm text-[color:var(--color-muted)] max-w-md mx-auto mb-4">
            No buying lists yet. Create one for the next card show — HobbyIQ will keep your ceilings and check-offs synced across your phone and web.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="hiq-btn-primary"
          >
            Create your first list
          </button>
        </div>
      )}

      {!loading && !error && lists.length > 0 && (
        <div className="space-y-3">
          {lists.map((list) => {
            const targets = targetsByList[list.id] ?? [];
            const wanted = targets.filter((t) => t.status === "wanted").length;
            const acquired = targets.filter((t) => t.status === "acquired").length;
            return (
              <div key={list.id} className="hiq-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/app/buyeriq/${list.id}`} className="flex-1 min-w-0 block hover:opacity-80">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <div className="font-semibold text-base">{list.name}</div>
                      {list.showDate && (
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full"
                          style={{
                            background: "var(--color-bg-card-hover)",
                            color: "var(--color-muted)",
                          }}
                        >
                          {formatShowDate(list.showDate)}
                        </span>
                      )}
                    </div>
                    {list.showLocation && (
                      <div className="text-xs text-[color:var(--color-muted)] mt-1">{list.showLocation}</div>
                    )}
                    {list.description && (
                      <div className="text-sm text-[color:var(--color-muted)] mt-2 line-clamp-2">{list.description}</div>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs">
                      <span style={{ color: "var(--color-accent)" }}>
                        {wanted} wanted
                      </span>
                      {acquired > 0 && (
                        <span style={{ color: "var(--color-success)" }}>{acquired} acquired</span>
                      )}
                      {targets.length === 0 && (
                        <span className="text-[color:var(--color-muted)]">Empty list</span>
                      )}
                    </div>
                  </Link>
                  <button
                    onClick={() => onDelete(list.id)}
                    className="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)] shrink-0"
                    aria-label="Delete list"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateListDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateListDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [showDate, setShowDate] = useState("");
  const [showLocation, setShowLocation] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createBuyerIqList({
        name: name.trim(),
        showDate: showDate.trim() || null,
        showLocation: showLocation.trim() || null,
        description: description.trim() || null,
      });
      onCreated();
    } catch (err) {
      setError((err as { message?: string }).message ?? "Failed to create list");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="hiq-card w-full max-w-md p-6 space-y-4"
      >
        <h2 className="text-xl font-bold">New buying list</h2>
        <div>
          <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="e.g. Chicago National"
            className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">Show date</label>
            <input
              type="date"
              value={showDate}
              onChange={(e) => setShowDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">Location</label>
            <input
              type="text"
              value={showLocation}
              onChange={(e) => setShowLocation(e.target.value)}
              placeholder="Rosemont, IL"
              className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">Notes</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Budget, focus, dealers to hit first…"
            className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          />
        </div>
        {error && <div className="text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>}
        <div className="flex items-center gap-2 justify-end">
          <button type="button" onClick={onClose} className="text-sm text-[color:var(--color-muted)] px-3 py-2">
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className="hiq-btn-primary">
            {busy ? "Creating…" : "Create list"}
          </button>
        </div>
      </form>
    </div>
  );
}

function formatShowDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
