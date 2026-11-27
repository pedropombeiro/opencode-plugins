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
  Slot,
  Style,
  type ComposerPillView,
  type MountedSession,
  type PanelTab,
  type SessionRef,
} from '@opencode/plugin/gui';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { automatedReview } from './automated-review-watch';
import {
  clientID,
  createFeedbackLoader,
  createLiveStatus,
  loadFeedback,
  type ForgeRpcClient,
} from './client-core';
import {
  canActOnFeedback,
  feedbackFooter,
  feedbackTime,
  linkOptions,
  sessionItems,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import { yesNo, type ForgeKind, type ReviewRequest } from './forge';
import { forgeScope, reference, requestNoun, requestPlural, traitsOf } from './forges';
import { detailsMessage, pipelineTone, type Tone } from './format';
import { statusPill } from './gui-status';
import { mapLimit } from './limit';
import { showNotice } from './notice';
import { ForgeSessionRpc, type CleanupProgress, type EventData } from './rpc';
import {
  cleanupReadyOf,
  formatCleanupFailures,
  formatCleanupProgress,
  formatCleanupSubtitle,
  worktreeLabel,
  type CleanupCandidate,
  type CleanupProgressEvent,
  type CleanupResult,
  type CleanupScanResult,
} from './session-cleanup';
import type { Place } from './status-client';
import type { Repository } from './git';
import { snapshotForge, type Lookup, type Snapshot } from './store';

const CSS = `
.forgekeeper-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; overflow-y: auto; height: 100%; font-size: 13px; line-height: 1.5; color: var(--v2-text-text-base); }
.forgekeeper-panel header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.forgekeeper-panel h2 { font-size: 13px; font-weight: 600; margin: 0; }
.forgekeeper-panel section { display: flex; flex-direction: column; gap: 2px; }
.forgekeeper-panel .fk-card { border: 1px solid var(--v2-border-border-muted); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.forgekeeper-panel .fk-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.forgekeeper-panel .fk-muted, .fk-cleanup-dialog .fk-muted { color: var(--v2-text-text-muted); }
.forgekeeper-panel .fk-label, .fk-cleanup-dialog .fk-label { color: var(--v2-text-text-muted); }
.forgekeeper-panel .fk-success, .fk-cleanup-dialog .fk-success { color: var(--v2-state-fg-success); }
.forgekeeper-panel .fk-warning, .fk-cleanup-dialog .fk-warning { color: var(--v2-state-fg-warning); }
.forgekeeper-panel .fk-error, .fk-cleanup-dialog .fk-error { color: var(--v2-state-fg-danger); }
.forgekeeper-panel a { color: var(--v2-text-text-accent); cursor: pointer; text-decoration: underline; }
.forgekeeper-panel .fk-pre { white-space: pre-wrap; }
.fk-cleanup-dialog { display: flex; flex-direction: column; gap: 10px; font-size: 13px; color: var(--v2-text-text-base); }
.fk-cleanup-list { display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow-y: auto; }
.fk-cleanup-group { font-size: 11px; font-weight: 600; color: var(--v2-text-text-muted); padding: 6px 4px 2px; }
.fk-cleanup-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 4px; border-top: 1px solid var(--v2-border-border-muted); }
.fk-cleanup-row:first-child { border-top: none; }
.fk-cleanup-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.fk-cleanup-title { cursor: pointer; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fk-cleanup-title:hover { text-decoration: underline; }
.fk-cleanup-meta { font-size: 12px; color: var(--v2-text-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fk-cleanup-footer { display: flex; align-items: center; gap: 8px; }
`;

const STATUS_TAB = 'status';
const FEEDBACK_TAB = 'feedback';
const EMPTY: InboxState = { items: [], paused: false };
let nextGuiScanSeq = 0;
const nextGuiScanID = () => `gui-cleanup-${Date.now()}-${++nextGuiScanSeq}`;

function toneClass(tone?: Tone): string | undefined {
  switch (tone) {
    case 'success':
      return 'fk-success';
    case 'warning':
      return 'fk-warning';
    case 'error':
      return 'fk-error';
    case 'muted':
      return 'fk-muted';
    default:
      return undefined;
  }
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS);
    const rpc = () =>
      ctx.client.rpc(ForgeSessionRpc) as unknown as ForgeRpcClient &
        Record<string, (input: object, options: object) => Promise<unknown>>;
    const at = (directory: string) => ({ location: { directory } });

    const [version, setVersion] = createSignal(0);
    const [inboxes, setInboxes] = createStore<Record<string, InboxState>>({});
    const [inboxErrors, setInboxErrors] = createStore<Record<string, string | undefined>>({});
    const feedback = createFeedbackLoader({
      load: (directory) => loadFeedback(rpc(), directory),
      changed: (directory, state) => {
        setInboxes(directory, state);
        setInboxErrors(directory, undefined);
      },
      failed: (directory, error) => setInboxErrors(directory, error),
    });
    const reload = feedback.reload;
    const connection = createLiveStatus({
      clientID: clientID(),
      onChange: () => setVersion((value) => value + 1),
      heartbeat: () => void feedback.refresh(),
    });
    const client = () => connection.client;

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
      return client()?.snapshot(place) ?? { loading: false };
    };
    const enabledFor = (directory: string) => {
      version();
      return client()?.enabled(directory) ?? true;
    };
    const forgeFor = (directory: string): ForgeKind | undefined => {
      version();
      return client()?.forge(directory);
    };
    const sessionForge = (place: Place): ForgeKind | undefined =>
      snapshotForge(snapshotOf(place), forgeFor(place.directory));
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
        connection.show(place);
        void reload(directory);
        onCleanup(() => connection.hide(place));
      },
    );

    const open = (tab: string, session = current()) => {
      if (session) ctx.layout.open(`${ctx.id}:${tab}`, session, { tab: 'select' });
    };

    // Commands explain why nothing happens when the checkout has status off.
    const statusOff = (directory: string, forge = forgeFor(directory)) => {
      if (enabledFor(directory)) return false;
      ctx.toast.show({
        title: `${requestNoun(forge)} status is off in the plugin's options (status: false)`,
      });
      return true;
    };

    const builtinServer = () =>
      ctx.servers
        .list()
        .map((id) => ctx.servers.get(id))
        .find((server) => server?.builtin);

    function closeCleanedTabs(sessionIDs: readonly string[]) {
      if (!sessionIDs.length) return;
      const ids = new Set(sessionIDs);
      for (const tab of ctx.tabs.list()) {
        if (tab.session && ownServer(tab.session) && ids.has(tab.session.id)) {
          ctx.tabs.close(tab.key);
        }
      }
    }

    async function runSessionCleanup(
      directory: string,
      sessionIDs: string[],
      scanID?: string,
      onProgress?: (progress: CleanupProgressEvent) => void,
    ): Promise<CleanupResult | undefined> {
      try {
        const archived: string[] = [];
        const alreadyArchived: string[] = [];
        const failed: CleanupResult['failed'][number][] = [];
        for (let i = 0; i < sessionIDs.length; i += 500) {
          const chunk = sessionIDs.slice(i, i + 500);
          const part = (await rpc().cleanupSessions(
            { sessionIDs: chunk, ...(scanID ? { scanID } : {}), allowClientArchive: true },
            at(directory),
          )) as CleanupResult;
          archived.push(...part.archived);
          alreadyArchived.push(...part.alreadyArchived);
          failed.push(...part.failed);
          const pendingClientArchive = part.needsClientArchive ?? [];
          if (pendingClientArchive.length > 0) {
            let checked = 0;
            const total = pendingClientArchive.length;
            onProgress?.({ phase: 'archiving', checked: 0, total });
            const clientArchived: string[] = [];
            await mapLimit(pendingClientArchive, 8, async (sessionID) => {
              try {
                await ctx.client.session.update({ sessionID, archived: true });
                clientArchived.push(sessionID);
              } catch (error) {
                failed.push({
                  sessionID,
                  reason: error instanceof Error ? error.message : String(error),
                });
              } finally {
                checked++;
                onProgress?.({ phase: 'archiving', checked, total });
              }
            });
            if (clientArchived.length > 0) {
              const finalized = (await rpc().cleanupSessions(
                {
                  sessionIDs: clientArchived,
                  ...(scanID ? { scanID } : {}),
                  finalizeArchived: true,
                },
                at(directory),
              )) as CleanupResult;
              archived.push(...finalized.archived);
              alreadyArchived.push(...finalized.alreadyArchived);
              failed.push(...finalized.failed);
            }
          }
        }
        const result: CleanupResult = { archived, alreadyArchived, failed };
        closeCleanedTabs([...result.archived, ...result.alreadyArchived]);
        if (result.archived.length > 0) {
          const count = result.archived.length;
          ctx.toast.show({
            title:
              count === 1
                ? 'Archived 1 session and closed its tab.'
                : `Archived ${count} sessions and closed their tabs.`,
          });
        } else if (result.alreadyArchived.length > 0 && result.failed.length === 0) {
          const count = result.alreadyArchived.length;
          ctx.toast.show({
            title:
              count === 1
                ? 'Session was already archived.'
                : `${count} sessions were already archived.`,
          });
        }
        if (result.failed.length > 0) {
          ctx.toast.show({
            title: formatCleanupFailures(result.failed),
            variant: 'error',
          });
        }
        return result;
      } catch (error) {
        ctx.toast.show({
          title: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
        return undefined;
      }
    }

    const resolveCleanupDirectory = (directory?: string) =>
      directory ??
      (current() ? directoryOf(current()!) : undefined) ??
      ctx.tabs
        .list()
        .find((tab) => tab.session && ownServer(tab.session) && tab.session.location?.directory)
        ?.session?.location?.directory;

    function openCleanup(directory?: string) {
      const targetDir = resolveCleanupDirectory(directory);
      if (!targetDir) {
        ctx.toast.show({ title: 'Open a project session to run /forge-cleanup.' });
        return;
      }
      if (statusOff(targetDir)) return;
      ctx.dialogs.open((dialog) => <CleanupDialog directory={targetDir} close={dialog.close} />);
    }

    ctx.add(ComposerPill, {
      id: 'status',
      show: (input) => pill(input.session),
    });
    function pill(session: MountedSession): ComposerPillView | undefined {
      if (!ownServer(session)) return undefined;
      const place = placeOf(session);
      if (!enabledFor(place.directory)) return undefined;
      const updates = feedbackFooter(inboxOf(place.directory), session.id);
      return statusPill(
        snapshotOf(place),
        updates,
        {
          external: (url) => ctx.system.openExternal(url),
          status: () => open(STATUS_TAB, session),
          feedback: () => open(FEEDBACK_TAB, session),
          cleanup: () => openCleanup(place.directory),
        },
        forgeFor(place.directory),
      );
    }

    const ui = ctx.ui;

    ctx.add(Slot, {
      at: 'session.header',
      render: (input) => {
        const ready = () => {
          if (!ownServer(input.session)) return undefined;
          const place = placeOf(input.session);
          if (!enabledFor(place.directory)) return undefined;
          return cleanupReadyOf(snapshotOf(place));
        };
        return (
          <Show when={ready()}>
            {(value: () => NonNullable<ReturnType<typeof ready>>) => (
              <ui.Button
                size="small"
                variant="ghost"
                icon="archive"
                onClick={() => openCleanup(directoryOf(input.session))}
              >
                {input.compact ? 'Clean up' : `${value().reason} · /forge-cleanup`}
              </ui.Button>
            )}
          </Show>
        );
      },
    });

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
      const forge = createMemo(() => snapshotForge(snapshot(), forgeFor(place().directory)));
      const noun = createMemo(() => requestNoun(forge()));
      const ready = createMemo(() => cleanupReadyOf(snapshot()));
      const [cleaning, setCleaning] = createSignal(false);
      const found = () => {
        const lookup = snapshot().lookup;
        return lookup?.kind === 'found'
          ? (lookup as Extract<Lookup, { kind: 'found' }>)
          : undefined;
      };
      return (
        <div class="forgekeeper-panel">
          <header>
            <h2>{noun()} status</h2>
            <div class="fk-actions">
              <Show when={ready()}>
                <ui.Button
                  size="small"
                  icon="archive"
                  busy={cleaning()}
                  onClick={async () => {
                    if (cleaning()) return;
                    setCleaning(true);
                    try {
                      await runSessionCleanup(place().directory, [props.session.id]);
                    } finally {
                      setCleaning(false);
                    }
                  }}
                >
                  Clean up session
                </ui.Button>
              </Show>
              <ui.Button
                size="small"
                icon="refresh"
                busy={snapshot().loading}
                onClick={() => void client()?.refresh(place())}
              >
                Refresh
              </ui.Button>
            </div>
          </header>
          <Show when={enabledFor(place().directory)} fallback={<div>{noun()} status is off.</div>}>
            <Show when={ready()}>
              {(value: () => NonNullable<ReturnType<typeof ready>>) => (
                <div class="fk-success">
                  <b>✓ {value().reason}</b> — ready to archive with /forge-cleanup.
                </div>
              )}
            </Show>
            <Show
              when={found()}
              fallback={
                <div class={`fk-pre ${snapshot().error ? 'fk-error' : 'fk-muted'}`}>
                  {detailsMessage(snapshot(), forgeFor(place().directory))}
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
                    <div class="fk-muted">No {noun()} status available.</div>
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
        await rpc()[method](input, at(directory));
        await reload(directory);
      } catch (error) {
        ctx.toast.show({
          title: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
      }
    }

    function FeedbackItemView(props: { item: FeedbackItem; directory: string }) {
      const item = () => props.item;
      const facts = () =>
        [
          item().read ? 'Read' : 'Unread',
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
            <ui.Button size="small" onClick={() => void run('summarizeFeedback')}>
              Summarize in session
            </ui.Button>
            <Show when={canActOnFeedback(item())}>
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
            </Show>
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
      const items = createMemo(() => sessionItems(state(), props.session.id));
      return (
        <div class="forgekeeper-panel">
          <header>
            <h2>Review updates{state().paused ? ' (monitoring paused)' : ''}</h2>
            <ui.Button
              size="small"
              disabled={!items().some((item) => !item.read)}
              onClick={() =>
                void inboxAction(directory(), 'markFeedbackRead', {
                  ids: items().map((item) => item.id),
                })
              }
            >
              Mark all as read
            </ui.Button>
            <ui.Button
              size="small"
              onClick={() =>
                void inboxAction(directory(), 'pauseFeedback', { paused: !state().paused })
              }
            >
              {state().paused ? 'Enable feedback inbox' : 'Pause monitoring'}
            </ui.Button>
          </header>
          <Show when={inboxErrors[directory()]}>
            {(error: () => string) => (
              <div class="fk-error">
                Could not load review updates: {error()}. Retrying automatically.
              </div>
            )}
          </Show>
          <Show
            when={items().length}
            fallback={
              <Show when={!inboxErrors[directory()]}>
                <div class="fk-muted">
                  {inboxes[directory()]
                    ? 'No pending review updates for this session.'
                    : 'Loading review updates…'}
                </div>
              </Show>
            }
          >
            <For each={items()}>
              {(item) => <FeedbackItemView item={item} directory={directory()} />}
            </For>
          </Show>
        </div>
      );
    }

    function CleanupDialog(props: { directory: string; close: () => void }) {
      const [loading, setLoading] = createSignal(true);
      const [cleaningID, setCleaningID] = createSignal<string | undefined>();
      const [error, setError] = createSignal<string | undefined>();
      const [progress, setProgress] = createSignal<CleanupProgressEvent | undefined>();
      const [scan, setScan] = createSignal<CleanupScanResult>({
        enabled: true,
        candidates: [],
        skippedErrors: 0,
      });

      let activeScanID = '';
      let loadController: AbortController | undefined;
      const offProgress = rpc().events.on('cleanupProgress', (event) => {
        const data = event.data as CleanupProgress;
        if (data.scanID === activeScanID) setProgress(data);
      });
      onCleanup(() => {
        loadController?.abort();
        offProgress();
      });

      const load = async () => {
        loadController?.abort();
        const controller = new AbortController();
        loadController = controller;
        const scanID = nextGuiScanID();
        activeScanID = scanID;
        setProgress(undefined);
        setLoading(true);
        setError(undefined);
        try {
          const result = (await rpc().cleanupCandidates(
            { scanID },
            { ...at(props.directory), signal: controller.signal },
          )) as CleanupScanResult;
          if (!controller.signal.aborted) setScan(result);
        } catch (err) {
          if (!controller.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (loadController === controller) setLoading(false);
        }
      };
      void load();

      const candidates = () => scan().candidates;
      const openTabIDs = createMemo(
        () =>
          new Set(
            ctx.tabs
              .list()
              .flatMap((tab) => (tab.session && ownServer(tab.session) ? [tab.session.id] : [])),
          ),
      );
      const groups = createMemo(() => {
        const list = candidates();
        const dirs = [...new Set(list.map((candidate) => candidate.directory))];
        const multi = dirs.length > 1;
        return dirs.map((directory) => ({
          directory,
          label: multi ? worktreeLabel(directory) : undefined,
          items: list.filter((candidate) => candidate.directory === directory),
        }));
      });

      const clean = async (ids: string[], key: string) => {
        if (cleaningID()) return;
        const scanID = nextGuiScanID();
        activeScanID = scanID;
        setProgress(undefined);
        setCleaningID(key);
        try {
          const result = await runSessionCleanup(props.directory, ids, scanID, setProgress);
          const doneIDs = [...(result?.archived ?? []), ...(result?.alreadyArchived ?? [])];
          if (doneIDs.length) {
            const archivedSet = new Set(doneIDs);
            const remaining = candidates().filter(
              (candidate) => !archivedSet.has(candidate.sessionID),
            );
            setScan((prev) => ({ ...prev, candidates: remaining }));
            if (remaining.length === 0) props.close();
          }
        } finally {
          setCleaningID(undefined);
          setProgress(undefined);
        }
      };

      const forge = createMemo(() => forgeFor(props.directory));
      const noun = createMemo(() => requestNoun(forge()));
      const plural = createMemo(() => requestPlural(forge()));

      const fallbackMessage = () => {
        if (loading()) return formatCleanupProgress(progress(), 'scan', forge());
        if (scan().enabled) {
          return `No sessions with all ${plural()} merged or tracked issues closed.`;
        }
        return `${noun()} status is off. Enable options.status in opencode.json to use this command.`;
      };

      const renderRow = (candidate: CleanupCandidate) => {
        const meta = () => {
          const parts = [formatCleanupSubtitle(candidate)];
          if (openTabIDs().has(candidate.sessionID)) parts.push('open tab');
          return parts.join(' · ');
        };
        return (
          <div class="fk-cleanup-row">
            <div class="fk-cleanup-main">
              <div
                class="fk-cleanup-title"
                onClick={() => {
                  const server = builtinServer()?.id;
                  if (!server) return;
                  props.close();
                  ctx.tabs.open({ server, id: candidate.sessionID }, { focus: true });
                }}
              >
                {candidate.title}
              </div>
              <div class="fk-cleanup-meta">{meta()}</div>
            </div>
            <ui.Button
              size="small"
              icon="archive"
              busy={cleaningID() === candidate.sessionID}
              disabled={loading() || cleaningID() !== undefined}
              onClick={() => void clean([candidate.sessionID], candidate.sessionID)}
            >
              Clean up
            </ui.Button>
          </div>
        );
      };

      return (
        <ui.Dialog
          title="Clean up finished sessions"
          description={`Archive idle sessions whose ${plural()} have merged or tracked issues have closed, and close their open tabs.`}
          size="large"
          footer={
            <div class="fk-cleanup-footer">
              <ui.Button
                size="small"
                icon="refresh"
                busy={loading()}
                disabled={cleaningID() !== undefined}
                onClick={() => void load()}
              >
                Refresh
              </ui.Button>
              <Show when={candidates().length > 0}>
                <ui.Button
                  size="small"
                  variant="contrast"
                  icon="archive"
                  busy={cleaningID() === 'all'}
                  disabled={loading() || cleaningID() !== undefined}
                  onClick={() =>
                    void clean(
                      candidates().map((candidate) => candidate.sessionID),
                      'all',
                    )
                  }
                >
                  {`Clean up all (${candidates().length})`}
                </ui.Button>
              </Show>
            </div>
          }
        >
          <div class="fk-cleanup-dialog">
            <Show when={error()}>
              {(message: () => string) => <div class="fk-error">{message()}</div>}
            </Show>
            <Show when={scan().skippedErrors > 0}>
              <div class="fk-warning">
                {`Skipped ${scan().skippedErrors} session${scan().skippedErrors === 1 ? '' : 's'} whose target status could not be verified.`}
              </div>
            </Show>
            <Show when={cleaningID() !== undefined && progress()}>
              <div class="fk-muted">{formatCleanupProgress(progress(), 'cleanup', forge())}</div>
            </Show>
            <Show
              when={!loading() && candidates().length > 0}
              fallback={
                <Show when={!error()}>
                  <div class="fk-muted">{fallbackMessage()}</div>
                </Show>
              }
            >
              <div class="fk-cleanup-list">
                <For each={groups()}>
                  {(group) => (
                    <>
                      <Show when={group.label}>
                        {(label: () => string) => <div class="fk-cleanup-group">{label()}</div>}
                      </Show>
                      <For each={group.items}>{(candidate) => renderRow(candidate)}</For>
                    </>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </ui.Dialog>
      );
    }

    const tab = (id: string, title: string): PanelTab => ({ id, title, closable: 'hover' });
    const statusTabs = {
      github: tab(STATUS_TAB, 'PR status'),
      gitlab: tab(STATUS_TAB, 'MR status'),
      mixed: tab(STATUS_TAB, 'PR/MR status'),
    };
    const statusTabFor = (session: MountedSession): PanelTab => {
      if (!ownServer(session)) return statusTabs.mixed;
      const forge = sessionForge(placeOf(session));
      return forge ? statusTabs[forge] : statusTabs.mixed;
    };
    const feedbackTab = tab(FEEDBACK_TAB, 'Review updates');
    ctx.add(Panel, {
      id: STATUS_TAB,
      region: 'side',
      width: 420,
      list: (input) => (input.open.includes(STATUS_TAB) ? [statusTabFor(input.session)] : []),
      render: (props) => <StatusView session={props.session} />,
    });
    ctx.add(Panel, {
      id: FEEDBACK_TAB,
      region: 'side',
      width: 420,
      list: (input) => (input.open.includes(FEEDBACK_TAB) ? [feedbackTab] : []),
      render: (props) => <FeedbackView session={props.session} />,
    });

    const currentForge = () => {
      const session = current();
      return session ? sessionForge(placeOf(session)) : undefined;
    };

    ctx.add(Command, (): Command => ({
      id: 'status',
      title: `Show ${requestNoun(currentForge())} status`,
      keywords: 'PR MR pull request merge request',
      group: 'Forge',
      slash: { name: 'forge-status' },
      enabled: !!current(),
      run: () => {
        const session = current();
        if (!session) return;
        const place = placeOf(session);
        if (statusOff(place.directory, sessionForge(place))) return;
        void client()?.refresh(place);
        open(STATUS_TAB, session);
      },
    }));
    ctx.add(Command, (): Command => ({
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
    }));
    ctx.add(Command, (): Command => ({
      id: 'open',
      title: `Open ${requestNoun(currentForge())} in browser`,
      keywords: 'PR MR pull request merge request',
      group: 'Forge',
      slash: { name: 'forge-open' },
      enabled: !!current(),
      run: async () => {
        const session = current();
        if (!session) return;
        const place = placeOf(session);
        if (statusOff(place.directory, sessionForge(place))) return;
        let requests = requestsOf(place);
        if (requests.length === 0) {
          await client()?.refresh(place);
          requests = requestsOf(place);
        }
        if (requests.length === 0) {
          ctx.toast.show({ title: `No ${requestNoun(sessionForge(place))} for this session` });
          return;
        }
        const forge = forgeScope(requests.map((request) => request.forge));
        const url =
          requests.length === 1
            ? requests[0].url
            : await ctx.dialogs.select({
                title: `Open ${requestNoun(forge)}`,
                options: requests.map((request) => ({
                  title: `${reference(request)} ${request.title}`,
                  description: request.targetProject,
                  value: request.url,
                })),
              });
        if (url) ctx.system.openExternal(url);
      },
    }));
    ctx.add(Command, (): Command => ({
      id: 'cleanup',
      title: 'Clean up finished sessions',
      group: 'Forge',
      slash: { name: 'forge-cleanup' },
      enabled: !!builtinServer() && !!resolveCleanupDirectory(),
      run: () => openCleanup(),
    }));

    createKeyed(
      () => ctx.client,
      () => {
        const currentRpc = rpc();
        feedback.invalidate();
        connection.connect(currentRpc);
        void feedback.refresh();
        const stops = [
          currentRpc.events.on('sessionsCleanedUp', (event) => {
            const { sessionIDs, archive } = event.data as EventData<'sessionsCleanedUp'>;
            closeCleanedTabs(sessionIDs);
            if (archive) {
              for (const sessionID of sessionIDs) {
                void ctx.client.session.update({ sessionID, archived: true }).catch(() => {});
              }
            }
          }),
          currentRpc.events.on('feedbackChanged', (event) => {
            const { directory } = event.data as EventData<'feedbackChanged'>;
            if (feedback.has(directory)) void reload(directory);
          }),
          currentRpc.events.on('notice', (event) => {
            const notice = event.data as EventData<'notice'>;
            showNotice(notice, {
              hasShown: (sessionID) =>
                !!client()?.hasShown(sessionID) ||
                (!!event.location?.directory && feedback.has(event.location.directory)),
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
        onCleanup(() => {
          for (const stop of stops) stop();
          feedback.invalidate();
          connection.dispose();
        });
      },
    );

    return () => {
      feedback.invalidate();
      connection.dispose();
    };
  },
});
