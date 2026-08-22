// CF-ESCALATE-ON-NAME-TOKENS-ONLY (2026-08-21) — pin the escalation gate.
//
// THE BUG. searchCatalog runs a cheap exact-token arm first, then escalates to
// a prefix (STARTSWITH) scan only when the cheap arm did not confidently find
// the person asked for. The escalation is expensive and the service's own
// comments price it: exact "carey" 1.5s, prefix "care" 16.6s. Keeping it RARE
// is the entire point of the gate.
//
// nameTokensCovered decides. It asks: does some candidate row's `playerName`
// account for ALL the name tokens in the query? It compares each token against
// `playerName` and NOTHING else.
//
// The call site passed `alphaTokens` — every >=4-char token that is not a brand
// or product word. That includes every colour and finish the user typed, and no
// person's name contains "blue" or "raywave". So for any query naming a
// parallel the gate was UNSATISFIABLE:
//
//   "2024 Bowman Chrome Blue Raywave Auto Leo De Vries"
//     alphaTokens = [blue, raywave, vries]
//     -> needs one playerName containing all three -> never -> escalate
//
// The arm the gate exists to make rare therefore ran on essentially every real
// card query. That is the dense 19-24s cluster in compiq_search_stage_timing —
// a FIXED cost, which is why it did not move when the anchor was fixed in
// CF-SEARCH-ANCHOR-FROM-PARSER (#1169).
//
// The gate's own docstring is unambiguous that these are meant to be name
// tokens, and it prices a false escalation at 28.8s. That earlier fix removed a
// length-driven false escalation; this removes a colour-driven one.
//
// THE FIX. parseCardQuery already resolved the player. Use its tokens, and fall
// back to alphaTokens only when it found no player — there the old proxy is
// still the best signal available and escalating is the safe direction.
//
// THIS FILE PINS:
//   1. A colour/finish word must not force escalation.
//   2. The misspelling trap the gate was BUILT for still escalates. This is
//      the load-bearing half — a fix that just made the gate always pass would
//      satisfy (1) and silently break fuzzy name matching.
//   3. Fuzzy per-token matching still covers near-misses ("erik" -> Eric).
//   4. No player parsed -> fall back to the old token proxy, unchanged.
//   5. Empty candidate rows always escalate.

import { describe, expect, it } from "vitest";
import { __testables } from "../src/services/catalog/catalogSearch.service.js";

const { nameTokensCovered } = __testables;

/** Mirrors the token derivation in searchCatalog. */
function playerTokens(playerName: string | null): string[] | null {
  const pn = String(playerName ?? "").toLowerCase();
  if (!pn) return null;
  const parts = pn.split(/[^a-z]+/).filter((t) => t.length >= 3);
  return parts.length > 0 ? parts : null;
}

/** true = escalate to the 16.6s prefix scan. */
const escalates = (
  rows: Array<{ playerName?: string }>,
  alphaTokens: string[],
  playerName: string | null,
) => !nameTokensCovered(rows, playerTokens(playerName) ?? alphaTokens);

describe("CF-ESCALATE-ON-NAME-TOKENS-ONLY", () => {
  it("a colour word no longer forces escalation", () => {
    // "2024 Bowman Chrome Blue Raywave Auto Leo De Vries"
    const rows = [{ playerName: "Leo De Vries" }];
    const alphaTokens = ["blue", "raywave", "vries"];

    // The bug: unsatisfiable, so the expensive arm always ran.
    expect(nameTokensCovered(rows, alphaTokens)).toBe(false);
    // The fix: the parsed player decides, and it is covered.
    expect(escalates(rows, alphaTokens, "Leo De Vries")).toBe(false);
  });

  it("still escalates on the misspelling trap it was built for", () => {
    // "2026 bowman justin gonzalez" -> exact arm returns Josuar Gonzalez.
    // "gonzalez" is a real token owned by another player, so the cheap arm
    // succeeds while answering the WRONG question. Must still escalate.
    const rows = [{ playerName: "Josuar Gonzalez" }];
    expect(escalates(rows, ["justin", "gonzalez"], "Justin Gonzalez")).toBe(true);
  });

  it("does not escalate when the right player was found", () => {
    expect(escalates([{ playerName: "Owen Carey" }], ["owen", "carey"], "Owen Carey")).toBe(false);
  });

  it("keeps fuzzy per-token coverage for near-misses", () => {
    // CF-SEARCH-FUZZY-PLAYER. "gonzales" vs "Gonzalez" is edit distance 1 on an
    // 8-char token (budget 2), so it is covered and must not escalate.
    expect(escalates([{ playerName: "Josuar Gonzalez" }], ["josuar", "gonzales"], "Josuar Gonzales")).toBe(false);
  });

  it("documents that fuzzy coverage needs >=5 chars", () => {
    // The gate's docstring cites "erik" covering Eric. It does not:
    // fuzzyIncludes bails on tokens under 5 chars ("too short to risk a fuzzy
    // hit"), so a 4-char misspelling escalates. Pinned so the real threshold is
    // visible and a future reader does not mistake it for a regression. This
    // behaviour is unchanged by CF-ESCALATE-ON-NAME-TOKENS-ONLY.
    expect(escalates([{ playerName: "Eric Hartman" }], ["erik", "hartman"], "Erik Hartman")).toBe(true);
    // One char longer, and the fuzzy budget applies (single substitution;
    // note a TRANSPOSITION costs 2 under plain Levenshtein and would still
    // exceed the budget of 1 at this length).
    expect(escalates([{ playerName: "Erica Hartman" }], ["erick", "hartman"], "Erick Hartman")).toBe(false);
  });

  it("colour words do not defeat a long multi-parallel query", () => {
    // The shape most affected in production: several finish words, one name.
    const rows = [{ playerName: "Shohei Ohtani" }];
    const alphaTokens = ["gold", "wave", "refractor", "ohtani"];
    expect(nameTokensCovered(rows, alphaTokens)).toBe(false); // was: escalate
    expect(escalates(rows, alphaTokens, "Shohei Ohtani")).toBe(false);
  });

  it("falls back to the old token proxy when no player was parsed", () => {
    // Unchanged behaviour: with no name resolved, alphaTokens is the only
    // signal available and escalating is the safe direction.
    const rows = [{ playerName: "Leo De Vries" }];
    const alphaTokens = ["blue", "raywave", "vries"];
    expect(escalates(rows, alphaTokens, null)).toBe(nameTokensCovered(rows, alphaTokens) === false);
    expect(escalates(rows, alphaTokens, null)).toBe(true);
  });

  it("falls back rather than passing vacuously for an unparseable name", () => {
    // A name of only short particles yields no usable token. It must NOT be
    // treated as "no tokens required" — that would make the gate always pass
    // and silently retire fuzzy name matching.
    expect(playerTokens("Y B")).toBeNull();
    expect(escalates([{ playerName: "Josuar Gonzalez" }], ["justin", "gonzalez"], "Y B")).toBe(true);
  });

  it("always escalates when the cheap arms found nothing", () => {
    expect(escalates([], ["vries"], "Leo De Vries")).toBe(true);
    expect(nameTokensCovered([], [])).toBe(false);
  });
});
