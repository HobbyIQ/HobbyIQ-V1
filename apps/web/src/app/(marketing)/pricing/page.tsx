import Link from "next/link";
import type { Metadata } from "next";
import { PricingCheckoutButton } from "@/components/PricingCheckoutButton";

export const metadata: Metadata = {
  title: "Pricing — HobbyIQ",
  description:
    "Simple, transparent pricing for HobbyIQ. Collector, Investor, and Pro Seller plans. Cancel anytime.",
};

interface PlanFeature {
  label: string;
  free: boolean | string;
  collector: boolean | string;
  investor: boolean | string;
  proSeller: boolean | string;
}

const FEATURES: PlanFeature[] = [
  { label: "Full grade ladder + FMV lookups", free: "5 / day", collector: "Unlimited", investor: "Unlimited", proSeller: "Unlimited" },
  { label: "Portfolio tracking", free: "10 holdings", collector: "Unlimited", investor: "Unlimited", proSeller: "Unlimited" },
  { label: "Multi-sport (Baseball, Basketball, Football, Pokemon)", free: true, collector: true, investor: true, proSeller: true },
  { label: "Card scan / auto-identify", free: "5 / month", collector: "Unlimited", investor: "Unlimited", proSeller: "Unlimited" },
  { label: "Portfolio gain/loss + P&L reports", free: true, collector: true, investor: true, proSeller: true },
  { label: "Daily market movers", free: false, collector: false, investor: true, proSeller: true },
  { label: "Actionable sell/hold/list signals", free: false, collector: false, investor: true, proSeller: true },
  { label: "Sub-raw prospect detection", free: false, collector: false, investor: true, proSeller: true },
  { label: "Weekly portfolio brief", free: false, collector: true, investor: true, proSeller: true },
  { label: "Notable-sales feed", free: false, collector: false, investor: true, proSeller: true },
  { label: "Bulk CSV / spreadsheet inventory", free: false, collector: false, investor: false, proSeller: true },
  { label: "eBay listing draft integration", free: false, collector: false, investor: false, proSeller: true },
  { label: "Priority support", free: false, collector: false, investor: false, proSeller: true },
];

export default function PricingPage() {
  return (
    <main className="w-full">
      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-16 pb-12 text-center">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
          Simple, transparent pricing
        </h1>
        <p className="text-lg text-[color:var(--color-muted)]">
          Cancel anytime. All paid plans include multi-sport coverage. Owner-comped accounts
          available for creators — reach out.
        </p>
      </section>

      {/* Plan cards */}
      <section className="max-w-6xl mx-auto px-6 pb-16 grid grid-cols-1 md:grid-cols-3 gap-6">
        <PlanCard
          name="Collector"
          price="$9.99"
          period="/mo"
          tagline="Casual collectors tracking a personal portfolio."
          plan="collector"
        />
        <PlanCard
          name="Investor"
          price="$19.99"
          period="/mo"
          tagline="Active traders — timed sell/hold/list signals."
          plan="investor"
          featured
        />
        <PlanCard
          name="Pro Seller"
          price="$29.99"
          period="/mo"
          tagline="Pros with bulk inventory + eBay workflows."
          plan="pro_seller"
        />
      </section>

      {/* Feature matrix */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold mb-8 text-center">Compare plans</h2>
        <div className="hiq-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--color-border)]">
                <th className="text-left px-5 py-4 text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
                  Feature
                </th>
                <th className="text-center px-3 py-4 text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
                  Free
                </th>
                <th className="text-center px-3 py-4 text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
                  Collector
                </th>
                <th className="text-center px-3 py-4 text-xs uppercase tracking-wide font-medium" style={{ color: "var(--color-accent)" }}>
                  Investor
                </th>
                <th className="text-center px-3 py-4 text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
                  Pro Seller
                </th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.label} className="border-b border-[color:var(--color-border)] last:border-0">
                  <td className="px-5 py-3 font-medium">{f.label}</td>
                  <FeatureCell v={f.free} />
                  <FeatureCell v={f.collector} />
                  <FeatureCell v={f.investor} highlight />
                  <FeatureCell v={f.proSeller} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold mb-8 text-center">Common questions</h2>
        <div className="space-y-4">
          <FaqCard
            q="Do you offer a free tier?"
            a="Yes. Every account starts free with 5 daily price checks and up to 10 holdings — enough to see if HobbyIQ fits your workflow before upgrading."
          />
          <FaqCard
            q="Can I cancel anytime?"
            a="Yes. Cancel from Account Settings; your paid tier remains active until the end of the billing period, then reverts to free — your holdings and history stay put."
          />
          <FaqCard
            q="How does the FMV differ from other card pricing sites?"
            a="Our FMV is the projected next sale price derived from the actual comp trend on OUR observed sales pool. Not a mean, not a median — a trend-projected value. Every rung is empirical; when we don't have real sales, we say so instead of guessing."
          />
          <FaqCard
            q="Does the iOS subscription work on web (and vice versa)?"
            a="Same account across iOS + web. Subscription plans can be purchased via Apple StoreKit (iOS) or Stripe (web). Your effective tier is the higher of the two; you don't get double-billed."
          />
          <FaqCard
            q="What if I run a card business? Do you have team pricing?"
            a="Pro Seller ($29.99/mo) covers most single-operator card businesses. For 3+ seats or a custom integration, email drew@justtheboysandcards.com."
          />
        </div>
      </section>
    </main>
  );
}

function PlanCard({
  name,
  price,
  period,
  tagline,
  plan,
  featured,
}: {
  name: string;
  price: string;
  period: string;
  tagline: string;
  plan: "collector" | "investor" | "pro_seller";
  featured?: boolean;
}) {
  return (
    <div
      className="hiq-card p-8 flex flex-col relative"
      style={featured ? { borderColor: "var(--color-accent)" } : undefined}
    >
      {featured && (
        <div
          className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap"
          style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
        >
          MOST POPULAR
        </div>
      )}
      <h3 className="font-bold text-xl mb-1">{name}</h3>
      <p className="text-sm text-[color:var(--color-muted)] mb-6">{tagline}</p>
      <div className="mb-6">
        <span className="text-4xl font-bold">{price}</span>
        <span className="text-[color:var(--color-muted)]">{period}</span>
      </div>
      <PricingCheckoutButton
        plan={plan}
        label={`Start ${name}`}
        featured={featured}
      />
    </div>
  );
}

function FeatureCell({ v, highlight }: { v: boolean | string; highlight?: boolean }) {
  const bg = highlight ? "color-mix(in oklab, var(--color-accent) 6%, transparent)" : undefined;
  if (v === true) {
    return (
      <td className="text-center px-3 py-3" style={bg ? { background: bg } : undefined}>
        <span style={{ color: "var(--color-success)" }}>✓</span>
      </td>
    );
  }
  if (v === false) {
    return (
      <td className="text-center px-3 py-3 text-[color:var(--color-muted)]" style={bg ? { background: bg } : undefined}>
        —
      </td>
    );
  }
  return (
    <td className="text-center px-3 py-3 text-xs" style={bg ? { background: bg } : undefined}>
      {v}
    </td>
  );
}

function FaqCard({ q, a }: { q: string; a: string }) {
  return (
    <div className="hiq-card p-6">
      <h3 className="font-bold mb-2">{q}</h3>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">{a}</p>
    </div>
  );
}
