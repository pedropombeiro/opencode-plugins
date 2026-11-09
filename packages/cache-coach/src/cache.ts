import type { Warming } from './warming';

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface Step {
  id: string;
  model: ModelRef;
  started: number;
  ended?: number;
  tokens: Tokens;
}

export interface Price {
  input: number;
  output: number;
  read: number;
  write: number;
}

export interface Cost {
  tier?: { type: 'context'; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
}

interface MessageLike {
  type: string;
  id: string;
  status?: string;
  model?: ModelRef;
  tokens?: Tokens;
  time: { created: number; completed?: number };
}

export const DEFAULT_TTL = 5 * 60_000;
export const EXPIRING = 60_000;

export const sameModel = (a?: ModelRef, b?: ModelRef) =>
  !!a && !!b && a.providerID === b.providerID && a.id === b.id;

export const promptTokens = (tokens: Tokens) =>
  tokens.input + tokens.cache.read + tokens.cache.write;

export const contextTokens = (tokens: Tokens) => promptTokens(tokens) + tokens.output;

export const reportsCache = (tokens: Tokens) => tokens.cache.read + tokens.cache.write > 0;

export function lastStep(
  messages: readonly MessageLike[],
  started?: (id: string) => number | undefined,
  skip?: string,
): Step | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'compaction' && message.status === 'completed') return undefined;
    if (message.id === skip) continue;
    if (message.type !== 'assistant' || !message.tokens || !message.model) continue;
    if (promptTokens(message.tokens) === 0) continue;
    const start = started?.(message.id) ?? message.time.created;
    return {
      id: message.id,
      model: message.model,
      started: start,
      ...(message.time.completed === undefined
        ? {}
        : { ended: Math.max(start, message.time.completed) }),
      tokens: message.tokens,
    };
  }
  return undefined;
}

export function priceFor(costs: readonly Cost[] | undefined, prompt: number): Price | undefined {
  let chosen: Cost | undefined;
  for (const cost of costs ?? []) {
    if (cost.tier && prompt <= cost.tier.size) continue;
    if (!chosen || (cost.tier?.size ?? 0) > (chosen.tier?.size ?? 0)) chosen = cost;
  }
  if (!chosen || chosen.input <= 0) return undefined;
  return {
    input: chosen.input,
    output: chosen.output,
    read: chosen.cache.read || chosen.input,
    write: chosen.cache.write || chosen.input,
  };
}

export const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

export const DEFAULT_CEILING = 250_000;

export interface Ceiling {
  tokens: number;
  reason: 'price' | 'limit';
}

export function priceTier(costs: readonly Cost[] | undefined): number | undefined {
  const sizes = (costs ?? []).flatMap((cost) =>
    cost.tier?.type === 'context' && cost.tier.size > 0 ? [cost.tier.size] : [],
  );
  return sizes.length ? Math.min(...sizes) : undefined;
}

export function contextCeiling(input: {
  configured?: number;
  costs?: readonly Cost[];
  modelLimit?: number;
}): Ceiling {
  const cap = (tokens: number) =>
    input.modelLimit && input.modelLimit > 0 ? Math.min(tokens, input.modelLimit) : tokens;
  if (input.configured) return { tokens: cap(input.configured), reason: 'limit' };
  const tier = priceTier(input.costs);
  if (tier && (!input.modelLimit || tier < input.modelLimit))
    return { tokens: tier, reason: 'price' };
  return { tokens: cap(DEFAULT_CEILING), reason: 'limit' };
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseTtl(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) return undefined;
  const ttl = Number(match[1]) * UNITS[match[2]];
  return ttl > 0 ? ttl : undefined;
}

export type CacheState =
  | { kind: 'unknown' }
  | { kind: 'running'; step: Step }
  | { kind: 'warm'; step: Step; remaining: number; warming: boolean }
  | { kind: 'cold'; step: Step; reason: 'expired' | 'model' };

export function cacheState(input: {
  step?: Step;
  now: number;
  ttl: number;
  running: boolean;
  selected?: ModelRef;
  warming?: Warming;
}): CacheState {
  const { step } = input;
  if (!step || !reportsCache(step.tokens)) return { kind: 'unknown' };
  if (input.running) return { kind: 'running', step };
  if (input.selected && !sameModel(input.selected, step.model))
    return { kind: 'cold', step, reason: 'model' };
  const remaining = step.started + input.ttl - input.now;
  return remaining > 0
    ? { kind: 'warm', step, remaining, warming: !!input.warming }
    : { kind: 'cold', step, reason: 'expired' };
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(Math.round(count));
}

