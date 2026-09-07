// CF-TCA-ENV-CHAIN-UNBROKEN (2026-09-07). A workflow-only fix, so the gate
// IS the text — plus a real bash execution of the extracted block, because
// the whole defect was that the YAML *looked* correct.
//
// The 2026-09-06/07 outage: eight consecutive scheduled TCA firehose runs
// went red with "TCA ingest wrote nothing on every platform" while
// x-ratelimit-remaining sat at 199,997. The cause was not quota and not the
// reconciliation verdict — it was a comment placed BETWEEN the trailing `\`
// of the CRAWLER_ID assignment and `node`. A backslash-newline continues
// onto the comment line, the comment ends the command, and the whole
// env-assignment chain bound to `set +e` (a builtin, which discards the
// assignments). `node` then ran as a separate command with an empty
// environment and died instantly with "COSMOS_CONNECTION_STRING required".
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as os from "node:os";

const ROOT = path.join(__dirname, "..", "..");
const yml = fs
  .readFileSync(path.join(ROOT, ".github", "workflows", "tca-firehose-ingest.yml"), "utf8")
  .replace(/\r\n/g, "\n");

/** The env-assignment chain that must reach `node` unbroken. */
function ingestChain(): string[] {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) =>
    l.trim().startsWith('COSMOS_CONNECTION_STRING="$COSMOS_CONNECTION_STRING"'));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) =>
    i > start && l.trim() === "node scripts/tca-firehose-ingest.cjs");
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1);
}

describe("TCA firehose env chain reaches node", () => {
  it("no comment interrupts the assignment chain", () => {
    const chain = ingestChain();
    const comments = chain.filter((l) => l.trim().startsWith("#"));
    expect(comments).toEqual([]);
  });

  it("every line but the last continues with a trailing backslash", () => {
    const chain = ingestChain();
    for (const l of chain.slice(0, -1)) expect(l.endsWith("\\")).toBe(true);
    expect(chain[chain.length - 1].trim()).toBe("node scripts/tca-firehose-ingest.cjs");
  });

  it("`set +e` is OUTSIDE the chain, so it cannot swallow the assignments", () => {
    expect(ingestChain().some((l) => l.trim() === "set +e")).toBe(false);
    // it still has to be there, immediately before the chain
    expect(yml).toMatch(/set \+e\n\s+COSMOS_CONNECTION_STRING="\$COSMOS_CONNECTION_STRING" \\/);
  });

  it("exit 4 counts as a platform that pulled and raises the reconcile red", () => {
    expect(yml).toMatch(/4\)\s+PLATFORMS_OK=\$\(\(PLATFORMS_OK\+1\)\)/);
    expect(yml).toMatch(/RECONCILE_RED=1/);
  });

  // The executable pin: run the real block with a stub in place of node and
  // assert the child actually receives the environment.
  it("the extracted block delivers the env to the child process", () => {
    if (process.platform === "win32" && !process.env.SHELL) return; // no bash → skip
    let blk = ingestChain().join("\n");
    // strip GitHub expressions (they are not shell)
    while (blk.includes("${{")) {
      const a = blk.indexOf("${{");
      let d = 0, k = a + 1;
      for (; k < blk.length; k++) {
        if (blk[k] === "{") d++;
        else if (blk[k] === "}" && --d === 0) break;
      }
      blk = blk.slice(0, a) + "STUB" + blk.slice(k + 1);
    }
    // No eval / indirection: print each var directly, so nothing depends on
    // a second layer of shell quoting. An undelivered var is simply empty.
    const probe = [
      "n=0",
      'for v in "$COSMOS_CONNECTION_STRING" "$TCA_API_KEY" "$APPLY" "$CRAWLER_ID" "$PLATFORM"; do',
      '  if [ -n "$v" ]; then n=$((n+1)); fi',
      "done",
      'echo "ENVCOUNT=$n"',
    ].join(String.fromCharCode(10));
    const probePath = path.join(os.tmpdir(), `tca-probe-${process.pid}.sh`);
    fs.writeFileSync(probePath, probe, "utf8");
    blk = blk.replace("node scripts/tca-firehose-ingest.cjs", "bash " + probePath.split("\\").join("/"));
    const script = [
      "COSMOS_CONNECTION_STRING=conn", "TCA_API_KEY=key", "PER_PLATFORM_MIN=12",
      "P_CLEAN=eBay", 'CAT_FILTER=""', blk,
    ].join("\n");
    const scriptPath = path.join(os.tmpdir(), `tca-chain-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, script, "utf8");
    try {
      const out = execFileSync("bash", [scriptPath], { encoding: "utf8" });
      // All five must arrive. Before the fix this was ENVCOUNT=0.
      expect(out).toContain("ENVCOUNT=5");
    } finally {
      fs.rmSync(probePath, { force: true });
      fs.rmSync(scriptPath, { force: true });
    }
  });
});
