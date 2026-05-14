/**
 * logger.js — structured logging with Application Insights integration.
 * When APPLICATIONINSIGHTS_CONNECTION_STRING is set, all console output is
 * automatically captured by the AI SDK. We also emit structured JSON for
 * Log Analytics to parse.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

function fmt(level, args) {
  if (IS_PROD) {
    // Structured JSON — Log Analytics / App Insights parses this
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    return JSON.stringify({ level, message: msg, timestamp: new Date().toISOString() });
  }
  return args;
}

const logger = {
  info: (...args) => IS_PROD ? console.log(fmt('INFO', args)) : console.log('[INFO]', ...args),
  warn: (...args) => IS_PROD ? console.warn(fmt('WARN', args)) : console.warn('[WARN]', ...args),
  error: (...args) => IS_PROD ? console.error(fmt('ERROR', args)) : console.error('[ERROR]', ...args),
  debug: (...args) => {
    if (!IS_PROD) console.log('[DEBUG]', ...args);
  },
};

const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
};

module.exports = { logger, requestLogger };

