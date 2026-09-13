// CF-A-CITATION-CONFIRMS-A-PENDING-ROW (#2098).
//
// A catalog row can carry `verificationStatus: "pending-review"` because a
// repair moved it on a Drew ruling rather than a checklist match --
// repair-bowman-product-refile's CF-IT-CAME-OUT-OF-BOWMAN stamp is the
// example. catalogVisibility keeps such a row PROVISIONAL and pricing
// withholds it with reason `pending-review` (#2098), and there was no lane to
// say "a source now confirms this" -- hand edits are forbidden, so the row
// stayed correct and unpriced with no way out.
//
// This file pins the `verify` action relocate-catalog-rows-by-list.cjs adds
// to close that gap:
//
//   - REFUSED at classify time without BOTH citation.source and
//     citation.ref -- doctrine is "verified" means checklist-backed or ruled
//     by Drew WITH A CITATION, never a bare word;
//   - REFUSED when the row is not `pending-review` -- verify only answers
//     "is THIS unconfirmed row now confirmed?", and that question is
//     meaningless off a row with no pending state;
//   - a NO-OP, reported as such, when the row already reads "verified";
//   - the APPLY shape against a mocked container: verificationStatus is set
//     to "verified" and verifiedBy is appended, and nothing else on the row
//     is patched;
//   - REPORT (dryRun) writes nothing, the same contract park and reslug
//     already honour.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const listPath = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-13-marconi-cpa-mg-gold-refractor-verify.json",
);

const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean;
    why?: string;
    action?: string;
    to?: string;
    citation?: { source: string; ref: string };
  };
};

const verifyEntry = {
  id: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50",
  action: "verify",
  reason: "checklistinsider confirms Gold Refractor /50 on the CPA ladder",
  citation: {
    source: "checklistinsider",
    ref: "https://www.checklistinsider.com/2026-bowman-baseball (Chrome Prospects Autographs ladder: Gold Refractor /50)",
  },
};

// ── classify: the citation gate ──────────────────────────────────────────────

describe("verify is REFUSED without a full citation", () => {
  it("classifies a well-formed verify", () => {
    const c = L.classifyEntry(verifyEntry);
    expect(c.ok).toBe(true);
    expect(c.action).toBe("verify");
    expect(c.citation).toEqual(verifyEntry.citation);
  });

  it("refuses a verify with no citation at all", () => {
    const c = L.classifyEntry({ id: verifyEntry.id, action: "verify", reason: "r" });
    expect(c.ok).toBe(false);
    expect(c.why).toContain("citation.source AND citation.ref");
  });

  it("refuses a citation missing `source`", () => {
    const c = L.classifyEntry({
      id: verifyEntry.id, action: "verify", reason: "r",
      citation: { ref: "https://example.com/x" },
    });
    expect(c.ok).toBe(false);
    expect(c.why).toContain("citation.source AND citation.ref");
  });

  it("refuses a citation missing `ref`", () => {
    const c = L.classifyEntry({
      id: verifyEntry.id, action: "verify", reason: "r",
      citation: { source: "checklistinsider" },
    });
    expect(c.ok).toBe(false);
    expect(c.why).toContain("citation.source AND citation.ref");
  });

  it("refuses a citation whose fields are blank strings", () => {
    const c = L.classifyEntry({
      id: verifyEntry.id, action: "verify", reason: "r",
      citation: { source: "  ", ref: "" },
    });
    expect(c.ok).toBe(false);
  });

  it("refuses a verify entry with no reason — an unexplained stamp is not reviewable", () => {
    const c = L.classifyEntry({ id: verifyEntry.id, action: "verify", citation: verifyEntry.citation });
    expect(c.ok).toBe(false);
    expect(c.why).toContain("no reason");
  });

  it("REFUSES a verify that carries a `to` — a verified row never moves", () => {
    const c = L.classifyEntry({ ...verifyEntry, to: "hiq:baseball:2025:bowman:cpa-mg:gold-refractor:auto:num-50" });
    expect(c.ok).toBe(false);
    expect(String(c.why)).toContain('must not name a "to"');
  });

  it("the unknown-action message now names all four shapes", () => {
    const c = L.classifyEntry({ id: verifyEntry.id, action: "verifyy", reason: "r" });
    expect(c.ok).toBe(false);
    expect(String(c.why)).toContain("park");
    expect(String(c.why)).toContain("retire");
    expect(String(c.why)).toContain("reslug");
    expect(String(c.why)).toContain("verify");
  });

  it("drew-ruling is an accepted source spelling, not just a checklist tag", () => {
    const c = L.classifyEntry({
      id: verifyEntry.id, action: "verify", reason: "r",
      citation: { source: "drew-ruling", ref: "CF-IT-CAME-OUT-OF-BOWMAN 2026-08-13, re-affirmed 2026-09-05" },
    });
    expect(c.ok).toBe(true);
  });
});

