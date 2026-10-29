// What Forgekeeper reports when a PR/MR that another target of the session
// builds on merges: the dependent PR/MR may need to target the branch the
// merged one went into. Forgekeeper only proposes that change and never makes
// it, since GitLab retargets dependents itself when the merge deletes the
// source branch, and a kept branch may be deliberate.
//
// A proposal reads the PR/MR again first, so it depends on the forge's
// current state, not on what a lookup saw earlier. A forge that already
// retargeted it counts as done.
import type { ReviewRequest } from './forge';
import type { LifecycleRecord } from './lifecycle-watch';
import type { EventPolicy, ExecutionMode } from './options';

// The stricter of two policies: the lower mode, and only the actions both
// allow. A mode this release doesn't know, such as `apply` in an event
// stored by an earlier one, counts as `notify`.
export function stricter(a: EventPolicy | undefined, b: EventPolicy): EventPolicy {
  if (!a) return { mode: 'notify', actions: [] };
  const order: ExecutionMode[] = ['notify', 'prepare'];
  const rank = (policy: EventPolicy) => Math.max(0, order.indexOf(policy.mode));
  const mode = order[Math.min(rank(a), rank(b))];
  return {
    mode,
    actions: mode === 'notify' ? [] : a.actions.filter((action) => b.actions.includes(action)),
  };
}

export interface RetargetOptions {
  parent: LifecycleRecord;
  // The session's current targets whose parent is the merged PR/MR.
  children: readonly LifecycleRecord[];
  policy: EventPolicy;
  // Reads a PR/MR from its forge, bypassing caches.
  fetch: (url: string) => Promise<ReviewRequest | undefined>;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// One line per dependent PR/MR: whether it needs a new target, and which.
export async function proposeRetargets(options: RetargetOptions): Promise<string[]> {
  const { parent, policy } = options;
  const from = parent.sourceBranch;
  const to = parent.targetBranch;
  // The policy's actions say what `prepare` works out.
  const preparing = policy.mode === 'prepare' && policy.actions.includes('retarget');

  async function line(child: LifecycleRecord): Promise<string> {
    if (!preparing)
      return `${child.reference} builds on ${parent.reference}: it targets ${from ?? 'its source branch'}.`;
    // A fork's branch can't stand in for the target project's branch.
    if (!from || !parent.sourceProject || parent.sourceProject !== parent.targetProject)
      return `${child.reference} builds on ${parent.reference}, which came from another project, so its new target is unclear.`;
    let current: ReviewRequest | undefined;
    try {
      current = await options.fetch(child.url);
    } catch (error) {
      return `Could not read ${child.reference}: ${reason(error)}.`;
    }
    if (!current || current.state !== 'opened')
      return `${child.reference} is no longer open, so it keeps its target.`;
    if (current.targetProject !== parent.targetProject)
      return `${child.reference} targets another project now, so it keeps its target.`;
    if (current.targetBranch === to) return `${child.reference} already targets ${to}.`;
    if (current.targetBranch !== from)
      return `${child.reference} now targets ${current.targetBranch}, not ${from}, so it keeps its target.`;
    return `Proposed: retarget ${child.reference} from ${from} to ${to}.`;
  }

  const lines: string[] = [];
  for (const child of options.children) lines.push(await line(child));
  return lines;
}
