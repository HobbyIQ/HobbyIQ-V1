/**
 * CF-ONE-PIECE-IS-NOT-A-BOWMAN-CARD (Drew, 2026-08-25).
 *
 * 30,829 One Piece and Naruto sales are filed under setKey `bowman`, and they
 * were still arriving on 2026-08-23. Sampled from prod:
 *
 *   hiq:anime-tcg:2025:bowman:eb02:base:no-auto
 *     "2025 One Piece Night X Los Angeles Dodgers Monkey D Luffy #EB02-010"
 *   hiq:anime-tcg:2002:bowman:301:base:no-auto
 *     "NARUTO CCG 2002 Rare #301 SUPREME NINJUTSU ..."
 *
 * The sport is right — CF-SPORT-PRIORITY-INVERT already made title detection
 * beat TCA's vendor tag. The SET is wrong, because `card_set` was still trusted
 * absolutely, and TCA mis-categorises a TCG card wholesale rather than one
 * field at a time.
 *
 * Our own parse needs no help here: inferSetKeyFromTitle returns "Unknown" for
 * every one of these titles. The vendor hint is the only thing introducing the
 * error, so the fix is to stop accepting it when the title has already said
 * this is not a sports card.
 */
import { describe, expect, it } from "vitest";
import { vendorSetNameHint } from "../src/routes/tcaWebhook.routes.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("a TCG card must not inherit a sports set from the vendor", () => {
  it("drops a sports product line when the title says anime-tcg", () => {
    expect(vendorSetNameHint("anime-tcg", "Bowman")).toBeNull();
    expect(vendorSetNameHint("anime-tcg", "Bowman Chrome")).toBeNull();
    expect(vendorSetNameHint("pokemon", "Topps Chrome")).toBeNull();
    expect(vendorSetNameHint("non-sport", "Panini Prizm")).toBeNull();
  });

  it("keeps a vendor set that is not a sports line — it is a real hint", () => {
    // Dropping every hint on TCG rows would trade one bug for a worse one.
    expect(vendorSetNameHint("anime-tcg", "One Piece OP07")).toBe("One Piece OP07");
    expect(vendorSetNameHint("pokemon", "Astral Radiance")).toBe("Astral Radiance");
  });

  it("never interferes with a sports card", () => {
    // catSport null = the title showed no non-sport marker.
    expect(vendorSetNameHint(null, "Bowman Chrome")).toBe("Bowman Chrome");
    expect(vendorSetNameHint(null, "Topps Update")).toBe("Topps Update");
  });

  it("treats an absent vendor set as no hint", () => {
    expect(vendorSetNameHint("anime-tcg", "")).toBeNull();
    expect(vendorSetNameHint(null, "   ")).toBeNull();
  });
});

describe("the titles that produced the bad rows", () => {
  const TITLES = [
    "2025 One Piece Night X Los Angeles Dodgers Monkey D Luffy #EB02-010 PSA 10",
    "2024 One Piece OP07 Japanese Manga Alternate Art #051 Boa Hancock PSA 10",
    "NARUTO CCG 2002 Rare #301 SUPREME NINJUTSU ONES OWN RULE CARD DIAMOND FOIL NM-MT",
    "2023 One Piece Kingdoms of Intrigue Nefeltari Vivi Secret Rare #OP04-118",
  ];

  it("our own parse already refuses to call these a sports set", () => {
    // This is why dropping the vendor hint is sufficient: nothing else was
    // claiming these are Bowman.
    for (const t of TITLES) expect(inferSetKeyFromTitle(t)).toBe("Unknown");
  });

  it("without the vendor hint the slug no longer lands in the bowman namespace", () => {
    // "Unknown" is an honest placeholder; `bowman` is a false claim about a
    // namespace we price against.
    const slug = computeHobbyIqCardId({
      sport: "anime-tcg", year: 2024, setKey: "Unknown",
      cardNumber: "051", parallel: "", isAuto: false, printRun: null,
    });
    expect(slug).toBe("hiq:anime-tcg:2024:unknown:051:base:no-auto");
    expect(slug).not.toContain(":bowman:");
  });

  it("a real Bowman card is untouched", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Chrome Slater de Brun BCP-151 Refractor"))
      .toBe("Bowman Chrome");
  });
});
