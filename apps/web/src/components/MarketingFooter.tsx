import Link from "next/link";

export function MarketingFooter() {
  return (
    <footer className="border-t border-[color:var(--color-border)] mt-auto">
      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-bold mb-3">
              Product
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/pricing" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/register" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Get started
                </Link>
              </li>
              <li>
                <Link href="/login" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Sign in
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-bold mb-3">
              Company
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/about" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  About
                </Link>
              </li>
              <li>
                <Link href="/contact" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Contact
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-bold mb-3">
              Legal
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/terms" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Terms of service
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-[color:var(--color-muted)] hover:text-white transition-colors">
                  Privacy policy
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-bold mb-3">
              Contact
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href="mailto:help@hobby-iq.com"
                  className="text-[color:var(--color-muted)] hover:text-white transition-colors break-all"
                >
                  help@hobby-iq.com
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-6 border-t border-[color:var(--color-border)] flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs text-[color:var(--color-muted)]">
          <div>© 2026 HobbyIQ · HobbyIQ, LLC</div>
          <div>The pricing icon of the trading card industry</div>
        </div>
      </div>
    </footer>
  );
}
