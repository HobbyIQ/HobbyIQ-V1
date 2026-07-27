import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — HobbyIQ",
  description: "Privacy policy for HobbyIQ.",
};

const EFFECTIVE_DATE = "2026-07-27";

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold mb-3">Privacy Policy</h1>
      <p className="text-sm text-[color:var(--color-muted)] mb-12">
        Effective {EFFECTIVE_DATE}
      </p>

      <div className="space-y-8 text-[color:var(--color-muted)] leading-relaxed">
        <Section title="1. Who we are">
          <p>
            HobbyIQ is operated by Just The Boys And Cards LLC (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). This
            Privacy Policy explains what personal data we collect, how we use it, and your
            rights.
          </p>
        </Section>

        <Section title="2. Information we collect">
          <p className="font-semibold text-white mt-4 mb-1">Account information</p>
          <p>Email address and password (stored as a scrypt hash — never plaintext), optional username and display name.</p>

          <p className="font-semibold text-white mt-4 mb-1">Portfolio content</p>
          <p>Card holdings you add (year, product, player, parallel, grade, quantity, cost basis, purchase date, notes, photos), and eBay listing IDs if you connect eBay.</p>

          <p className="font-semibold text-white mt-4 mb-1">Usage data</p>
          <p>Server logs (IP address, User-Agent, request path, response status, timestamps) retained for up to 90 days for abuse prevention, security, and operational analysis. Aggregated telemetry (which features are used, feature latency, error rates) is retained longer.</p>

          <p className="font-semibold text-white mt-4 mb-1">Payment information</p>
          <p>We do NOT store credit card numbers. Payments are processed by Stripe (web) or Apple StoreKit (iOS); we receive only a subscription status and a transaction identifier from these processors.</p>

          <p className="font-semibold text-white mt-4 mb-1">Device tokens</p>
          <p>If you enable push notifications, we store your device token to deliver alerts.</p>
        </Section>

        <Section title="3. How we use your information">
          <ul className="list-disc pl-6 space-y-1">
            <li>To provide, operate, and maintain the Service</li>
            <li>To calculate portfolio value, gain/loss, and personalized signals</li>
            <li>To process subscription payments and manage entitlements</li>
            <li>To send transactional and (with your consent) marketing communications</li>
            <li>To improve pricing accuracy — aggregated, de-identified transaction data from user comps feeds our sold_comps pool</li>
            <li>To detect fraud, abuse, and security threats</li>
            <li>To comply with legal obligations</li>
          </ul>
        </Section>

        <Section title="4. Third-party services we use">
          <p>To operate the Service, we share limited data with these processors:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong className="text-white">Microsoft Azure</strong> — hosting (App Service, Cosmos DB, Redis, Application Insights, Static Web Apps)</li>
            <li><strong className="text-white">Cloudflare</strong> — DNS + edge routing for hobby-iq.com</li>
            <li><strong className="text-white">Stripe</strong> — payment processing for web subscriptions</li>
            <li><strong className="text-white">Apple</strong> — payment processing for iOS subscriptions via StoreKit</li>
            <li><strong className="text-white">eBay, PSA</strong> — trading card marketplaces and grading services (we query these on your behalf when you look up cards)</li>
            <li><strong className="text-white">Third-party pricing partners</strong> — anonymized market data providers used to enrich our comp pool</li>
          </ul>
          <p className="mt-3">
            We do not sell your personal information to advertisers, brokers, or any third
            party.
          </p>
        </Section>

        <Section title="5. Aggregated data and pricing intelligence">
          <p>
            When you log a card sale (through the &quot;Sell&quot; action on a holding) or connect
            eBay, that transaction may be added to our sold_comps pool used to compute FMV
            for everyone. This pool is de-identified — it stores the card, the price, the
            date, and the marketplace, but not the seller&apos;s identity. You cannot opt out
            of this de-identified aggregation while using the Service, because it&apos;s core to
            how our pricing works. Contact us if you have concerns.
          </p>
        </Section>

        <Section title="6. Data retention">
          <p>
            Account and portfolio data is retained while your account is active. If you
            delete your account, we remove your personal data within 30 days, except where
            retention is required by law (e.g., tax records related to your subscription
            payments). De-identified transaction data may be retained indefinitely as part
            of our pricing pool.
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            Depending on your jurisdiction, you may have rights to access, correct, delete,
            or export your personal data. Most of these are self-service in the app; email{" "}
            <a href="mailto:drew@justtheboysandcards.com" style={{ color: "var(--color-accent)" }}>
              drew@justtheboysandcards.com
            </a>{" "}
            to submit a formal request. California and EU residents have additional rights
            under CCPA and GDPR respectively.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            We use HTTPS everywhere, scrypt password hashing, encrypted-at-rest Cosmos DB
            storage, and least-privilege access controls. No system is perfectly secure; we
            will notify affected users of any material breach as required by law.
          </p>
        </Section>

        <Section title="9. Children">
          <p>
            The Service is not intended for children under 13 (or 16 in the EU/UK). We do
            not knowingly collect personal information from children. If you believe we
            have, contact us and we&apos;ll delete it.
          </p>
        </Section>

        <Section title="10. Changes">
          <p>
            We may update this Privacy Policy. Material changes will be emailed to
            subscribers at least 30 days before they take effect.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            Privacy questions or requests:{" "}
            <a href="mailto:drew@justtheboysandcards.com" style={{ color: "var(--color-accent)" }}>
              drew@justtheboysandcards.com
            </a>
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-white mb-3">{title}</h2>
      <div className="text-sm">{children}</div>
    </section>
  );
}
