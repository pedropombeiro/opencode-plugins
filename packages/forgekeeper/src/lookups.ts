import type { Exec } from './exec';
import type { ReviewRef } from './forge';
import { traits } from './forges';

export interface TitleLookups {
  sourceBranch(ref: ReviewRef, directory: string): Promise<string | undefined>;
}

export function createTitleLookups(run: Exec): TitleLookups {
  return {
    async sourceBranch(ref, directory) {
      return traits(ref.forge)
        .open(run, directory)
        .sourceBranch(ref)
        .catch(() => undefined);
    },
  };
}
