"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  fetchSessionUser,
  fetchEntitlements,
  setUsername,
  deleteAccount,
  signOut,
  setPublicShareEnabled,
  type AuthUser,
  type EntitlementsMeResponse,
} from "@/lib/api";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  collector: "Collector",
  investor: "Investor",
  pro_seller: "Pro Seller",
};

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ent, setEnt] = useState<EntitlementsMeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSessionUser(), fetchEntitlements().catch(() => null)])
      .then(([u, e]) => {
        if (cancelled) return;
        setUser(u);
        setEnt(e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading settings…</div>
      </div>
    );
  }

  if (!user) {
    router.replace("/login");
    return null;
  }

  const effectivePlan = ent?.plan ?? user.plan ?? "free";
  const isOwnerOverride = ent?.entitlementOverride != null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-1">Settings</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Account, subscription, and identity.
        </p>
      </div>

      {/* Account */}
      <section className="hiq-card p-6">
        <h2 className="font-bold text-lg mb-4">Account</h2>
        <ReadonlyField label="Email" value={user.email} />
        <ReadonlyField label="User ID" value={user.userId} />
        <div className="mt-4 pt-4 border-t border-[color:var(--color-border)]">
          <button
            onClick={async () => {
              await signOut();
              router.push("/");
            }}
            className="text-sm font-medium hover:underline"
            style={{ color: "var(--color-danger)" }}
          >
            Sign out
          </button>
        </div>
      </section>

      {/* Subscription */}
      <section className="hiq-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg">Subscription</h2>
          {isOwnerOverride && (
            <span
              className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              Owner comp
            </span>
          )}
        </div>
        <ReadonlyField label="Current plan" value={PLAN_LABEL[effectivePlan] ?? effectivePlan} />
        {isOwnerOverride && (
          <p className="mt-4 text-xs text-[color:var(--color-muted)] leading-relaxed">
            Owner override active — your effective tier is set server-side and won&apos;t be
            affected by App Store or Stripe subscription changes.
          </p>
        )}
      </section>

      {/* Username */}
      <UsernameSection currentUsername={user.username ?? null} />

      {/* Public storefront — Pro Seller only */}
      {effectivePlan === "pro_seller" && user.username && (
        <PublicShareSection
          initialEnabled={user.publicShareEnabled ?? false}
          username={user.username}
        />
      )}

      {/* Password */}
      <section className="hiq-card p-6">
        <h2 className="font-bold text-lg mb-4">Password</h2>
        <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
          Password change via the web isn&apos;t wired up yet — coming in the next sprint.
          Contact{" "}
          <a
            href="mailto:drew@justtheboysandcards.com"
            className="hover:underline"
            style={{ color: "var(--color-accent)" }}
          >
            drew@justtheboysandcards.com
          </a>{" "}
          for a manual reset in the meantime.
        </p>
      </section>

      {/* Danger zone */}
      <DangerZone />
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        {label}
      </div>
      <div className="text-sm font-medium break-all">{value}</div>
    </div>
  );
}

function UsernameSection({ currentUsername }: { currentUsername: string | null }) {
  const [value, setValue] = useState(currentUsername ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await setUsername(v);
      if (res.success) {
        setSaved(true);
      } else {
        setError(res.error ?? "Failed to update username");
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409) setError("That username is already taken.");
      else if (e.status === 400) setError(e.message ?? "Invalid username format.");
      else setError(e.message ?? "Failed to update username");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="hiq-card p-6">
      <h2 className="font-bold text-lg mb-4">Username</h2>
      <form onSubmit={onSubmit} className="flex gap-3">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
            setError(null);
          }}
          placeholder="pick a handle"
          className="flex-1 px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
        />
        <button
          type="submit"
          disabled={saving || value.trim() === currentUsername || !value.trim()}
          className="hiq-btn-primary disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {error && (
        <div className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-3 text-sm" style={{ color: "var(--color-success)" }}>
          Username updated.
        </div>
      )}
    </section>
  );
}

function PublicShareSection({
  initialEnabled,
  username,
}: {
  initialEnabled: boolean;
  username: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onToggle() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const res = await setPublicShareEnabled(next);
      setEnabled(res.publicShareEnabled);
    } catch (err) {
      setError((err as { message?: string }).message ?? "Failed to update");
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  const storefrontUrl = `/u/${encodeURIComponent(username)}`;

  return (
    <section className="hiq-card p-6">
      <h2 className="font-bold text-lg mb-2">Public storefront</h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
        Share your inventory publicly at{" "}
        <span className="text-white font-medium">hobby-iq.com/u/{username}</span>.
        Cards show with photos, grades, and HobbyIQ market values. Cost basis,
        gain/loss, and personal info stay private.
      </p>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggle}
            disabled={saving}
            role="switch"
            aria-checked={enabled}
            className="relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50"
            style={{
              background: enabled ? "var(--color-accent)" : "var(--color-border)",
            }}
          >
            <span
              className="absolute top-0.5 h-5 w-5 rounded-full transition-transform"
              style={{
                background: enabled ? "var(--color-bg)" : "var(--color-muted)",
                transform: enabled ? "translateX(18px)" : "translateX(2px)",
              }}
            />
          </button>
          <span className="text-sm font-medium">
            {enabled ? "Storefront is live" : "Storefront is off"}
          </span>
        </div>

        {enabled && (
          <Link
            href={storefrontUrl}
            target="_blank"
            className="hiq-btn-secondary text-sm"
          >
            Open storefront ↗
          </Link>
        )}
      </div>

      {error && (
        <div className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </section>
  );
}

function DangerZone() {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText === "DELETE";

  async function onDelete() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      await signOut();
      router.push("/");
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <section
      className="hiq-card p-6 border"
      style={{ borderColor: "color-mix(in oklab, var(--color-danger) 30%, transparent)" }}
    >
      <h2 className="font-bold text-lg mb-2" style={{ color: "var(--color-danger)" }}>
        Danger zone
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
        Delete your account, all holdings, and all associated data. Type{" "}
        <span className="font-mono font-bold" style={{ color: "var(--color-danger)" }}>DELETE</span>{" "}
        below to enable the button. Cannot be undone.
      </p>
      <div className="flex gap-3">
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder='Type "DELETE" to confirm'
          className="flex-1 px-4 py-2.5 rounded-xl border text-sm outline-none"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
        />
        <button
          onClick={onDelete}
          disabled={!canDelete || deleting}
          className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-30 transition-colors"
          style={{
            background: "var(--color-danger)",
            color: "white",
          }}
        >
          {deleting ? "Deleting…" : "Delete account"}
        </button>
      </div>
      {error && (
        <div className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </section>
  );
}
