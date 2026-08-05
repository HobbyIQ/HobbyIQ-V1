import Link from "next/link";
import { LiveStatsStrip } from "@/components/LiveStatsStrip";

export default function LandingPage() {
  return (
    <main className="w-full">
      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-16 md:pt-24 pb-14 text-center">
        <div
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-8"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-accent)" }} />
          Empirical FMV · updated daily
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight leading-tight max-w-3xl mx-auto">
          The card market,{" "}
          <span className="hiq-hero-stroke text-transparent bg-clip-text">priced honestly</span>
        </h1>
        <p className="mt-6 text-lg md:text-xl text-[color:var(--color-muted)] max-w-2xl mx-auto leading-relaxed">
          Every price rung sourced from real transactions. No hand-tuned matrix, no guesses.
          Multi-sport, full grade ladder, actionable sell/hold/list signals.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4 flex-wrap">
          <Link href="/register" className="hiq-btn-primary">
            Start free
          </Link>
          <Link href="/pricing" className="hiq-btn-secondary">
            See pricing
          </Link>
        </div>
      </section>

      {/* Live stats strip */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <LiveStatsStrip />
      </section>

      {/* Feature triptych — 3 clean cards */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FeatureCard
            iconPath="M4 6h16v12H4V6zm2 2v8h12V8H6zm8 3l-3 3-1.5-1.5L8 14l3 3 5-5-1.5-1.5z"
            title="Empirical FMV"
            body="Every rung is a real sale. Observed medians when we have them, transparent estimates when we don't."
          />
          <FeatureCard
            iconPath="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            title="Actionable intel"
            body="Sell-now radar. Sub-raw prospect detection. Grade-worthy alerts. Timed windows, not vibes."
          />
          <FeatureCard
            iconPath="M3 3h2v18H3V3zm4 12h2v6H7v-6zm4-4h2v10h-2V11zm4-6h2v16h-2V5zm4 8h2v8h-2v-8z"
            title="Full grade ladder"
            body="PSA 1-10, BGS, SGC, CGC. Vintage low-grade included. No wrong numbers when the data isn't there."
          />
        </div>
      </section>

      {/* Workflow overview */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="text-center mb-10">
          <div className="text-xs uppercase tracking-wide font-bold mb-2" style={{ color: "var(--color-accent)" }}>
            Everything in one place
          </div>
          <h2 className="text-3xl md:text-4xl font-bold">Built for how you actually trade</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <WorkflowCard
            title="Search + price any card"
            body="Player name, cert number, or free text. Grade ladder, parallel picker, buy/hold/sell zones inline."
            href="/register"
            cta="Try search"
          />
          <WorkflowCard
            title="Portfolio tracking"
            body="Real-time value, gain/loss, top movers. Import from eBay purchases or add manually."
            href="/pricing"
            cta="See plans"
          />
          <WorkflowCard
            title="Market intelligence"
            body="Sector movers by sport, notable sales feed, hot prospect detection, personalized daily brief."
            href="/pricing"
            cta="See plans"
          />
          <WorkflowCard
            title="Pro seller workflows"
            body="Bulk inventory, eBay listing draft/publish, sales sync, tax-ready reports. Coming to Pro Seller."
            href="/pricing"
            cta="Learn more"
          />
        </div>
      </section>

      {/* Category coverage strip */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="hiq-card p-8 md:p-10 text-center">
          <div className="text-xs uppercase tracking-wide font-bold mb-3" style={{ color: "var(--color-accent)" }}>
            Multi-sport coverage
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Baseball, Basketball, Football, Pokemon
          </h2>
          <p className="text-[color:var(--color-muted)] max-w-2xl mx-auto leading-relaxed">
            Millions of observed sales across every major card category, ingested nightly.
            Sport-aware calibration — grade multipliers, scarcity tiers, and player signals
            tuned per category. No cross-sport contamination.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-24 text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready to see your portfolio priced right?</h2>
        <p className="text-[color:var(--color-muted)] mb-8 max-w-2xl mx-auto">
          Free plan gets you started. Upgrade any time.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link href="/register" className="hiq-btn-primary">
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

function FeatureCard({ iconPath, title, body }: { iconPath: string; title: string; body: string }) {
  return (
    <div className="hiq-card p-6">
      <div className="mb-4">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--color-accent)" }}>
          <path d={iconPath} />
        </svg>
      </div>
      <h3 className="font-bold text-lg mb-2">{title}</h3>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">{body}</p>
    </div>
  );
}

function WorkflowCard({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="hiq-card p-6 flex flex-col">
      <h3 className="font-bold text-lg mb-2">{title}</h3>
      <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">{body}</p>
      <Link
        href={href}
        className="mt-4 text-sm font-medium hover:underline self-start"
        style={{ color: "var(--color-accent)" }}
      >
        {cta} →
      </Link>
    </div>
  );
}
