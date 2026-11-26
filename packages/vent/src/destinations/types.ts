export const VENT_CATEGORIES = [
  'tooling',
  'documentation',
  'skill',
  'permissions',
  'environment',
  'workflow',
  'other',
] as const;

export type VentCategory = (typeof VENT_CATEGORIES)[number];

export interface VentInput {
  title: string;
  friction: string;
  context: string;
  evidence?: string;
  suggestion?: string;
  category?: VentCategory;
  labels?: string[];
  destination?: string;
  unrelatedReason?: string;
  onClosedMatch?: 'reopen' | 'create';
  closedMatchUrl?: string;
}

export interface VentMetadata {
  date: string;
  timestamp: string;
  directory?: string;
  remote?: string;
  branch?: string;
  sessionID?: string;
  category?: VentCategory;
}

export interface VentResult {
  action: 'created' | 'commented' | 'reopened' | 'closed-match';
  destination: string;
  destinationType: 'gitlab' | 'github' | 'file';
  url?: string;
  path?: string;
  title: string;
  matchedTitle?: string;
  matchScore?: number;
  closedLabels?: string[];
  note?: string;
}
