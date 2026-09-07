// Worker lifecycle attribution.
//
// PROVENANCE: #1973 (2026-09-07). Both HobbyIQ3 workers were observed
// rebooting every 8-19 minutes. The investigation had to reconstruct the
// cause from the Azure activity log after the fact, because the process
// left nothing behind when it went down: there were no signal handlers and
// no unhandled-rejection handler anywhere in the backend. A restart was
// therefore indistinguishable, from inside the app, from a cold boot.
//
// This module closes that gap. It emits ONE `worker_shutdown` custom event
// carrying the reason the process is ending, so the next incident is
// attributable from telemetry alone rather than from a forensic dig:
//
//   reason=SIGTERM  -> platform-initiated (deploy, appsettings write,
//                      plan scale, host patch). This is the expected shape
//                      for an Azure App Service recycle.
//   reason=SIGINT   -> operator/console interrupt.
//   reason=uncaughtException / unhandledRejection -> the app's own fault.
//
// DELIBERATELY NOT A LOGGER FOR THE JOBS. This does not attempt to drain,
// checkpoint, or finish in-flight work -- doing that safely needs per-job
// cooperation and is out of scope for #1973. It records WHY the process is
// going away, nothing more.
//
// LIVENESS POLICY (Drew, #1973): an unhandled rejection must NOT take the
// worker down. Node's default for an unhandled rejection is to terminate
// the process, which on a 2-worker plan means a user-visible outage from a
// single stray promise. We log it, count it, and keep serving. An
// uncaughtException is left to Node's default terminate behaviour -- the
// process state is genuinely unknown at that point -- but we get the trace
// out first so it is attributable.
//
// Telemetry must never throw: every emit is wrapped. A failure to report a
// shutdown must not itself become the shutdown.

import * as appInsights from "applicationinsights";
// CF-DEPLOY-RESTARTS-ONCE: GIT_SHA_SHORT is no longer written as an App
// Setting (that write was the second restart per deploy). Read the SHA from
// the deployed artifact, falling back to the env var.
import { getGitShaShort } from "./buildInfo.js";

export type ShutdownReason =
  | "SIGTERM"
  | "SIGINT"
  | "uncaughtException"
  | "unhandledRejection";

/** Seam: replaced in tests so we assert on emitted payloads, not on App Insights. */
let _emit: (name: string, properties: Record<string, string>) => void = (
  name,
  properties,
) => {
  const client = (appInsights as any).defaultClient;
  if (client) client.trackEvent({ name, properties });
};

/** Seam: flush is a no-op in tests; in prod it races the platform's kill window. */
let _flush: () => void = () => {
  const client = (appInsights as any).defaultClient;
  if (client && typeof client.flush === "function") client.flush();
};

export function _setEmitterForTests(
  fn: (name: string, properties: Record<string, string>) => void,
): void {
  _emit = fn;
}
export function _setFlusherForTests(fn: () => void): void {
  _flush = fn;
}
export function _resetForTests(): void {
  _emit = (name, properties) => {
    const client = (appInsights as any).defaultClient;
    if (client) client.trackEvent({ name, properties });
  };
  _flush = () => {
    const client = (appInsights as any).defaultClient;
    if (client && typeof client.flush === "function") client.flush();
  };
  for (const [event, fn] of _registered) {
    process.removeListener(event as any, fn);
  }
  _registered = [];
  _shutdownEmitted = false;
  _unhandledRejections = 0;
  _installed = false;
}

// A worker dies once. SIGTERM followed by an uncaughtException during
// teardown must not produce two rows, or the incident count is wrong.
let _shutdownEmitted = false;
let _unhandledRejections = 0;
let _installed = false;
// Held so _resetForTests can actually DETACH them. Without this, repeated
// install/reset cycles in a test file accumulate real process listeners and
// every rejection is counted once per cycle.
let _registered: Array<[NodeJS.Signals | string, (...args: any[]) => void]> = [];

/** Test/ops accessor: how many rejections we absorbed without dying. */
export function unhandledRejectionCount(): number {
  return _unhandledRejections;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Emit the single `worker_shutdown` event. Idempotent: only the FIRST
 * reason wins, because that is the one that actually explains the death.
 * Returns true if this call was the one that emitted.
 */
export function emitWorkerShutdown(
  reason: ShutdownReason,
  detail?: unknown,
): boolean {
  if (_shutdownEmitted) return false;
  _shutdownEmitted = true;
  const uptimeSec = Math.round(process.uptime());
  const properties: Record<string, string> = {
    reason,
    uptimeSeconds: String(uptimeSec),
    // Short uptime + SIGTERM is the recycle signature. Recording it as a
    // property means the query is a filter, not a join against boot traces.
    shortLived: String(uptimeSec < 20 * 60),
    gitSha: getGitShaShort() ?? "",
    unhandledRejections: String(_unhandledRejections),
  };
  if (detail !== undefined) properties.detail = describe(detail).slice(0, 500);
  try {
    _emit("worker_shutdown", properties);
    _flush();
  } catch {
    // never throw from the shutdown path
  }
  // Console too: App Insights may not flush before the platform kills us,
  // but the App Service log stream captures stdout synchronously.
  try {
    console.warn(
      `[lifecycle] worker_shutdown reason=${reason} uptimeSec=${uptimeSec}` +
        (properties.detail ? ` detail=${properties.detail}` : ""),
    );
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Install the process-level lifecycle handlers. Idempotent — a second call
 * is a no-op, so importing this from more than one entry point is safe.
 */
export function installWorkerLifecycleHandlers(): void {
  if (_installed) return;
  _installed = true;

  // Platform recycle (deploy, appsettings write, scale, host patch).
  // We do NOT call process.exit(): letting Node exit on its own lets the
  // HTTP server finish what it can inside the platform's grace window.
  const on = (event: string, fn: (...args: any[]) => void): void => {
    process.on(event as any, fn);
    _registered.push([event, fn]);
  };

  on("SIGTERM", () => {
    emitWorkerShutdown("SIGTERM");
  });

  on("SIGINT", () => {
    emitWorkerShutdown("SIGINT");
  });

  // Node's default is to terminate. Get the attribution out first; then
  // let the default handler run, because process state is unknowable here.
  on("uncaughtException", (err) => {
    emitWorkerShutdown("uncaughtException", err);
    throw err;
  });

  // LIVENESS: absorb. Do not let one stray promise recycle a worker.
  on("unhandledRejection", (reason) => {
    _unhandledRejections += 1;
    try {
      _emit("worker_unhandled_rejection", {
        detail: describe(reason).slice(0, 500),
        uptimeSeconds: String(Math.round(process.uptime())),
        count: String(_unhandledRejections),
        gitSha: getGitShaShort() ?? "",
      });
    } catch {
      /* never throw from the handler */
    }
    try {
      console.error(
        `[lifecycle] unhandled rejection (absorbed, n=${_unhandledRejections}):`,
        describe(reason),
      );
    } catch {
      /* ignore */
    }
  });
}
