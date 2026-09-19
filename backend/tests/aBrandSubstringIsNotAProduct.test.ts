/**
 * CF-A-BRAND-SUBSTRING-IS-NOT-A-PRODUCT (R67 prerequisite, 2026-09-19).
 *
 * R67 keys a named insert on its own product key, `<product>-<insert-slug>`.
 * Measured across the six staged checklistinsider products, 1,228 such keys
 * are proposed and EIGHTEEN of them fold onto a DIFFERENT MANUFACTURER'S
 * PRODUCT before this fix:
 *
 *   panini-photogenic-troops-tribute{,-black,-blue,-gold,-orange,-pink,
 *     -purple,-red,-silver}                        -> topps-tribute
 *   panini-zenith-contenders-optic-rookie-ticket[-variation]-rps-preview
 *     {,-blue,-green,-red}                         -> panini-contenders-optic
 *
 * Two unanchored brand patterns cause it. `[/topps-tribute/]` matches those
 * letters ANYWHERE, and Panini Photogenic has an insert set called "Troops
 * Tribute". The Contenders Optic rule is anchored at its own edges but matches
 * the phrase anywhere in a key, and 2024 Zenith carries two insert sets whose
 * own names quote that product ("Contenders Optic Rookie Ticket RPS Preview").
 *
 * A Zenith card is not a Contenders card because Zenith printed a preview of
 * one, and a Panini insert is not a Topps product because both say "Tribute".
 * Writing those rows to the other manufacturer's key is strictly worse than
 * the flagship fold it replaces.
 *
 * THE COLOUR CHILDREN FOLD ONTO THEIR PARENT, AND THAT IS R67. Under the
 * ruling the colour is the PARALLEL and only the parent root is a key, so
 * `…-troops-tribute-black` answering `…-troops-tribute` is the correct answer,
 * not a miss. What must never happen is either of them answering another
 * manufacturer. Both facts are pinned below.
 */
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const TROOPS = "panini-photogenic-troops-tribute";
const RPS = "panini-zenith-contenders-optic-rookie-ticket-rps-preview";
const RPS_VAR = "panini-zenith-contenders-optic-rookie-ticket-variation-rps-preview";

describe("a brand substring is not a product", () => {
  it("the two parent roots are FIXED POINTS", () => {
    for (const k of [TROOPS, RPS, RPS_VAR]) {
      expect(normalizeSetKey(k, "football"), k).toBe(k);
    }
  });

  it("their colour children fold onto their OWN parent — R67, the colour is the parallel", () => {
    for (const c of ["black", "blue", "gold", "orange", "pink", "purple", "red", "silver"]) {
      expect(normalizeSetKey(`${TROOPS}-${c}`, "football"), c).toBe(TROOPS);
    }
    for (const c of ["blue", "green", "red"]) {
      expect(normalizeSetKey(`${RPS}-${c}`, "football"), c).toBe(RPS);
      expect(normalizeSetKey(`${RPS_VAR}-${c}`, "football"), c).toBe(RPS_VAR);
    }
  });

  it("NOTHING reaches another manufacturer's product — the defect itself", () => {
    const all = [TROOPS, RPS, RPS_VAR];
    for (const c of ["", "-black", "-blue", "-red", "-silver"]) {
      for (const k of all) {
        const got = normalizeSetKey(`${k}${c}`, "football");
        expect(got, `${k}${c} reached topps-tribute`).not.toBe("topps-tribute");
        expect(got, `${k}${c} reached panini-contenders-optic`).not.toBe("panini-contenders-optic");
      }
    }
  });

  it("the LONGER Zenith sibling is not claimed by the shorter rule", () => {
    // `…-rookie-ticket-rps-preview` is not a prefix of the Variation key, but
    // the ordering is what guarantees it stays that way if either is edited.
    expect(normalizeSetKey(RPS_VAR, "football")).toBe(RPS_VAR);
    expect(normalizeSetKey(RPS_VAR, "football")).not.toBe(RPS);
  });

  // ── MUTATION: the products being protected FROM must be unharmed ──────────

  it("MUTATION: Topps Tribute still answers itself", () => {
    expect(normalizeSetKey("topps-tribute", "baseball")).toBe("topps-tribute");
    expect(normalizeSetKey("topps-tribute", "football")).toBe("topps-tribute");
    expect(normalizeSetKey("2024 Topps Tribute", "baseball")).toBe("topps-tribute");
  });

  it("MUTATION: Contenders Optic and its playoff spelling are untouched", () => {
    expect(normalizeSetKey("panini-contenders-optic", "football")).toBe("panini-contenders-optic");
    expect(normalizeSetKey("playoff-contenders-optic", "football")).toBe("panini-contenders-optic");
    expect(normalizeSetKey("contenders-optic", "football")).toBe("panini-contenders-optic");
    expect(normalizeSetKey("panini-contenders", "football")).toBe("panini-contenders");
  });

  it("MUTATION: both host flagships are untouched", () => {
    expect(normalizeSetKey("panini-photogenic", "football")).toBe("panini-photogenic");
    expect(normalizeSetKey("panini-zenith", "football")).toBe("panini-zenith");
  });
});
