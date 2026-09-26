/**
 * CF-A-CARD-NUMBER-SUBSET-IS-NOT-A-WHOLE-PRODUCT (2026-09-25) -- the optional
 * card-number scope on `rekey-product-setkey`, pinned.
 *
 * THE NEED. R1/R2 (see the script's own header) move a WHOLE product from
 * FROM to TO. That is the wrong shape for a fold that is really a PARTIAL
 * split: 2026 Mega Box's BMA-/RMA-/BST-/ES- prefixes and its Mojo ladder sit
 * under `bowman-chrome` / `bowman-chrome-mega-box` alongside every OTHER
 * Bowman Chrome card number, and only the Mega Box numbers belong at
 * `bowman-mega`. A whole-product fold of `bowman-chrome` would sweep the base
 * Chrome ladder onto the wrong key. CARD_NUMBER_SCOPE narrows candidate
 * selection (both the setKey-field pass and the id-stem pass, in MODE=catalog,
 * plus the MODE=pool scan) to a comma-separated list of card-number PREFIXES
 * (`^<prefix>`, case-insensitive) or exact numbers, matched against the id's
 * own cardNumber segment.
 *
 * THE ENV. No new workflow_dispatch input: the runner has no spare slot (24 of
 * 25 used) and `titles` already carries TO_SETKEY for this script. The scope
 * rides the runner's EXISTING `card_numbers` input (-> BACKFILL_CARD_NUMBERS),
 * which this script never read before this change and which the runner
 * otherwise exports, unconditionally, to every dispatch's env regardless of
 * `script` -- the same shape every other per-script env line in that block
 * already assumes. It is consumed by exactly one other script
 * (backfill-cardsight-title-identity.cjs), a DIFFERENT `script` selection, so
 * the two can never read it in the same run.
 *
 * THE SHAPE OF THESE TESTS mirrors rekeyRetireUntwinned.test.ts and
 * rekeyRefusesCrossMarket.test.ts exactly: this script is a CJS ops script
 * whose main() builds a Cosmos client eagerly and has no module.exports, so it
 * cannot be `require`d directly without executing that main() (and failing on
 * a missing connection string) -- what is testable without prod is the
 * script's OWN contract: it must accept a valid dispatch and die only on the
 * connection string (proving the new option adds no refusal of its own), and
 * its filtering/reporting/reconciliation code must be pinned in the source.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "rekey-product-setkey.cjs");
const SRC = readFileSync(SCRIPT, "utf8");

function run(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe", timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** The 2026 Mega Box dispatch this ticket names: bowman-chrome -> bowman-mega,
 *  scoped to the Mega Box card-number prefixes. REPORT form (no APPLY). */
const MEGA_BOX = {
  MODE: "catalog",
  SPORT: "baseball",
  SETKEY: "bowman-chrome",
  TO_SETKEY: "bowman-mega",
  CARD_NUMBER_SCOPE: "bma-,rma-,bst-,es-",
  COSMOS_CONNECTION_STRING: "",
};

/** A no-scope dispatch: today's behaviour, byte-identical, before this option
 *  existed at all. */
const NO_SCOPE = { ...MEGA_BOX, CARD_NUMBER_SCOPE: "", BACKFILL_CARD_NUMBERS: "" };

