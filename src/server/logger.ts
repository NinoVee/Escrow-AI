/**
 * Structured logger with redaction. Application logs must never contain
 * passwords, tokens, bank details, government IDs, or document contents.
 */
const SENSITIVE_KEYS =
  /pass(word)?|secret|token|authorization|cookie|account_?number|routing|iban|swift|ssn|tax_?id|tin\b|dob|birth|totp|backup|api_?key|accountNumberEnc|routingNumberEnc|text|body|content|excerpt/i;

const LONG_DIGITS = /\b\d{8,}\b/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.replace(LONG_DIGITS, (m) => `[redacted-${m.length}d]`).replace(EMAIL, "$1***@$2");
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const min = (process.env.LOG_LEVEL as Level) || "info";
  if (ORDER[level] < ORDER[min]) return;
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(meta ? { meta: redact(meta) } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
