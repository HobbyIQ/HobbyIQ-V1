// CF-GRADER-STATUS-FIELD (2026-06-28) — pins the new first-class
// graderStatus field's persistence + wire echo + accepted values.
//
// Drew: "I want it to be part of people's inventory" — distinct from
// the existing `status` field. Tracks the physical/logistical state of
// the card itself (at grader, in transit, in hand). Future autopricing
// can derate confidence on cards the user can't physically react with.
//
// THIS FILE PINS:
//   1. composeHoldingWireShape echoes graderStatus
//   2. All four canonical values pass through
//   3. Absent field stays absent (no default fabrication)
//   4. Unknown string still passes through (server-side validation is
//      a separate concern; trust the type system + client validation)

import { describe, expect, it } from "vitest";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function base(): PortfolioHolding {
  return {
    id: "test-id",
    playerName: "Test Player",
    cardYear: 2025,
    setName: "Test Set",
    parallel: "Base",
    quantity: 1,
    purchasePrice: 100,
  };
}

describe("composeHoldingWireShape — graderStatus echo", () => {
  it("absent on input → absent on wire", () => {
    const wire = composeHoldingWireShape(base());
    expect(wire.graderStatus).toBeUndefined();
  });

  it("'available' echoed as-is", () => {
    const wire = composeHoldingWireShape({ ...base(), graderStatus: "available" });
    expect(wire.graderStatus).toBe("available");
  });

  it("'at_psa' echoed as-is", () => {
    const wire = composeHoldingWireShape({ ...base(), graderStatus: "at_psa" });
    expect(wire.graderStatus).toBe("at_psa");
  });

  it("'pending_redemption' echoed as-is", () => {
    const wire = composeHoldingWireShape({ ...base(), graderStatus: "pending_redemption" });
    expect(wire.graderStatus).toBe("pending_redemption");
  });

  it("'in_route' echoed as-is", () => {
    const wire = composeHoldingWireShape({ ...base(), graderStatus: "in_route" });
    expect(wire.graderStatus).toBe("in_route");
  });
});
