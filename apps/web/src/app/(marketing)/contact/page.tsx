import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact — HobbyIQ",
  description: "Get in touch with HobbyIQ. Founder-in-your-inbox — real reply from a real human.",
};

export default function ContactPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold mb-4">Get in touch</h1>
      <p className="text-lg text-[color:var(--color-muted)] mb-12 leading-relaxed">
        Real human replies. Usually within a business day.
      </p>

      <div className="space-y-6">
        <ContactRow
          label="Help desk"
          value="help@hobby-iq.com"
          href="mailto:help@hobby-iq.com"
          body="General questions, feature requests, subscription help, or a card you think we're mispricing."
        />
        <ContactRow
          label="Ops alerts"
          value="help@hobby-iq.com"
          href="mailto:help@hobby-iq.com"
          body="Report a bug or an outage. Include your userId (Account Settings → User ID) if it's a portfolio-specific issue."
        />
        <ContactRow
          label="Legal / Founder"
          value="drew@hobby-iq.com"
          href="mailto:drew@hobby-iq.com"
          body="Privacy or terms-of-service questions, DMCA notices, business inquiries. Reaches me directly."
        />
      </div>

      <div className="mt-16 hiq-card p-6 text-center">
        <p className="text-sm text-[color:var(--color-muted)] mb-4">
          Not ready to email? Start with the free plan.
        </p>
        <Link href="/register" className="hiq-btn-primary inline-block">
          Create free account
        </Link>
      </div>
    </main>
  );
}

function ContactRow({
  label,
  value,
  href,
  body,
}: {
  label: string;
  value: string;
  href: string;
  body: string;
}) {
  return (
    <div className="hiq-card p-6">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
        {label}
      </div>
      <a
        href={href}
        className="text-xl font-medium hover:underline break-all block mb-2"
        style={{ color: "var(--color-accent)" }}
      >
        {value}
      </a>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">{body}</p>
    </div>
  );
}
