"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { signIn, signUp } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const isSignup = params.get("signup") === "true";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (isSignup) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
      router.push("/app");
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="hiq-card p-8">
      <h1 className="text-3xl font-bold mb-2">
        {isSignup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="text-sm text-[color:var(--color-muted)] mb-8">
        {isSignup
          ? "Start with the free tier. Upgrade anytime."
          : "Sign in to your HobbyIQ portfolio."}
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium mb-2">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border text-white outline-none focus:border-[color:var(--color-accent)] transition-colors"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
            }}
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium mb-2">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border text-white outline-none focus:border-[color:var(--color-accent)] transition-colors"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
            }}
          />
        </div>

        {error && (
          <div
            className="text-sm p-3 rounded-lg"
            style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--color-danger)" }}
          >
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className="hiq-btn-primary w-full disabled:opacity-60">
          {loading ? (isSignup ? "Creating…" : "Signing in…") : isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-[color:var(--color-muted)]">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-[color:var(--color-accent)] hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to HobbyIQ?{" "}
            <Link
              href="/login?signup=true"
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Create an account
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="hiq-glow-top flex-1 w-full flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors block mb-8"
        >
          ← Back to home
        </Link>

        <Suspense
          fallback={
            <div className="hiq-card p-8 text-sm text-[color:var(--color-muted)]">
              Loading…
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
