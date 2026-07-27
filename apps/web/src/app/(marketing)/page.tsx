import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="w-full">
      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-16 pb-24 text-center">
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
          <Link href="/pricing" className="hiq-btn-secondary">
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

      {/* Multi-sport highlight */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="hiq-card p-8 md:p-12 text-center">
          <div className="text-xs uppercase tracking-wide font-bold mb-3" style={{ color: "var(--color-accent)" }}>
            Multi-sport coverage
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Baseball, Basketball, Football, and Pokemon
          </h2>
          <p className="text-[color:var(--color-muted)] max-w-2xl mx-auto leading-relaxed">
            Millions of observed sales across every major card category, ingested and priced
            nightly. Sport-aware calibration; no cross-sport contamination in the models.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-24 text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready to see your portfolio priced right?</h2>
        <p className="text-[color:var(--color-muted)] mb-8 max-w-2xl mx-auto">
          Free plan gets you started. Upgrade any time.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link href="/login?signup=true" className="hiq-btn-primary">
            Create free account
          </Link>
          <Link href="/pricing" className="hiq-btn-secondary">
            Compare plans
          </Link>
        </div>
      </section>
    </main>
  );
}
