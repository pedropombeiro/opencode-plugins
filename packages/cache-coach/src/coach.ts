import type { Plugin } from '@opencode/plugin/tui';
import {
  cacheState,
  contextCeiling,
  contextTokens,
  DEFAULT_TTL,
  details,
  EXPIRING,
  lastStep,
  nextCost,
  parseTtl,
  priceFor,
  promptTokens,
  reportsCache,
  sameModel,
  shortName,
  type ModelRef,
  type Tokens,
} from './cache';
import { compactionChoice, expiryNotice, formatClock, type Choice } from './compaction';
import { createHealth, type Finding, type Thresholds } from './health';
import { ttlForModel, type Settings } from './options';
import {
  contextCeilingTip,
  estimateTokens,
  healthLines,
  healthTip,
  largeOutputTip,
  modelSwitchTip,
  warmingTip,
  type Tip,
} from './tips';
import { resolveWarming } from './warming';

type Data = Plugin.Context['data'];
type SessionData = Data['session'];
type LocationData = Data['location'];
export type ModelInfo = NonNullable<ReturnType<LocationData['model']['list']>>[number];
export type ProviderInfo = NonNullable<ReturnType<LocationData['provider']['list']>>[number];
type Messages = Parameters<typeof lastStep>[0];

export interface CoachData {
  session: Pick<SessionData, 'get' | 'status' | 'cost'> & {
    message: Pick<SessionData['message'], 'list' | 'get'>;
  };
  location: {
    model: Pick<LocationData['model'], 'list' | 'sync'>;
    provider: Pick<LocationData['provider'], 'list' | 'sync'>;
  };
}

export type ConfigClient = Pick<Plugin.Context['client'], 'config'>;

export interface CoachOptions {
  data: CoachData;
  client: () => ConfigClient;
  settings: Settings;
  selectedModel: (sessionID: string) => ModelRef | undefined;
  startedAt: (sessionID: string, id: string) => number | undefined;
  thresholds?: Thresholds;
}

export interface Notice {
  sessionID: string;
  stepID: string;
  at: number;
  expires: number;
  description: string;
}

export interface StepEnded {
  sessionID: string;
  assistantMessageID: string;
  tokens: Tokens;
}

export interface ToolOutput {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  content: readonly { type: string; text?: string }[];
}

export type View = ReturnType<Coach['view']>;
export type Coach = ReturnType<typeof createCoach>;

