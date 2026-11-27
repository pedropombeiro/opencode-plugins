import type { Skill } from '@opencode/plugin';
import type { DestinationConfig, ResolvedVentOptions } from './options.ts';

export const RESOLVE_VENT_SKILL_ID = 'resolve-vent';

function formatInlineCodes(items: readonly string[]): string {
  return items.map((item) => `\`${item}\``).join(', ');
}

function describeDestinationTarget(name: string, config: DestinationConfig): string {
  if (config.type === 'gitlab') {
    const confidentiality = config.confidential ? 'confidential ' : '';
    const epic = config.epic ? `, under epic \`${config.epic}\`` : '';
    const labels = config.labels.length > 0 ? `, labeled ${formatInlineCodes(config.labels)}` : '';
    const resolutionPrefix = config.resolutionLabelPrefix
      ? `, resolution prefix \`${config.resolutionLabelPrefix}\``
      : '';
    const reopen =
      config.reopenLabels && config.reopenLabels.length > 0
        ? `, reopen labels ${formatInlineCodes(config.reopenLabels)}`
        : '';
    return `- **${name}** (GitLab \`${config.host}\`): ${confidentiality}issues/work items in \`${config.project}\`${epic}${labels}${resolutionPrefix}${reopen}.`;
  }
  if (config.type === 'github') {
    const labels = config.labels.length > 0 ? `, labeled ${formatInlineCodes(config.labels)}` : '';
    const resolutionPrefix = config.resolutionLabelPrefix
      ? `, resolution prefix \`${config.resolutionLabelPrefix}\``
      : '';
    const reopen =
      config.reopenLabels && config.reopenLabels.length > 0
        ? `, reopen labels ${formatInlineCodes(config.reopenLabels)}`
        : '';
    return `- **${name}** (GitHub \`${config.host}\`): issues in \`${config.repo}\`${labels}${resolutionPrefix}${reopen}.`;
  }
  return `- **${name}** (Markdown file): sections in \`${config.path}\`.`;
}

function summarizeDestinationExamples(destinations: Record<string, DestinationConfig>): string {
  const examples: string[] = [];
  for (const config of Object.values(destinations)) {
    if (config.type === 'gitlab') {
      examples.push(`\`${config.project}\` GitLab issues/work items`);
    } else if (config.type === 'github') {
      examples.push(`\`${config.repo}\` GitHub issues`);
    } else {
      examples.push(`\`${config.path}\` entries`);
    }
  }
  if (examples.length === 0) return '';
  return `, such as ${examples.join(' or ')}`;
}

type IssueDestinationConfig = Exclude<DestinationConfig, { type: 'file' }>;

function describeClosedDuplicateGuidance(
  destinations: Record<string, DestinationConfig>,
): string[] {
  const issueDestinations = Object.entries(destinations).filter(
    (entry): entry is [string, IssueDestinationConfig] => entry[1].type !== 'file',
  );
  if (issueDestinations.length === 0) {
    return [];
  }

  const lines: string[] = [
    '',
    '   If a matching item is closed, follow that destination’s closed-match rules:',
  ];

  for (const [name, config] of issueDestinations) {
    const prefixNote = config.resolutionLabelPrefix
      ? `removing its \`${config.resolutionLabelPrefix}*\` labels`
      : 'keeping its existing labels';
    if (config.reopenLabels && config.reopenLabels.length > 0) {
      const reopen = config.reopenLabels.map((label) => `\`${label}\``).join(' or ');
      const otherExamples = config.resolutionLabelPrefix
        ? ` (such as \`${config.resolutionLabelPrefix}fixed\` or \`${config.resolutionLabelPrefix}intended\`)`
        : '';
      lines.push(
        `   - **${name}**: ${reopen} marks an item closed without a confirmed fix, so the new report is additional evidence. Ask the user, then reopen it (\`vent\` with \`onClosedMatch: "reopen"\` and \`closedMatchUrl\`, or manually reopen, ${prefixNote}, and comment with the new evidence). Other closed items${otherExamples} indicate a likely regression: file a new item that links the closed one (\`onClosedMatch: "create"\` and \`closedMatchUrl\`) and check why the earlier fix or documentation did not hold.`,
      );
    } else {
      lines.push(
        `   - **${name}**: no \`reopenLabels\` are configured. Ask the user whether to reopen the closed item and add the new evidence (\`vent\` with \`onClosedMatch: "reopen"\` and \`closedMatchUrl\`, ${prefixNote}) or to file a new item that links the closed one (\`onClosedMatch: "create"\` and \`closedMatchUrl\`).`,
      );
    }
  }

  return lines;
}

