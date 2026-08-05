#!/usr/bin/env node
// HobbyIQ design-token codegen (Drew, 2026-08-05).
//
// Reads design/tokens.json (single source of truth) and writes:
//   - HobbyIQ/DesignSystem/HobbyIQTokens.generated.swift
//       Swift enum HobbyIQTokens { enum Colors { … }; enum Spacing { … }; … }
//       imported by HobbyIQTheme.swift so all HobbyIQTheme.Colors.* keep
//       working (backwards-compatible aliases live in HobbyIQTheme.swift).
//   - apps/web/src/app/tokens.generated.css
//       :root custom-property block. Imported by globals.css so every
//       --hiq-* var / --color-* alias resolves to the shared value.
//
// Run: node design/gen-tokens.mjs
//
// Never edit the .generated.* files by hand — regenerate.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const tokensPath = join(here, "tokens.json");
const swiftOut = join(repoRoot, "HobbyIQ", "DesignSystem", "HobbyIQTokens.generated.swift");
const cssOut = join(repoRoot, "apps", "web", "src", "app", "tokens.generated.css");

const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));

// ─── helpers ─────────────────────────────────────────────────

function toCamel(name) { return name; }
function toKebab(name) { return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/^-/, ""); }
function hexToUInt(hex) {
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length === 6) return `0x${s.toUpperCase()}`;
  throw new Error(`Only 6-digit hex supported: ${hex}`);
}
function hexToRGB(hex) {
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = parseInt(s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function rgba(hex, alpha) {
  const [r, g, b] = hexToRGB(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
function alphaColor(baseHex, alpha) {
  return rgba(baseHex, alpha);
}

// ─── Swift generation ───────────────────────────────────────

function genSwift() {
  const lines = [];
  lines.push("// GENERATED — DO NOT EDIT MANUALLY.");
  lines.push("// Source: design/tokens.json  · Regen: node design/gen-tokens.mjs");
  lines.push("//");
  lines.push("// Consumed by HobbyIQTheme.swift, which re-exports the values so all");
  lines.push("// existing HobbyIQTheme.Colors.* / .Spacing.* / .Typography.* / .Radius.*");
  lines.push("// call sites keep working. Edit tokens.json, not this file.");
  lines.push("");
  lines.push("import SwiftUI");
  lines.push("");
  lines.push("enum HobbyIQTokens {");

  // Colors
  lines.push("    enum Colors {");
  for (const [name, hex] of Object.entries(tokens.colors)) {
    lines.push(`        static let ${name} = Color(hex: ${hexToUInt(hex)})`);
  }
  // Alpha tokens
  for (const [name, spec] of Object.entries(tokens.alphaTokens)) {
    if (name.startsWith("$")) continue;
    const baseHex = spec.base.startsWith("#") ? spec.base : tokens.colors[spec.base];
    if (!baseHex) throw new Error(`Unknown alpha base color: ${spec.base}`);
    if (spec.base === "#000000") {
      lines.push(`        static let ${name} = Color.black.opacity(${spec.alpha})`);
    } else if (spec.base === "pureWhite") {
      lines.push(`        static let ${name} = Color.white.opacity(${spec.alpha})`);
    } else {
      lines.push(`        static let ${name} = Color(hex: ${hexToUInt(baseHex)}).opacity(${spec.alpha})`);
    }
  }
  lines.push("    }");
  lines.push("");

  // Gradients (linear only for now)
  lines.push("    enum Gradients {");
  for (const [name, g] of Object.entries(tokens.gradients)) {
    if (name.startsWith("$")) continue;
    // Convert CSS angle to SwiftUI start/end. 135deg = top-leading→bottom-trailing.
    // Only support the common angle for now — extend when tokens.json grows more variants.
    if (g.angleDeg === 135) {
      const stops = g.stops.map((s) => `Color(hex: ${hexToUInt(s.color)})`).join(", ");
      lines.push(`        static let ${name} = LinearGradient(colors: [${stops}], startPoint: .topLeading, endPoint: .bottomTrailing)`);
    } else {
      throw new Error(`Unsupported gradient angle: ${g.angleDeg} (extend gen-tokens.mjs)`);
    }
  }
  lines.push("    }");
  lines.push("");

  // Spacing
  lines.push("    enum Spacing {");
  for (const [name, value] of Object.entries(tokens.spacing)) {
    lines.push(`        static let ${name}: CGFloat = ${value}`);
  }
  lines.push("    }");
  lines.push("");

  // Radius
  lines.push("    enum Radius {");
  for (const [name, value] of Object.entries(tokens.radius)) {
    lines.push(`        static let ${name}: CGFloat = ${value}`);
  }
  lines.push("    }");
  lines.push("");

  // Typography
  lines.push("    enum Typography {");
  for (const [name, spec] of Object.entries(tokens.typography)) {
    if (name.startsWith("$")) continue;
    const weight = spec.weight >= 700 ? ".bold" : spec.weight >= 600 ? ".semibold" : ".regular";
    const design = spec.design === "rounded" ? ".rounded" : ".default";
    lines.push(`        static let ${name} = Font.system(size: ${spec.size}, weight: ${weight}, design: ${design})`);
  }
  lines.push("    }");

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// ─── CSS generation ─────────────────────────────────────────

function genCss() {
  const lines = [];
  lines.push("/* GENERATED — DO NOT EDIT MANUALLY.");
  lines.push(" * Source: design/tokens.json  · Regen: node design/gen-tokens.mjs");
  lines.push(" *");
  lines.push(" * Imported by apps/web/src/app/globals.css. Every --hiq-* variable is");
  lines.push(" * the single source of truth — the legacy --color-* aliases in globals.css");
  lines.push(" * reference these tokens. Edit tokens.json, not this file. */");
  lines.push("");
  lines.push(":root {");

  // Colors
  lines.push("  /* Colors */");
  for (const [name, hex] of Object.entries(tokens.colors)) {
    lines.push(`  --hiq-${toKebab(name)}: ${hex};`);
  }
  lines.push("");

  // Alpha tokens
  lines.push("  /* Alpha-derived colors */");
  for (const [name, spec] of Object.entries(tokens.alphaTokens)) {
    if (name.startsWith("$")) continue;
    const baseHex = spec.base.startsWith("#") ? spec.base : tokens.colors[spec.base];
    lines.push(`  --hiq-${toKebab(name)}: ${rgba(baseHex, spec.alpha)};`);
  }
  lines.push("");

  // Gradients
  lines.push("  /* Gradients */");
  for (const [name, g] of Object.entries(tokens.gradients)) {
    if (name.startsWith("$")) continue;
    const stopsStr = g.stops.map((s) => `${s.color} ${Math.round(s.position * 100)}%`).join(", ");
    lines.push(`  --hiq-gradient-${toKebab(name)}: linear-gradient(${g.angleDeg}deg, ${stopsStr});`);
  }
  // Alias — keep --hiq-brand-gradient stable for existing consumers.
  lines.push(`  --hiq-brand-gradient: var(--hiq-gradient-brand);`);
  lines.push("");

  // Spacing
  lines.push("  /* Spacing */");
  const spacingAlias = { xxSmall: "xxs", xSmall: "xs", small: "sm", medium: "md", large: "lg", xLarge: "xl", xxLarge: "xxl", screenPadding: "screen-pad", cardPadding: "card-pad" };
  for (const [name, value] of Object.entries(tokens.spacing)) {
    const alias = spacingAlias[name] ?? toKebab(name);
    lines.push(`  --hiq-space-${alias}: ${value}px;`);
  }
  lines.push("");

  // Radius
  lines.push("  /* Radius */");
  const radiusAlias = { xSmall: "xs", small: "sm", medium: "md", large: "lg", xLarge: "xl", pill: "pill" };
  for (const [name, value] of Object.entries(tokens.radius)) {
    const alias = radiusAlias[name] ?? toKebab(name);
    const unit = name === "pill" ? "px" : "px";
    lines.push(`  --hiq-radius-${alias}: ${value}${unit};`);
  }
  lines.push("}");
  lines.push("");

  // Typography classes — mirror the iOS Font tokens as CSS utility classes.
  lines.push("/* Typography utility classes — match HobbyIQTheme.Typography exactly. */");
  const typoClass = { hero: "hiq-hero", title: "hiq-title", sectionTitle: "hiq-section-title", cardTitle: "hiq-card-title", body: "hiq-body", bodyEmphasis: "hiq-body-emph", caption: "hiq-caption", captionEmphasis: "hiq-caption-emph", statNumber: "hiq-stat-number", statSubtle: "hiq-stat-subtle" };
  for (const [name, spec] of Object.entries(tokens.typography)) {
    if (name.startsWith("$")) continue;
    const cls = typoClass[name] ?? `hiq-${toKebab(name)}`;
    const stack = spec.design === "rounded" ? "var(--hiq-font-rounded)" : "var(--hiq-font-body)";
    lines.push(`.${cls} { font: ${spec.weight} ${spec.size}px/${spec.lineHeight} ${stack}; }`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─── write ──────────────────────────────────────────────────

writeFileSync(swiftOut, genSwift(), "utf8");
console.log(`wrote ${swiftOut}`);
writeFileSync(cssOut, genCss(), "utf8");
console.log(`wrote ${cssOut}`);
