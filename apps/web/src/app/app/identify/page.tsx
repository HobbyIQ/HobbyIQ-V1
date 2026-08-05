"use client";

// CF-CARD-IDENTIFY web parity (Drew, 2026-08-05).
//
// Web mirror of HobbyIQ/CardIdentifyView.swift. Upload/drag-drop an
// image → SAS-signed Azure blob → /api/portfolio/identify →
// grid of detections. Each detection renders card identity + grading
// + confidence, with a "View card" link into /app/card/[cardsightId]
// and a "Copy free-text" affordance for pasting into Search.
//
// MVP scope: file picker + drag-drop + preview + identify + result
// grid. Camera capture (iOS-native) is deferred — web can hit
// this same page from mobile Safari's file picker which offers
// "Take Photo" natively when it detects the accept="image/*" attr.

import Link from "next/link";
import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  uploadHoldingPhoto,
  identifyCardFromBlob,
  type CardIdentifyResponse,
  type CardIdentifyDetection,
} from "@/lib/api";

type Phase = "idle" | "uploading" | "identifying" | "done" | "error";

export default function IdentifyPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<CardIdentifyResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pickFile = useCallback((next: File | null) => {
    setError(null);
    setResponse(null);
    setPhase("idle");
    setFile(next);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(next ? URL.createObjectURL(next) : null);
  }, [previewUrl]);

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) pickFile(f);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0] ?? null;
    if (f && f.type.startsWith("image/")) pickFile(f);
  }

  async function onIdentify() {
    if (!file) return;
    setError(null);
    setResponse(null);
    try {
      setPhase("uploading");
      const blobUrl = await uploadHoldingPhoto(file);
      setPhase("identifying");
      const res = await identifyCardFromBlob(blobUrl, { extractCert: true });
      setResponse(res);
      setPhase("done");
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to identify card");
      setPhase("error");
    }
  }

  function reset() {
    pickFile(null);
    setError(null);
    setResponse(null);
    setPhase("idle");
    if (inputRef.current) inputRef.current.value = "";
  }

  const detections = response?.detections ?? [];
  const busy = phase === "uploading" || phase === "identifying";

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Identify a card</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Upload a photo of the front (and back if you have it). We&#39;ll return the best-guess set, card number, and grading in seconds.
        </p>
      </header>

      {!previewUrl ? (
        <label
          htmlFor="identify-file"
          className={`hiq-card p-10 flex flex-col items-center justify-center text-center gap-3 cursor-pointer transition-colors ${
            dragOver ? "bg-white/[0.06]" : "hover:bg-white/[0.02]"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-accent)]">
            <path d="M12 3l4 4h-3v6h-2V7H8l4-4zm-7 12h14v4H5v-4zm2 1v2h2v-2H7z" />
          </svg>
          <div className="text-lg font-semibold">Drop a card image here</div>
          <div className="text-sm text-[color:var(--color-muted)]">
            or click to choose · JPG / PNG · from Photos, camera roll, or drag-drop
          </div>
          <input
            ref={inputRef}
            id="identify-file"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onInputChange}
          />
        </label>
      ) : (
        <div className="space-y-6">
          <div className="hiq-card p-4 flex items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Card preview"
              className="w-32 h-44 object-cover rounded-lg flex-shrink-0"
              style={{ background: "var(--color-bg)" }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium mb-1 truncate">{file?.name ?? "image"}</div>
              <div className="text-xs text-[color:var(--color-muted)] mb-4">
                {file ? `${Math.round(file.size / 1024)} KB` : ""}
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={onIdentify}
                  disabled={busy}
                  className="hiq-btn-primary text-sm disabled:opacity-50"
                >
                  {phase === "uploading"
                    ? "Uploading…"
                    : phase === "identifying"
                      ? "Identifying…"
                      : "Identify"}
                </button>
                <button
                  onClick={reset}
                  disabled={busy}
                  className="hiq-btn-secondary text-sm disabled:opacity-50"
                >
                  Choose a different image
                </button>
              </div>
              {error && (
                <div className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
              )}
            </div>
          </div>

          {phase === "done" && detections.length === 0 && (
            <div className="hiq-card p-6 text-sm text-[color:var(--color-muted)]">
              We couldn&#39;t match this image. Try a well-lit shot of the card front, or use Search with the player + year.
            </div>
          )}

          {phase === "done" && detections.length > 0 && (
            <section>
              <div className="mb-3 text-xs text-[color:var(--color-muted)]">
                {detections.length} detection{detections.length === 1 ? "" : "s"}
                {response?.processingTime != null && ` · ${Math.round(response.processingTime * 1000)}ms`}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {detections.map((d, i) => (
                  <DetectionCard key={`${d.card?.id ?? "d"}-${i}`} d={d} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function DetectionCard({ d }: { d: CardIdentifyDetection }) {
  const c = d.card;
  const g = d.grading;
  const title = c?.name || "Unidentified card";
  const meta = [
    c?.year,
    c?.releaseName || c?.setName,
    c?.number ? `#${c.number}` : null,
    c?.parallel?.name,
  ].filter(Boolean).join(" · ");
  const gradeLabel = (() => {
    const company = g?.company?.name;
    const grade = g?.grade?.value;
    if (company && grade) return `${company} ${grade}`;
    if (company) return company;
    return null;
  })();
  const confidencePct = (() => {
    const raw = d.confidence ?? "";
    // iOS shows the raw string ("HIGH" / "MEDIUM" / "LOW") — mirror.
    return raw ? raw.toUpperCase() : null;
  })();
  const cardsightId = c?.id;
  const cardHref = cardsightId ? `/app/card/${encodeURIComponent(cardsightId)}` : null;

  return (
    <div className="hiq-card p-4 flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold">{title}</div>
        {meta && <div className="text-xs text-[color:var(--color-muted)] mt-1">{meta}</div>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {gradeLabel && <span className="hiq-badge hiq-badge--brand">{gradeLabel}</span>}
        {g?.autoGrade?.value && (
          <span className="hiq-badge hiq-badge--brand">Auto {g.autoGrade.value}</span>
        )}
        {confidencePct && (
          <span className="hiq-badge hiq-badge--neutral">{confidencePct}</span>
        )}
        {g?.qualifier?.name && (
          <span className="hiq-badge hiq-badge--warning">{g.qualifier.name}</span>
        )}
      </div>
      {cardHref && (
        <Link
          href={cardHref}
          className="text-xs font-medium mt-auto hover:underline self-start"
          style={{ color: "var(--color-accent)" }}
        >
          View pricing detail →
        </Link>
      )}
    </div>
  );
}
