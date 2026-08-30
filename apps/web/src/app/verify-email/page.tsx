"use client";

// CF-EMAIL-VERIFICATION (Drew, 2026-07-27). Landing page that the link
// in the verification email points at. Redeems `?token=<t>` against the
// backend and shows a branded success / failure UI. No auth required —
// the token itself is the auth for this one-shot flow.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { verifyEmailToken } from "@/lib/api";

type Status =
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

function VerifyEmailBody() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status>({ kind: "verifying" });

  useEffect(() => {
    const token = params?.get("token")?.trim() ?? "";
    if (!token) {
      setStatus({ kind: "missing" });
      return;
    }
    verifyEmailToken(token)
      .then((res) => {
        if (res.success) {
          setStatus({ kind: "success" });
        } else {
          setStatus({
            kind: "invalid",
            reason: res.error ?? "Invalid or expired link",
          });
        }
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Something went wrong";
        setStatus({ kind: "invalid", reason: msg });
      });
  }, [params]);

  return (
    <main
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="hiq-card p-8 max-w-md w-full text-center">
        {status.kind === "verifying" && (
          <>
            <h1 className="text-xl font-bold mb-2">Verifying your email…</h1>
            <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
              Give us a moment.
            </p>
          </>
        )}
        {status.kind === "success" && (
          <>
            <div
              className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center text-2xl font-bold"
              style={{
                background: "color-mix(in oklab, var(--hiq-hobby-green) 18%, transparent)",
                color: "var(--hiq-hobby-green)",
              }}
            >
              ✓
            </div>
            <h1 className="text-xl font-bold mb-2">Email verified</h1>
            <p
              className="text-sm mb-6"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              Thanks — your address is confirmed. A few quick steps and
              you&apos;re fully set up.
            </p>
            {/* CF-ONBOARDING: land on /app/welcome so the user immediately
                sees the checklist (link eBay, add first card, etc.) rather
                than an empty dashboard. */}
            <button
              onClick={() => router.push("/app/welcome?verified=1")}
              className="hiq-btn-primary"
            >
              Continue setup
            </button>
          </>
        )}
        {status.kind === "missing" && (
          <>
            <h1 className="text-xl font-bold mb-2">No token</h1>
            <p
              className="text-sm mb-6"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              This page needs a verification link with a token. Open the link
              from your email or request a new one from Settings.
            </p>
            <Link href="/app/settings" className="hiq-btn-primary">
              Go to Settings
            </Link>
          </>
        )}
        {status.kind === "invalid" && (
          <>
            <div
              className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center text-2xl font-bold"
              style={{
                background: "color-mix(in oklab, var(--hiq-danger) 18%, transparent)",
                color: "var(--hiq-danger)",
              }}
            >
              !
            </div>
            <h1 className="text-xl font-bold mb-2">Link expired</h1>
            <p
              className="text-sm mb-6"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              {status.reason}. Verification links are single-use and expire
              after 24 hours — request a fresh one from Settings.
            </p>
            <Link href="/app/settings" className="hiq-btn-primary">
              Request a new link
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailBody />
    </Suspense>
  );
}
