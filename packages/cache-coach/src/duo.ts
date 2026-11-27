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
  id: string;
  type: string;
  model?: ModelRef;
  tokens?: Tokens;
  time: { created: number; completed?: number };
  error?: unknown;
  finish?: string;
}

interface Usage {
  calls: number;
  credits?: number;
}

function observed(message: Message) {
  return message.type === 'assistant' &&
    message.model &&
    isDuo(message.model) &&
    message.time.completed !== undefined &&
    !message.error &&
    message.finish !== 'error'
    ? message.model
    : undefined;
}

function callsFor(
  rate: ReturnType<typeof rateFor>,
  prompt: number | undefined,
): number | undefined {
  if (typeof rate === 'number') return rate;
  if (!prompt) return undefined;
  return rate?.[prompt > DUO_TIER ? 1 : 0];
}

function add(usage: Usage, model: ModelRef, message: Message) {
  const rate = rateFor(model, message.time.created);
  const prompt = message.tokens && promptTokens(message.tokens);
  const calls = callsFor(rate, prompt);
  usage.calls++;
  usage.credits = calls && usage.credits !== undefined ? usage.credits + 1 / calls : undefined;
}

export function duoTurn(messages: readonly Message[]) {
  const usage: Usage = { calls: 0, credits: 0 };
  let lastCall: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === 'user') {
      if (!usage.calls) return undefined;
      const credits =
        usage.credits === undefined ? '' : ` · ~${Number(usage.credits.toFixed(2))} cr`;
      return {
        id: message.id,
        lastCall,
        calls: usage.calls,
        text: `Duo this turn: ${usage.calls} ${usage.calls === 1 ? 'call' : 'calls'}${credits}`,
      };
    }
    const model = observed(message);
    if (model) {
      lastCall ??= message.id;
      add(usage, model, message);
    }
  }
}

export function duoUsage(messages: readonly Message[]): string[] {
  const models = new Map<string, Usage>();
  for (const message of messages) {
    const model = observed(message);
    if (!model) continue;
    const usage = models.get(model.id) ?? { calls: 0, credits: 0 };
    add(usage, model, message);
    models.set(model.id, usage);
  }
  return Array.from(
    models,
    ([id, { calls, credits }]) =>
      `${id}: ${calls} observed ${calls === 1 ? 'call' : 'calls'}${credits === undefined ? '' : ` · ~${Number(credits.toFixed(2))} GitLab Credits`}`,
  );
}
