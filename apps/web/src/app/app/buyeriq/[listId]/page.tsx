"use client";

// Mirrors iOS BuyerIQListDetailView.swift. Filter by status, add/edit/delete
// targets, mark acquired.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  fetchBuyerIqLists,
  fetchBuyerIqTargets,
  createBuyerIqTarget,
  updateBuyerIqTarget,
  deleteBuyerIqTarget,
  searchCards,
  type BuyerIqList,
  type BuyerIqTarget,
  type BuyerIqPriority,
  type BuyerIqStatus,
  type SearchCandidate,
} from "@/lib/api";

const STATUS_TABS: BuyerIqStatus[] = ["wanted", "acquired", "passed"];

export default function BuyerIqListDetailPage() {
  const params = useParams<{ listId: string }>();
  const router = useRouter();
  const listId = params.listId;

  const [list, setList] = useState<BuyerIqList | null>(null);
  const [targets, setTargets] = useState<BuyerIqTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<BuyerIqStatus>("wanted");
  const [editTarget, setEditTarget] = useState<BuyerIqTarget | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    try {
      const [listsRes, targetsRes] = await Promise.all([
        fetchBuyerIqLists(),
        fetchBuyerIqTargets(listId),
      ]);
      const found = listsRes.lists.find((l) => l.id === listId) ?? null;
      setList(found);
      setTargets(targetsRes.targets);
    } catch (err) {
      setError((err as { message?: string }).message ?? "Failed to load list");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [listId]);

  const filtered = useMemo(
    () => targets.filter((t) => t.status === statusFilter),
    [targets, statusFilter],
  );

  const counts = useMemo(() => {
    const c: Record<BuyerIqStatus, number> = { wanted: 0, acquired: 0, passed: 0 };
    for (const t of targets) c[t.status]++;
    return c;
  }, [targets]);

  async function markAcquired(target: BuyerIqTarget) {
    try {
      await updateBuyerIqTarget(target.id, { status: "acquired" });
      await refresh();
    } catch (err) {
      alert((err as { message?: string }).message ?? "Failed to update");
    }
  }

  async function markWanted(target: BuyerIqTarget) {
    try {
      await updateBuyerIqTarget(target.id, { status: "wanted", acquiredAt: null, acquiredPrice: null });
      await refresh();
    } catch (err) {
      alert((err as { message?: string }).message ?? "Failed to update");
    }
  }

  async function markPassed(target: BuyerIqTarget) {
    try {
      await updateBuyerIqTarget(target.id, { status: "passed" });
      await refresh();
    } catch (err) {
      alert((err as { message?: string }).message ?? "Failed to update");
    }
  }

  async function onDelete(target: BuyerIqTarget) {
    if (!confirm(`Delete "${target.playerName}"?`)) return;
    try {
      await deleteBuyerIqTarget(target.id);
      await refresh();
    } catch (err) {
      alert((err as { message?: string }).message ?? "Failed to delete");
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading list…</div>
      </div>
    );
  }

  if (error || !list) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/buyeriq" className="text-sm text-[color:var(--color-accent)] hover:underline">← Back to BuyerIQ</Link>
        <div className="hiq-card p-4 mt-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error ?? "List not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/app/buyeriq" className="text-sm text-[color:var(--color-accent)] hover:underline">← Back to BuyerIQ</Link>
      <div className="mt-2 mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{list.name}</h1>
          <div className="text-sm text-[color:var(--color-muted)] mt-1 flex items-center gap-2 flex-wrap">
            {list.showDate && <span>{formatShowDate(list.showDate)}</span>}
            {list.showLocation && <span>· {list.showLocation}</span>}
          </div>
          {list.description && (
            <div className="text-sm text-[color:var(--color-muted)] mt-2">{list.description}</div>
          )}
        </div>
        <button onClick={() => setShowAdd(true)} className="hiq-btn-primary shrink-0">
          + Add target
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={{
              background: statusFilter === s ? "var(--color-accent)" : "var(--color-bg-card)",
              color: statusFilter === s ? "var(--color-bg)" : "var(--color-muted)",
            }}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
            <span className="ml-1 opacity-70">{counts[s]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="hiq-card p-8 text-center">
          <p className="text-sm text-[color:var(--color-muted)] max-w-md mx-auto">
            {statusFilter === "wanted"
              ? "No wanted targets. Add cards you're hunting at the next show."
              : statusFilter === "acquired"
              ? "Nothing acquired yet. Check off targets as you find them."
              : "No passed targets."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <TargetRow
              key={t.id}
              target={t}
              onEdit={() => setEditTarget(t)}
              onMarkAcquired={() => markAcquired(t)}
              onMarkWanted={() => markWanted(t)}
              onMarkPassed={() => markPassed(t)}
              onDelete={() => onDelete(t)}
            />
          ))}
        </div>
      )}

      {(showAdd || editTarget) && (
        <TargetDialog
          listId={list.id}
          initial={editTarget ?? undefined}
          onClose={() => {
            setShowAdd(false);
            setEditTarget(null);
          }}
          onSaved={() => {
            setShowAdd(false);
            setEditTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function TargetRow({
  target,
  onEdit,
  onMarkAcquired,
  onMarkWanted,
  onMarkPassed,
  onDelete,
}: {
  target: BuyerIqTarget;
  onEdit: () => void;
  onMarkAcquired: () => void;
  onMarkWanted: () => void;
  onMarkPassed: () => void;
  onDelete: () => void;
}) {
  const subtitle = subtitleLine(target);
  return (
    <div
      className="hiq-card p-3 flex items-start gap-3"
      style={{ opacity: target.status === "passed" ? 0.6 : 1 }}
    >
      <div
        className="w-11 h-16 shrink-0 rounded flex items-center justify-center overflow-hidden"
        style={{ background: "var(--color-bg-card-hover)" }}
      >
        {target.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={target.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-xs text-[color:var(--color-muted)]">—</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <button onClick={onEdit} className="text-left w-full block hover:opacity-80">
          <div className="font-semibold text-sm truncate">{target.playerName}</div>
          {subtitle && (
            <div className="text-xs text-[color:var(--color-muted)] truncate">{subtitle}</div>
          )}
          {target.parallel && (
            <div className="text-xs font-medium mt-0.5">{target.parallel}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <PriorityChip priority={target.priority} />
            {target.maxPrice !== null && (
              <Chip
                label={`Cap $${Math.round(target.maxPrice)}`}
                bg="var(--color-bg-card-hover)"
                fg="white"
              />
            )}
            {target.status === "acquired" && target.acquiredPrice !== null && (
              <Chip
                label={`Paid $${Math.round(target.acquiredPrice)}`}
                bg="rgba(34,197,94,0.25)"
                fg="rgb(34,197,94)"
              />
            )}
            {target.notes && (
              <span className="text-xs text-[color:var(--color-muted)] truncate max-w-[200px]">
                — {target.notes}
              </span>
            )}
          </div>
        </button>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {target.status === "wanted" && (
          <>
            <button
              onClick={onMarkAcquired}
              className="text-xs px-2 py-1 rounded-full font-semibold"
              style={{ background: "rgba(34,197,94,0.2)", color: "rgb(34,197,94)" }}
            >
              ✓ Got it
            </button>
            <button
              onClick={onMarkPassed}
              className="text-xs px-2 py-1 rounded-full text-[color:var(--color-muted)] hover:text-white"
            >
              Pass
            </button>
          </>
        )}
        {target.status === "acquired" && (
          <button
            onClick={onMarkWanted}
            className="text-xs px-2 py-1 rounded-full text-[color:var(--color-muted)] hover:text-white"
          >
            Undo
          </button>
        )}
        {target.status === "passed" && (
          <button
            onClick={onMarkWanted}
            className="text-xs px-2 py-1 rounded-full text-[color:var(--color-muted)] hover:text-white"
          >
            Restore
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function PriorityChip({ priority }: { priority: BuyerIqPriority }) {
  const map = {
    high: { bg: "rgba(239,68,68,0.25)", fg: "rgb(239,68,68)", label: "High" },
    medium: { bg: "rgba(234,179,8,0.25)", fg: "rgb(234,179,8)", label: "Med" },
    low: { bg: "var(--color-bg-card-hover)", fg: "var(--color-muted)", label: "Low" },
  } as const;
  const c = map[priority];
  return <Chip label={c.label} bg={c.bg} fg={c.fg} />;
}

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span
      className="text-xs font-bold px-2 py-0.5 rounded-full"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  );
}

function TargetDialog({
  listId,
  initial,
  onClose,
  onSaved,
}: {
  listId: string;
  initial?: BuyerIqTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [playerName, setPlayerName] = useState(initial?.playerName ?? "");
  const [cardYear, setCardYear] = useState(initial?.cardYear?.toString() ?? "");
  const [setName, setSetName] = useState(initial?.setName ?? "");
  const [cardNumber, setCardNumber] = useState(initial?.cardNumber ?? "");
  const [parallel, setParallel] = useState(initial?.parallel ?? "");
  const [isAuto, setIsAuto] = useState(initial?.isAuto ?? false);
  const [gradeCompany, setGradeCompany] = useState(initial?.gradeCompany ?? "");
  const [gradeValue, setGradeValue] = useState(initial?.gradeValue?.toString() ?? "");
  const [maxPrice, setMaxPrice] = useState(initial?.maxPrice?.toString() ?? "");
  const [priority, setPriority] = useState<BuyerIqPriority>(initial?.priority ?? "medium");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [status, setStatus] = useState<BuyerIqStatus>(initial?.status ?? "wanted");
  const [acquiredPrice, setAcquiredPrice] = useState(initial?.acquiredPrice?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CF-BUYERIQ-CATALOG-SEARCH web (Drew, 2026-08-10). Catalog search
  // panel state — mirrors the iOS BuyerIQCatalogSearchSheet flow so
  // web + iOS "Add target" both prefill from the same canonical
  // catalog identity + capture hobbyiqCardId for pricing rails.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pickedHobbyiqCardId, setPickedHobbyiqCardId] = useState<string | null>(initial?.hobbyiqCardId ?? null);
  const [pickedImageUrl, setPickedImageUrl] = useState<string | null>(initial?.imageUrl ?? null);

  async function runSearch() {
    const q = searchQuery.trim();
    if (q.length < 2) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await searchCards(q, "freetext");
      setSearchResults(res.candidates ?? []);
    } catch (err) {
      setSearchError((err as { message?: string }).message ?? "Search failed");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  function applyCatalogPick(c: SearchCandidate) {
    // Prefill every form field the catalog knows. User can still
    // edit anything below (e.g. add a grade/parallel not captured).
    if (c.player) setPlayerName(c.player);
    if (c.year != null) setCardYear(String(c.year));
    if (c.setName) setSetName(c.setName);
    if (c.cardNumber) setCardNumber(c.cardNumber);
    if (c.parallel) setParallel(c.parallel);
    setIsAuto(c.isAuto);
    if (c.gradeCompany) setGradeCompany(c.gradeCompany);
    if (c.gradeValue != null) setGradeValue(String(c.gradeValue));
    setPickedHobbyiqCardId(c.candidateId);
    setPickedImageUrl(c.imageUrl);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!playerName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        listId,
        // CF-BUYERIQ-CATALOG-SEARCH web (Drew, 2026-08-10). Passing the
        // canonical slug + image when the user picked from catalog so
        // the target row lands slug-tagged on first insert.
        hobbyiqCardId: pickedHobbyiqCardId,
        imageUrl: pickedImageUrl,
        playerName: playerName.trim(),
        cardYear: cardYear.trim() ? Number(cardYear.trim()) : null,
        setName: setName.trim() || null,
        cardNumber: cardNumber.trim() || null,
        parallel: parallel.trim() || null,
        isAuto,
        gradeCompany: gradeCompany.trim() || null,
        gradeValue: gradeValue.trim() ? Number(gradeValue.trim()) : null,
        maxPrice: maxPrice.trim() ? Number(maxPrice.trim()) : null,
        priority,
        notes: notes.trim() || null,
        status,
        acquiredPrice: acquiredPrice.trim() ? Number(acquiredPrice.trim()) : null,
      };
      if (isEdit) {
        await updateBuyerIqTarget(initial!.id, body);
      } else {
        await createBuyerIqTarget(body);
      }
      onSaved();
    } catch (err) {
      setError((err as { message?: string }).message ?? "Failed to save");
      setBusy(false);
    }
  }

  const inputCls = "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]";
  const inputStyle = { background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="hiq-card w-full max-w-lg p-6 space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-xl font-bold">{isEdit ? "Edit target" : "Add target"}</h2>

        {/* CF-BUYERIQ-CATALOG-SEARCH web (Drew, 2026-08-10). Catalog
            search — same identity source as iOS BuyerIQCatalogSearchSheet.
            Create mode only; hidden in edit so existing targets don't
            accidentally re-slug. Picking a result prefills every field
            AND captures the canonical hobbyiqCardId + imageUrl so the
            row lands slug-tagged for FMV / gap match / market movers. */}
        {!isEdit && (
          <div
            className="rounded-lg border p-3"
            style={{
              background: "var(--color-bg)",
              borderColor: pickedHobbyiqCardId ? "var(--hiq-hobby-green, #7CFF72)" : "var(--color-border)",
            }}
          >
            {!searchOpen && !pickedHobbyiqCardId && (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="w-full flex items-center gap-3 text-left"
              >
                <span aria-hidden style={{ color: "var(--color-accent)", fontSize: 18 }}>🔍</span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-white">Search catalog</span>
                  <span className="block text-xs text-[color:var(--color-muted)]">
                    Match to canonical identity so pricing rails snap in
                  </span>
                </span>
                <span className="text-[color:var(--color-muted)]">›</span>
              </button>
            )}
            {!searchOpen && pickedHobbyiqCardId && (
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(true);
                  setPickedHobbyiqCardId(null);
                  setPickedImageUrl(null);
                }}
                className="w-full flex items-center gap-3 text-left"
              >
                <span aria-hidden style={{ color: "var(--hiq-hobby-green, #7CFF72)", fontSize: 18 }}>✓</span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-white">Card picked from catalog</span>
                  <span className="block text-xs text-[color:var(--color-muted)]">Tap to change; or edit fields below</span>
                </span>
              </button>
            )}
            {searchOpen && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runSearch();
                      }
                    }}
                    placeholder="e.g. 2011 Topps Update Mike Trout US175"
                    className={inputCls}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={runSearch}
                    disabled={searchLoading || searchQuery.trim().length < 2}
                    className="hiq-btn-primary text-sm disabled:opacity-60 whitespace-nowrap"
                  >
                    {searchLoading ? "Searching…" : "Search"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery("");
                      setSearchResults([]);
                      setSearchError(null);
                    }}
                    className="text-xs text-[color:var(--color-muted)] hover:text-white"
                  >
                    Close
                  </button>
                </div>
                {searchError && (
                  <div className="text-xs" style={{ color: "var(--color-danger)" }}>{searchError}</div>
                )}
                {!searchLoading && searchResults.length === 0 && searchQuery.trim().length >= 2 && !searchError && (
                  <div className="text-xs text-[color:var(--color-muted)]">
                    No matches. Try adding the year, set name, or card number.
                  </div>
                )}
                {searchResults.length > 0 && (
                  <div className="max-h-64 overflow-y-auto -mx-1">
                    {searchResults.slice(0, 20).map((c) => (
                      <button
                        key={c.candidateId}
                        type="button"
                        onClick={() => applyCatalogPick(c)}
                        className="w-full flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 text-left"
                      >
                        <div className="w-10 h-14 rounded flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg-card, #101B2D)" }}>
                          {c.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.imageUrl} alt="" className="w-full h-full object-contain" />
                          ) : (
                            <span className="text-[color:var(--color-muted)] text-xs">📷</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-white truncate">{c.title}</div>
                          <div className="text-xs text-[color:var(--color-muted)] flex items-center gap-1.5 flex-wrap mt-0.5">
                            {c.year && <span>{c.year}</span>}
                            {c.setName && <span>· {c.setName}</span>}
                            {c.cardNumber && <span>· #{c.cardNumber}</span>}
                            {c.parallel && <span>· {c.parallel}</span>}
                            {c.isAuto && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: "var(--hiq-hobby-green, #7CFF72)", color: "#0e1626" }}>AUTO</span>
                            )}
                          </div>
                        </div>
                        <span className="text-[color:var(--color-accent)] text-lg" aria-hidden>+</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <Field label="Player name" required>
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            required
            autoFocus
            placeholder="Mike Trout"
            className={inputCls}
            style={inputStyle}
          />
        </Field>

        <div className="grid grid-cols-3 gap-2">
          <Field label="Year">
            <input
              type="number"
              value={cardYear}
              onChange={(e) => setCardYear(e.target.value)}
              placeholder="2011"
              className={inputCls}
              style={inputStyle}
            />
          </Field>
          <Field label="Card #">
            <input
              type="text"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              placeholder="US175"
              className={inputCls}
              style={inputStyle}
            />
          </Field>
          <Field label="Auto">
            <label className="flex items-center gap-2 text-sm pt-1.5">
              <input
                type="checkbox"
                checked={isAuto}
                onChange={(e) => setIsAuto(e.target.checked)}
              />
              <span>Autograph</span>
            </label>
          </Field>
        </div>

        <Field label="Set / product">
          <input
            type="text"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            placeholder="Topps Update"
            className={inputCls}
            style={inputStyle}
          />
        </Field>

        <Field label="Parallel">
          <input
            type="text"
            value={parallel}
            onChange={(e) => setParallel(e.target.value)}
            placeholder="Gold Refractor"
            className={inputCls}
            style={inputStyle}
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Grade company">
            <select
              value={gradeCompany}
              onChange={(e) => setGradeCompany(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="">Raw</option>
              <option value="PSA">PSA</option>
              <option value="BGS">BGS</option>
              <option value="SGC">SGC</option>
              <option value="CGC">CGC</option>
            </select>
          </Field>
          <Field label="Grade value">
            <input
              type="number"
              step="0.5"
              value={gradeValue}
              onChange={(e) => setGradeValue(e.target.value)}
              placeholder="10"
              className={inputCls}
              style={inputStyle}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Max buy price">
            <input
              type="number"
              step="1"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="500"
              className={inputCls}
              style={inputStyle}
            />
          </Field>
          <Field label="Priority">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as BuyerIqPriority)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </Field>
        </div>

        {isEdit && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as BuyerIqStatus)}
                className={inputCls}
                style={inputStyle}
              >
                <option value="wanted">Wanted</option>
                <option value="acquired">Acquired</option>
                <option value="passed">Passed</option>
              </select>
            </Field>
            {status === "acquired" && (
              <Field label="Paid">
                <input
                  type="number"
                  step="1"
                  value={acquiredPrice}
                  onChange={(e) => setAcquiredPrice(e.target.value)}
                  placeholder="425"
                  className={inputCls}
                  style={inputStyle}
                />
              </Field>
            )}
          </div>
        )}

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Table 12, dealer prefers cash…"
            className={inputCls}
            style={inputStyle}
          />
        </Field>

        {error && <div className="text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>}

        <div className="flex items-center gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[color:var(--color-muted)] px-3 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !playerName.trim()}
            className="hiq-btn-primary"
          >
            {busy ? "Saving…" : isEdit ? "Save" : "Add target"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">
        {label}
        {required && <span style={{ color: "var(--color-danger)" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

function subtitleLine(t: BuyerIqTarget): string | null {
  const parts: string[] = [];
  if (t.cardYear) parts.push(String(t.cardYear));
  if (t.setName) parts.push(t.setName);
  if (t.cardNumber) parts.push(`#${t.cardNumber}`);
  if (t.gradeCompany && t.gradeValue !== null) parts.push(`${t.gradeCompany} ${t.gradeValue}`);
  else if (t.isAuto === true) parts.push("Auto");
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatShowDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
