// What Forgekeeper does when a PR/MR that another target of the session builds
// on merges: the dependent PR/MR may need to target the branch the merged one
// went into. Forgekeeper does this itself, through its forge's one retarget
// operation, so no model and no general-purpose tool takes part.
//
// Each step reads the PR/MR again first, so the outcome depends on the forge's
// current state, not on what a lookup saw earlier. A forge that already
// retargeted it, as GitLab and GitHub can when a merged branch is deleted,
// counts as done.
import type { ReviewRequest } from './forge';
import type { LifecycleRecord } from './lifecycle-watch';
import type { EventPolicy, ExecutionMode } from './options';

// How many times Forgekeeper tries to retarget a dependent, failed reads
// included, before it reports the failure as final.
export const MAX_RETARGET_ATTEMPTS = 3;

// The stricter of two policies: the lower mode, and only the actions both
// allow.
export function stricter(a: EventPolicy | undefined, b: EventPolicy): EventPolicy {
  if (!a) return { mode: 'notify', actions: [] };
  const order: ExecutionMode[] = ['notify', 'prepare', 'apply'];
  const mode = order[Math.min(order.indexOf(a.mode), order.indexOf(b.mode))];
  return {
    mode,
    actions: mode === 'notify' ? [] : a.actions.filter((action) => b.actions.includes(action)),
  };
}

// A retarget's progress, stored so a reload neither repeats nor loses it.
export interface RetargetEntry {
  state: 'running' | 'done';
  from: string;
  to: string;
  outcome?: string;
  // Attempts so far, each spent before it starts.
  attempts?: number;
  // Whether Forgekeeper asked the forge to retarget, so a later read that
  // finds the new target knows the change was Forgekeeper's.
  sent?: boolean;
}

export interface RetargetOptions {
  parent: LifecycleRecord;
  // The session's current targets whose parent is the merged PR/MR.
  children: readonly LifecycleRecord[];
  policy: EventPolicy;
  // Reads a PR/MR from its forge, bypassing caches.
  fetch: (url: string) => Promise<ReviewRequest | undefined>;
  // Whether the session may still have the dependent retargeted, checked
  // right before the change: it still targets it, from this checkout.
  // Rejects when that can't be told right now.
  allowed: (child: string) => Promise<boolean>;
  // The forge's retarget operation, when it has one.
  retarget?: (request: ReviewRequest, branch: string) => Promise<void>;
  journal: {
    get: (child: string) => Promise<RetargetEntry | undefined>;
    set: (child: string, entry: RetargetEntry) => Promise<void>;
  };
}

export interface RetargetResult {
  // One line per dependent PR/MR: what Forgekeeper did, would do, or why not.
  lines: string[];
  // Whether a dependent failed in a way worth another attempt.
  retry: boolean;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function retargetChildren(options: RetargetOptions): Promise<RetargetResult> {
  const { parent, policy } = options;
  const from = parent.sourceBranch;
  const to = parent.targetBranch;
  const applying =
    policy.mode === 'apply' && policy.actions.includes('retarget') && !!options.retarget;

  async function handle(child: LifecycleRecord): Promise<{ line: string; retry?: boolean }> {
    if (policy.mode === 'notify')
      return {
        line: `${child.reference} builds on ${parent.reference}: it targets ${from ?? 'its source branch'}.`,
      };
    // A fork's branch can't stand in for the target project's branch.
    if (!from || !parent.sourceProject || parent.sourceProject !== parent.targetProject)
      return {
        line: `${child.reference} builds on ${parent.reference}, which came from another project, so its new target is unclear.`,
      };
    const entry = await options.journal.get(child.url);
    if (entry?.state === 'done' && entry.outcome) return { line: entry.outcome };
    const previous = entry?.attempts ?? 0;
    // A reload during the last attempt leaves its budget spent. Forgekeeper
    // then only reads what that attempt did, and never sends another change.
    const exhausted = applying && previous >= MAX_RETARGET_ATTEMPTS;
    const attempts = previous + (applying && !exhausted ? 1 : 0);
    const gaveUp = (line: string) => `${line} Forgekeeper gave up after ${attempts} attempts.`;
    let sent = entry?.sent === true;
    const save = (next: Partial<RetargetEntry>) => {
      sent ||= next.sent === true;
      return options.journal.set(child.url, {
        state: 'running',
        from,
        to,
        attempts,
        ...next,
        sent,
      });
    };
    const done = async (line: string) => {
      if (applying) await save({ state: 'done', outcome: line });
      return { line };
    };
    // While applying, a failure is tried again, up to the attempt limit.
    const failed = async (line: string) => {
      if (!applying) return { line };
      if (!exhausted && attempts < MAX_RETARGET_ATTEMPTS) return { line, retry: true };
      return done(gaveUp(line));
    };
    // The attempt is spent before anything else, so neither a failure nor a
    // reload gives it back.
    if (applying && !exhausted) await save({});
    let current: ReviewRequest | undefined;
    try {
      current = await options.fetch(child.url);
    } catch (error) {
      return failed(`Could not read ${child.reference}: ${reason(error)}.`);
    }
    if (!current || current.state !== 'opened')
      return done(`${child.reference} is no longer open, so it keeps its target.`);
    if (current.targetProject !== parent.targetProject)
      return done(`${child.reference} targets another project now, so it keeps its target.`);
    // A retarget whose response was lost shows up here as done.
    if (current.targetBranch === to)
      return done(
        sent
          ? `Retargeted ${child.reference} from ${from} to ${to}.`
          : `${child.reference} already targets ${to}.`,
      );
    if (current.targetBranch !== from)
      return done(
        `${child.reference} now targets ${current.targetBranch}, not ${from}, so it keeps its target.`,
      );
    if (!applying)
      return {
        line: `Proposed: retarget ${child.reference} from ${from} to ${to}.${
          policy.mode === 'apply' && policy.actions.includes('retarget')
            ? " Forgekeeper can't retarget on this forge."
            : ''
        }`,
      };
    if (exhausted)
      return done(gaveUp(`Could not retarget ${child.reference} from ${from} to ${to}.`));
    // The session may have dropped the dependent while it was read.
    let allowed: boolean;
    try {
      allowed = await options.allowed(child.url);
    } catch (error) {
      return failed(`Could not check ${child.reference}: ${reason(error)}.`);
    }
    if (!allowed)
      return done(
        `${child.reference} is no longer a target of this session, so Forgekeeper left it alone.`,
      );
    await save({ sent: true });
    try {
      await options.retarget!(current, to);
    } catch (error) {
      return failed(
        `Could not retarget ${child.reference} from ${from} to ${to}: ${reason(error)}.`,
      );
    }
    // The forge confirmed the change, so a failed read afterwards doesn't
    // undo it.
    const after = await options.fetch(child.url).catch(() => undefined);
    return done(
      !after || after.targetBranch === to
        ? `Retargeted ${child.reference} from ${from} to ${to}.`
        : `Asked to retarget ${child.reference} from ${from} to ${to}, but it now targets ${after.targetBranch}.`,
    );
  }

  const lines: string[] = [];
  let retry = false;
  for (const child of options.children) {
    const result = await handle(child);
    lines.push(result.line);
    retry ||= !!result.retry;
  }
  return { lines, retry };
}
