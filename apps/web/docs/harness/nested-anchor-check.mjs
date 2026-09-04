// CF-WEB-NO-NESTED-ANCHOR — real-browser verification.
//
// Loads the portfolio page in Chromium with a stubbed portfolio containing a
// MISSING-identity holding, and checks what the unit test cannot: what the
// BROWSER does with the markup, and where a tap actually lands.
//
// Measured against the pre-fix build (`before-check.mjs`, same stubs):
//
//                        before            after
//   a-inside-a             2                0
//   tap at fixer centre    the ROW          the fixer
//   fixer tap target       no box of        44 px
//                          its own
//
// "tap lands on the row" is the reported symptom, reproduced: with the
// anchors nested, the parser hoists the fixer out and the point the user
// aims at resolves to the row's link instead.
//
// Note on hydration: the console is CLEAN in both builds. The browser's
// parser splits the nested anchors the same way on the server-rendered HTML
// and on the client, so React sees no mismatch to warn about — the invalid
// nesting is real but silent at runtime. That is exactly why the committed
// unit test asserts the STRUCTURE rather than watching for a console
// message: waiting for a warning here would be waiting for one that never
// comes.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3111";

const MISSING_HOLDING = {
  id: "h_missing_1",
  playerName: "Ken Griffey Jr.",
  cardNumber: "1",
  year: 1989,
  setName: "Upper Deck",
  quantity: 1,
  // No fairMarketValue and no pricing envelope -> value == null, and
  // valuationStatus is neither estimated nor pending -> the MISSING branch.
  fairMarketValue: null,
  totalCostBasis: 100,
  purchasePrice: 100,
  identityVerified: false,
  photos: [],
};

// The endpoint's real shape: `items` (not `holdings`) plus a `summary` the
// dashboard reads unconditionally.
const PORTFOLIO = {
  success: true,
  userId: "u_test",
  items: [MISSING_HOLDING],
  summary: {
    totalValue: 0,
    totalCost: 100,
    totalGainLoss: -100,
    totalGainLossPct: -100,
    cardCount: 1,
    observedValue: 0,
    estimatedValue: 0,
    estimatedCount: 0,
    pendingCount: 0,
    observedPct: 0,
  },
  valuation: {
    repricing: false,
    oldestValuationAt: null,
    oldestValuationAgeMs: null,
  },
};

const browser = await chromium.launch();
const results = [];

for (const [name, viewport] of [
  ["mobile-390", { width: 390, height: 844 }],
  ["desktop-1280", { width: 1280, height: 900 }],
]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

  await ctx.addInitScript(() => {
    window.localStorage.setItem("hobbyiq_session_id", "test-session");
  });

  // Route precedence: Playwright matches the LAST-registered handler first,
  // so the catch-all is registered FIRST and the specific stubs after it.
  //
  // The page is a dashboard: it fans out to value-history, breakdown, the
  // reprice dispatcher and more, and several of those consumers call
  // .filter()/.length on an array they assume is present. A bare `{}` makes
  // the page's error boundary swallow the row we came to inspect, so the
  // catch-all answers with the empty-but-well-formed shape instead.
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        items: [],
        data: [],
        results: [],
        points: [],
        count: 0,
      }),
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
  // Do NOT let the page dispatch a reprice: it would poll and re-render.
  await page.route("**/api/portfolio/reprice/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accepted: false, status: "throttled", throttled: true, running: false }),
    }),
  );
  // The PortfolioIQ dashboard is NOT what this checks, and stubbing its full
  // shape is a long chain of unrelated fields. A 500 makes the page render
  // without it — which is the state the holdings list must survive anyway.
  await page.route("**/api/portfolioiq/**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false }) }),
  );
  await page.route("**/api/portfolio/value-history", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        asOf: new Date().toISOString(),
        totalDisplayable: 0,
        observedValue: 0,
        estimatedValue: 0,
        points: [],
      }),
    }),
  );
  // The portfolio itself, carrying the MISSING-identity holding.
  await page.route("**/api/portfolio/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PORTFOLIO),
    }),
  );

  await page.goto(`${BASE}/app/portfolio`, { waitUntil: "networkidle" });
  // BOTH layouts are in the DOM at once — the mobile card (`md:hidden`) and
  // the desktop row (`hidden md:flex`) — with CSS hiding one. Every query
  // below is scoped to the VISIBLE one, which is the layout the user at this
  // viewport actually taps.
  const visibleFixer = page.locator('[data-testid="fix-identity-link"]:visible');
  await visibleFixer.first().waitFor({ state: "visible", timeout: 15000 });

  // 1. Nested anchors, per the browser's OWN parsed DOM (not our markup).
  const nested = await page.$$eval("a a", (els) => els.length);

  // 2. Hydration errors. React phrases the nested-anchor case as a
  //    validateDOMNesting / "cannot be a descendant of" / hydration message.
  const hydration = consoleErrors.filter((t) =>
    /hydrat|validateDOMNesting|cannot be a descendant|cannot contain a nested/i.test(t),
  );

  // 3. The tap test: the element at the centre of the fixer must BE the
  //    fixer (or inside it) — not the row's stretched link painted over it.
  // `elementFromPoint` answers in VIEWPORT coordinates and returns null for
  // anything scrolled off-screen, so bring the fixer into view before the
  // hit-test — otherwise an off-screen element reads as "covered" when it is
  // merely below the fold.
  await visibleFixer.first().scrollIntoViewIfNeeded();
  const box = await visibleFixer.first().boundingBox();
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      const a = el?.closest("a");
      return {
        testid: a?.getAttribute("data-testid") ?? null,
        href: a?.getAttribute("href") ?? null,
      };
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );

  // 4. Touch target height against the 44px floor.
  const rowBox = await page
    .locator('[data-testid="row-link"]:visible')
    .first()
    .boundingBox();

  // 5. Both destinations still reachable.
  const hrefs = [
    ...new Set(
      await page.$$eval("a[href^='/app/portfolio/']", (els) =>
        els.map((e) => e.getAttribute("href")),
      ),
    ),
  ];

  // 6. Keyboard: the fixer must be focusable.
  const focusable = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="fix-identity-link"]')];
    const el = els.find((e) => e.getBoundingClientRect().width > 0);
    el.focus();
    return document.activeElement === el;
  });

  results.push({
    viewport: name,
    nestedAnchors: nested,
    hydrationErrors: hydration,
    otherConsoleErrors: consoleErrors.filter((t) => !hydration.includes(t)),
    tapAtFixerCentreHits: hit,
    fixerHeightPx: Math.round(box.height),
    rowLinkBox: rowBox && {
      w: Math.round(rowBox.width),
      h: Math.round(rowBox.height),
    },
    portfolioHrefs: hrefs,
    fixerKeyboardFocusable: focusable,
  });

  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));

const bad = results.filter(
  (r) =>
    r.nestedAnchors !== 0 ||
    r.hydrationErrors.length > 0 ||
    r.tapAtFixerCentreHits.testid !== "fix-identity-link" ||
    r.fixerHeightPx < 44 ||
    !r.fixerKeyboardFocusable,
);
console.log(bad.length === 0 ? "\nVERDICT: PASS" : "\nVERDICT: FAIL");
process.exit(bad.length === 0 ? 0 : 1);
