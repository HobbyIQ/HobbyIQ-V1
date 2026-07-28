"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  fetchSessionUser,
  fetchEntitlements,
  setUsername,
  checkUsernameAvailable,
  deleteAccount,
  signOut,
  createStripePortalSession,
  changePassword,
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

      {/* Account — email, user id, editable username, sign out. Username
          used to be its own tile below Subscription; consolidated here
          2026-07-27 so identity fields live in one card. */}
      <section className="hiq-card p-6">
        <h2 className="font-bold text-lg mb-4">Account</h2>
        <ReadonlyField label="Email" value={user.email} />
        <ReadonlyField label="User ID" value={user.userId} />
        <UsernameField currentUsername={user.username ?? null} />
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

      {/* CF-UX-CLEANUP (Drew, 2026-07-27): Email verification moved
          exclusively to /app/storefront where the send-verification
          button is inline with the storefront enable prerequisite.
          Prior duplicate section removed to eliminate the two-places-
          to-flip-the-same-flag pattern. Users who verified via a
          welcome email still see their verified state in the row chip
          and on /app/storefront. */}

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
        {user.stripeSubscriptionStatus && user.stripeSubscriptionStatus !== "canceled" && (
          <ReadonlyField label="Subscription status" value={user.stripeSubscriptionStatus} />
        )}
        {isOwnerOverride && (
          <p className="mt-4 text-xs text-[color:var(--color-muted)] leading-relaxed">
            Owner override active — your effective tier is set server-side and won&apos;t be
            affected by App Store or Stripe subscription changes.
          </p>
        )}
        <div className="mt-4 pt-4 border-t border-[color:var(--color-border)] flex items-center gap-3 flex-wrap">
          {user.stripeCustomerId ? (
            <ManageSubscriptionButton />
          ) : (
            <Link href="/pricing" className="hiq-btn-primary text-sm">
              Upgrade
            </Link>
          )}
        </div>
      </section>

      {/* CF-UX-CLEANUP (Drew, 2026-07-27): Public storefront controls
          moved exclusively to /app/storefront — includes visibility
          toggle, per-card picker with tier cap, and the send-verify
          button. Prior PublicShareSection removed. Nav has a
          Storefront entry so the surface is one click away. */}

      {/* Password */}
      <PasswordSection />


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

type CheckStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken"; reason: string }
  | { kind: "invalid"; reason: string };

// CF-UX-CLEANUP (Drew, 2026-07-27): EmailVerificationSection deleted —
// the equivalent UnverifiedBanner in /app/storefront is the sole owner
// of the send-verification button now.

// UsernameField (was UsernameSection prior to 2026-07-27): renders inline
// inside the Account tile, no card wrapper of its own. Everything else —
// debounced availability probe, reserved-name pill, disable-Save gating —
// is unchanged.
function UsernameField({ currentUsername }: { currentUsername: string | null }) {
  const [value, setValue] = useState(currentUsername ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<CheckStatus>({ kind: "idle" });

  const trimmed = value.trim();
  const isSelf = trimmed === (currentUsername ?? "").trim();

  // CF-RESERVED-USERNAMES: debounced availability probe. Only fires
  // when the input has diverged from the currently-held name so we're
  // not spamming the endpoint on every keystroke or checking the user's
  // own handle. Reserved-name gate is enforced server-side; this just
  // surfaces the verdict.
  useEffect(() => {
    if (!trimmed || isSelf) {
      setCheck({ kind: "idle" });
      return;
    }
    setCheck({ kind: "checking" });
    const handle = setTimeout(async () => {
      try {
        const res = await checkUsernameAvailable(trimmed);
        if (res.available) {
          setCheck({ kind: "available" });
        } else {
          // Distinguish format failures from taken so the pill copy is
          // accurate.
          if (res.reason && /3-30|letters|numbers/i.test(res.reason)) {
            setCheck({ kind: "invalid", reason: res.reason });
          } else {
            setCheck({ kind: "taken", reason: res.reason ?? "Username already taken" });
          }
        }
      } catch {
        // Network failure — leave the pill idle. Submit will still hit
        // the change endpoint and show the server's verdict.
        setCheck({ kind: "idle" });
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [trimmed, isSelf]);

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

  const canSubmit =
    !saving &&
    trimmed.length > 0 &&
    !isSelf &&
    (check.kind === "available" || check.kind === "idle");

  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        Username
      </div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
              setError(null);
            }}
            placeholder="pick a handle"
            className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{
              background: "var(--color-bg)",
              borderColor:
                check.kind === "available"
                  ? "var(--hiq-hobby-green)"
                  : check.kind === "taken" || check.kind === "invalid"
                  ? "var(--hiq-danger)"
                  : "var(--color-border)",
              color: "white",
            }}
          />
          <CheckPill status={check} />
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className="hiq-btn-primary text-sm px-4 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {(check.kind === "taken" || check.kind === "invalid") && !error && !saved && (
        <div className="mt-2 text-xs" style={{ color: "var(--hiq-danger)" }}>
          {check.reason}
        </div>
      )}
      {check.kind === "available" && !error && !saved && (
        <div className="mt-2 text-xs" style={{ color: "var(--hiq-hobby-green)" }}>
          Available — click Save to claim it.
        </div>
      )}
      {error && (
        <div className="mt-2 text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-2 text-xs" style={{ color: "var(--color-success)" }}>
          Username updated.
        </div>
      )}
    </div>
  );
}

