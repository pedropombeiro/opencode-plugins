import type { AutomationRule } from './options';
import type { FeedbackItem } from './feedback-inbox';
import type {
  AutomationRecord,
  ExecutionOutcome,
  LinkedRecord,
  ProvisioningExecution,
} from './review-automation';

export interface ExecutionSource {
  head: string;
  sourceProject: string;
  sourceBranch: string;
}

export class EnvironmentUncertain extends Error {}

export interface StartContext {
  pending: (item: FeedbackItem) => Promise<void>;
  rules: () => Promise<readonly AutomationRule[]>;
  check: (
    item: FeedbackItem,
    automatic: boolean,
    rules: readonly AutomationRule[],
  ) => Promise<readonly AutomationRule[]>;
  admit: () => Promise<void>;
}

export type UpdateExecution = (patch: Partial<ProvisioningExecution>) => Promise<AutomationRecord>;

export interface AutomationEnvironmentProvider {
  id: string;
  version: number;
  recover: (record: AutomationRecord) => Promise<void>;
  provision: (record: AutomationRecord, update: UpdateExecution) => Promise<AutomationRecord>;
  verify: (record: LinkedRecord) => Promise<void>;
  submit: (record: LinkedRecord) => Promise<void>;
  exists: (record: AutomationRecord) => Promise<boolean>;
  wait: (record: AutomationRecord) => Promise<void>;
  outcome: (record: AutomationRecord) => Promise<ExecutionOutcome>;
  matchesSession: (record: AutomationRecord, sessionID: string) => boolean;
  startContext: (record: LinkedRecord) => StartContext;
  describe: (record: AutomationRecord, phase: 'started' | 'ended') => Promise<string[]>;
  archive?: (
    record: AutomationRecord,
  ) => Promise<string | { sessionID: string; needsClientArchive?: boolean } | undefined>;
  sweep: () => Promise<string[]>;
}

export interface AutomationEnvironments {
  default: string;
  providers: readonly AutomationEnvironmentProvider[];
}

export function environmentProvider(
  environments: AutomationEnvironments | undefined,
  record?: AutomationRecord,
): AutomationEnvironmentProvider {
  const id = record?.execution?.provider ?? environments?.default;
  const provider = environments?.providers.find((entry) => entry.id === id);
  if (!provider)
    throw new Error(`Execution environment provider ${id ?? '(unset)'} is unavailable`);
  if (record?.execution && record.execution.version !== provider.version)
    throw new Error(
      `Execution environment provider ${id} cannot read version ${record.execution.version}`,
    );
  return provider;
}