// NOTE on ordering: COSMOS_CONNECTION_STRING is checked (and the process
// exits) BEFORE the startup banner ever prints -- true for every refusal test
// in this file, and already true of rekeyRetireUntwinned.test.ts's own
// "complete dispatch" case above. So these CLI runs prove a scoped dispatch
// reaches exactly as far as an unscoped one (no new refusal), and the banner's
// CONTENT is pinned separately, in source, below.
describe("CARD_NUMBER_SCOPE is optional and adds no refusal of its own", () => {
  it("a scoped dispatch gets PAST every refusal and dies on the missing connection string", () => {
    const r = run(MEGA_BOX);
    expect(r.code).toBe(1);
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
  });

  it("an unscoped dispatch behaves exactly the same way -- no scope is not a refusal", () => {
    const r = run(NO_SCOPE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
  });

  it("MODE=pool also accepts the scope (YEAR required, as always) and reaches the same refusal", () => {
    const r = run({ ...MEGA_BOX, MODE: "pool", YEARS: "2026" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
  });

  it("MODE=pool still refuses on a missing YEAR even with the scope set -- the new option changes no existing refusal", () => {
    const r = run({ ...MEGA_BOX, MODE: "pool", YEARS: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("MODE=pool requires YEAR");
  });
});

describe("the scope travels on the runner's EXISTING `card_numbers` input, no new one", () => {
  it("BACKFILL_CARD_NUMBERS (the runner's env name for `card_numbers`) works standalone, no refusal", () => {
    const r = run({ ...MEGA_BOX, CARD_NUMBER_SCOPE: "", BACKFILL_CARD_NUMBERS: "bma-,rma-,bst-,es-" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("COSMOS_CONNECTION_STRING not set");
  });

  it("CARD_NUMBER_SCOPE and BACKFILL_CARD_NUMBERS are both read (the source decides precedence, pinned below)", () => {
    expect(SRC).toContain('process.env.CARD_NUMBER_SCOPE || process.env.BACKFILL_CARD_NUMBERS || ""');
  });

  it("no NEW workflow_dispatch input was introduced for this feature", () => {
    // Same style of proof rekeyRetireUntwinned.test.ts uses for its own flags:
    // no invented `inputs.<name>` for this feature anywhere in the workflow.
    const wf = readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(wf).not.toContain("inputs.card_number_scope");
    // ...and the workflow already carries `card_numbers` -> BACKFILL_CARD_NUMBERS
    // unconditionally, the line this feature relies on rather than adding to.
    expect(wf).toContain("BACKFILL_CARD_NUMBERS: ${{ inputs.card_numbers }}");
  });

  it("the self-relaunch dispatch forwards card_numbers, so a budget-hit continuation keeps the scope", () => {
    const wf = readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const line = wf.split("\n").find((l) => l.includes("script=rekey-product-setkey") && l.includes("gh workflow run"));
    expect(line, "the rekey-product-setkey relaunch dispatch line must exist").toBeTruthy();
    expect(line).toContain('-f card_numbers="${{ inputs.card_numbers }}"');
  });
});

describe("the source: where the filter is applied, and what it does NOT change", () => {
  it("inCardNumberScope delegates to card-number-scope.cjs, not an inline reimplementation", () => {
    // The subset-segment bug (fixed in cardNumberScope.test.ts's own suite)
    // lives in ONE place now -- a caller cannot silently regress to reading
    // a literal [4] because there is no id-parsing logic left in this file
    // to regress.
    expect(SRC).toContain('require(path.join(__dirname, "lib", "card-number-scope.cjs"))');
    expect(SRC).toContain("const { matchesCardNumberScope } =");
    expect(SRC).toContain("function inCardNumberScope(id) {\n  return matchesCardNumberScope(id, CARD_NUMBER_SCOPE);\n}");
    // and NOT an inline split(":")[4] anywhere in this script -- that read
    // belongs to card-number-scope.cjs alone now.
    expect(SRC).not.toContain('.split(":")[4]');
  });

  it("MODE=catalog: the filter runs in the SAME candidates filter both scan passes share, and passes the WHOLE id", () => {
    // Both the setKey-field pass and the id-stem pass build `candidates` from
    // this one filter -- so a single change covers both, and a filter placed
    // in only one pass's own branch would be the bug this test catches.
    // Passing the whole `d.id` (not a pre-sliced segment) is deliberate: the
    // segment-vs-subset decision belongs entirely to card-number-scope.cjs.
    const block = SRC.slice(SRC.indexOf("const candidates = rows.filter"), SRC.indexOf("for (let i = 0; i < candidates.length"));
    expect(block).toContain("inCardNumberScope(d.id)");
    expect(block).toContain("s.cardNumberOutOfScope++");
  });

  it("MODE=catalog: out-of-scope rows are filtered BEFORE the per-row dedup, not after", () => {
    // `seen` is checked a second time here deliberately: the id-stem pass and
    // the setKey-field pass can both see the same row, and without this the
    // counter would double-count a row both passes reach.
    const block = SRC.slice(SRC.indexOf("const candidates = rows.filter"), SRC.indexOf("for (let i = 0; i < candidates.length"));
    expect(block).toContain("if (seen.has(String(d.id))) return false;");
  });

  it("MODE=catalog: an out-of-scope row is excluded from BOTH scanned and skipped", () => {
    // scanned: the filter runs before the per-row closure that does `s.scanned++`.
    const scanIdx = SRC.indexOf("s.scanned++");
    const candIdx = SRC.indexOf("const candidates = rows.filter");
    expect(candIdx).toBeLessThan(scanIdx);
    // skipped: the reconciliation sum for MODE=catalog must not add the counter.
    const skippedLine = SRC.slice(SRC.indexOf("const skipped = s.stemMismatch"), SRC.indexOf("reconcile(\"rekey-product-setkey:catalog\""));
    expect(skippedLine).not.toContain("cardNumberOutOfScope");
  });

  it("MODE=pool: the filter runs alongside the shard filter, passes the WHOLE hobbyiqCardId, before scanned counts the row", () => {
    const block = SRC.slice(SRC.indexOf("const mine = rows.filter"), SRC.indexOf("for (let i = 0; i < mine.length"));
    expect(block).toContain("inCardNumberScope(r.hobbyiqCardId)");
    expect(block).toContain("s.cardNumberOutOfScope++");
    const mineIdx = SRC.indexOf("const mine = rows.filter");
    const scannedIdx = SRC.indexOf("s.scanned += batch.length");
    expect(mineIdx).toBeLessThan(scannedIdx);
  });

  it("MODE=pool: an out-of-scope row is excluded from the reconciliation's skipped term", () => {
    const reconcileCall = SRC.slice(SRC.indexOf("reconcile(\"rekey-product-setkey:pool\""), SRC.indexOf("reconcile(\"rekey-product-setkey:pool\"") + 220);
    expect(reconcileCall).not.toContain("cardNumberOutOfScope");
  });

  it("the banner line is printed in both modes (plus the doc header mention)", () => {
    expect(SRC).toContain("LEFT: card-number out of scope");
    // one console.log per mode's report block, plus the doc-comment header.
    const printed = SRC.match(/console\.log\(`  LEFT: card-number out of scope/g) ?? [];
    expect(printed.length).toBe(2);
  });

  it("the startup banner states the scope in its own line (pinned in source: unreachable via CLI, the connection-string check exits first)", () => {
    expect(SRC).toContain(
      '`  card-number scope  ${HAS_CARD_NUMBER_SCOPE ? `${CARD_NUMBER_SCOPE.join(",")}  (prefix or exact match on the id\'s cardNumber segment)` : "(none -- every card number in FROM is in scope)"}`',
    );
  });

  it("MODE=holdings is untouched -- the ticket scoped this to catalog and pool only", () => {
    const holdingsFn = SRC.slice(SRC.indexOf("async function rekeyHoldings"), SRC.indexOf("// ── shared reporting"));
    expect(holdingsFn).not.toContain("inCardNumberScope");
    expect(holdingsFn).not.toContain("cardNumberOutOfScope");
  });

  it("the comment block documents the subset-id case (sub-{slug} pushes the number to index 5)", () => {
    expect(SRC).toContain("THE CARD-NUMBER SEGMENT IS NOT ALWAYS INDEX 4");
    expect(SRC).toContain("subsetInId");
  });

  it("the undocumented direct-env override (CARD_NUMBER_SCOPE, read before BACKFILL_CARD_NUMBERS) is explained in the comment, not silent", () => {
    expect(SRC).toContain("CARD_NUMBER_SCOPE has no runner-facing default of its own");
    expect(SRC).toContain("it is not itself a\n// second input, just an alternate spelling of the one input this feature\n// uses");
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────

describe("MUTATION: inCardNumberScope's wiring in this script", () => {
  it("a mutant that inverted HAS_CARD_NUMBER_SCOPE's role would refuse every dispatch that sets no scope", () => {
    // HAS_CARD_NUMBER_SCOPE / CARD_NUMBER_SCOPE still live in THIS file (env
    // parsing does not belong in the pure lib) and are handed to the lib's
    // matchesCardNumberScope as `scopeList` -- an empty list there means
    // "everything is in scope", pinned directly in cardNumberScope.test.ts.
    expect(SRC).toContain("const HAS_CARD_NUMBER_SCOPE = CARD_NUMBER_SCOPE.length > 0;");
  });

  it("a mutant that read the setKey segment instead of delegating to the id-aware helper would filter the wrong axis", () => {
    // Both call sites pass the id/hobbyiqCardId UNSLICED -- a mutant that
    // reintroduced any manual segment slicing here (setKey at index 3, or a
    // literal cardNumber index) would show up as a diff against these exact
    // call shapes.
    expect(SRC).toContain("inCardNumberScope(d.id)");
    expect(SRC).toContain("inCardNumberScope(r.hobbyiqCardId)");
  });

  it("a mutant that reverted the extraction to a literal [4] is caught in cardNumberScope.test.ts, not here", () => {
    // This file pins WIRING (who calls what, with what argument, and where).
    // The extraction RULE itself (index 4 vs 5, the sub- prefix check) is
    // pinned as a real unit test against plain strings in
    // tests/cardNumberScope.test.ts, which is the only place a revert to
    // `.split(":")[4]` can be mechanically caught -- this file no longer
    // contains that logic to mutate.
    expect(SRC).not.toContain('.split(":")[4]');
  });
});
