import { ventToFile } from './destinations/file.ts';
import { ventToGitHub } from './destinations/github.ts';
import { ventToGitLab } from './destinations/gitlab.ts';
import {
  VENT_CATEGORIES,
  type VentCategory,
  type VentInput,
  type VentMetadata,
  type VentResult,
} from './destinations/types.ts';
import type { Exec } from './exec.ts';
import { sanitizeRemote, selectDestination, type ResolvedVentOptions } from './options.ts';

export const VENT_TOOL_NAME = 'vent';

export const VENT_DESCRIPTION = [
  'Record a tooling, documentation, skill, permission, or workflow friction encountered during work.',
  'Routes to a configured destination (such as a GitLab issue under an epic, a GitHub issue, or a',
  'local Markdown log). Automatically checks open items at the destination and appends a comment or',
  'occurrence entry when a matching friction already exists instead of creating a duplicate.',
  'When only a closed GitHub or GitLab item matches, nothing is written: the result names it, and you',
  'ask the user whether to call `vent` again with `onClosedMatch` to reopen it or to file a new item',
  'that links it.',
  '',
  'Include concrete details: what failed or slowed you down, what you were doing, evidence (commands,',
  'paths, error text), and a suggested improvement when clear. Never include secret values, tokens,',
  'or sensitive production data.',
].join('\n');

export const VENT_GUIDANCE = [
  'When you encounter genuine, actionable friction in tools, skills, documentation, permissions, or',
  'repository workflows (such as misleading docs, broken helper scripts, missing read-only permission',
  'rules, or repeated workarounds), call the `vent` tool to record it.',
  'Do not call `vent` for normal bugs in the feature or fix you are actively implementing, or for',
  'transient user typos. Never include secrets, credentials, or sensitive production data in vents.',
  'Omit destination for project friction. For friction unrelated to the project, set destination',
  'and explain why in unrelatedReason. Never use another destination when issue filing fails.',
].join(' ');

export const ventInputSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 3,
      description: 'Concise summary of the friction, used as the issue title or section heading.',
    },
    friction: {
      type: 'string',
      minLength: 10,
      description:
        'Clear description of what failed, was slow, was undocumented, or caused wasted effort.',
    },
    context: {
      type: 'string',
      minLength: 5,
      description: 'What task or investigation you were performing when the friction occurred.',
    },
    evidence: {
      type: 'string',
      description:
        'Relevant error messages, command invocations, file paths, or reproduction details.',
    },
    suggestion: {
      type: 'string',
      description:
        'Concrete proposal to fix or improve the tool, documentation, skill, or workflow.',
    },
    category: {
      type: 'string',
      enum: [...VENT_CATEGORIES],
      description: 'Broad area where the friction occurred.',
    },
    labels: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Optional extra labels to apply when creating an issue on GitLab or GitHub.',
    },
    destination: {
      type: 'string',
      minLength: 1,
      description: 'Optional configured destination name. An enforced route restricts overrides.',
    },
    unrelatedReason: {
      type: 'string',
      minLength: 1,
      description:
        'With an explicit destination, explain why this friction is unrelated to the current checkout. Required to override an enforced route. Never use this to bypass failed issue filing.',
    },
    localReason: {
      type: 'string',
      minLength: 1,
      description: 'Deprecated alias for unrelatedReason.',
    },
    onClosedMatch: {
      type: 'string',
      enum: ['reopen', 'create'],
      description:
        'Only after a result reported a similar closed item, and after asking the user: `reopen` reopens it and adds this occurrence, `create` files a new item that links it.',
    },
    closedMatchUrl: {
      type: 'string',
      minLength: 1,
      description:
        'Optional URL of the closed item approved by the user when calling `vent` again with `onClosedMatch`.',
    },
  },
  required: ['title', 'friction', 'context'],
  additionalProperties: false,
} as const;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`\`${field}\` must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalCategory(value: unknown): VentCategory | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (VENT_CATEGORIES as readonly string[]).includes(value)) {
    return value as VentCategory;
  }
  throw new Error(`Invalid \`category\`. Expected one of: ${VENT_CATEGORIES.join(', ')}.`);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('`labels` must be an array of strings.');
  const items = value
    .map((item) => optionalString(item))
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function optionalClosedMatchAction(value: unknown): VentInput['onClosedMatch'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'reopen' || value === 'create') return value;
  throw new Error('Invalid `onClosedMatch`. Expected `reopen` or `create`.');
}

export function parseVentInput(raw: unknown): VentInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Vent input must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const evidence = optionalString(record.evidence);
  const suggestion = optionalString(record.suggestion);
  const category = optionalCategory(record.category);
  const labels = optionalStringArray(record.labels);
  const destination = optionalString(record.destination);
  const unrelatedReason =
    optionalString(record.unrelatedReason) ?? optionalString(record.localReason);
  const onClosedMatch = optionalClosedMatchAction(record.onClosedMatch);
  const closedMatchUrl = optionalString(record.closedMatchUrl);

  return {
    title: requiredString(record.title, 'title'),
    friction: requiredString(record.friction, 'friction'),
    context: requiredString(record.context, 'context'),
    ...(evidence ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(category ? { category } : {}),
    ...(labels ? { labels } : {}),
    ...(destination ? { destination } : {}),
    ...(unrelatedReason ? { unrelatedReason } : {}),
    ...(onClosedMatch ? { onClosedMatch } : {}),
    ...(closedMatchUrl ? { closedMatchUrl } : {}),
  };
}

