"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  previewImport,
  commitImport,
  type ImportRowEnvelope,
  type ImportPreviewResponse,
  type ImportBucket,
  type CommitAction,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

// Bulk import via CSV / XLSX. Preview shows every row with its resolver
// verdict + collision bucket; the user picks an action per row before
// committing. Supports the sync path (≤40 rows) — async large-file
// support is a follow-up.
export default function PortfolioImportPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [actions, setActions] = useState<Record<number, CommitAction>>({});
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<Awaited<ReturnType<typeof commitImport>> | null>(null);
  const [idempotencyToken] = useState(() =>
    `web-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(null);
    setError(null);
    setCommitResult(null);
    setLoading(true);
    try {
      const format: "csv" | "xlsx" = /\.csv$/i.test(f.name) ? "csv" : "xlsx";
      const res = await previewImport(f, format);
      setPreview(res);
      if (res.async) {
        setError(
          "This file is large — the async import path isn't wired on the web yet. Try a file with ≤ 40 rows or use the iOS app for now.",
        );
        setLoading(false);
        return;
      }
      // Default action = "commit" for each envelope; user overrides as needed.
      const initial: Record<number, CommitAction> = {};
      (res.envelopes ?? []).forEach((env) => {
        initial[env.rowNumber] = env.bucket === "clean" ? "commit" : "skip";
      });
      setActions(initial);
    } catch (err) {
      const e = err as { message?: string; status?: number };
      if (e.status === 402) {
        setError("Import is limited on your plan. Upgrade for larger imports.");
      } else {
        setError(e.message ?? "Failed to preview file.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function onCommit() {
    if (!preview?.envelopes) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await commitImport(idempotencyToken, preview.envelopes, actions);
      setCommitResult(res);
      if (res.capacityExceeded) {
        setError(
          `Import would exceed your portfolio cap (${res.capacityExceeded.wouldBeTotal} > ${res.capacityExceeded.cap}). Upgrade or remove rows.`,
        );
      }
    } catch (err) {
      setError((err as { message?: string }).message ?? "Commit failed.");
    } finally {
      setCommitting(false);
    }
  }

  const envelopes = preview?.envelopes ?? [];
  const commitCount = useMemo(
    () => Object.values(actions).filter((a) => a === "commit" || a === "add-as-copy" || a === "update-cost").length,
    [actions],
  );

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
        ← Back to portfolio
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Import cards</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Upload a CSV or Excel file — one row per card. We&apos;ll match each row
          to a known SKU and let you review before anything commits to your
          portfolio.
        </p>
        <p className="text-xs text-[color:var(--color-muted)] mt-3">
          Not sure of the format?{" "}
          <a
            href="/hobbyiq-portfolio-template.csv"
            download
            className="hover:underline"
            style={{ color: "var(--hiq-electric-blue)" }}
          >
            Download the CSV template ↓
          </a>{" "}
          — canonical column names + 3 sample rows.
        </p>
        <p className="text-xs text-[color:var(--color-muted)] mt-2">
          Coming from Card Ladder? Their CSV export drops in unchanged — we
          understand Date Purchased, Subject, Set, Variation, Number,
          Condition, Investment, Graded Cert #, and Population.
        </p>
      </div>

      {/* File picker card */}
      <div className="hiq-card p-6 mb-6">
        <label className="block cursor-pointer">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-2">
            File (CSV or XLSX)
          </div>
          <div
            className="rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:border-[color:var(--color-accent)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            {file ? (
              <div>
                <div className="text-sm font-medium">{file.name}</div>
                <div className="text-xs text-[color:var(--color-muted)] mt-1">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
                <div className="text-xs mt-2" style={{ color: "var(--color-accent)" }}>
                  Click to pick a different file
                </div>
              </div>
            ) : (
              <div className="text-sm text-[color:var(--color-muted)]">
                Drop or click to upload · CSV or XLSX
              </div>
            )}
          </div>
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={onPickFile}
            className="sr-only"
            disabled={loading || committing}
          />
        </label>
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)] mb-4">
          Parsing + resolving rows…
        </div>
      )}

      {error && (
        <div className="hiq-card p-4 mb-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {commitResult && (
        <div
          className="hiq-card p-4 mb-6 text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-success) 8%, transparent)",
            color: "var(--color-success)",
          }}
        >
          <div className="font-medium">
            {commitResult.totals?.added ?? 0} added ·{" "}
            {commitResult.totals?.updated ?? 0} updated ·{" "}
            {commitResult.totals?.skipped ?? 0} skipped ·{" "}
            {commitResult.totals?.failed ?? 0} failed
          </div>
          <button
            onClick={() => router.push("/app/portfolio")}
            className="mt-3 hiq-btn-primary text-sm"
          >
            Open portfolio
          </button>
        </div>
      )}

      {preview?.summary && !commitResult && (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <SummaryTile label="Total rows" value={preview.summary.totalRows} />
            <SummaryTile label="Clean" value={preview.summary.byBucket.clean ?? 0} color="var(--color-success)" />
            <SummaryTile label="Collision" value={preview.summary.byBucket.collision ?? 0} color="var(--color-accent)" />
            <SummaryTile label="Ambiguous" value={preview.summary.byBucket.ambiguous ?? 0} color="var(--color-accent)" />
            <SummaryTile label="Unresolved" value={preview.summary.byBucket.unresolved ?? 0} color="var(--color-danger)" />
          </div>

          {preview.summary.capacityProjection?.wouldExceed && (
            <div className="hiq-card p-3 mb-4 text-sm"
              style={{
                background: "color-mix(in oklab, var(--color-danger) 8%, transparent)",
                color: "var(--color-danger)",
              }}
            >
              This import would put you at {preview.summary.capacityProjection.projectedTotal} cards,
              above your plan cap of {preview.summary.capacityProjection.cap}. Upgrade or reduce
              rows before committing.
            </div>
          )}

          {preview.unmappedHeaders && preview.unmappedHeaders.length > 0 && (
            <div className="hiq-card p-3 mb-4 text-xs" style={{ background: "var(--color-bg)" }}>
              <span className="text-[color:var(--color-muted)]">Ignored columns: </span>
              {preview.unmappedHeaders.join(", ")}
            </div>
          )}

          <div className="space-y-2 mb-6">
            {envelopes.map((env) => (
              <EnvelopeRow
                key={env.rowNumber}
                env={env}
                action={actions[env.rowNumber] ?? "skip"}
                onActionChange={(a) => setActions((prev) => ({ ...prev, [env.rowNumber]: a }))}
              />
            ))}
          </div>

          <div className="hiq-card p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-[color:var(--color-muted)]">
              <strong>{commitCount}</strong> row{commitCount === 1 ? "" : "s"} will commit
            </div>
            <button
              onClick={onCommit}
              disabled={committing || commitCount === 0 || preview.summary.capacityProjection?.wouldExceed}
              className="hiq-btn-primary text-sm disabled:opacity-40"
            >
              {committing ? "Committing…" : `Commit ${commitCount}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="hiq-card p-3">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums" style={color && value > 0 ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function EnvelopeRow({
  env,
  action,
  onActionChange,
}: {
  env: ImportRowEnvelope;
  action: CommitAction;
  onActionChange: (a: CommitAction) => void;
}) {
  const bucketColor = bucketColorOf(env.bucket);
  const p = env.payload;
  const title = [
    p.cardYear,
    p.product,
    p.parallel,
    p.playerName,
    p.cardNumber ? `#${p.cardNumber}` : null,
  ]
    .filter(Boolean)
    .join(" ") || p.cardTitle || `Row ${env.rowNumber}`;

  const availableActions: Array<{ value: CommitAction; label: string }> = [
    { value: "commit", label: env.lane === "update" ? "Update" : "Add" },
    { value: "skip", label: "Skip" },
  ];
  if (env.lane === "update" || env.bucket === "collision") {
    availableActions.push({ value: "add-as-copy", label: "Add as copy" });
    availableActions.push({ value: "update-cost", label: "Update cost only" });
  }

  return (
    <div className="hiq-card p-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
              style={{
                background: `color-mix(in oklab, ${bucketColor} 15%, transparent)`,
                color: bucketColor,
              }}
            >
              {env.bucket}
            </span>
            <span className="text-xs text-[color:var(--color-muted)]">Row {env.rowNumber}</span>
            {env.lane === "update" && (
              <span className="text-xs text-[color:var(--color-muted)]">→ update existing</span>
            )}
          </div>
          <div className="font-medium text-sm mt-1 truncate">{title}</div>
          <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
            {p.gradeCompany && p.gradeValue != null && (
              <span>{p.gradeCompany} {p.gradeValue}</span>
            )}
            {p.quantity != null && p.quantity > 1 && <span>qty {p.quantity}</span>}
            {p.purchasePrice != null && (
              <span>paid {formatUSD(p.purchasePrice, { hideCents: p.purchasePrice >= 100 })}</span>
            )}
          </div>
          {env.message && (
            <div className="text-xs mt-2 text-[color:var(--color-muted)] leading-snug">
              {env.message}
            </div>
          )}
          {env.parseFlags.length > 0 && (
            <div className="text-xs mt-1" style={{ color: "var(--color-accent)" }}>
              {env.parseFlags.map((f) => `${f.column}: ${f.reason}`).join(" · ")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {availableActions.map((a) => (
            <button
              key={a.value}
              onClick={() => onActionChange(a.value)}
              className="px-2.5 py-1 rounded text-xs font-medium"
              style={{
                background: action === a.value ? "var(--color-accent)" : "transparent",
                color: action === a.value ? "var(--color-bg)" : "var(--color-muted)",
                border: `1px solid ${action === a.value ? "var(--color-accent)" : "var(--color-border)"}`,
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function bucketColorOf(b: ImportBucket): string {
  switch (b) {
    case "clean": return "var(--color-success)";
    case "collision": return "var(--color-accent)";
    case "ambiguous": return "var(--color-accent)";
    case "unresolved": return "var(--color-danger)";
    case "identity-edited": return "var(--color-accent)";
  }
}
