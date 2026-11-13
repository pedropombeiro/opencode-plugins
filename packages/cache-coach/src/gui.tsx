/** @jsxImportSource solid-js */
import {
  Command,
  ComposerPill,
  createKeyed,
  Panel,
  Plugin,
  Style,
  type ComposerPillView,
  type MountedSession,
  type PanelTab,
  type ServerRef,
  type SessionRef,
} from '@opencode/plugin/gui';
import { createMemo, createSignal, For, mapArray, onCleanup, Show } from 'solid-js';
import { aboutUsd, indicator, shortName } from './cache';
import {
  createCoach,
  createNotices,
  createSwitchWatcher,
  createTipGate,
  type Coach,
  type Notice,
} from './coach';
import { parseOptions } from './options';
import type { Tip } from './tips';

const CSS = `
.cache-coach-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; overflow-y: auto; height: 100%; font-size: 13px; line-height: 1.5; color: var(--v2-text-text-base); }
.cache-coach-panel h2 { font-size: 13px; font-weight: 600; margin: 0; }
.cache-coach-panel section { display: flex; flex-direction: column; gap: 2px; }
.cache-coach-panel .cc-card { border: 1px solid var(--v2-border-border-muted); border-radius: 8px; padding: 8px 10px; }
.cache-coach-panel .cc-muted { color: var(--v2-text-text-muted); }
.cache-coach-panel .cc-success { color: var(--v2-state-fg-success); }
.cache-coach-panel .cc-warning { color: var(--v2-state-fg-warning); }
`;

const DETAILS_TAB = 'details';

interface ServerCoach {
  coach: Coach;
  notices: ReturnType<typeof createNotices>;
  starts: Map<string, { id: string; at: number }>;
}

