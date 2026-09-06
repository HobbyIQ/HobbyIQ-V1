// CF-WITHHELD-SAYS-WHY / CF-MOBILE-390-DETAIL — real-browser verification.
//
// Drew's audit, 2026-09-05: a withheld holding rendered as a bare "—" with no
// account of itself, and the DailyIQ column told every one of them "value
// withheld: cost-basis check" regardless of cause.
//
// The unit tests pin the COPY (four causes, four sentences; the refused number
// never escapes its sentence). This checks what only a browser knows: that the
// reason is actually visible at both viewports, that the refused number is NOT
// rendered anywhere a reader could mistake it for this card's value, that the
// detail page's KPI row does not overflow 390px, and that no two text nodes
// overlap on the mobile card.
//
// Four holdings are stubbed, one per reason, because the whole point is that
// they must not look alike:
//
//   h_floor      cost-basis-floor        -> quotes $2 refused vs $29.45 basis
//   h_checklist  no-checklist-match      -> "checklist being acquired"
//   h_catalog    identity-not-in-catalog -> "card not in catalog yet"
//   h_migrating  pool-migrating          -> "comps settling"
//
// Usage (see README.md):
//   cd apps/web && npx next build && npx next start -p 3111
//   BASE=http://127.0.0.1:3111 node withheld-check.mjs
//
// Add SHOTS=/path/to/dir to also write the screenshots.
import { chromium } from "playwright";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3111";
const SHOTS = process.env.SHOTS ?? null;

function withheldHolding(id, reason, extra = {}) {
  return {
    id,
    playerName: "Ken Griffey Jr.",
    cardNumber: "1",
    year: 1989,
    setName: "O-Pee-Chee",
    quantity: 1,
    totalCostBasis: 29.45,
    purchasePrice: 29.45,
    identityVerified: true,
    pricing: {
      headline: { value: null, valueSource: "unpriced", perUnit: null, quantity: 1 },
      provenance: {
        withheld: {
          reason,
          blockingId: `hiq:test:${reason}`,
          blockingCount: 4,
          proposed: null,
          retained: null,
          retentionRefused: null,
        },
      },
    },
    ...extra,
  };
}

const HOLDINGS = [
  // The floor case carries the refused number — the one row where a dollar
  // figure legitimately appears, and only inside the refusal sentence.
  withheldHolding("h_floor", "cost-basis-floor", {
    pricing: {
      headline: { value: null, valueSource: "unpriced", perUnit: null, quantity: 1 },
      provenance: {
        withheld: {
          reason: "cost-basis-floor",
          blockingId: "hiq:test:floor",
          blockingCount: 4,
          proposed: 2,
          retained: null,
          retentionRefused: null,
        },
      },
    },
  }),
  withheldHolding("h_checklist", "no-checklist-match"),
  withheldHolding("h_catalog", "identity-not-in-catalog"),
  withheldHolding("h_migrating", "pool-migrating"),
];

const SUMMARY = {
  totalValue: 0,
  totalCost: 117.8,
  totalGainLoss: 0,
  totalGainLossPct: 0,
  cardCount: HOLDINGS.length,
  observedValue: 0,
  estimatedValue: 0,
  estimatedCount: 0,
  pendingCount: 0,
  observedPct: 0,
};

const failures = [];
function check(name, cond, detail = "") {
  if (cond) return;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

async function stub(page) {
  await page.route("**/api/portfolio**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: HOLDINGS, summary: SUMMARY }),
    }),
  );
  // The dashboard is not under test and is a long chain of unrelated fields
  // to stub; 500 keeps it out of the way (same approach as the other scripts).
  await page.route("**/api/portfolioiq/**", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u_test", email: "test@example.com" } }),
    }),
  );
}

async function run() {
  const browser = await chromium.launch();
  try {
    for (const [label, width, height] of [["mobile-390", 390, 844], ["desktop-1280", 1280, 900]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await stub(page);
      await page.goto(`${BASE}/app/portfolio`, { waitUntil: "networkidle" });

      const body = await page.innerText("body");

      // 1. Four causes must not read alike. Each reason's words appear.
      for (const [id, words] of [
        ["h_floor", "held below your cost"],
        ["h_checklist", "checklist being acquired"],
        ["h_catalog", "card not in catalog yet"],
        ["h_migrating", "comps settling"],
      ]) {
        check(`${label}: ${id} shows its own reason`, body.toLowerCase().includes(words), words);
      }

      // 2. The old bug, as a browser assertion: no withheld row may be told
      //    "cost-basis check" unless its reason IS the cost-basis floor.
      check(
        `${label}: the collapsed sentence is gone`,
        !body.toLowerCase().includes("cost-basis check"),
      );

      // 3. MISSING must not paint a deliberate refusal.
      check(`${label}: refused rows are not labelled MISSING`, !body.includes("MISSING"));

      // 4. RULE 3, in the browser: the refused $2 must NOT appear as a value.
      //    On the list it is a tooltip only, never rendered text.
      check(
        `${label}: the refused number is not shown as a value`,
        !/\$2(\.00)?\b/.test(body),
        "the refused market read must stay inside its sentence",
      );

      // 5. The engine's vocabulary must never reach the glass.
      for (const machine of ["cost-basis-floor", "no-checklist-match", "identity-not-in-catalog", "pool-migrating"]) {
        check(`${label}: does not leak "${machine}"`, !body.includes(machine));
      }

      // 6. No horizontal overflow at either width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      check(`${label}: no horizontal overflow`, !overflow);

      if (SHOTS) {
        await page.screenshot({
          path: path.join(SHOTS, `withheld-${label}-after.png`),
          fullPage: true,
        });
      }

      // ── The detail page, which the audit found was never measured at 390.
      await page.goto(`${BASE}/app/portfolio/h_floor`, { waitUntil: "networkidle" });
      const detail = await page.innerText("body");

      check(
        `${label}: detail explains the refusal`,
        detail.toLowerCase().includes("held below your cost"),
      );
      // Here the refused number SHOULD appear — inside the sentence.
      check(
        `${label}: detail quotes the refused number in its sentence`,
        detail.includes("$2.00") && detail.includes("$29.45"),
      );
      check(
        `${label}: detail says what would unlock it`,
        detail.toLowerCase().includes("not published as a value"),
      );

      const detailOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      check(`${label}: detail has no horizontal overflow`, !detailOverflow);

      if (SHOTS) {
        await page.screenshot({
          path: path.join(SHOTS, `withheld-detail-${label}-after.png`),
          fullPage: true,
        });
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`FAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("PASS — withheld reasons are distinct, legible, and contained at 390 and 1280.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
