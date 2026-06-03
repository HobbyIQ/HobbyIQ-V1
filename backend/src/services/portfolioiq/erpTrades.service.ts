// CF-ERP-EXPANSION-#7 (2026-06-03): trade transaction model + FMV-based
// proceeds allocation.
//
// Tax treatment: a trade is a TAXABLE disposition at FMV. NOT a like-kind
// swap (§1031 is real-property-only post-2017 TCJA — no basis carryover).
// Each outgoing card recognizes proceeds proportional to its FMV share of
// total outgoing FMV, applied to amountRealized.
//
// Formulae (cashToMe is SIGNED — positive received, negative paid):
//   amountRealized   = Σ FMV(incoming) + cashToMe
//   basisGivenUp     = Σ costBasis(outgoing)
//   realizedGainLoss = amountRealized − basisGivenUp
//   per outgoing card:
//     proceeds_i = amountRealized × (fmv_i / Σ fmv_outgoing)
//     gl_i       = proceeds_i − basis_i
//   Σ gl_i MUST equal realizedGainLoss (asserted in test).
//   incoming card basis = its FMV
//   balanceCheck = Σ FMV(outgoing) − amountRealized
//     >0: traded down (gave up more FMV than received)
//     <0: came out ahead
//     ==0: balanced trade
//
// FMV source labels propagate to the persisted trade record so a CPA can
// see which figures are CompIQ-derived vs user-attested.

export type FmvSource = "compiq" | "manual";

export interface TradeOutgoingInput {
  holdingId: string;
  fmvAtTrade: number;
  fmvSource: FmvSource;
}

export interface TradeIncomingInput {
  cardsightCardId?: string;
  cardTitle: string;
  grade?: string;
  fmvAtTrade: number;
  fmvSource: FmvSource;
}

export interface TradeOutgoingLeg extends TradeOutgoingInput {
  costBasis: number;
  proceeds: number;
  realizedGainLoss: number;
  ledgerEntryId: string;
}

export interface TradeIncomingLeg extends TradeIncomingInput {
  holdingId: string;   // newly-minted holding id
}

export interface TradeTotals {
  fmvOut: number;
  fmvIn: number;
  cashToMe: number;
  amountRealized: number;
  basisGivenUp: number;
  realizedGainLoss: number;
  balanceCheck: number;
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Pure FMV allocation. CALLER provides the outgoing costBasis values (from
 * holdings.totalCostBasis or computed); this function does the math and
 * returns per-leg proceeds + per-leg P&L, plus totals.
 *
 * `outgoingCostBases` MUST have length === outgoingFmvs.length and align by index.
 */
export interface AllocateProceedsInput {
  outgoingFmvs: ReadonlyArray<number>;
  outgoingCostBases: ReadonlyArray<number>;
  incomingFmvs: ReadonlyArray<number>;
  cashToMe: number;
}

export interface AllocateProceedsResult {
  perOutgoing: Array<{ proceeds: number; realizedGainLoss: number }>;
  totals: TradeTotals;
}

export function allocateTradeProceeds(input: AllocateProceedsInput): AllocateProceedsResult {
  const fmvOut = input.outgoingFmvs.reduce((acc, v) => acc + v, 0);
  const fmvIn = input.incomingFmvs.reduce((acc, v) => acc + v, 0);
  const cashToMe = input.cashToMe;
  const amountRealized = fmvIn + cashToMe;
  const basisGivenUp = input.outgoingCostBases.reduce((acc, v) => acc + v, 0);
  const realizedGainLoss = amountRealized - basisGivenUp;

  // Allocate amountRealized across outgoing legs by FMV share.
  // CRITICAL: round non-last legs first, then derive the LAST leg's
  // proceeds as the residual of the (rounded) amountRealized minus the
  // (rounded) earlier legs. This guarantees Σ rounded-proceeds equals the
  // rounded amountRealized exactly — no floating-point drift in the
  // user-visible totals.
  const rounded: Array<{ proceeds: number; realizedGainLoss: number }> = [];
  if (fmvOut <= 0) {
    // Degenerate (no outgoing FMV): zero per-leg proceeds.
    for (let i = 0; i < input.outgoingFmvs.length; i += 1) {
      rounded.push({ proceeds: 0, realizedGainLoss: r2(-input.outgoingCostBases[i]) });
    }
  } else {
    const roundedAmountRealized = r2(amountRealized);
    let allocatedRoundedSum = 0;
    for (let i = 0; i < input.outgoingFmvs.length; i += 1) {
      const isLast = i === input.outgoingFmvs.length - 1;
      let proceedsR: number;
      if (isLast) {
        proceedsR = r2(roundedAmountRealized - allocatedRoundedSum);
      } else {
        const raw = amountRealized * (input.outgoingFmvs[i] / fmvOut);
        proceedsR = r2(raw);
        allocatedRoundedSum += proceedsR;
      }
      const glR = r2(proceedsR - input.outgoingCostBases[i]);
      rounded.push({ proceeds: proceedsR, realizedGainLoss: glR });
    }
  }

  return {
    perOutgoing: rounded,
    totals: {
      fmvOut: r2(fmvOut),
      fmvIn: r2(fmvIn),
      cashToMe: r2(cashToMe),
      amountRealized: r2(amountRealized),
      basisGivenUp: r2(basisGivenUp),
      realizedGainLoss: r2(realizedGainLoss),
      balanceCheck: r2(fmvOut - amountRealized),
    },
  };
}
