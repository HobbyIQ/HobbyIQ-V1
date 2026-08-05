// CF-REGISTER-URL (Drew, 2026-08-05).
//
// Signup was previously only reachable via /login?signup=true — an
// awkward URL for marketing CTAs, direct links, ads, and bookmarks.
// This route is the canonical /register URL that forwards into the
// same login-page component in signup mode. Query params like ?plan=
// are preserved (PricingCheckoutButton uses that).
//
// The signup form itself still lives in /login/page.tsx (branches on
// searchParams.signup) — one form, one code path, two front doors.

import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RegisterPage({ searchParams }: Props) {
  const params = await searchParams;
  const forward = new URLSearchParams();
  forward.set("signup", "true");
  for (const [key, value] of Object.entries(params)) {
    if (key === "signup") continue;
    if (Array.isArray(value)) {
      for (const v of value) forward.append(key, v);
    } else if (value !== undefined) {
      forward.set(key, value);
    }
  }
  redirect(`/login?${forward.toString()}`);
}
