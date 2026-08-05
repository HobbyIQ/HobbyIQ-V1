import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — HobbyIQ",
  description:
    "HobbyIQ is built by Just The Boys And Cards LLC to be the pricing standard for the trading card industry.",
};

export default function AboutPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl md:text-5xl font-bold mb-6">The pricing icon of the industry</h1>
      <p className="text-lg text-[color:var(--color-muted)] mb-12 leading-relaxed">
        HobbyIQ is built by a collector for collectors. Our north star: THE authoritative
        price for every card, every grade, every sport.
      </p>

      <div className="space-y-10 text-[color:var(--color-muted)] leading-relaxed">
        <Section title="Why we built this">
          <p>
            Every existing card pricing tool is either a spreadsheet with a marketing budget
            or a black box that gives you a number without telling you where it came from.
            Neither works for people who actually buy and sell cards.
          </p>
          <p>
            We wanted a pricing standard the way baseball has WAR, or basketball has BPM.
            Something with a stated methodology, empirical foundations, and a public
            accuracy track record. Something you could point at and say &quot;the market says
            X&quot; and not have to argue.
          </p>
        </Section>

        <Section title="How we're different">
          <p className="font-semibold text-white mb-2">Every price rung is a real sale, not a guess.</p>
          <p>
            Our fair market value (FMV) is derived from observed transactions on eBay
            and our own verified user comps. When we don&apos;t have real sales for a
            specific grade or parallel, we say so — you get an &quot;estimated&quot; badge,
            not a made-up number.
          </p>

          <p className="font-semibold text-white mt-6 mb-2">FMV is the projected next sale, not the median.</p>
          <p>
            Most pricing sites report the median of the last N sales. That&apos;s a lagging
            indicator; it tells you where the market WAS, not where it&apos;s HEADING. Our FMV
            is trend-projected from the comp pool — the price the next buyer will most
            likely pay. When the market moves fast, so does our number.
          </p>

          <p className="font-semibold text-white mt-6 mb-2">Sport-aware calibration.</p>
          <p>
            Baseball, basketball, football, and Pokemon each have their own grade
            multipliers, market microstructure, and seasonality. We calibrate per-sport
            (and often per-set) instead of pretending one model fits everything.
          </p>

          <p className="font-semibold text-white mt-6 mb-2">Actionable, not just informative.</p>
          <p>
            Investor and Pro Seller tiers get timed sell/hold/list signals based on
            cascade-tier attention flowing through beat writers, engaged fans, and buyers.
            We don&apos;t just tell you a card is worth $X — we tell you when the market will
            most likely pay $X and whether YOUR card meets the criteria.
          </p>
        </Section>

        <Section title="Who's behind it">
          <p>
            HobbyIQ is a product of Just The Boys And Cards LLC, founded by Drew Vabulas.
            The stack is Node/TypeScript on Azure App Service + Cosmos DB, iOS in native
            SwiftUI, web in Next.js. Small team, product-first, no VCs.
          </p>
        </Section>

        <Section title="Get in touch">
          <p>
            Founder-in-your-inbox is real —{" "}
            <a href="mailto:drew@justtheboysandcards.com" style={{ color: "var(--color-accent)" }}>
              drew@justtheboysandcards.com
            </a>{" "}
            reaches Drew directly. Feature requests, partnership questions, or a card you
            think we&apos;re mispricing — all welcome.
          </p>
        </Section>
      </div>

      <div className="mt-16 flex items-center gap-4 flex-wrap">
        <Link href="/register" className="hiq-btn-primary">
          Create free account
        </Link>
        <Link href="/pricing" className="hiq-btn-secondary">
          See pricing
        </Link>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-2xl font-bold text-white mb-4">{title}</h2>
      <div className="text-sm space-y-4">{children}</div>
    </section>
  );
}