// ── the branch source: refusal on a non-pending row, no-op on verified ──────

describe("verify only acts on a pending-review row", () => {
  const laneSrc = readFileSync(lane, "utf8");

  it("gates on verificationStatus === 'pending-review', refusing anything else", () => {
    expect(laneSrc).toContain('if (status !== "pending-review") {');
    expect(laneSrc).toContain("refusedNotPending++");
    expect(laneSrc).toContain("verify only confirms a pending-review row");
  });

  it("an already-verified row is a NO-OP, not a write and not a refusal", () => {
    expect(laneSrc).toContain('if (status === "verified") {');
    expect(laneSrc).toContain("alreadyVerified++");
    expect(laneSrc).toContain("already verified — nothing to write");
    // The already-verified check runs BEFORE the not-pending refusal, so a
    // verified row is never also counted as refused.
    const verifiedIdx = laneSrc.indexOf('if (status === "verified") {');
    const notPendingIdx = laneSrc.indexOf('if (status !== "pending-review") {');
    expect(verifiedIdx).toBeGreaterThan(-1);
    expect(notPendingIdx).toBeGreaterThan(verifiedIdx);
  });

  it("a verify of a row that no longer exists is a refusal, not a silent no-op", () => {
    expect(laneSrc).toContain("a verify needs a row to stamp");
  });

  // Anchored on the loop-body comment, not on `if (action === "verify") {`:
  // that exact string also opens the classifyEntry citation gate near the top
  // of the file, and a bare indexOf would slice from THAT occurrence instead
  // of the branch inside the loop.
  const verifyBranch = () => laneSrc.slice(
    laneSrc.indexOf("// ── VERIFY "),
    laneSrc.indexOf('if (action === "retire") {'),
  );

  it("writes through patchCatalogRowFields, never a raw patch (#1614)", () => {
    const branch = verifyBranch();
    expect(branch).toContain("patchCatalogRowFields");
    expect(branch).not.toMatch(/\.item\([^)]*\)\.patch\(/);
    expect(branch).toContain('verificationStatus: "verified"');
    expect(branch).toContain("verifiedBy:");
    expect(branch).toContain("citation: c.citation");
    // ONE call for both modes, with dryRun -- report predicts apply.
    expect(branch).toContain("dryRun: !APPLY");
  });

  it("touches only verificationStatus and verifiedBy — nothing else is patched", () => {
    const branch = verifyBranch();
    const call = branch.slice(branch.indexOf("patchCatalogRowFields("), branch.indexOf("{ retry, dryRun"));
    expect(call).toMatch(/verificationStatus:\s*"verified"/);
    expect(call).toMatch(/verifiedBy:/);
    // No move, no delete on this path.
    expect(branch).not.toContain("moveCatalogRow");
    expect(branch).not.toContain("retireCatalogRow");
  });

  it("counts verified writes separately BY CITATION SOURCE in the banner", () => {
    expect(laneSrc).toContain("verifiedBySource");
    expect(laneSrc).toContain("of which");
  });

  it("VERIFIED reconciles on the written side, alreadyVerified as a skip", () => {
    expect(laneSrc).toContain("+ verified");
    expect(laneSrc).toContain("+ alreadyVerified");
    expect(laneSrc).toContain("+ refusedNotPending");
  });
});

// ── REPORT writes nothing ────────────────────────────────────────────────────

describe("REPORT (no BACKFILL_APPLY) writes nothing for a verify", () => {
  it("the write call always carries dryRun: !APPLY, and APPLY defaults false", () => {
    const laneSrc = readFileSync(lane, "utf8");
    expect(laneSrc).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
    const branch = laneSrc.slice(
      laneSrc.indexOf('if (action === "verify") {'),
      laneSrc.indexOf('if (action === "retire") {'),
    );
    expect(branch).toContain("dryRun: !APPLY");
  });

  it("dryRun on patchCatalogRowFields returns before any container.patch call", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");

    const patch = vi.fn();
    const container = {
      item: () => ({
        read: async () => ({
          resource: {
            id: verifyEntry.id, cardId: verifyEntry.id,
            verificationStatus: "pending-review",
          },
        }),
        patch,
      }),
    } as never;

    const res = await ops.patchCatalogRowFields(
      container, verifyEntry.id, verifyEntry.id,
      {
        verificationStatus: "verified",
        verifiedBy: { citation: verifyEntry.citation, at: "2026-09-13T00:00:00.000Z", lane: "relocate-catalog-rows-by-list" },
      },
      { dryRun: true, noShadow: true },
    );
    expect(res.action).toBe("patch");
    expect(res.fieldsChanged.sort()).toEqual(["verificationStatus", "verifiedBy"]);
    expect(patch).not.toHaveBeenCalled();
  });
});