export async function collectGitContext(
  run: Exec,
  directory: string,
  signal?: AbortSignal,
): Promise<{
  remote?: string;
  fetchRemotes: string[];
  remoteLookupFailed?: boolean;
  remoteLookupError?: string;
  branch?: string;
}> {
  const [remoteResult, branchResult] = await Promise.all([
    run('git', ['remote', '-v'], { cwd: directory, timeout: 5_000, signal }),
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: directory,
      timeout: 5_000,
      signal,
    }),
  ]);

  const fetchEntries =
    remoteResult.code === 0
      ? [
          ...remoteResult.stdout
            .replace(/\r\n?/g, '\n')
            .matchAll(/^(\S+)\s+(.+?) \(fetch\)(?:\s+\[.*\])?$/gm),
        ]
      : [];
  const rawRemote = fetchEntries.find((entry) => entry[1] === 'origin')?.[2];
  const remote = rawRemote ? sanitizeRemote(rawRemote) : undefined;
  const rawBranch = branchResult.code === 0 ? optionalString(branchResult.stdout) : undefined;
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : undefined;
  const notGitRepo = /not a git repository/i.test(`${remoteResult.stderr}\n${remoteResult.stdout}`);
  const remoteLookupFailed = remoteResult.code !== 0 && !notGitRepo;
  const remoteLookupError = remoteLookupFailed
    ? (remoteResult.stderr || remoteResult.stdout).trim() || `exit code ${remoteResult.code}`
    : undefined;

  return {
    ...(remote ? { remote } : {}),
    fetchRemotes: fetchEntries.map((entry) => entry[2]!.trim()).filter(Boolean),
    ...(remoteLookupFailed ? { remoteLookupFailed: true } : {}),
    ...(remoteLookupError ? { remoteLookupError } : {}),
    ...(branch ? { branch } : {}),
  };
}

export function formatVentResult(result: VentResult): string {
  const target = result.url ?? result.path ?? result.destination;
  const lines: string[] = [];

  if (result.action === 'commented') {
    const score = result.matchScore !== undefined ? ` (similarity ${result.matchScore})` : '';
    lines.push(
      `Recorded new occurrence on existing ${result.destinationType} entry "${result.matchedTitle ?? result.title}"${score}: ${target}`,
    );
  } else if (result.action === 'reopened') {
    lines.push(
      `Reopened closed ${result.destinationType} issue "${result.matchedTitle}" and recorded a new occurrence: ${target}`,
    );
  } else if (result.action === 'closed-match') {
    const score = result.matchScore !== undefined ? ` (similarity ${result.matchScore})` : '';
    lines.push(
      `Found a similar closed ${result.destinationType} issue "${result.matchedTitle}"${score}: ${target}`,
    );
  } else {
    lines.push(
      `Created new ${result.destinationType} vent "${result.title}" in destination "${result.destination}": ${target}`,
    );
  }

  if (result.note) {
    lines.push(`Note: ${result.note}`);
  }

  return lines.join('\n');
}

export async function executeVent(
  rawInput: unknown,
  options: ResolvedVentOptions,
  runtime: {
    sessionID: string;
    directory: string;
    branch?: string;
    remote?: string;
    exec: Exec;
    now?: () => Date;
    home?: string;
    signal?: AbortSignal;
  },
): Promise<VentResult> {
  const input = parseVentInput(rawInput);
  const git: {
    remote?: string;
    fetchRemotes?: string[];
    remoteLookupFailed?: boolean;
    remoteLookupError?: string;
    branch?: string;
  } =
    runtime.remote === undefined || runtime.branch === undefined
      ? await collectGitContext(runtime.exec, runtime.directory, runtime.signal)
      : {};

  const rawRemote = runtime.remote ?? git.remote;
  const remote = rawRemote ? sanitizeRemote(rawRemote) : undefined;
  const branch = runtime.branch ?? git.branch;

  const selected = selectDestination(options, {
    requested: input.destination,
    directory: runtime.directory,
    fetchRemotes: [...(runtime.remote ? [runtime.remote] : []), ...(git.fetchRemotes ?? [])],
    remoteLookupFailed: git.remoteLookupFailed,
    remoteLookupError: git.remoteLookupError,
    unrelatedReason: input.unrelatedReason,
    home: runtime.home,
  });

  const now = (runtime.now ?? (() => new Date()))();
  const timestamp = now.toISOString();
  const date = timestamp.slice(0, 10);
  const omitCheckoutMetadata =
    Boolean(selected.unrelatedOverride) &&
    selected.config.includeCheckoutMetadataOnUnrelated !== true;

  const metadata: VentMetadata = {
    date,
    timestamp,
    ...(!omitCheckoutMetadata
      ? {
          directory: runtime.directory,
          ...(remote ? { remote } : {}),
          ...(branch ? { branch } : {}),
          sessionID: runtime.sessionID,
        }
      : {}),
    ...(input.category ? { category: input.category } : {}),
  };

  const deps = {
    exec: runtime.exec,
    threshold: options.similarityThreshold,
    cwd: runtime.directory,
    signal: runtime.signal,
    home: runtime.home,
  };

  if (selected.config.type === 'gitlab') {
    return ventToGitLab(selected.name, selected.config, input, metadata, deps);
  }
  if (selected.config.type === 'github') {
    return ventToGitHub(selected.name, selected.config, input, metadata, deps);
  }
  return ventToFile(selected.name, selected.config, input, metadata, deps);
}
