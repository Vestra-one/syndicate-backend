/**
 * Tiny leveled logger — the single logging surface for the app.
 *
 * `debug`/`info` are development signal and are silenced in production builds; `warn`/`error`
 * always reach the console (operators need them). Call sites keep their own `[subsystem]`
 * prefix as the first argument, so this stays a thin, allocation-free gate rather than a
 * framework. Gated on `import.meta.env.DEV`, so the dead branches tree-shake out of prod.
 *
 * Rule of thumb:
 *   log.debug — verbose/diagnostic (param dumps, per-frame traces)
 *   log.info  — notable lifecycle events (session established, room registered)
 *   log.warn  — recoverable/expected-but-notable failures (transient fetch, stale socket)
 *   log.error — unexpected failures a developer should see
 */
const DEV = import.meta.env.DEV

export const log = {
  debug: (...args: unknown[]) => { if (DEV) console.debug(...args) },
  info: (...args: unknown[]) => { if (DEV) console.log(...args) },
  warn: (...args: unknown[]) => { console.warn(...args) },
  error: (...args: unknown[]) => { console.error(...args) },
}