// ── APPLY shape against a mocked container ───────────────────────────────────

describe("APPLY sets verificationStatus and appends verifiedBy, nothing else", () => {
  it("patches exactly the two fields and their shadow is suppressed", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");

    let patchedOps: Array<{ op: string; path: string; value: unknown }> = [];
    const container = {
      item: () => ({
        read: async () => ({
          resource: {
            id: verifyEntry.id, cardId: verifyEntry.id,
            playerName: "Marconi", setName: "2026 Bowman",
            verificationStatus: "pending-review",
            movedReason: "CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05)",
          },
        }),
        patch: async (ops2: typeof patchedOps) => { patchedOps = ops2; },
      }),
    } as never;

    const verifiedBy = { citation: verifyEntry.citation, at: "2026-09-13T00:00:00.000Z", lane: "relocate-catalog-rows-by-list" };
    const res = await ops.patchCatalogRowFields(
      container, verifyEntry.id, verifyEntry.id,
      { verificationStatus: "verified", verifiedBy },
      { dryRun: false, noShadow: true },
    );

    expect(res.action).toBe("patch");
    expect(res.fieldsChanged.sort()).toEqual(["verificationStatus", "verifiedBy"]);
    // No `<field>Before` shadow ops -- noShadow: true, so exactly 2 patch ops.
    expect(patchedOps).toHaveLength(2);
    const byPath = Object.fromEntries(patchedOps.map((o) => [o.path, o]));
    expect(byPath["/verificationStatus"]).toMatchObject({ op: "set", value: "verified" });
    expect(byPath["/verifiedBy"]).toMatchObject({ op: "add", value: verifiedBy });
    // Nothing else — playerName, setName, movedReason are untouched.
    expect(patchedOps.map((o) => o.path)).not.toContain("/playerName");
    expect(patchedOps.map((o) => o.path)).not.toContain("/movedReason");
  });

  it("a row already verified is a NOOP through the same helper", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");

    const patch = vi.fn();
    const container = {
      item: () => ({
        read: async () => ({
          resource: { id: verifyEntry.id, cardId: verifyEntry.id, verificationStatus: "verified" },
        }),
        patch,
      }),
    } as never;

    // The lane's own gate reads row.verificationStatus directly and never
    // reaches this call for an already-verified row (see the source pin
    // above); this exercises the helper's own idempotence as a second line
    // of defence, the same belt-and-suspenders shape park relies on for
    // identityUnverified.
    const res = await ops.patchCatalogRowFields(
      container, verifyEntry.id, verifyEntry.id,
      { verificationStatus: "verified" },
      { dryRun: false, noShadow: true },
    );
    expect(res.action).toBe("noop");
    expect(patch).not.toHaveBeenCalled();
  });

  it("id, cardId and hobbyiqCardId stay unpatchable — a verify is not an address change", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const container = { item: () => ({ read: async () => ({ resource: {} }) }) } as never;
    await expect(
      ops.patchCatalogRowFields(container, verifyEntry.id, verifyEntry.id, { hobbyiqCardId: "x" }, {}),
    ).rejects.toThrow(/address the row/);
  });
});

// ── the staged Marconi list ───────────────────────────────────────────────────

describe("the staged Marconi CPA-MG Gold Refractor verify list", () => {
  if (!existsSync(listPath)) {
    it.skip("list not present in this checkout", () => {});
    return;
  }
  const doc = JSON.parse(readFileSync(listPath, "utf8")) as {
    forLane: string;
    entries: Array<{ id: string; action: string; reason: string; citation?: { source: string; ref: string } }>;
  };

  it("names this lane and holds exactly one verify entry", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].action).toBe("verify");
  });

  it("is the Marconi CPA-MG Gold Refractor row", () => {
    expect(doc.entries[0].id).toBe("hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50");
  });

  it("carries a real citation with both fields, and passes the lane's own gate", () => {
    const e = doc.entries[0];
    expect(e.citation?.source).toBeTruthy();
    expect(e.citation?.ref).toBeTruthy();
    expect(L.classifyEntry(e).ok).toBe(true);
  });

  it("the citation names the checklistinsider Gold Refractor /50 confirmation", () => {
    const e = doc.entries[0];
    expect(e.citation?.source).toBe("checklistinsider");
    expect(e.citation?.ref).toMatch(/checklistinsider\.com/);
    expect(e.citation?.ref).toMatch(/Gold Refractor.*50/i);
  });
});
