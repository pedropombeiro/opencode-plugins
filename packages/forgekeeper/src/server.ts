import type { Plugin } from '@opencode/plugin';
import { CONCURRENCY, mapLimit } from './limit';
import type { TitleLookups } from './lookups';
import { statusOptions } from './options';
import { ForgeSessionRpc, implement } from './rpc';
import { setupStatus, type Status, type StatusDependencies } from './status-server';
import type { Snapshot } from './store';
import {
  applyTargetChange,
  includesRequest,
  MAX_TARGETS,
  parseTargetChange,
  targetOutput,
  targetRequest,
  targetsPrefix,
  type Target,
} from './target';
import { branchPrefix, extractIssueNumber, reconcileTitle } from './title';

const SKIP_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);

// Stored per session. `prefix` is the title prefix this plugin last wrote, so
// it can be replaced without touching text the user added. Before sessions
// could have several targets, the state held a single `target`.
type StoredState = { targets?: Target[]; prefix?: string };
type SessionState = { targets: Target[]; prefix?: string };

const TARGET_KEY = 'forgekeeper-session-target';

const GUIDANCE = [
  'When the user establishes or changes the primary issue, PR, or MR for this session, call set_session_target with its full URL before starting that work.',
  'When the user asks you to work on several issues, PRs, or MRs together, call set_session_target with all of their full URLs in targets. If the user describes them instead of linking them, find them first, then set them before starting that work. When they are all PRs/MRs for one established issue, pass it as issue_url.',
  'After you create a PR or MR for the current task (for example with gpsup, glab mr create, gh pr create, or a forge tool), call set_session_target with the new PR/MR URL. Pass the current issue as issue_url when the PR/MR was created for it. If the session has several targets that are still part of the task, use operation "add" so they are kept.',
  'When the user drops some of several targets from the task, call set_session_target with operation "remove" and their URLs.',
  'Background references, comparisons, and dependencies do not change the target. Follow-ups without a new primary target keep the current target.',
  'Include issue_url only when its relationship to the target PRs/MRs is established. Never carry over the checked-out branch’s issue to another target.',
  'When the user explicitly returns to work on the checked-out branch, call set_session_target with target "branch".',
  `The current session target is in the <context> entry "${TARGET_KEY}". The plugin updates it when it changes, so trust the latest value.`,
];

function describeTargets(targets: readonly Target[]): string {
  if (targets.length === 0) return 'checked-out branch (automatic)';
  if (targets.length === 1) return JSON.stringify(targets[0]);
  return `${targets.length} targets: ${JSON.stringify(targets)}`;
}

function toolResult(targets: readonly Target[], missing: readonly string[]): string {
  const lines =
    targets.length === 0
      ? ['Session target: checked-out branch.']
      : targets.length === 1
        ? [`Session target: ${targets[0].url}`]
        : [`Session targets (${targets.length}):`, ...targets.map((target) => `- ${target.url}`)];
  if (missing.length) lines.push(`Not session targets, so not removed: ${missing.join(', ')}`);
  return lines.join('\n');
}

const DISABLED = { enabled: false, snapshot: { loading: false } };

// How long cleanup waits for running title updates. They can't write once
// cleanup starts, so this only bounds how long their lookups are kept.
const DRAIN_TIME = 5_000;

async function drain(tasks: Promise<unknown>[], limit: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, limit))),
  ]);
  clearTimeout(timer);
}

