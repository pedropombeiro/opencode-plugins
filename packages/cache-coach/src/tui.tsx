/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import { createViewFilter } from '../../_shared/src/index.ts';
import { indicator, type Tone } from './cache';
import { createCoach, createNotices, createSwitchWatcher, createTipGate } from './coach';
import { NOTICE_TEXT } from './notice';
import { parseOptions } from './options';
import type { Tip } from './tips';

export default {
  id: 'opencode-cache-coach',
  async setup(context) {
    const settings = parseOptions(context.options);
    const [now, setNow] = createSignal(Date.now());
    const [starts, setStarts] = context.storage.memory<
      Record<string, { id: string; at: number } | undefined>
    >('step-starts', { initial: {} });
    const [shown, setShown] = context.storage.memory<Record<string, boolean | undefined>>(
      'tips-shown',
      { initial: {} },
    );

    const coach = createCoach({
      data: context.data,
      client: () => context.client,
      settings,
      selectedModel(sessionID) {
        const route = context.ui.router.current();
        if (route.type === 'session' && route.sessionID === sessionID) {
          const current = context.ui.model.current();
          if (current) return { providerID: current.providerID, id: current.modelID };
        }
        return context.data.session.get(sessionID)?.model;
      },
      startedAt(sessionID, id) {
        const start = starts[sessionID];
        return start?.id === id ? start.at : undefined;
      },
    });

    const notices = createNotices({
      running: (sessionID) => context.data.session.status(sessionID) === 'running',
      deliver: (notice) =>
        void context.client.session
          .synthetic({
            sessionID: notice.sessionID,
            id: `${notice.stepID}-cache-coach`,
            text: NOTICE_TEXT,
            description: notice.description,
            metadata: { cacheCoach: 'expiry' },
            resume: false,
          })
          .catch(() => {}),
    });

    const clock = setInterval(() => {
      const time = Date.now();
      setNow(time);
      notices.check(time);
    }, 1000);

    const gate = createTipGate({
      has: (key) => !!shown[key],
      add: (key) =>
        setShown((draft) => {
          draft[key] = true;
        }),
      remove: (key) =>
        setShown((draft) => {
          delete draft[key];
        }),
    });

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
      void context.ui.dialog.alert({
        title: 'Prompt cache',
        message: coach.describe(id, Date.now()).join('\n'),
      });
    }

    function showTip(sessionID: string, tip: Tip | undefined) {
      const shown = gate.take(sessionID, tip);
      if (!shown) return;
      context.ui.toast.show({
        title: shown.title,
        message: shown.message,
        variant: shown.variant,
        duration: 12_000,
        sessionID,
      });
    }

    const shows = createViewFilter(context, () => false);

    function Indicator(props: { sessionID?: string }) {
      const current = createMemo(() => {
        if (!props.sessionID) return undefined;
        const value = coach.view(props.sessionID, now());
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

    const watchSwitch = createSwitchWatcher((sessionID, selected) =>
      showTip(sessionID, coach.switchTip(sessionID, selected)),
    );

    context.ui.slot({
      append: 'app',
      render: () => {
        createEffect(() => {
          const route = context.ui.router.current();
          const current = context.ui.model.current();
          const sessionID = route.type === 'session' ? route.sessionID : undefined;
          untrack(() => watchSwitch(sessionID, current));
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
        notices.set(sessionID, undefined);
        setStarts((draft) => {
          draft[sessionID] = { id: assistantMessageID, at: Date.now() };
        });
      }),
      context.data.on('session.step.ended', (event) => {
        const result = coach.stepEnded(event.data, shows(event));
        if (!result) return;
        notices.set(event.data.sessionID, result.notice);
        for (const tip of result.tips) showTip(event.data.sessionID, tip);
      }),
      context.data.on('session.tool.success', (event) => {
        if (shows(event)) showTip(event.data.sessionID, coach.toolOutput(event.data));
      }),
      context.data.on('session.compaction.ended', (event) => gate.compacted(event.data.sessionID)),
    ];

    return () => {
      clearInterval(clock);
      for (const stop of stops) stop();
    };
  },
} satisfies Plugin.Definition;
