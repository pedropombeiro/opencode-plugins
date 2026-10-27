import type { Plugin } from '@opencode/plugin';
import { startPrompt } from './babysit';
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
  type TargetChange,
} from './target';
import { branchPrefix, extractIssueNumber, reconcileTitle } from './title';

const SKIP_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);

// Stored per session. `prefix` is the title prefix this plugin last wrote, so
// it can be replaced without touching text the user added. Before sessions
// could have several targets, the state held a single `target`.
type StoredState = { targets?: Target[]; prefix?: string };
type SessionState = { targets: Target[]; prefix?: string };

// Session instruction entries. Unlike the system prompt, changing one doesn't
// invalidate the prompt cache, and the model sees it at the next step.
const TARGET_KEY = 'forgekeeper-session-target';
const BABYSIT_KEY = 'forgekeeper-babysitting';

const GUIDANCE = [
  'When the user establishes or changes the primary issue, PR, or MR for this session, call set_session_target with its full URL before starting that work.',
  'When the user asks you to work on several issues, PRs, or MRs together, call set_session_target with all of their full URLs in targets. If the user describes them instead of linking them, find them first, then set them before starting that work. When they are all PRs/MRs for one established issue, pass it as issue_url.',
  'After you create a PR or MR for the current task (for example with gpsup, glab mr create, gh pr create, or a forge tool), call set_session_target with the new PR/MR URL. Pass the current issue as issue_url when the PR/MR was created for it. If the session has several targets that are still part of the task, use operation "add" so they are kept.',
  'When the user drops some of several targets from the task, call set_session_target with operation "remove" and their URLs.',
  'Background references, comparisons, and dependencies do not change the target. Follow-ups without a new primary target keep the current target.',
  'Include issue_url only when its relationship to the target PRs/MRs is established. Never carry over the checked-out branch’s issue to another target.',
  'When the user explicitly returns to work on the checked-out branch, call set_session_target with target "branch".',
  `The current session target, and any babysitting, are in the <context> entries "${TARGET_KEY}" and "${BABYSIT_KEY}". The plugin updates them when they change, so trust the latest ones.`,
];

function describeTargets(targets: readonly Target[]): string {
  if (targets.length === 0) return 'checked-out branch (automatic)';
  if (targets.length === 1) return JSON.stringify(targets[0]);
  return `${targets.length} targets: ${JSON.stringify(targets)}`;
}

