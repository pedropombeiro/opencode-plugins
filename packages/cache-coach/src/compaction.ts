import {
  aboutUsd,
  formatTokens,
  priceFor,
  sameModel,
  usd,
  type Cost,
  type ModelRef,
  type Price,
} from './cache';

export interface Candidate {
  ref: ModelRef;
  name: string;
  costs?: readonly Cost[];
  limit?: number;
}

export interface Choice {
  ref: ModelRef;
  name: string;
  cost: number;
}

export function compactionChoice(input: {
  candidates: readonly Candidate[];
  current: ModelRef;
  tokens: number;
  price?: Price;
  minCost: number;
}): Choice | undefined {
  if (!input.price) return undefined;
  const rewrite = usd(input.tokens, input.price.write);
  for (const candidate of input.candidates) {
    if (sameModel(candidate.ref, input.current)) continue;
    if (candidate.limit && candidate.limit < input.tokens) continue;
    const price = priceFor(candidate.costs, input.tokens);
    if (!price) continue;
    const cost = usd(input.tokens, price.write);
    if (rewrite - cost >= input.minCost) return { ref: candidate.ref, name: candidate.name, cost };
  }
  return undefined;
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function expiryNotice(input: {
  time: string;
  tokens: number;
  from: { name: string; price?: Price };
  choice?: Choice;
  minTokens: number;
  minCost: number;
}): string | undefined {
  const { tokens, from, choice } = input;
  if (tokens < input.minTokens) return undefined;
  const rewrite = from.price && usd(tokens, from.price.write);
  if (rewrite !== undefined && rewrite < input.minCost) return undefined;
  const cost = rewrite === undefined ? '' : ` (${aboutUsd(rewrite)} on ${from.name})`;
  const advice = choice
    ? `To compact, switch to ${choice.name} first (${aboutUsd(choice.cost)}), run /compact, then switch back.`
    : 'Compacting on a cheaper model costs less.';
  return `Prompt cache expires at ${input.time}. After that, the next message writes ~${formatTokens(tokens)} tokens to the cache again${cost}. ${advice}`;
}
