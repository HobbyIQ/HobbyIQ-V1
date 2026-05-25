// Unit test for CF-BACKTEST-DETERMINISTIC — verifies the OpenAI call site in
// pricing.ts uses the locked temperature + seed config.
//
// Why this test exists: prior multi-run backtests at default temperature
// returned unstable_high_variance verdicts (sign-stability 0.4-0.6 across 5
// repeats — see docs/phase0/backtest_runs/20260524-224322-n15-r5/multirun_summary.md).
// This test guards the lock from accidental regression.
//
// Run: cd mcp-server && npx tsx --test scripts/pricing_deterministic.test.ts

import { describe, it, before } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// pricing.ts instantiates the OpenAI client at module load. In test
// environment we have no real key; supply a dummy value so the constructor
// succeeds. The client is never actually called by this test (we only import
// the const + read the source file). Using dynamic import inside before()
// because ESM static imports are hoisted before the env-var assignment runs.
let OPENAI_DETERMINISTIC_CONFIG: { readonly temperature: number; readonly seed: number };

before(async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-dummy-key";
  const mod = await import("../pricing.js");
  OPENAI_DETERMINISTIC_CONFIG = mod.OPENAI_DETERMINISTIC_CONFIG;
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("CF-BACKTEST-DETERMINISTIC — OPENAI_DETERMINISTIC_CONFIG export", () => {
  it("locks temperature to 0", () => {
    assert.equal(
      OPENAI_DETERMINISTIC_CONFIG.temperature,
      0,
      "temperature must be 0 — anything else reintroduces sampling noise",
    );
  });

  it("locks seed to the canonical value (42)", () => {
    assert.equal(
      OPENAI_DETERMINISTIC_CONFIG.seed,
      42,
      "seed must be the fixed canonical value — changing it invalidates prior backtest baselines",
    );
  });

  it("does not accidentally include other sampling params", () => {
    // Defensive: top_p, frequency_penalty, presence_penalty all introduce
    // additional sampling variation. Adding any of them silently here would
    // undo the determinism contract. If a future change deliberately adds
    // one, this test should be updated to reflect the new contract.
    const keys = Object.keys(OPENAI_DETERMINISTIC_CONFIG);
    assert.deepEqual(keys.sort(), ["seed", "temperature"]);
  });
});

describe("CF-BACKTEST-DETERMINISTIC — call site uses the lock", () => {
  it("pricing.ts spreads OPENAI_DETERMINISTIC_CONFIG into chat.completions.create", () => {
    // Source-level assertion: the chat.completions.create call must spread the
    // locked config so any future code change that drops the spread is caught
    // here. Reading the source rather than mocking the OpenAI client keeps
    // this test fast + side-effect-free.
    const pricingTs = fs.readFileSync(
      path.join(__dirname, "..", "pricing.ts"),
      "utf8",
    );

    // Find the chat.completions.create({ ... }) block.
    const match = pricingTs.match(
      /openai\.chat\.completions\.create\(\s*\{([\s\S]*?)\}\s*\)/,
    );
    assert.ok(
      match,
      "Could not locate openai.chat.completions.create({...}) call in pricing.ts — test needs updating if the call site moved",
    );

    const callBody = match![1];
    assert.match(
      callBody,
      /\.\.\.OPENAI_DETERMINISTIC_CONFIG/,
      "chat.completions.create call must spread OPENAI_DETERMINISTIC_CONFIG so temperature + seed are locked at every prediction site",
    );
  });
});
