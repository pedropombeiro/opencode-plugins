import {
  describeClosedMatch,
  parseConcatenatedJson,
  relatedToClosed,
  withoutResolutionLabels,
} from '../closed.ts';
import type { Exec } from '../exec.ts';
import { formatCommentBody, formatIssueBody } from '../format.ts';
import { buildMatchQuery, findBestMatch } from '../match.ts';
import type { GitHubDestination } from '../options.ts';
import type { VentInput, VentMetadata, VentResult } from './types.ts';

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
}

interface GitHubComment {
  html_url?: string;
}

function mergeLabels(base: readonly string[], extra: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const label of [...base, ...(extra ?? [])]) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}

async function ghApi<T>(
  run: Exec,
  host: string,
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH';
    paginate?: boolean;
    body?: Record<string, unknown>;
    cwd: string;
    signal?: AbortSignal;
  },
): Promise<T> {
  const args = ['api', '--hostname', host];
  if (options.paginate) args.push('--paginate');
  if (options.method && options.method !== 'GET') {
    args.push('--method', options.method);
  }
  let stdin: string | undefined;
  if (options.body !== undefined) {
    args.push('--input', '-');
    stdin = JSON.stringify(options.body);
  }
  args.push(endpoint);

  const result = await run('gh', args, {
    cwd: options.cwd,
    stdin,
    signal: options.signal,
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`gh api ${options.method ?? 'GET'} ${endpoint} failed: ${detail}`);
  }

  return parseConcatenatedJson<T>(result.stdout);
}

export async function ventToGitHub(
  destinationName: string,
  destination: GitHubDestination,
  input: VentInput,
  metadata: VentMetadata,
  deps: { exec: Exec; threshold: number; cwd?: string; signal?: AbortSignal },
): Promise<VentResult> {
  const cwd = deps.cwd ?? metadata.directory ?? process.cwd();
  const labelFilter =
    destination.labels.length > 0
      ? `&labels=${encodeURIComponent(destination.labels.join(','))}`
      : '';
  const issues = await ghApi<GitHubIssue[]>(
    deps.exec,
    destination.host,
    `repos/${destination.repo}/issues?state=open&per_page=100${labelFilter}`,
    {
      cwd,
      signal: deps.signal,
      paginate: true,
    },
  );

  const openCandidates = (Array.isArray(issues) ? issues : [])
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      id: `#${issue.number}`,
      title: issue.title,
      body: issue.body ?? '',
      issue,
    }));

  const match = findBestMatch(buildMatchQuery(input), openCandidates, deps.threshold);

  if (match) {
    const matchedIssue = match.item.issue;
    const comment = await ghApi<GitHubComment>(
      deps.exec,
      destination.host,
      `repos/${destination.repo}/issues/${matchedIssue.number}/comments`,
      {
        method: 'POST',
        body: { body: formatCommentBody(input, metadata) },
        cwd,
        signal: deps.signal,
      },
    );

    return {
      action: 'commented',
      destination: destinationName,
      destinationType: 'github',
      url: comment.html_url ?? matchedIssue.html_url,
      title: input.title,
      matchedTitle: matchedIssue.title,
      matchScore: Number(match.score.toFixed(2)),
    };
  }

  let body = formatIssueBody(input, metadata);
  let note: string | undefined;

  const closed = await ghApi<GitHubIssue[]>(
    deps.exec,
    destination.host,
    `repos/${destination.repo}/issues?state=closed&per_page=100${labelFilter}`,
    {
      cwd,
      signal: deps.signal,
      paginate: true,
    },
  );
  const closedCandidates = (Array.isArray(closed) ? closed : [])
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      id: `#${issue.number}`,
      title: issue.title,
      body: issue.body ?? '',
      issue,
    }));
  const closedMatch = findBestMatch(buildMatchQuery(input), closedCandidates, deps.threshold);

  if (input.onClosedMatch && !closedMatch) {
    throw new Error(
      `No matching closed GitHub issue was found for onClosedMatch: "${input.onClosedMatch}".`,
    );
  }

  if (closedMatch) {
    const closedIssue = closedMatch.item.issue;
    if (input.closedMatchUrl && closedIssue.html_url !== input.closedMatchUrl) {
      throw new Error(
        `Matched closed GitHub issue "${closedIssue.html_url}" does not match approved closedMatchUrl "${input.closedMatchUrl}".`,
      );
    }
    const closedLabels = (closedIssue.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter((label): label is string => Boolean(label));

    if (input.onClosedMatch === 'reopen') {
      const kept = withoutResolutionLabels(closedLabels, destination.resolutionLabelPrefix);
      await ghApi<GitHubIssue>(
        deps.exec,
        destination.host,
        `repos/${destination.repo}/issues/${closedIssue.number}`,
        {
          method: 'PATCH',
          body: {
            state: 'open',
            state_reason: 'reopened',
            ...(kept.length < closedLabels.length ? { labels: kept } : {}),
          },
          cwd,
          signal: deps.signal,
        },
      );
      const comment = await ghApi<GitHubComment>(
        deps.exec,
        destination.host,
        `repos/${destination.repo}/issues/${closedIssue.number}/comments`,
        {
          method: 'POST',
          body: { body: formatCommentBody(input, metadata) },
          cwd,
          signal: deps.signal,
        },
      );
      return {
        action: 'reopened',
        destination: destinationName,
        destinationType: 'github',
        url: comment.html_url ?? closedIssue.html_url,
        title: input.title,
        matchedTitle: closedIssue.title,
        matchScore: Number(closedMatch.score.toFixed(2)),
      };
    }

    if (input.onClosedMatch === 'create') {
      body = `${body}\n\n${relatedToClosed(closedIssue.html_url)}`;
      note = `Linked the closed issue ${closedIssue.html_url}.`;
    } else {
      return {
        action: 'closed-match',
        destination: destinationName,
        destinationType: 'github',
        url: closedIssue.html_url,
        title: input.title,
        matchedTitle: closedIssue.title,
        matchScore: Number(closedMatch.score.toFixed(2)),
        closedLabels,
        note: describeClosedMatch(closedLabels, destination.reopenLabels, closedIssue.html_url),
      };
    }
  }

  const labels = mergeLabels(destination.labels, [
    ...(input.category ? [input.category] : []),
    ...(input.labels ?? []),
  ]);
  const created = await ghApi<GitHubIssue>(
    deps.exec,
    destination.host,
    `repos/${destination.repo}/issues`,
    {
      method: 'POST',
      body: {
        title: input.title.trim(),
        body,
        ...(labels.length > 0 ? { labels } : {}),
      },
      cwd,
      signal: deps.signal,
    },
  );

  return {
    action: 'created',
    destination: destinationName,
    destinationType: 'github',
    url: created.html_url,
    title: input.title,
    ...(note ? { note } : {}),
  };
}
