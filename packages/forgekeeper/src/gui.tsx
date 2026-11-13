/** @jsxImportSource solid-js */
// The desktop app's part. Like the terminal part, it leases the sessions it
// shows so the server watches them, and renders what the server sends: a
// composer pill, side panels for the status and the inbox, commands, and the
// server's notices as toasts.
import {
  Command,
  ComposerPill,
  createKeyed,
  Panel,
  Plugin,
  Style,
  type ComposerPillTone,
  type ComposerPillView,
  type MountedSession,
  type PanelTab,
  type SessionRef,
} from '@opencode/plugin/gui';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { automatedReview } from './automated-review-watch';
import { clientID, connectStatus, loadFeedback, type ForgeRpcClient } from './client-core';
import {
  feedbackFooter,
  feedbackTime,
  linkOptions,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import { yesNo, type ReviewRequest } from './forge';
import { reference, traitsOf } from './forges';
import { detailsMessage, footerSegments, pipelineTone, type Tone } from './format';
import { showNotice } from './notice';
import { ForgeSessionRpc, type EventData } from './rpc';
import type { Place } from './status-client';
import type { Repository } from './git';
import type { Lookup, Snapshot } from './store';

const CSS = `
.forgekeeper-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; overflow-y: auto; height: 100%; font-size: 13px; line-height: 1.5; color: var(--v2-text-text-base); }
.forgekeeper-panel header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.forgekeeper-panel h2 { font-size: 13px; font-weight: 600; margin: 0; }
.forgekeeper-panel section { display: flex; flex-direction: column; gap: 2px; }
.forgekeeper-panel .fk-card { border: 1px solid var(--v2-border-border-muted); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.forgekeeper-panel .fk-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.forgekeeper-panel .fk-muted { color: var(--v2-text-text-muted); }
.forgekeeper-panel .fk-label { color: var(--v2-text-text-muted); }
.forgekeeper-panel .fk-success { color: var(--v2-state-fg-success); }
.forgekeeper-panel .fk-warning { color: var(--v2-state-fg-warning); }
.forgekeeper-panel .fk-error { color: var(--v2-state-fg-danger); }
.forgekeeper-panel a { color: var(--v2-text-text-accent); cursor: pointer; text-decoration: underline; }
.forgekeeper-panel .fk-pre { white-space: pre-wrap; }
`;

const STATUS_TAB = 'status';
const FEEDBACK_TAB = 'feedback';
const EMPTY: InboxState = { items: [], paused: false };

const toneClass = (tone?: Tone) =>
  tone === 'success'
    ? 'fk-success'
    : tone === 'warning'
      ? 'fk-warning'
      : tone === 'error'
        ? 'fk-error'
        : tone === 'muted'
          ? 'fk-muted'
          : undefined;

// The pill's tone is its most urgent segment's.
function pillTone(tones: readonly Tone[]): ComposerPillTone | undefined {
  if (tones.includes('error')) return 'danger';
  if (tones.includes('warning')) return 'warning';
  if (tones.includes('success')) return 'success';
  return undefined;
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS);
    const rpc = ctx.client.rpc(ForgeSessionRpc) as unknown as ForgeRpcClient &
      Record<string, (input: object, options: object) => Promise<unknown>>;
    const at = (directory: string) => ({ location: { directory } });

    const [version, setVersion] = createSignal(0);
    const [inboxes, setInboxes] = createStore<Record<string, InboxState>>({});
    const reload = (directory: string) =>
      loadFeedback(rpc, directory)
        .then((state) => setInboxes(directory, state))
        .catch(() => {});
    const connection = connectStatus(rpc, {
      clientID: clientID(),
      onChange: () => setVersion((value) => value + 1),
      heartbeat: () => {
        for (const directory of Object.keys(inboxes)) void reload(directory);
      },
    });
    const client = connection.client;

    // Only the app's own server runs this plugin. Sessions on other servers
    // have no Forgekeeper there.
    const ownServer = (session: SessionRef) => session.server.builtin;
    const directoryOf = (session: MountedSession) =>
      session.location?.directory ?? session.directory;
    const placeOf = (session: MountedSession): Place => ({
      directory: directoryOf(session),
      key: session.id,
    });
    const snapshotOf = (place: Place): Snapshot => {
      version();
      return client.snapshot(place);
    };
    const enabledFor = (directory: string) => {
      version();
      return client.enabled(directory);
    };
    const inboxOf = (directory: string) => inboxes[directory] ?? EMPTY;
    const requestsOf = (place: Place): ReviewRequest[] => {
      const lookup = snapshotOf(place).lookup;
      return lookup?.kind === 'found' ? lookup.requests : [];
    };

    const current = () => {
      const session = ctx.sessions.current();
      return session && ownServer(session) ? session : undefined;
    };

    // The routed session is the one on screen. Its lease keeps the server
    // watching it, and its checkout's inbox loads.
    createKeyed(
      () => {
        const session = current();
        return session ? JSON.stringify([directoryOf(session), session.id]) : undefined;
      },
      (key) => {
        const [directory, sessionID] = JSON.parse(key) as [string, string];
        const place = { directory, key: sessionID };
        client.show(place);
        void reload(directory);
        onCleanup(() => client.hide(place));
      },
    );

    const open = (tab: string, session = current()) => {
      if (session) ctx.layout.open(`${ctx.id}:${tab}`, session, { tab: 'select' });
    };

    // Commands explain why nothing happens when the checkout has status off.
    const statusOff = (directory: string) => {
      if (enabledFor(directory)) return false;
      ctx.toast.show({ title: "PR/MR status is off in the plugin's options (status: false)" });
      return true;
    };

    ctx.add(ComposerPill, {
      id: 'status',
      show: (input) => pill(input.session),
    });
    function pill(session: MountedSession): ComposerPillView | undefined {
      if (!ownServer(session)) return undefined;
      const place = placeOf(session);
      if (!enabledFor(place.directory)) return undefined;
      const segments = footerSegments(snapshotOf(place));
      const updates = feedbackFooter(inboxOf(place.directory), session.id);
      if (!segments.length && !updates) return undefined;
      return {
        icon: 'review' as const,
        label: [...segments.map((segment) => segment.compact ?? segment.text), updates]
          .filter(Boolean)
          .join(' · '),
        tone: pillTone(segments.map((segment) => segment.tone)),
        title: 'PR/MR status',
        rows: [
          ...segments.map((segment, index) => ({
            id: `segment-${index}`,
            label: segment.text,
            ...(segment.url ? { icon: 'outline-arrow-up-right' as const } : {}),
            ...(segment.tone === 'success' || segment.tone === 'warning'
              ? { tone: segment.tone }
              : segment.tone === 'error'
                ? { tone: 'danger' as const }
                : {}),
            ...(segment.url ? { run: () => ctx.system.openExternal(segment.url!) } : {}),
          })),
          {
            id: 'details',
            label: 'Show PR/MR status',
            icon: 'status' as const,
            run: () => open(STATUS_TAB, session),
          },
          ...(updates
            ? [
                {
                  id: 'feedback',
                  label: updates,
                  icon: 'comment' as const,
                  run: () => open(FEEDBACK_TAB, session),
                },
              ]
            : []),
        ],
      };
    }

    const ui = ctx.ui;

    function Field(props: { label: string; value: string; tone?: Tone; url?: string }) {
      return (
        <div>
          <span class="fk-label">{props.label}: </span>
          <Show when={props.url} fallback={<b class={toneClass(props.tone)}>{props.value}</b>}>
            <a class={toneClass(props.tone)} onClick={() => ctx.system.openExternal(props.url!)}>
              <b>{props.value}</b>
            </a>
          </Show>
        </div>
      );
    }

    function RequestDetails(props: { request: ReviewRequest; head?: string }) {
      const request = () => props.request;
      const traits = () => traitsOf(request());
      const review = () => automatedReview(request());
      return (
        <div class="fk-card">
          <a onClick={() => ctx.system.openExternal(request().url)}>
            <b>
              {reference(request())} {request().title}
            </b>
          </a>
          <section>
            <Field
              label="State"
              value={request().state}
              tone={request().state === 'merged' ? 'success' : undefined}
            />
            <Field
              label="Target"
              value={`${request().targetProject} → ${request().targetBranch}`}
            />
            <Field
              label={traits().ci.charAt(0).toUpperCase() + traits().ci.slice(1)}
              value={request().pipeline?.label ?? 'none'}
              tone={pipelineTone(request().pipeline)}
              url={request().pipeline?.url}
            />
            <Field
              label="Unresolved threads"
              value={`${request().unresolvedThreads}${request().threadsComplete ? '' : '+'}`}
              tone={
                request().unresolvedThreads || !request().threadsComplete ? 'warning' : undefined
              }
            />
            <Field
              label="Draft"
              value={yesNo(request().draft)}
              tone={request().draft ? 'warning' : undefined}
            />
            <Field
              label="Conflicts"
              value={request().conflictsKnown ? yesNo(request().conflicts) : 'unknown'}
              tone={request().conflicts ? 'error' : undefined}
            />
          </section>
          <section>
            <b>Review and approval</b>
            <For each={traits().details(request())}>
              {(line) => {
                const separator = line.indexOf(': ');
                return separator < 0 ? (
                  <div>{line}</div>
                ) : (
                  <Field label={line.slice(0, separator)} value={line.slice(separator + 2)} />
                );
              }}
            </For>
            <Show when={review()}>
              {(value: () => NonNullable<ReturnType<typeof automatedReview>>) => (
                <Field
                  label={`${value().name} review`}
                  value={value().label}
                  tone={value().state === 'running' ? 'warning' : undefined}
                />
              )}
            </Show>
            <Show when={request().awaitingReviewers.length}>
              <Field
                label="Awaiting review"
                value={request()
                  .awaitingReviewers.map((username) => `@${username}`)
                  .join(', ')}
              />
            </Show>
          </section>
          <Show when={!request().reviewersComplete}>
            <div class="fk-warning">Reviewer list is partial</div>
          </Show>
          <Show when={props.head && request().headSha && props.head !== request().headSha}>
            <div class="fk-warning">
              Local HEAD differs from the {traits().noun} head commit (unpushed or not fetched)
            </div>
          </Show>
        </div>
      );
    }

    function StatusView(props: { session: MountedSession }) {
      const place = createMemo(() => placeOf(props.session), undefined, {
        equals: (a, b) => a.directory === b.directory && a.key === b.key,
      });
      const snapshot = createMemo(() => snapshotOf(place()));
      const found = () => {
        const lookup = snapshot().lookup;
        return lookup?.kind === 'found'
          ? (lookup as Extract<Lookup, { kind: 'found' }>)
          : undefined;
      };
      return (
        <div class="forgekeeper-panel">
          <header>
            <h2>PR/MR status</h2>
            <ui.Button
              size="small"
              icon="refresh"
              busy={snapshot().loading}
              onClick={() => void client.refresh(place())}
            >
              Refresh
            </ui.Button>
          </header>
          <Show when={enabledFor(place().directory)} fallback={<div>PR/MR status is off.</div>}>
            <Show
              when={found()}
              fallback={
                <div class={`fk-pre ${snapshot().error ? 'fk-error' : 'fk-muted'}`}>
                  {detailsMessage(snapshot())}
                </div>
              }
            >
              {(lookup: () => Extract<Lookup, { kind: 'found' }>) => (
                <>
                  <Show when={lookup().repository}>
                    {(repository: () => Repository) => (
                      <section>
                        <Field label="Repository" value={repository().source.path} />
                        <Field
                          label="Branch"
                          value={
                            repository().branch === repository().sourceBranch
                              ? repository().branch
                              : `${repository().branch} (pushes to ${repository().sourceBranch})`
                          }
                        />
                      </section>
                    )}
                  </Show>
                  <Show when={!lookup().repository && lookup().sessionTarget}>
                    <Field label="Session target" value={lookup().sessionTarget!} />
                  </Show>
                  <For each={lookup().failed ?? []}>
                    {(failure) => (
                      <div class="fk-warning fk-pre">
                        <b>Unavailable</b>
                        {`\n${failure.url}\n${failure.reason}`}
                      </div>
                    )}
                  </For>
                  <Show when={lookup().requests.length === 0}>
                    <div class="fk-muted">No PR/MR status available.</div>
                  </Show>
                  <For each={lookup().requests}>
                    {(request) => (
                      <RequestDetails request={request} head={lookup().repository?.head} />
                    )}
                  </For>
                  <Show when={snapshot().error}>
                    {(error: () => NonNullable<Snapshot['error']>) => (
                      <div class="fk-error fk-pre">
                        <b>Last refresh failed at {new Date(error().at).toLocaleTimeString()}</b>
                        {`\n${error().message}`}
                      </div>
                    )}
                  </Show>
                  <Show when={snapshot().fetchedAt !== undefined}>
                    <div class="fk-muted">
                      Last fetched: {new Date(snapshot().fetchedAt!).toLocaleTimeString()}
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </div>
      );
    }

    // Runs an inbox action, and shows the inbox the server returns, or the
    // failure as a toast.
    async function inboxAction(directory: string, method: string, input: object) {
      try {
        setInboxes(directory, (await rpc[method](input, at(directory))) as InboxState);
      } catch (error) {
        ctx.toast.show({
          title: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
      }
    }

    function FeedbackItemView(props: { item: FeedbackItem; directory: string; current: string }) {
      const item = () => props.item;
      const facts = () =>
        [
          item().sessionID === props.current ? 'This session' : undefined,
          feedbackTime(item()),
          item().automation
            ? `${item().automation!.state}${item().automation!.reason ? `: ${item().automation!.reason}` : ''}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
      const run = (method: string, input: object = {}) =>
        inboxAction(props.directory, method, { id: item().id, ...input });
      return (
        <div class="fk-card">
          <b>{item().title}</b>
          <div class="fk-muted">{facts()}</div>
          <For each={item().details ?? []}>{(detail) => <div>{detail}</div>}</For>
          <section>
            <For each={linkOptions(item())}>
              {(link) => <a onClick={() => ctx.system.openExternal(link.value)}>{link.title}</a>}
            </For>
          </section>
          <div class="fk-actions">
            <Show when={item().sessionID !== props.current}>
              <ui.Button
                size="small"
                onClick={() => {
                  const server = current()?.server.id;
                  if (server) ctx.tabs.open({ server, id: item().sessionID }, { focus: true });
                }}
              >
                Open session
              </ui.Button>
            </Show>
            <ui.Button size="small" onClick={() => void run('summarizeFeedback')}>
              Summarize in session
            </ui.Button>
            <ui.Button size="small" onClick={() => void run('actOnFeedback')}>
              Act on feedback
            </ui.Button>
            <ui.Button
              size="small"
              onClick={async () => {
                const confirmed = await ctx.dialogs.confirm({
                  title: 'Retry feedback work?',
                  description: 'Retry may repeat earlier changes. Inspect the session first.',
                  confirm: 'Retry',
                  danger: true,
                });
                if (confirmed) await run('actOnFeedback', { retry: true });
              }}
            >
              Retry
            </ui.Button>
            <ui.Button size="small" onClick={() => void run('acknowledgeFeedback')}>
              Acknowledge
            </ui.Button>
          </div>
        </div>
      );
    }

    function FeedbackView(props: { session: MountedSession }) {
      const directory = () => directoryOf(props.session);
      const state = () => inboxOf(directory());
      return (
        <div class="forgekeeper-panel">
          <header>
            <h2>Review updates{state().paused ? ' (monitoring paused)' : ''}</h2>
            <ui.Button
              size="small"
              onClick={() =>
                void inboxAction(directory(), 'pauseFeedback', { paused: !state().paused })
              }
            >
              {state().paused ? 'Resume monitoring' : 'Pause monitoring'}
            </ui.Button>
          </header>
          <Show
            when={state().items.length}
            fallback={<div class="fk-muted">No pending review updates in this checkout.</div>}
          >
            <For each={state().items}>
              {(item) => (
                <FeedbackItemView item={item} directory={directory()} current={props.session.id} />
              )}
            </For>
          </Show>
        </div>
      );
    }

    const tab = (id: string, title: string): PanelTab => ({ id, title, closable: 'hover' });
    const statusTab = tab(STATUS_TAB, 'PR/MR status');
    const feedbackTab = tab(FEEDBACK_TAB, 'Review updates');
    ctx.add(Panel, {
      id: STATUS_TAB,
      region: 'side',
      list: (input) => (input.open.includes(STATUS_TAB) ? [statusTab] : []),
      render: (props) => <StatusView session={props.session} />,
    });
    ctx.add(Panel, {
      id: FEEDBACK_TAB,
      region: 'side',
      list: (input) => (input.open.includes(FEEDBACK_TAB) ? [feedbackTab] : []),
      render: (props) => <FeedbackView session={props.session} />,
    });

    ctx.add(
      Command,
      (): Command => ({
        id: 'status',
        title: 'Show PR/MR status',
        group: 'Forge',
        slash: { name: 'forge-status' },
        enabled: !!current(),
        run: () => {
          const session = current();
          if (!session || statusOff(directoryOf(session))) return;
          void client.refresh(placeOf(session));
          open(STATUS_TAB, session);
        },
      }),
    );
    ctx.add(
      Command,
      (): Command => ({
        id: 'feedback',
        title: 'Show pending review feedback',
        group: 'Forge',
        slash: { name: 'forge-feedback' },
        enabled: !!current(),
        run: () => {
          const session = current();
          if (!session) return;
          void reload(directoryOf(session));
          open(FEEDBACK_TAB, session);
        },
      }),
    );
    ctx.add(
      Command,
      (): Command => ({
        id: 'open',
        title: 'Open PR/MR in browser',
        group: 'Forge',
        slash: { name: 'forge-open' },
        enabled: !!current(),
        run: async () => {
          const session = current();
          if (!session || statusOff(directoryOf(session))) return;
          const place = placeOf(session);
          let requests = requestsOf(place);
          if (requests.length === 0) {
            await client.refresh(place);
            requests = requestsOf(place);
          }
          if (requests.length === 0) {
            ctx.toast.show({ title: 'No PR/MR for this session or branch' });
            return;
          }
          const url =
            requests.length === 1
              ? requests[0].url
              : await ctx.dialogs.select({
                  title: 'Open PR/MR',
                  options: requests.map((request) => ({
                    title: `${reference(request)} ${request.title}`,
                    description: request.targetProject,
                    value: request.url,
                  })),
                });
          if (url) ctx.system.openExternal(url);
        },
      }),
    );

    const builtinServer = () =>
      ctx.servers
        .list()
        .map((id) => ctx.servers.get(id))
        .find((server) => server?.builtin);
    const stops = [
      rpc.events.on('feedbackChanged', (event) => {
        const { directory } = event.data as EventData<'feedbackChanged'>;
        if (directory in inboxes) void reload(directory);
      }),
      rpc.events.on('notice', (event) => {
        const notice = event.data as EventData<'notice'>;
        showNotice(notice, {
          hasShown: (sessionID) =>
            client.hasShown(sessionID) ||
            (!!event.location?.directory && event.location.directory in inboxes),
          openTab: (sessionID) => {
            const server = builtinServer()?.id;
            if (server) ctx.tabs.open({ server, id: sessionID });
          },
          toast: ({ title, message, variant }) => {
            const server = builtinServer()?.id;
            const sessionID = notice.sessionID;
            ctx.toast.show({
              title: title ?? message,
              ...(title ? { description: message } : {}),
              variant: variant === 'error' ? 'error' : 'default',
              ...(server && sessionID
                ? {
                    actions: [
                      {
                        label: 'Open session',
                        run: () => ctx.tabs.open({ server, id: sessionID }, { focus: true }),
                      },
                    ],
                  }
                : {}),
            });
            void ctx.attention.notify({
              title: title ?? 'Forgekeeper',
              message,
              variant: variant === 'error' ? 'error' : 'default',
              ...(server && sessionID ? { session: { server, id: sessionID } } : {}),
              id: `forgekeeper:${sessionID ?? ''}:${title ?? ''}:${message}`,
            });
          },
        });
      }),
    ];

    return () => {
      for (const stop of stops) stop();
      connection.dispose();
    };
  },
});
