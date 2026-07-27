// Session-scoped hand-off from search results → the card detail page.
// Search stashes the last-clicked SearchCandidate; the detail page
// reads it on mount so the header + parallels selector have real data
// (title, player, parallels[]). If the URL is arrived at fresh
// (bookmark / share), sessionStorage is empty and the page falls back
// to what price-by-id gives us.

import type { SearchCandidate } from "@/lib/api";

const CANDIDATE_STASH_KEY = "hobbyiq_last_candidate";

export function stashCandidate(c: SearchCandidate): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CANDIDATE_STASH_KEY, JSON.stringify(c));
  } catch {
    // sessionStorage full or blocked — non-fatal, page falls back
  }
}

export function readStashedCandidate(cardsightCardId: string): SearchCandidate | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CANDIDATE_STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SearchCandidate;
    const idFromStash = parsed.candidateId.replace(/^cardsight:/, "");
    if (idFromStash !== cardsightCardId) return null;
    return parsed;
  } catch {
    return null;
  }
}
