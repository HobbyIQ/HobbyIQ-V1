#!/usr/bin/env -S node --experimental-strip-types
/**
 * CF-OWNER-OVERRIDE (2026-06-05): generic owner-account seed script.
 *
 * Interactive bootstrap for any account that should be server-side comped
 * to a paid tier (default: pro_seller). Designed to be re-runnable + PII-
 * free at the repository level: NO emails, usernames, or passwords are
 * baked into the file. The operator supplies all three at runtime.
 *
 * Behavior:
 *   - Prompts for email (echoed), username (echoed), password (hidden).
 *   - Looks up by email via the real authService.
 *   - If the user exists: claims the supplied username (if different)
 *     and sets entitlementOverride = "pro_seller". DOES NOT reset
 *     password, touch Apple subscription state, or modify email.
 *   - If the user doesn't exist: registers via the real authService with
 *     the supplied email/username/password, then sets the override.
 *   - Idempotent: a second run with identical inputs is a no-op on
 *     anything except the override timestamp (which is implicit on
 *     re-write — no change to behavior).
 *   - Prints ONLY the resulting userId on stdout. No password, no email,
 *     no token, no PII echoed anywhere — even on error paths.
 *
 * Required env (for Cosmos):
 *   COSMOS_ENDPOINT + (COSMOS_KEY | AAD), or COSMOS_CONNECTION_STRING
 *   COSMOS_DATABASE / COSMOS_DB         (default "hobbyiq")
 *
 * Usage:
 *   node --experimental-strip-types backend/scripts/seedOwnerAccount.ts
 */

import { createInterface, Interface as ReadlineInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  findUserByEmail,
  registerUser,
  setEntitlementOverride,
} from "../src/services/authService.js";

const OVERRIDE_TIER = "pro_seller" as const;

// ─── Prompt utilities ──────────────────────────────────────────────────────

function promptVisible(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
}

/**
 * Read a password from stdin without echoing the typed characters to
 * stdout. Implementation: wrap process.stdout in a Writable that
 * suppresses chunks while `muted` is true. The cursor stays put, no
 * asterisks, no characters — same UX as `sudo`.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });
    process.stdout.write(question);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("error", reject);
  });
}

function requireNonEmpty(label: string, value: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    // Never include user input in the error message — keep PII out of logs.
    process.stderr.write(`[seedOwnerAccount] ${label} is required\n`);
    process.exit(1);
  }
  return trimmed;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const email = requireNonEmpty(
    "email",
    await promptVisible(rl, "Email:    "),
  );
  const username = requireNonEmpty(
    "username",
    await promptVisible(rl, "Username: "),
  );
  rl.close();

  // Hidden prompt opens its own readline; the visible one above is closed first.
  const password = await promptHidden("Password: ");
  // Only validate length for the create path — on the find path, password
  // is unused and may be left blank by the operator. We don't store it,
  // log it, or echo it under any branch.
  if (password.length === 0 && (await findUserByEmail(email)) === null) {
    process.stderr.write(
      "[seedOwnerAccount] password required when creating a new account\n",
    );
    process.exit(1);
  }

  const existing = await findUserByEmail(email);

  let userId: string;
  if (existing) {
    const updated = await setEntitlementOverride(
      existing.userId,
      OVERRIDE_TIER,
      { username },
    );
    if (!updated) {
      process.stderr.write(
        "[seedOwnerAccount] could not apply override (user not found or username invalid/taken)\n",
      );
      process.exit(2);
    }
    userId = updated.userId;
  } else {
    const reg = await registerUser({ email, username, password });
    if (!reg.success || !reg.user) {
      // reg.error is typed as a string but never includes the supplied
      // credentials — it's an enum-like message. Safe to surface to stderr.
      process.stderr.write(
        `[seedOwnerAccount] registration failed: ${reg.error}\n`,
      );
      process.exit(3);
    }
    const updated = await setEntitlementOverride(
      reg.user.userId,
      OVERRIDE_TIER,
      { username },
    );
    if (!updated) {
      process.stderr.write(
        "[seedOwnerAccount] registration succeeded but override apply failed\n",
      );
      process.exit(4);
    }
    userId = updated.userId;
  }

  // STDOUT carries ONLY the userId — nothing else. Operators can grep
  // / pipe / store this without leaking any other identifier.
  process.stdout.write(userId + "\n");
}

main().catch((err) => {
  // Avoid printing the error message to stdout (which the operator may
  // be piping); send it to stderr only.
  process.stderr.write(
    `[seedOwnerAccount] failed: ${err?.message ?? String(err)}\n`,
  );
  process.exit(1);
});
