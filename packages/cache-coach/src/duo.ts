import { promptTokens, type ModelRef, type Tokens } from './cache';

export const isDuo = (ref?: ModelRef) =>
  ref?.providerID === 'gitlab' && ref.id.startsWith('duo-chat-');

export const DUO_TIER = 272_000;

type Rate = number | readonly [standard: number, long: number];

const callsPerCredit: Readonly<Record<string, Rate | undefined>> = {
  'haiku-5-5': 8,
  'sonnet-5-5': 3.2,
  'sonnet-5': 3.2,
  'sonnet-4-5': 2,
  'sonnet-4-6': 2,
  'opus-5-5': 1.35,
  'opus-5': 1.1,
  'opus-4-6': 1.1,
  'opus-4-7': 1.1,
  'opus-4-8': 1.1,
  'fable-5-2': 0.75,
  'gpt-5-4-mini': 6.7,
  'gpt-6-luna': 8,
  'gpt-6-1-sol': [2.86, 1.54],
  'gpt-6-2-sol': [2.86, 1.54],
  'gpt-6-2-astra': [0.67, 0.38],
  'gemini-4-hydrogen': 3.33,
  'kimi-k3-1-pro': 2.86,
};

function rateFor(ref: ModelRef, at: number): Rate | undefined {
  const name = ref.id.slice('duo-chat-'.length);
  if (name === 'gemini-4-argon' || name === 'gemini-4-carbon')
    return at < Date.UTC(2026, 11, 1) ? 2.86 : 1.33;
  return Object.hasOwn(callsPerCredit, name) ? callsPerCredit[name] : undefined;
}

export const duoTier = (ref: ModelRef) =>
  isDuo(ref) && Array.isArray(rateFor(ref, Date.now())) ? DUO_TIER : undefined;

interface Message {
  type: string;
  model?: ModelRef;
  tokens?: Tokens;
  time: { created: number; completed?: number };
  error?: unknown;
  finish?: string;
}

export function duoUsage(messages: readonly Message[]): string[] {
  const models = new Map<string, { calls: number; credits?: number }>();
  for (const message of messages) {
    const { model, tokens, time } = message;
    if (message.type !== 'assistant' || !model || !isDuo(model)) continue;
    if (time.completed === undefined || message.error || message.finish === 'error') continue;
    const usage = models.get(model.id) ?? { calls: 0, credits: 0 };
    usage.calls++;
    const rate = rateFor(model, time.created);
    const prompt = tokens && promptTokens(tokens);
    const calls =
      typeof rate === 'number' ? rate : prompt ? rate?.[prompt > DUO_TIER ? 1 : 0] : undefined;
    usage.credits = calls && usage.credits !== undefined ? usage.credits + 1 / calls : undefined;
    models.set(model.id, usage);
  }
  return Array.from(
    models,
    ([id, { calls, credits }]) =>
      `${id}: ${calls} observed ${calls === 1 ? 'call' : 'calls'}${credits === undefined ? '' : ` · ~${Number(credits.toFixed(2))} GitLab Credits`}`,
  );
}
