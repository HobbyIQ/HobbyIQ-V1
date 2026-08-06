"use client";

// CF-PARALLEL-TRAIN-PAGE (Drew, 2026-08-06). Human-in-the-loop labeling
// for the OCR + price-nearest-sibling parallel disambiguator. Shows one
// anomaly row at a time with its image, OCR text, and neighboring
// parallels; admin picks the correct one and the row gets reclassified
// + logged as a training example.

import { useCallback, useEffect, useState } from "react";
import { getStoredAdminToken } from "@/lib/adminApi";

interface Sibling {
  parallel: string;
  medianPrice: number;
  n: number;
  sampleImageUrl: string | null;
}

interface Item {
  stagingId: string;
  hobbyiqCardId: string;
  title: string;
  price: number;
  storedParallel: string;
  imageUrl: string | null;
  ocrText: string;
  siblings: Sibling[];
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

function slugParallel(hobbyiqCardId: string): string {
  const parts = hobbyiqCardId.split(":");
  return parts[5] ?? "";  // hiq:sport:year:set:cardNumber:parallelSlug:autoFlag
}

export default function ParallelTrainPage() {
  const [item, setItem] = useState<Item | null>(null);
  const [color, setColor] = useState<string>("blue");
  const [mode, setMode] = useState<"auto" | "non-auto">("non-auto");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labeled, setLabeled] = useState<number>(0);
  const [manualEntry, setManualEntry] = useState<string>("");

  const token = getStoredAdminToken();

