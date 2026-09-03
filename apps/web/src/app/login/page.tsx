"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { signIn, signUp } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const isSignup = params?.get("signup") === "true";
  // CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Prefill invite from URL
  // (?invite=CODE) so shared "join HobbyIQ" links land the code in the
  // form automatically. User can still edit if wrong / paste-corrupted.
  const inviteFromUrl = params?.get("invite") ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(inviteFromUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CF-TERMS-ACCEPTANCE: starts false — consent must be an affirmative act.
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (isSignup) {
        // Belt-and-braces: the button is disabled without consent, but a
        // form can still be submitted by keyboard or devtools.
        if (!acceptedTerms) {
          setError("Please accept the Terms and Conditions to create an account.");
          return;
        }
        await signUp(email, password, inviteCode, true);
        // CF-FIRST-RUN (Drew, 2026-09-02). A brand-new account goes
        // straight into the guided funnel rather than to an empty
        // dashboard — the fastest path from signup to a valued card.
        // Sign-IN still lands on /app: a returning user is never routed
        // into onboarding, and /app/start itself bounces anyone whose
        // funnel is done or skipped, so this cannot trap a repeat visitor.
        router.push("/app/start");
        return;
      }
      await signIn(email, password);
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

        {/* CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Invite code field
            for signup path only. Value prefills from ?invite= URL param
            for share-link flows. Required-ness enforced server-side
            (allows the field to still submit if invites are turned
            off; server just ignores an unused value). */}
        {isSignup && (
          <div>
            <label htmlFor="invite" className="block text-sm font-medium mb-2">
              Invite code
            </label>
            <input
              id="invite"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="HOBBYIQ-XXXXXX"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              className="w-full px-4 py-3 rounded-xl border text-white outline-none focus:border-[color:var(--color-accent)] transition-colors font-mono tracking-wider"
              style={{
                background: "var(--color-bg)",
                borderColor: "var(--color-border)",
              }}
            />
            <p className="text-xs text-[color:var(--color-muted)] mt-2">
              HobbyIQ is invite-only right now. Ask Drew for a code, or use the link from your invite email.
            </p>
          </div>
        )}

        {/* CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Explicit, unchecked-by-
            default consent on the signup path. Unchecked-by-default matters:
            a pre-ticked box is not affirmative assent, and §20 of the Terms
            binds the user to arbitration and a class action waiver. The
            submit button stays disabled until it's ticked, so the account
            cannot be created without the agreement on record. */}
        {isSignup && (
          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--color-accent)] cursor-pointer"
            />
            <span className="text-[color:var(--color-muted)] leading-relaxed">
              I agree to the{" "}
              <Link
                href="/terms"
                target="_blank"
                className="text-[color:var(--color-accent)] hover:underline"
              >
                Terms and Conditions
              </Link>{" "}
              and{" "}
              <Link
                href="/privacy"
                target="_blank"
                className="text-[color:var(--color-accent)] hover:underline"
              >
                Privacy Policy
              </Link>
              . The Terms include a binding arbitration provision and class
              action waiver.
            </span>
          </label>
        )}

        {error && (
          <div
            className="text-sm p-3 rounded-lg"
            style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--color-danger)" }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || (isSignup && !acceptedTerms)}
          className="hiq-btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed"
        >
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
              href="/register"
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
