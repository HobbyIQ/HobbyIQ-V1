// CF-WEB-GUIDE (2026-08-22). "How HobbyIQ works" — the teaching layer.
//
// THE GAP THIS FILLS. Onboarding was a setup CHECKLIST: verify email, link
// eBay, add a card, set an alert, enable storefront. Five account chores. A
// user could finish every one of them and still not know what BuyerIQ is,
// what the confidence number means, or why our FMV differs from every other
// card site — because nothing in the app ever explained it.
//
// Worse, the single most important idea in the product — FMV is the PROJECTED
// NEXT SALE, not a median — was written down only on the public /about
// marketing page. Prospects were taught it; actual users never were.
//
// So this page teaches three things, in the order a new user needs them:
//   1. CONCEPTS  — what the numbers mean and when we refuse to show one
//   2. SURFACES  — what each sidebar destination is for, one line each
//   3. JOBS      — "I want to X" → where to go
//
// Every line here is grounded in what the corresponding page actually does.
// Nothing on this page describes a feature that does not exist, and plan-gated
// surfaces say so rather than promising something a Free user cannot open.

"use client";

import Link from "next/link";
import { APP_NAV } from "@/lib/navigation";

interface Concept {
  term: string;
  short: string;
  body: string;
}

// Grounded in apps/web/src/app/(marketing)/about + pricing FAQ, which is where
// this was previously explained to prospects but never to signed-in users.
const CONCEPTS: Concept[] = [
  {
    term: "FMV is the projected next sale",
    short: "Not a median. Not an average.",
    body:
      "Most card sites show you the middle of recent sales. That tells you where the market WAS. " +
      "HobbyIQ reads the trend in the comp pool for that exact card and grade, then projects what " +
      "the next sale should land at. When a card is climbing, the median lags it; the projection does not.",
  },
  {
    term: "Confidence tells you how much to trust it",
    short: "Shown as a percentage on every price.",
    body:
      "A card with dozens of recent sales of the exact parallel and grade prices with high confidence. " +
      "A card we had to reach for — a sibling parallel, a neighbouring grade — prices lower. Use it as " +
      "a weight, not a gate: a confident $40 and a shaky $400 are different kinds of information.",
  },
  {
    term: "No data means no number",
    short: "We say so instead of guessing.",
    body:
      "If we have not observed real sales we can stand behind, the card shows as unpriced rather than " +
      "filled in with something invented. That is deliberate. A made-up number you trust is worse than " +
      "a blank you can see.",
  },
];

// One line per sidebar destination, in APP_NAV order so this reads in the same
// sequence as the sidebar the user is looking at. Sourced from each page's own
// copy — see the CF-WEB-GUIDE note above.
const SURFACES: Record<string, { what: string; note?: string }> = {
  "/app": {
    what: "Your morning briefing. Portfolio movement, market movement, and what needs attention today.",
  },
  "/app/search": {
    what: "Look up any card by player, set, cert number, or plain description. Click a result for the full pricing breakdown and grade ladder.",
  },
  "/app/portfolio": {
    what: "Everything you own, with current FMV, confidence, and the method behind each price. Add cards by hand, by cert, or by CSV import.",
  },
  "/app/buyeriq": {
    what: "Card-show buying checklists. Add targets, set your ceiling, tick them off as you find them on the floor.",
  },
  "/app/erp": {
    what: "The money view. Cost basis, realised and unrealised P&L, expenses, and what you need at tax time.",
  },
  "/app/storefront": {
    what: "Publish a public inventory page at hobby-iq.com/u/your-name and pick which cards appear on it.",
    note: "Investor lists up to 50 cards, Pro Seller up to 200.",
  },
  "/app/market": {
    what: "Top movers across the whole comp pool, sector trends, and market-wide signals.",
    note: "Investor and Pro Seller. Free and Collector see portfolio-scoped movers only.",
  },
  "/app/messages": {
    what: "Talk to other collectors directly — trades, questions, deals.",
  },
  "/app/alerts": {
    what: "Get notified the moment a card crosses a price you set. Create one from any card's page.",
  },
  "/app/ebay": {
    what: "Connect your seller account once. Draft listings straight from a holding, and let completed sales flow back into your cost basis automatically.",
  },
  "/app/settings": {
    what: "Account, plan, email verification, and your public storefront toggle.",
  },
};

interface Job {
  want: string;
  go: string;
  href: string;
  how: string;
}