export const formatUsd = (amount: number) => (amount < 0.005 ? '<$0.01' : `$${amount.toFixed(2)}`);

export const aboutUsd = (amount: number) =>
  amount < 0.005 ? 'under $0.01' : `~$${amount.toFixed(2)}`;

export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`;
}

export type Tone = 'success' | 'warning' | 'muted';

export interface Indicator {
  text: string;
  tone: Tone;
}

export interface Next {
  tokens: number;
  cost?: number;
}

export interface Alternative {
  name: string;
  cost: number;
}

export const shortName = (name: string) => /\(([^()]+)\)\s*$/.exec(name)?.[1] ?? name;

export function indicator(
  state: CacheState,
  next?: Next,
  alternative?: Alternative,
): Indicator | undefined {
  if (state.kind === 'unknown') return undefined;
  if (state.kind === 'running') return { text: '● cache', tone: 'success' };
  if (state.kind === 'warm') {
    const time = `${formatRemaining(state.remaining)}${state.warming ? ' · warming?' : ''}`;
    return state.remaining <= EXPIRING
      ? { text: `◐ cache ${time}`, tone: 'warning' }
      : { text: `● cache ${time}`, tone: 'success' };
  }
  const rewrite = next
    ? ` · rewrite ~${formatTokens(next.tokens)}${next.cost === undefined ? '' : ` (${formatUsd(next.cost)})`}`
    : '';
  const cheaper = alternative
    ? ` · ${shortName(alternative.name)} ${formatUsd(alternative.cost)}`
    : '';
  return { text: `○ cache cold${rewrite}${cheaper}`, tone: 'warning' };
}

export function nextCost(state: CacheState, tokens: number, price?: Price): Next {
  if (!price) return { tokens };
  const warm = state.kind === 'warm' || state.kind === 'running';
  return { tokens, cost: usd(tokens, warm ? price.read : price.write) };
}

export function details(input: {
  state: CacheState;
  ttl: number;
  next: Next;
  warming?: Warming;
  stepModel?: string;
  selectedModel?: string;
  sessionCost?: number;
}): string[] {
  const { state, warming } = input;
  if (state.kind === 'unknown')
    return ['No cache data yet. The provider may not report cache tokens for this session.'];
  const lines: string[] = [];
  if (state.kind === 'running') lines.push('Cache: in use by the running request');
  else if (state.kind === 'warm')
    lines.push(`Cache: warm, about ${formatRemaining(state.remaining)} left`);
  else if (state.reason === 'expired') lines.push('Cache: cold, it expired');
  else
    lines.push(
      `Cache: cold, ${input.selectedModel ?? 'the selected model'} has no cache for this session`,
    );
  lines.push(`Cache lifetime: ${formatDuration(input.ttl)} after each request`);
  lines.push(
    warming
      ? `Warming: every ${formatDuration(warming.interval)} while idle, until ${formatDuration(warming.duration)} after the last request. Warming requests may not renew the cache, so the countdown doesn't count on them.`
      : 'Warming: off',
  );
  const { tokens } = state.step;
  const prompt = promptTokens(tokens);
  const hit = prompt ? Math.round((tokens.cache.read / prompt) * 100) : 0;
  lines.push(
    '',
    `Last request${input.stepModel ? ` on ${input.stepModel}` : ''}: ${formatTokens(prompt)} prompt tokens, ${hit}% read from the cache`,
    `Read ${formatTokens(tokens.cache.read)} · written ${formatTokens(tokens.cache.write)} · uncached ${formatTokens(tokens.input)} · output ${formatTokens(tokens.output)}`,
  );
  const cost = input.next.cost === undefined ? '' : ` (${aboutUsd(input.next.cost)})`;
  const warm = state.kind === 'warm' || state.kind === 'running';
  lines.push(
    warm
      ? `Next message: reads ~${formatTokens(input.next.tokens)} tokens from the cache${cost}`
      : `Next message: writes ~${formatTokens(input.next.tokens)} tokens to a new cache${cost}`,
  );
  if (input.sessionCost !== undefined)
    lines.push(`Session cost so far: ${formatUsd(input.sessionCost)}`);
  return lines;
}
