// CF-CROSS-SOURCE-CONSENSUS (Drew, 2026-08-01). When the same physical
// sale is reported by MULTIPLE sources (CardHedge + eBay + Cardsight)
// with matching title fingerprint AND price within a small band, that's
// strong ground truth. Tag both rows with __consensusVerified=true so
// downstream consumers can prefer them as training signal.
//
// Match rule (per slug):
//   - Rows from ≥2 distinct sources within a 30-day window
//   - Title fingerprints match (>=80% word overlap after normalization)
//   - Prices agree within ±10%
//
// Called from recordSoldComp as a fire-and-forget after write.
// Cheap query — bounded by same-slug rows in a 30-day window.

import type { Container } from "@azure/cosmos";

const PRICE_TOLERANCE = 0.10;   // ±10%
const WINDOW_DAYS = 30;

function titleFingerprint(title: string | null | undefined): Set<string> {
  const t = String(title ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = t.split(/\s+/).filter((w) => w.length >= 3);
  return new Set(words);
}

function fingerprintOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / Math.min(a.size, b.size);
}

export async function checkCrossSourceConsensus(
  container: Container,
  incoming: {
    id: string;
    hobbyiqCardId: string | null;
    price: number;
    source: string;
    title: string | null;
    soldAt: string | null;
  },
): Promise<{ verified: boolean; consensusCount: number; matchedRows: string[] }> {
  if (!incoming.hobbyiqCardId || !incoming.title) return { verified: false, consensusCount: 0, matchedRows: [] };
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  try {
    const { resources } = await container.items.query({
      query: `SELECT c.id, c.source, c.title, c.price FROM c
                WHERE c.hobbyiqCardId = @slug
                  AND c.source != @src
                  AND (c.soldAt >= @cutoff OR c.observedAt >= @cutoff)
                  AND ABS(c.price - @price) / @price <= @tol`,
      parameters: [
        { name: "@slug", value: incoming.hobbyiqCardId },
        { name: "@src", value: incoming.source },
        { name: "@cutoff", value: cutoff },
        { name: "@price", value: incoming.price },
        { name: "@tol", value: PRICE_TOLERANCE },
      ],
    }, { maxItemCount: 25 }).fetchAll();

    const incFp = titleFingerprint(incoming.title);
    const matched: string[] = [];
    const sourcesSeen = new Set<string>([incoming.source]);
    for (const r of resources) {
      const otherFp = titleFingerprint((r as { title?: string }).title ?? null);
      const overlap = fingerprintOverlap(incFp, otherFp);
      if (overlap < 0.5) continue;   // titles too different
      const otherSrc = String((r as { source?: string }).source ?? "");
      if (!sourcesSeen.has(otherSrc)) sourcesSeen.add(otherSrc);
      matched.push(String((r as { id?: string }).id ?? ""));
    }
    if (sourcesSeen.size >= 2 && matched.length >= 1) {
      return { verified: true, consensusCount: matched.length + 1, matchedRows: matched };
    }
    return { verified: false, consensusCount: 1, matchedRows: [] };
  } catch { return { verified: false, consensusCount: 0, matchedRows: [] }; }
}
