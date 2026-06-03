// CF-PAYMENTS-A — requireSession middleware unit test.
//
// Verifies the contract:
//   - 401 when x-session-id header is missing.
//   - 401 when getUserBySession returns null (invalid session).
//   - attaches req.user + calls next() on success.
//   - short-circuits (no re-auth) when req.user already attached.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/authService.js", () => ({
  // Defined here so the import below resolves; per-test overrides via
  // .mockResolvedValueOnce.
  getUserBySession: vi.fn(),
}));

const auth = await import("../src/services/authService.js");
const { requireSession } = await import("../src/middleware/requireSession.js");

function makeReqRes(headers: Record<string, string> = {}, preAttachedUser?: any) {
  const req: any = { headers, user: preAttachedUser };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: any) { body = payload; return res; },
  };
  Object.defineProperty(res, "_status", { get: () => statusCode });
  Object.defineProperty(res, "_body", { get: () => body });
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireSession middleware", () => {
  it("401 when x-session-id is missing", async () => {
    const { req, res, next } = makeReqRes({});
    await requireSession(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({
      success: false,
      error: "Missing or invalid x-session-id header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("401 when x-session-id is whitespace-only", async () => {
    const { req, res, next } = makeReqRes({ "x-session-id": "   " });
    await requireSession(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401 when getUserBySession returns null", async () => {
    (auth.getUserBySession as any).mockResolvedValueOnce(null);
    const { req, res, next } = makeReqRes({ "x-session-id": "bad-session" });
    await requireSession(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({
      success: false,
      error: "Missing or invalid x-session-id header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.user + calls next() on success", async () => {
    const user = {
      userId: "u-1",
      email: "x@y.z",
      username: null,
      fullName: null,
      plan: "collector",
      createdAt: "2026-01-01T00:00:00Z",
    };
    (auth.getUserBySession as any).mockResolvedValueOnce(user);
    const { req, res, next } = makeReqRes({ "x-session-id": "ok-session" });
    await requireSession(req, res, next);
    expect(req.user).toEqual(user);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when req.user is already attached (idempotent)", async () => {
    const preAttached = { userId: "u-1", plan: "investor" } as any;
    const { req, res, next } = makeReqRes({ "x-session-id": "any" }, preAttached);
    await requireSession(req, res, next);
    expect(req.user).toBe(preAttached);
    expect(next).toHaveBeenCalledTimes(1);
    expect(auth.getUserBySession).not.toHaveBeenCalled();
  });
});
