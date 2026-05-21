import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isCompLogsDisabled,
  getCompLogsSampleRate,
  __compLogsConfigInternals,
} from "../src/services/compLogs/compLogsConfig";

const ENV_DISABLED = "COMPIQ_COMP_LOGS_DISABLED";
const ENV_RATE = "COMPIQ_COMP_LOGS_SAMPLE_RATE";

function clearEnv() {
  delete process.env[ENV_DISABLED];
  delete process.env[ENV_RATE];
}

describe("compLogsConfig — isCompLogsDisabled", () => {
  beforeEach(() => clearEnv());
  afterEach(() => clearEnv());

  it("returns false when env var is unset", () => {
    expect(isCompLogsDisabled()).toBe(false);
  });

  it.each(["1", "true", "True", "TRUE", "yes", "YES"])(
    'returns true when env var = "%s"',
    (val) => {
      process.env[ENV_DISABLED] = val;
      expect(isCompLogsDisabled()).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", "", "  "])(
    'returns false when env var = "%s"',
    (val) => {
      process.env[ENV_DISABLED] = val;
      expect(isCompLogsDisabled()).toBe(false);
    },
  );
});

describe("compLogsConfig — getCompLogsSampleRate", () => {
  beforeEach(() => {
    clearEnv();
    __compLogsConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("returns 0 when env var is unset", () => {
    expect(getCompLogsSampleRate()).toBe(0);
  });

  it("returns 0 when env var is empty string", () => {
    process.env[ENV_RATE] = "";
    expect(getCompLogsSampleRate()).toBe(0);
  });

  it.each([
    ["0", 0],
    ["0.01", 0.01],
    ["0.5", 0.5],
    ["1", 1],
    ["1.0", 1],
  ])('parses valid value "%s" as %s', (val, expected) => {
    process.env[ENV_RATE] = val;
    expect(getCompLogsSampleRate()).toBe(expected);
  });

  it.each(["-0.1", "1.5", "abc", "NaN", "0,5"])(
    'returns 0 and warns once for invalid value "%s"',
    (val) => {
      process.env[ENV_RATE] = val;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(getCompLogsSampleRate()).toBe(0);
      expect(getCompLogsSampleRate()).toBe(0); // second call: still 0
      expect(warnSpy).toHaveBeenCalledTimes(1); // but only one warn
      warnSpy.mockRestore();
    },
  );

  it("re-reads env on every call (no caching)", () => {
    process.env[ENV_RATE] = "0.1";
    expect(getCompLogsSampleRate()).toBe(0.1);
    process.env[ENV_RATE] = "0.5";
    expect(getCompLogsSampleRate()).toBe(0.5);
    delete process.env[ENV_RATE];
    expect(getCompLogsSampleRate()).toBe(0);
  });
});
