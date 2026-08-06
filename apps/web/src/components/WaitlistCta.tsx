"use client";

// CF-WAITLIST (Drew, 2026-08-06). Homepage signup CTA. Inline email
// field with a submit button and a small success / duplicate / error
// state. POSTs to /api/waitlist/join.

import { useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

type Status = "idle" | "loading" | "joined" | "already" | "error";

export function WaitlistCta({ source = "homepage" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (status === "loading") return;
    const trimmed = email.trim();
    if (!trimmed) {
      setStatus("error");
      setMessage("Please enter an email address.");
      return;
    }
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/waitlist/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        alreadyOnList?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setStatus("error");
        setMessage(body.error ?? "Something went wrong. Try again in a moment.");
        return;
      }
      if (body.alreadyOnList) {
        setStatus("already");
        setMessage("You're already on the list — thanks!");
      } else {
        setStatus("joined");
        setMessage("You're on the list. Check your inbox for a confirmation.");
      }
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Network hiccup. Try again in a moment.");
    }
  }

  return (
    <div className="w-full max-w-xl mx-auto">
      <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-2 items-stretch">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 px-4 py-3 rounded-lg border outline-none text-base"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "var(--color-text)",
          }}
          aria-label="Email address"
          disabled={status === "loading"}
        />
        <button
          type="submit"
          className="hiq-btn-primary whitespace-nowrap"
          disabled={status === "loading"}
        >
          {status === "loading" ? "Joining…" : "Join waitlist"}
        </button>
      </form>
      {message && (
        <div
          className="mt-3 text-sm text-center"
          style={{
            color:
              status === "error"
                ? "var(--color-danger)"
                : status === "joined" || status === "already"
                  ? "var(--color-accent)"
                  : "var(--color-muted)",
          }}
          role="status"
        >
          {message}
        </div>
      )}
    </div>
  );
}
