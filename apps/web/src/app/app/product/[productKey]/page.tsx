"use client";

// CF-CATALOG-FIRST product-structure page (Drew, 2026-08-04).
//
// Web mirror of HobbyIQ/ProductOverviewView.swift. Renders the
// authoritative baseballcardpedia-derived product structure: every
// parallel (with print run), every insert subset, every autograph
// subset. User lands here from /app/search via a link when a search
// result carries a productKey.

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getProductStructure, type ProductStructure, type ProductParallel, type ProductSubset, type ProductRelic } from "@/lib/api";

export default function ProductPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProductPageInner />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="text-sm text-[color:var(--color-muted)]">Loading product…</div>
    </div>
  );
}

function ProductPageInner() {
  const params = useParams<{ productKey: string }>();
  const productKey = String(params?.productKey ?? "");

  const [product, setProduct] = useState<ProductStructure | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productKey) return;
    let cancelled = false;
    getProductStructure(productKey)
      .then((p) => { if (!cancelled) setProduct(p); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load product"); });
    return () => { cancelled = true; };
  }, [productKey]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <p className="text-sm text-red-500">{error}</p>
        <Link href="/app/search" className="text-sm text-[color:var(--color-accent)]">← Back to search</Link>
      </div>
    );
  }
  if (!product) return <Loading />;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{product.productName}</h1>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          {product.brand.toUpperCase()} · {product.year}
          {product.parentSetKey ? <> · parent: <span className="font-mono">{product.parentSetKey}</span></> : null}
        </p>
      </header>

      {product.parallels.length > 0 && (
        <ProductSection title="Parallels" count={product.parallels.length} suffix="variants">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {product.parallels.map((p, i) => (
              <ParallelRow key={`${p.section}:${p.name}:${i}`} parallel={p} />
            ))}
          </ul>
        </ProductSection>
      )}

      {product.inserts.length > 0 && (
        <ProductSection title="Inserts" count={product.inserts.length} suffix="subsets">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {product.inserts.map((s) => <SubsetRow key={s.name} subset={s} />)}
          </ul>
        </ProductSection>
      )}

      {product.autos.length > 0 && (
        <ProductSection title="Autographs" count={product.autos.length} suffix="subsets">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {product.autos.map((s) => <SubsetRow key={s.name} subset={s} />)}
          </ul>
        </ProductSection>
      )}

      {product.gameUsed.length > 0 && (
        <ProductSection title="Game-Used" count={product.gameUsed.length} suffix="subsets">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {product.gameUsed.map((r) => <RelicRow key={r.name} relic={r} />)}
          </ul>
        </ProductSection>
      )}

      {product.gimmicks.length > 0 && (
        <ProductSection title="Gimmicks" count={product.gimmicks.length} suffix="subsets">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {product.gimmicks.map((r) => <RelicRow key={r.name} relic={r} />)}
          </ul>
        </ProductSection>
      )}
    </div>
  );
}

function ProductSection({ title, count, suffix, children }: { title: string; count: number; suffix: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <span className="text-xs text-[color:var(--color-muted)]">{count} {suffix}</span>
      </div>
      {children}
    </section>
  );
}

function ParallelRow({ parallel }: { parallel: ProductParallel }) {
  return (
    <li className="py-2 flex items-center justify-between">
      <div>
        <div className="text-sm">{parallel.name}</div>
        <div className="text-xs text-[color:var(--color-muted)]">{parallel.section}</div>
      </div>
      {parallel.printRun != null ? (
        <div className="text-sm text-[color:var(--color-accent)]">/{parallel.printRun}</div>
      ) : (
        <div className="text-xs text-[color:var(--color-muted)]">unnum.</div>
      )}
    </li>
  );
}

function SubsetRow({ subset }: { subset: ProductSubset }) {
  return (
    <li className="py-2 flex items-center justify-between">
      <div>
        <div className="text-sm">{subset.name}</div>
        {subset.cardPrefix ? (
          <div className="text-xs text-[color:var(--color-muted)]">prefix {subset.cardPrefix}</div>
        ) : null}
      </div>
      {subset.parallelCount > 0 && (
        <div className="text-xs text-[color:var(--color-accent)]">{subset.parallelCount} parallels</div>
      )}
    </li>
  );
}

function RelicRow({ relic }: { relic: ProductRelic }) {
  return (
    <li className="py-2 flex items-center justify-between">
      <div>
        <div className="text-sm">{relic.name}</div>
        {relic.cardPrefix ? (
          <div className="text-xs text-[color:var(--color-muted)]">prefix {relic.cardPrefix}</div>
        ) : null}
      </div>
    </li>
  );
}
