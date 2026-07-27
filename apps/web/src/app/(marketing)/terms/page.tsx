import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — HobbyIQ",
  description: "Terms of service for HobbyIQ.",
};

// Reasonable-starting-point Terms of Service. Founder should have
// counsel review before serious scale; this is not legal advice.
const EFFECTIVE_DATE = "2026-07-27";

export default function TermsPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold mb-3">Terms of Service</h1>
      <p className="text-sm text-[color:var(--color-muted)] mb-12">
        Effective {EFFECTIVE_DATE}
      </p>

      <div className="prose-content space-y-8 text-[color:var(--color-muted)] leading-relaxed">
        <Section title="1. Agreement">
          <p>
            These Terms of Service (&quot;Terms&quot;) govern your use of HobbyIQ (the &quot;Service&quot;),
            operated by Just The Boys And Cards LLC (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). By creating an
            account, accessing, or using the Service, you agree to be bound by these Terms.
            If you do not agree, do not use the Service.
          </p>
        </Section>

        <Section title="2. Eligibility">
          <p>
            You must be at least 18 years old (or the age of legal majority in your
            jurisdiction) to use the Service. By using the Service, you represent that you
            meet this requirement.
          </p>
        </Section>

        <Section title="3. Accounts">
          <p>
            You are responsible for maintaining the confidentiality of your account
            credentials and for all activity under your account. Notify us immediately at{" "}
            <a href="mailto:drew@justtheboysandcards.com" style={{ color: "var(--color-accent)" }}>
              drew@justtheboysandcards.com
            </a>{" "}
            of any unauthorized use.
          </p>
        </Section>

        <Section title="4. Subscriptions and billing">
          <p>
            Paid tiers (Collector, Investor, Pro Seller) are billed monthly. You may cancel
            at any time from Account Settings. Cancellation takes effect at the end of the
            current billing period; no partial refunds are issued for the remainder of a
            period. Prices are subject to change; we will provide at least 30 days&apos;
            notice of a price increase to any active subscriber. Subscriptions purchased via
            Apple StoreKit or Google Play are managed by those platforms and are subject to
            their refund policies.
          </p>
        </Section>

        <Section title="5. Data content and disclaimers">
          <p>
            The Service provides card pricing information (&quot;Pricing Data&quot;) derived from
            observed transactions across third-party data sources and our own user comps.
            Pricing Data is provided for informational purposes only and does not constitute
            financial or investment advice. Card values fluctuate; past sales do not
            guarantee future prices. Sell/hold/list recommendations are algorithmic outputs,
            not personalized investment advice. You are solely responsible for your own
            trading decisions.
          </p>
        </Section>

        <Section title="6. Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Reverse engineer, scrape, or bulk-extract Pricing Data from the Service</li>
            <li>Resell, sublicense, or redistribute the Service or its outputs commercially</li>
            <li>Attempt to circumvent authentication, rate limits, or entitlement gates</li>
            <li>Upload content you do not have the right to upload</li>
            <li>Interfere with the Service&apos;s operation or other users&apos; access</li>
          </ul>
        </Section>

        <Section title="7. User content">
          <p>
            You retain ownership of the card holdings, photos, and notes you add to your
            portfolio (&quot;User Content&quot;). You grant us a limited license to store, process,
            and display your User Content solely to operate the Service on your behalf.
            Aggregated, de-identified transaction data derived from user comps may be used
            to improve our Pricing Data.
          </p>
        </Section>

        <Section title="8. Termination">
          <p>
            You may delete your account at any time via Account Settings. We may suspend or
            terminate accounts that violate these Terms or that we reasonably believe are
            engaged in fraud, abuse, or security threats. Upon termination, your User
            Content is deleted within 30 days except where retention is required by law.
          </p>
        </Section>

        <Section title="9. Disclaimers">
          <p>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY
            KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE
            WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT PRICING DATA IS COMPLETE OR ACCURATE.
          </p>
        </Section>

        <Section title="10. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, JUST THE BOYS AND CARDS LLC WILL NOT BE
            LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, INCLUDING LOST PROFITS, LOST DATA, OR TRADING LOSSES, ARISING OUT OF OR
            RELATED TO YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY WILL NOT EXCEED THE
            AMOUNT YOU PAID US IN THE 12 MONTHS PRECEDING THE CLAIM.
          </p>
        </Section>

        <Section title="11. Governing law">
          <p>
            These Terms are governed by the laws of the State of Delaware, USA, without
            regard to its conflict-of-laws principles. Any dispute will be resolved in the
            state or federal courts located in Delaware.
          </p>
        </Section>

        <Section title="12. Changes to these Terms">
          <p>
            We may update these Terms from time to time. We will notify subscribers by
            email of material changes at least 30 days before they take effect. Continued
            use of the Service after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section title="13. Contact">
          <p>
            Questions?{" "}
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
      <div className="text-sm space-y-3">{children}</div>
    </section>
  );
}
