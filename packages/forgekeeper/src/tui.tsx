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
import { yesNo, type ForgeKind, type ReviewRequest } from './forge';
import {
  forgeScope,
  parseReference,
  reference,
  requestNoun,
  requestPlural,
  traitsOf,
} from './forges';
import { automatedReview } from './automated-review-watch';
import { mapLimit } from './limit';
import { showNotice } from './notice';
import { clientID, connectStatus, loadFeedback as fetchFeedback } from './client-core';
import { ForgeSessionRpc, HOME, type CleanupProgress, type EventData } from './rpc';
import {
  cleanupReadyOf,
  formatCleanupFailures,
  formatCleanupProgress,
  formatCleanupSubtitle,
  worktreeLabel,
  type CleanupProgressEvent,
  type CleanupResult,
  type CleanupScanResult,
} from './session-cleanup';
import { samePlace, type Place } from './status-client';
import { snapshotForge, type Lookup, type Snapshot } from './store';
import {
  canActOnFeedback,
  feedbackFooter,
  feedbackTime,
  linkOptions,
  listAllowsAct,
  sessionItems,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import type { Repository } from './git';

type StatusDialogAction = 'close' | 'cleanup' | 'refresh';

function branchLabel(repository: Repository): string {
  if (repository.branch === repository.sourceBranch) return repository.branch;
  return `${repository.branch} (pushes to ${repository.sourceBranch})`;
}

function statusActionLabel(action: StatusDialogAction, loading: boolean): string {
  switch (action) {
    case 'close':
      return 'Close';
    case 'cleanup':
      return 'Clean up session';
    case 'refresh':
      return loading ? 'Refreshing…' : 'Refresh';
  }
}

function feedbackItemDescription(item: FeedbackItem): string {
  const parts = [item.read ? 'Read' : 'Unread', feedbackTime(item)];
  if (item.automation) {
    const reason = item.automation.reason ? `: ${item.automation.reason}` : '';
    parts.push(`${item.automation.state}${reason}`);
  }
  if (item.details?.length) {
    const extra = item.details.length > 1 ? ` (+${item.details.length - 1})` : '';
    parts.push(`${item.details[0]}${extra}`);
  }
  return parts.join(' · ');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

let nextCleanupScanSeq = 0;
const nextScanID = () => `cleanup-${Date.now()}-${++nextCleanupScanSeq}`;

function emptyCleanupMessage(skippedErrors: number, forge?: ForgeKind): string {
  if (skippedErrors > 0) {
    return `No eligible sessions found (${skippedErrors} skipped due to lookup errors).`;
  }
  return `No sessions with all ${requestPlural(forge)} merged or tracked issues closed.`;
}

function cleanupDialogTitle(skippedErrors: number): string {
  if (skippedErrors > 0) return `Clean up finished sessions (${skippedErrors} skipped)`;
  return 'Clean up finished sessions';
}

export default {
  id: 'pedropombeiro.forgekeeper',
  async setup(context) {
    const rpc = context.client.rpc(ForgeSessionRpc);
    const [feedback, setFeedback] = createSignal<InboxState>({ items: [], paused: false });
    const feedbackDirectory = () => currentPlace().directory;
    let feedbackRequest = 0;
    async function loadFeedback(directory = feedbackDirectory()) {
      const request = ++feedbackRequest;
      const state = await fetchFeedback(rpc, directory);
      if (directory === feedbackDirectory() && request === feedbackRequest) setFeedback(state);
      return state;
    }

    const [version, setVersion] = createSignal(0);
    const connection = connectStatus(rpc, {
      clientID: clientID(),
      onChange: () => setVersion((value) => value + 1),
      heartbeat: () => void loadFeedback().catch(() => {}),
    });
    const client = connection.client;

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

    // `status: false` on a directory's server turns its footer and
    // commands off. Each directory has its own options.
    const enabledFor = (directory: string) => {
      version();
      return client.enabled(directory);
    };

    const forgeFor = (directory: string): ForgeKind | undefined => {
      version();
      return client.forge(directory);
    };

    const sessionForge = (place = currentPlace()): ForgeKind | undefined =>
      snapshotForge(snapshotOf(place), forgeFor(place.directory));

    const refresh = (place: Place) => client.refresh(place);

    const color = (tone: Tone) => {
      const feedback = context.theme.text.feedback;
      switch (tone) {
        case 'success':
          return feedback.success.base;
        case 'warning':
          return feedback.warning.base;
        case 'error':
          return feedback.error.base;
        default:
          return context.theme.text.muted;
      }
    };

    function Footer(props: { sessionID?: string }) {
      const place = createMemo(() => placeFor(props.sessionID), undefined, { equals: samePlace });

      createEffect(() => {
        const current = place();
        client.show(current);
        onCleanup(() => client.hide(current));
      });

      const snapshot = createMemo(() => snapshotOf(place()));
      const forge = createMemo(() => forgeFor(place().directory));
      const fullWidth = createMemo(() =>
        enabledFor(place().directory) ? segmentsWidth(footerSegments(snapshot(), forge())) : 0,
      );
      const [availableWidth, setAvailableWidth] = createSignal(0);
      const segments = createMemo(() =>
        responsiveFooterSegments(snapshot(), availableWidth(), forge()),
      );

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
        message: `${requestNoun(sessionForge(place))} status is off in the plugin's options (status: false)`,
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

    function StatusDetails(props: { snapshot: Snapshot; forge?: ForgeKind }) {
      const lookup = () => {
        const value = props.snapshot.lookup;
        return value?.kind === 'found' ? value : undefined;
      };
      const noun = () => requestNoun(snapshotForge(props.snapshot, props.forge));
      return (
        <box gap={1} flexShrink={0}>
          <Show
            when={lookup()}
            fallback={
              <text fg={props.snapshot.error ? color('error') : context.theme.text.muted}>
                {detailsMessage(props.snapshot, props.forge)}
              </text>
            }
          >
            {(found: () => Extract<Lookup, { kind: 'found' }>) => (
              <>
                <Show when={found().repository}>
                  {(repository: () => Repository) => (
                    <box flexShrink={0}>
                      <DetailField label="Repository" value={repository().source.path} />
                      <DetailField label="Branch" value={branchLabel(repository())} />
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
                  <text fg={context.theme.text.muted}>No {noun()} status available.</text>
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

    function closeCleanedSessions(sessionIDs: readonly string[]) {
      if (!sessionIDs.length) return;
      const ids = new Set(sessionIDs);
      if (context.ui.tabs.enabled()) {
        for (const id of ids) context.ui.tabs.close(id);
      }
      const route = context.ui.router.current();
      if (route.type === 'session' && ids.has(route.sessionID)) {
        context.ui.router.navigate({ type: 'home' });
      }
    }

    function CleanupProgressDialog(props: {
      title: string;
      mode: 'scan' | 'cleanup';
      forge?: () => ForgeKind | undefined;
      progress: () => CleanupProgressEvent | undefined;
    }) {
      const [frame, setFrame] = createSignal(0);
      const timer = setInterval(() => {
        setFrame((index) => (index + 1) % SPINNER_FRAMES.length);
      }, 80);
      onCleanup(() => clearInterval(timer));

      return (
        <box height={5} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
            <text fg={context.theme.text.base}>
              <b>{props.title}</b>
            </text>
            <text fg={context.theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
              esc
            </text>
          </box>
          <box height={1} flexShrink={0}>
            <text wrapMode="none" fg={context.theme.text.muted}>
              {SPINNER_FRAMES[frame()]}{' '}
              {formatCleanupProgress(props.progress(), props.mode, props.forge?.())}
            </text>
          </box>
        </box>
      );
    }

    async function runSessionCleanup(
      directory: string,
      sessionIDs: string[],
      showProgressDialog = false,
    ): Promise<CleanupResult | undefined> {
      const scanID = nextScanID();
      const [progress, setProgress] = createSignal<CleanupProgressEvent | undefined>();
      const offProgress = rpc.events.on('cleanupProgress', (event) => {
        const data = event.data as CleanupProgress;
        if (data.scanID === scanID) setProgress(data);
      });
      let progressOpen = false;
      if (showProgressDialog) {
        progressOpen = true;
        context.ui.dialog.set({ size: 'medium', centered: true });
        context.ui.dialog.show(
          () => (
            <CleanupProgressDialog
              title="Clean up finished sessions"
              mode="cleanup"
              forge={() => forgeFor(directory)}
              progress={progress}
            />
          ),
          () => {
            progressOpen = false;
          },
        );
      }
      try {
        const archived: string[] = [];
        const alreadyArchived: string[] = [];
        const failed: CleanupResult['failed'][number][] = [];
        for (let i = 0; i < sessionIDs.length; i += 500) {
          const chunk = sessionIDs.slice(i, i + 500);
          const part = (await rpc.cleanupSessions(
            { sessionIDs: chunk, scanID, allowClientArchive: true },
            { location: { directory } },
          )) as CleanupResult;
          archived.push(...part.archived);
          alreadyArchived.push(...part.alreadyArchived);
          failed.push(...part.failed);
          const pendingClientArchive = part.needsClientArchive ?? [];
          if (pendingClientArchive.length > 0) {
            let checked = 0;
            const total = pendingClientArchive.length;
            setProgress({ phase: 'archiving', checked: 0, total });
            const clientArchived: string[] = [];
            await mapLimit(pendingClientArchive, 8, async (sessionID) => {
              try {
                await context.client.session.update({ sessionID, archived: true });
                clientArchived.push(sessionID);
              } catch (error) {
                failed.push({
                  sessionID,
                  reason: error instanceof Error ? error.message : String(error),
                });
              } finally {
                checked++;
                setProgress({ phase: 'archiving', checked, total });
              }
            });
            if (clientArchived.length > 0) {
              const finalized = (await rpc.cleanupSessions(
                { sessionIDs: clientArchived, scanID, finalizeArchived: true },
                { location: { directory } },
              )) as CleanupResult;
              archived.push(...finalized.archived);
              alreadyArchived.push(...finalized.alreadyArchived);
              failed.push(...finalized.failed);
            }
          }
        }
        const result: CleanupResult = { archived, alreadyArchived, failed };
        if (progressOpen) context.ui.dialog.clear();
        closeCleanedSessions([...result.archived, ...result.alreadyArchived]);
        if (result.archived.length > 0) {
          const count = result.archived.length;
          context.ui.toast.show({
            message:
              count === 1
                ? 'Archived 1 session and closed its tab.'
                : `Archived ${count} sessions and closed their tabs.`,
            variant: 'info',
          });
        } else if (result.alreadyArchived.length > 0 && result.failed.length === 0) {
          const count = result.alreadyArchived.length;
          context.ui.toast.show({
            message:
              count === 1
                ? 'Session was already archived.'
                : `${count} sessions were already archived.`,
            variant: 'info',
          });
        }
        if (result.failed.length > 0) {
          context.ui.toast.show({
            message: formatCleanupFailures(result.failed),
            variant: 'error',
          });
        }
        return result;
      } catch (error) {
        if (progressOpen) context.ui.dialog.clear();
        context.ui.toast.show({
          message: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
        return undefined;
      } finally {
        offProgress();
      }
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
      const defaultForge = createMemo(() => forgeFor(props.place.directory));
      const noun = createMemo(() => requestNoun(snapshotForge(snapshot(), defaultForge())));
      const canCleanup = createMemo(() => props.place.key !== HOME && !!cleanupReadyOf(snapshot()));
      const [cleaning, setCleaning] = createSignal(false);
      const reload = () => {
        if (!snapshot().loading) void refresh(props.place);
      };
      const cleanSession = () => {
        if (!canCleanup() || cleaning()) return;
        setCleaning(true);
        context.ui.dialog.clear();
        void runSessionCleanup(props.place.directory, [props.place.key]);
      };
      const availableActions = createMemo<readonly StatusDialogAction[]>(() =>
        canCleanup() ? ['close', 'cleanup', 'refresh'] : ['close', 'refresh'],
      );
      const [activeAction, setActiveAction] = createSignal<StatusDialogAction>('refresh');
      createEffect(() => {
        if (!availableActions().includes(activeAction())) {
          setActiveAction('refresh');
        }
      });
      const stepAction = (delta: 1 | -1) =>
        setActiveAction((current) => {
          const actions = availableActions().filter(
            (action) => !(action === 'refresh' && snapshot().loading),
          );
          const index = actions.indexOf(current);
          const next = index < 0 ? 0 : (index + delta + actions.length) % actions.length;
          return actions[next] ?? 'close';
        });
      const close = () => context.ui.dialog.clear();
      const runDialogAction = (action: StatusDialogAction) => {
        switch (action) {
          case 'refresh':
            reload();
            break;
          case 'cleanup':
            cleanSession();
            break;
          case 'close':
            close();
            break;
        }
      };
      const actionColor = (disabled: boolean, active: boolean) => {
        if (disabled) return context.theme.text.action.primary.disabled;
        if (active) return context.theme.text.action.primary.focused;
        return context.theme.text.muted;
      };

      context.keymap.layer(() => ({
        mode: 'modal',
        commands: [
          {
            id: 'forge.review.status.refresh',
            bind: 'ctrl+r',
            enabled: () => !snapshot().loading,
            run: reload,
          },
          {
            id: 'forge.review.status.cleanup',
            bind: 'ctrl+d',
            enabled: () => canCleanup() && !cleaning(),
            run: cleanSession,
          },
          { bind: 'tab', title: 'Next dialog action', run: () => stepAction(1) },
          { bind: 'shift+tab', title: 'Previous dialog action', run: () => stepAction(-1) },
          { bind: 'left', title: 'Previous dialog action', run: () => stepAction(-1) },
          { bind: 'right', title: 'Next dialog action', run: () => stepAction(1) },
          {
            bind: 'return',
            title: 'Activate dialog action',
            run: () => runDialogAction(activeAction()),
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
              <b>{noun()} status</b>
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
            <StatusDetails snapshot={snapshot()} forge={defaultForge()} />
          </scrollbox>
          <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
            <For each={availableActions()}>
              {(action) => {
                const disabled = () =>
                  (action === 'refresh' && snapshot().loading) ||
                  (action === 'cleanup' && cleaning());
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
                      runDialogAction(action);
                    }}
                  >
                    <text wrapMode="none" fg={actionColor(disabled(), active())}>
                      {statusActionLabel(action, snapshot().loading)}
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
      const place = currentPlace();
      const directory = place.directory;
      const state = await loadFeedback(directory);
      const items = sessionItems(state, place.key || undefined);
      const triggerAct = async (id: string, retry = false) => {
        if (retry) {
          const confirmed = await context.ui.dialog.select({
            title: 'Retry may repeat earlier changes. Inspect the session first.',
            options: [
              { title: 'Cancel', value: 'cancel' },
              { title: 'Retry feedback work', value: 'retry' },
            ],
          });
          if (confirmed !== 'retry') return;
        }
        try {
          await rpc.actOnFeedback(
            { id, ...(retry ? { retry: true } : {}) },
            { location: { directory } },
          );
          context.ui.dialog.clear();
          void showFeedback();
        } catch (error) {
          context.ui.toast.show({ message: String(error), variant: 'error' });
        }
      };
      const triggerSummarize = async (id: string) => {
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
      };
      const triggerAcknowledge = async (id: string) => {
        await rpc.acknowledgeFeedback({ id }, { location: { directory } });
        context.ui.dialog.clear();
        void showFeedback();
      };
      const inboxForge =
        forgeScope(items.map((item) => parseReference(item.url)?.ref.forge)) ?? sessionForge(place);
      const selected = await context.ui.dialog.select({
        title: `Review feedback and ${requestNoun(inboxForge)} updates${state.paused ? ' (monitoring paused)' : ''}`,
        options: items.map((item) => ({
          title: item.title,
          description: feedbackItemDescription(item),
          value: item.id,
        })),
        actions: [
          ...(listAllowsAct(items)
            ? [
                {
                  bind: 'ctrl+a',
                  title: 'Act on feedback',
                  onTrigger: (id: string) => void triggerAct(id, false),
                },
                {
                  bind: 'ctrl+t',
                  title: 'Retry feedback work',
                  onTrigger: (id: string) => void triggerAct(id, true),
                },
              ]
            : []),
          {
            bind: 'ctrl+d',
            title: 'Acknowledge',
            onTrigger: (id) => void triggerAcknowledge(id),
          },
          {
            bind: 'ctrl+r',
            title: 'Summarize in session',
            onTrigger: (id) => void triggerSummarize(id),
          },
          {
            bind: 'ctrl+u',
            title: 'Mark all as read',
            selection: 'none',
            onTrigger: async () => {
              await rpc.markFeedbackRead(
                { ids: items.map((item) => item.id) },
                { location: { directory } },
              );
              context.ui.dialog.clear();
              void showFeedback();
            },
          },
          {
            bind: 'ctrl+s',
            title: state.paused ? 'Enable feedback inbox' : 'Pause monitoring',
            selection: 'none',
            onTrigger: async () => {
              await rpc.pauseFeedback({ paused: !state.paused }, { location: { directory } });
              context.ui.dialog.clear();
              void showFeedback();
            },
          },
        ],
      });
      const item = items.find((entry) => entry.id === selected);
      if (!item) return;
      const link = await context.ui.dialog.select({
        title: item.title,
        options: linkOptions(item),
        actions: [
          ...(canActOnFeedback(item)
            ? [
                {
                  bind: 'ctrl+a',
                  title: 'Act on feedback',
                  selection: 'none' as const,
                  onTrigger: () => void triggerAct(item.id, false),
                },
                {
                  bind: 'ctrl+t',
                  title: 'Retry feedback work',
                  selection: 'none' as const,
                  onTrigger: () => void triggerAct(item.id, true),
                },
              ]
            : []),
          {
            bind: 'ctrl+r',
            title: 'Summarize in session',
            selection: 'none',
            onTrigger: () => void triggerSummarize(item.id),
          },
          {
            bind: 'ctrl+d',
            title: 'Acknowledge',
            selection: 'none',
            onTrigger: () => void triggerAcknowledge(item.id),
          },
        ],
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
        context.ui.toast.show({
          message: `No ${requestNoun(sessionForge(place))} for this session`,
          variant: 'info',
        });
        return;
      }
      if (requests.length === 1) return openUrl(requests[0].url);
      const forge = forgeScope(requests.map((mr) => mr.forge));
      const url = await context.ui.dialog.select({
        title: `Open ${requestNoun(forge)}`,
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

    let activeCleanupScan: AbortController | undefined;

    async function showCleanup(prefetched?: CleanupScanResult, targetDirectory?: string) {
      const directory = targetDirectory ?? currentPlace().directory;
      if (statusOff({ directory, key: HOME })) return;
      activeCleanupScan?.abort();
      let scan = prefetched;
      if (!scan) {
        const scanID = nextScanID();
        const controller = new AbortController();
        activeCleanupScan = controller;
        const [progress, setProgress] = createSignal<CleanupProgressEvent | undefined>();
        const offProgress = rpc.events.on('cleanupProgress', (event) => {
          const data = event.data as CleanupProgress;
          if (data.scanID === scanID) setProgress(data);
        });
        let transitioning = false;
        let progressOpen = true;
        context.ui.dialog.set({ size: 'medium', centered: true });
        context.ui.dialog.show(
          () => (
            <CleanupProgressDialog
              title="Clean up finished sessions"
              mode="scan"
              forge={() => forgeFor(directory)}
              progress={progress}
            />
          ),
          () => {
            progressOpen = false;
            if (!transitioning) controller.abort();
          },
        );
        try {
          scan = (await rpc.cleanupCandidates(
            { scanID },
            { location: { directory }, signal: controller.signal },
          )) as CleanupScanResult;
        } catch (error) {
          offProgress();
          if (activeCleanupScan === controller) activeCleanupScan = undefined;
          if (controller.signal.aborted) return;
          transitioning = true;
          if (progressOpen) context.ui.dialog.clear();
          context.ui.toast.show({
            message: error instanceof Error ? error.message : String(error),
            variant: 'error',
          });
          return;
        }
        offProgress();
        if (activeCleanupScan === controller) activeCleanupScan = undefined;
        if (controller.signal.aborted) return;
        if (!scan.enabled) {
          transitioning = true;
          if (progressOpen) context.ui.dialog.clear();
          context.ui.toast.show({
            message: `${requestNoun(forgeFor(directory))} status is off. Enable options.status in opencode.json to use this command.`,
            variant: 'info',
          });
          return;
        }
        if (!scan.candidates.length) {
          transitioning = true;
          if (progressOpen) context.ui.dialog.clear();
          context.ui.toast.show({
            message: emptyCleanupMessage(scan.skippedErrors, forgeFor(directory)),
            variant: 'info',
          });
          return;
        }
        transitioning = true;
      } else if (!scan.candidates.length) {
        return;
      }
      const openTabIDs = new Set(
        context.ui.tabs.enabled() ? context.ui.tabs.list().map((tab) => tab.sessionID) : [],
      );
      const directories = new Set(scan.candidates.map((candidate) => candidate.directory));
      const multiWorktree = directories.size > 1;
      context.ui.dialog.set({ size: 'large', centered: true });
      queueMicrotask(() => context.ui.dialog.set({ size: 'large', centered: true }));
      const selected = await context.ui.dialog.select({
        title: cleanupDialogTitle(scan.skippedErrors),
        options: scan.candidates.map((candidate) => ({
          title: candidate.title,
          description: formatCleanupSubtitle(candidate),
          ...(openTabIDs.has(candidate.sessionID) ? { footer: 'open tab' } : {}),
          ...(multiWorktree ? { category: worktreeLabel(candidate.directory) } : {}),
          value: candidate.sessionID,
        })),
        actions: [
          {
            bind: 'ctrl+a',
            title: `Clean up all (${scan.candidates.length})`,
            selection: 'none',
            onTrigger: async () => {
              context.ui.dialog.clear();
              await runSessionCleanup(
                directory,
                scan.candidates.map((candidate) => candidate.sessionID),
                true,
              );
            },
          },
          {
            bind: 'ctrl+o',
            title: 'Open session',
            onTrigger: (sessionID) => {
              context.ui.dialog.clear();
              if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID)) return;
              context.ui.router.navigate({ type: 'session', sessionID });
            },
          },
          {
            bind: 'ctrl+r',
            title: 'Refresh',
            selection: 'none',
            onTrigger: () => {
              context.ui.dialog.clear();
              void showCleanup(undefined, directory);
            },
          },
        ],
      });
      if (!selected) return;
      const result = await runSessionCleanup(directory, [selected]);
      const doneIDs = new Set([...(result?.archived ?? []), ...(result?.alreadyArchived ?? [])]);
      if (scan.candidates.length > 1 && doneIDs.size > 0) {
        const remaining = scan.candidates.filter((candidate) => !doneIDs.has(candidate.sessionID));
        if (remaining.length > 0) {
          void showCleanup({ ...scan, candidates: remaining }, directory);
        }
      }
    }

    context.ui.slot({
      append: 'session.composer.top',
      render: (input) => {
        const place = () => placeFor(input.sessionID);
        const ready = () =>
          enabledFor(place().directory) ? cleanupReadyOf(snapshotOf(place())) : undefined;
        return (
          <Show when={ready()}>
            {(value: () => NonNullable<ReturnType<typeof ready>>) => (
              <box paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
                <text
                  wrapMode="none"
                  fg={color('success')}
                  onMouseUp={() => void showCleanup(undefined, place().directory)}
                >
                  ✓ {value().reason} — run <b>/forge-cleanup</b> to archive this session
                </text>
              </box>
            )}
          </Show>
        );
      },
    });

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
              title: `Show ${requestNoun(sessionForge())} status`,
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-status', aliases: ['mr-status', 'pr-status'] },
              run: () => showStatus(),
            },
            {
              id: 'forge.review.open',
              title: `Open ${requestNoun(sessionForge())} in browser`,
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-open', aliases: ['mr-open', 'pr-open'] },
              run: openRequest,
            },
            {
              id: 'forge.review.cleanup',
              title: 'Clean up finished sessions',
              group: 'Forge',
              palette: true,
              slash: { name: 'forge-cleanup', aliases: ['mr-cleanup', 'pr-cleanup'] },
              run: () => showCleanup(),
            },
          ],
        }));
        return null;
      },
    });

    context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => {
        const text = () => feedbackFooter(feedback(), input.sessionID);
        return (
          <Show when={text()}>
            <text fg={context.theme.text.muted} onMouseUp={() => void showFeedback()}>
              {text()}
            </text>
          </Show>
        );
      },
    });

    const stops = [
      rpc.events.on('sessionsCleanedUp', (event) => {
        const { sessionIDs, archive } = event.data as EventData<'sessionsCleanedUp'>;
        closeCleanedSessions(sessionIDs);
        if (archive) {
          for (const sessionID of sessionIDs) {
            void context.client.session.update({ sessionID, archived: true }).catch(() => {});
          }
        }
      }),
      rpc.events.on('feedbackChanged', (event) => {
        const { directory } = event.data as EventData<'feedbackChanged'>;
        if (directory === feedbackDirectory()) void loadFeedback(directory).catch(() => {});
      }),
      rpc.events.on('notice', (event) =>
        showNotice(event.data as EventData<'notice'>, {
          hasShown: (sessionID) =>
            client.hasShown(sessionID) || event.location?.directory === feedbackDirectory(),
          openTab: (sessionID) => context.ui.tabs.open(sessionID),
          toast: context.ui.toast.show,
        }),
      ),
    ];

    return () => {
      for (const stop of stops) stop();
      connection.dispose();
    };
  },
} satisfies Plugin.Definition;
