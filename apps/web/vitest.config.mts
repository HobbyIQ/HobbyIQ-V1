// D20 (2026-08-30). Minimal vitest for the web's PURE helpers only — the
// rung -> words mapper, the holding display-value ladder, the grade-curve
// tier pick. No DOM, no React, no fetch: `environment: "node"`. Components
// stay untested here; the point is that the doctrine rules the helpers
// encode (observed before estimate, never cost-proxy, never a median, an
// unknown rung is never hidden) are pinned by something that exits 0/1.
// CF-WEB-NO-NESTED-ANCHOR (2026-09-04): `.tsx` joins the include glob so a
// STRUCTURAL component invariant — no <a> inside an <a> — can be pinned by
// rendering to static markup. Still `environment: "node"`: react-dom/server
// needs no DOM, so this buys the invariant without a jsdom dependency.
//
// `.mts` because the package is CommonJS and Vite's native config loader
// wants ESM syntax in an ESM file.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: false,
  },
});
