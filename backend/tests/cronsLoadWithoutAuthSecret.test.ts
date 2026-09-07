// CF-CRON-AUTH-LOAD (2026-09-07). Three notification crons — cascade-detect,
// grade-worthy-push and watchlist-digest — died at require() time on every
// scheduled run with:
//
//   AUTH_SESSION_SECRET is unset — refusing to start.
//
// None of them touches a session, and none of the three workflows supplies
// the secret. The throw came from authService, which resolves the secret at
// module load (CF-AUTH-SESSION-SECRET-FAIL-CLOSED) and was reached only
// because portfolioStore.service imported getUserBySession at the top level
// for a single HTTP-request helper.
//
// The fail-closed guard is correct and stays. What changed is WHEN it loads.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const BACKEND = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(BACKEND, ...p), "utf8").replace(/\r\n/g, "\n");

describe("the notification crons load without AUTH_SESSION_SECRET", () => {
  const store = read("src", "services", "portfolioiq", "portfolioStore.service.ts");

  it("portfolioStore does not import authService at module load", () => {
    expect(store).not.toMatch(/^import\s*\{[^}]*getUserBySession[^}]*\}\s*from\s*"\.\.\/authService\.js";/m);
  });

  it("it still calls getUserBySession, via a deferred import", () => {
    expect(store).toContain('await import("../authService.js")');
    expect(store).toContain("await getUserBySession(sessionId)");
  });

  it("the fail-closed guard itself is untouched", () => {
    const auth = read("src", "services", "authService.ts");
    expect(auth).toContain("AUTH_SESSION_SECRET is unset — refusing to start.");
    expect(auth).toContain("const SESSION_SECRET = resolveSessionSecret();");
  });

  // The real acceptance: load each cron's entry service with the secret
  // absent. Before the fix every one of these threw on import.
  const entries: Array<[string, string]> = [
    ["cascade-detect", "dist/services/portfolioiq/cascadeNotify.service.js"],
    ["grade-worthy-push", "dist/services/portfolioiq/gradeWorthyPushNotify.service.js"],
    ["watchlist-digest", "dist/services/portfolioiq/watchlistDigestNotify.service.js"],
  ];

  for (const [cron, rel] of entries) {
    it(`${cron} imports its service with AUTH_SESSION_SECRET unset`, async () => {
      const prior = process.env.AUTH_SESSION_SECRET;
      delete process.env.AUTH_SESSION_SECRET;
      try {
        const abs = path.join(BACKEND, rel);
        expect(fs.existsSync(abs), `${rel} missing — run npm run build`).toBe(true);
        // A cache-busting query so this is a real load, not a hit on a module
        // some earlier suite imported while the secret was still set.
        const posix = abs.split(path.sep).join("/");
        const url = `${new URL("file:///" + posix).href}?noSecret=${Date.now()}`;
        await expect(import(/* @vite-ignore */ url)).resolves.toBeTruthy();
      } finally {
        if (prior === undefined) delete process.env.AUTH_SESSION_SECRET;
        else process.env.AUTH_SESSION_SECRET = prior;
      }
    });
  }
});
