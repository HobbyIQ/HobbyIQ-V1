"use client";

// CF-ADD-CARD-DEDICATED-PAGE (Drew, 2026-08-10). Was a redirect to
// /app/portfolio?add=1, but users reported the button doing nothing
// (likely a React state / hydration issue on the main portfolio
// page). This page now renders AddCardModal in its own isolated
// tree — bypasses whatever might be broken on the portfolio index.
// After add, navigate to /app/portfolio to see the new card.
//
// Onboarding checklist + iOS deep links + the "+ Add card" button's
// href fallback all point here, so any broken client-side path
// eventually hard-navigates to a page that works.

import { useRouter } from "next/navigation";
import { AddCardModal } from "@/components/AddCardModal";

export default function AddCardPage() {
  const router = useRouter();
  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <AddCardModal
        onClose={() => router.push("/app/portfolio")}
        onAdded={() => router.push("/app/portfolio")}
      />
    </div>
  );
}