function describeCloseOutSteps(destinations: Record<string, DestinationConfig>): string[] {
  const entries = Object.entries(destinations);
  const issueDestinations = entries.filter(
    (entry): entry is [string, IssueDestinationConfig] => entry[1].type !== 'file',
  );
  const fileDestinations = entries.filter(
    (entry): entry is [string, Extract<DestinationConfig, { type: 'file' }>] =>
      entry[1].type === 'file',
  );

  if (issueDestinations.length === 0 && fileDestinations.length > 0) {
    const paths = fileDestinations.map(([, config]) => `\`${config.path}\``).join(' or ');
    return [
      '1. **Close out after approval.** Once the fix is in place:',
      '   1. Draft a resolution summary stating the root cause, what changed, and the',
      '      changed file paths. If the failure could not be reproduced, state instead',
      '      what you tried, the OpenCode version and date, and what evidence would let',
      '      someone reproduce it next time.',
      '   1. Ask with the `question` tool whether to append a `### Resolution`',
      `      subsection to the matching \`## <title>\` section in ${paths} or remove the`,
      '      resolved section from the log.',
      '   1. Apply the approved update to the Markdown log.',
      '   1. Report which files are uncommitted. Do not commit unless the user asks.',
    ];
  }

  const configuredPrefixes = [
    ...new Set(
      issueDestinations
        .map(([, config]) => config.resolutionLabelPrefix)
        .filter((prefix): prefix is string => Boolean(prefix)),
    ),
  ];
  const primaryPrefix = configuredPrefixes[0] ?? 'resolution::';
  const formatOutcome = (suffix: string) =>
    configuredPrefixes.length <= 1
      ? `\`${primaryPrefix}${suffix}\``
      : configuredPrefixes.map((prefix) => `\`${prefix}${suffix}\``).join(' / ');
  const formatPrefixHeading = (): string => {
    switch (configuredPrefixes.length) {
      case 0:
        return 'Pick the native close reason (and a resolution label such as `resolution::<name>` if the destination uses resolution labels):';
      case 1:
        return `Pick the resolution label (\`${primaryPrefix}<name>\`, when configured on the destination) and native close reason:`;
      default:
        return `Pick the resolution label (${configuredPrefixes.map((prefix) => `\`${prefix}<name>\``).join(' or ')}, matching the destination's configured prefix) and native close reason:`;
    }
  };
  const prefixHeading = formatPrefixHeading();

  return [
    '1. **Close out after approval.** Once the fix is in place:',
    '   1. Draft a closing comment stating the root cause, what changed, and the',
    `      changed file paths. For ${formatOutcome('cannot-reproduce')}, state instead what you`,
    '      tried, the OpenCode version and date, and what evidence would let someone',
    '      reproduce it next time.',
    `   1. ${prefixHeading}`,
    `      - ${formatOutcome('fixed')}: the root cause is fixed. Reason: completed (Done).`,
    `      - ${formatOutcome('mitigated')}: a workaround or agent rule is in place while the`,
    '        root cause is external or unknown. Reason: completed (Done).',
    `      - ${formatOutcome('intended')}: the behavior is deliberate and the supported`,
    '        workflow is documented. Reason: completed (Done).',
    `      - ${formatOutcome('cannot-reproduce')}: the failure could not be reproduced or`,
    "        confirmed, and nothing changed. Reason: not planned (Won't do).",
    '',
    '      Close duplicates as duplicates without a resolution label, linking the',
    '      primary item.',
    '   1. Ask with the `question` tool whether to post the comment and close the',
    '      item.',
    '   1. For GitLab, post the comment with `gitlab_create_work_item_note` or',
    '      `glab api --hostname <host>`, then close the item (adding `-f add_labels=<label>` when using resolution labels) via',
    '      `glab api --hostname <host> --method PUT projects/<url-encoded-project>/issues/<iid> -f state_event=close -f add_labels=<label>`.',
    '      For GitHub, pass the full issue URL so `gh` targets the configured host: add the label (when used) with',
    '      `gh issue edit <issue-url> --add-label <label>`, then run',
    '      `gh issue close <issue-url> --comment <text>` (adding',
    `      \`--reason "not planned"\` for ${formatOutcome('cannot-reproduce')}, or`,
    '      `--reason duplicate --duplicate-of <primary>` for duplicates).',
    ...(fileDestinations.length > 0
      ? [
          '      For Markdown file entries, append the approved `### Resolution` subsection',
          '      to the matching `## <title>` section or remove the resolved section.',
        ]
      : []),
    '   1. Report which files are uncommitted. Do not commit unless the user asks.',
  ];
}

