/**
 * CF-A-SCOPE-DIR-IS-A-COPY-OR-IT-IS-A-FORK (R65 follow-up, 2026-09-18).
 *
 * `backend/data/checklists/tcgdex-ja-sv10/` exists for ONE reason: the runner
 * hands `ingest-checklist-csv-to-catalog.cjs` a whole DIRECTORY (`DIR:
 * ${{ inputs.scope }}`), and that ingester has no per-file filter -- selection
 * is `fs.readdirSync(DIR)` plus shard maths. Pointing `scope` at the 52-file
 * lane directory to land ONE new product would re-upsert the other 51:
 *
 *   would ingest 7,182 rows    <- the whole lane
 *   would ingest   132 rows    <- this directory
 *
 * and that re-upsert is NOT a no-op. `upsertCatalogEntry` calls
 * `c.items.upsert(merged)` unconditionally -- no equality check, no early
 * return -- and `mergeCatalogEntries` stamps `lastSeenAt: now` on every merge.
 * 7,050 unrelated rows would take a fresh timestamp and a new ETag, which is
 * the churn that preceded the 09-14 Bush/Mantle incident.
 *
 * -- WHY A COPY AND NOT A MOVE -----------------------------------------------
 *
 * The obvious move -- relocate the package out of `tcgdex-ja-modern/` -- is
 * wrong, and the class guards are why. Both R65 pins iterate that directory:
 *
 *   "no staged JA manifest declares a setKey an ENGLISH set owns"
 *   "the staged FILENAME carries the same ruled key as its manifest"
 *
 * Moving `ja-sv10` out would drop the lane to 51 files, force the `stages 52
 * products` pin to be weakened, and -- the real cost -- remove the one product
 * those guards were written for from the sweep that protects it. A copy keeps
 * the coverage.
 *
 * -- WHICH MAKES DRIFT THE NEW RISK, SO IT IS PINNED HERE --------------------
 *
 * Two directories holding one package is a fork waiting to happen: a later fix
 * to the lane copy that misses this one would ship a manifest claiming the
 * English key again, by the back door, past guards that only ever look at
 * `tcgdex-ja-modern/`. So the contract is BYTE EQUALITY with the lane copy,
 * plus the same class rules applied here directly rather than by implication.
 *
 * THIS DIRECTORY IS DISPOSABLE. It exists to scope one APPLY and may be
 * deleted afterwards -- see its README. When it goes, this file goes with it,
 * and the `absent` branch below keeps that a one-step deletion rather than a
 * red suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { POKEMON_EN_SET_CODES, POKEMON_JA_SET_CODES } from "../src/services/catalog/pokemonSetCodes.js";

const DATA = path.resolve(__dirname, "..", "data", "checklists");
const SCOPE_DIR = path.join(DATA, "tcgdex-ja-sv10");
const LANE_DIR = path.join(DATA, "tcgdex-ja-modern");

const EN_CODES = new Set(Object.keys(POKEMON_EN_SET_CODES));
const JA_CODES = new Set(Object.keys(POKEMON_JA_SET_CODES));

/** The scope dir is disposable: when it is deleted these pins retire with it. */
const present = fs.existsSync(SCOPE_DIR);

describe.skipIf(!present)("the ja-sv10 scope directory is a copy, never a fork", () => {
  const files = present
    ? fs.readdirSync(SCOPE_DIR).filter((f) => !f.startsWith("README")).sort()
    : [];

  it("holds exactly one package — a second one defeats the whole point", () => {
    // If this directory ever holds two CSVs, scoping to it stops meaning "one
    // product" and the 132-vs-7,182 isolation above quietly stops holding.
    const csvs = files.filter((f) => f.endsWith(".csv"));
    expect(csvs).toEqual(["2025-ja-sv10-pokemon.csv"]);
  });

  it("every file is BYTE-IDENTICAL to the lane copy", () => {
    for (const f of files) {
      const here = fs.readFileSync(path.join(SCOPE_DIR, f));
      const lanePath = path.join(LANE_DIR, f);
      expect(fs.existsSync(lanePath), `${f} has no counterpart in tcgdex-ja-modern/`).toBe(true);
      expect(here.equals(fs.readFileSync(lanePath)), `${f} has DRIFTED from the lane copy`).toBe(true);
    }
  });

  it("the manifest does not declare a setKey an ENGLISH set owns", () => {
    // The R65 class rule, applied HERE rather than inherited by implication.
    // EN-owned is derived from the committed tables, never a hand list.
    const m = JSON.parse(fs.readFileSync(path.join(SCOPE_DIR, "2025-ja-sv10-pokemon.manifest.json"), "utf8"));
    const key = String(m.setKey ?? "").trim().toLowerCase();
    expect(key).toBe("ja-sv10");
    expect(EN_CODES.has(key) && !JA_CODES.has(key), `setKey "${key}" is an English key`).toBe(false);
  });

  it("the FILENAME carries the same ruled key as the manifest", () => {
    // productOf() parses the stem when a sidecar is missing, so a corrected
    // manifest beside an uncorrected filename still mints on the English key.
    const m = JSON.parse(fs.readFileSync(path.join(SCOPE_DIR, "2025-ja-sv10-pokemon.manifest.json"), "utf8"));
    expect("2025-ja-sv10-pokemon").toBe(`${m.year}-${m.setKey}-pokemon`);
  });

  it("says in writing why it exists and that it may be deleted", () => {
    const readme = files.length >= 0 ? path.join(SCOPE_DIR, "README.md") : "";
    expect(fs.existsSync(readme), "the scope dir needs a README stating it is disposable").toBe(true);
    const text = fs.readFileSync(readme, "utf8");
    expect(text).toMatch(/scope/i);
    expect(text).toMatch(/delete/i);
  });
});
