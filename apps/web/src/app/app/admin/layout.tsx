"use client";

// CF-ADMIN-LAYOUT (Drew, 2026-07-28). Wraps every /app/admin/* page
// in a lightweight admin-token gate. If the user hasn't stored an
// ADMIN_API_TOKEN yet, prompt for it. Once set, the shared adminApi
// helpers pull it from localStorage on every request.

import { useEffect, useState, type ReactNode } from "react";
import { clearStoredAdminToken, getStoredAdminToken, setStoredAdminToken } from "@/lib/adminApi";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");

  useEffect(() => {
    const stored = getStoredAdminToken();
    if (!stored) {
      setNeedsToken(true);
    }
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="p-8 text-sm text-[color:var(--color-text-muted)]">Loading admin…</div>;
  }

  if (needsToken) {
    return (
      <div className="p-8 max-w-md">
        <h2 className="text-lg font-semibold mb-2">Admin token required</h2>
        <p className="text-sm text-[color:var(--color-text-muted)] mb-4">
          Paste the value of <code className="text-xs px-1 py-0.5 rounded bg-[color:var(--color-surface-2)]">ADMIN_API_TOKEN</code> from
          Azure App Service application settings. Stored in this browser only.
        </p>
        <input
          type="password"
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 mb-3"
          placeholder="ADMIN_API_TOKEN"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        <button
          type="button"
          className="w-full rounded bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] px-3 py-2 font-medium disabled:opacity-50"
          disabled={!tokenInput.trim()}
          onClick={() => {
            setStoredAdminToken(tokenInput.trim());
            setNeedsToken(false);
          }}
        >
          Use this token
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <a href="/app/admin/cleanliness" className="hover:underline">Cleanliness</a>
          <a href="/app/admin/data-quality" className="hover:underline">Data quality</a>
          <a href="/app/admin/verify" className="hover:underline">Verify queue</a>
          <a href="/app/admin/labeler" className="hover:underline">Variant labeler</a>
        </div>
        <button
          type="button"
          className="text-xs text-[color:var(--color-text-muted)] hover:underline"
          onClick={() => {
            clearStoredAdminToken();
            setNeedsToken(true);
          }}
        >
          Clear admin token
        </button>
      </div>
      {children}
    </div>
  );
}
