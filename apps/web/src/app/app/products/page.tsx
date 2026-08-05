"use client";

// CF-CATALOG-BROWSE (Drew, 2026-08-05).
//
// Browse-products landing — enumerates every product family in the
// BCCP-derived catalog for a year, optionally filtered by brand.
// Backed by /api/catalog/product-structure/list. Each card links to
// /app/product/[productKey] for the full parallel/insert/auto rollup.
//
// URL: /app/products?year=2024&brand=topps
//   - year defaults to current year on cold load
//   - brand omitted = all brands
//
// iOS counterpart to build next: ProductBrowseView.swift consuming
// APIService.listProductStructures(year:brand:).

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { listProductStructures, type ProductListItem } from "@/lib/api";

const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2010, 2005, 2000, 1995, 1990, 1985, 1980, 1975, 1970, 1965, 1960, 1955, 1950];
const BRANDS: Array<{ id: string; label: string }> = [
  { id: "",        label: "All brands" },
  { id: "topps",   label: "Topps"      },
  { id: "bowman",  label: "Bowman"     },
  { id: "panini",  label: "Panini"     },
  { id: "upper-deck", label: "Upper Deck" },
  { id: "fleer",   label: "Fleer"      },
  { id: "pinnacle", label: "Pinnacle"  },
  { id: "opc",     label: "O-Pee-Chee" },
  { id: "goudey",  label: "Goudey"     },
  { id: "other",   label: "Other"      },
];

export default function ProductsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProductsInner />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="text-sm text-[color:var(--color-muted)]">Loading products…</div>
    </div>
  );
}

function ProductsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialYear = Number(params.get("year")) || 2025;
  const initialBrand = params.get("brand") ?? "";

  const [year, setYear] = useState<number>(initialYear);
  const [brand, setBrand] = useState<string>(initialBrand);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async (y: number, b: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProductStructures(y, b || undefined);
      setProducts(list);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to load products");
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(year, brand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, brand]);

  function updateUrl(y: number, b: string) {
    const p = new URLSearchParams();
    p.set("year", String(y));
    if (b) p.set("brand", b);
    router.replace(`/app/products?${p.toString()}`);
  }

  function onYearChange(y: number) { setYear(y); updateUrl(y, brand); }
  function onBrandChange(b: string) { setBrand(b); updateUrl(year, b); }

  const filtered = q.trim()
    ? products.filter((p) => p.productName.toLowerCase().includes(q.trim().toLowerCase()))
    : products;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Browse products</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Every Topps, Bowman, Panini, and vintage set with parallel + insert + autograph enumeration.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={year}
            onChange={(e) => onYearChange(Number(e.target.value))}
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "white" }}
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select
            value={brand}
            onChange={(e) => onBrandChange(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "white" }}
          >
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </div>
      </header>

      <input
        type="search"
        placeholder={`Filter ${year} products…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full mb-6 px-4 py-2.5 rounded-lg text-sm outline-none focus:border-[color:var(--color-accent)]"
        style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "white" }}
      />

      {loading && (
        <div className="hiq-card p-8 text-sm text-[color:var(--color-muted)]">Loading…</div>
      )}

      {error && (
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}

      {!loading && !error && (
        <>
          <div className="mb-4 text-xs text-[color:var(--color-muted)]">
            {filtered.length} product{filtered.length === 1 ? "" : "s"}
            {q.trim() && ` matching "${q.trim()}"`}
            {brand && ` · ${BRANDS.find((b) => b.id === brand)?.label ?? brand}`}
          </div>

          {filtered.length === 0 ? (
            <div className="hiq-card p-8 text-center text-sm text-[color:var(--color-muted)]">
              No products {brand ? "for that brand" : ""} in {year}. Try a different year or brand.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <ProductCard key={p.productKey} p={p} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProductCard({ p }: { p: ProductListItem }) {
  const total = p.parallelCount + p.insertCount + p.autoCount + p.gameUsedCount + p.gimmickCount;
  return (
    <Link
      href={`/app/product/${encodeURIComponent(p.productKey)}`}
      className="hiq-card p-4 flex flex-col justify-between transition-colors hover:bg-white/[0.02]"
    >
      <div>
        <div className="font-medium truncate mb-1">{p.productName}</div>
        <div className="text-xs text-[color:var(--color-muted)] mb-3">
          {p.brand.toUpperCase()} · <span className="font-mono">{p.setKey}</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs">
        <div className="flex gap-3 flex-wrap">
          {p.parallelCount > 0 && <StatPill label="parallels" n={p.parallelCount} accent="brand" />}
          {p.insertCount > 0   && <StatPill label="inserts"   n={p.insertCount}   accent="neutral" />}
          {p.autoCount > 0     && <StatPill label="autos"     n={p.autoCount}     accent="positive" />}
          {p.gameUsedCount > 0 && <StatPill label="relics"    n={p.gameUsedCount} accent="neutral" />}
        </div>
        {total === 0 && (
          <span className="text-[color:var(--color-muted)]">no structure</span>
        )}
      </div>
    </Link>
  );
}

function StatPill({ label, n, accent }: { label: string; n: number; accent: "brand" | "positive" | "neutral" }) {
  return (
    <span className={`hiq-badge hiq-badge--${accent} whitespace-nowrap`}>
      {n} {label}
    </span>
  );
}