const JOBS: Job[] = [
  {
    want: "What is this card worth?",
    go: "Search",
    href: "/app/search",
    how: "Type the player, or paste a cert number. The result page gives you FMV, confidence, the comps behind it, and the full grade ladder so you can see what it would be worth graded higher.",
  },
  {
    want: "Should I sell this one?",
    go: "Alerts",
    href: "/app/alerts",
    how: "Set a threshold on the cards you would sell at the right number, and stop checking manually. Insights carries the weekly brief and the sell-now radar alongside it.",
  },
  {
    want: "I am going to a card show",
    go: "BuyerIQ",
    href: "/app/buyeriq",
    how: "Build the list before you go, with your walk-away ceiling on each target. On the floor you are checking a list against a price you already decided, instead of doing maths at a table.",
  },
  {
    want: "What did I actually make this year?",
    go: "Financials",
    href: "/app/erp",
    how: "Realised P&L per sale, expenses, and unreconciled items you still need to account for.",
  },
];

function SectionHeading({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold"
        style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
      >
        {n}
      </div>
      <div className="min-w-0">
        <h2 className="text-xl font-bold leading-tight">{title}</h2>
        <p className="text-sm mt-0.5" style={{ color: "var(--color-muted)" }}>
          {sub}
        </p>
      </div>
    </div>
  );
}

export default function GuidePage() {
  // Drive the surface list from APP_NAV itself so this page cannot drift out of
  // step with the sidebar: a nav item that is removed disappears from the guide
  // automatically, with no second list to remember to update.
  //
  // The other direction is the dangerous one. Filtering to only-documented
  // items would mean a newly added destination is SILENTLY absent from the
  // guide — the page still builds, still looks complete, and simply never
  // mentions a feature. That is the same fail-silent shape as a checklist that
  // reports success while covering nothing, so this fails VISIBLY instead: an
  // undocumented surface renders with its name and link and an explicit note,
  // which is obvious to anyone who opens the page.
  //
  // The guide does not list itself.
  const surfaces = APP_NAV.filter((item) => item.href !== "/app/guide");

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-10">
      <header>
        <h1 className="text-3xl font-bold mb-2">How HobbyIQ works</h1>
        <p style={{ color: "var(--color-muted)" }}>
          Five minutes here will save you a lot of clicking around. Start with what the
          numbers mean — that part is genuinely different from other card sites.
        </p>
      </header>

      {/* ── 1. Concepts ─────────────────────────────────────────────── */}
      <section>
        <SectionHeading
          n={1}
          title="What the numbers mean"
          sub="The part worth reading properly."
        />
        <div className="space-y-3">
          {CONCEPTS.map((c) => (
            <div key={c.term} className="hiq-card p-5">
              <div className="flex items-baseline gap-2 flex-wrap mb-2">
                <h3 className="font-bold">{c.term}</h3>
                <span className="text-xs" style={{ color: "var(--color-accent)" }}>
                  {c.short}
                </span>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "var(--color-muted)" }}>
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 2. Surfaces ─────────────────────────────────────────────── */}
      <section>
        <SectionHeading
          n={2}
          title="What each page is for"
          sub="Same order as your sidebar."
        />
        <div className="hiq-card p-0 divide-y divide-[color:var(--color-border)]">
          {surfaces.map((item) => {
            const s = SURFACES[item.href] ?? {
              what: "This page is part of HobbyIQ but has not been written up here yet.",
              note: "Undocumented — add an entry to SURFACES in this file.",
            };
            return (
              <div key={item.href} className="p-4 flex items-start gap-3">
                <svg
                  viewBox="0 0 24 24"
                  className="w-5 h-5 flex-shrink-0 mt-0.5"
                  fill="var(--color-accent)"
                  aria-hidden="true"
                >
                  <path d={item.iconPath} />
                </svg>
                <div className="min-w-0 flex-1">
                  <Link href={item.href} className="font-semibold hover:underline">
                    {item.label}
                  </Link>
                  <p className="text-sm mt-1" style={{ color: "var(--color-muted)" }}>
                    {s.what}
                  </p>
                  {s.note && (
                    <p className="text-xs mt-1.5" style={{ color: "var(--color-warning)" }}>
                      {s.note}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 3. Jobs ─────────────────────────────────────────────────── */}
      <section>
        <SectionHeading
          n={3}
          title="I want to…"
          sub="The four things people actually open HobbyIQ to do."
        />
        <div className="space-y-3">
          {JOBS.map((j) => (
            <div key={j.want} className="hiq-card p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <h3 className="font-bold">{j.want}</h3>
                <Link href={j.href} className="hiq-btn-primary text-sm px-3 py-1.5">
                  {j.go} →
                </Link>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "var(--color-muted)" }}>
                {j.how}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer
        className="hiq-card p-5 flex items-center justify-between gap-3 flex-wrap"
        style={{ borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)" }}
      >
        <div className="min-w-0">
          <div className="font-semibold">Still setting up?</div>
          <p className="text-sm mt-0.5" style={{ color: "var(--color-muted)" }}>
            Your checklist tracks verification, eBay, your first card, and alerts.
          </p>
        </div>
        <Link href="/app/welcome" className="hiq-btn-secondary text-sm px-4">
          Open checklist
        </Link>
      </footer>
    </div>
  );
}
