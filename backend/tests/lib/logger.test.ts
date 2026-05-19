import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createLogger } from "../../src/lib/logger.js";

describe("createLogger", () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLevel == null) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    vi.restoreAllMocks();
  });

  it("returns logger with debug/info/warn/error methods", () => {
    const log = createLogger("test.module");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("warn writes JSON with ts/level/module/event and fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("cardsight.client");

    log.warn("api_http_error", { status: 500, endpoint: "searchCatalog" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0];
    const parsed = JSON.parse(String(line));
    expect(parsed.ts).toBeTypeOf("string");
    expect(parsed.level).toBe("WARN");
    expect(parsed.module).toBe("cardsight.client");
    expect(parsed.event).toBe("api_http_error");
    expect(parsed.status).toBe(500);
    expect(parsed.endpoint).toBe("searchCatalog");
  });

  it("info passes fields correctly", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("cardsight.mapper");

    log.info("catalog_zero_results", { query: "Mike Trout", take: 25 });

    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed.level).toBe("INFO");
    expect(parsed.query).toBe("Mike Trout");
    expect(parsed.take).toBe(25);
  });

  it("error includes all required fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("cardsight.translator");

    log.error("translate_failed", { code: "E_PARSE" });

    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed.ts).toBeTypeOf("string");
    expect(parsed.level).toBe("ERROR");
    expect(parsed.module).toBe("cardsight.translator");
    expect(parsed.event).toBe("translate_failed");
    expect(parsed.code).toBe("E_PARSE");
  });

  it("LOG_LEVEL=ERROR suppresses warn", () => {
    process.env.LOG_LEVEL = "ERROR";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");

    log.warn("should_not_log", { a: 1 });

    expect(spy).not.toHaveBeenCalled();
  });

  it("LOG_LEVEL=WARN suppresses info", () => {
    process.env.LOG_LEVEL = "WARN";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");

    log.info("should_not_log", { a: 1 });

    expect(spy).not.toHaveBeenCalled();
  });

  it("default LOG_LEVEL=INFO suppresses debug", () => {
    delete process.env.LOG_LEVEL;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");

    log.debug("debug_event", { a: 1 });

    expect(spy).not.toHaveBeenCalled();
  });

  it("invalid LOG_LEVEL falls back to INFO", () => {
    process.env.LOG_LEVEL = "NOT_A_LEVEL";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");

    log.debug("debug_event", { a: 1 });
    log.info("info_event", { b: 2 });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed.event).toBe("info_event");
  });

  it("circular fields do not throw and emits fallback log", () => {
    process.env.LOG_LEVEL = "DEBUG";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => log.debug("circular", circular)).not.toThrow();

    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed.level).toBe("DEBUG");
    expect(parsed.module).toBe("test.module");
    expect(parsed.event).toBe("circular");
    expect(parsed._serializeError).toBe(true);
  });

  it("omitted or empty fields still produce valid log line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test.module");

    log.info("no_fields");
    log.info("empty_fields", {});

    const first = JSON.parse(String(spy.mock.calls[0][0]));
    const second = JSON.parse(String(spy.mock.calls[1][0]));
    expect(first.event).toBe("no_fields");
    expect(second.event).toBe("empty_fields");
    expect(first.module).toBe("test.module");
    expect(second.module).toBe("test.module");
  });

  it("module name appears in every log", () => {
    process.env.LOG_LEVEL = "DEBUG";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("cardsight.client");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const modules = spy.mock.calls.map((c) => JSON.parse(String(c[0])).module);
    expect(modules).toEqual(["cardsight.client", "cardsight.client", "cardsight.client", "cardsight.client"]);
  });
});
