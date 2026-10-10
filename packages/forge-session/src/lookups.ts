import type { Exec } from './exec';
import type { ForgeTraits, ReviewRef } from './forge';
import { traits, type ForgeCatalog } from './forges';

// What session titles need from the forges. Status lookups use the same forge
// catalog, so both agree on which remote, branch, and PR/MR a checkout has.
export interface TitleLookups {
  // The checked-out branch and the number of its newest open PR/MR. Undefined
  // when the checkout has no supported forge remote or is on its default branch.
  branch(
    directory: string,
  ): Promise<{ forge: ForgeTraits; branch: string; number?: string } | undefined>;
  // The branch a PR/MR was opened from, for inferring its issue.
  sourceBranch(ref: ReviewRef, directory: string): Promise<string | undefined>;
}

// How long a found PR/MR number is reused. A branch's PR/MR rarely changes,
// but one can close and another open from the same branch.
export const NUMBER_TTL = 10 * 60_000;

export function createTitleLookups(
  forges: ForgeCatalog,
  run: Exec,
  now: () => number = Date.now,
): TitleLookups {
  // Found numbers are kept for NUMBER_TTL. A branch without one is looked up
  // again after every turn.
  const numbers = new Map<string, { number: string; at: number }>();

  return {
    async branch(directory) {
      const lookup = await forges.repository(directory);
      if (lookup.kind === 'none') return undefined;
      const { repository } = lookup;
      const forge = forges.forHost(repository.source.host, directory);
      if (!forge) return undefined;
      const key = JSON.stringify([
        directory,
        repository.source.host,
        repository.source.path,
        repository.sourceBranch,
      ]);
      const cached = numbers.get(key);
      let number = cached && now() - cached.at < NUMBER_TTL ? cached.number : undefined;
      // A failed lookup keeps an expired number, which is likelier to be right
      // than no number at all.
      if (!number) {
        try {
          number = await forge.findNumberByBranch(repository);
          if (number) numbers.set(key, { number, at: now() });
          else numbers.delete(key);
        } catch {
          number = cached?.number;
        }
      }
      return { forge: forge.traits, branch: repository.branch, number };
    },

    // Uses the forge the URL names, even on a host the catalog doesn't list.
    async sourceBranch(ref, directory) {
      return traits(ref.forge)
        .open(run, directory)
        .sourceBranch(ref)
        .catch(() => undefined);
    },
  };
}
