/**
 * CF-A-COMP-EMIT-KNOWS-THE-CARD-IT-ASKED-ABOUT /
 * CF-A-ROW-SHOULD-NAME-ITS-WRITER (Fable, 2026-09-19).
 *
 * THE DEFECT. The Sold Comps Cleanliness Canary breached on
 * `MISSING hobbyiqCardId 6.50%` (limit 5.00%), climbing 0 → 2.86 → 4.58 → 6.50.
 * All 320 missing rows were `source: "cardhedge"`; 259 had no `sport` at all.
 *
 * `sport` is the FIRST segment of `hiq:<sport>:<year>:<setKey>:…`, so a row
 * without one can never be minted a slug and lands in the pool unaddressable.
 *
 * WHERE THEY CAME FROM, pinned by the external-id template
 * `{cardId}::{soldAt}::{priceInCents}::{gradeLabel}`:
 * `cardsight.router.ts` → `recordSoldComp({ source: "cardhedge", … })`. That
 * payload carried playerName, cardYear, setName, parallel, cardNumber and
 * isAuto — everything except sport, which `CardIdentityHint` did not even
 * have a field for.
 *
 * NOT a CardHedge feed change: `ch_daily_sales` holds ZERO rows for these
 * card_ids, so the `group`-field mapping never ran on them. NOT the 21:58Z
 * deploy either: the earliest such row is 07:45Z, ~14 h earlier, and 114,035
 * null-sport `cardhedge` rows predate 09-18 entirely. The defect is
 * long-standing; only the measurement is new.
 */
import { describe, expect, it } from "vitest";

const read = async (p: string) => {
  const fs = await import("node:fs");
  return fs.readFileSync(new URL(p, import.meta.url), "utf8");
};

describe("the CH comp emit passes the sport it already knows", () => {
  it("CardIdentityHint HAS a sport field", async () => {
    const src = await read("../src/services/compiq/cardsight.router.ts");
    const iface = src.slice(src.indexOf("export interface CardIdentityHint"));

    // MUTATION CHECK: the field did not exist, so the emit below could not pass
    // a sport even though every caller knows one. That absence is the root
    // cause of 114,035 unaddressable rows.
    expect(iface.slice(0, 1400)).toMatch(/sport\?:\s*string \| null;/);
  });

  it("the recordSoldComp payload passes sport, not nothing", async () => {
    const src = await read("../src/services/compiq/cardsight.router.ts");
    const emit = src.slice(src.indexOf('source: "cardhedge"') - 1200);

    expect(emit.slice(0, 2600)).toMatch(/sport:\s*identity\.sport \?\? null/);
  });

  it("never DEFAULTS a sport — null stays null", async () => {
    const src = await read("../src/services/compiq/cardsight.router.ts");
    const emit = src.slice(src.indexOf('source: "cardhedge"') - 1200, src.indexOf('source: "cardhedge"') + 1400);

    // THE pin that matters. A guessed sport mints into another sport's pool —
    // the L5 no-sport-predicate failure, where 219k card numbers were answered
    // by the wrong sport's checklist. `?? null` is the only permitted fallback;
    // any string literal here would be a fabricated address.
    expect(emit).not.toMatch(/sport:\s*identity\.sport \?\? ["'][a-z]/);
    expect(emit).not.toMatch(/sport:\s*["'](baseball|football|basketball|hockey)["']/);
  });
});

describe("a row names its writer", () => {
  it("RecordSoldCompInput accepts a writerTag", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");
    const iface = src.slice(src.indexOf("interface RecordSoldCompInput"));

    expect(iface.slice(0, 4000)).toMatch(/writerTag\?:\s*string \| null;/);
  });

  it("the tag is persisted onto the stored document", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");

    // MUTATION CHECK: without this the field is accepted and silently dropped,
    // which is worse than not having it — a query for it would return nothing
    // and read as "no such writer" rather than "not recorded".
    expect(src).toMatch(/writerTag:\s*input\.writerTag \?\? null,/);
  });

  it("the CH comp emit sets a call-site constant", async () => {
    const src = await read("../src/services/compiq/cardsight.router.ts");

    // `source` names the VENDOR; it does not name the code that wrote the row.
    // Pinning this call site took a grep across every `::`-joined id template
    // in the repo, because the id shape was the row's only fingerprint.
    expect(src).toMatch(/writerTag:\s*"cardsight\.router\.trustedComps"/);
  });

  it("writerTag is OPTIONAL, so no existing caller breaks", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");
    const iface = src.slice(src.indexOf("interface RecordSoldCompInput"));

    // ~46 callers exist. A required field would be a repo-wide change for an
    // observability win, and absent must keep meaning "not recorded".
    expect(iface.slice(0, 4000)).not.toMatch(/writerTag:\s*string;/);
  });
});

describe("sport derivation is unchanged for everyone else", () => {
  it("stated sport still wins over the text heuristic", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");

    // The order is: what the caller STATED, then the literal-word heuristic.
    // This PR adds a way for the CH emit to state one; it changes nothing about
    // how a sport is derived when the caller does not.
    expect(src).toMatch(/sport:\s*input\.sport \?\? inferSportFromContext\(/);
  });

  it("no checklist lookup was added to the write path", async () => {
    const raw = await read("../src/services/portfolioiq/soldCompsStore.service.ts");
    // Comments stripped: the source explains WHY the adoption was dropped and
    // names it to do so. Naming a thing you rejected must not trip a pin
    // against doing it.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // A (year, setKey) → sport adoption was designed and DROPPED: the only
    // authoritative source is card_catalog, and a Cosmos read on the write path
    // of every sold comp is not acceptable. `productSetKeys` cannot supply it —
    // `ProductSetKey` carries setKey/names/family/parent/refines and NO sport,
    // deliberately. Recorded here so the idea is not re-attempted blind.
    expect(code).not.toMatch(/sportFromChecklistBackedKey/);
    expect(code).not.toMatch(/items\.query[\s\S]{0,200}card_catalog/);
  });
});