const pillLabel = (text: string) => text.replace(/^[●◐○]\s*/, '');

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS);
    const settings = parseOptions(ctx.options);
    const [now, setNow] = createSignal(Date.now());
    const shown = new Set<string>();
    const gate = createTipGate({
      has: (key) => shown.has(key),
      add: (key) => shown.add(key),
      remove: (key) => shown.delete(key),
    });

    const routed = (server: ServerRef, sessionID: string) => {
      const session = ctx.sessions.current();
      return session?.server.id === server.id && session.id === sessionID ? session : undefined;
    };

    const openRef = (server: ServerRef, sessionID: string): SessionRef | undefined =>
      ctx.sessions.list().find((ref) => ref.server.id === server.id && ref.id === sessionID);

    const visible = (server: ServerRef, sessionID: string) => {
      const root = server.data.session.root(sessionID);
      return ctx.sessions
        .list()
        .some((ref) => ref.server.id === server.id && server.data.session.root(ref.id) === root);
    };

    const openDetails = (session: SessionRef) =>
      ctx.layout.open(`${ctx.id}:${DETAILS_TAB}`, session, { tab: 'select' });

    function toast(
      server: ServerRef,
      sessionID: string,
      input: { title: string; message: string },
    ) {
      const ref = openRef(server, sessionID);
      ctx.toast.show({
        title: input.title,
        description: input.message,
        duration: 12_000,
        ...(ref
          ? {
              actions: [
                {
                  label: 'Show prompt cache',
                  run: () => {
                    ctx.tabs.open({ server: server.id, id: sessionID }, { focus: true });
                    openDetails(ref);
                  },
                },
              ],
            }
          : {}),
      });
    }

    function showTip(server: ServerRef, sessionID: string, tip: Tip | undefined) {
      const taken = gate.take(sessionID, tip);
      if (taken) toast(server, sessionID, taken);
    }

    function deliver(server: ServerRef, notice: Notice) {
      if (!visible(server, notice.sessionID)) return;
      toast(server, notice.sessionID, {
        title: 'Prompt cache expires soon',
        message: notice.description,
      });
      void ctx.attention.notify({
        title: 'Prompt cache expires soon',
        message: notice.description,
        session: { server: server.id, id: notice.sessionID },
        id: `cache-coach:${server.id}:${notice.stepID}`,
      });
    }

    const coaches = new WeakMap<object, ServerCoach>();
    function coachFor(server: ServerRef): ServerCoach {
      const data = server.data;
      const existing = coaches.get(data);
      if (existing) return existing;
      const starts = new Map<string, { id: string; at: number }>();
      const entry: ServerCoach = {
        starts,
        notices: createNotices({
          running: (sessionID) => data.session.status(sessionID) === 'running',
          deliver: (notice) => deliver(server, notice),
        }),
        coach: createCoach({
          data,
          client: () => ctx.servers.get(server.id)?.client ?? server.client,
          settings,
          selectedModel(sessionID) {
            const model = routed(server, sessionID) && ctx.screen.current()?.composer.model();
            if (model) return { providerID: model.providerID, id: model.modelID };
            return data.session.get(sessionID)?.model;
          },
          startedAt(sessionID, id) {
            const start = starts.get(sessionID);
            return start?.id === id ? start.at : undefined;
          },
        }),
      };
      coaches.set(data, entry);
      return entry;
    }

    const clock = setInterval(() => {
      const time = Date.now();
      setNow(time);
      for (const id of ctx.servers.list()) {
        const server = ctx.servers.get(id);
        if (server) coaches.get(server.data)?.notices.check(time);
      }
    }, 1000);

    createMemo(
      mapArray(
        () => ctx.servers.list(),
        (id) =>
          createKeyed(
            () => ctx.servers.get(id)?.data,
            (data) => {
              const server = ctx.servers.get(id);
              if (!server) return;
              const { coach, notices, starts } = coachFor(server);
              const stops = [
                data.on('session.step.started', (event) => {
                  const { sessionID, assistantMessageID } = event.data;
                  notices.set(sessionID, undefined);
                  starts.set(sessionID, { id: assistantMessageID, at: Date.now() });
                }),
                data.on('session.step.ended', (event) => {
                  const { sessionID } = event.data;
                  const result = coach.stepEnded(event.data, visible(server, sessionID));
                  if (!result) return;
                  notices.set(sessionID, result.notice);
                  for (const tip of result.tips) showTip(server, sessionID, tip);
                }),
                data.on('session.tool.success', (event) => {
                  const { sessionID } = event.data;
                  if (visible(server, sessionID))
                    showTip(server, sessionID, coach.toolOutput(event.data));
                }),
                data.on('session.compaction.ended', (event) =>
                  gate.compacted(event.data.sessionID),
                ),
              ];
              onCleanup(() => {
                for (const stop of stops) stop();
              });
            },
          ),
      ),
    );

    const watchSwitch = createSwitchWatcher((key, selected) => {
      const session = ctx.sessions.current();
      if (session?.key === key)
        showTip(
          session.server,
          session.id,
          coachFor(session.server).coach.switchTip(session.id, selected),
        );
    });
    createKeyed(
      () => {
        const session = ctx.sessions.current();
        const model = session && ctx.screen.current()?.composer.model();
        return session && model
          ? JSON.stringify([session.key, model.providerID, model.modelID])
          : undefined;
      },
      (key) => {
        const [sessionKey, providerID, modelID] = JSON.parse(key) as [string, string, string];
        watchSwitch(sessionKey, { providerID, modelID });
      },
      { otherwise: () => watchSwitch(undefined, undefined) },
    );

    const viewOf = (session: SessionRef) => coachFor(session.server).coach.view(session.id, now());

    ctx.add(ComposerPill, {
      id: 'cache',
      show: (input): ComposerPillView | undefined => {
        const value = viewOf(input.session);
        const current = indicator(value.state, value.next, value.alternative);
        if (!current) return undefined;
        return {
          icon: 'status',
          label: pillLabel(current.text),
          ...(current.tone === 'muted' ? {} : { tone: current.tone }),
          title: 'Prompt cache',
          run: () => openDetails(input.session),
        };
      },
    });

    function DetailsView(props: { session: MountedSession }) {
      const lines = () => coachFor(props.session.server).coach.describe(props.session.id, now());
      const value = () => viewOf(props.session);
      const sections = () => {
        const groups: string[][] = [[]];
        for (const line of lines()) {
          if (line) groups[groups.length - 1].push(line);
          else groups.push([]);
        }
        return groups.filter((group) => group.length);
      };
      const notice = () => {
        now();
        return coachFor(props.session.server).notices.get(props.session.id);
      };
      const tone = () => {
        const current = indicator(value().state, value().next, value().alternative);
        return current?.tone === 'success' ? 'cc-success' : current ? 'cc-warning' : 'cc-muted';
      };
      return (
        <div class="cache-coach-panel">
          <h2>Prompt cache</h2>
          <For each={sections()}>
            {(group, index) => (
              <section class={index() === 0 ? tone() : undefined}>
                <For each={group}>{(line) => <div>{line}</div>}</For>
              </section>
            )}
          </For>
          <Show when={value().alternative}>
            {(alternative: () => NonNullable<ReturnType<typeof value>['alternative']>) => (
              <div class="cc-card">
                Compacting on {shortName(alternative().name)} costs {aboutUsd(alternative().cost)}.
                Switch to it, run /compact, then switch back.
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(pending: () => Notice) => <div class="cc-card cc-muted">{pending().description}</div>}
          </Show>
        </div>
      );
    }

    const detailsTab: PanelTab = { id: DETAILS_TAB, title: 'Prompt cache', closable: 'hover' };
    ctx.add(Panel, {
      id: DETAILS_TAB,
      region: 'side',
      width: 420,
      list: (input) => (input.open.includes(DETAILS_TAB) ? [detailsTab] : []),
      render: (props) => <DetailsView session={props.session} />,
    });

    ctx.add(
      Command,
      (): Command => ({
        id: 'details',
        title: 'Show prompt cache status',
        group: 'Cache',
        slash: { name: 'cache' },
        enabled: !!ctx.sessions.current(),
        run: () => {
          const session = ctx.sessions.current();
          if (session) openDetails(session);
        },
      }),
    );

    return () => clearInterval(clock);
  },
});
