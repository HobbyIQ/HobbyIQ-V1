// CF-COMPRESSION-TYPE-SHIM (Drew, 2026-07-25). The Daily-5AM deploy
// runs `npm ci --omit=dev` and then re-runs `npm run build` inside
// zip.js — meaning tsc executes a SECOND time with all @types/* pruned.
// @types/compression is a devDep and disappears; without a fallback
// declaration, TS7016 breaks the deploy.
//
// The runtime `compression` package works fine as `any` — its options
// object is simple and its default filter already does content-type
// checking. Typing it as `any` here satisfies both build passes.
declare module "compression";
