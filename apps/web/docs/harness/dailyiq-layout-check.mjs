// CF-DAILYIQ-LAYOUT / CF-DAILYIQ-ACTIONS / CF-DAILYIQ-BANNER-ONLY-WHEN-EMPTY
// — real-browser verification.
//
// Drew, 2026-09-04: "I love the market indexes. Portfolio Today should be a
// wide bar at the top with relevant data, then market indexes, and maybe
// something around actions below it."
//
// The unit tests pin the DECISIONS (which order the page mounts things in,
// which holdings earn an attention row, when the banner may show). This
// checks the things only a browser knows: that the bar actually paints as ONE
// ROW at 1280 and TWO STACKED ROWS at 390, that nothing inside it overlaps at
// either width, that the three sections come down the page in the order Drew
// asked for as MEASURED BY GEOMETRY rather than source position, and that the
// onboarding banner is absent on a 43-holding portfolio.
//
// THE FIXTURE IS THE REPORTED CASE: 43 holdings, 38 of them verified, with a
// spread of the real meta shapes so every actions column has something to
// render —
//
//   h_parked        needsReview + reviewReason   -> identity needs a match
//   h_withheld      envelope valueSource cost-proxy -> value withheld
//   h_lowconf       pricingLabels[low-confidence]   -> the wire's sentence
//   h_sell          sellSignal sell-window          -> a sell signal
//
// and firstRun returns an EMPTY progress record with holdingCount 43 — the
// exact state that used to render "Value your first card". If the banner
// comes back, check 1 goes red.
//
// Usage (see README.md):
//   cd apps/web && npx next build && npx next start -p 3111
//   BASE=http://127.0.0.1:3111 node dailyiq-layout-check.mjs
//
// Add SHOTS=/path/to/dir to also write the screenshots.
import { chromium } from "playwright";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3111";
const SHOTS = process.env.SHOTS ?? null;

const envelope = (value, source) => ({
  headline: { value, valueSource: source, perUnit: value, quantity: 1 },
});

/** A healthy priced holding. The bulk of the fixture, so the attention column
 *  is short — a column that flags everything is the failure mode. */
function healthy(i) {
  return {
    id: `h_ok_${i}`,
    playerName: `Player ${i}`,
    cardTitle: `Player ${i} base`,
    cardYear: 2024,
    product: "Bowman Chrome",
    cardNumber: String(100 + i),
    hobbyiqCardId: `hiq:baseball:2024:bowman-chrome:${100 + i}:base:noauto`,
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    fairMarketValue: 130,
    totalProfitLoss: 30 + i,
    identityVerified: true,
    pricing: envelope(130, "observed"),
    photos: [],
  };
}

const ITEMS = [
  // 39 healthy verified rows...
  ...Array.from({ length: 39 }, (_, i) => healthy(i)),
  // ...plus the four that each exercise one column/row shape.
  {
    ...healthy(90),
    id: "h_parked",
    playerName: "Paul Skenes",
    hobbyiqCardId: null,
    cardId: null,
    identityVerified: false,
    needsReview: true,
    reviewReason: "No catalog match — pick the card in Edit to price it.",
    pricing: envelope(null, "unpriced"),
    totalProfitLoss: null,
  },
  {
    ...healthy(91),
    id: "h_withheld",
    playerName: "Elly De La Cruz",
    identityVerified: false,
    pricing: envelope(120, "cost-proxy"),
    totalProfitLoss: null,
  },
  {
    ...healthy(92),
    id: "h_lowconf",
    playerName: "Jackson Holliday",
    identityVerified: false,
    pricingLabels: [
      {
        code: "low-confidence",
        text: "No independent sales in this card's pool yet — the price leans on one comp.",
      },
    ],
    totalProfitLoss: -450,
  },
  {
    ...healthy(93),
    id: "h_sell",
    playerName: "Wyatt Langford",
    identityVerified: true,
    totalProfitLoss: 980,
    sellSignal: {
      signal: "sell-window",
      horizon: "days-7-14",
      signalClass: "price",
      basis: "Player index +18.2% while this card's own pool moved +2.1% over 30 days.",
      measures: { divergencePct: 16.1, ownPoolSales: 6, confidence: 0.71 },
    },
  },
];

const PORTFOLIO = {
  success: true,
  userId: "u_test",
  items: ITEMS,
  summary: {
    totalValue: 128450,
    totalCost: 96100,
    totalGainLoss: 32350,
    totalGainLossPct: 33.7,
    cardCount: 43,
    observedValue: 126000,
    estimatedValue: 2450,
    estimatedCount: 2,
    pendingCount: 1,
    observedPct: 98,
  },
  valuation: { repricing: false, oldestValuationAt: null, oldestValuationAgeMs: null },
};

