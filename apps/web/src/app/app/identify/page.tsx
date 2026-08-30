"use client";

// D20 — the web says what the engine says (2026-08-30).
//
// This page used to upload a photo to blob storage and POST its URL to
// /api/portfolio/identify — a route that has never existed on the backend
// (CF-CARD-IDENTIFY web parity, 2026-08-05, mirrored the iOS flow's field
// names, not a handler). Every scan uploaded, then 404'd. The dead call is
// gone from lib/api.ts; this page says what is true and points at the
// surfaces that work. No backend route is invented here — when a
// photo-identification service exists, this page gets its call back.

import Link from "next/link";

export default function IdentifyPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Identify a card</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Photo identification is not available on the web yet.
        </p>
      </header>

      <div className="hiq-card p-6 space-y-4">
        <p className="text-sm">
          There is no photo-identification service behind this page today, so an
          image uploaded here cannot be matched to a card. Until there is one, find
          the card by its details:
        </p>
        <ul className="text-sm space-y-2 list-disc pl-5">
          <li>
            <Link
              href="/app/search"
              className="font-medium hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              Search
            </Link>
            {" "}by player, year, set and card number — results come from the HobbyIQ catalog.
          </li>
          <li>
            <Link
              href="/app/portfolio?add=1"
              className="font-medium hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              Add a card
            </Link>
            {" "}to your portfolio and pick the exact card from the catalog there.
          </li>
        </ul>
        <div className="flex gap-2 flex-wrap pt-2">
          <Link href="/app/search" className="hiq-btn-primary text-sm">
            Go to search
          </Link>
          <Link href="/app/portfolio?add=1" className="hiq-btn-secondary text-sm">
            Add a card
          </Link>
        </div>
      </div>
    </div>
  );
}
