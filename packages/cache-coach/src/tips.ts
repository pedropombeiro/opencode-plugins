import { aboutUsd, formatTokens, usd, type Ceiling, type Price } from './cache';
import type { Warming } from './warming';

export interface Tip {
  key: string;
  title: string;
  message: string;
  variant: 'info' | 'warning';
}

export interface PricedModel {
  name: string;
  price?: Price;
}

export function modelSwitchTip(input: {
  tokens: number;
  warm: boolean;
  from: PricedModel;
  to: PricedModel;
  compaction?: { name: string; cost: number };
  minTokens: number;
  minCost: number;
}): Tip | undefined {
  const { tokens, from, to } = input;
  if (tokens < input.minTokens) return undefined;
  const size = `~${formatTokens(tokens)} tokens`;
  const move = to.price && usd(tokens, to.price.write);
  if (input.warm) {
    const stay = from.price && usd(tokens, from.price.read);
    if (move !== undefined && stay !== undefined && move - stay < input.minCost) return undefined;
    const costs =
      move !== undefined && stay !== undefined
        ? ` (${aboutUsd(move)}). Staying on ${from.name} reads them from its cache (${aboutUsd(stay)})`
        : `. Staying on ${from.name} reads them from its cache instead`;
    return {
      key: 'model-switch',
      title: 'This model switch rewrites the cache',
      variant: 'warning',
      message: `Your next message on ${to.name} writes ${size} to a new cache${costs}. To compact, switch back, compact, and then switch.`,
    };
  }
  const stay = from.price && usd(tokens, from.price.write);
  if (stay === undefined) return undefined;
  const cheaper =
    input.compaction ??
    (move !== undefined && stay - move >= input.minCost
      ? { name: to.name, cost: move }
      : undefined);
  if (!cheaper) return undefined;
  const costs = `${move === undefined ? '' : `${aboutUsd(move)} on ${to.name}, `}${aboutUsd(stay)} on ${from.name}`;
  return {
    key: 'model-switch-cold',
    title: 'The cache already expired',
    variant: 'info',
    message: `The next message rewrites ${size} on any model: ${costs}. If you plan to compact, compacting on ${cheaper.name} costs less (${aboutUsd(cheaper.cost)}).`,
  };
}

export function contextCeilingTip(input: {
  tokens: number;
  ceiling: Ceiling;
  ratio: number;
  price?: Price;
}): Tip | undefined {
  const { tokens, ceiling, price } = input;
  if (ceiling.tokens <= 0 || tokens < ceiling.tokens * input.ratio) return undefined;
  const costs = price
    ? ` reads the context from the cache for ${aboutUsd(usd(tokens, price.read))}. After the cache expires, the same compaction pays ${aboutUsd(usd(tokens, price.write))} to write it again.`
    : ' reads the context from the cache instead of writing it again.';
  const position =
    ceiling.reason === 'price'
      ? `~${formatTokens(tokens)} tokens, and this model charges a higher price for prompts over ${formatTokens(ceiling.tokens)} tokens`
      : `~${formatTokens(tokens)} of ${formatTokens(ceiling.tokens)} tokens`;
  return {
    key: 'context-limit',
    title: ceiling.reason === 'price' ? 'Close to a higher price' : 'Close to the context limit',
    variant: 'info',
    message: `This session's context is at ${position}. Compacting now, while the cache is warm,${costs}`,
  };
}

export function largeOutputTip(input: {
  tool: string;
  tokens: number;
  threshold: number;
  price?: Price;
}): Tip | undefined {
  const { tool, tokens, price } = input;
  if (tokens < input.threshold) return undefined;
  const cost = price
    ? `, adding ${aboutUsd(usd(tokens, price.read))} to each request as cache reads`
    : '';
  return {
    key: `large-output:${tool}`,
    title: 'Large tool output',
    variant: 'info',
    message: `${tool} returned ~${formatTokens(tokens)} tokens. They stay in every later request in this session${cost}. Next time, ask for a narrower result, for example with grep, head, or a line range.`,
  };
}

export function warmingTip(input: {
  gap: number;
  ttl: number;
  warming: Warming;
  model: string;
  written: number;
  prompt: number;
  minTokens: number;
  minCost: number;
  price?: Price;
}): Tip | undefined {
  const { gap, written, price } = input;
  if (gap <= input.ttl || gap >= input.warming.duration) return undefined;
  if (input.prompt < input.minTokens || written < input.prompt / 2) return undefined;
  const rewrite = price && usd(written, price.write);
  if (rewrite !== undefined && rewrite < input.minCost) return undefined;
  const minutes = Math.round(gap / 60_000);
  const away = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const cost = rewrite === undefined ? '' : ` (${aboutUsd(rewrite)})`;
  return {
    key: 'warming',
    title: "Warming didn't keep the cache",
    variant: 'warning',
    message: `Warming didn't keep the cache this time: this request wrote ~${formatTokens(written)} tokens again${cost} after ${away} away. Warming requests also cost money, so consider turning warming off for ${input.model}.`,
  };
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
