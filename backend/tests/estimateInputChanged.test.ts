// CF-PHOTO-PATCH-LATENCY (2026-08-12) — the reprice gate on
// PATCH /api/portfolio/holdings/:id.
//
// The incident this pins: `updateHolding` awaited `autoPriceHolding` on EVERY
// patch, which runs a full `computeEstimate`. Drew attached a photo to two
// holdings from the web client; the blob upload succeeded both times and the
// follow-up PATCH is what broke. App Insights for the two cards:
//
//     well-comped card                  260 Cosmos deps    1.76s   200
//     2026 Bowman Chrome, 0 comps       911 Cosmos deps   15.64s   200
//
// On the first attempt at the slow card the PATCH never reached the server —
// preflight 204, then a full page refetch, because the client aborted. The
// photo eventually landed on retry, but the UI reported failure.
//
// A photo URL cannot move an FMV, so the gate asks whether the patch changed
// anything computeEstimate actually READS. Two properties matter most and are
// tested here: it must never skip a patch that could move the price, and it
// must fail open when it cannot tell.

import { describe, it, expect } from "vitest";
import {
  estimateInputChanged,
  buildEstimateRequestFromHolding,
} from "../src/services/portfolioiq/portfolioStore.service";
import type { PortfolioHolding } from "../src/types/portfolioiq.types";

const BASE = {
  id: "h-1",
  playerName: "Paul Skenes",
  cardYear: 2024,
  product: "Bowman Chrome",
  parallel: "Base",
  isAuto: false,
  quantity: 1,
  purchasePrice: 120,
  gradingCompany: "PSA",
  gradeValue: 10,
} as unknown as PortfolioHolding;

const patch = (over: Record<string, unknown>) =>
  ({ ...(BASE as object), ...over }) as unknown as PortfolioHolding;

describe("skips the reprice — nothing the engine reads has changed", () => {
  it("photo attach (the reported bug)", () => {
    expect(estimateInputChanged(BASE, patch({ photoUrl: "https://blob/x.jpg" }))).toBe(false);
  });

  it("a second photo appended", () => {
    const withOne = patch({ photoUrls: ["https://blob/a.jpg"] });
    const withTwo = patch({ photoUrls: ["https://blob/a.jpg", "https://blob/b.jpg"] });
    expect(estimateInputChanged(withOne, withTwo)).toBe(false);
  });

  it("notes edit", () => {
    expect(estimateInputChanged(BASE, patch({ notes: "corner ding" }))).toBe(false);
  });

  it("quantity bump", () => {
    // Quantity scales position value downstream; it is not a computeEstimate
    // input, so the per-card FMV cannot move.
    expect(estimateInputChanged(BASE, patch({ quantity: 3 }))).toBe(false);
  });

  it("identical no-op patch", () => {
    expect(estimateInputChanged(BASE, patch({}))).toBe(false);
  });
});

describe("still reprices — the patch moved a pricing input", () => {
  const REPRICE: Array<[string, Record<string, unknown>]> = [
    ["playerName", { playerName: "Jackson Holliday" }],
    ["cardYear", { cardYear: 2023 }],
    ["product", { product: "Topps Chrome" }],
    ["parallel", { parallel: "Gold Refractor" }],
    ["isAuto", { isAuto: true }],
    ["gradingCompany", { gradingCompany: "BGS" }],
    ["gradeValue", { gradeValue: 9 }],
    ["cardId", { cardId: "hiq:baseball:2024:bowman-chrome:85:base:no-auto" }],
    ["parallelId", { parallelId: "par-123" }],
    ["purchasePrice", { purchasePrice: 400 }],
    ["isBlackLabel", { isBlackLabel: true }],
  ];

  it.each(REPRICE)("%s change reprices", (_label, over) => {
    expect(estimateInputChanged(BASE, patch(over))).toBe(true);
  });

  it("clearing a grade back to Raw reprices", () => {
    // The PSA 10 -> Raw conversion is a real FMV move and must not be skipped.
    // Also covered end-to-end by patchHoldingRawClear.test.ts.
    const raw = patch({ gradingCompany: undefined, gradeValue: undefined });
    expect(estimateInputChanged(BASE, raw)).toBe(true);
  });

  it("pinning a cardId flips pinnedAuthoritative and reprices", () => {
    const unpinned = patch({ cardId: undefined });
    const pinned = patch({ cardId: "hiq:baseball:2024:bowman-chrome:85:base:no-auto" });
    expect(buildEstimateRequestFromHolding(unpinned).pinnedAuthoritative).toBe(false);
    expect(buildEstimateRequestFromHolding(pinned).pinnedAuthoritative).toBe(true);
    expect(estimateInputChanged(unpinned, pinned)).toBe(true);
  });
});

describe("fails open", () => {
  it("absent previous reprices", () => {
    // A first write has nothing to compare against; never skip on unknown.
    expect(estimateInputChanged(undefined, BASE)).toBe(true);
  });

  it("a throwing comparison reprices rather than skipping", () => {
    // Force the throw where the builder actually reads. A circular reference
    // does NOT work here: buildEstimateRequestFromHolding copies scalars into
    // a fresh object, so the cycle never reaches JSON.stringify and the gate
    // correctly reports "unchanged". The failure mode worth guarding is the
    // builder itself throwing.
    const poison = {} as PortfolioHolding;
    Object.defineProperty(poison, "playerName", {
      get() { throw new Error("corrupt holding"); },
      enumerable: true,
    });
    expect(estimateInputChanged(poison, BASE)).toBe(true);
  });
});

describe("the gate tracks the engine input, not a hand-listed field set", () => {
  it("agrees with buildEstimateRequestFromHolding on every key it emits", () => {
    // The anti-drift property: if changing a field changes the engine request,
    // the gate MUST report changed. Walk the request's own keys so a newly
    // added engine input is covered the day it lands.
    const req = buildEstimateRequestFromHolding(BASE) as Record<string, unknown>;
    for (const key of Object.keys(req)) {
      const mutated = patch({
        // Perturb via the holding fields that feed this request key.
        playerName: key === "playerName" ? "Someone Else" : BASE.playerName,
        cardYear: key === "cardYear" ? 1999 : (BASE as any).cardYear,
        product: key === "product" ? "Topps Finest" : (BASE as any).product,
        parallel: key === "parallel" ? "Orange Refractor" : (BASE as any).parallel,
        isAuto: key === "isAuto" ? !BASE.isAuto : BASE.isAuto,
        gradingCompany: key === "gradeCompany" ? "SGC" : (BASE as any).gradingCompany,
        gradeValue: key === "gradeValue" ? 8 : (BASE as any).gradeValue,
        purchasePrice: key === "purchasePrice" ? 999 : (BASE as any).purchasePrice,
      });
      const engineMoved =
        JSON.stringify(buildEstimateRequestFromHolding(BASE)) !==
        JSON.stringify(buildEstimateRequestFromHolding(mutated));
      expect(estimateInputChanged(BASE, mutated), `${key}`).toBe(engineMoved);
    }
  });

  it("is symmetric — direction of the edit does not matter", () => {
    const a = patch({ parallel: "Base" });
    const b = patch({ parallel: "Gold Refractor" });
    expect(estimateInputChanged(a, b)).toBe(estimateInputChanged(b, a));
  });
});
