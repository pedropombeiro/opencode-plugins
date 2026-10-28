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

// A retarget's progress, stored so a reload doesn't repeat or lose it.
export interface RetargetEntry {
  state: 'running' | 'done';
  from: string;
  to: string;
  outcome?: string;
}

export interface RetargetOptions {
  parent: LifecycleRecord;
  // The session's records whose parent is the merged PR/MR.
  children: readonly LifecycleRecord[];
  policy: EventPolicy;
  // Reads a PR/MR from its forge, bypassing caches.
  fetch: (url: string) => Promise<ReviewRequest | undefined>;
  // The forge's retarget operation, when it has one.
  retarget?: (request: ReviewRequest, branch: string) => Promise<void>;
  journal: {
    get: (child: string) => Promise<RetargetEntry | undefined>;
    set: (child: string, entry: RetargetEntry) => Promise<void>;
  };
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// One line per dependent PR/MR: what Forgekeeper did, would do, or why not.
export async function retargetChildren(options: RetargetOptions): Promise<string[]> {
  const { parent, policy } = options;
  const lines: string[] = [];
  const from = parent.sourceBranch;
  const to = parent.targetBranch;
  for (const child of options.children) {
    if (policy.mode === 'notify') {
      lines.push(
        `${child.reference} builds on ${parent.reference}: it targets ${from ?? 'its source branch'}.`,
      );
      continue;
    }
    // A fork's branch can't stand in for the target project's branch.
    if (!from || !parent.sourceProject || parent.sourceProject !== parent.targetProject) {
      lines.push(
        `${child.reference} builds on ${parent.reference}, which came from another project, so its new target is unclear.`,
      );
      continue;
    }
    const done = await options.journal.get(child.url);
    if (done?.state === 'done' && done.outcome) {
      lines.push(done.outcome);
      continue;
    }
    let current: ReviewRequest | undefined;
    try {
      current = await options.fetch(child.url);
    } catch (error) {
      lines.push(`Could not read ${child.reference}: ${reason(error)}.`);
      continue;
    }
    const finish = async (outcome: string) => {
      lines.push(outcome);
      if (policy.mode === 'apply')
        await options.journal.set(child.url, { state: 'done', from, to, outcome });
    };
    if (!current || current.state !== 'opened') {
      await finish(`${child.reference} is no longer open, so it keeps its target.`);
      continue;
    }
    if (current.targetProject !== parent.targetProject) {
      await finish(`${child.reference} targets another project now, so it keeps its target.`);
      continue;
    }
    if (current.targetBranch === to) {
      await finish(`${child.reference} already targets ${to}.`);
      continue;
    }
    if (current.targetBranch !== from) {
      await finish(
        `${child.reference} now targets ${current.targetBranch}, not ${from}, so it keeps its target.`,
      );
      continue;
    }
    if (policy.mode === 'prepare' || !policy.actions.includes('retarget')) {
      lines.push(`Proposed: retarget ${child.reference} from ${from} to ${to}.`);
      continue;
    }
    if (!options.retarget) {
      lines.push(
        `Proposed: retarget ${child.reference} from ${from} to ${to}. Forgekeeper can't retarget on this forge.`,
      );
      continue;
    }
    await options.journal.set(child.url, { state: 'running', from, to });
    try {
      await options.retarget(current, to);
    } catch (error) {
      // Stays `running`: the next attempt reads the PR/MR again, so a
      // retarget whose response was lost counts as done then.
      lines.push(`Could not retarget ${child.reference} from ${from} to ${to}: ${reason(error)}.`);
      continue;
    }
    let after: ReviewRequest | undefined;
    try {
      after = await options.fetch(child.url);
    } catch {
      after = undefined;
    }
    await finish(
      after?.targetBranch === to
        ? `Retargeted ${child.reference} from ${from} to ${to}.`
        : `Asked to retarget ${child.reference} from ${from} to ${to}, but it now targets ${after?.targetBranch ?? 'an unknown branch'}.`,
    );
  }
  return lines;
}
