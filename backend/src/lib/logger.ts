/**
 * Structured JSON logger. Single shape: { ts, level, module, event, ...fields }. Use createLogger('module.name') at module top-level.
 */

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type Logger = {
  debug: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
};

const SEVERITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

function normalizedMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  if (raw === "DEBUG" || raw === "INFO" || raw === "WARN" || raw === "ERROR") {
    return raw;
  }
  return "INFO";
}

function shouldLog(level: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[normalizedMinLevel()];
}

function emit(level: LogLevel, moduleName: string, event: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const base = {
    ts: new Date().toISOString(),
    level,
    module: moduleName,
    event,
  };

  const payload = fields ? { ...base, ...fields } : base;

  try {
    console.log(JSON.stringify(payload));
  } catch {
    const fallback = {
      ts: base.ts,
      level,
      module: moduleName,
      event,
      _serializeError: true,
    };
    console.log(JSON.stringify(fallback));
  }
}

export function createLogger(moduleName: string): Logger {
  return {
    debug: (event, fields) => emit("DEBUG", moduleName, event, fields),
    info: (event, fields) => emit("INFO", moduleName, event, fields),
    warn: (event, fields) => emit("WARN", moduleName, event, fields),
    error: (event, fields) => emit("ERROR", moduleName, event, fields),
  };
}