/** THE REGRESSION STATE: holdings exist, funnel never run. This is what used
 *  to render "Value your first card — Get started". */
const FIRST_RUN = {
  success: true,
  progress: { status: "active", completedSteps: [], lane: null, startedAt: null, updatedAt: null },
  holdingCount: 43,
};

// The REAL MarketIndexesResponse shape (api.ts): tiles read `latestLevel`,
// `changePct`, `freshMembers`/`basketSize` and a `series` of {date, level}.
// A fixture with invented field names would render a strip of blanks and the
// position assertions would still pass — measuring nothing.
const SPORT_INDEXES = {
  success: true,
  computedAt: "2026-09-04T05:00:00.000Z",
  windowDays: 180,
  indexes: ["baseball", "basketball", "football", "hockey", "pokemon"].map((sport, i) => ({
    sport,
    latestLevel: 100 + i * 7,
    changePct: i % 2 === 0 ? 1.4 + i : -0.8 - i,
    windowDays: 180,
    basketSize: 40,
    asOf: "2026-09-04",
    freshMembers: 38 - i,
    usedWeight: 0.82,
    series: Array.from({ length: 12 }, (_, d) => ({
      date: `2026-08-${String(20 + d).padStart(2, "0")}`,
      level: 100 + i * 7 + Math.sin(d) * 3,
    })),
  })),
};

const browser = await chromium.launch();
const results = [];
let failures = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
}

