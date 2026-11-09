import { parseTtl, type ModelRef } from './cache';

export interface Settings {
  tips: boolean;
  notices: boolean;
  compactionModels: ModelRef[];
  ttl?: number;
  contextCeiling?: number;
  contextRatio: number;
  minTokens: number;
  minCost: number;
  largeOutput: number;
}

export const DEFAULTS: Settings = {
  tips: true,
  notices: true,
  compactionModels: [],
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

export function parseOptions(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const value = options ?? {};
  const ratio = positive(value['contextRatio'], DEFAULTS.contextRatio);
  return {
    tips: value['tips'] !== false,
    notices: value['notices'] !== false,
    compactionModels: modelRefs(value['compactionModel']),
    ttl: parseTtl(value['ttl']),
    contextCeiling: isPositive(value['contextCeiling']) ? value['contextCeiling'] : undefined,
    contextRatio: ratio <= 1 ? ratio : DEFAULTS.contextRatio,
    minTokens: positive(value['minTokens'], DEFAULTS.minTokens),
    minCost: positive(value['minCost'], DEFAULTS.minCost),
    largeOutput: positive(value['largeOutput'], DEFAULTS.largeOutput),
  };
}