  const loadNext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/verify/parallel-train/next?color=${encodeURIComponent(color)}&mode=${mode}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setItem(json.item ?? null);
      setError(null);   // clear stale error on success
    } catch (e) {
      setError((e as Error)?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }, [color, mode, token]);

  useEffect(() => { void loadNext(); }, [loadNext]);

  const submitLabel = async (action: "assign" | "skip" | "unknown", chosenParallel?: string): Promise<void> => {
    if (!item) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/verify/parallel-train/${item.stagingId}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ action, chosenParallel, adminUserId: "drew" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLabeled((n) => n + 1);
      setManualEntry("");   // clear the manual input on advance
      await loadNext();
    } catch (e) {
      setError((e as Error)?.message ?? "submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div style={{ padding: 24, color: "var(--color-text)" }}>
        <p>Admin token required. Set it on the main admin page first.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", color: "var(--color-text)" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Parallel Train</h1>
      <p style={{ opacity: 0.7, marginBottom: 20 }}>
        Labeled this session: <strong>{labeled}</strong>. Each label reclassifies the staging row + logs a training example.
      </p>

      <div style={{ display: "flex", gap: 16, marginBottom: 24, alignItems: "center" }}>
        <label>Color: <select value={color} onChange={(e) => setColor(e.target.value)}>
          <option value="blue">blue</option>
          <option value="red">red</option>
          <option value="gold">gold</option>
          <option value="silver">silver</option>
          <option value="green">green</option>
          <option value="orange">orange</option>
          <option value="purple">purple</option>
          <option value="pink">pink</option>
          <option value="black">black</option>
        </select></label>
        <label>Mode: <select value={mode} onChange={(e) => setMode(e.target.value as "auto" | "non-auto")}>
          <option value="non-auto">non-auto</option>
          <option value="auto">auto</option>
        </select></label>
        <button onClick={() => void loadNext()} disabled={loading} style={{ padding: "6px 14px" }}>Reload</button>
      </div>

      {error && <div style={{ padding: 12, background: "#fee", color: "#900", marginBottom: 16 }}>{error}</div>}

      {loading && <p>Loading next candidate…</p>}
      {!loading && !item && <p>No pending candidates for this color/mode. Try another combo.</p>}

      {item && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24 }}>
          <div>
            {item.imageUrl ? (
              <img src={item.imageUrl} alt="candidate" style={{ width: "100%", borderRadius: 8, border: "1px solid #ddd" }} />
            ) : (
              <div style={{ padding: 20, background: "#eee", textAlign: "center" }}>no image</div>
            )}
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6, wordBreak: "break-all" }}>
              <a href={item.imageUrl ?? "#"} target="_blank" rel="noreferrer">open full-size</a>
            </div>
          </div>
          <div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{item.title}</div>
              <div style={{ marginTop: 4, opacity: 0.7, fontSize: 13 }}>
                stored parallel: <strong>{item.storedParallel || "(empty)"}</strong> · sold for <strong>${item.price}</strong>
              </div>
              <div style={{ marginTop: 4, opacity: 0.6, fontSize: 12, wordBreak: "break-all" }}>{item.hobbyiqCardId}</div>
            </div>

            <div style={{ marginBottom: 16, padding: 10, background: "rgba(0,0,0,0.03)", borderRadius: 6, fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>OCR text</div>
              <div style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>{item.ocrText || "(empty)"}</div>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Pick the correct parallel (nearest to ${item.price} first)</div>
              {item.siblings.length === 0 ? (
                <div style={{ padding: 12, background: "rgba(255,193,7,0.15)", border: "1px solid rgba(255,193,7,0.6)", borderRadius: 6, color: "var(--color-text)" }}>
                  No sibling sales at this year/set/#cardNumber with the color match. Rare insert or thin pool.
                  <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
                    Slug says: <code style={{ background: "rgba(0,0,0,0.15)", padding: "2px 6px", borderRadius: 3 }}>{slugParallel(item.hobbyiqCardId)}</code> — click <strong>Current is correct</strong> if that&apos;s right.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
                  {item.siblings.map((s) => (
                    <button
                      key={s.parallel}
                      disabled={submitting}
                      onClick={() => void submitLabel("assign", s.parallel)}
                      style={{
                        display: "grid", gridTemplateColumns: "50px 1fr auto", gap: 10,
                        alignItems: "center", padding: 8, textAlign: "left",
                        background: "white", border: "1px solid #ddd", borderRadius: 6, cursor: "pointer",
                        color: "#111",
                      }}
                    >
                      {s.sampleImageUrl
                        ? <img src={s.sampleImageUrl} alt="sib" style={{ width: 40, height: 55, objectFit: "cover", borderRadius: 4 }} />
                        : <div style={{ width: 40, height: 55, background: "#eee", borderRadius: 4 }} />}
                      <div>
                        <div style={{ fontWeight: 500 }}>{s.parallel}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>median ${s.medianPrice} · n={s.n}</div>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.6 }}>
                        Δ ${Math.abs(s.medianPrice - item.price).toFixed(2)}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 12, display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="text"
                  placeholder="Or type the correct parallel manually (e.g. 'Blue Mojo Refractor')"
                  value={manualEntry}
                  onChange={(e) => setManualEntry(e.target.value)}
                  disabled={submitting}
                  style={{ flex: 1, padding: 8, background: "white", color: "#111", border: "1px solid #ccc", borderRadius: 6 }}
                />
                <button
                  disabled={submitting || !manualEntry.trim()}
                  onClick={() => void submitLabel("assign", manualEntry.trim())}
                  style={{ padding: "8px 16px", background: manualEntry.trim() ? "#e0f2fe" : "#eee", border: "1px solid #0284c7", color: "#0369a1", borderRadius: 6, cursor: manualEntry.trim() ? "pointer" : "not-allowed" }}
                >
                  Assign manual
                </button>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                <button disabled={submitting} onClick={() => void submitLabel("assign", item.storedParallel || item.hobbyiqCardId.split(":")[5] || "")}
                        style={{ padding: "8px 16px", background: "#efe", border: "1px solid #8c8" }}>
                  Current is correct
                </button>
                <button disabled={submitting} onClick={() => void submitLabel("skip")}
                        style={{ padding: "8px 16px", background: "#eee", border: "1px solid #ccc" }}>Skip</button>
                <button disabled={submitting} onClick={() => void submitLabel("unknown")}
                        style={{ padding: "8px 16px", background: "#fee", border: "1px solid #f88" }}>None of these (unknown)</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
