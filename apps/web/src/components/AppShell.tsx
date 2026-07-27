"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { APP_NAV, activeNavItem, type NavItem } from "@/lib/navigation";
import { fetchSessionUser, signOut, type AuthUser } from "@/lib/api";
import { GlobalSearchBar } from "@/components/GlobalSearchBar";

interface AppShellProps {
  children: React.ReactNode;
}

// Guarded shell used by every /app/* route. Redirects to /login if there's
// no valid session, otherwise renders the sidebar + account chip.
export function AppShell({ children }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSessionUser()
      .then((u) => {
        if (cancelled) return;
        if (!u) {
          router.replace("/login");
          return;
        }
        setUser(u);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (loading || !user) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>
      </main>
    );
  }

  const active = activeNavItem(pathname ?? "/app");

  return (
    <div className="flex-1 w-full flex">
      {/* Sidebar — desktop */}
      <aside
        className="hidden md:flex md:w-60 lg:w-64 flex-col border-r border-[color:var(--color-border)]"
        style={{ background: "var(--color-bg)" }}
      >
        <div className="p-6 border-b border-[color:var(--color-border)]">
          <Link href="/app" className="font-bold text-xl block">
            <span className="hiq-hero-stroke text-transparent bg-clip-text">
              HobbyIQ
            </span>
          </Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {APP_NAV.map((item) => (
            <NavLink key={item.href} item={item} isActive={active?.href === item.href} />
          ))}
        </nav>
        <AccountChip user={user} />
      </aside>

      {/* Top bar — mobile */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 border-b border-[color:var(--color-border)]"
           style={{ background: "var(--color-bg)" }}>
        <div className="flex items-center gap-3 px-4 h-14">
          <Link href="/app" className="font-bold text-lg flex-shrink-0">
            <span className="hiq-hero-stroke text-transparent bg-clip-text">
              HobbyIQ
            </span>
          </Link>
          <div className="flex-1 min-w-0">
            <GlobalSearchBar compact />
          </div>
          <button
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle navigation"
            className="p-2 rounded-lg hover:bg-white/5 flex-shrink-0"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d={mobileOpen ? "M6.4 4.9L12 10.5l5.6-5.6 1.4 1.4L13.4 12l5.6 5.6-1.4 1.4L12 13.4l-5.6 5.6-1.4-1.4L10.6 12 5 6.4z" : "M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"} />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-20 pt-14"
             style={{ background: "var(--color-bg)" }}>
          <nav className="p-4 space-y-2">
            {APP_NAV.map((item) => (
              <NavLink key={item.href} item={item} isActive={active?.href === item.href} />
            ))}
          </nav>
          <div className="p-4 border-t border-[color:var(--color-border)]">
            <AccountChip user={user} />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 md:pl-0 pt-14 md:pt-0 min-w-0 flex flex-col">
        {/* Desktop top bar — global search */}
        <div
          className="hidden md:flex sticky top-0 z-30 border-b border-[color:var(--color-border)] px-6 h-14 items-center gap-4"
          style={{ background: "color-mix(in oklab, var(--color-bg) 92%, transparent)", backdropFilter: "blur(8px)" }}
        >
          <div className="w-full max-w-2xl">
            <GlobalSearchBar />
          </div>
        </div>
        <div className="flex-1 min-w-0">{children}</div>
      </main>
    </div>
  );
}

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        isActive
          ? "text-white"
          : "text-[color:var(--color-muted)] hover:text-white hover:bg-white/5"
      }`}
      style={isActive ? { background: "var(--color-bg-card)" } : undefined}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d={item.iconPath} />
      </svg>
      <span>{item.label}</span>
    </Link>
  );
}

function AccountChip({ user }: { user: AuthUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const initial = (user.email[0] ?? "?").toUpperCase();
  const planLabel = (user.plan ?? "free").replace("_", " ");

  return (
    <div ref={ref} className="relative p-3 border-t border-[color:var(--color-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors"
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
          style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm font-medium text-white truncate">{user.email}</div>
          <div className="text-xs capitalize" style={{ color: "var(--color-accent)" }}>
            {planLabel}
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
          <path d="M12 15.5L5 8.5l1.4-1.4L12 12.7l5.6-5.6L19 8.5z" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-3 right-3 mb-2 rounded-xl shadow-2xl overflow-hidden border border-[color:var(--color-border)]"
          style={{ background: "var(--color-bg-card)" }}
        >
          <Link
            href="/app/settings"
            className="block px-4 py-3 text-sm hover:bg-white/5 transition-colors"
          >
            Account settings
          </Link>
          <button
            onClick={async () => {
              await signOut();
              router.push("/");
            }}
            className="w-full text-left px-4 py-3 text-sm hover:bg-white/5 transition-colors"
            style={{ color: "var(--color-danger)" }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
