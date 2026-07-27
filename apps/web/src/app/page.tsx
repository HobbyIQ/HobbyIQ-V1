import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="hiq-glow-top flex-1 w-full">
      {/* Top nav */}
      <nav className="flex items-center justify-between w-full max-w-7xl mx-auto px-6 py-6">
        <div className="flex items-center gap-2 font-bold tracking-tight text-xl">
          <span className="hiq-hero-stroke text-transparent bg-clip-text">HobbyIQ</span>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-[color:var(--color-muted)] hover:text-white transition-colors text-sm"
          >
            Sign in
          </Link>
          <Link href="/login?signup=true" className="hiq-btn-primary text-sm">
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-24 text-center">
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight leading-tight">
          The pricing icon of the{" "}
          <span className="hiq-hero-stroke text-transparent bg-clip-text">
            trading card industry
          </span>
        </h1>
        <p className="mt-6 text-lg md:text-xl text-[color:var(--color-muted)] max-w-2xl mx-auto leading-relaxed">
          Empirical fair-market value for every card in every grade, sport, and era. Real
          sell/hold/list intel — not guesses. Built for collectors and pro sellers.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link href="/login?signup=true" className="hiq-btn-primary">
            Start free
          </Link>
          <Link href="#pricing" className="hiq-btn-secondary">
            See pricing
          </Link>
        </div>
      </section>

      {/* Feature triptych */}
      <section className="max-w-6xl mx-auto px-6 pb-24 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="hiq-card p-6">
          <h3 className="font-bold text-lg mb-2">Empirical FMV</h3>
          <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
            Every price rung sourced from real transactions across CardHedge, Cardsight, eBay,
            and our verified user comps. No hand-tuned matrix, no guesses.
          </p>
        </div>
        <div className="hiq-card p-6">
          <h3 className="font-bold text-lg mb-2">Actionable intel</h3>
          <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
            Sell-now radar. Sub-raw prospect detection. Grade-worthy alerts. Cards you own,
            timed windows you can act on.
          </p>
        </div>
        <div className="hiq-card p-6">
          <h3 className="font-bold text-lg mb-2">Full grade ladder</h3>
          <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
            PSA 1-10, BGS, SGC, CGC — all tiers where real sales exist. Vintage low-grade
            included. No wrong numbers when the data isn&apos;t there.
          </p>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-6 pb-24">
        <h2 className="text-3xl font-bold text-center mb-2">Simple, transparent pricing</h2>
        <p className="text-center text-[color:var(--color-muted)] mb-12">
          Cancel anytime. All plans include multi-sport coverage (baseball, basketball, football, Pokemon).
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="hiq-card p-8 flex flex-col">
            <h3 className="font-bold text-xl mb-1">Collector</h3>
            <p className="text-sm text-[color:var(--color-muted)] mb-6">
              Casual collectors tracking a personal portfolio.
            </p>
            <div className="mb-6">
              <span className="text-4xl font-bold">$12.99</span>
              <span className="text-[color:var(--color-muted)]">/mo</span>
            </div>
            <ul className="text-sm space-y-2 mb-8 text-[color:var(--color-muted)]">
              <li>✓ Full FMV on every card</li>
              <li>✓ Portfolio tracking</li>
              <li>✓ Daily market movers</li>
              <li>✓ Multi-sport + Pokemon</li>
            </ul>
            <Link href="/login?signup=true&plan=collector" className="hiq-btn-secondary text-center">
              Choose Collector
            </Link>
          </div>

          <div
            className="hiq-card p-8 flex flex-col relative"
            style={{ borderColor: "var(--color-accent)" }}
          >
            <div
              className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full"
              style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
            >
              MOST POPULAR
            </div>
            <h3 className="font-bold text-xl mb-1">Investor</h3>
            <p className="text-sm text-[color:var(--color-muted)] mb-6">
              For active traders — timed sell/hold/list signals.
            </p>
            <div className="mb-6">
              <span className="text-4xl font-bold">$24.99</span>
              <span className="text-[color:var(--color-muted)]">/mo</span>
            </div>
            <ul className="text-sm space-y-2 mb-8 text-[color:var(--color-muted)]">
              <li>✓ Everything in Collector</li>
              <li>✓ Actionable sell/hold/list</li>
              <li>✓ Sub-raw prospect detection</li>
              <li>✓ Extended market intelligence</li>
            </ul>
            <Link href="/login?signup=true&plan=investor" className="hiq-btn-primary text-center">
              Choose Investor
            </Link>
          </div>

          <div className="hiq-card p-8 flex flex-col">
            <h3 className="font-bold text-xl mb-1">Pro Seller</h3>
            <p className="text-sm text-[color:var(--color-muted)] mb-6">
              Built for pros — bulk workflows, priority intel.
            </p>
            <div className="mb-6">
              <span className="text-4xl font-bold">$49.99</span>
              <span className="text-[color:var(--color-muted)]">/mo</span>
            </div>
            <ul className="text-sm space-y-2 mb-8 text-[color:var(--color-muted)]">
              <li>✓ Everything in Investor</li>
              <li>✓ Bulk inventory (CSV, spreadsheet)</li>
              <li>✓ Priority sell radar</li>
              <li>✓ Notable-sales feed</li>
            </ul>
            <Link href="/login?signup=true&plan=proseller" className="hiq-btn-secondary text-center">
              Choose Pro Seller
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[color:var(--color-border)] py-8">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between text-sm text-[color:var(--color-muted)]">
          <div>© 2026 HobbyIQ · Just The Boys And Cards LLC</div>
          <div className="flex gap-6">
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <a href="mailto:drew@justtheboysandcards.com" className="hover:text-white">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