const babysitNote = (urls: readonly string[]) =>
  `This session babysits ${urls.join(', ')} until they are ready for human review. Handle each babysitting update and review notification, then end your turn; do not poll or sleep. Call babysit with operation "stop" when a PR/MR needs the user.`;

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
        watcher ? { enabled: true, snapshot: json(await watcher.service.refresh(key)) } : DISABLED,
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
      babysitUpdated: (sessionID) => void instruct(sessionID).catch(() => {}),
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
    // Guidance and prompts tell the agent to call these by name, so they are
    // direct tools instead of reaching the agent only through Code Mode.
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
        const result = await changeTargets(sessionID, parseTargetChange(input));
        return { content: toolResult(result.targets, result.missing) };
      },
    });
    editor.add({
      name: 'babysit',
      options: { codemode: false },
      description:
        'Babysit PR/MR session targets until they are ready for human review: the plugin watches their CI, merge conflicts, and reviews, and resumes the session when one needs attention. Use operation "start" only when the user asks to babysit or watch PRs/MRs; it adds any given URLs as session targets, and without urls it babysits every PR/MR target. Use "stop" when a PR/MR needs the user or the user asks to stop, with urls to stop only some. Use "status" to list what is babysat.',
      input: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['start', 'stop', 'status'] },
          urls: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_TARGETS,
            description: 'Full PR/MR URLs. Defaults to every babysat PR/MR or PR/MR target.',
          },
        },
        required: ['operation'],
        additionalProperties: false,
      },
      execute: async (input, { sessionID }) => {
        const { operation, urls } = input as { operation: string; urls?: string[] };
        if (operation === 'start') {
          const started = await startBabysit(sessionID, urls);
          return { content: [started.text, ...started.notes].join('\n\n') };
        }
        if (operation === 'stop') return { content: await stopBabysit(sessionID, urls) };
        return { content: await babysitStatus(sessionID) };
      },
    });
  });

  const commands = await ctx.command.transform((editor) => {
    editor.add({
      name: 'babysit',
      description:
        'Babysit PRs/MRs until they are ready for human review. Usage: /babysit [URL...], /babysit status, /babysit stop [URL...]',
      execute: async ({ sessionID, prompt, delivery }) => {
        const words = prompt.text.trim().split(/\s+/).filter(Boolean);
        const tell = (message: string, variant: 'info' | 'error' = 'info') =>
          void rpc.events
            .emit('notice', { sessionID, title: 'Babysit', message, variant })
            .catch(() => {});
        try {
          if (words[0] === 'stop') return tell(await stopBabysit(sessionID, words.slice(1)));
          if (words[0] === 'status') return tell(await babysitStatus(sessionID));
          const started = await startBabysit(sessionID, words);
          for (const note of started.notes) tell(note);
          await ctx.session.prompt({ sessionID, text: started.text, delivery });
        } catch (error) {
          tell(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  });

  async function rootSession(sessionID: string, what: string) {
    const session = await ctx.session.get({ sessionID });
    if (session.parentID || session.location.directory !== ctx.location.directory) {
      throw new Error(`${what} only in the current root session.`);
    }
  }

  async function changeTargets(sessionID: string, change: TargetChange) {
    let result: { targets: Target[]; missing: string[] } = { targets: [], missing: [] };
    await schedule(sessionID, async () => {
      await rootSession(sessionID, 'Session targets can be set');
      const state = await stateFor(sessionID);
      result = applyTargetChange(state.targets, change);
      await inferIssues(result.targets, state.targets);
      await save(sessionID, {
        targets: result.targets,
        ...(state.prefix ? { prefix: state.prefix } : {}),
      });
      // A PR/MR that is no longer a target is no longer babysat.
      const kept = new Set(result.targets.map((target) => target.url));
      await watcher?.babysitter.prune(sessionID, (url) => kept.has(url));
      watcher?.targetsChanged(sessionID, result.targets);
      watcher?.babysitChanged(sessionID);
      await instruct(sessionID).catch(() => {});
      await rpc.events.emit('targetChanged', { sessionID, ...targetOutput(result.targets) });
      await update(sessionID);
    });
    return result;
  }

  function babysitting() {
    if (!watcher)
      throw new Error('Babysitting needs PR/MR status, which the reviewStatus option turned off.');
    return watcher;
  }

  // The normalized URLs, as session targets store them.
  const normalize = (urls: readonly string[]) => {
    const change = parseTargetChange({ targets: urls, operation: 'add' });
    return change.operation === 'branch' ? [] : change.targets.map((target) => target.url);
  };

  // The configured skill, if it's installed. A missing skill falls back to
  // the built-in instructions.
  async function babysitSkill(): Promise<{ skill?: string; missing?: string }> {
    const name = settings.babysitSkill;
    if (!name) return {};
    try {
      const skills = await ctx.skill.list();
      if (skills.data.some((skill) => skill.id === name)) return { skill: name };
    } catch {
      // Treated as missing.
    }
    return { missing: name };
  }

  async function startBabysit(sessionID: string, urls?: readonly string[]) {
    const status = babysitting();
    await rootSession(sessionID, 'Babysitting can start');
    const wanted = urls?.length ? normalize(urls) : undefined;
    if (wanted)
      await changeTargets(sessionID, parseTargetChange({ targets: wanted, operation: 'add' }));
    const candidates = (await stateFor(sessionID)).targets
      .filter((target) => targetRequest(target))
      .map((target) => target.url)
      .filter((url) => !wanted || wanted.includes(url));
    if (candidates.length === 0)
      throw new Error(
        wanted
          ? 'Only PRs/MRs can be babysat, not issues.'
          : 'This session has no PR/MR targets. Pass their URLs: /babysit <URL>...',
      );
    const { added, claimed } = await status.babysitter.start(sessionID, candidates);
    status.babysitChanged(sessionID);
    const elsewhere = claimed.map((claim) => `${claim.url} (session ${claim.sessionID})`);
    if (added.length === 0)
      throw new Error(`Another session already babysits ${elsewhere.join(', ')}.`);
    const skill = await babysitSkill();
    const notes = [
      ...(elsewhere.length ? [`Another session already babysits ${elsewhere.join(', ')}.`] : []),
      ...(skill.missing
        ? [
            `The babysitSkill "${skill.missing}" is not installed, so babysitting uses the built-in instructions.`,
          ]
        : []),
    ];
    return { added, notes, text: startPrompt(added, skill.skill) };
  }

  async function stopBabysit(sessionID: string, urls?: readonly string[]) {
    const status = babysitting();
    const stopped = await status.babysitter.stop(
      sessionID,
      urls?.length ? normalize(urls) : undefined,
    );
    status.babysitChanged(sessionID);
    return stopped.length
      ? `Stopped babysitting ${stopped.join(', ')}.`
      : 'Nothing matching was being babysat.';
  }

  async function babysitStatus(sessionID: string) {
    const record = await babysitting().babysitter.get(sessionID);
    const items = Object.entries(record?.items ?? {});
    if (items.length === 0) return 'This session babysits no PRs/MRs.';
    return [
      `Babysitting ${items.length} PR/MR${items.length === 1 ? '' : 's'}:`,
      ...items.map(
        ([url, state]) =>
          `- ${url}${state.observed ? `: CI ${state.ci?.toLowerCase() ?? 'unknown'}${state.conflicts ? ', merge conflicts' : ''}` : ': waiting for the first check'}`,
      ),
    ].join('\n');
  }

  // The entries the session should have, as the model reads them.
  async function wantedEntries(sessionID: string) {
    const state = await stateFor(sessionID);
    const wanted = new Map([
      [TARGET_KEY, `Current session target: ${describeTargets(state.targets)}.`],
    ]);
    const urls = Object.keys((await watcher?.babysitter.get(sessionID))?.items ?? {});
    if (urls.length) wanted.set(BABYSIT_KEY, babysitNote(urls));
    return wanted;
  }

  // Brings the session's entries up to date, and returns the ones it wrote.
  // It compares with the stored entries instead of remembering what it wrote,
  // so it also corrects entries after a failed write or a reload.
  async function writeInstructions(sessionID: string) {
    if (closing) return [];
    const wanted = await wantedEntries(sessionID);
    const current = new Map(
      (await ctx.session.instructions.entry.list({ sessionID })).map((entry) => [
        entry.key,
        entry.value,
      ]),
    );
    const written: string[] = [];
    for (const [key, value] of wanted) {
      if (current.get(key) === value) continue;
      await ctx.session.instructions.entry.put({ sessionID, key, value });
      written.push(value);
    }
    for (const key of [TARGET_KEY, BABYSIT_KEY]) {
      if (!wanted.has(key) && current.has(key))
        await ctx.session.instructions.entry.remove({ sessionID, key });
    }
    return written;
  }

  // Runs one write at a time per session, so a stale read can't overwrite a newer one.
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
      // The model sees an entry from the next step on. What this call wrote
      // goes into this request too, so a session's first request, or the
      // first after a reload, doesn't lack its target.
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
    await commands.dispose();
    await tools.dispose();
    await rpc.dispose();
  };
}
