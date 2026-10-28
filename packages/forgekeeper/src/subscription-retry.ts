export class SubscriptionRateLimit extends Error {
  constructor(readonly retryAt: number) {
    super('Feedback subscription rate limited');
  }
}

export function subscriptionRetryAt(headers: Headers, now = Date.now()): number | undefined {
  const serverTime = Date.parse(headers.get('date') ?? '');
  const base = Number.isFinite(serverTime) ? serverTime : now;
  const delays: number[] = [];
  const retry = headers.get('retry-after')?.trim();
  if (retry) {
    if (/^\d+$/.test(retry)) delays.push(Number(retry) * 1000);
    else if (!/^[+-]?[\d.]+$/.test(retry)) delays.push(Date.parse(retry) - base);
  }
  for (const name of ['ratelimit-reset', 'x-ratelimit-reset']) {
    const value = headers.get(name)?.trim();
    if (value && /^\d+$/.test(value)) delays.push(Number(value) * 1000 - base);
  }
  const reset = headers.get('ratelimit-resettime');
  if (reset) delays.push(Date.parse(reset) - base);
  const valid = delays.filter((delay) => Number.isFinite(delay) && delay >= 0);
  if (!valid.length) return undefined;
  const at = now + Math.max(...valid);
  return Number.isSafeInteger(at) ? at : undefined;
}
