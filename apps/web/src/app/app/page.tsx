"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessionUser, signOut, type AuthUser } from "@/lib/api";

export default function AppHome() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !user) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-sm text-[color:var(--color-muted)]">Loading your portfolio…</div>
      </main>
    );
  }

  return (
    <main className="hiq-glow-top flex-1 w-full">
      {/* Signed-in top bar */}
      <nav className="border-b border-[color:var(--color-border)]">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/app" className="font-bold text-xl">
            <span className="hiq-hero-stroke text-transparent bg-clip-text">HobbyIQ</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-[color:var(--color-muted)]">{user.email}</span>
            <span
              className="px-2 py-1 rounded text-xs font-medium capitalize"
              style={{ background: "var(--color-bg-card)", color: "var(--color-accent)" }}
            >
              {(user.plan ?? "free").replace("_", " ")}
            </span>
            <button
              onClick={() => {
                signOut();
                router.push("/");
              }}
              className="text-[color:var(--color-muted)] hover:text-white transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* Placeholder dashboard */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Welcome, {user.email.split("@")[0]}</h1>
        <p className="text-[color:var(--color-muted)] mb-8">
          Your Pro Seller dashboard lands here. Inventory, portfolio movers, sell-signal
          radar, prospect detection, and bulk workflows.
        </p>

        {/* Skeleton grid — replaced by real widgets in the next sprint */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="hiq-card p-6">
            <h2 className="font-bold mb-2">Portfolio Today</h2>
            <p className="text-sm text-[color:var(--color-muted)]">
              Total FMV + P&amp;L + top movers in your holdings (coming next).
            </p>
          </div>
          <div className="hiq-card p-6">
            <h2 className="font-bold mb-2">Sell radar</h2>
            <p className="text-sm text-[color:var(--color-muted)]">
              Cards you own that hit your sell threshold overnight (coming next).
            </p>
          </div>
          <div className="hiq-card p-6">
            <h2 className="font-bold mb-2">Market Today</h2>
            <p className="text-sm text-[color:var(--color-muted)]">
              Sector movers per sport, notable sales, hot prospects (coming next).
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