// RPC values must be JSON, which has no `undefined`, such as a cleared error.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Stores each root session's targets, keeps its title prefix current, serves
// the targets to the CLI over RPC, and, given `status`, watches the PRs/MRs
// of the sessions that CLIs show.
export async function setupServer(
  ctx: Plugin.Context,
  lookups: TitleLookups,
  status?: StatusDependencies,
) {
  const pending = new Map<string, Promise<void>>();
  const instructing = new Map<string, Promise<unknown>>();
  const controller = new AbortController();
  // Set when cleanup starts. No title update or target change starts after
  // it, and one that is running stops before it writes, so it can't
  // overwrite what the replacement instance stores.
  let closing = false;
  // The last targets read or written per session, for checks that can't wait
  // for storage, such as whether a PR/MR is still a target before notifying.
  const known = new Map<string, Target[]>();
  // Counts each session's target writes. A read that overlapped a write may
  // return the old targets, so it doesn't update `known`.
  const revisions = new Map<string, number>();
  const revision = (sessionID: string) => revisions.get(sessionID) ?? 0;
  const bump = (sessionID: string) => revisions.set(sessionID, revision(sessionID) + 1);

  async function stateFor(sessionID: string): Promise<SessionState> {
    const started = revision(sessionID);
    const stored =
      ((await ctx.storage.get(`sessions/${sessionID}`)) as StoredState | undefined) ?? {};
    const targets = Array.isArray(stored.targets) ? stored.targets : [];
    if (revision(sessionID) === started) known.set(sessionID, targets);
    return { targets, ...(stored.prefix ? { prefix: stored.prefix } : {}) };
  }

  // Bumps the revision before and after the write, so neither a read that
  // started before it nor one that started while it ran updates `known`.
  const save = async (sessionID: string, state: SessionState) => {
    if (closing) throw new Error('The plugin is reloading. Try again.');
    bump(sessionID);
    known.set(sessionID, state.targets);
    try {
      await ctx.storage.set(`sessions/${sessionID}`, {
        ...(state.targets.length ? { targets: state.targets } : {}),
        ...(state.prefix ? { prefix: state.prefix } : {}),
      });
    } finally {
      bump(sessionID);
    }
  };

  let watcher: Status | undefined;
  const rpc = await ctx.rpc.register(
    ForgeSessionRpc,
    implement({
      target: async ({ sessionID }) => targetOutput((await stateFor(sessionID)).targets),
      watch: async ({ clientID, keys, visible }) =>
        watcher
          ? { enabled: true, statuses: json(watcher.service.watch(clientID, keys, visible)) }
          : { enabled: false, statuses: {} },
      release: async ({ clientID }) => {
        watcher?.service.release(clientID);
        return {};
      },
      refresh: async ({ key }) =>
        watcher ? { enabled: true, snapshot: json(await watcher.refresh(key)) } : DISABLED,
      feedback: async () => (watcher ? watcher.inbox.list() : { items: [], paused: false }),
      acknowledgeFeedback: async ({ id }) =>
        watcher ? watcher.inbox.acknowledge(id) : { items: [], paused: false },
      pauseFeedback: async ({ paused }) => {
        if (!watcher) return { items: [], paused: false };
        const state = await watcher.inbox.pause(paused);
        watcher.service.pauseFeedback(paused);
        await watcher.discovery.refresh();
        return state;
      },
    }),
  );

  const settings = statusOptions(ctx.options);
  if (status && settings.enabled) {
    watcher = await setupStatus(ctx, settings, status, {
      state: stateFor,
      isTarget: (sessionID, url) => includesRequest(known.get(sessionID) ?? [], url),
      publish: (key: string, snapshot: Snapshot) =>
        void rpc.events
          .emit('status', { directory: ctx.location.directory, key, snapshot: json(snapshot) })
          .catch(() => {}),
      notice: (notice) => void rpc.events.emit('notice', json(notice)).catch(() => {}),
      feedbackChanged: () =>
        void rpc.events
          .emit('feedbackChanged', { directory: ctx.location.directory })
          .catch(() => {}),
    });
  }

  async function update(sessionID: string): Promise<void> {
    const session = await ctx.session.get({ sessionID });
    if (session.parentID || !session.title) return;

    const directory = session.location.directory;
    if (directory !== ctx.location.directory) return;

    const state = await stateFor(sessionID);
    let prefix = targetsPrefix(state.targets);
    if (state.targets.length === 0) {
      const vcs = await ctx.vcs.get({ location: session.location });
      const info = vcs.data?.branch;
      const branch = info?.current;
      if (branch && !SKIP_BRANCHES.has(branch) && branch !== info?.default) {
        const found = await lookups.branch(directory);
        if (found) prefix = branchPrefix(found.forge, found.branch, found.number);
      }
    }

    // A branch lookup can outlast cleanup. Its result must not reach the
    // title or storage, which the replacement instance owns by then.
    if (closing) return;
    const title = reconcileTitle(session.title, prefix, state.prefix);
    if (title !== session.title) await ctx.session.update({ sessionID, title });
    await save(sessionID, { targets: state.targets, ...(prefix ? { prefix } : {}) });
  }

  // Runs one update at a time per session, so a target change and a turn
  // ending at once can't interleave their reads and writes.
  function schedule(sessionID: string, action = () => update(sessionID)): Promise<void> {
    if (closing) return Promise.reject(new Error('The plugin is reloading. Try again.'));
    const previous = pending.get(sessionID) ?? Promise.resolve();
    const next = previous.then(action);
    const settled = next.catch(() => {});
    pending.set(sessionID, settled);
    void settled.then(() => {
      if (pending.get(sessionID) === settled) pending.delete(sessionID);
    });
    return next;
  }

  // Infers the related issue of each PR/MR target from its source branch.
  // Targets the session already had were looked up when they were added.
  async function inferIssues(targets: Target[], previous: readonly Target[]) {
    const known = new Set(
      previous.filter((target) => !target.issueUrl).map((target) => target.url),
    );
    await mapLimit(targets, CONCURRENCY, async (target) => {
      if (target.issueUrl || target.branchIssue || known.has(target.url)) return;
      const request = targetRequest(target);
      const branch = request
        ? await lookups.sourceBranch(request, ctx.location.directory)
        : undefined;
      const issue = branch ? extractIssueNumber(branch) : undefined;
      if (issue) target.branchIssue = issue;
    });
  }

  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: 'set_session_target',
      options: { codemode: false },
      description:
        'Set the issues, PRs, or MRs this session works on, for its title and PR/MR status. Use target for one full URL, or "branch" to return to branch-based naming. Use targets for several full URLs. The default operation, "replace", sets exactly the given targets; "add" keeps the current targets, and "remove" drops the given ones. Call it after creating a PR/MR for the current task. Without issue_url, the related issue is inferred from the PR/MR source branch name. This only changes local session metadata.',
      input: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Full GitHub/GitLab issue, PR, or MR URL, or "branch".',
          },
          targets: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_TARGETS,
            description: 'Several full GitHub/GitLab issue, PR, or MR URLs, instead of target.',
          },
          operation: {
            type: 'string',
            enum: ['replace', 'add', 'remove'],
            description: 'How the given targets change the current ones. Defaults to "replace".',
          },
          issue_url: {
            type: 'string',
            description:
              'Optional full URL of an established related issue for target, or for every PR/MR in targets. Omit when unknown.',
          },
        },
        additionalProperties: false,
      },
      execute: async (input, { sessionID }) => {
        const change = parseTargetChange(input);
        let result: { targets: Target[]; missing: string[] } = { targets: [], missing: [] };
        await schedule(sessionID, async () => {
          const session = await ctx.session.get({ sessionID });
          if (session.parentID || session.location.directory !== ctx.location.directory) {
            throw new Error('Session targets can only be set in the current root session.');
          }
          const state = await stateFor(sessionID);
          result = applyTargetChange(state.targets, change);
          await inferIssues(result.targets, state.targets);
          await save(sessionID, {
            targets: result.targets,
            ...(state.prefix ? { prefix: state.prefix } : {}),
          });
          watcher?.targetsChanged(sessionID, result.targets);
          await instruct(sessionID).catch(() => {});
          await rpc.events.emit('targetChanged', { sessionID, ...targetOutput(result.targets) });
          await update(sessionID);
        });
        return { content: toolResult(result.targets, result.missing) };
      },
    });
  });

  async function writeInstructions(sessionID: string): Promise<string[]> {
    if (closing) return [];
    const state = await stateFor(sessionID);
    const value = `Current session target: ${describeTargets(state.targets)}.`;
    const entries = await ctx.session.instructions.entry.list({ sessionID });
    if (entries.some((entry) => entry.key === TARGET_KEY && entry.value === value)) return [];
    if (closing) return [];
    await ctx.session.instructions.entry.put({ sessionID, key: TARGET_KEY, value });
    return [value];
  }

  function instruct(sessionID: string): Promise<string[]> {
    const next = (instructing.get(sessionID) ?? Promise.resolve()).then(() =>
      writeInstructions(sessionID),
    );
    const settled = next.catch(() => {});
    instructing.set(sessionID, settled);
    void settled.then(() => {
      if (instructing.get(sessionID) === settled) instructing.delete(sessionID);
    });
    return next;
  }

  // A failure here must not block the model request, so it only skips the guidance.
  await ctx.session.hook('context', async (event) => {
    try {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || session.location.directory !== ctx.location.directory) return;
      event.system.push({ type: 'text', text: GUIDANCE.join('\n') });
      const written = await instruct(event.sessionID);
      if (written.length) event.system.push({ type: 'text', text: written.join('\n') });
    } catch {
      // The request goes ahead without the guidance.
    }
  });

  void (async () => {
    for await (const event of ctx.event.subscribe({
      types: [
        'session.renamed',
        'session.moved',
        'session.execution.succeeded',
        'session.execution.failed',
        'vcs.branch.updated',
      ],
      signal: controller.signal,
    })) {
      const { type } = event as { type: string };
      const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID;
      if ((type === 'session.renamed' || type === 'session.execution.succeeded') && sessionID) {
        void schedule(sessionID).catch(() => {});
      }
      if (type === 'session.renamed' && sessionID)
        void watcher?.titleChanged(sessionID).catch(() => {});
      if (type === 'session.moved' && sessionID) watcher?.sessionMoved(sessionID);
      if (type === 'session.execution.succeeded' || type === 'session.execution.failed')
        watcher?.turnEnded();
      if (type === 'vcs.branch.updated') {
        const location = (event as { location?: { directory?: string } }).location;
        if (!location?.directory || location.directory === ctx.location.directory)
          void watcher?.branchChanged().catch(() => {});
      }
    }
  })().catch((error) => {
    // Without events, titles and statuses stop following renames, turns, and
    // branch switches until the plugin reloads.
    if (controller.signal.aborted) return;
    const reason = error instanceof Error ? error.message : String(error);
    void rpc.events
      .emit('notice', {
        message: `Session title and PR/MR status updates stopped: ${reason}`,
        variant: 'error',
      })
      .catch(() => {});
  });

  // Stops new work, waits for running title updates and target changes, then
  // stops the status watchers.
  return async () => {
    closing = true;
    controller.abort();
    await drain([...pending.values()], DRAIN_TIME);
    await watcher?.dispose();
    await tools.dispose();
    await rpc.dispose();
  };
}
