// CF-VERIFIED-IS-A-CHECK — real-browser verification.
//
// Drew, 2026-09-04: "Rather than say Verified — let's just do a green check
// for it next to the card details."
//
// The unit test can see the markup. This checks what only a browser knows:
// that the check is actually VISIBLE at both viewports, that it sits ON the
// title line rather than down in the chips band, that it survives the desktop
// row's `truncate` (which clips the end of the line — the exact place a naive
// implementation loses it), that nothing overlaps at 390px, and that the word
// "VERIFIED" is gone from the rendered page while every OTHER chip stays.
//
// Two holdings are stubbed, because the interesting assertions are about the
// DIFFERENCE between them:
//
//   h_verified    identityVerified: true   -> check, no UNVERIFIED chip
//   h_unverified  identityVerified: false  -> no check, UNVERIFIED chip
//
// Usage (see README.md):
//   cd apps/web && npx next build && npx next start -p 3111
//   BASE=http://127.0.0.1:3111 node verified-check-check.mjs
//
// Add SHOTS=/path/to/dir to also write the screenshots.
import { chromium } from "playwright";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3111";
const SHOTS = process.env.SHOTS ?? null;

// A long title on the verified row is deliberate: the desktop layout
// `truncate`s the title, and `text-overflow: ellipsis` clips the END of the
// line. A check left inside that truncating element vanishes on exactly the
// titles most likely to be verified. This row is the regression case.
const VERIFIED_HOLDING = {
  id: "h_verified",
  playerName: "Bobby Witt Jr.",
  cardNumber: "CPA-BWJ",
  year: 2020,
  setName: "Bowman Chrome Prospect Autographs Refractor",
  parallel: "Gold Refractor",
  quantity: 1,
  fairMarketValue: 1415,
  totalCostBasis: 1260,
  purchasePrice: 1260,
  identityVerified: true,
  photos: [],
};

const UNVERIFIED_HOLDING = {
  id: "h_unverified",
  playerName: "Ken Griffey Jr.",
  cardNumber: "1",
  year: 1989,
  setName: "Upper Deck",
  quantity: 1,
  fairMarketValue: 900,
  totalCostBasis: 100,
  purchasePrice: 100,
  identityVerified: false,
  photos: [],
};

const PORTFOLIO = {
  success: true,
  userId: "u_test",
  items: [VERIFIED_HOLDING, UNVERIFIED_HOLDING],
  summary: {
    totalValue: 2315,
    totalCost: 1360,
    totalGainLoss: 955,
    totalGainLossPct: 70.2,
    cardCount: 2,
    observedValue: 2315,
    estimatedValue: 0,
    estimatedCount: 0,
    pendingCount: 0,
    observedPct: 100,
  },
  valuation: { repricing: false, oldestValuationAt: null, oldestValuationAgeMs: null },
};

const browser = await chromium.launch();
const results = [];
let failures = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
}

