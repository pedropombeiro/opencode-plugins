import { aboutUsd, formatTokens, usd, type Ceiling, type Price } from './cache';
import type { Finding, IncidentRecord, Status, Summary, Window } from './health';
import type { Warming } from './warming';

export interface Tip {
  key: string;
  title: string;
  message: string;
  variant: 'info' | 'warning';
  attention?: boolean;
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

export function automaticCompactionTip(
  tokens: number,
  threshold: number,
  ratio: number,
): Tip | undefined {
  if (tokens < threshold * ratio) return undefined;
  const remaining = threshold - tokens;
  const estimate =
    remaining > 0
      ? `About ${formatTokens(remaining)} tokens remain before automatic compaction.`
      : 'This session has reached the estimated automatic compaction threshold.';
  return {
    key: 'automatic-compaction',
    title: 'Approaching automatic compaction',
    message: `${estimate} If you need exact details from earlier messages, save them now.`,
    variant: 'info',
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

export const formatShare = (share: number) =>
  share > 0 && share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`;

const across = (window: Window) =>
  `${formatShare(window.share)} of ${formatTokens(window.input)} input tokens came from the cache across the last ${window.requests} requests`;

const missed = (lost: number, extra?: number) =>
  `an estimated ~${formatTokens(lost)} tokens from earlier prompts weren't read from the cache${extra === undefined ? '' : ` (${aboutUsd(extra)} extra)`}`;

const patternOf = (record: IncidentRecord) =>
  record.pattern === 'partial'
    ? `only about ${formatShare(record.partialShare ?? 0)} of each prompt was read from the cache`
    : 'little or nothing was read from the cache';

export function healthTip(finding: Finding, model: string): Tip | undefined {
  if (finding.type === 'low') return undefined;
  const { record } = finding;
  if (finding.type === 'recovered') {
    if (!finding.notified) return undefined;
    return {
      key: `cache-health-recovered:${finding.key}:${record.opened}`,
      title: 'Cache reuse recovered',
      variant: 'info',
      message: `Cache reuse recovered for ${model}: ${across(finding.window)}. Over ${record.requests} requests, ${missed(record.lost, record.extra)}.`,
      attention: true,
    };
  }
  const earlier =
    finding.baseline === undefined
      ? ''
      : `, down from ${formatShare(finding.baseline)} earlier in this session`;
  return {
    key: `cache-health:${finding.key}:${record.opened}`,
    title: 'Cache reuse still low',
    variant: 'warning',
    message: `Cache reuse is still low for ${model}: ${across(finding.window)}${earlier}. In most of the missed requests, ${patternOf(record)}. Over ${record.requests} requests, ${missed(record.lost, record.extra)}. Each missed request processes the context again, so compacting makes misses cheaper. Possible causes include prompt-prefix changes, cache configuration, or provider-side misses. Run /cache for details to include in a report.`,
    attention: true,
  };
}

export function healthLines(status: Status, summary: Summary): string[] {
  const lines: string[] = [];
  if (status.kind === 'waiting')
    lines.push('Cache health: waiting for more requests on this model');
  else if (status.kind === 'ok')
    lines.push(
      `Cache health: ${formatShare(status.window.share)} of ${formatTokens(status.window.input)} input tokens read from the cache across the last ${status.window.requests} requests`,
    );
  else if (status.kind === 'low') {
    const earlier =
      status.baseline === undefined ? '' : `, down from ${formatShare(status.baseline)}`;
    lines.push(
      `Cache health: reuse unexpectedly low, ${formatShare(status.window.share)} of ${formatTokens(status.window.input)} input tokens read from the cache across the last ${status.window.requests} requests${earlier}`,
    );
  }
  const { last } = summary;
  if (!last) return lines;
  const count = (value: number) => `${value} ${value === 1 ? 'incident' : 'incidents'}`;
  if (summary.incidents) {
    const ongoing = summary.open ? `, ${summary.open} ongoing` : '';
    lines.push(
      `Cache misses this session: ${count(summary.incidents)}${ongoing}. In total, ${missed(summary.lost, summary.extra)}.`,
    );
  }
  const assumed = last.assumed ? ', assumed' : '';
  lines.push(
    `Last incident on ${last.key}: ${last.requests} requests, ${last.open ? 'ongoing' : 'ended'}${assumed}. In most of the missed requests, ${patternOf(last)}.`,
  );
  if (summary.assumed)
    lines.push(
      `${count(summary.assumed)} assumed caching from the model's cache prices, because the provider hasn't reported cache use for that model in this session. They may not be real misses, so they aren't in the totals and don't show a warning.`,
    );
  return lines;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
