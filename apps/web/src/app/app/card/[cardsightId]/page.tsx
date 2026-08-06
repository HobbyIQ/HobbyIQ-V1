"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { CardPriceDetail } from "@/components/CardPriceDetail";
import { RecentCompsList } from "@/components/RecentCompsList";
import { GradeCurveView } from "@/components/GradeCurveView";
import { readStashedCandidate } from "@/lib/candidateStash";
import type { SearchCandidate } from "@/lib/api";

interface Grade { company: string; value: number }

export default function CardDetailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CardDetailInner />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="text-sm text-[color:var(--color-muted)]">Loading card…</div>
    </div>
  );
}

function CardDetailInner() {
  const params = useParams<{ cardsightId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  // CF-CARD-ID-DECODE (Drew, 2026-08-06). Next.js dynamic route params
  // arrive URL-encoded. For a slug like "hiq:baseball:2018:..." the
  // colons come back as "%3A", producing "hiq%3Abaseball%3A..." that
  // no backend endpoint can resolve — the page rendered with a
  // "Insufficient recent comps" fallback + garbage "#hiq%3Aba" card
  // number. Decode on read so the raw slug flows to every downstream
  // fetch, and the display shows "#hiq:ba..." instead of "#hiq%3Aba".
  const rawCardsightId = String(params?.cardsightId ?? "");
  const cardsightCardId = (() => {
    try { return decodeURIComponent(rawCardsightId); } catch { return rawCardsightId; }
  })();
  const initialParallel = searchParams.get("parallel");
  const initialGradeRaw = searchParams.get("grade");
  const initialGrade: Grade | null = (() => {
    if (!initialGradeRaw) return null;
    const [company, valueStr] = initialGradeRaw.split(":");
    const value = Number(valueStr);
    if (!company || !Number.isFinite(value)) return null;
    return { company: company.toUpperCase(), value };
  })();

  const [candidate, setCandidate] = useState<SearchCandidate | null>(null);
  const didHydrate = useRef(false);
  useEffect(() => {
    if (didHydrate.current) return;
    didHydrate.current = true;
    setCandidate(readStashedCandidate(cardsightCardId));
  }, [cardsightCardId]);

  function onSelectionChange(grade: Grade | null, parallel: string | null) {
    const params = new URLSearchParams();
    if (parallel) params.set("parallel", parallel);
    if (grade) params.set("grade", `${grade.company}:${grade.value}`);
    const qs = params.toString();
    router.replace(`/app/card/${cardsightCardId}${qs ? `?${qs}` : ""}`);
  }

  if (!cardsightCardId) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>
          Missing card id.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-4">
        <Link
          href="/app/search"
          className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors"
        >
          ← Back to search
        </Link>
      </div>

      <CardPriceDetail
        cardsightCardId={cardsightCardId}
        candidate={candidate}
        initialGrade={initialGrade}
        initialParallel={initialParallel}
        onSelectionChange={onSelectionChange}
      />

      <div className="mt-6">
        <GradeCurveView cardId={cardsightCardId} />
      </div>

      <div className="mt-6">
        <RecentCompsList
          cardId={cardsightCardId}
          parallel={initialParallel ?? ""}
          gradeCompany={initialGrade?.company}
          gradeValue={initialGrade?.value}
          subtitle="Live comps that back this card's price. Filter by source or window."
        />
      </div>
    </div>
  );
}