for (const [name, viewport] of [
  ["mobile-390", { width: 390, height: 900 }],
  ["desktop-1280", { width: 1280, height: 1000 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  await ctx.addInitScript(() => {
    window.localStorage.setItem("hobbyiq_session_id", "test-session");
  });

  // Route precedence: Playwright matches the LAST-registered handler first,
  // so the catch-all goes on first and the specific stubs after it.
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, items: [], data: [], results: [], points: [], count: 0 }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: { id: "u_test", email: "test@example.com", name: "Test" },
      }),
    }),
  );
  await page.route("**/api/portfolioiq/**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false }) }),
  );
  await page.route("**/api/onboarding**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        dismissed: false,
        percentComplete: 40,
        doneCount: 2,
        total: 5,
        steps: [{ id: "s", label: "Add a card", done: false, cta: "Add" }],
      }),
    }),
  );
  // The real paths: fetchFirstRun -> /api/onboarding/first-run,
  // fetchMarketIndexes -> /api/compiq/market-indexes. Registered AFTER the
  // /api/onboarding catch-all above so the more specific one wins.
  await page.route("**/api/onboarding/first-run**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIRST_RUN) }),
  );
  await page.route("**/api/compiq/market-indexes**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SPORT_INDEXES) }),
  );
  await page.route("**/api/portfolio/", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PORTFOLIO) }),
  );

  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="portfolio-bar"]').waitFor({ state: "visible", timeout: 20000 });

  const bodyText = await page.locator("body").innerText();

  // 1. THE BANNER FIX. 43 holdings must not be told to value their first card.
  check(
    `${name}: no onboarding banner on a 43-holding portfolio`,
    !/Value your first card|Get started/i.test(bodyText),
    "onboarding banner rendered",
  );

  // 2. ORDER, MEASURED BY GEOMETRY — bar above indexes above actions. The
  //    unit test reads source position; this reads where they actually land.
  const geo = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    return {
      bar: box('[data-testid="portfolio-bar"]'),
      indexes: box('[data-market-indexes], [data-testid="market-indexes"]'),
      actions: box('[data-testid="todays-actions"]'),
      docWidth: document.documentElement.clientWidth,
    };
  });

  check(`${name}: the bar is present`, !!geo.bar, JSON.stringify(geo.bar));
  check(`${name}: the actions section is present`, !!geo.actions, JSON.stringify(geo.actions));
  if (geo.bar && geo.actions) {
    check(
      `${name}: bar sits above the actions section`,
      geo.bar.bottom <= geo.actions.top + 1,
      `bar.bottom=${geo.bar.bottom} actions.top=${geo.actions.top}`,
    );
  }
  if (geo.bar && geo.indexes) {
    check(
      `${name}: bar sits above the market indexes`,
      geo.bar.bottom <= geo.indexes.top + 1,
      `bar.bottom=${geo.bar.bottom} indexes.top=${geo.indexes.top}`,
    );
  }
  if (geo.indexes && geo.actions) {
    check(
      `${name}: market indexes sit above the actions section`,
      geo.indexes.bottom <= geo.actions.top + 1,
      `indexes.bottom=${geo.indexes.bottom} actions.top=${geo.actions.top}`,
    );
  }

  // 3. THE BAR IS FULL WIDTH — it is a bar, not a card in a column.
  if (geo.bar) {
    check(
      `${name}: bar spans the content width`,
      geo.bar.w >= Math.min(geo.docWidth, 1280) * 0.6,
      `bar width ${geo.bar.w} of ${geo.docWidth}`,
    );
  }

  // 4. ONE ROW ON DESKTOP, TWO STACKED AT 390. Measured on the two bands:
  //    side by side means their vertical ranges overlap; stacked means the
  //    second starts at or below the first's bottom.
  const bands = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="portfolio-bar"]');
    if (!bar) return null;
    const kids = [...bar.children].filter((n) => n.getBoundingClientRect().height > 0);
    return kids.map((n) => {
      const r = n.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  });
  if (bands && bands.length >= 2) {
    const [a, b] = bands;
    const sideBySide = a.top < b.bottom - 1 && b.top < a.bottom - 1;
    if (name === "desktop-1280") {
      check(`${name}: bar is ONE row (bands side by side)`, sideBySide, JSON.stringify(bands));
    } else {
      check(`${name}: bar is TWO stacked rows`, !sideBySide, JSON.stringify(bands));
    }
  } else {
    check(`${name}: bar has two bands`, false, JSON.stringify(bands));
  }

  // 5. THE VERIFIED SHARE IS A COUNT WITH THE GLYPH, NEVER THE WORD.
  check(
    `${name}: verified share shown as "N of 43"`,
    /\b\d+ of 43 verified\b/.test(bodyText),
    "verified count line missing",
  );
  const barHasCheck = await page.evaluate(
    () => !!document.querySelector('[data-testid="portfolio-bar"] [data-verified-check]'),
  );
  check(`${name}: the VerifiedCheck glyph is reused in the bar`, barHasCheck, "no glyph in bar");
  check(
    `${name}: the word VERIFIED does not appear`,
    !/\bVERIFIED\b/.test(bodyText.replace(/UNVERIFIED/g, "")),
    "found the word VERIFIED",
  );

  // 6. THE ATTENTION CHIP is present (the fixture has 3 flagged rows) and
  //    links to the actions section.
  const chip = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="portfolio-bar-attention"]');
    return el ? { text: el.textContent.trim(), href: el.getAttribute("href") } : null;
  });
  check(
    `${name}: attention chip present and points at the actions section`,
    !!chip && /need|needs/.test(chip.text) && chip.href === "#todays-actions",
    JSON.stringify(chip),
  );

  // 7. THE ACTIONS COLUMNS each rendered something real.
  const attentionKinds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-attention-kind]")].map((n) => n.getAttribute("data-attention-kind")),
  );
  check(
    `${name}: attention rows built from the real meta shapes`,
    attentionKinds.includes("identity-unmatched") &&
      attentionKinds.includes("value-withheld") &&
      attentionKinds.includes("low-confidence"),
    JSON.stringify(attentionKinds),
  );
  // The reason must be in the user's words, not the engine's vocabulary.
  check(
    `${name}: attention reasons avoid engine vocabulary`,
    !/cost-proxy|BASIS-IDENTITY|ladderRung|valueSource/i.test(bodyText),
    "engine vocabulary leaked to the page",
  );
  const sellRows = await page.locator('[data-testid="sell-signal-row"]').count();
  check(`${name}: the sell column rendered its signal`, sellRows >= 1, `${sellRows} rows`);
  check(
    `${name}: the sell basis sentence is shown verbatim`,
    bodyText.includes("Player index +18.2% while this card's own pool moved +2.1% over 30 days."),
    "basis sentence missing or paraphrased",
  );

  // 8. NO HORIZONTAL OVERFLOW at this viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${name}: no horizontal overflow`, overflow <= 0, `${overflow}px`);

  // 9. NOTHING OVERLAPS — the assertion Drew's "never overlaps" asks for,
  //    measured over the bar and the actions section rather than eyeballed.
  const overlaps = await page.evaluate(() => {
    const roots = [
      document.querySelector('[data-testid="portfolio-bar"]'),
      document.querySelector('[data-testid="todays-actions"]'),
    ].filter(Boolean);
    const bad = [];
    for (const root of roots) {
      const leaves = [...root.querySelectorAll("*")].filter(
        (n) => n.children.length === 0 && n.textContent.trim() && n.getBoundingClientRect().width > 0,
      );
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          const a = leaves[i].getBoundingClientRect();
          const b = leaves[j].getBoundingClientRect();
          const hit =
            a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (hit) bad.push(`${leaves[i].textContent.trim().slice(0, 20)} / ${leaves[j].textContent.trim().slice(0, 20)}`);
        }
      }
    }
    return bad;
  });
  check(`${name}: no overlapping text in the bar or actions`, overlaps.length === 0, overlaps.slice(0, 5).join(" | "));

  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, `dailyiq-${name}-after.png`), fullPage: true });
  }

  await ctx.close();
}

await browser.close();

for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  — ${r.detail}`}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
