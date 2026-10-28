/** @jsxImportSource @opentui/solid */
// OpenCode loads this CLI entry point automatically because the server entry
// point in index.ts is configured in opencode.json. The server looks up and
// watches the PRs/MRs; this entry point renders their status and shows the
// server's notices as toasts. The server watches only sessions that a CLI has
// shown, so this entry point renews a lease on each of them.
import type { Plugin } from '@opencode/plugin/tui';
import type { BoxRenderable } from '@opentui/core';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { exec } from './exec';
import {
  detailsMessage,
  footerSegments,
  pipelineTone,
  responsiveFooterSegments,
  segmentsWidth,
  type Tone,
} from './format';
import { yesNo, type ReviewRequest } from './forge';
import { reference, traitsOf } from './forges';
import { automatedReview } from './automated-review-watch';
import { ForgeSessionRpc, HEARTBEAT, HOME, type EventData, type Output } from './rpc';
import { createStatusClient, samePlace, type Place } from './status-client';
import type { Snapshot } from './store';
import { feedbackTime, linkOptions, type InboxState } from './feedback-inbox';
import type { Repository } from './git';
import type { Lookup } from './store';

export default {
  id: 'pedropombeiro.forgekeeper',
  async setup(context) {
    const rpc = context.client.rpc(ForgeSessionRpc);
    const [feedback, setFeedback] = createSignal<InboxState>({ items: [], paused: false });
    const feedbackDirectory = () => currentPlace().directory;
    let feedbackRequest = 0;
    async function loadFeedback(directory = feedbackDirectory()) {
      const request = ++feedbackRequest;
      const state = (await rpc.feedback({}, { location: { directory } })) as InboxState;
      if (directory === feedbackDirectory() && request === feedbackRequest) setFeedback(state);
      return state;
    }

    const [version, setVersion] = createSignal(0);
    const client = createStatusClient({
      clientID: crypto.randomUUID(),
      // OpenCode types the results as `unknown`; the server returns what the
      // schemas in rpc.ts describe.
      watch: async (directory, input) =>
        (await rpc.watch(input, { location: { directory } })) as Output<'watch'>,
      refresh: async (directory, key) =>
        (await rpc.refresh({ key }, { location: { directory } })) as Output<'refresh'>,
      release: (directory, clientID) => rpc.release({ clientID }, { location: { directory } }),
      onChange: () => setVersion((value) => value + 1),
    });

    // The displayed session can live in a different worktree than the one the
    // TUI started in, so resolve the directory from the session first.
    const directoryFor = (sessionID?: string) =>
      (sessionID ? context.data.session.get(sessionID)?.location.directory : undefined) ??
      context.location?.directory ??
      context.data.location.default().directory;

    const placeFor = (sessionID?: string): Place => ({
      directory: directoryFor(sessionID),
      key: sessionID ?? HOME,
    });

    const currentPlace = () => {
      const route = context.ui.router.current();
      return placeFor(route.type === 'session' ? route.sessionID : undefined);
    };

    const snapshotOf = (place: Place): Snapshot => {
      version();
      return client.snapshot(place);
    };

    // `reviewStatus: false` on a directory's server turns its footer and
    // commands off. Each directory has its own options.
    const enabledFor = (directory: string) => {
      version();
      return client.enabled(directory);
    };

    const refresh = (place: Place) => client.refresh(place);
    const heartbeat = setInterval(() => {
      client.heartbeat();
      void loadFeedback().catch(() => {});
    }, HEARTBEAT);

    const color = (tone: Tone) => {
      const feedback = context.theme.text.feedback;
      if (tone === 'success') return feedback.success.base;
      if (tone === 'warning') return feedback.warning.base;
      if (tone === 'error') return feedback.error.base;
      return context.theme.text.muted;
    };

    function Footer(props: { sessionID?: string }) {
      const place = createMemo(() => placeFor(props.sessionID), undefined, { equals: samePlace });

      createEffect(() => {
        const current = place();
        client.show(current);
        onCleanup(() => client.hide(current));
      });

      // Keeps the checkout's branch watched, so a branch switch reaches the server.
      createEffect(() => {
        context.data.location.vcs.sync({ directory: place().directory }).catch(() => {});
      });

      const snapshot = createMemo(() => snapshotOf(place()));
      const fullWidth = createMemo(() =>
        enabledFor(place().directory) ? segmentsWidth(footerSegments(snapshot())) : 0,
      );
      const [availableWidth, setAvailableWidth] = createSignal(0);
      const segments = createMemo(() => responsiveFooterSegments(snapshot(), availableWidth()));

      return (
        <Show when={fullWidth() > 0}>
          <box
            flexDirection="row"
            width={fullWidth()}
            flexShrink={1}
            minWidth={0}
            height={1}
            overflow="hidden"
            onSizeChange={function (this: BoxRenderable) {
              const width = this.width;
              queueMicrotask(() => setAvailableWidth(width));
            }}
          >
            <For each={segments()}>
              {(segment, index) => (
                <>
                  <Show when={index() > 0}>
                    <text wrapMode="none" flexShrink={0} fg={context.theme.text.muted}>
                      {' · '}
                    </text>
                  </Show>
                  <Show
                    when={segment.url}
                    fallback={
                      // Segments without a link of their own open the status dialog,
                      // which has the full detail behind the abbreviated indicator.
                      <text
                        wrapMode="none"
                        flexShrink={0}
                        fg={color(segment.tone)}
                        onMouseUp={() => showStatus(place())}
                      >
                        {segment.text}
                      </text>
                    }
                  >
                    {(url: () => string) => (
                      <text
                        wrapMode="none"
                        flexShrink={0}
                        fg={color(segment.tone)}
                        onMouseUp={() => openUrl(url())}
                      >
                        <u>{segment.text}</u>
                      </text>
                    )}
                  </Show>
                </>
              )}
            </For>
          </box>
        </Show>
      );
    }

    const openUrl = (url: string) => {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      void exec(opener, [url], process.cwd()).then((result) => {
        if (result.code !== 0)
          context.ui.toast.show({ message: `Could not open ${url}`, variant: 'error' });
      });
    };

    const requestsFor = (place: Place): ReviewRequest[] => {
      const lookup = snapshotOf(place).lookup;
      return lookup?.kind === 'found' ? lookup.requests : [];
    };

    // Commands explain why nothing happens when the place's server has status off.
    const statusOff = (place: Place) => {
      if (enabledFor(place.directory)) return false;
      context.ui.toast.show({
        message: "PR/MR status is off in the plugin's options (reviewStatus: false)",
        variant: 'info',
      });
      return true;
    };

    function DetailField(props: { label: string; value: string; tone?: Tone; url?: string }) {
      const foreground = () => (props.tone ? color(props.tone) : context.theme.text.base);
      return (
        <text fg={context.theme.text.muted} onMouseUp={() => props.url && openUrl(props.url)}>
          {props.label}
          {': '}
          <span style={{ fg: foreground() }}>
            <Show when={props.url} fallback={<b>{props.value}</b>}>
              <u>
                <b>{props.value}</b>
              </u>
            </Show>
          </span>
        </text>
      );
    }

    function RequestDetails(props: { request: ReviewRequest; head?: string }) {
      const request = () => props.request;
      const traits = () => traitsOf(request());
      const review = () => automatedReview(request());
      return (
        <box gap={1} flexShrink={0}>
          <text fg={context.theme.text.base} onMouseUp={() => openUrl(request().url)}>
            <u>
              <b>
                {reference(request())} {request().title}
              </b>
            </u>
          </text>
          <box flexShrink={0}>
            <DetailField
              label="State"
              value={request().state}
              tone={request().state === 'merged' ? 'success' : undefined}
            />
            <DetailField
              label="Target"
              value={`${request().targetProject} → ${request().targetBranch}`}
            />
            <DetailField
              label={traits().ci.charAt(0).toUpperCase() + traits().ci.slice(1)}
              value={request().pipeline?.label ?? 'none'}
              tone={pipelineTone(request().pipeline)}
              url={request().pipeline?.url}
            />
            <DetailField
              label="Unresolved threads"
              value={`${request().unresolvedThreads}${request().threadsComplete ? '' : '+'}`}
              tone={
                request().unresolvedThreads || !request().threadsComplete ? 'warning' : undefined
              }
            />
            <DetailField
              label="Draft"
              value={yesNo(request().draft)}
              tone={request().draft ? 'warning' : undefined}
            />
            <DetailField
              label="Conflicts"
              value={request().conflictsKnown ? yesNo(request().conflicts) : 'unknown'}
              tone={request().conflicts ? 'error' : undefined}
            />
          </box>
          <box flexShrink={0}>
            <text fg={context.theme.text.base}>
              <b>Review and approval</b>
            </text>
            <For each={traits().details(request())}>
              {(line) => {
                const separator = line.indexOf(': ');
                return separator < 0 ? (
                  <text fg={context.theme.text.base}>{line}</text>
                ) : (
                  <DetailField label={line.slice(0, separator)} value={line.slice(separator + 2)} />
                );
              }}
            </For>
            <Show when={review()}>
              {(value: () => NonNullable<ReturnType<typeof automatedReview>>) => (
                <DetailField
                  label={`${value().name} review`}
                  value={value().label}
                  tone={value().state === 'running' ? 'warning' : undefined}
                />
              )}
            </Show>
            <Show when={request().awaitingReviewers.length}>
              <DetailField
                label="Awaiting review"
                value={request()
                  .awaitingReviewers.map((username) => `@${username}`)
                  .join(', ')}
              />
            </Show>
          </box>
          <Show when={!request().reviewersComplete}>
            <text fg={color('warning')}>Reviewer list is partial</text>
          </Show>
          <Show when={props.head && request().headSha && props.head !== request().headSha}>
            <text fg={color('warning')}>
              Local HEAD differs from the {traits().noun} head commit (unpushed or not fetched)
            </text>
          </Show>
        </box>
      );
    }

    function StatusDetails(props: { snapshot: Snapshot }) {
      const lookup = () => {
        const value = props.snapshot.lookup;
        return value?.kind === 'found' ? value : undefined;
      };
      return (
        <box gap={1} flexShrink={0}>
          <Show
            when={lookup()}
            fallback={
              <text fg={props.snapshot.error ? color('error') : context.theme.text.muted}>
                {detailsMessage(props.snapshot)}
              </text>
            }
          >
            {(found: () => Extract<Lookup, { kind: 'found' }>) => (
              <>
                <Show when={found().repository}>
                  {(repository: () => Repository) => (
                    <box flexShrink={0}>
                      <DetailField label="Repository" value={repository().source.path} />
                      <DetailField
                        label="Branch"
                        value={
                          repository().branch === repository().sourceBranch
                            ? repository().branch
                            : `${repository().branch} (pushes to ${repository().sourceBranch})`
                        }
                      />
                    </box>
                  )}
                </Show>
                <Show when={!found().repository && found().sessionTarget}>
                  <DetailField label="Session target" value={found().sessionTarget!} />
                </Show>
                <For each={found().failed ?? []}>
                  {(failure) => (
                    <text fg={color('warning')}>
                      <b>Unavailable</b>
                      {'\n'}
                      {failure.url}
                      {'\n'}
                      {failure.reason}
                    </text>
                  )}
                </For>
                <Show when={found().requests.length === 0}>
                  <text fg={context.theme.text.muted}>No PR/MR status available.</text>
                </Show>
                <For each={found().requests}>
                  {(request) => (
                    <RequestDetails request={request} head={found().repository?.head} />
                  )}
                </For>
                <Show when={props.snapshot.error}>
                  {(error: () => NonNullable<Snapshot['error']>) => (
                    <text fg={color('error')}>
                      <b>Last refresh failed at {new Date(error().at).toLocaleTimeString()}</b>
                      {'\n'}
                      {error().message}
                    </text>
                  )}
                </Show>
                <Show when={props.snapshot.fetchedAt !== undefined}>
                  <text fg={context.theme.text.muted}>
                    Last fetched: {new Date(props.snapshot.fetchedAt!).toLocaleTimeString()}
                  </text>
                </Show>
              </>
            )}
          </Show>
        </box>
      );
    }

    function StatusDialog(props: { place: Place }) {
      const [terminalHeight, setTerminalHeight] = createSignal(context.renderer.height);
      const onResize = () => setTerminalHeight(context.renderer.height);
      context.renderer.on('resize', onResize);
      onCleanup(() => context.renderer.off('resize', onResize));
      // Leave room for the dialog host, title, gaps, footer, and padding.
      // A maxHeight alone lets the scrollbox's content grow the dialog.
      const contentHeight = createMemo(() =>
        Math.max(1, Math.min(24, Math.floor(terminalHeight() * 0.6) - 5)),
      );
      const snapshot = createMemo(() => snapshotOf(props.place));
      const reload = () => {
        if (!snapshot().loading) void refresh(props.place);
      };
      const [activeAction, setActiveAction] = createSignal<'refresh' | 'close'>('refresh');
      const moveAction = () =>
        setActiveAction((action) =>
          action === 'refresh' || snapshot().loading ? 'close' : 'refresh',
        );
      const close = () => context.ui.dialog.clear();

      context.keymap.layer(() => ({
        mode: 'modal',
        commands: [
          {
            id: 'forge.review.status.refresh',
            bind: 'ctrl+r',
            enabled: () => !snapshot().loading,
            run: reload,
          },
          { bind: 'tab', title: 'Next dialog action', run: moveAction },
          { bind: 'shift+tab', title: 'Previous dialog action', run: moveAction },
          { bind: 'left', title: 'Previous dialog action', run: moveAction },
          { bind: 'right', title: 'Next dialog action', run: moveAction },
          {
            bind: 'return',
            title: 'Activate dialog action',
            run: () => {
              if (activeAction() === 'refresh') reload();
              else close();
            },
          },
        ],
      }));

      return (
        <box
          height={contentHeight() + 5}
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          gap={1}
        >
          <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
            <text fg={context.theme.text.base}>
              <b>PR/MR status</b>
            </text>
            <text fg={context.theme.text.muted} onMouseUp={close}>
              esc
            </text>
          </box>
          <scrollbox
            height={contentHeight()}
            minHeight={1}
            flexShrink={0}
            scrollX={false}
            contentOptions={{ flexShrink: 0 }}
          >
            <StatusDetails snapshot={snapshot()} />
          </scrollbox>
          <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
            <For each={['close', 'refresh'] as const}>
              {(action) => {
                const disabled = () => action === 'refresh' && snapshot().loading;
                const active = () => activeAction() === action && !disabled();
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                    backgroundColor={
                      active() ? context.theme.background.action.primary.focused : undefined
                    }
                    onMouseMove={() => {
                      if (!disabled()) setActiveAction(action);
                    }}
                    onMouseUp={() => {
                      if (disabled()) return;
                      setActiveAction(action);
                      if (action === 'refresh') reload();
                      else close();
                    }}
                  >
                    <text
                      wrapMode="none"
                      fg={
                        disabled()
                          ? context.theme.text.action.primary.disabled
                          : active()
                            ? context.theme.text.action.primary.focused
                            : context.theme.text.muted
                      }
                    >
                      {action === 'close'
                        ? 'Close'
                        : snapshot().loading
                          ? 'Refreshing…'
                          : 'Refresh'}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        </box>
      );
    }

    function showStatus(place = currentPlace()) {
      if (statusOff(place)) return;
      void refresh(place);
      context.ui.dialog.set({ size: 'large', centered: true });
      context.ui.dialog.show(() => <StatusDialog place={place} />);
    }

    async function showFeedback() {
      const directory = feedbackDirectory();
      const state = await loadFeedback(directory);
      const selected = await context.ui.dialog.select({
        title: `Review feedback and PR/MR updates${state.paused ? ' (monitoring paused)' : ''}`,
        options: state.items.map((item) => ({
          title: item.title,
          // A lifecycle event's first fact, such as a retarget, shows too.
          description: [
            context.data.session.get(item.sessionID)?.title ?? item.sessionID,
            feedbackTime(item),
            ...(item.details?.length
              ? [
                  `${item.details[0]}${item.details.length > 1 ? ` (+${item.details.length - 1})` : ''}`,
                ]
              : []),
          ].join(' · '),
          value: item.id,
        })),
        actions: [
          {
            bind: 'ctrl+d',
            title: 'Acknowledge',
            onTrigger: async (id) => {
              await rpc.acknowledgeFeedback({ id }, { location: { directory } });
              context.ui.dialog.clear();
              void showFeedback();
            },
          },
          {
            bind: 'ctrl+r',
            title: 'Summarize in session',
            onTrigger: async (id) => {
              context.ui.dialog.clear();
              try {
                await rpc.summarizeFeedback({ id }, { location: { directory } });
                context.ui.toast.show({
                  message: 'Summarizing the update in its session, without tools.',
                  variant: 'info',
                });
              } catch (error) {
                context.ui.toast.show({
                  message: `Could not summarize: ${error instanceof Error ? error.message : String(error)}`,
                  variant: 'error',
                });
              }
            },
          },
          {
            bind: 'ctrl+s',
            title: state.paused ? 'Resume monitoring' : 'Pause monitoring',
            selection: 'none',
            onTrigger: async () => {
              await rpc.pauseFeedback({ paused: !state.paused }, { location: { directory } });
              context.ui.dialog.clear();
              void showFeedback();
            },
          },
        ],
      });
      const item = state.items.find((entry) => entry.id === selected);
      if (!item) return;
      const link = await context.ui.dialog.select({
        title: item.title,
        options: linkOptions(item),
      });
      if (link) openUrl(link);
    }

    async function openRequest() {
      const place = currentPlace();
      if (statusOff(place)) return;
      let requests = requestsFor(place);
      if (requests.length === 0) {
        await refresh(place);
        requests = requestsFor(place);
      }
      if (requests.length === 0) {
        context.ui.toast.show({ message: 'No PR/MR for this session or branch', variant: 'info' });
        return;
      }
      if (requests.length === 1) return openUrl(requests[0].url);
      const url = await context.ui.dialog.select({
        title: 'Open PR/MR',
        actions: [
          {
            bind: 'ctrl+w',
            title: 'Close',
            side: 'right',
            selection: 'none',
            onTrigger: () => context.ui.dialog.clear(),
          },
        ],
        options: requests.map((mr) => ({
          title: `${reference(mr)} ${mr.title}`,
          value: mr.url,
          description: mr.targetProject,
        })),
      });
      if (url) openUrl(url);
    }

    context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => <Footer sessionID={input.sessionID} />,
    });

    context.ui.slot({
      append: 'app',
      render: () => {
        createEffect(() => {
          const directory = feedbackDirectory();
          setFeedback({ items: [], paused: false });
          void loadFeedback(directory).catch(() => {});
        });
        context.keymap.layer(() => ({
          mode: 'global',
          commands: [
            {
              id: 'forge.review.feedback',
              title: 'Show pending review feedback',
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-feedback' },
              run: () => showFeedback(),
            },
            {
              id: 'forge.review.status',
              title: 'Show PR/MR status',
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-status', aliases: ['mr-status', 'pr-status'] },
              run: () => showStatus(),
            },
            {
              id: 'forge.review.open',
              title: 'Open PR/MR in browser',
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-open', aliases: ['mr-open', 'pr-open'] },
              run: openRequest,
            },
          ],
        }));
        return null;
      },
    });

    context.ui.slot({
      append: 'home.footer.status',
      render: () => (
        <Show when={feedback().items.length > 0 || feedback().paused}>
          <text fg={context.theme.text.muted} onMouseUp={() => void showFeedback()}>
            {feedback().items.length} review updates{feedback().paused ? ' (paused)' : ''}
          </text>
        </Show>
      ),
    });
    context.ui.slot({
      append: 'prompt.footer.status',
      render: () => (
        <Show when={feedback().items.length > 0 || feedback().paused}>
          <text fg={context.theme.text.muted} onMouseUp={() => void showFeedback()}>
            {feedback().items.length} review updates{feedback().paused ? ' (paused)' : ''}
          </text>
        </Show>
      ),
    });

    const stops = [
      rpc.events.on('feedbackChanged', (event) => {
        const { directory } = event.data as EventData<'feedbackChanged'>;
        if (directory === feedbackDirectory()) void loadFeedback(directory).catch(() => {});
      }),
      rpc.events.on('status', (event) => {
        const { directory, key, snapshot } = event.data as EventData<'status'>;
        client.receive(directory, key, snapshot);
      }),
      // Notices about a session go to the CLIs that have shown it.
      rpc.events.on('notice', (event) => {
        const notice = event.data as EventData<'notice'>;
        if (
          notice.sessionID &&
          !client.hasShown(notice.sessionID) &&
          event.location?.directory !== feedbackDirectory()
        )
          return;
        context.ui.toast.show({
          ...(notice.title ? { title: notice.title } : {}),
          message: notice.message,
          variant: notice.variant,
        });
      }),
    ];

    return () => {
      clearInterval(heartbeat);
      for (const stop of stops) stop();
      client.dispose();
    };
  },
} satisfies Plugin.Definition;
