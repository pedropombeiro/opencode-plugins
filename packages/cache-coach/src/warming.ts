export interface Warming {
  interval: number;
  duration: number;
}

export const DEFAULT_WARMING: Warming = { interval: 4 * 60_000, duration: 30 * 60_000 };

const UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(value.trim());
  if (!match) return undefined;
  const name = match[2].toLowerCase();
  const unit = UNITS[name] ?? UNITS[name.replace(/s$/, '')];
  const duration = unit === undefined ? undefined : Number(match[1]) * unit;
  return duration && duration > 0 ? duration : undefined;
}

type Fields = { interval?: unknown; duration?: unknown };

const fieldsOf = (value: unknown): Fields | undefined =>
  value === true ? {} : value && typeof value === 'object' ? (value as Fields) : undefined;

function schedule(fields: Fields, top: Fields, ttl: number | undefined): Warming | undefined {
  const rawInterval = fields.interval ?? top.interval;
  const interval =
    rawInterval === 'auto'
      ? ttl && ttl * 0.9
      : rawInterval === undefined
        ? DEFAULT_WARMING.interval
        : parseDuration(rawInterval);
  const rawDuration = fields.duration ?? top.duration;
  const duration =
    rawDuration === undefined ? DEFAULT_WARMING.duration : parseDuration(rawDuration);
  if (!interval || !duration || interval >= duration) return undefined;
  return { interval, duration };
}

export function resolveWarming(input: {
  top?: unknown;
  provider?: unknown;
  model?: unknown;
  ttl?: number;
}): Warming | undefined {
  const top = fieldsOf(input.top);
  const chosen = [input.model, input.provider, input.top].find((value) => value !== undefined);
  if (chosen === undefined || chosen === false) return undefined;
  const fields = fieldsOf(chosen);
  if (fields) {
    const resolved = schedule(fields, top ?? {}, input.ttl);
    if (resolved || chosen === input.top) return resolved;
  }
  return top ? schedule(top, {}, input.ttl) : undefined;
}
