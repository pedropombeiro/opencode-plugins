import { parseTtl, type ModelRef } from './cache';

export interface TtlRule {
  pattern: string;
  ttl: number;
}

export interface Settings {
  tips: boolean;
  notices: boolean;
  health: boolean;
  compactionModels: ModelRef[];
  ttl: TtlRule[];
  contextCeiling?: number;
  contextRatio: number;
  minTokens: number;
  minCost: number;
  largeOutput: number;
}

export const DEFAULTS: Settings = {
  tips: true,
  notices: true,
  health: true,
  compactionModels: [],
  ttl: [],
  contextRatio: 0.8,
  minTokens: 50_000,
  minCost: 0.1,
  largeOutput: 20_000,
};

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const positive = (value: unknown, fallback: number) => (isPositive(value) ? value : fallback);

function modelRef(value: unknown): ModelRef[] {
  if (typeof value !== 'string') return [];
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return [];
  return [{ providerID: value.slice(0, slash), id: value.slice(slash + 1) }];
}

const modelRefs = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).flatMap((entry) => modelRef(entry));

function ttlRules(value: unknown): TtlRule[] {
  if (typeof value === 'string') {
    const ttl = parseTtl(value);
    return ttl ? [{ pattern: '*', ttl }] : [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([pattern, entry]) => {
    const ttl = parseTtl(entry);
    return pattern && ttl ? [{ pattern, ttl }] : [];
  });
}

const literals = (pattern: string) => pattern.replaceAll('*', '').length;

const matcher = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    's',
  );

export function ttlForModel(rules: readonly TtlRule[], ref: ModelRef | undefined) {
  if (!ref) return undefined;
  const key = `${ref.providerID}/${ref.id}`;
  const exact = rules.find((rule) => !rule.pattern.includes('*') && rule.pattern === key);
  if (exact) return exact.ttl;
  let best: TtlRule | undefined;
  for (const rule of rules) {
    if (!rule.pattern.includes('*') || !matcher(rule.pattern).test(key)) continue;
    if (!best || literals(rule.pattern) > literals(best.pattern)) best = rule;
  }
  return best?.ttl;
}

export function parseOptions(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const value = options ?? {};
  const ratio = positive(value['contextRatio'], DEFAULTS.contextRatio);
  return {
    tips: value['tips'] !== false,
    notices: value['notices'] !== false,
    health: value['health'] !== false,
    compactionModels: modelRefs(value['compactionModel']),
    ttl: ttlRules(value['ttl']),
    contextCeiling: isPositive(value['contextCeiling']) ? value['contextCeiling'] : undefined,
    contextRatio: ratio <= 1 ? ratio : DEFAULTS.contextRatio,
    minTokens: positive(value['minTokens'], DEFAULTS.minTokens),
    minCost: positive(value['minCost'], DEFAULTS.minCost),
    largeOutput: positive(value['largeOutput'], DEFAULTS.largeOutput),
  };
}