export function buildResolveVentSkill(options: ResolvedVentOptions): Skill.Info {
  const examples = summarizeDestinationExamples(options.destinations);
  const description =
    `Resolve friction items recorded by the OpenCode \`vent\` tool${examples}. ` +
    'Use when asked to address, fix, triage, or close a vent or friction item.';

  const destinationLines = Object.entries(options.destinations).map(([name, config]) =>
    describeDestinationTarget(name, config),
  );

  const content = [
    '# Resolve vent',
    '',
    'A vent records friction that an agent hit in a tool, doc, skill, permission, or',
    'workflow. Fix the root cause so future sessions do not hit the same friction.',
    '',
    '## Where vents live',
    '',
    ...(destinationLines.length > 0
      ? destinationLines
      : ['- Configured under the `opencode-vent` plugin options in `opencode.json`.']),
    '',
    '## Workflow',
    '',
    '1. **Set the target.** When resolving a GitLab issue/work item or GitHub issue and',
    '   `set_session_target` is available, call `set_session_target` with its full URL',
    '   before reading it.',
    '1. **Read the item.**',
    '   - **GitLab**: read the description and notes with `gitlab_get_work_item` and',
    '     `gitlab_get_work_item_notes`, or `glab issue view <issue-url>` / `glab api --hostname <host>`.',
    '   - **GitHub**: run `gh issue view <issue-url> --comments`.',
    '   - **Markdown file**: read the `## <title>` section and its `### Occurrence`',
    '     subsections.',
    '',
    '   The collapsible `Session metadata` block records the timestamp, category,',
    '   working directory, repository remote, branch, and session ID.',
    '1. **Find the original session.** When `search_sessions` is available, call it',
    '   with that `session_id`, a query taken from the friction text, and',
    '   `include: ["tools"]` to inspect the failing call, its error output, and',
    '   whether the user had approved the action.',
    '1. **Look for duplicates.** Check open and closed items in the destination',
    '   (`gitlab_list_issues` or `glab api --hostname <host>` for GitLab,',
    '   `gh issue list -R <host/owner/repo> --state all` for GitHub, or other sections in',
    '   the Markdown log). Resolve items with the same root cause together, and add',
    '   all of them to `set_session_target` when available.',
    ...describeClosedDuplicateGuidance(options.destinations),
    '1. **Find the root cause.** Reproduce the failure, or confirm it in the',
    '   configuration, plugin code, skill, script, or documentation involved. Decide',
    '   whether the behavior is intended:',
    '   - **Intended** (such as a deliberate permission rule or guard): keep it, and',
    '     document the supported workflow where the agent reads it before hitting the',
    '     friction.',
    '   - **Unintended**: fix the configuration, plugin, script, or documentation.',
    '',
    '   When the fix involves a real choice, ask the user with the `question` tool',
    '   before building it.',
    '1. **Review and verify the fix.** Follow the repository review flow and run the',
    '   tests or checks that cover the changed files.',
    ...describeCloseOutSteps(options.destinations),
  ].join('\n');

  return {
    id: RESOLVE_VENT_SKILL_ID as Skill.ID,
    name: RESOLVE_VENT_SKILL_ID as Skill.Name,
    description,
    path: `skill://${RESOLVE_VENT_SKILL_ID}/SKILL.md` as Skill.Info['path'],
    content,
  };
}
