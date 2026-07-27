import Link from "next/link";

// Public-page header — used on landing + all marketing routes.
// AppShell handles its own header for authenticated /app/* routes.
export function MarketingHeader() {
  return (
    <nav className="flex items-center justify-between w-full max-w-7xl mx-auto px-6 py-6">
      <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-xl">
        <span className="hiq-hero-stroke text-transparent bg-clip-text">HobbyIQ</span>
      </Link>
      <div className="flex items-center gap-6 text-sm">
        <Link
          href="/pricing"
          className="text-[color:var(--color-muted)] hover:text-white transition-colors hidden sm:block"
        >
          Pricing
        </Link>
        <Link
          href="/about"
          className="text-[color:var(--color-muted)] hover:text-white transition-colors hidden sm:block"
        >
          About
        </Link>
        <Link
          href="/login"
          className="text-[color:var(--color-muted)] hover:text-white transition-colors"
        >
          Sign in
        </Link>
        <Link href="/login?signup=true" className="hiq-btn-primary text-sm">
          Get started
        </Link>
      </div>
    </nav>
  );
}
