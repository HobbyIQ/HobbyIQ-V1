/**
 * Unit tests for the Beckett sweep orchestrator.
 *
 * We don't hit live Beckett S3 in CI — we mock `fetch` to serve a known
 * fixture and verify the staged file layout + SUMMARY + REPORT.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, expect, it, vi, afterEach } from "vitest";

import { runBeckettSweep } from "../src/agents/beckett/sweepOrchestrator.js";

const FIXTURE_2022_BOWMAN = path.resolve(
  __dirname,
  "fixtures",
  "beckett",
  "2022-Bowman-Baseball-Checklist-2.xlsx",
);

describe("runBeckettSweep — integration with mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("end-to-end: discover + fetch + parse + dedup + stage one tuple", async () => {
    const fixtureBytes = fs.readFileSync(FIXTURE_2022_BOWMAN);
    const winningUrl =
      "https://beckett-www.s3.amazonaws.com/news/news-content/uploads/2022/04/2022-Bowman-Baseball-Checklist.xlsx";

    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      const method = init?.method ?? "GET";
      if (String(url) === winningUrl) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(fixtureBytes.byteLength),
            },
          });
        }
        // GET: return the actual fixture bytes
        return new Response(fixtureBytes as unknown as ArrayBuffer, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response(null, { status: 404 });
    }) as any;

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sweep-test-"));
    try {
      const summary = await runBeckettSweep({
        years: [2022],
        brands: ["Bowman"],
        outDir: tmpDir,
        timeoutMs: 5000,
        concurrency: 1,
        force: true,
      });

      expect(summary.tuplesAttempted).toBe(1);
      expect(summary.tuplesOk).toBe(1);
      expect(summary.totalDedupedCards).toBeGreaterThan(500);

      // Staged files exist
      const stagedFile = path.join(tmpDir, "2022", "Bowman.json");
      const summaryFile = path.join(tmpDir, "SUMMARY.json");
      const unmatchedFile = path.join(tmpDir, "unmatchedParallels.json");
      const reportFile = path.join(tmpDir, "REPORT.md");

      expect(fs.existsSync(stagedFile)).toBe(true);
      expect(fs.existsSync(summaryFile)).toBe(true);
      expect(fs.existsSync(unmatchedFile)).toBe(true);
      expect(fs.existsSync(reportFile)).toBe(true);

      const staged = JSON.parse(await fsp.readFile(stagedFile, "utf-8"));
      expect(staged.year).toBe(2022);
      expect(staged.brand).toBe("Bowman");
      expect(staged.sport).toBe("Baseball");
      expect(staged.cards.length).toBe(summary.totalDedupedCards);
      expect(Array.isArray(staged.parallels)).toBe(true);

      const report = await fsp.readFile(reportFile, "utf-8");
      expect(report).toMatch(/Beckett Sweep Report/);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resumability: second run with same outDir skips already-staged tuple", async () => {
    const fixtureBytes = fs.readFileSync(FIXTURE_2022_BOWMAN);
    const winningUrl =
      "https://beckett-www.s3.amazonaws.com/news/news-content/uploads/2022/04/2022-Bowman-Baseball-Checklist.xlsx";

    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const method = init?.method ?? "GET";
      if (String(url) === winningUrl) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(fixtureBytes.byteLength),
            },
          });
        }
        return new Response(fixtureBytes as unknown as ArrayBuffer, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    globalThis.fetch = fetchMock as any;

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sweep-resume-"));
    try {
      await runBeckettSweep({
        years: [2022],
        brands: ["Bowman"],
        outDir: tmpDir,
        timeoutMs: 5000,
        concurrency: 1,
        force: true,
      });
      const callsAfterFirst = fetchMock.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Second run — should NOT make any fresh fetches
      await runBeckettSweep({
        years: [2022],
        brands: ["Bowman"],
        outDir: tmpDir,
        timeoutMs: 5000,
        concurrency: 1,
        force: false,
      });
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("missing tuple is reported but does not throw", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as any;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sweep-miss-"));
    try {
      const summary = await runBeckettSweep({
        years: [2099],
        brands: ["Bowman"],
        outDir: tmpDir,
        timeoutMs: 5000,
        concurrency: 1,
        force: true,
      });
      expect(summary.tuplesAttempted).toBe(1);
      expect(summary.tuplesOk).toBe(0);
      expect(summary.tuplesMissing).toBe(1);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
