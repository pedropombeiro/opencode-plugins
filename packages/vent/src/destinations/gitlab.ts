import {
  describeClosedMatch,
  parseConcatenatedJson,
  relatedToClosed,
  withoutResolutionLabels,
} from '../closed.ts';
import type { Exec } from '../exec.ts';
import { formatCommentBody, formatIssueBody } from '../format.ts';
import { buildMatchQuery, findBestMatch } from '../match.ts';
import type { GitLabDestination } from '../options.ts';
import type { VentInput, VentMetadata, VentResult } from './types.ts';

export interface GitLabEpicRef {
  host: string;
  groupPath: string;
  iid: string;
  url: string;
}

interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state?: string;
  confidential?: boolean;
  labels?: string[];
  web_url: string;
  epic?: { id?: number; iid?: number } | null;
}

interface GitLabNote {
  id: number;
}

function matchesDestinationScope(
  issue: GitLabIssue,
  destination: GitLabDestination,
  epicRef: GitLabEpicRef | undefined,
  projectPath: string,
): boolean {
  if (destination.confidential && issue.confidential !== true) {
    return false;
  }
  if (epicRef) {
    if (!URL.canParse(issue.web_url)) return false;
    const url = new URL(issue.web_url);
    return (
      url.host.toLowerCase() === destination.host.toLowerCase() &&
      url.pathname.toLowerCase().startsWith(projectPath)
    );
  }
  return true;
}

