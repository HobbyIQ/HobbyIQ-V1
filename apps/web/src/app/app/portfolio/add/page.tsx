"use client";

// CF-UX-CLEANUP #4 (Drew, 2026-07-27). The Add-a-card flow moved into
// the AddCardModal (opens over the Portfolio page). This route is kept
// as a redirect so bookmarks, iOS deep links, and the onboarding
// checklist step "Add your first card" all still land on the correct
// UX — the modal auto-opens when the target page reads ?add=1.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function AddCardRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/app/portfolio?add=1");
  }, [router]);
  return (
    <div className="max-w-3xl mx-auto px-6 py-16 text-center">
      <div className="text-sm text-[color:var(--color-muted)]">Opening Add card…</div>
    </div>
  );
}