function CheckPill({ status }: { status: CheckStatus }) {
  if (status.kind === "idle") return null;
  const color =
    status.kind === "available"
      ? "var(--hiq-hobby-green)"
      : status.kind === "checking"
      ? "var(--hiq-muted-text)"
      : "var(--hiq-danger)";
  const label =
    status.kind === "available"
      ? "Available"
      : status.kind === "checking"
      ? "Checking…"
      : status.kind === "taken"
      ? "Taken"
      : "Invalid";
  return (
    <span
      className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

function ManageSubscriptionButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await createStripePortalSession();
      if (res.success && res.url) {
        window.location.href = res.url;
        return;
      }
      setError(res.error ?? "Portal unavailable");
    } catch (err) {
      setError((err as { message?: string }).message ?? "Portal failed");
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <button
        onClick={onClick}
        disabled={loading}
        className="hiq-btn-primary text-sm disabled:opacity-60"
      >
        {loading ? "Loading…" : "Manage subscription"}
      </button>
      {error && (
        <span className="text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </span>
      )}
    </>
  );
}

// CF-UX-CLEANUP (Drew, 2026-07-27): PublicShareSection deleted — the
// full storefront editor at /app/storefront is the sole owner. Users
// reach it from the sidebar (Storefront entry) or from the storefront
// step in the onboarding checklist.

// CF-CHANGE-PASSWORD (Drew, 2026-07-27). Three-field form: current, new,
// confirm. Server verifies the current password; front end just checks
// new === confirm before submit to save a round-trip on the trivial typo.
// Apple-OAuth accounts see a "not available for Apple Sign-In" message
// surfaced from the backend if they somehow submit — this component
// doesn't hide itself for them since we don't know at render time.
function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit =
    !saving && current.length >= 1 && next.length >= 8 && next === confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await changePassword(current, next);
      if (res.success) {
        setSaved(true);
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        setError(res.error ?? "Password change failed");
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) setError(e.message ?? "Current password is incorrect");
      else setError(e.message ?? "Password change failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="hiq-card p-6">
      <h2 className="font-bold text-lg mb-4">Password</h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <PasswordInput
          label="Current password"
          value={current}
          onChange={(v) => {
            setCurrent(v);
            setSaved(false);
            setError(null);
          }}
          autoComplete="current-password"
        />
        <PasswordInput
          label="New password"
          value={next}
          onChange={(v) => {
            setNext(v);
            setSaved(false);
            setError(null);
          }}
          autoComplete="new-password"
          hint={next.length > 0 && next.length < 8 ? "At least 8 characters" : undefined}
        />
        <PasswordInput
          label="Confirm new password"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setSaved(false);
            setError(null);
          }}
          autoComplete="new-password"
          errorText={mismatch ? "Doesn't match new password" : undefined}
        />
        <div className="pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="hiq-btn-primary text-sm px-4 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
      {error && (
        <div className="mt-3 text-sm" style={{ color: "var(--hiq-danger)" }}>
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-3 text-sm" style={{ color: "var(--hiq-hobby-green)" }}>
          Password updated.
        </div>
      )}
    </section>
  );
}

function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  errorText,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  hint?: string;
  errorText?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        {label}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
        style={{
          background: "var(--color-bg)",
          borderColor: errorText ? "var(--hiq-danger)" : "var(--color-border)",
          color: "white",
        }}
      />
      {errorText && (
        <div className="mt-1 text-xs" style={{ color: "var(--hiq-danger)" }}>
          {errorText}
        </div>
      )}
      {!errorText && hint && (
        <div className="mt-1 text-xs" style={{ color: "var(--hiq-muted-text)" }}>
          {hint}
        </div>
      )}
    </div>
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