for (const [name, viewport] of [
  ["mobile-390", { width: 390, height: 844 }],
  ["desktop-1280", { width: 1280, height: 900 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  await ctx.addInitScript(() => {
    window.localStorage.setItem("hobbyiq_session_id", "test-session");
  });

  // Route precedence: Playwright matches the LAST-registered handler first,
  // so the catch-all goes on first and the specific stubs after it. Same
  // stub set as nested-anchor-check.mjs — see its notes for why the
  // dashboard gets a 500 rather than a hand-built shape.
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
  await page.route("**/api/portfolio/reprice/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accepted: false, status: "throttled", throttled: true, running: false }),
    }),
  );
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
        totalDisplayable: 2315,
        observedValue: 2315,
        estimatedValue: 0,
        points: [],
      }),
    }),
  );
  await page.route("**/api/portfolio/", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PORTFOLIO) }),
  );

  await page.goto(`${BASE}/app/portfolio`, { waitUntil: "networkidle" });

  // BOTH layouts are in the DOM at once (`md:hidden` / `hidden md:flex`) with
  // CSS hiding one. Every query is scoped to `:visible` — the layout the user
  // at this viewport actually sees.
  const checks = page.locator("[data-verified-check]:visible");
  await checks.first().waitFor({ state: "visible", timeout: 15000 });

  // 1. Exactly ONE check is visible: the verified holding's. The unverified
  //    row must not have grown one.
  const visibleChecks = await checks.count();
  check(`${name}: exactly one check visible`, visibleChecks === 1, `got ${visibleChecks}`);

  // 2. The word is gone from the whole rendered page. This is the actual ask.
  const bodyText = await page.locator("body").innerText();
  check(`${name}: no "VERIFIED" text anywhere`, !bodyText.includes("VERIFIED".toUpperCase()) || !/\bVERIFIED\b/.test(bodyText.replace(/UNVERIFIED/g, "")), "found the word VERIFIED");

  // 3. UNVERIFIED still says UNVERIFIED — the other chips are untouched.
  check(`${name}: UNVERIFIED chip still present`, bodyText.includes("UNVERIFIED"), "UNVERIFIED chip missing");

  // 4. The check is ON the title line: its vertical centre is within the
  //    title's box, not down in the chips band. This is what "next to the
  //    card details" means, measured.
  const geo = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-verified-check]")].find(
      (n) => n.getBoundingClientRect().width > 0,
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // The nearest ancestor card, then the element holding the title text.
    const card = el.closest(".hiq-card");
    const cardRect = card?.getBoundingClientRect() ?? null;
    // Anything in this card that is a status chip (the 10px pills).
    const chips = [...(card?.querySelectorAll("span") ?? [])]
      .filter((n) => /^(EST|PENDING|MISSING|UNDER REVIEW|UNVERIFIED)$/.test(n.textContent.trim()))
      .map((n) => n.getBoundingClientRect().top);
    return {
      check: { top: r.top, bottom: r.bottom, left: r.left, w: r.width, h: r.height },
      cardTop: cardRect?.top ?? null,
      cardBottom: cardRect?.bottom ?? null,
      firstChipTop: chips.length ? Math.min(...chips) : null,
    };
  });
  check(`${name}: check has a real box`, geo && geo.check.w >= 10 && geo.check.h >= 10, JSON.stringify(geo?.check));
  // In the upper half of the card = on the title, not in the chips band.
  const inUpperHalf =
    geo && geo.cardTop != null && geo.check.top < geo.cardTop + (geo.cardBottom - geo.cardTop) / 2;
  check(`${name}: check sits on the title line, not the chips band`, !!inUpperHalf, JSON.stringify(geo));

  // 5. It survives the desktop `truncate`: the check must be fully inside its
  //    card's box, not clipped off the right edge.
  const clipped = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-verified-check]")].find(
      (n) => n.getBoundingClientRect().width > 0,
    );
    if (!el) return "no check";
    const r = el.getBoundingClientRect();
    const card = el.closest(".hiq-card").getBoundingClientRect();
    return r.right <= card.right + 0.5 && r.left >= card.left - 0.5 ? null : "clipped";
  });
  check(`${name}: check is not clipped by the card`, clipped === null, String(clipped));

  // 6. Accessible name present in the live DOM.
  const label = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-verified-check]")].find(
      (n) => n.getBoundingClientRect().width > 0,
    );
    return el ? el.getAttribute("aria-label") : null;
  });
  check(`${name}: aria-label present`, label === "Verified identity", String(label));

  // 7. No horizontal overflow at this viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${name}: no horizontal overflow`, overflow <= 0, `${overflow}px`);

  // 8. Nothing in a holding card overlaps anything else — the defect
  //    #1714 fixed, re-measured with the check added to the title line.
  const overlaps = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".hiq-card")].filter(
      (c) => c.getBoundingClientRect().width > 0,
    );
    let bad = 0;
    for (const card of cards) {
      const leaves = [...card.querySelectorAll("*")].filter(
        (n) =>
          n.children.length === 0 &&
          n.textContent.trim() &&
          n.getBoundingClientRect().width > 0,
      );
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          const a = leaves[i].getBoundingClientRect();
          const b = leaves[j].getBoundingClientRect();
          const hit =
            a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (hit) bad += 1;
        }
      }
    }
    return bad;
  });
  check(`${name}: no overlapping text in cards`, overlaps === 0, `${overlaps} overlaps`);

  if (SHOTS) {
    await page.screenshot({
      path: path.join(SHOTS, `portfolio-${name}-verified-check.png`),
      fullPage: false,
    });
  }

  await ctx.close();
}

await browser.close();

for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  -- ${r.detail}`}`);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
