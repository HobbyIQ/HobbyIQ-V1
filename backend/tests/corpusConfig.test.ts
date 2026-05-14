import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isCorpusDisabled,
  getCorpusSampleRate,
  __corpusConfigInternals,
} from "../src/services/corpus/corpusConfig";

const ENV_DISABLED = "COMPIQ_CORPUS_DISABLED";
const ENV_RATE = "COMPIQ_CORPUS_SAMPLE_RATE";

function clearEnv() {
  delete process.env[ENV_DISABLED];
  delete process.env[ENV_RATE];
}

describe("corpusConfig — isCorpusDisabled()", () => {
  beforeEach(() => clearEnv());
  afterEach(() => clearEnv());

  it("returns false when unset", () => {
    expect(isCorpusDisabled()).toBe(false);
  });

  it("returns false for empty string", () => {
    process.env[ENV_DISABLED] = "";
    expect(isCorpusDisabled()).toBe(false);
  });

  it("returns true for \"1\"", () => {
    process.env[ENV_DISABLED] = "1";
    expect(isCorpusDisabled()).toBe(true);
  });

  it("returns true for \"true\" (lowercase)", () => {
    process.env[ENV_DISABLED] = "true";
    expect(isCorpusDisabled()).toBe(true);
  });

  it("returns true for \"TRUE\" (case-insensitive)", () => {
    process.env[ENV_DISABLED] = "TRUE";
    expect(isCorpusDisabled()).toBe(true);
  });

  it("returns true for \"yes\"", () => {
    process.env[ENV_DISABLED] = "yes";
    expect(isCorpusDisabled()).toBe(true);
  });

  it("returns false for \"0\"", () => {
    process.env[ENV_DISABLED] = "0";
    expect(isCorpusDisabled()).toBe(false);
  });

  it("returns false for \"false\"", () => {
    process.env[ENV_DISABLED] = "false";
    expect(isCorpusDisabled()).toBe(false);
  });

  it("returns false for unrelated string \"maybe\"", () => {
    process.env[ENV_DISABLED] = "maybe";
    expect(isCorpusDisabled()).toBe(false);
  });

  it("re-reads on every call (no caching)", () => {
    expect(isCorpusDisabled()).toBe(false);
    process.env[ENV_DISABLED] = "1";
    expect(isCorpusDisabled()).toBe(true);
    process.env[ENV_DISABLED] = "0";
    expect(isCorpusDisabled()).toBe(false);
  });
});

describe("corpusConfig — getCorpusSampleRate()", () => {
  beforeEach(() => {
    clearEnv();
    __corpusConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("returns 0 when unset (no warning)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getCorpusSampleRate()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 0 for empty string (no warning)", () => {
    process.env[ENV_RATE] = "";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getCorpusSampleRate()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns parsed float for valid in-range value", () => {
    process.env[ENV_RATE] = "0.25";
    expect(getCorpusSampleRate()).toBe(0.25);
  });

  it("returns 0 exactly for \"0\"", () => {
    process.env[ENV_RATE] = "0";
    expect(getCorpusSampleRate()).toBe(0);
  });

  it("returns 1 exactly for \"1\"", () => {
    process.env[ENV_RATE] = "1";
    expect(getCorpusSampleRate()).toBe(1);
  });

  it("warns once and returns 0 for non-numeric value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_RATE] = "abc";
    expect(getCorpusSampleRate()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("warns once and returns 0 for negative value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_RATE] = "-0.1";
    expect(getCorpusSampleRate()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("warns once and returns 0 for value > 1", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_RATE] = "1.5";
    expect(getCorpusSampleRate()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("warns only ONCE per process across multiple invalid reads", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_RATE] = "abc";
    getCorpusSampleRate();
    getCorpusSampleRate();
    process.env[ENV_RATE] = "-5";
    getCorpusSampleRate();
    process.env[ENV_RATE] = "NaN";
    getCorpusSampleRate();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("re-reads on every call (no caching)", () => {
    process.env[ENV_RATE] = "0.1";
    expect(getCorpusSampleRate()).toBe(0.1);
    process.env[ENV_RATE] = "0.5";
    expect(getCorpusSampleRate()).toBe(0.5);
  });
});
