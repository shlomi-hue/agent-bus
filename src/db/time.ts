const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/;

/** Epoch microseconds, or null when the text is not a timestamp. */
export function instantMicros(value: string): bigint | null {
  const match = INSTANT.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const sign = match[8];
  const offsetHours = Number(match[9] ?? "0");
  const offsetMinutes = Number(match[10] ?? "0");
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(utcMs)) return null;
  if (sign) {
    const offset = (sign === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutes);
    utcMs -= offset * 60_000;
  }
  const digits = fraction.padEnd(6, "0").slice(0, 6);
  return BigInt(utcMs) * 1000n + BigInt(digits);
}

function formatEpochMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const wholeMs = abs / 1000n;
  const extra = (abs % 1000n).toString().padStart(3, "0");
  const iso = new Date(Number(wholeMs)).toISOString();
  const dot = iso.indexOf(".");
  const prefix = iso.slice(0, dot);
  const millis = iso.slice(dot + 1, dot + 4);
  const body = `${prefix}.${millis}${extra}Z`;
  return negative ? `-${body}` : body;
}

/** UTC timestamp with exactly 6 fractional digits. Unparseable text is returned unchanged. */
export function canonicalTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "Invalid Date";
    return formatEpochMicros(BigInt(value.getTime()) * 1000n);
  }
  const micros = instantMicros(value);
  if (micros === null) return value;
  return formatEpochMicros(micros);
}

export function compareInstants(a: string, b: string): number {
  const left = instantMicros(a);
  const right = instantMicros(b);
  if (left === null || right === null) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isAfter(a: string, b: string): boolean {
  return compareInstants(a, b) > 0;
}

export function isAtOrAfter(a: string, b: string): boolean {
  return compareInstants(a, b) >= 0;
}

export function maxInstant(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!best || compareInstants(value, best) > 0) best = value;
  }
  return best;
}

export function minInstant(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!best || compareInstants(value, best) < 0) best = value;
  }
  return best;
}
