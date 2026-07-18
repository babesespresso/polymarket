/**
 * Minimal structured logger. Redacts anything that looks like a secret before
 * it can reach stdout. Credentials must never be logged, so we scrub known key
 * names and long base64-looking blobs defensively.
 */

const SECRET_KEY_PATTERN = /(secret|key_id|keyid|secretkey|password|token|authorization)/i;

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Redact long base64/hex blobs that resemble secret keys.
    if (value.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (meta) line.meta = redact(meta);
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, meta);
  },
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
