# Web harnesses

Ad-hoc Playwright checks that verify a fix against a **real browser**, where a
unit test can only see the markup. Not wired into CI — `playwright` is
deliberately not a dependency of `apps/web` (it pulls a browser download).
Run them from a scratch directory:

```sh
mkdir -p /tmp/pwharness && cd /tmp/pwharness
npm init -y && npm i playwright
cp <repo>/apps/web/docs/harness/*.mjs .

# build + serve the app under test
cd <repo>/apps/web && npx next build && npx next start -p 3111

cd /tmp/pwharness && BASE=http://127.0.0.1:3111 node nested-anchor-check.mjs
```

Both scripts stub the API: a session, a one-holding portfolio in the
MISSING-identity state, and a 500 for `/api/portfolioiq/**` so the dashboard
(not under test, and a long chain of unrelated fields to stub) stays out of
the way. They assert on the **visible** layout only — the mobile card and the
desktop row are both in the DOM at once, with CSS hiding one.

## nested-anchor-check.mjs

CF-WEB-NO-NESTED-ANCHOR. Exits non-zero unless, at 390px and 1280px: no `<a>
` has an `<a>` descendant, no hydration error is logged, a tap at the centre
of "Fix identity →" resolves to the fixer, the fixer is ≥44px tall, and it is
keyboard-focusable.

## verified-check-check.mjs

CF-VERIFIED-IS-A-CHECK. Stubs TWO holdings — one `identityVerified: true`,
one `false` — because the assertions are about the difference between them.
Exits non-zero unless, at 390px and 1280px: exactly ONE check is visible (the
verified row's), the word "VERIFIED" appears nowhere on the page, the
UNVERIFIED chip is still rendered, the check's box is ≥10px and sits in the
upper half of its card (the title line, not the chips band), it is not clipped
by the card edge, its `aria-label` is "Verified identity", there is no
horizontal overflow, and no two text nodes inside a holding card overlap.

The clipping assertion is the one worth keeping: the desktop title
`truncate`s, and `text-overflow: ellipsis` eats the END of the line — a check
left inside the truncating element vanishes on exactly the long titles most
likely to be verified. The verified fixture carries a deliberately long title
for that reason.

```sh
BASE=http://127.0.0.1:3111 \
SHOTS=<repo>/apps/web/docs/screenshots \
node verified-check-check.mjs
```

`SHOTS` is optional; with it the run also writes the two screenshots.

## before-check.mjs

The control. Same measurements, selecting the fixer by its visible text so it
runs against the **pre-fix** build (which carries no `data-testid`). Its job
is to make the numbers above mean something — a check that cannot fail on the
broken build is not evidence.

Against the pre-fix build:

|                     | before              | after     |
| ------------------- | ------------------- | --------- |
| `<a>` inside `<a>`  | 2                   | 0         |
| tap at fixer centre | the **row**         | the fixer |
| fixer tap target    | no box of its own   | 44px      |

The console is clean in BOTH builds: the parser splits the nested anchors the
same way server-side and client-side, so React sees no mismatch to warn
about. The nesting is invalid and load-bearing but silent at runtime — which
is why the committed unit test
(`src/components/HoldingRowLink.test.tsx`) asserts structure rather than
watching for a console message.
