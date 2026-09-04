// D-APNS (2026-09-04) — the key is a PEM, whatever shape the setting is in.
//
// App Service held APNS_KEY_P8 as the BASE64 of the whole .p8 file (344
// chars, decoding to a 257-byte P-256 PEM). `apn` got those characters as
// UTF-8 bytes, OpenSSL refused them with "error:1E08010C:DECODER
// routines::unsupported", getProvider() returned null, and every push
// silently no-op'd from ~2026-08-20. Only the Personal Prospect Breakout
// nightly asserts delivery, so it alone went red.
//
// Pins:
//   1. all three legitimate shapes load and initialise the provider:
//      raw PEM, PEM with literal "\n" escapes, base64 of the PEM
//   2. the loaded key is byte-identical across shapes (same key, one PEM)
//   3. a flattened PEM and other garbage are REFUSED, with a reason that
//      names the failure and the length and never leaks key content
//   4. an unset value keeps the no-op, with an explicit reason
//
// Every key here is generated in-process and never written to disk.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";

const { loadApnsKey } = await import("../src/services/notification.service.js");

// ── Throwaway key material (in-memory only) ─────────────────────────
//
// P-256 / PKCS#8, the same shape Apple issues a .p8 in.
function makePem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // Node emits PKCS#8 PEM with a trailing newline, exactly as a .p8 file
  // holds it. That newline is the canonical form the loader normalises to.
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const BACKSLASH_N = String.fromCharCode(92) + "n";
/** The JSON/shell round-trip shape: real newlines become two characters. */
const escapePem = (pem: string) => pem.split("\n").join(BACKSLASH_N);
const base64Pem = (pem: string) => Buffer.from(pem, "utf8").toString("base64");

describe("loadApnsKey accepts every shape the setting is legitimately stored in", () => {
  const pem = makePem();

  it("raw PEM (what a .p8 file holds)", () => {
    const r = loadApnsKey(pem);
    expect(r.shape).toBe("pem");
    expect(r.reason).toBeNull();
    expect(r.key).toBe(pem);
  });

  it('PEM with literal "\\n" escapes (JSON / shell round-trip)', () => {
    const escaped = escapePem(pem);
    // Guard the fixture: the escaped form must NOT contain real newlines,
    // and must be exactly what blew up in prod.
    expect(escaped).not.toContain("\n");
    expect(() => createPrivateKey(escaped)).toThrow(/DECODER|unsupported/);

    const r = loadApnsKey(escaped);
    expect(r.shape).toBe("escaped-pem");
    expect(r.reason).toBeNull();
    expect(r.key).toBe(pem);
  });

  it("base64 of the PEM (the shape that was live on App Service)", () => {
    const b64 = base64Pem(pem);
    expect(b64).not.toContain("-----BEGIN");

    const r = loadApnsKey(b64);
    expect(r.shape).toBe("base64-pem");
    expect(r.reason).toBeNull();
    expect(r.key).toBe(pem);
  });

  it("all three shapes normalise to the SAME PEM, and each one parses", () => {
    const keys = [pem, escapePem(pem), base64Pem(pem)].map((v) => loadApnsKey(v).key);
    expect(new Set(keys).size).toBe(1);
    for (const k of keys) {
      expect(k).not.toBeNull();
      expect(() => createPrivateKey(k as string)).not.toThrow();
    }
  });

  it("base64 of an ESCAPED PEM still lands (both round-trips at once)", () => {
    const r = loadApnsKey(base64Pem(escapePem(pem)));
    expect(r.shape).toBe("base64-pem");
    expect(r.key).toBe(pem);
  });

  it("surrounding whitespace does not defeat detection", () => {
    expect(loadApnsKey(`\n  ${pem}  \n`).shape).toBe("pem");
    expect(loadApnsKey(`  ${base64Pem(pem)}  `).shape).toBe("base64-pem");
  });
});

