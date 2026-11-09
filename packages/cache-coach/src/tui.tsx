/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import { createViewFilter, type EventOf } from '../../_shared/src/index.ts';
import {
  cacheState,
  contextCeiling,
  contextTokens,
  DEFAULT_TTL,
  EXPIRING,
  details,
  indicator,
  lastStep,
  nextCost,
  parseTtl,
  priceFor,
  promptTokens,
  reportsCache,
  sameModel,
  shortName,
  type ModelRef,
  type Tone,
} from './cache';
import { parseOptions } from './options';
import {
  contextCeilingTip,
  estimateTokens,
  largeOutputTip,
  modelSwitchTip,
  warmingTip,
  type Tip,
} from './tips';
import { resolveWarming } from './warming';
import { compactionChoice, expiryNotice, formatClock, type Choice } from './compaction';
import { NOTICE_TEXT } from './notice';

type Data = Plugin.Context['data'];
type ModelInfo = NonNullable<ReturnType<Data['location']['model']['list']>>[number];
type ProviderInfo = NonNullable<ReturnType<Data['location']['provider']['list']>>[number];
type Messages = Parameters<typeof lastStep>[0];

export default {
  id: 'opencode-cache-coach',
  async setup(context) {
    const settings = parseOptions(context.options);
    const [now, setNow] = createSignal(Date.now());
    const clock = setInterval(() => {
      const time = Date.now();
      setNow(time);
      checkNotices(time);
    }, 1000);
    const [starts, setStarts] = context.storage.memory<
      Record<string, { id: string; at: number } | undefined>
    >('step-starts', { initial: {} });
    const [shown, setShown] = context.storage.memory<Record<string, boolean | undefined>>(
      'tips-shown',
      { initial: {} },
    );

    const session = (sessionID: string) => context.data.session.get(sessionID);
    const locationOf = (sessionID: string) => {
      const directory = session(sessionID)?.location.directory;
      return directory ? { directory } : undefined;
    };

    const synced = new Set<string>();
    function catalog(sessionID: string) {
      const location = locationOf(sessionID);
      const models = context.data.location.model.list(location);
      const providers = context.data.location.provider.list(location);
      const key = location?.directory ?? '';
      if ((!models || !providers) && !synced.has(key)) {
        synced.add(key);
        void context.data.location.model.sync(location).catch(() => {});
        void context.data.location.provider.sync(location).catch(() => {});
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

    const ttlFor = (model?: ModelInfo, provider?: ProviderInfo) =>
      settings.ttl ??
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

    const [configured, setConfigured] = createSignal<Record<string, { warming: unknown }>>({});
    const loading = new Set<string>();
    function topWarming(directory: string | undefined): unknown {
      const key = directory ?? '';
      const loaded = configured()[key];
      if (!loaded && !loading.has(key)) {
        loading.add(key);
        void context.client.config
          .get(directory ? { location: { directory } } : undefined)
          .then((entries) => {
            const warming = [...entries]
              .reverse()
              .map((entry) => (entry.type === 'document' ? entry.info.warming : undefined))
              .find((value) => value !== undefined);
            setConfigured((current) => ({ ...current, [key]: { warming } }));
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

    function selectedModel(sessionID: string): ModelRef | undefined {
      const route = context.ui.router.current();
      if (route.type === 'session' && route.sessionID === sessionID) {
        const current = context.ui.model.current();
        if (current) return { providerID: current.providerID, id: current.modelID };
      }
      return session(sessionID)?.model;
    }

    const startedAt = (sessionID: string) => (id: string) => {
      const start = starts[sessionID];
      return start?.id === id ? start.at : undefined;
    };

    const stepOf = (sessionID: string) =>
      lastStep(context.data.session.message.list(sessionID) as Messages, startedAt(sessionID));

    function view(sessionID: string, time: number) {
      const step = stepOf(sessionID);
      const { models, providers } = catalog(sessionID);
      const selected = selectedModel(sessionID);
      const stepModel = step && findModel(models, step.model);
      const target = selected ? findModel(models, selected) : stepModel;
      const provider = step && providers.find((entry) => entry.id === step.model.providerID);
      const ttl = ttlFor(stepModel, provider);
      const warming = warmingFor(sessionID, stepModel, provider);
      const state = cacheState({
        step,
        now: time,
        ttl,
        running: context.data.session.status(sessionID) === 'running',
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

    const color = (tone: Tone) => {
      if (tone === 'success') return context.theme.text.feedback.success.base;
      if (tone === 'warning') return context.theme.text.feedback.warning.base;
      return context.theme.text.muted;
    };

    function showDetails(sessionID?: string) {
      const route = context.ui.router.current();
      const id = sessionID ?? (route.type === 'session' ? route.sessionID : undefined);
      if (!id) {
        context.ui.toast.show({ message: 'Open a session to see its cache', variant: 'info' });
        return;
      }
      const current = view(id, Date.now());
      void context.ui.dialog.alert({
        title: 'Prompt cache',
        message: details({ ...current, sessionCost: context.data.session.cost(id) }).join('\n'),
      });
    }

    function showTip(sessionID: string, tip: Tip | undefined) {
      if (!tip || !settings.tips) return;
      const key = `${sessionID}:${tip.key}`;
      if (shown[key]) return;
      setShown((draft) => {
        draft[key] = true;
      });
      context.ui.toast.show({
        title: tip.title,
        message: tip.message,
        variant: tip.variant,
        duration: 12_000,
        sessionID,
      });
    }

    const pending: Record<
      string,
      { stepID: string; at: number; expires: number; description: string } | undefined
    > = {};

    function scheduleNotice(input: {
      sessionID: string;
      stepID: string;
      expires: number;
      tokens: number;
      ref?: ModelRef;
      model?: ModelInfo;
      models: readonly ModelInfo[];
    }) {
      const { sessionID, ref, model, tokens } = input;
      delete pending[sessionID];
      if (!settings.notices || !ref) return;
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
      if (!description) return;
      pending[sessionID] = {
        stepID: input.stepID,
        at: input.expires - EXPIRING,
        expires: input.expires,
        description,
      };
    }

    function checkNotices(time: number) {
      for (const [sessionID, notice] of Object.entries(pending)) {
        if (!notice || time < notice.at) continue;
        delete pending[sessionID];
        if (time >= notice.expires || context.data.session.status(sessionID) === 'running')
          continue;
        void context.client.session
          .synthetic({
            sessionID,
            id: `${notice.stepID}-cache-coach`,
            text: NOTICE_TEXT,
            description: notice.description,
            metadata: { cacheCoach: 'expiry' },
            resume: false,
          })
          .catch(() => {});
      }
    }

    function checkSwitch(sessionID: string, selected: ModelRef) {
      const step = stepOf(sessionID);
      if (!step || !reportsCache(step.tokens) || sameModel(step.model, selected)) return;
      const { models, providers } = catalog(sessionID);
      const from = findModel(models, step.model);
      const to = findModel(models, selected);
      const provider = providers.find((entry) => entry.id === step.model.providerID);
      const tokens = contextTokens(step.tokens);
      const price = from && priceFor(from.cost, tokens);
      const tip = modelSwitchTip({
        tokens,
        warm: step.started + ttlFor(from, provider) > Date.now(),
        from: { name: nameOf(from, step.model), price },
        to: { name: nameOf(to, selected), price: to && priceFor(to.cost, tokens) },
        compaction: compactionFor(models, step.model, tokens, price),
        minTokens: settings.minTokens,
        minCost: settings.minCost,
      });
      showTip(sessionID, tip && { ...tip, key: `${tip.key}:${step.id}` });
    }

    const shows = createViewFilter(context, () => false);
    const coached = (sessionID: string) => !session(sessionID)?.parentID;

    function onStepEnded(event: EventOf<'session.step.ended'>) {
      const { sessionID, assistantMessageID, tokens } = event.data;
      if (!coached(sessionID) || !reportsCache(tokens)) return;
      const message = context.data.session.message.get(sessionID, assistantMessageID);
      const ref =
        message?.type === 'assistant' ? message.model : (session(sessionID)?.model ?? undefined);
      const { models, providers } = catalog(sessionID);
      const model = findModel(models, ref);
      const total = contextTokens(tokens);
      const provider = ref && providers.find((entry) => entry.id === ref.providerID);
      const start = starts[sessionID];
      const started =
        start?.id === assistantMessageID ? start.at : (message?.time.created ?? Date.now());
      scheduleNotice({
        sessionID,
        stepID: assistantMessageID,
        expires: started + ttlFor(model, provider),
        tokens: total,
        ref,
        model,
        models,
      });
      if (!shows(event)) return;
      const previous = lastStep(
        context.data.session.message.list(sessionID) as Messages,
        startedAt(sessionID),
        assistantMessageID,
      );
      const warming = warmingFor(sessionID, model, provider);
      if (previous && ref && warming && sameModel(previous.model, ref)) {
        showTip(
          sessionID,
          warmingTip({
            gap: started - (previous.ended ?? previous.started),
            ttl: ttlFor(model, provider),
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
      showTip(
        sessionID,
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
    }

    function onToolSuccess(event: EventOf<'session.tool.success'>) {
      const { sessionID, assistantMessageID, id, content } = event.data;
      if (!shows(event) || !coached(sessionID)) return;
      const text = content.reduce((sum, part) => sum + (part.type === 'text' ? part.text : ''), '');
      const tokens = estimateTokens(text);
      if (tokens < settings.largeOutput) return;
      const message = context.data.session.message.get(sessionID, assistantMessageID);
      const assistant = message?.type === 'assistant' ? message : undefined;
      const tool = assistant?.content.find((part) => part.type === 'tool' && part.id === id);
      const model = findModel(catalog(sessionID).models, assistant?.model);
      showTip(
        sessionID,
        largeOutputTip({
          tool: tool?.type === 'tool' ? tool.name : 'A tool',
          tokens,
          threshold: settings.largeOutput,
          price: model && priceFor(model.cost, tokens),
        }),
      );
    }

    function Indicator(props: { sessionID?: string }) {
      const current = createMemo(() => {
        if (!props.sessionID) return undefined;
        const value = view(props.sessionID, now());
        return indicator(value.state, value.next, value.alternative);
      });
      return (
        <Show when={current()}>
          {(value: () => NonNullable<ReturnType<typeof indicator>>) => (
            <text
              wrapMode="none"
              flexShrink={0}
              fg={color(value().tone)}
              onMouseUp={() => showDetails(props.sessionID)}
            >
              {value().text}
            </text>
          )}
        </Show>
      );
    }

    context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => <Indicator sessionID={input.sessionID} />,
    });

    context.ui.slot({
      append: 'app',
      render: () => {
        let previous: { sessionID: string; key: string } | undefined;
        createEffect(() => {
          const route = context.ui.router.current();
          const current = context.ui.model.current();
          if (route.type !== 'session' || !current) {
            previous = undefined;
            return;
          }
          const key = `${current.providerID}/${current.modelID}`;
          const last = previous;
          previous = { sessionID: route.sessionID, key };
          if (!last || last.sessionID !== route.sessionID || last.key === key) return;
          untrack(() =>
            checkSwitch(route.sessionID, { providerID: current.providerID, id: current.modelID }),
          );
        });
        context.keymap.layer(() => ({
          mode: 'global',
          commands: [
            {
              id: 'cache-coach.details',
              title: 'Show prompt cache status',
              group: 'Cache',
              palette: true,
              slash: { name: 'cache' },
              run: () => showDetails(),
            },
          ],
        }));
        return null;
      },
    });

    const stops = [
      context.data.on('session.step.started', (event) => {
        const { sessionID, assistantMessageID } = event.data;
        delete pending[sessionID];
        setStarts((draft) => {
          draft[sessionID] = { id: assistantMessageID, at: Date.now() };
        });
      }),
      context.data.on('session.step.ended', onStepEnded),
      context.data.on('session.tool.success', onToolSuccess),
      context.data.on('session.compaction.ended', (event) => {
        const key = `${event.data.sessionID}:context-limit`;
        setShown((draft) => {
          delete draft[key];
        });
      }),
    ];

    return () => {
      clearInterval(clock);
      for (const stop of stops) stop();
    };
  },
} satisfies Plugin.Definition;
