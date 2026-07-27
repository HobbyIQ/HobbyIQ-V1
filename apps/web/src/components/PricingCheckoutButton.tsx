"use client";

import { useState } from "react";
import { createStripeCheckoutSession } from "@/lib/api";

interface Props {
  plan: "collector" | "investor" | "pro_seller";
  label: string;
  featured?: boolean;
}

// Kicks off a Stripe Checkout Session for the given plan. If the user
// isn't authenticated, request() throws — we catch it and route to the
// sign-in page carrying the plan as a return-hint so the user lands
// back here after login. The Stripe key can also be absent server-side
// (503) — we surface that as a friendly "coming soon" note rather than
// blowing up.
export function PricingCheckoutButton({ plan, label, featured }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await createStripeCheckoutSession(plan);
      if (res.success && res.url) {
        window.location.href = res.url;
        return;
      }
      setError(res.error ?? "Checkout unavailable");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) {
        // Not signed in — route to signup carrying the plan choice
        window.location.href = `/login?signup=true&plan=${encodeURIComponent(plan)}`;
        return;
      }
      if (e.status === 503) {
        setError("Web checkout is warming up — try again in a moment.");
      } else {
        setError(e.message ?? "Checkout failed");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className={`w-full text-center ${featured ? "hiq-btn-primary" : "hiq-btn-secondary"} disabled:opacity-60`}
      >
        {loading ? "Loading…" : label}
      </button>
      {error && (
        <div className="mt-2 text-xs text-center" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
