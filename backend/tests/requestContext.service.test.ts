// CF-REQUEST-CONTEXT smoke tests. Verifies AsyncLocalStorage integration.

import { describe, it, expect } from "vitest";
import {
  getCurrentUserId,
  setCurrentUserId,
  runWithUserId,
} from "../src/services/portfolioiq/requestContext.service.js";

describe("requestContext — AsyncLocalStorage-backed userId", () => {
  it("returns null outside any request context", () => {
    expect(getCurrentUserId()).toBeNull();
  });

  it("runWithUserId provides context to inner code", () => {
    runWithUserId("user-abc", () => {
      expect(getCurrentUserId()).toBe("user-abc");
    });
    expect(getCurrentUserId()).toBeNull();     // cleared after run
  });

  it("setCurrentUserId mutates active context", () => {
    runWithUserId(null, () => {
      expect(getCurrentUserId()).toBeNull();
      setCurrentUserId("user-xyz");
      expect(getCurrentUserId()).toBe("user-xyz");
    });
  });

  it("setCurrentUserId outside context is a safe no-op", () => {
    expect(() => setCurrentUserId("user-abc")).not.toThrow();
    expect(getCurrentUserId()).toBeNull();
  });

  it("nested runs preserve isolation", () => {
    runWithUserId("outer", () => {
      expect(getCurrentUserId()).toBe("outer");
      runWithUserId("inner", () => {
        expect(getCurrentUserId()).toBe("inner");
      });
      expect(getCurrentUserId()).toBe("outer");
    });
  });
});