export function createCoach(options: CoachOptions) {
  const { data, settings } = options;
  const session = (sessionID: string) => data.session.get(sessionID);
  const locationOf = (sessionID: string) => {
    const directory = session(sessionID)?.location.directory;
    return directory ? { directory } : undefined;
  };

  const synced = new Set<string>();
  function catalog(sessionID: string) {
    const location = locationOf(sessionID);
    const models = data.location.model.list(location);
    const providers = data.location.provider.list(location);
    const key = location?.directory ?? '';
    if ((!models || !providers) && !synced.has(key)) {
      synced.add(key);
      void data.location.model.sync(location).catch(() => {});
      void data.location.provider.sync(location).catch(() => {});
    }
    return { models: models ?? [], providers: providers ?? [] };
  }

  const findModel = (models: readonly ModelInfo[], ref?: ModelRef) =>
    ref
      ? models.find(
          (model) =>
            model.providerID === ref.providerID &&
            (model.id === ref.id || model.modelID === ref.id),
        )
      : undefined;

  const ttlFor = (ref: ModelRef | undefined, model?: ModelInfo, provider?: ProviderInfo) =>
    ttlForModel(settings.ttl, ref) ??
    parseTtl(model?.settings?.cache?.ttl) ??
    parseTtl(provider?.settings?.cache?.ttl) ??
    DEFAULT_TTL;

  const nameOf = (model: ModelInfo | undefined, ref: ModelRef) => model?.name ?? ref.id;

  function compactionFor(
    models: readonly ModelInfo[],
    current: ModelRef,
    tokens: number,
    price: ReturnType<typeof priceFor>,
  ): Choice | undefined {
    const candidates = settings.compactionModels.flatMap((ref) => {
      const model = findModel(models, ref);
      if (!model) return [];
      const limit = model.limit.input ?? model.limit.context;
      return [{ ref, name: nameOf(model, ref), costs: model.cost, limit }];
    });
    return compactionChoice({ candidates, current, tokens, price, minCost: settings.minCost });
  }

  const configured = new Map<string, { warming: unknown }>();
  const loading = new Set<string>();
  function topWarming(directory: string | undefined): unknown {
    const key = directory ?? '';
    const loaded = configured.get(key);
    if (!loaded && !loading.has(key)) {
      loading.add(key);
      void options
        .client()
        .config.get(directory ? { location: { directory } } : undefined)
        .then((entries) => {
          const warming = [...entries]
            .reverse()
            .map((entry) => (entry.type === 'document' ? entry.info.warming : undefined))
            .find((value) => value !== undefined);
          configured.set(key, { warming });
        })
        .catch(() => loading.delete(key));
    }
    return loaded?.warming;
  }

  const cacheSettings = (settings: unknown) =>
    (settings as { cache?: { ttl?: unknown; warming?: unknown } } | undefined)?.cache;

  function warmingFor(sessionID: string, model?: ModelInfo, provider?: ProviderInfo) {
    if (session(sessionID)?.parentID) return undefined;
    const fromModel = cacheSettings(model?.settings);
    const fromProvider = cacheSettings(provider?.settings);
    return resolveWarming({
      top: topWarming(locationOf(sessionID)?.directory),
      provider: fromProvider?.warming,
      model: fromModel?.warming,
      ttl: parseTtl(fromModel?.ttl) ?? parseTtl(fromProvider?.ttl),
    });
  }

  const startedAt = (sessionID: string) => (id: string) => options.startedAt(sessionID, id);

  const stepOf = (sessionID: string) =>
    lastStep(data.session.message.list(sessionID) as Messages, startedAt(sessionID));

  function view(sessionID: string, time: number) {
    const step = stepOf(sessionID);
    const { models, providers } = catalog(sessionID);
    const selected = options.selectedModel(sessionID);
    const stepModel = step && findModel(models, step.model);
    const target = selected ? findModel(models, selected) : stepModel;
    const provider = step && providers.find((entry) => entry.id === step.model.providerID);
    const ttl = ttlFor(step?.model, stepModel, provider);
    const warming = warmingFor(sessionID, stepModel, provider);
    const state = cacheState({
      step,
      now: time,
      ttl,
      running: data.session.status(sessionID) === 'running',
      selected,
      warming,
    });
    const tokens = step ? contextTokens(step.tokens) : 0;
    const next = nextCost(state, tokens, target && priceFor(target.cost, tokens));
    const alternative =
      state.kind === 'cold' && step
        ? compactionFor(
            models,
            selected ?? step.model,
            tokens,
            target && priceFor(target.cost, tokens),
          )
        : undefined;
    return {
      state,
      ttl,
      warming,
      next,
      alternative,
      stepModel: step && nameOf(stepModel, step.model),
      selectedModel: selected && nameOf(target, selected),
    };
  }

  const health = createHealth(options.thresholds);
  const unseen = new Map<string, { finding: Finding; name: string }>();

  const cachePriced = (model?: ModelInfo) =>
    (model?.cost ?? []).some((cost) => cost.cache.read > 0 || cost.cache.write > 0);

  function healthTips(
    sessionID: string,
    finding: Finding | undefined,
    name: string,
    visible: boolean,
  ): Tip[] {
    if (finding && healthTip(finding, name)) {
      const pending = unseen.get(sessionID)?.finding;
      unseen.delete(sessionID);
      const dropped =
        finding.type === 'recovered' &&
        pending?.type === 'persistent' &&
        pending.key === finding.key &&
        pending.incident === finding.incident;
      if (dropped) return [];
      unseen.set(sessionID, { finding, name });
      while (unseen.size > 50) {
        const oldest = unseen.keys().next().value;
        if (oldest === undefined) break;
        unseen.delete(oldest);
      }
    }
    if (!visible) return [];
    const pending = unseen.get(sessionID);
    unseen.delete(sessionID);
    const tip = pending && healthTip(pending.finding, pending.name);
    return tip ? [tip] : [];
  }

  function describe(sessionID: string, time: number) {
    const lines = details({ ...view(sessionID, time), sessionCost: data.session.cost(sessionID) });
    if (!settings.health) return lines;
    const step = stepOf(sessionID);
    const message = step && data.session.message.get(sessionID, step.id);
    const agent = message?.type === 'assistant' ? message.agent : undefined;
    const status = step
      ? health.status(sessionID, step.model, agent)
      : ({ kind: 'unknown' } as const);
    const extra = healthLines(status, health.summary(sessionID));
    return extra.length ? [...lines, '', ...extra] : lines;
  }

  function notice(input: {
    sessionID: string;
    stepID: string;
    expires: number;
    tokens: number;
    ref?: ModelRef;
    model?: ModelInfo;
    models: readonly ModelInfo[];
  }): Notice | undefined {
    const { ref, model, tokens } = input;
    if (!settings.notices || !ref) return undefined;
    const price = model && priceFor(model.cost, tokens);
    const choice = compactionFor(input.models, ref, tokens, price);
    const description = expiryNotice({
      time: formatClock(input.expires),
      tokens,
      from: { name: shortName(nameOf(model, ref)), price },
      choice: choice && { ...choice, name: shortName(choice.name) },
      minTokens: settings.minTokens,
      minCost: settings.minCost,
    });
    if (!description) return undefined;
    return {
      sessionID: input.sessionID,
      stepID: input.stepID,
      at: input.expires - EXPIRING,
      expires: input.expires,
      description,
    };
  }

  function switchTip(sessionID: string, selected: ModelRef, now = Date.now()): Tip | undefined {
    if (!settings.tips) return undefined;
    const step = stepOf(sessionID);
    if (!step || !reportsCache(step.tokens) || sameModel(step.model, selected)) return undefined;
    const { models, providers } = catalog(sessionID);
    const from = findModel(models, step.model);
    const to = findModel(models, selected);
    const provider = providers.find((entry) => entry.id === step.model.providerID);
    const tokens = contextTokens(step.tokens);
    const price = from && priceFor(from.cost, tokens);
    const tip = modelSwitchTip({
      tokens,
      warm: step.started + ttlFor(step.model, from, provider) > now,
      from: { name: nameOf(from, step.model), price },
      to: { name: nameOf(to, selected), price: to && priceFor(to.cost, tokens) },
      compaction: compactionFor(models, step.model, tokens, price),
      minTokens: settings.minTokens,
      minCost: settings.minCost,
    });
    return tip && { ...tip, key: `${tip.key}:${step.id}` };
  }

  const coached = (sessionID: string) => !session(sessionID)?.parentID;

  function stepEnded(
    event: StepEnded,
    visible: boolean,
    now = Date.now(),
  ): { notice?: Notice; tips: Tip[] } | undefined {
    const { sessionID, assistantMessageID, tokens } = event;
    if (!coached(sessionID)) return undefined;
    const message = data.session.message.get(sessionID, assistantMessageID);
    const ref =
      message?.type === 'assistant' ? message.model : (session(sessionID)?.model ?? undefined);
    const { models, providers } = catalog(sessionID);
    const model = findModel(models, ref);
    const total = contextTokens(tokens);
    const provider = ref && providers.find((entry) => entry.id === ref.providerID);
    const started =
      options.startedAt(sessionID, assistantMessageID) ?? message?.time.created ?? now;
    const price = model && priceFor(model.cost, promptTokens(tokens));
    const checked =
      settings.health && ref
        ? healthTips(
            sessionID,
            health.observe({
              sessionID,
              stepID: assistantMessageID,
              model: ref,
              ...(message?.type === 'assistant' ? { agent: message.agent } : {}),
              started,
              tokens,
              ttl: ttlFor(ref, model, provider),
              cachePriced: cachePriced(model),
              ...(price ? { price } : {}),
            }),
            shortName(nameOf(model, ref)),
            visible,
          )
        : [];
    if (!reportsCache(tokens)) return checked.length ? { tips: checked } : undefined;
    const scheduled = notice({
      sessionID,
      stepID: assistantMessageID,
      expires: started + ttlFor(ref, model, provider),
      tokens: total,
      ref,
      model,
      models,
    });
    if (!visible || !settings.tips) return { notice: scheduled, tips: checked };
    const tips: (Tip | undefined)[] = [];
    const previous = lastStep(
      data.session.message.list(sessionID) as Messages,
      startedAt(sessionID),
      assistantMessageID,
    );
    const warming = warmingFor(sessionID, model, provider);
    if (previous && ref && warming && sameModel(previous.model, ref)) {
      tips.push(
        warmingTip({
          gap: started - (previous.ended ?? previous.started),
          ttl: ttlFor(ref, model, provider),
          warming,
          model: shortName(nameOf(model, ref)),
          written: tokens.cache.write,
          prompt: promptTokens(tokens),
          minTokens: settings.minTokens,
          minCost: settings.minCost,
          price: model && priceFor(model.cost, total),
        }),
      );
    }
    tips.push(
      contextCeilingTip({
        tokens: total,
        ceiling: contextCeiling({
          configured: settings.contextCeiling,
          costs: model?.cost,
          modelLimit: model ? (model.limit.input ?? model.limit.context) : undefined,
        }),
        ratio: settings.contextRatio,
        price: model && priceFor(model.cost, total),
      }),
    );
    return { notice: scheduled, tips: [...checked, ...tips.filter((tip): tip is Tip => !!tip)] };
  }

  function toolOutput(event: ToolOutput): Tip | undefined {
    const { sessionID, assistantMessageID, id, content } = event;
    if (!settings.tips || !coached(sessionID)) return undefined;
    const text = content.reduce(
      (sum, part) => sum + (part.type === 'text' ? (part.text ?? '') : ''),
      '',
    );
    const tokens = estimateTokens(text);
    if (tokens < settings.largeOutput) return undefined;
    const message = data.session.message.get(sessionID, assistantMessageID);
    const assistant = message?.type === 'assistant' ? message : undefined;
    const tool = assistant?.content.find((part) => part.type === 'tool' && part.id === id);
    const model = findModel(catalog(sessionID).models, assistant?.model);
    return largeOutputTip({
      tool: tool?.type === 'tool' ? tool.name : 'A tool',
      tokens,
      threshold: settings.largeOutput,
      price: model && priceFor(model.cost, tokens),
    });
  }

  function stepFailed(event: { sessionID: string; assistantMessageID: string }) {
    health.failed(event.sessionID, event.assistantMessageID);
  }

  function compacted(sessionID: string) {
    health.compacted(sessionID);
    unseen.delete(sessionID);
  }

  return { view, describe, switchTip, stepEnded, stepFailed, compacted, toolOutput, coached };
}

