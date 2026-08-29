// CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG (Drew, 2026-08-29: "Bases are tagged
// to this gold or the gold is tagged to bases"). persistVendorSalesToPool
// used to let the vendor's PRODUCT tag (identity.parallel -- CardHedge's
// variant, TCA's structured hint) overwrite the parallel the title parser
// read. Under one Gold Refractor /50 slug that left 38 base autos at $5-12
// whose titles never said gold; pool-wide, exact: CH Gold 226 / Blue 161 /
// Blue Refractor 467 / Black 132 / Silver 551, TCA colour refractors 1-3%.
//
// The rule, as a pure function so it is tested and single-spelled: the
// sale's parallel is what its TITLE says. A vendor tag can never add a
// finish the title does not name, and never replace one it does. The tag is
// returned as telemetry so the caller can count the disagreements.

export interface ParallelDecision {
  parallel: string | null;
  /** The vendor tag that was NOT adopted, when it disagreed with the title. */
  vendorTagOverruled: string | null;
}

const norm = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").trim();
  return s && !/^base$/i.test(s) ? s : null;
};

export function parallelTheTitleAllows(
  titleParallel: string | null | undefined,
  vendorParallel: string | null | undefined,
): ParallelDecision {
  const fromTitle = norm(titleParallel);
  const fromVendor = norm(vendorParallel);
  const agrees = (fromTitle ?? "").toLowerCase() === (fromVendor ?? "").toLowerCase();
  return {
    parallel: fromTitle,
    vendorTagOverruled: fromVendor !== null && !agrees ? fromVendor : null,
  };
}
