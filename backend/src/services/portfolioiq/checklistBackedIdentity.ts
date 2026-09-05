/**
 * CF-VERIFIED-IS-CHECKLIST-BACKED (Drew, 2026-08-30).
 *
 * "VERIFIED" on a holding means its identity is a checklist-backed catalog
 * card — whether the owner confirmed it in Edit, an import matched it, the
 * catalog sweep (conform-holdings-to-catalog) resolved it, or a ruling placed
 * it. The manual Confirm gate (CF-IDENTITY-VERIFIED, 2026-07-27) stays as the
 * override for parked / fuzzy identities; it no longer is the only road.
 *
 * This module stamps the flag on the live add / update paths. The catalog row
 * is read through an injected reader so the decision is testable without
 * Cosmos; the default reader point-reads card_catalog (id === partition key).
 */
import { isChecklistBackedIdentity } from "../catalog/identityBacking.js";

export const CHECKLIST_STAMP_SOURCE = "checklist-backed-identity";

export type CatalogRowSourceReader = (slug: string) => Promise<{ source?: string | null } | null>;

export type ChecklistStampOutcome =
  | "stamped"
  | "already-verified"
  | "no-identity"
  | "row-missing"
  | "not-checklist-backed";

/**
 * Stamp identityVerified on `h` when its hobbyiqCardId is a checklist-backed
 * catalog row. Never clears an existing verification. Mutates `h`.
 */
export async function stampChecklistBackedIdentity(
  h: Record<string, unknown>,
  readRow: CatalogRowSourceReader,
  ctx: { via: string },
): Promise<ChecklistStampOutcome> {
  if (h.identityVerified === true) return "already-verified";
  const slug = String(h.hobbyiqCardId ?? "").trim();
  if (!slug.startsWith("hiq:")) return "no-identity";
  const row = await readRow(slug);
  if (!row) return "row-missing";
  // CF-ONE-DEFINITION-OF-CHECKLIST-BACKED (2026-09-04). This asked
  // `catalogAuthorityOf(...) !== "checklist"` directly, which is the same
  // question the PRICING gate now asks — and asking it twice, in two files,
  // with two spellings, is how the four predicates in catalogAuthority's
  // header drifted apart in the first place.
  //
  // Both roads now go through the one predicate, so the badge and the price
  // can never disagree about a holding: a card that shows VERIFIED is exactly
  // a card the valuation path will publish a number for. (They agreed already
  // -- this module already refused `user-verified` while `catalogAuthorityOf`
  // calls it "vendor" -- only because this call site happened to test for
  // equality with "checklist" rather than for absence of "derived".)
  if (!isChecklistBackedIdentity(row.source)) return "not-checklist-backed";
  const at = new Date().toISOString();
  h.identityVerified = true;
  h.identityVerifiedAt = at;
  h.identityVerifiedBy = { source: CHECKLIST_STAMP_SOURCE, candidateId: slug, via: ctx.via, verifiedAt: at };
  return "stamped";
}

/** Default reader: a point read of card_catalog by slug (id === partition key). Null on 404 or outage. */
export async function readCatalogRowSource(slug: string): Promise<{ source?: string | null } | null> {
  try {
    const { getCatalogContainerForRead } = await import("../catalog/catalogMatcher.service.js");
    const container = await getCatalogContainerForRead();
    if (!container) return null;
    const { resource } = await container.item(slug, slug).read<{ source?: string | null }>();
    return resource ? { source: resource.source ?? null } : null;
  } catch (e: unknown) {
    const code = (e as { code?: number } | null)?.code;
    if (code !== 404) {
      console.warn(JSON.stringify({ event: "checklist_backed_identity_read_failed", source: "checklistBackedIdentity", slug, error: String((e as Error)?.message ?? e).slice(0, 160) }));
    }
    return null;
  }
}