export function createNotices(input: {
  deliver: (notice: Notice) => void;
  running: (sessionID: string) => boolean;
}) {
  const pending = new Map<string, Notice>();
  return {
    set(sessionID: string, notice: Notice | undefined) {
      if (notice) pending.set(sessionID, notice);
      else pending.delete(sessionID);
    },
    get: (sessionID: string) => pending.get(sessionID),
    check(time: number) {
      for (const [sessionID, notice] of pending) {
        if (time < notice.at) continue;
        pending.delete(sessionID);
        if (time >= notice.expires || input.running(sessionID)) continue;
        input.deliver(notice);
      }
    },
  };
}

export function createSwitchWatcher(onSwitch: (sessionID: string, selected: ModelRef) => void) {
  let previous: { sessionID: string; key: string } | undefined;
  return (
    sessionID: string | undefined,
    model: { providerID: string; modelID: string } | undefined,
  ) => {
    if (!sessionID || !model) {
      previous = undefined;
      return;
    }
    const key = `${model.providerID}/${model.modelID}`;
    const last = previous;
    previous = { sessionID, key };
    if (!last || last.sessionID !== sessionID || last.key === key) return;
    onSwitch(sessionID, { providerID: model.providerID, id: model.modelID });
  };
}

export function createTipGate(store: {
  has: (key: string) => boolean;
  add: (key: string) => void;
  remove: (key: string) => void;
}) {
  return {
    take(sessionID: string, tip: Tip | undefined): Tip | undefined {
      if (!tip) return undefined;
      const key = `${sessionID}:${tip.key}`;
      if (store.has(key)) return undefined;
      store.add(key);
      return tip;
    },
    compacted: (sessionID: string) => store.remove(`${sessionID}:context-limit`),
  };
}