describe("loadApnsKey refuses what it cannot verify, loudly and without leaking", () => {
  const pem = makePem();

  const bad: Array<[string, string]> = [
    // A PEM flattened onto one line: structure was destroyed, not escaped.
    ["flattened PEM", pem.replace(/\n/g, "")],
    // Header present, body truncated.
    ["truncated PEM", pem.slice(0, 60)],
    // Plausible-looking base64 that decodes to nothing key-shaped.
    ["base64 of non-PEM", Buffer.from("not a key at all", "utf8").toString("base64")],
    ["arbitrary text", "hunter2-not-a-key"],
  ];

  for (const [name, value] of bad) {
    it(`${name} is refused with a reason naming the length, never the content`, () => {
      const r = loadApnsKey(value);
      expect(r.key).toBeNull();
      expect(r.shape).toBeNull();
      expect(r.reason).toBeTruthy();
      const reason = r.reason as string;
      expect(reason).toContain("APNS_KEY_P8");
      expect(reason).toContain(String(value.trim().length));
      // The credential must never reach a log line. Check the reason carries
      // no run of key material.
      expect(reason).not.toContain(value.trim().slice(0, 24));
      expect(reason).not.toContain("PRIVATE KEY-----\n");
    });
  }

  it("a flattened PEM is not silently re-wrapped into a key", () => {
    const r = loadApnsKey(pem.replace(/\n/g, ""));
    expect(r.key).toBeNull();
    expect(r.reason).toMatch(/flattened onto one line cannot be recovered/);
  });

  it("unset / empty keeps the no-op with an explicit reason", () => {
    for (const v of [undefined, null, "", "   "]) {
      const r = loadApnsKey(v as any);
      expect(r.key).toBeNull();
      expect(r.reason).toMatch(/unset or empty/);
    }
  });
});

// ── Provider initialisation, end to end ──────────────────────────────
//
// The loader is only useful if the value it returns is one `apn.Provider`
// actually accepts. Rather than trust the string, each shape is driven
// through getProvider() with apn mocked, and the key it received is parsed
// with node:crypto — the exact step that threw in prod.
describe("every accepted shape initialises the provider", () => {
  const pem = makePem();
  const ENV_KEYS = [
    "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_KEY_P8", "APNS_PRODUCTION",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    vi.doUnmock("apn");
  });

  async function initWith(keyValue: string | undefined) {
    const seenKeys: Buffer[] = [];
    vi.doMock("apn", () => ({
      default: {
        Provider: class {
          constructor(opts: any) { seenKeys.push(opts.token.key); }
        },
        Notification: class {},
      },
    }));
    process.env.APNS_KEY_ID = "TESTKEYID1";
    process.env.APNS_TEAM_ID = "TESTTEAMID";
    process.env.APNS_BUNDLE_ID = "com.hobbyiq.test";
    process.env.APNS_PRODUCTION = "false";
    if (keyValue === undefined) delete process.env.APNS_KEY_P8;
    else process.env.APNS_KEY_P8 = keyValue;

    const mod = await import("../src/services/notification.service.js");
    const configured = mod.isPushProviderConfigured();
    return { configured, seenKeys };
  }

  for (const [name, make] of [
    ["raw PEM", (p: string) => p],
    ["escaped PEM", escapePem],
    ["base64 PEM", base64Pem],
  ] as Array<[string, (p: string) => string]>) {
    it(`${name}: provider is configured and gets a parseable key`, async () => {
      const { configured, seenKeys } = await initWith(make(pem));
      expect(configured).toBe(true);
      expect(seenKeys).toHaveLength(1);
      // The step that threw "1E08010C:DECODER routines::unsupported" in prod.
      expect(() => createPrivateKey(seenKeys[0].toString("utf8"))).not.toThrow();
    });
  }

  it("a flattened key logs one refusal naming the shape and length, and no-ops", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: any[]) => { errs.push(a.join(" ")); });
    const flat = pem.replace(/\n/g, "");
    try {
      const { configured, seenKeys } = await initWith(flat);
      expect(configured).toBe(false);
      expect(seenKeys).toHaveLength(0); // never handed to apn
      const refusals = errs.filter((e) => e.includes("APNs key rejected"));
      expect(refusals).toHaveLength(1); // one clear line, not a stack
      expect(refusals[0]).toContain(String(flat.length));
      expect(refusals[0]).toContain("Push sends will no-op");
      expect(refusals[0]).not.toContain(flat.slice(0, 24)); // no key content
    } finally {
      spy.mockRestore();
    }
  });

  it("an unset key still no-ops, naming the missing var", async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a: any[]) => { warns.push(a.join(" ")); });
    try {
      const { configured } = await initWith(undefined);
      expect(configured).toBe(false);
      expect(warns.join("\n")).toContain("APNS_KEY_P8");
    } finally {
      spy.mockRestore();
    }
  });
});