export function parseGitLabEpicRef(epic: string, defaultHost: string): GitLabEpicRef {
  const trimmed = epic.trim();

  const urlMatch = trimmed.match(
    /^(https?:\/\/)([^/]+)\/groups\/(.+?)\/-\/(?:epics|work_items)\/(\d+)(?:[/?#].*)?$/,
  );
  if (urlMatch) {
    const protocol = urlMatch[1]!;
    const host = urlMatch[2]!;
    const groupPath = urlMatch[3]!;
    const iid = urlMatch[4]!;
    return {
      host,
      groupPath,
      iid,
      url: `${protocol}${host}/groups/${groupPath}/-/epics/${iid}`,
    };
  }

  const refMatch = trimmed.match(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)&(\d+)$/);
  if (refMatch) {
    const groupPath = refMatch[1]!;
    const iid = refMatch[2]!;
    return {
      host: defaultHost,
      groupPath,
      iid,
      url: `https://${defaultHost}/groups/${groupPath}/-/epics/${iid}`,
    };
  }

  throw new Error(
    `Invalid GitLab epic reference "${epic}". Expected a URL like https://gitlab.com/groups/<group>/-/epics/<iid> or shorthand <group>&<iid>.`,
  );
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

async function glabApi<T>(
  run: Exec,
  host: string,
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
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
    args.push('--header', 'Content-Type: application/json', '--input', '-');
    stdin = JSON.stringify(options.body);
  }
  args.push(endpoint);

  const result = await run('glab', args, {
    cwd: options.cwd,
    stdin,
    signal: options.signal,
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`glab api ${options.method ?? 'GET'} ${endpoint} failed: ${detail}`);
  }

  return parseConcatenatedJson<T>(result.stdout);
}

export async function ventToGitLab(
  destinationName: string,
  destination: GitLabDestination,
  input: VentInput,
  metadata: VentMetadata,
  deps: { exec: Exec; threshold: number; cwd?: string; signal?: AbortSignal },
): Promise<VentResult> {
  const epicRef = destination.epic
    ? parseGitLabEpicRef(destination.epic, destination.host)
    : undefined;
  if (epicRef && epicRef.host.toLowerCase() !== destination.host.toLowerCase()) {
    throw new Error(
      `GitLab epic host "${epicRef.host}" does not match destination host "${destination.host}".`,
    );
  }
  const host = destination.host;
  const cwd = deps.cwd ?? metadata.directory ?? process.cwd();
  const encodedProject = encodeURIComponent(destination.project);

  const labelFilter =
    !epicRef && destination.labels.length > 0
      ? `&labels=${encodeURIComponent(destination.labels.join(','))}`
      : '';
  const listPath = epicRef
    ? `groups/${encodeURIComponent(epicRef.groupPath)}/epics/${epicRef.iid}/issues`
    : `projects/${encodedProject}/issues`;
  const listEndpoint = `${listPath}?state=opened&per_page=100${labelFilter}`;
  const projectPath = `/${destination.project.toLowerCase()}/-/`;

  const issues = await glabApi<GitLabIssue[]>(deps.exec, host, listEndpoint, {
    cwd,
    signal: deps.signal,
    paginate: true,
  });
  if (!Array.isArray(issues)) {
    throw new Error('GitLab open issue lookup did not return a list.');
  }

  const openCandidates = issues
    .filter(
      (issue) =>
        (!issue.state || issue.state === 'opened') &&
        matchesDestinationScope(issue, destination, epicRef, projectPath),
    )
    .map((issue) => ({
      id: `${issue.project_id}#${issue.iid}`,
      title: issue.title,
      body: issue.description ?? '',
      issue,
    }));

  const match = findBestMatch(buildMatchQuery(input), openCandidates, deps.threshold);

  if (match) {
    const matchedIssue = match.item.issue;
    const noteBody = formatCommentBody(input, metadata);
    const note = await glabApi<GitLabNote>(
      deps.exec,
      host,
      `projects/${matchedIssue.project_id}/issues/${matchedIssue.iid}/notes`,
      {
        method: 'POST',
        body: { body: noteBody },
        cwd,
        signal: deps.signal,
      },
    );

    const url = note.id ? `${matchedIssue.web_url}#note_${note.id}` : matchedIssue.web_url;
    return {
      action: 'commented',
      destination: destinationName,
      destinationType: 'gitlab',
      url,
      title: input.title,
      matchedTitle: matchedIssue.title,
      matchScore: Number(match.score.toFixed(2)),
    };
  }

  const closed =
    epicRef && Array.isArray(issues) && issues.some((issue) => issue.state === 'closed')
      ? issues
      : await glabApi<GitLabIssue[]>(
          deps.exec,
          host,
          `${listPath}?state=closed&per_page=100${labelFilter}`,
          {
            cwd,
            signal: deps.signal,
            paginate: true,
          },
        );
  if (!Array.isArray(closed)) {
    throw new Error('GitLab closed issue lookup did not return a list.');
  }

  const closedCandidates = closed
    .filter(
      (issue) =>
        issue.state === 'closed' &&
        matchesDestinationScope(issue, destination, epicRef, projectPath),
    )
    .map((issue) => ({
      id: `${issue.project_id}#${issue.iid}`,
      title: issue.title,
      body: issue.description ?? '',
      issue,
    }));
  const bestClosedMatch = findBestMatch(buildMatchQuery(input), closedCandidates, deps.threshold);
  const pinnedCandidate = input.closedMatchUrl
    ? closedCandidates.find((candidate) => candidate.issue.web_url === input.closedMatchUrl)
    : undefined;
  if (input.closedMatchUrl && !pinnedCandidate) {
    if (bestClosedMatch) {
      throw new Error(
        `Matched closed GitLab issue "${bestClosedMatch.item.issue.web_url}" does not match approved closedMatchUrl "${input.closedMatchUrl}".`,
      );
    }
    throw new Error(
      `Approved closedMatchUrl "${input.closedMatchUrl}" was not found among closed GitLab issues.`,
    );
  }
  const closedMatch = pinnedCandidate
    ? {
        item: pinnedCandidate,
        score: bestClosedMatch?.item === pinnedCandidate ? bestClosedMatch.score : 1,
      }
    : bestClosedMatch;

  if (input.onClosedMatch && !closedMatch) {
    throw new Error(
      `No matching closed GitLab issue was found for onClosedMatch: "${input.onClosedMatch}".`,
    );
  }

  let linkedClosedUrl: string | undefined;
  if (closedMatch) {
    const closedIssue = closedMatch.item.issue;
    const closedLabels = closedIssue.labels ?? [];

    if (input.onClosedMatch === 'reopen') {
      const kept = withoutResolutionLabels(closedLabels, destination.resolutionLabelPrefix);
      const resolutionLabels = closedLabels.filter((label) => !kept.includes(label));
      await glabApi<GitLabIssue>(
        deps.exec,
        host,
        `projects/${closedIssue.project_id}/issues/${closedIssue.iid}`,
        {
          method: 'PUT',
          body: {
            state_event: 'reopen',
            ...(resolutionLabels.length > 0 ? { remove_labels: resolutionLabels.join(',') } : {}),
          },
          cwd,
          signal: deps.signal,
        },
      );
      let note: GitLabNote;
      try {
        note = await glabApi<GitLabNote>(
          deps.exec,
          host,
          `projects/${closedIssue.project_id}/issues/${closedIssue.iid}/notes`,
          {
            method: 'POST',
            body: { body: formatCommentBody(input, metadata) },
            cwd,
            signal: deps.signal,
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Reopened ${closedIssue.web_url}, but adding the occurrence comment failed: ${detail}`,
          { cause: error },
        );
      }
      return {
        action: 'reopened',
        destination: destinationName,
        destinationType: 'gitlab',
        url: note.id ? `${closedIssue.web_url}#note_${note.id}` : closedIssue.web_url,
        title: input.title,
        matchedTitle: closedIssue.title,
        matchScore: Number(closedMatch.score.toFixed(2)),
      };
    }

    if (input.onClosedMatch === 'create') {
      linkedClosedUrl = closedIssue.web_url;
    } else {
      return {
        action: 'closed-match',
        destination: destinationName,
        destinationType: 'gitlab',
        url: closedIssue.web_url,
        title: input.title,
        matchedTitle: closedIssue.title,
        matchScore: Number(closedMatch.score.toFixed(2)),
        closedLabels,
        note: describeClosedMatch(closedLabels, destination.reopenLabels, closedIssue.web_url),
      };
    }
  }

  let description = formatIssueBody(input, metadata);
  if (linkedClosedUrl) {
    description = `${description}\n\n${relatedToClosed(linkedClosedUrl)}`;
  }
  if (epicRef) {
    description = `${description}\n\n/epic ${epicRef.url}`;
  }

  const labels = mergeLabels(destination.labels, [
    ...(input.category ? [input.category] : []),
    ...(input.labels ?? []),
  ]);
  const created = await glabApi<GitLabIssue>(deps.exec, host, `projects/${encodedProject}/issues`, {
    method: 'POST',
    body: {
      title: input.title.trim(),
      description,
      confidential: destination.confidential,
      ...(labels.length > 0 ? { labels: labels.join(',') } : {}),
    },
    cwd,
    signal: deps.signal,
  });

  let note: string | undefined = linkedClosedUrl
    ? `Linked the closed issue ${linkedClosedUrl}.`
    : undefined;
  if (epicRef && !created.epic && created.id) {
    try {
      await glabApi(
        deps.exec,
        host,
        `groups/${encodeURIComponent(epicRef.groupPath)}/epics/${epicRef.iid}/issues/${created.id}`,
        {
          method: 'POST',
          cwd,
          signal: deps.signal,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.replace(/^glab api POST \S+ failed:\s*/, '');
      if (!/\b409\b/.test(detail) && !detail.toLowerCase().includes('already')) {
        note = `${note ? `${note} ` : ''}Issue created, but fallback epic link failed: ${message}`;
      }
    }
  }

  return {
    action: 'created',
    destination: destinationName,
    destinationType: 'gitlab',
    url: created.web_url,
    title: input.title,
    ...(note ? { note } : {}),
  };
}
